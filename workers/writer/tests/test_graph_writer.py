from __future__ import annotations

import asyncio
import re
from collections.abc import Sequence
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any, cast
from uuid import UUID, uuid4

import numpy as np

from backend.app.schemas import (
    Entity,
    EventEntityNotification,
    GraphEntityUpsert,
    GraphRelationshipUpsert,
    GraphWriteBatch,
    Relationship,
)
from workers.writer.app.graph_writer import (
    ArcadeDBGraphWriter,
    DatabaseWriterService,
    LocalEvidenceEmbeddingModel,
    WriterConfig,
    build_graph_write_script,
    build_schema_bootstrap_commands,
    high_confidence_event_notifications,
    immutable_relationship_uid,
)


@dataclass(frozen=True)
class FakeRecord:
    value: GraphWriteBatch


class FakeConsumer:
    def __init__(self, batches: list[GraphWriteBatch]) -> None:
        self.batches = batches
        self.started = False
        self.stopped = False

    async def start(self) -> None:
        self.started = True

    async def stop(self) -> None:
        self.stopped = True

    async def records(self) -> Any:
        for batch in self.batches:
            yield FakeRecord(batch)


class FakeArcadeClient:
    def __init__(self) -> None:
        self.calls: list[tuple[str, str]] = []

    async def command(self, language: str, command: str) -> list[dict[str, Any]]:
        self.calls.append((language, command))
        return []


class FakeNotificationProducer:
    def __init__(self) -> None:
        self.started = False
        self.stopped = False
        self.sent: list[tuple[str, EventEntityNotification, dict[str, Any]]] = []

    async def start(self) -> None:
        self.started = True

    async def stop(self) -> None:
        self.stopped = True

    async def send(self, topic: str, value: EventEntityNotification, **kwargs: Any) -> None:
        self.sent.append((topic, value, kwargs))


class FixedEmbeddingModel:
    def embed(self, texts: Sequence[str]) -> np.ndarray:
        assert texts
        return np.asarray([[3.0, 4.0, 0.0] for _ in texts], dtype=np.float32)


def make_entity(entity_id: UUID, entity_type: str, source_count: int = 1) -> Entity:
    return Entity(
        id=entity_id,
        entity_type=cast(Any, entity_type),
        confidence=0.91,
        source_count=source_count,
        last_updated=datetime(2026, 5, 4, 12, 0, tzinfo=UTC),
    )


def make_batch(valid_from: datetime | None = None) -> GraphWriteBatch:
    source_id = UUID("11111111-1111-4111-8111-111111111111")
    destination_id = UUID("22222222-2222-4222-8222-222222222222")
    return GraphWriteBatch(
        id=uuid4(),
        created_at=datetime(2026, 5, 4, 12, 5, tzinfo=UTC),
        entities=(
            GraphEntityUpsert(entity=make_entity(source_id, "PERSON"), canonical_name="Riya Shah"),
            GraphEntityUpsert(entity=make_entity(destination_id, "ORG", 3), canonical_name="Acme Maritime"),
        ),
        relationships=(
            GraphRelationshipUpsert(
                source_entity_id=source_id,
                destination_entity_id=destination_id,
                relationship=Relationship(
                    confidence=0.84,
                    valid_from=valid_from or datetime(2026, 5, 4, 12, 0, tzinfo=UTC),
                    evidence_text="Riya Shah represented Acme Maritime at Harbor Forum in Mumbai.",
                ),
            ),
        ),
    )


def make_event_batch(confidence: float = 0.91) -> GraphWriteBatch:
    event_id = UUID("33333333-3333-4333-8333-333333333333")
    return GraphWriteBatch(
        id=uuid4(),
        created_at=datetime(2026, 5, 4, 12, 5, tzinfo=UTC),
        entities=(
            GraphEntityUpsert(
                entity=Entity(
                    id=event_id,
                    entity_type="EVENT",
                    confidence=confidence,
                    source_count=1,
                    last_updated=datetime(2026, 5, 4, 12, 0, tzinfo=UTC),
                ),
                canonical_name="Harbor Forum",
            ),
        ),
        relationships=(),
    )


def test_schema_bootstrap_creates_hnsw_vector_index_on_edge_embedding() -> None:
    commands = build_schema_bootstrap_commands(WriterConfig(evidence_embedding_dimensions=192))
    joined = "\n".join(commands)

    assert "CREATE EDGE TYPE SemanticRelationship IF NOT EXISTS" in joined
    assert "CREATE PROPERTY SemanticRelationship.evidence_embedding ARRAY_OF_FLOATS" in joined
    assert "CREATE INDEX IF NOT EXISTS ON SemanticRelationship (evidence_embedding) LSM_VECTOR" in joined
    assert "dimensions: 192" in joined
    assert "similarity: 'COSINE'" in joined
    assert "buildGraphNow: true" in joined


def test_write_script_upserts_vertices_and_creates_immutable_vector_edge() -> None:
    batch = make_batch()
    script = build_graph_write_script(batch, FixedEmbeddingModel())

    assert script.startswith("begin;\n")
    assert script.endswith("\ncommit;")
    assert "UPDATE Entity SET" in script
    assert "UPSERT WHERE id = '11111111-1111-4111-8111-111111111111'" in script
    assert "CREATE EDGE SemanticRelationship IF NOT EXISTS" in script
    assert "valid_from = '2026-05-04T12:00:00+00:00'" in script
    assert "evidence_embedding = [0.6,0.8,0.0]" in script
    assert "source_batch_id" in script


def test_relationship_uid_preserves_temporal_history() -> None:
    first = make_batch(datetime(2026, 5, 4, 12, 0, tzinfo=UTC)).relationships[0]
    second = make_batch(datetime(2026, 5, 4, 13, 0, tzinfo=UTC)).relationships[0]

    assert immutable_relationship_uid(first) != immutable_relationship_uid(second)


def test_local_evidence_embedding_is_small_and_normalized() -> None:
    model = LocalEvidenceEmbeddingModel(dimensions=16)
    embedding = model.embed(["Riya Shah represented Acme Maritime."])

    assert embedding.shape == (1, 16)
    assert np.isclose(np.linalg.norm(embedding[0]), 1.0)


def test_high_confidence_event_notifications_filter_persisted_events() -> None:
    high_confidence = high_confidence_event_notifications(make_event_batch(0.91))
    low_confidence = high_confidence_event_notifications(make_event_batch(0.85))

    assert len(high_confidence) == 1
    assert high_confidence[0].entity.entity_type == "EVENT"
    assert high_confidence[0].entity.confidence == 0.91
    assert low_confidence == []


def test_writer_bootstraps_schema_and_executes_transactional_batch() -> None:
    async def run() -> None:
        client = FakeArcadeClient()
        writer = ArcadeDBGraphWriter(
            client,
            config=WriterConfig(evidence_embedding_dimensions=3),
            embedding_model=FixedEmbeddingModel(),
        )

        await writer.ensure_schema()
        await writer.write_batch(make_batch())

        assert client.calls[0][0] == "sqlscript"
        assert "LSM_VECTOR" in client.calls[0][1]
        assert client.calls[1][0] == "sqlscript"
        assert re.search(r"^begin;", client.calls[1][1])
        assert re.search(r"commit;$", client.calls[1][1])

    asyncio.run(run())


def test_service_consumes_graph_write_batches_from_event_bus() -> None:
    async def run() -> None:
        batch = make_batch()
        consumer = FakeConsumer([batch])
        client = FakeArcadeClient()
        writer = ArcadeDBGraphWriter(
            client,
            config=WriterConfig(evidence_embedding_dimensions=3),
            embedding_model=FixedEmbeddingModel(),
        )
        service = DatabaseWriterService(
            WriterConfig(),
            consumer=cast(Any, consumer),
            event_notification_producer=FakeNotificationProducer(),
            graph_writer=writer,
        )

        await service.run(max_records=1)

        assert consumer.started is True
        assert consumer.stopped is True
        assert len(client.calls) == 2
        assert "CREATE EDGE SemanticRelationship IF NOT EXISTS" in client.calls[1][1]

    asyncio.run(run())


def test_service_publishes_high_confidence_event_after_persistence() -> None:
    async def run() -> None:
        batch = make_event_batch()
        consumer = FakeConsumer([batch])
        client = FakeArcadeClient()
        producer = FakeNotificationProducer()
        writer = ArcadeDBGraphWriter(client, config=WriterConfig(evidence_embedding_dimensions=3))
        service = DatabaseWriterService(
            WriterConfig(event_notification_topic="osint.events.high_confidence"),
            consumer=cast(Any, consumer),
            event_notification_producer=producer,
            graph_writer=writer,
        )

        await service.run(max_records=1)

        assert producer.started is True
        assert producer.stopped is True
        assert len(producer.sent) == 1
        assert producer.sent[0][0] == "osint.events.high_confidence"
        assert producer.sent[0][1].canonical_name == "Harbor Forum"

    asyncio.run(run())
