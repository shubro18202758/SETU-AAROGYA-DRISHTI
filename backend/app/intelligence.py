from __future__ import annotations

import asyncio
import hashlib
import unicodedata
from collections.abc import AsyncIterator, Sequence
from dataclasses import dataclass
from datetime import datetime
from importlib import import_module
from typing import Any, Protocol, cast

import logging

import httpx
import numpy as np
from fastapi import APIRouter, Query, WebSocket, WebSocketDisconnect
from pydantic import BaseModel, ConfigDict, Field

logger = logging.getLogger(__name__)

from .bus import AsyncSchemaConsumer, EventBusConfig
from .schemas import EventEntityNotification
from .storage import ArcadeDBClient

GRAPH_RAG_TOP_K = 5
GRAPH_RAG_TRAVERSAL_HOPS = 3
DEFAULT_EVENT_NOTIFICATION_TOPIC = "osint.events.high_confidence"
DEFAULT_GEO_GRAPH_LIMIT = 5000
MAX_GEO_GRAPH_LIMIT = 20000


class TextEmbeddingModel(Protocol):
    def embed(self, texts: Sequence[str]) -> np.ndarray: ...


class GraphRAGRepository(Protocol):
    async def connected_subgraph(self, query_embedding: Sequence[float]) -> dict[str, Any]: ...

    async def geo_graph(self, limit: int) -> dict[str, Any]: ...


class NotificationConsumer(Protocol):
    async def start(self) -> None: ...

    async def stop(self) -> None: ...

    def records(self) -> AsyncIterator[Any]: ...


class GraphRAGRequest(BaseModel):
    query: str = Field(min_length=1, max_length=4096)


class GraphNode(BaseModel):
    model_config = ConfigDict(extra="allow")

    id: str
    entity_type: str | None = None
    confidence: float | None = None
    source_count: int | None = None
    last_updated: str | None = None
    canonical_name: str | None = None


class GraphEdge(BaseModel):
    model_config = ConfigDict(extra="allow")

    id: str
    source_entity_id: str | None = None
    destination_entity_id: str | None = None
    confidence: float | None = None
    valid_from: str | None = None
    evidence_text: str | None = None


class GraphRAGResponse(BaseModel):
    query: str
    vector_top_k: int
    traversal_hops: int
    seed_relationships: list[GraphEdge]
    entities: list[GraphNode]
    relationships: list[GraphEdge]


class GeoLocation(BaseModel):
    model_config = ConfigDict(extra="allow")

    id: str
    canonical_name: str | None = None
    confidence: float | None = None
    source_count: int | None = None
    last_updated: str | None = None
    latitude: float | None = None
    longitude: float | None = None


class GeoConnectedEntity(BaseModel):
    model_config = ConfigDict(extra="allow")

    id: str
    entity_type: str
    canonical_name: str | None = None
    confidence: float | None = None
    last_updated: str | None = None


class GeoRelationship(BaseModel):
    model_config = ConfigDict(extra="allow")

    id: str
    source_entity_id: str | None = None
    destination_entity_id: str | None = None
    confidence: float | None = None
    valid_from: str | None = None
    evidence_text: str | None = None


class GeoGraphResponse(BaseModel):
    generated_at: str
    limit: int
    locations: list[GeoLocation]
    connected_entities: list[GeoConnectedEntity]
    relationships: list[GeoRelationship]


class LocalQueryEmbeddingModel:
    def __init__(self, dimensions: int = 192) -> None:
        self.dimensions = dimensions

    def embed(self, texts: Sequence[str]) -> np.ndarray:
        matrix = np.zeros((len(texts), self.dimensions), dtype=np.float32)
        for row_index, text in enumerate(texts):
            normalized = normalize_query_text(text)
            tokens = normalized.split()
            features = tokens + [normalized[index : index + 4] for index in range(max(len(normalized) - 3, 0))]
            for feature in features:
                digest = hashlib.blake2b(feature.encode("utf-8"), digest_size=8).digest()
                bucket = int.from_bytes(digest[:4], "little") % self.dimensions
                sign = 1.0 if digest[4] & 1 else -1.0
                matrix[row_index, bucket] += sign
        return normalize_matrix(matrix)


@dataclass(frozen=True, slots=True)
class ArcadeDBGraphRAGRepository:
    client: ArcadeDBClient

    async def connected_subgraph(self, query_embedding: Sequence[float]) -> dict[str, Any]:
        query = build_graphrag_sqlscript(query_embedding)
        records = await self.client.command("sqlscript", query)
        return parse_graphrag_records(records)

    async def geo_graph(self, limit: int) -> dict[str, Any]:
        query = build_geo_graph_sqlscript(limit)
        records = await self.client.command("sqlscript", query)
        return parse_geo_graph_records(records)


class WebSocketConnectionManager:
    def __init__(self) -> None:
        self._connections: set[WebSocket] = set()
        self._lock = asyncio.Lock()

    async def connect(self, websocket: WebSocket) -> None:
        await websocket.accept()
        async with self._lock:
            self._connections.add(websocket)

    async def disconnect(self, websocket: WebSocket) -> None:
        async with self._lock:
            self._connections.discard(websocket)

    async def broadcast(self, notification: EventEntityNotification) -> None:
        payload = notification.model_dump(mode="json")
        async with self._lock:
            connections = tuple(self._connections)
        stale_connections: list[WebSocket] = []
        for websocket in connections:
            try:
                await websocket.send_json(payload)
            except RuntimeError:
                stale_connections.append(websocket)
        for websocket in stale_connections:
            await self.disconnect(websocket)


class EventNotificationHub:
    def __init__(
        self,
        manager: WebSocketConnectionManager,
        *,
        consumer: NotificationConsumer | None = None,
    ) -> None:
        self.manager = manager
        self.consumer = consumer
        self._task: asyncio.Task[None] | None = None

    async def start(self, consumer_factory: Any | None = None) -> None:
        if self.consumer is None and consumer_factory is not None:
            self.consumer = consumer_factory()
        if self.consumer is None or self._task is not None:
            return
        await self.consumer.start()
        self._task = asyncio.create_task(self._consume(), name="event-notification-hub")

    async def stop(self) -> None:
        if self._task is not None:
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass
            self._task = None
        if self.consumer is not None:
            await self.consumer.stop()

    async def publish(self, notification: EventEntityNotification) -> None:
        if is_high_confidence_event(notification):
            await self.manager.broadcast(notification)

    async def _consume(self) -> None:
        assert self.consumer is not None
        async for record in self.consumer.records():
            value = getattr(record, "value", record)
            if isinstance(value, EventEntityNotification):
                await self.publish(value)
            else:
                await self.publish(EventEntityNotification.model_validate(value))


class IntelligenceService:
    def __init__(self, repository: GraphRAGRepository, embedding_model: TextEmbeddingModel) -> None:
        self.repository = repository
        self.embedding_model = embedding_model

    async def graphrag(self, query: str) -> GraphRAGResponse:
        embedding = self.embedding_model.embed([query])[0].astype(float).tolist()
        try:
            subgraph = await self.repository.connected_subgraph(embedding)
        except (httpx.HTTPError, OSError) as exc:
            logger.warning("graphrag storage unavailable, returning empty subgraph: %s", exc)
            subgraph = {"seed_relationships": [], "entities": [], "relationships": []}
        return GraphRAGResponse(
            query=query,
            vector_top_k=GRAPH_RAG_TOP_K,
            traversal_hops=GRAPH_RAG_TRAVERSAL_HOPS,
            seed_relationships=[to_graph_edge(edge) for edge in subgraph.get("seed_relationships", [])],
            entities=[to_graph_node(entity) for entity in subgraph.get("entities", [])],
            relationships=[to_graph_edge(edge) for edge in subgraph.get("relationships", [])],
        )

    async def geo_graph(self, limit: int = DEFAULT_GEO_GRAPH_LIMIT) -> GeoGraphResponse:
        normalized_limit = min(max(limit, 1), MAX_GEO_GRAPH_LIMIT)
        try:
            graph = await self.repository.geo_graph(normalized_limit)
        except (httpx.HTTPError, OSError) as exc:
            logger.warning("geo_graph storage unavailable, returning empty graph: %s", exc)
            graph = {"locations": [], "connected_entities": [], "relationships": []}
        return GeoGraphResponse(
            generated_at=utc_now_iso(),
            limit=normalized_limit,
            locations=[to_geo_location(location) for location in graph.get("locations", [])],
            connected_entities=[to_geo_connected_entity(entity) for entity in graph.get("connected_entities", [])],
            relationships=[to_geo_relationship(relationship) for relationship in graph.get("relationships", [])],
        )


def create_intelligence_router(service: IntelligenceService, hub: EventNotificationHub) -> APIRouter:
    router = APIRouter(prefix="/intelligence", tags=["intelligence"])

    @router.post("/graphrag", response_model=GraphRAGResponse)
    async def graphrag(request: GraphRAGRequest) -> GraphRAGResponse:
        return await service.graphrag(request.query)

    @router.get("/geo", response_model=GeoGraphResponse)
    async def geo(limit: int = Query(default=DEFAULT_GEO_GRAPH_LIMIT, ge=1, le=MAX_GEO_GRAPH_LIMIT)) -> GeoGraphResponse:
        return await service.geo_graph(limit)

    @router.websocket("/events")
    async def event_stream(websocket: WebSocket) -> None:
        await hub.manager.connect(websocket)
        try:
            while True:
                await websocket.receive_text()
        except WebSocketDisconnect:
            await hub.manager.disconnect(websocket)

    return router


def make_event_notification_consumer(
    *,
    bootstrap_servers: str,
    topic: str = DEFAULT_EVENT_NOTIFICATION_TOPIC,
    group_id: str = "osint-intelligence-api-events",
) -> AsyncSchemaConsumer[EventEntityNotification]:
    return AsyncSchemaConsumer(
        EventBusConfig(bootstrap_servers=bootstrap_servers, client_id="osint-intelligence-api"),
        EventEntityNotification,
        [topic],
        group_id,
    )


def build_graphrag_sqlscript(query_embedding: Sequence[float]) -> str:
    vector = json_vector(query_embedding)
    return "\n".join(
        [
            f"LET $seedEdges = (SELECT expand(vectorNeighbors('SemanticRelationship[evidence_embedding]', {vector}, {GRAPH_RAG_TOP_K}));",
            "LET $seedVertices = (SELECT expand(unionall($seedEdges.outV(), $seedEdges.inV())));",
            (
                "LET $entities = (SELECT FROM (TRAVERSE both('SemanticRelationship') FROM $seedVertices "
                f"MAXDEPTH {GRAPH_RAG_TRAVERSAL_HOPS} STRATEGY BREADTH_FIRST) WHERE @class = 'Entity');"
            ),
            (
                "LET $relationships = (SELECT FROM SemanticRelationship "
                "WHERE outV() IN $entities AND inV() IN $entities);"
            ),
            "RETURN {seed_relationships: $seedEdges, entities: $entities, relationships: $relationships};",
        ]
    )


def build_geo_graph_sqlscript(limit: int) -> str:
    normalized_limit = min(max(int(limit), 1), MAX_GEO_GRAPH_LIMIT)
    relationship_limit = min(normalized_limit * 6, MAX_GEO_GRAPH_LIMIT * 6)
    return "\n".join(
        [
            f"LET $locations = (SELECT FROM Entity WHERE entity_type = 'GEO' ORDER BY last_updated DESC LIMIT {normalized_limit});",
            "LET $geoIds = $locations.id;",
            (
                "LET $relationships = (SELECT FROM SemanticRelationship "
                "WHERE source_entity_id IN $geoIds OR destination_entity_id IN $geoIds "
                f"LIMIT {relationship_limit});"
            ),
            "LET $entityIds = unionall($relationships.source_entity_id, $relationships.destination_entity_id);",
            "LET $connected = (SELECT FROM Entity WHERE id IN $entityIds AND entity_type IN ['ORG', 'PERSON']);",
            "RETURN {locations: $locations, connected_entities: $connected, relationships: $relationships};",
        ]
    )


def parse_graphrag_records(records: Sequence[dict[str, Any]]) -> dict[str, Any]:
    for record in records:
        candidate = record.get("value", record.get("result", record))
        if isinstance(candidate, dict) and {"entities", "relationships"}.issubset(candidate):
            return {
                "seed_relationships": list(candidate.get("seed_relationships", [])),
                "entities": list(candidate.get("entities", [])),
                "relationships": list(candidate.get("relationships", [])),
            }
    entities: list[dict[str, Any]] = []
    relationships: list[dict[str, Any]] = []
    for record in records:
        if record.get("@class") == "Entity":
            entities.append(record)
        if record.get("@class") == "SemanticRelationship":
            relationships.append(record)
    return {"seed_relationships": relationships[:GRAPH_RAG_TOP_K], "entities": entities, "relationships": relationships}


def parse_geo_graph_records(records: Sequence[dict[str, Any]]) -> dict[str, Any]:
    for record in records:
        candidate = record.get("value", record.get("result", record))
        if isinstance(candidate, dict) and {"locations", "relationships"}.issubset(candidate):
            return {
                "locations": list(candidate.get("locations", [])),
                "connected_entities": list(candidate.get("connected_entities", [])),
                "relationships": list(candidate.get("relationships", [])),
            }
    locations: list[dict[str, Any]] = []
    connected_entities: list[dict[str, Any]] = []
    relationships: list[dict[str, Any]] = []
    for record in records:
        if record.get("@class") == "Entity" and record.get("entity_type") == "GEO":
            locations.append(record)
        elif record.get("@class") == "Entity" and record.get("entity_type") in {"ORG", "PERSON"}:
            connected_entities.append(record)
        elif record.get("@class") == "SemanticRelationship":
            relationships.append(record)
    return {"locations": locations, "connected_entities": connected_entities, "relationships": relationships}


def to_graph_node(record: Any) -> GraphNode:
    data = normalize_record(record)
    return GraphNode(
        id=str(data.get("id", data.get("@rid", ""))),
        entity_type=optional_str(data.get("entity_type")),
        confidence=optional_float(data.get("confidence")),
        source_count=optional_int(data.get("source_count")),
        last_updated=optional_str(data.get("last_updated")),
        canonical_name=optional_str(data.get("canonical_name")),
        **extra_record_fields(data, {"id", "entity_type", "confidence", "source_count", "last_updated", "canonical_name"}),
    )


def to_graph_edge(record: Any) -> GraphEdge:
    data = normalize_record(record)
    return GraphEdge(
        id=str(data.get("relationship_uid", data.get("id", data.get("@rid", "")))),
        source_entity_id=optional_str(data.get("source_entity_id")),
        destination_entity_id=optional_str(data.get("destination_entity_id")),
        confidence=optional_float(data.get("confidence")),
        valid_from=optional_str(data.get("valid_from")),
        evidence_text=optional_str(data.get("evidence_text")),
        **extra_record_fields(
            data,
            {"relationship_uid", "id", "source_entity_id", "destination_entity_id", "confidence", "valid_from", "evidence_text"},
        ),
    )


def to_geo_location(record: Any) -> GeoLocation:
    data = normalize_record(record)
    latitude = optional_float(data.get("latitude", data.get("lat")))
    longitude = optional_float(data.get("longitude", data.get("lon", data.get("lng"))))
    return GeoLocation(
        id=str(data.get("id", data.get("@rid", ""))),
        canonical_name=optional_str(data.get("canonical_name")),
        confidence=optional_float(data.get("confidence")),
        source_count=optional_int(data.get("source_count")),
        last_updated=optional_str(data.get("last_updated")),
        latitude=latitude,
        longitude=longitude,
        **extra_record_fields(
            data,
            {"id", "entity_type", "confidence", "source_count", "last_updated", "canonical_name", "latitude", "longitude", "lat", "lon", "lng"},
        ),
    )


def to_geo_connected_entity(record: Any) -> GeoConnectedEntity:
    data = normalize_record(record)
    return GeoConnectedEntity(
        id=str(data.get("id", data.get("@rid", ""))),
        entity_type=str(data.get("entity_type", "")),
        canonical_name=optional_str(data.get("canonical_name")),
        confidence=optional_float(data.get("confidence")),
        last_updated=optional_str(data.get("last_updated")),
        **extra_record_fields(data, {"id", "entity_type", "confidence", "last_updated", "canonical_name"}),
    )


def to_geo_relationship(record: Any) -> GeoRelationship:
    data = normalize_record(record)
    return GeoRelationship(
        id=str(data.get("relationship_uid", data.get("id", data.get("@rid", "")))),
        source_entity_id=optional_str(data.get("source_entity_id")),
        destination_entity_id=optional_str(data.get("destination_entity_id")),
        confidence=optional_float(data.get("confidence")),
        valid_from=optional_str(data.get("valid_from")),
        evidence_text=optional_str(data.get("evidence_text")),
        **extra_record_fields(
            data,
            {"relationship_uid", "id", "source_entity_id", "destination_entity_id", "confidence", "valid_from", "evidence_text"},
        ),
    )


def normalize_record(record: Any) -> dict[str, Any]:
    if isinstance(record, dict):
        return record
    if hasattr(record, "model_dump"):
        return cast(dict[str, Any], record.model_dump(mode="json"))
    return {}


def extra_record_fields(data: dict[str, Any], excluded: set[str]) -> dict[str, Any]:
    return {key: value for key, value in data.items() if key not in excluded and not key.startswith("@")}


def is_high_confidence_event(notification: EventEntityNotification) -> bool:
    return notification.entity.entity_type == "EVENT" and notification.entity.confidence > 0.85


def normalize_query_text(value: str) -> str:
    ascii_value = unicodedata.normalize("NFKD", value).encode("ascii", "ignore").decode("ascii")
    return " ".join(ascii_value.lower().split())


def normalize_matrix(matrix: np.ndarray) -> np.ndarray:
    array = np.asarray(matrix, dtype=np.float32)
    if array.ndim == 1:
        array = array.reshape(1, -1)
    norms = np.linalg.norm(array, axis=1, keepdims=True)
    return np.divide(array, np.maximum(norms, 1e-12), out=np.zeros_like(array), where=norms > 0)


def json_vector(vector: Sequence[float]) -> str:
    return "[" + ",".join(format_vector_float(float(value)) for value in vector) + "]"


def format_vector_float(value: float) -> str:
    return f"{value:.6f}".rstrip("0").rstrip(".") if value else "0.0"


def optional_str(value: Any) -> str | None:
    return None if value is None else str(value)


def optional_float(value: Any) -> float | None:
    return None if value is None else float(value)


def optional_int(value: Any) -> int | None:
    return None if value is None else int(value)


def utc_now_iso() -> str:
    return datetime.now().isoformat()
