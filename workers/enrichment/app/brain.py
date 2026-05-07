from __future__ import annotations

import asyncio
import json
import operator
import re
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from datetime import datetime
from importlib import import_module
from typing import Annotated, Any, Literal, NotRequired, Protocol, TypedDict, cast

from backend.app.bus import AsyncSchemaConsumer, EventBusConfig
from backend.app.schemas import Entity, RawEvent, Relationship, UniversalSchema
from backend.app.schemas.core import FORBIDDEN_DOMAIN_TERMS
from pydantic import Field, ValidationError

ErrorLog = Annotated[list[str], operator.add]
IngestRouteName = Literal["Extract", "Quarantine"]
ValidateRouteName = Literal["Extract", "Quarantine", "Format"]

JSON_BLOCK_PATTERN = re.compile(r"```(?:json)?\s*(\{.*?\}|\[.*?\])\s*```", re.IGNORECASE | re.DOTALL)
JSON_OBJECT_PATTERN = re.compile(r"(\{.*\}|\[.*\])", re.DOTALL)

EXTRACTION_SYSTEM_PROMPT = """
You are the Extract node in a local stateful OSINT graph. Analyze only the provided raw Markdown.

Your task:
- Extract every recognizable entity that is explicitly present in the Markdown.
- Entity types are exactly ORG, PERSON, GEO, and EVENT.
- Extract semantic relationships connecting recognized entities when the Markdown gives evidence for that connection.
- Do not infer facts from outside knowledge, do not speculate, and do not create entities that are not supported by the Markdown.

Strict output contract:
- Return one JSON object only, with exactly two top-level keys: entities and relationships.
- entities must be an array of objects conforming exactly to the Entity schema.
- relationships must be an array of objects conforming exactly to the Relationship schema.
- Do not wrap the JSON in Markdown fences. Do not include commentary.
- Do not add fields such as name, label, source, target, relationship_type, aliases, or metadata.

Entity schema, exact fields only:
- id: valid RFC 4122 UUID string. Use a stable UUID for the normalized entity mention and type.
- entity_type: one of ORG, PERSON, GEO, EVENT.
- confidence: factual confidence as a float from 0.0 to 1.0.
- source_count: integer count of distinct source mentions in this Markdown.
- last_updated: ISO-8601 UTC timestamp. Use the supplied fetch timestamp unless the Markdown gives a clearer timestamp.

Relationship schema, exact fields only:
- confidence: factual confidence as a float from 0.0 to 1.0.
- valid_from: ISO-8601 UTC timestamp. Use an explicit event/date timestamp when present, otherwise use the fetch timestamp.
- evidence_text: concise source-grounded sentence describing the semantic connection and naming the related entities.

Quality rules:
- Use empty arrays when no entities or relationships are present.
- Prefer precise extraction over recall when the text is ambiguous.
- Keep evidence_text under 8192 characters.
- Avoid these blocked domain-specific terms in all JSON string values: {blocked_terms}.
""".strip().format(blocked_terms=", ".join(sorted(FORBIDDEN_DOMAIN_TERMS)))


class UniversalExtraction(UniversalSchema):
    entities: tuple[Entity, ...] = Field(default_factory=tuple)
    relationships: tuple[Relationship, ...] = Field(default_factory=tuple)


class BrainState(TypedDict, total=False):
    raw_event: NotRequired[RawEvent]
    raw_event_id: str
    source_uri: str
    original_raw_markdown: str
    attempted_json_extraction: dict[str, Any] | list[Any] | None
    formatted_json_extraction: dict[str, Any] | None
    validation_passed: bool
    error_log: ErrorLog
    retry_counter: int


@dataclass(frozen=True, slots=True)
class BrainConfig:
    raw_topic: str = "osint.raw.events"
    group_id: str = "osint-brain"
    max_extraction_retries: int = 2
    llm_base_url: str = "http://localhost:8088/v1"
    llm_model: str = "Qwen/Qwen3.5-4B"
    extraction_temperature: float = 0.1
    llm_timeout_seconds: float = 30.0
    llm_max_tokens: int = 2048


StateCallback = Callable[[BrainState], Awaitable[None] | None]
PostJson = Callable[[str, dict[str, Any], float], Awaitable[dict[str, Any]]]


class ExtractionClient(Protocol):
    async def extract_universal_schema_json(
        self,
        *,
        markdown: str,
        source_uri: str,
        fetch_timestamp: datetime | None,
        error_log: list[str] | None = None,
        retry_counter: int = 0,
    ) -> dict[str, Any] | list[Any]: ...


class QwenAPIClient:
    def __init__(self, config: BrainConfig, *, post_json: PostJson | None = None) -> None:
        self.config = config
        self._post_json = post_json or self._default_post_json

    async def extract_universal_schema_json(
        self,
        *,
        markdown: str,
        source_uri: str,
        fetch_timestamp: datetime | None,
        error_log: list[str] | None = None,
        retry_counter: int = 0,
    ) -> dict[str, Any] | list[Any]:
        payload = {
            "model": self.config.llm_model,
            "temperature": self.config.extraction_temperature,
            "max_tokens": self.config.llm_max_tokens,
            "stream": False,
            "response_format": {"type": "json_object"},
            "messages": [
                {"role": "system", "content": EXTRACTION_SYSTEM_PROMPT},
                {
                    "role": "user",
                    "content": build_extraction_user_prompt(
                        markdown=markdown,
                        source_uri=source_uri,
                        fetch_timestamp=fetch_timestamp,
                        error_log=error_log,
                        retry_counter=retry_counter,
                    ),
                },
            ],
        }
        data = await self._post_json(
            f"{self.config.llm_base_url.rstrip('/')}/chat/completions",
            payload,
            self.config.llm_timeout_seconds,
        )
        content = extract_chat_completion_content(data)
        return extract_first_json_payload(content)

    @staticmethod
    async def _default_post_json(
        url: str,
        payload: dict[str, Any],
        timeout_seconds: float,
    ) -> dict[str, Any]:
        httpx = import_module("httpx")
        async with httpx.AsyncClient(timeout=timeout_seconds) as client:
            response = await client.post(url, json=payload)
            response.raise_for_status()
            return cast(dict[str, Any], response.json())


class ExtractNode:
    def __init__(self, extraction_client: ExtractionClient) -> None:
        self.extraction_client = extraction_client

    async def __call__(self, state: BrainState) -> BrainState:
        raw_event = state.get("raw_event")
        markdown = state.get("original_raw_markdown", "")
        try:
            extracted = await self.extraction_client.extract_universal_schema_json(
                markdown=markdown,
                source_uri=state.get("source_uri", ""),
                fetch_timestamp=raw_event.fetch_timestamp if raw_event is not None else None,
                error_log=state.get("error_log", []),
                retry_counter=state.get("retry_counter", 0),
            )
        except Exception as exc:
            return {
                "attempted_json_extraction": None,
                "validation_passed": False,
                "error_log": [f"Extract failed on retry {state.get('retry_counter', 0)}: {exc}"],
            }
        return {"attempted_json_extraction": extracted, "validation_passed": False}


def initial_state_from_raw_event(raw_event: RawEvent) -> BrainState:
    return {
        "raw_event": raw_event,
        "raw_event_id": str(raw_event.id),
        "source_uri": raw_event.source_uri,
        "original_raw_markdown": "",
        "attempted_json_extraction": None,
        "formatted_json_extraction": None,
        "validation_passed": False,
        "error_log": [],
        "retry_counter": 0,
    }


def ingest_node(state: BrainState) -> BrainState:
    raw_event = state.get("raw_event")
    if raw_event is None:
        return {
            "original_raw_markdown": "",
            "attempted_json_extraction": None,
            "formatted_json_extraction": None,
            "validation_passed": False,
            "error_log": ["Ingest could not find a RawEvent in graph state."],
            "retry_counter": state.get("retry_counter", 0),
        }
    return {
        "raw_event_id": str(raw_event.id),
        "source_uri": raw_event.source_uri,
        "original_raw_markdown": raw_event.raw_markdown_payload,
        "attempted_json_extraction": None,
        "formatted_json_extraction": None,
        "validation_passed": False,
        "retry_counter": state.get("retry_counter", 0),
    }


def route_after_ingest(state: BrainState) -> IngestRouteName:
    if state.get("original_raw_markdown"):
        return "Extract"
    return "Quarantine"


def validate_node(state: BrainState) -> BrainState:
    try:
        validated = validate_universal_extraction_payload(state.get("attempted_json_extraction"))
    except (TypeError, ValueError, ValidationError) as exc:
        retry_counter = state.get("retry_counter", 0) + 1
        return {
            "validation_passed": False,
            "formatted_json_extraction": None,
            "error_log": [f"Validate failed on attempt {retry_counter}: {format_validation_error(exc)}"],
            "retry_counter": retry_counter,
        }
    return {
        "attempted_json_extraction": validated,
        "formatted_json_extraction": None,
        "validation_passed": True,
    }


def route_after_validate(max_retries: int) -> Callable[[BrainState], ValidateRouteName]:
    def route(state: BrainState) -> ValidateRouteName:
        if state.get("validation_passed") is True:
            return "Format"
        if state.get("retry_counter", 0) <= max_retries:
            return "Extract"
        return "Quarantine"

    return route


def format_node(state: BrainState) -> BrainState:
    extraction = state.get("attempted_json_extraction")
    return {"formatted_json_extraction": extraction if isinstance(extraction, dict) else None}


def quarantine_node(state: BrainState) -> BrainState:
    raw_event_id = state.get("raw_event_id", "unknown")
    return {
        "error_log": [
            f"Quarantined RawEvent {raw_event_id} after {state.get('retry_counter', 0)} retries."
        ]
    }


def extract_first_json_payload(markdown: str) -> dict[str, Any] | list[Any]:
    candidates = [match.group(1) for match in JSON_BLOCK_PATTERN.finditer(markdown)]
    if not candidates:
        object_match = JSON_OBJECT_PATTERN.search(markdown)
        if object_match is not None:
            candidates.append(object_match.group(1))

    for candidate in candidates:
        try:
            parsed = json.loads(candidate)
        except json.JSONDecodeError:
            continue
        if isinstance(parsed, (dict, list)):
            return parsed
    raise ValueError("no valid JSON object or array was found in RawEvent Markdown")


def validate_universal_extraction_payload(payload: dict[str, Any] | list[Any] | None) -> dict[str, Any]:
    if not isinstance(payload, dict):
        raise ValueError("Universal Schema extraction must be a JSON object")
    envelope = UniversalExtraction.model_validate_json(json.dumps(payload, ensure_ascii=False))
    return cast(dict[str, Any], envelope.model_dump(mode="json"))


def format_validation_error(exc: Exception) -> str:
    if isinstance(exc, ValidationError):
        messages = []
        for error in exc.errors(include_url=False):
            location = ".".join(str(part) for part in error.get("loc", ())) or "payload"
            messages.append(f"{location}: {error.get('msg', 'invalid value')}")
        return "; ".join(messages)
    return str(exc)


def build_extraction_user_prompt(
    *,
    markdown: str,
    source_uri: str,
    fetch_timestamp: datetime | None,
    error_log: list[str] | None = None,
    retry_counter: int = 0,
) -> str:
    fetched_at = fetch_timestamp.isoformat() if fetch_timestamp is not None else "unknown"
    retry_feedback = ""
    if retry_counter > 0 and error_log:
        recent_errors = "\n".join(f"- {entry}" for entry in error_log[-8:])
        retry_feedback = (
            "\n\nRetry correction required. The previous output failed strict schema validation. "
            "Fix these specific violations and return a corrected JSON object only:\n"
            f"{recent_errors}\n"
            "Do not repeat any listed violation. Preserve supported facts from the raw Markdown only."
        )
    return (
        f"Source URI: {source_uri}\n"
        f"Fetch timestamp: {fetched_at}\n\n"
        "Raw Markdown begins below. Extract only from this content.\n"
        "<raw_markdown>\n"
        f"{markdown}\n"
        "</raw_markdown>"
        f"{retry_feedback}"
    )


def extract_chat_completion_content(data: dict[str, Any]) -> str:
    choices = data.get("choices")
    if not isinstance(choices, list) or not choices:
        raise ValueError("LLM response did not include choices")
    first_choice = choices[0]
    if not isinstance(first_choice, dict):
        raise ValueError("LLM response choice was not an object")
    message = first_choice.get("message")
    if not isinstance(message, dict):
        raise ValueError("LLM response choice did not include a message")
    content = message.get("content")
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        text_parts = [part.get("text", "") for part in content if isinstance(part, dict)]
        joined = "".join(text_parts)
        if joined:
            return joined
    raise ValueError("LLM response message did not include text content")


def build_brain_graph(
    config: BrainConfig | None = None,
    *,
    extraction_client: ExtractionClient | None = None,
) -> Any:
    graph_config = config or BrainConfig()
    langgraph = import_module("langgraph.graph")
    state_graph = langgraph.StateGraph(BrainState)
    state_graph.add_node("Ingest", ingest_node)
    state_graph.add_node("Extract", ExtractNode(extraction_client or QwenAPIClient(graph_config)))
    state_graph.add_node("Validate", validate_node)
    state_graph.add_node("Format", format_node)
    state_graph.add_node("Quarantine", quarantine_node)

    state_graph.add_edge(langgraph.START, "Ingest")
    state_graph.add_conditional_edges(
        "Ingest",
        route_after_ingest,
        {"Extract": "Extract", "Quarantine": "Quarantine"},
    )
    state_graph.add_edge("Extract", "Validate")
    state_graph.add_conditional_edges(
        "Validate",
        route_after_validate(graph_config.max_extraction_retries),
        {"Format": "Format", "Extract": "Extract", "Quarantine": "Quarantine"},
    )
    state_graph.add_edge("Format", langgraph.END)
    state_graph.add_edge("Quarantine", langgraph.END)
    return state_graph.compile()


class BrainRunner:
    def __init__(
        self,
        config: BrainConfig,
        *,
        event_bus_config: EventBusConfig | None = None,
        raw_event_consumer: AsyncSchemaConsumer[RawEvent] | None = None,
        extraction_client: ExtractionClient | None = None,
        graph: Any | None = None,
        on_state: StateCallback | None = None,
    ) -> None:
        self.config = config
        self.event_bus_config = event_bus_config or EventBusConfig(client_id="osint-brain")
        self.raw_event_consumer = raw_event_consumer
        self.graph = graph or build_brain_graph(config, extraction_client=extraction_client)
        self.on_state = on_state

    async def start(self) -> None:
        if self.raw_event_consumer is None:
            self.raw_event_consumer = AsyncSchemaConsumer(
                self.event_bus_config,
                RawEvent,
                [self.config.raw_topic],
                self.config.group_id,
            )
        await self.raw_event_consumer.start()

    async def stop(self) -> None:
        if self.raw_event_consumer is not None:
            await self.raw_event_consumer.stop()

    async def run(self, *, max_records: int | None = None) -> None:
        await self.start()
        assert self.raw_event_consumer is not None
        processed = 0
        try:
            async for record in self.raw_event_consumer.records():
                await self.process_raw_event(record.value)
                processed += 1
                if max_records is not None and processed >= max_records:
                    break
        finally:
            await self.stop()

    async def process_raw_event(self, raw_event: RawEvent) -> BrainState:
        initial_state = initial_state_from_raw_event(raw_event)
        if hasattr(self.graph, "ainvoke"):
            result = await self.graph.ainvoke(initial_state)
        else:
            result = self.graph.invoke(initial_state)
        final_state = cast(BrainState, result)
        if self.on_state is not None:
            callback_result = self.on_state(final_state)
            if asyncio.iscoroutine(callback_result):
                await callback_result
        return final_state
