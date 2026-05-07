from __future__ import annotations

import asyncio
import hashlib
import math
import unicodedata
from collections.abc import Sequence
from dataclasses import dataclass
from datetime import UTC, datetime
from importlib import import_module
from typing import Any, Protocol, cast
from uuid import uuid4

import numpy as np

from backend.app.bus import AsyncSchemaConsumer, AsyncSchemaProducer, ConsumedRecord, EventBusConfig
from backend.app.schemas import EventEntityNotification, GraphRelationshipUpsert, GraphWriteBatch

DEFAULT_GRAPH_WRITE_TOPIC = "osint.graph.write"
DEFAULT_EVENT_NOTIFICATION_TOPIC = "osint.events.high_confidence"
DEFAULT_WRITER_GROUP_ID = "osint-db-writer"
ENTITY_VERTEX_TYPE = "Entity"
RELATIONSHIP_EDGE_TYPE = "SemanticRelationship"
EVIDENCE_EMBEDDING_PROPERTY = "evidence_embedding"


class EvidenceEmbeddingModel(Protocol):
    def embed(self, texts: Sequence[str]) -> np.ndarray: ...


class GraphWriteConsumer(Protocol):
    async def start(self) -> None: ...

    async def stop(self) -> None: ...

    def records(self) -> Any: ...


class EventNotificationProducer(Protocol):
    async def start(self) -> None: ...

    async def stop(self) -> None: ...

    async def send(self, topic: str, value: EventEntityNotification, **kwargs: Any) -> Any: ...


class ArcadeCommandClient(Protocol):
    async def command(self, language: str, command: str) -> list[dict[str, Any]]: ...


@dataclass(frozen=True, slots=True)
class WriterConfig:
    graph_write_topic: str = DEFAULT_GRAPH_WRITE_TOPIC
    event_notification_topic: str = DEFAULT_EVENT_NOTIFICATION_TOPIC
    group_id: str = DEFAULT_WRITER_GROUP_ID
    arcadedb_url: str = "http://localhost:2480"
    arcadedb_database: str = "osint"
    arcadedb_user: str = "root"
    arcadedb_password: str = "change-me-local-only"
    evidence_embedding_dimensions: int = 192
    vector_similarity: str = "COSINE"
    vector_max_connections: int = 16
    vector_beam_width: int = 100


class LocalEvidenceEmbeddingModel:
    def __init__(self, dimensions: int = 192) -> None:
        self.dimensions = dimensions

    def embed(self, texts: Sequence[str]) -> np.ndarray:
        matrix = np.zeros((len(texts), self.dimensions), dtype=np.float32)
        for row_index, text in enumerate(texts):
            normalized = normalize_embedding_text(text)
            tokens = normalized.split()
            features = tokens + [normalized[index : index + 4] for index in range(max(len(normalized) - 3, 0))]
            for feature in features:
                digest = hashlib.blake2b(feature.encode("utf-8"), digest_size=8).digest()
                bucket = int.from_bytes(digest[:4], "little") % self.dimensions
                sign = 1.0 if digest[4] & 1 else -1.0
                matrix[row_index, bucket] += sign
        return normalize_matrix(matrix)


class ArcadeDBAsyncClient:
    def __init__(self, url: str, database: str, user: str, password: str) -> None:
        self.url = url.rstrip("/")
        self.database = database
        self.auth = (user, password)

    async def command(self, language: str, command: str) -> list[dict[str, Any]]:
        httpx = import_module("httpx")
        async with httpx.AsyncClient(timeout=30) as client:
            response = await client.post(
                f"{self.url}/api/v1/command/{self.database}",
                auth=self.auth,
                json={"language": language, "command": command},
            )
            response.raise_for_status()
            data = response.json()
        if not isinstance(data, dict):
            return []
        result = data.get("result", [])
        return [item for item in result if isinstance(item, dict)] if isinstance(result, list) else []


class ArcadeDBGraphWriter:
    def __init__(
        self,
        client: ArcadeCommandClient,
        *,
        config: WriterConfig | None = None,
        embedding_model: EvidenceEmbeddingModel | None = None,
    ) -> None:
        self.client = client
        self.config = config or WriterConfig()
        self.embedding_model = embedding_model or LocalEvidenceEmbeddingModel(
            self.config.evidence_embedding_dimensions
        )

    async def ensure_schema(self) -> None:
        await self.client.command("sqlscript", "\n".join(build_schema_bootstrap_commands(self.config)))

    async def write_batch(self, batch: GraphWriteBatch) -> None:
        script = build_graph_write_script(batch, self.embedding_model)
        await self.client.command("sqlscript", script)


class DatabaseWriterService:
    def __init__(
        self,
        config: WriterConfig,
        *,
        event_bus_config: EventBusConfig | None = None,
        consumer: GraphWriteConsumer | None = None,
        event_notification_producer: EventNotificationProducer | None = None,
        graph_writer: ArcadeDBGraphWriter | None = None,
    ) -> None:
        self.config = config
        self.event_bus_config = event_bus_config or EventBusConfig(client_id="osint-db-writer")
        self.consumer = consumer
        self.event_notification_producer = event_notification_producer
        self.graph_writer = graph_writer or ArcadeDBGraphWriter(
            ArcadeDBAsyncClient(
                config.arcadedb_url,
                config.arcadedb_database,
                config.arcadedb_user,
                config.arcadedb_password,
            ),
            config=config,
        )

    async def start(self) -> None:
        await self.graph_writer.ensure_schema()
        if self.consumer is None:
            self.consumer = AsyncSchemaConsumer(
                self.event_bus_config,
                GraphWriteBatch,
                [self.config.graph_write_topic],
                self.config.group_id,
            )
        await self.consumer.start()
        if self.event_notification_producer is None:
            self.event_notification_producer = AsyncSchemaProducer(
                self.event_bus_config,
                EventEntityNotification,
            )
        await self.event_notification_producer.start()

    async def stop(self) -> None:
        if self.consumer is not None:
            await self.consumer.stop()
        if self.event_notification_producer is not None:
            await self.event_notification_producer.stop()

    async def run(self, *, max_records: int | None = None) -> None:
        await self.start()
        assert self.consumer is not None
        processed = 0
        try:
            async for record in self.consumer.records():
                batch = extract_batch(record)
                await self.graph_writer.write_batch(batch)
                await self.publish_high_confidence_events(batch)
                processed += 1
                if max_records is not None and processed >= max_records:
                    break
        finally:
            await self.stop()

    async def publish_high_confidence_events(self, batch: GraphWriteBatch) -> None:
        assert self.event_notification_producer is not None
        for notification in high_confidence_event_notifications(batch):
            await self.event_notification_producer.send(
                self.config.event_notification_topic,
                notification,
                key=str(notification.entity.id),
            )


def extract_batch(record: Any) -> GraphWriteBatch:
    if isinstance(record, ConsumedRecord):
        return record.value
    value = getattr(record, "value", record)
    if isinstance(value, GraphWriteBatch):
        return value
    return GraphWriteBatch.model_validate(value)


def build_schema_bootstrap_commands(config: WriterConfig) -> list[str]:
    dimensions = int(config.evidence_embedding_dimensions)
    return [
        f"CREATE VERTEX TYPE {ENTITY_VERTEX_TYPE} IF NOT EXISTS;",
        f"CREATE PROPERTY {ENTITY_VERTEX_TYPE}.id STRING;",
        f"CREATE PROPERTY {ENTITY_VERTEX_TYPE}.entity_type STRING;",
        f"CREATE PROPERTY {ENTITY_VERTEX_TYPE}.confidence DOUBLE;",
        f"CREATE PROPERTY {ENTITY_VERTEX_TYPE}.source_count INTEGER;",
        f"CREATE PROPERTY {ENTITY_VERTEX_TYPE}.last_updated DATETIME;",
        f"CREATE PROPERTY {ENTITY_VERTEX_TYPE}.canonical_name STRING;",
        f"CREATE INDEX IF NOT EXISTS ON {ENTITY_VERTEX_TYPE} (id) UNIQUE;",
        f"CREATE EDGE TYPE {RELATIONSHIP_EDGE_TYPE} IF NOT EXISTS;",
        f"CREATE PROPERTY {RELATIONSHIP_EDGE_TYPE}.relationship_uid STRING;",
        f"CREATE PROPERTY {RELATIONSHIP_EDGE_TYPE}.source_entity_id STRING;",
        f"CREATE PROPERTY {RELATIONSHIP_EDGE_TYPE}.destination_entity_id STRING;",
        f"CREATE PROPERTY {RELATIONSHIP_EDGE_TYPE}.confidence DOUBLE;",
        f"CREATE PROPERTY {RELATIONSHIP_EDGE_TYPE}.valid_from DATETIME;",
        f"CREATE PROPERTY {RELATIONSHIP_EDGE_TYPE}.evidence_text STRING;",
        f"CREATE PROPERTY {RELATIONSHIP_EDGE_TYPE}.{EVIDENCE_EMBEDDING_PROPERTY} ARRAY_OF_FLOATS;",
        f"CREATE PROPERTY {RELATIONSHIP_EDGE_TYPE}.source_batch_id STRING;",
        f"CREATE PROPERTY {RELATIONSHIP_EDGE_TYPE}.written_at DATETIME;",
        f"CREATE INDEX IF NOT EXISTS ON {RELATIONSHIP_EDGE_TYPE} (relationship_uid) UNIQUE;",
        (
            f"CREATE INDEX IF NOT EXISTS ON {RELATIONSHIP_EDGE_TYPE} ({EVIDENCE_EMBEDDING_PROPERTY}) "
            f"LSM_VECTOR METADATA {{dimensions: {dimensions}, similarity: {sql_quote(config.vector_similarity)}, "
            f"maxConnections: {int(config.vector_max_connections)}, beamWidth: {int(config.vector_beam_width)}, "
            "buildGraphNow: true}};"
        ),
    ]


def high_confidence_event_notifications(batch: GraphWriteBatch) -> list[EventEntityNotification]:
    persisted_at = datetime.now(UTC)
    return [
        EventEntityNotification(
            id=uuid4(),
            entity=entity_upsert.entity,
            canonical_name=entity_upsert.canonical_name,
            persisted_at=persisted_at,
            source_batch_id=batch.id,
        )
        for entity_upsert in batch.entities
        if entity_upsert.entity.entity_type == "EVENT" and entity_upsert.entity.confidence > 0.85
    ]


def build_graph_write_script(
    batch: GraphWriteBatch,
    embedding_model: EvidenceEmbeddingModel,
) -> str:
    commands = ["begin;"]
    commands.extend(build_entity_upsert_command(entity_upsert) for entity_upsert in batch.entities)
    relationship_embeddings = embed_relationship_evidence(batch.relationships, embedding_model)
    commands.extend(
        build_relationship_edge_command(batch, relationship_upsert, relationship_embeddings[index])
        for index, relationship_upsert in enumerate(batch.relationships)
    )
    commands.append("commit;")
    return "\n".join(commands)


def build_entity_upsert_command(entity_upsert: Any) -> str:
    entity = entity_upsert.entity
    return (
        f"UPDATE {ENTITY_VERTEX_TYPE} SET "
        f"id = {sql_quote(str(entity.id))}, "
        f"entity_type = {sql_quote(entity.entity_type)}, "
        f"confidence = {format_float(entity.confidence)}, "
        f"source_count = {int(entity.source_count)}, "
        f"last_updated = {sql_quote(entity.last_updated.isoformat())}, "
        f"canonical_name = {sql_quote(entity_upsert.canonical_name)} "
        f"UPSERT WHERE id = {sql_quote(str(entity.id))};"
    )


def build_relationship_edge_command(
    batch: GraphWriteBatch,
    relationship_upsert: GraphRelationshipUpsert,
    evidence_embedding: np.ndarray,
) -> str:
    relationship = relationship_upsert.relationship
    relationship_uid = immutable_relationship_uid(relationship_upsert)
    written_at = datetime.now(UTC).isoformat()
    return (
        f"CREATE EDGE {RELATIONSHIP_EDGE_TYPE} IF NOT EXISTS "
        f"FROM (SELECT FROM {ENTITY_VERTEX_TYPE} WHERE id = {sql_quote(str(relationship_upsert.source_entity_id))}) "
        f"TO (SELECT FROM {ENTITY_VERTEX_TYPE} WHERE id = {sql_quote(str(relationship_upsert.destination_entity_id))}) "
        "SET "
        f"relationship_uid = {sql_quote(relationship_uid)}, "
        f"source_entity_id = {sql_quote(str(relationship_upsert.source_entity_id))}, "
        f"destination_entity_id = {sql_quote(str(relationship_upsert.destination_entity_id))}, "
        f"confidence = {format_float(relationship.confidence)}, "
        f"valid_from = {sql_quote(relationship.valid_from.isoformat())}, "
        f"evidence_text = {sql_quote(relationship.evidence_text)}, "
        f"{EVIDENCE_EMBEDDING_PROPERTY} = {json_vector(evidence_embedding)}, "
        f"source_batch_id = {sql_quote(str(batch.id))}, "
        f"written_at = {sql_quote(written_at)};"
    )


def embed_relationship_evidence(
    relationships: Sequence[GraphRelationshipUpsert],
    embedding_model: EvidenceEmbeddingModel,
) -> np.ndarray:
    if not relationships:
        return np.zeros((0, 0), dtype=np.float32)
    evidence_texts = [relationship.relationship.evidence_text for relationship in relationships]
    return normalize_matrix(embedding_model.embed(evidence_texts))


def immutable_relationship_uid(relationship_upsert: GraphRelationshipUpsert) -> str:
    relationship = relationship_upsert.relationship
    fingerprint = hashlib.sha256(
        "|".join(
            (
                str(relationship_upsert.source_entity_id),
                str(relationship_upsert.destination_entity_id),
                relationship.valid_from.isoformat(),
                relationship.evidence_text,
            )
        ).encode("utf-8")
    ).hexdigest()[:32]
    return f"rel:{fingerprint}"


def normalize_embedding_text(value: str) -> str:
    ascii_value = unicodedata.normalize("NFKD", value).encode("ascii", "ignore").decode("ascii")
    return " ".join(ascii_value.lower().split())


def normalize_matrix(matrix: np.ndarray) -> np.ndarray:
    array = np.asarray(matrix, dtype=np.float32)
    if array.ndim == 1:
        array = array.reshape(1, -1)
    if array.size == 0:
        return array
    norms = np.linalg.norm(array, axis=1, keepdims=True)
    return np.divide(array, np.maximum(norms, 1e-12), out=np.zeros_like(array), where=norms > 0)


def sql_quote(value: str) -> str:
    return "'" + value.replace("'", "''") + "'"


def format_float(value: float) -> str:
    if not math.isfinite(value):
        raise ValueError("non-finite float cannot be written to ArcadeDB")
    return format(value, ".8g")


def json_vector(vector: np.ndarray) -> str:
    return "[" + ",".join(format_vector_float(float(value)) for value in vector.astype(np.float32)) + "]"


def format_vector_float(value: float) -> str:
    return f"{value:.6f}".rstrip("0").rstrip(".") if value else "0.0"


async def run_service(config: WriterConfig) -> None:
    service = DatabaseWriterService(
        config,
        event_bus_config=EventBusConfig(
            bootstrap_servers=cast(str, import_module("os").getenv("REDPANDA_BROKERS", "localhost:19092")),
            client_id="osint-db-writer",
        ),
    )
    await service.run()


def _env_int(name: str, default: int) -> int:
    os = import_module("os")
    return int(os.getenv(name, str(default)))


def config_from_env() -> WriterConfig:
    os = import_module("os")
    return WriterConfig(
        graph_write_topic=os.getenv("GRAPH_WRITE_TOPIC", DEFAULT_GRAPH_WRITE_TOPIC),
        event_notification_topic=os.getenv("EVENT_NOTIFICATION_TOPIC", DEFAULT_EVENT_NOTIFICATION_TOPIC),
        group_id=os.getenv("DB_WRITER_GROUP_ID", DEFAULT_WRITER_GROUP_ID),
        arcadedb_url=os.getenv("ARCADEDB_URL", "http://localhost:2480"),
        arcadedb_database=os.getenv("ARCADEDB_DATABASE", "osint"),
        arcadedb_user=os.getenv("ARCADEDB_USER", "root"),
        arcadedb_password=os.getenv("ARCADEDB_PASSWORD", "change-me-local-only"),
        evidence_embedding_dimensions=_env_int("EVIDENCE_EMBEDDING_DIMENSIONS", 192),
        vector_max_connections=_env_int("EVIDENCE_VECTOR_MAX_CONNECTIONS", 16),
        vector_beam_width=_env_int("EVIDENCE_VECTOR_BEAM_WIDTH", 100),
    )


def main() -> None:
    asyncio.run(run_service(config_from_env()))
