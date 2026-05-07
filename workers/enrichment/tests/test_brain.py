from __future__ import annotations

import asyncio
import json
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any, cast
from uuid import uuid4

from backend.app.schemas import RawEvent
from workers.enrichment.app.brain import (
    BrainConfig,
    BrainRunner,
    QwenAPIClient,
    build_brain_graph,
    ingest_node,
    initial_state_from_raw_event,
    route_after_ingest,
    validate_node,
)

VALID_EXTRACTION = {
    "entities": [
        {
            "id": "11111111-1111-4111-8111-111111111111",
            "entity_type": "ORG",
            "confidence": 0.94,
            "source_count": 1,
            "last_updated": "2026-05-04T12:00:00Z",
        },
        {
            "id": "22222222-2222-4222-8222-222222222222",
            "entity_type": "PERSON",
            "confidence": 0.91,
            "source_count": 1,
            "last_updated": "2026-05-04T12:00:00Z",
        },
        {
            "id": "33333333-3333-4333-8333-333333333333",
            "entity_type": "GEO",
            "confidence": 0.88,
            "source_count": 1,
            "last_updated": "2026-05-04T12:00:00Z",
        },
        {
            "id": "44444444-4444-4444-8444-444444444444",
            "entity_type": "EVENT",
            "confidence": 0.87,
            "source_count": 1,
            "last_updated": "2026-05-04T12:00:00Z",
        },
    ],
    "relationships": [
        {
            "confidence": 0.84,
            "valid_from": "2026-05-04T12:00:00Z",
            "evidence_text": "Riya Shah represented Acme Maritime at Harbor Forum in Mumbai.",
        }
    ],
}


@dataclass(frozen=True)
class FakeRecord:
    value: RawEvent


class FakeConsumer:
    def __init__(self, events: list[RawEvent]) -> None:
        self.events = events
        self.started = False
        self.stopped = False

    async def start(self) -> None:
        self.started = True

    async def stop(self) -> None:
        self.stopped = True

    async def records(self) -> Any:
        for event in self.events:
            yield FakeRecord(event)


class FakeExtractionClient:
    def __init__(
        self,
        payload: dict[str, Any] | list[Any] | list[dict[str, Any] | list[Any]],
        *,
        failures_before_success: int = 0,
    ) -> None:
        self.payloads = payload if isinstance(payload, list) else [payload]
        self.failures_before_success = failures_before_success
        self.calls: list[dict[str, Any]] = []

    async def extract_universal_schema_json(
        self,
        *,
        markdown: str,
        source_uri: str,
        fetch_timestamp: datetime | None,
        error_log: list[str] | None = None,
        retry_counter: int = 0,
    ) -> dict[str, Any] | list[Any]:
        self.calls.append(
            {
                "markdown": markdown,
                "source_uri": source_uri,
                "fetch_timestamp": fetch_timestamp,
                "error_log": error_log or [],
                "retry_counter": retry_counter,
            }
        )
        if self.failures_before_success > 0:
            self.failures_before_success -= 1
            raise RuntimeError("temporary model failure")
        index = min(len(self.calls) - 1, len(self.payloads) - 1)
        return self.payloads[index]


def make_raw_event(markdown: str) -> RawEvent:
    return RawEvent(
        id=uuid4(),
        collector_name="public-web",
        source_uri="https://example.test/document",
        content_type="text/markdown",
        fetch_timestamp=datetime.now(UTC),
        raw_markdown_payload=markdown,
    )


def test_ingest_populates_state_and_routes_to_primary_extract() -> None:
    event = make_raw_event("# Public note\n\nPlain civic update.")

    state = ingest_node(initial_state_from_raw_event(event))

    assert state["original_raw_markdown"] == event.raw_markdown_payload
    assert state["attempted_json_extraction"] is None
    assert state["retry_counter"] == 0
    assert route_after_ingest(state) == "Extract"


def test_brain_graph_calls_extract_node_after_ingest() -> None:
    async def run() -> None:
        markdown = "# Bulletin\n\nRiya Shah represented Acme Maritime at Harbor Forum in Mumbai."
        event = make_raw_event(markdown)
        client = FakeExtractionClient(VALID_EXTRACTION)
        graph = build_brain_graph(BrainConfig(max_extraction_retries=1), extraction_client=client)

        final_state = await graph.ainvoke(initial_state_from_raw_event(event))

        assert final_state["original_raw_markdown"] == markdown
        assert len(client.calls) == 1
        assert client.calls[0]["markdown"] == markdown
        assert final_state["attempted_json_extraction"]["entities"][0]["entity_type"] == "ORG"
        assert final_state["attempted_json_extraction"]["entities"][1]["entity_type"] == "PERSON"
        assert final_state["attempted_json_extraction"]["entities"][2]["entity_type"] == "GEO"
        assert final_state["attempted_json_extraction"]["entities"][3]["entity_type"] == "EVENT"
        assert final_state["attempted_json_extraction"]["relationships"][0]["confidence"] == 0.84
        assert final_state["formatted_json_extraction"] == final_state["attempted_json_extraction"]
        assert final_state["validation_passed"] is True
        assert final_state["error_log"] == []
        assert final_state["retry_counter"] == 0

    asyncio.run(run())


def test_validate_node_records_specific_schema_errors_and_increments_retry() -> None:
    invalid_state = {
        "attempted_json_extraction": {
            "entities": [{"entity_type": "FACILITY", "source_count": 1}],
            "relationships": [],
        },
        "error_log": [],
        "retry_counter": 0,
    }

    state = validate_node(cast(Any, invalid_state))

    assert state["validation_passed"] is False
    assert state["retry_counter"] == 1
    assert state["formatted_json_extraction"] is None
    assert "entities.0.entity_type" in state["error_log"][0]
    assert "entities.0.confidence" in state["error_log"][0]


def test_brain_graph_retries_with_validation_error_feedback_then_formats() -> None:
    async def run() -> None:
        event = make_raw_event("# Bulletin\n\nRiya Shah represented Acme Maritime at Harbor Forum in Mumbai.")
        client = FakeExtractionClient(
            [
                {"entities": [{"entity_type": "FACILITY", "source_count": 1}], "relationships": []},
                VALID_EXTRACTION,
            ]
        )
        graph = build_brain_graph(BrainConfig(max_extraction_retries=1), extraction_client=client)

        final_state = await graph.ainvoke(initial_state_from_raw_event(event))

        assert final_state["validation_passed"] is True
        assert final_state["retry_counter"] == 1
        assert len(client.calls) == 2
        assert client.calls[1]["retry_counter"] == 1
        assert any("entities.0.entity_type" in entry for entry in client.calls[1]["error_log"])
        assert final_state["formatted_json_extraction"] == final_state["attempted_json_extraction"]

    asyncio.run(run())


def test_brain_graph_quarantines_after_validation_retry_budget_is_exhausted() -> None:
    async def run() -> None:
        event = make_raw_event("# Public note\n\nNo structured object is present.")
        client = FakeExtractionClient({"entities": [{"entity_type": "FACILITY"}], "relationships": []})
        graph = build_brain_graph(BrainConfig(max_extraction_retries=1), extraction_client=client)

        final_state = await graph.ainvoke(initial_state_from_raw_event(event))

        assert final_state["attempted_json_extraction"] is not None
        assert final_state["formatted_json_extraction"] is None
        assert final_state["validation_passed"] is False
        assert final_state["retry_counter"] == 2
        assert len(client.calls) == 2
        assert any("Validate failed" in entry for entry in final_state["error_log"])
        assert any("Quarantined RawEvent" in entry for entry in final_state["error_log"])

    asyncio.run(run())


def test_qwen_api_client_uses_deterministic_schema_extraction_payload() -> None:
    async def run() -> None:
        captured: dict[str, Any] = {}

        async def post_json(url: str, payload: dict[str, Any], timeout_seconds: float) -> dict[str, Any]:
            captured["url"] = url
            captured["payload"] = payload
            captured["timeout_seconds"] = timeout_seconds
            return {"choices": [{"message": {"content": json.dumps(VALID_EXTRACTION)}}]}

        client = QwenAPIClient(
            BrainConfig(
                llm_base_url="http://localhost:8088/v1",
                llm_model="Qwen/Qwen3.5-4B",
                extraction_temperature=0.1,
                llm_timeout_seconds=12.0,
            ),
            post_json=post_json,
        )

        result = await client.extract_universal_schema_json(
            markdown="# Bulletin\n\nRiya Shah represented Acme Maritime at Harbor Forum in Mumbai.",
            source_uri="https://example.test/document",
            fetch_timestamp=datetime(2026, 5, 4, 12, 0, tzinfo=UTC),
        )

        payload = captured["payload"]
        system_prompt = payload["messages"][0]["content"]
        user_prompt = payload["messages"][1]["content"]
        assert captured["url"] == "http://localhost:8088/v1/chat/completions"
        assert captured["timeout_seconds"] == 12.0
        assert payload["model"] == "Qwen/Qwen3.5-4B"
        assert payload["temperature"] == 0.1
        assert payload["response_format"] == {"type": "json_object"}
        assert "ORG, PERSON, GEO, and EVENT" in system_prompt
        assert "conforming exactly to the Entity schema" in system_prompt
        assert "Relationship schema" in system_prompt
        assert "Source URI: https://example.test/document" in user_prompt
        assert result == VALID_EXTRACTION

    asyncio.run(run())


def test_qwen_api_client_injects_validation_errors_on_retry() -> None:
    async def run() -> None:
        captured: dict[str, Any] = {}

        async def post_json(url: str, payload: dict[str, Any], timeout_seconds: float) -> dict[str, Any]:
            captured["payload"] = payload
            return {"choices": [{"message": {"content": json.dumps(VALID_EXTRACTION)}}]}

        client = QwenAPIClient(BrainConfig(), post_json=post_json)

        await client.extract_universal_schema_json(
            markdown="# Bulletin\n\nRiya Shah represented Acme Maritime at Harbor Forum in Mumbai.",
            source_uri="https://example.test/document",
            fetch_timestamp=datetime(2026, 5, 4, 12, 0, tzinfo=UTC),
            error_log=["Validate failed on attempt 1: entities.0.confidence: Field required"],
            retry_counter=1,
        )

        user_prompt = captured["payload"]["messages"][1]["content"]
        assert "Retry correction required" in user_prompt
        assert "entities.0.confidence: Field required" in user_prompt
        assert "Do not repeat any listed violation" in user_prompt

    asyncio.run(run())


def test_brain_runner_reads_raw_events_from_consumer() -> None:
    async def run() -> None:
        event = make_raw_event("# Bulletin\n\nRiya Shah represented Acme Maritime at Harbor Forum in Mumbai.")
        consumer = FakeConsumer([event])
        client = FakeExtractionClient(VALID_EXTRACTION)
        states: list[dict[str, Any]] = []
        runner = BrainRunner(
            BrainConfig(max_extraction_retries=0),
            raw_event_consumer=cast(Any, consumer),
            extraction_client=client,
            on_state=lambda state: states.append(dict(state)),
        )

        await runner.run(max_records=1)

        assert consumer.started is True
        assert consumer.stopped is True
        assert len(states) == 1
        assert states[0]["original_raw_markdown"] == event.raw_markdown_payload
        assert states[0]["attempted_json_extraction"]["relationships"][0]["confidence"] == 0.84
        assert states[0]["formatted_json_extraction"] == states[0]["attempted_json_extraction"]

    asyncio.run(run())
