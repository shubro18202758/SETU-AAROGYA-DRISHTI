from __future__ import annotations

import asyncio
from collections.abc import Sequence
from datetime import UTC, datetime
from typing import Any, cast
from uuid import UUID, uuid4

import numpy as np
from fastapi import FastAPI
from fastapi.testclient import TestClient

from backend.app.intelligence import (
    EventNotificationHub,
    IntelligenceService,
    WebSocketConnectionManager,
    build_geo_graph_sqlscript,
    build_graphrag_sqlscript,
    create_intelligence_router,
    is_high_confidence_event,
)
from backend.app.schemas import Entity, EventEntityNotification


class FakeEmbeddingModel:
    def embed(self, texts: Sequence[str]) -> np.ndarray:
        assert texts == ["connections near harbor forum"]
        return np.asarray([[0.6, 0.8, 0.0]], dtype=np.float32)


class FakeGraphRAGRepository:
    def __init__(self) -> None:
        self.embeddings: list[list[float]] = []

    async def connected_subgraph(self, query_embedding: Sequence[float]) -> dict[str, Any]:
        self.embeddings.append([float(value) for value in query_embedding])
        return {
            "seed_relationships": [
                {
                    "relationship_uid": "rel:seed",
                    "source_entity_id": "11111111-1111-4111-8111-111111111111",
                    "destination_entity_id": "22222222-2222-4222-8222-222222222222",
                    "confidence": 0.84,
                    "valid_from": "2026-05-04T12:00:00+00:00",
                    "evidence_text": "Riya Shah represented Acme Maritime at Harbor Forum in Mumbai.",
                }
            ],
            "entities": [
                {
                    "id": "11111111-1111-4111-8111-111111111111",
                    "entity_type": "PERSON",
                    "confidence": 0.91,
                    "source_count": 1,
                    "last_updated": "2026-05-04T12:00:00+00:00",
                    "canonical_name": "Riya Shah",
                },
                {
                    "id": "22222222-2222-4222-8222-222222222222",
                    "entity_type": "ORG",
                    "confidence": 0.9,
                    "source_count": 2,
                    "last_updated": "2026-05-04T12:00:00+00:00",
                    "canonical_name": "Acme Maritime",
                },
            ],
            "relationships": [
                {
                    "relationship_uid": "rel:seed",
                    "source_entity_id": "11111111-1111-4111-8111-111111111111",
                    "destination_entity_id": "22222222-2222-4222-8222-222222222222",
                    "confidence": 0.84,
                    "valid_from": "2026-05-04T12:00:00+00:00",
                    "evidence_text": "Riya Shah represented Acme Maritime at Harbor Forum in Mumbai.",
                }
            ],
        }

    async def geo_graph(self, limit: int) -> dict[str, Any]:
        return {
            "locations": [
                {
                    "id": "33333333-3333-4333-8333-333333333333",
                    "entity_type": "GEO",
                    "confidence": 0.88,
                    "source_count": 2,
                    "last_updated": "2026-05-04T12:00:00+00:00",
                    "canonical_name": "Mumbai",
                    "latitude": 19.076,
                    "longitude": 72.8777,
                }
            ],
            "connected_entities": [
                {
                    "id": "11111111-1111-4111-8111-111111111111",
                    "entity_type": "PERSON",
                    "confidence": 0.91,
                    "last_updated": "2026-05-04T12:00:00+00:00",
                    "canonical_name": "Riya Shah",
                }
            ],
            "relationships": [
                {
                    "relationship_uid": "rel:geo-person",
                    "source_entity_id": "33333333-3333-4333-8333-333333333333",
                    "destination_entity_id": "11111111-1111-4111-8111-111111111111",
                    "confidence": 0.87,
                    "valid_from": "2026-05-04T12:00:00+00:00",
                    "evidence_text": "Riya Shah appeared at Harbor Forum in Mumbai.",
                }
            ],
        }


class FakeWebSocket:
    def __init__(self) -> None:
        self.accepted = False
        self.payloads: list[dict[str, Any]] = []

    async def accept(self) -> None:
        self.accepted = True

    async def send_json(self, payload: dict[str, Any]) -> None:
        self.payloads.append(payload)


def make_event_notification(confidence: float = 0.91, entity_type: str = "EVENT") -> EventEntityNotification:
    return EventEntityNotification(
        id=uuid4(),
        entity=Entity(
            id=UUID("33333333-3333-4333-8333-333333333333"),
            entity_type=cast(Any, entity_type),
            confidence=confidence,
            source_count=1,
            last_updated=datetime(2026, 5, 4, 12, 0, tzinfo=UTC),
        ),
        canonical_name="Harbor Forum",
        persisted_at=datetime(2026, 5, 4, 12, 1, tzinfo=UTC),
        source_batch_id=uuid4(),
    )


def test_graphrag_sqlscript_uses_vector_search_then_three_hop_traversal() -> None:
    script = build_graphrag_sqlscript([0.6, 0.8, 0.0])

    assert "vectorNeighbors('SemanticRelationship[evidence_embedding]', [0.6,0.8,0.0], 5)" in script
    assert "TRAVERSE both('SemanticRelationship')" in script
    assert "MAXDEPTH 3" in script
    assert "WHERE outV() IN $entities AND inV() IN $entities" in script


def test_geo_graph_sqlscript_fetches_geo_relationships_and_people_or_orgs() -> None:
    script = build_geo_graph_sqlscript(5000)

    assert "SELECT FROM Entity WHERE entity_type = 'GEO'" in script
    assert "source_entity_id IN $geoIds OR destination_entity_id IN $geoIds" in script
    assert "entity_type IN ['ORG', 'PERSON']" in script
    assert "LIMIT 5000" in script


def test_graphrag_endpoint_returns_connected_subgraph() -> None:
    repository = FakeGraphRAGRepository()
    service = IntelligenceService(repository, FakeEmbeddingModel())
    hub = EventNotificationHub(WebSocketConnectionManager())
    app = FastAPI()
    app.include_router(create_intelligence_router(service, hub))
    client = TestClient(app)

    response = client.post("/intelligence/graphrag", json={"query": "connections near harbor forum"})

    assert response.status_code == 200
    body = response.json()
    assert body["vector_top_k"] == 5
    assert body["traversal_hops"] == 3
    assert body["entities"][0]["canonical_name"] == "Riya Shah"
    assert body["relationships"][0]["id"] == "rel:seed"
    assert repository.embeddings == [[0.6000000238418579, 0.800000011920929, 0.0]]


def test_geo_endpoint_returns_locations_relationships_and_connected_entities() -> None:
    repository = FakeGraphRAGRepository()
    service = IntelligenceService(repository, FakeEmbeddingModel())
    hub = EventNotificationHub(WebSocketConnectionManager())
    app = FastAPI()
    app.include_router(create_intelligence_router(service, hub))
    client = TestClient(app)

    response = client.get("/intelligence/geo?limit=5000")

    assert response.status_code == 200
    body = response.json()
    assert body["limit"] == 5000
    assert body["locations"][0]["canonical_name"] == "Mumbai"
    assert body["locations"][0]["latitude"] == 19.076
    assert body["connected_entities"][0]["entity_type"] == "PERSON"
    assert body["relationships"][0]["id"] == "rel:geo-person"


def test_websocket_hub_filters_for_high_confidence_event_entities() -> None:
    async def run() -> None:
        manager = WebSocketConnectionManager()
        hub = EventNotificationHub(manager)
        websocket = FakeWebSocket()
        await manager.connect(cast(Any, websocket))

        await hub.publish(make_event_notification(0.85, "EVENT"))
        await hub.publish(make_event_notification(0.91, "ORG"))
        await hub.publish(make_event_notification(0.91, "EVENT"))

        assert websocket.accepted is True
        assert len(websocket.payloads) == 1
        assert websocket.payloads[0]["canonical_name"] == "Harbor Forum"
        assert websocket.payloads[0]["entity"]["entity_type"] == "EVENT"

    asyncio.run(run())


def test_high_confidence_event_filter_is_strictly_above_threshold() -> None:
    assert is_high_confidence_event(make_event_notification(0.86, "EVENT")) is True
    assert is_high_confidence_event(make_event_notification(0.85, "EVENT")) is False
    assert is_high_confidence_event(make_event_notification(0.95, "PERSON")) is False
