from __future__ import annotations

import hashlib
import math
import re
import unicodedata
from collections.abc import Sequence
from dataclasses import dataclass
from datetime import datetime
from importlib import import_module
from typing import Any, Literal, Protocol, cast
from uuid import UUID

import numpy as np

from backend.app.schemas import Entity

ResolutionAction = Literal["merge", "create"]

TOKEN_PATTERN = re.compile(r"[a-z0-9]+")
LEGAL_TOKEN_EXPANSIONS = {
    "co": "company",
    "corp": "corporation",
    "inc": "incorporated",
    "intl": "international",
    "ltd": "limited",
}


class EmbeddingModel(Protocol):
    def embed(self, texts: Sequence[str]) -> np.ndarray: ...


class EntityResolutionStore(Protocol):
    async def fetch_existing_entities(
        self,
        *,
        entity_types: Sequence[str],
        limit: int,
    ) -> Sequence["StoredEntityRecord"]: ...

    async def merge_entity(self, decision: "ResolutionDecision") -> None: ...

    async def flag_new_entity(self, decision: "ResolutionDecision") -> None: ...


@dataclass(frozen=True, slots=True)
class ResolvableEntity:
    entity: Entity
    surface_text: str
    embedding_text: str | None = None

    @property
    def comparison_text(self) -> str:
        return self.embedding_text or self.surface_text


@dataclass(frozen=True, slots=True)
class StoredEntityRecord:
    entity: Entity
    canonical_name: str
    embedding: tuple[float, ...] | None = None

    @property
    def comparison_text(self) -> str:
        return self.canonical_name


@dataclass(frozen=True, slots=True)
class ResolutionDecision:
    action: ResolutionAction
    new_entity: ResolvableEntity
    matched_existing: StoredEntityRecord | None
    lexical_distance: float
    semantic_distance: float
    merged_entity: Entity | None = None

    @property
    def should_create_node(self) -> bool:
        return self.action == "create"


@dataclass(frozen=True, slots=True)
class EntityResolutionConfig:
    candidate_batch_size: int = 4096
    semantic_merge_distance_threshold: float = 0.08
    lexical_candidate_distance_threshold: float = 0.42
    lexical_tie_breaker_weight: float = 0.15
    embedding_dimensions: int = 192


class LocalHashEmbeddingModel:
    def __init__(self, dimensions: int = 192, ngram_range: tuple[int, int] = (3, 5)) -> None:
        self.dimensions = dimensions
        self.ngram_range = ngram_range

    def embed(self, texts: Sequence[str]) -> np.ndarray:
        matrix = np.zeros((len(texts), self.dimensions), dtype=np.float32)
        for row_index, text in enumerate(texts):
            normalized = f" {normalize_entity_text(text)} "
            if not normalized.strip():
                continue
            for ngram_size in range(self.ngram_range[0], self.ngram_range[1] + 1):
                if len(normalized) < ngram_size:
                    continue
                for start in range(0, len(normalized) - ngram_size + 1):
                    ngram = normalized[start : start + ngram_size]
                    digest = hashlib.blake2b(ngram.encode("utf-8"), digest_size=8).digest()
                    bucket = int.from_bytes(digest[:4], "little") % self.dimensions
                    sign = 1.0 if digest[4] & 1 else -1.0
                    matrix[row_index, bucket] += sign
        return normalize_embedding_matrix(matrix)


class FastEmbedTextEmbeddingModel:
    def __init__(self, model_name: str = "BAAI/bge-small-en-v1.5") -> None:
        fastembed = import_module("fastembed")
        self.model = fastembed.TextEmbedding(model_name=model_name)

    def embed(self, texts: Sequence[str]) -> np.ndarray:
        matrix = np.asarray(list(self.model.embed(list(texts))), dtype=np.float32)
        return normalize_embedding_matrix(matrix)


class EntityResolver:
    def __init__(
        self,
        store: EntityResolutionStore,
        *,
        config: EntityResolutionConfig | None = None,
        embedding_model: EmbeddingModel | None = None,
    ) -> None:
        self.store = store
        self.config = config or EntityResolutionConfig()
        self.embedding_model = embedding_model or LocalHashEmbeddingModel(
            dimensions=self.config.embedding_dimensions
        )

    async def resolve_batch(self, new_entities: Sequence[ResolvableEntity]) -> list[ResolutionDecision]:
        entity_types = sorted({entity.entity.entity_type for entity in new_entities})
        existing_entities = list(
            await self.store.fetch_existing_entities(
                entity_types=entity_types,
                limit=self.config.candidate_batch_size,
            )
        )
        decisions: list[ResolutionDecision] = []
        for new_entity in new_entities:
            decision = self.resolve_one(new_entity, existing_entities)
            decisions.append(decision)
            if decision.action == "merge" and decision.matched_existing is not None and decision.merged_entity is not None:
                existing_entities = replace_existing_record(
                    existing_entities,
                    decision.matched_existing,
                    StoredEntityRecord(
                        entity=decision.merged_entity,
                        canonical_name=decision.matched_existing.canonical_name,
                        embedding=decision.matched_existing.embedding,
                    ),
                )
            if decision.action == "create":
                existing_entities.append(
                    StoredEntityRecord(
                        entity=new_entity.entity,
                        canonical_name=new_entity.surface_text,
                        embedding=tuple(
                            self.embedding_model.embed([new_entity.comparison_text])[0].astype(float).tolist()
                        ),
                    )
                )
        return decisions

    async def resolve_and_apply(self, new_entities: Sequence[ResolvableEntity]) -> list[ResolutionDecision]:
        decisions = await self.resolve_batch(new_entities)
        for decision in decisions:
            if decision.action == "merge":
                await self.store.merge_entity(decision)
            else:
                await self.store.flag_new_entity(decision)
        return decisions

    def resolve_one(
        self,
        new_entity: ResolvableEntity,
        existing_entities: Sequence[StoredEntityRecord],
    ) -> ResolutionDecision:
        typed_candidates = [
            candidate
            for candidate in existing_entities
            if candidate.entity.entity_type == new_entity.entity.entity_type
        ]
        if not typed_candidates:
            return create_decision(new_entity)

        new_text = normalize_entity_text(new_entity.comparison_text)
        candidate_texts = [normalize_entity_text(candidate.comparison_text) for candidate in typed_candidates]
        lexical_distances = pairwise_levenshtein_distances(new_text, candidate_texts)
        semantic_distances = pairwise_semantic_distances(
            self.embedding_model,
            new_entity.comparison_text,
            typed_candidates,
        )
        combined_distances = semantic_distances + (
            lexical_distances * self.config.lexical_tie_breaker_weight
        )
        best_index = int(np.argmin(combined_distances))
        best_candidate = typed_candidates[best_index]
        best_lexical_distance = float(lexical_distances[best_index])
        best_semantic_distance = float(semantic_distances[best_index])

        if (
            best_semantic_distance <= self.config.semantic_merge_distance_threshold
            or best_lexical_distance <= self.config.lexical_candidate_distance_threshold
            and best_semantic_distance <= self.config.semantic_merge_distance_threshold * 2.5
        ):
            merged_entity = merge_entity_payload(best_candidate.entity, new_entity.entity)
            return ResolutionDecision(
                action="merge",
                new_entity=new_entity,
                matched_existing=best_candidate,
                lexical_distance=best_lexical_distance,
                semantic_distance=best_semantic_distance,
                merged_entity=merged_entity,
            )

        return ResolutionDecision(
            action="create",
            new_entity=new_entity,
            matched_existing=best_candidate,
            lexical_distance=best_lexical_distance,
            semantic_distance=best_semantic_distance,
        )


class ArcadeDBEntityResolutionStore:
    def __init__(self, url: str, database: str, user: str, password: str) -> None:
        self.url = url.rstrip("/")
        self.database = database
        self.auth = (user, password)

    async def fetch_existing_entities(
        self,
        *,
        entity_types: Sequence[str],
        limit: int,
    ) -> Sequence[StoredEntityRecord]:
        if not entity_types:
            return []
        type_filter = ", ".join(f"'{entity_type}'" for entity_type in sorted(set(entity_types)))
        command = (
            "SELECT id, entity_type, confidence, source_count, last_updated, "
            "canonical_name, embedding FROM Entity "
            f"WHERE entity_type IN [{type_filter}] LIMIT {int(limit)}"
        )
        records = await self._command(command)
        return [record for item in records if (record := parse_stored_entity(item)) is not None]

    async def merge_entity(self, decision: ResolutionDecision) -> None:
        if decision.matched_existing is None or decision.merged_entity is None:
            return
        entity = decision.merged_entity
        command = (
            "UPDATE Entity SET "
            f"source_count = {entity.source_count}, "
            f"last_updated = '{entity.last_updated.isoformat()}', "
            f"confidence = {entity.confidence} "
            f"WHERE id = '{entity.id}'"
        )
        await self._command(command)

    async def flag_new_entity(self, decision: ResolutionDecision) -> None:
        return None

    async def _command(self, command: str) -> list[dict[str, Any]]:
        httpx = import_module("httpx")
        async with httpx.AsyncClient(timeout=15) as client:
            response = await client.post(
                f"{self.url}/api/v1/command/{self.database}",
                auth=self.auth,
                json={"language": "sql", "command": command},
            )
            response.raise_for_status()
            data = response.json()
        if isinstance(data, dict):
            result = data.get("result", data.get("records", []))
            return [item for item in result if isinstance(item, dict)] if isinstance(result, list) else []
        return []


def normalize_entity_text(value: str) -> str:
    ascii_value = unicodedata.normalize("NFKD", value).encode("ascii", "ignore").decode("ascii")
    tokens = TOKEN_PATTERN.findall(ascii_value.lower())
    expanded = [LEGAL_TOKEN_EXPANSIONS.get(token, token) for token in tokens]
    return " ".join(expanded)


def pairwise_levenshtein_distances(source: str, candidates: Sequence[str]) -> np.ndarray:
    return np.fromiter(
        (normalized_levenshtein_distance(source, candidate) for candidate in candidates),
        dtype=np.float32,
        count=len(candidates),
    )


def normalized_levenshtein_distance(left: str, right: str) -> float:
    if left == right:
        return 0.0
    if not left or not right:
        return 1.0
    rapidfuzz_distance = rapidfuzz_normalized_distance(left, right)
    if rapidfuzz_distance is not None:
        return rapidfuzz_distance
    return fallback_normalized_levenshtein_distance(left, right)


def rapidfuzz_normalized_distance(left: str, right: str) -> float | None:
    try:
        rapidfuzz_distance = import_module("rapidfuzz.distance")
    except ModuleNotFoundError:
        return None
    return cast(float, rapidfuzz_distance.Levenshtein.normalized_distance(left, right))


def fallback_normalized_levenshtein_distance(left: str, right: str) -> float:
    if len(left) < len(right):
        left, right = right, left
    previous_row = list(range(len(right) + 1))
    for left_index, left_char in enumerate(left, start=1):
        current_row = [left_index]
        for right_index, right_char in enumerate(right, start=1):
            insert_cost = current_row[right_index - 1] + 1
            delete_cost = previous_row[right_index] + 1
            replace_cost = previous_row[right_index - 1] + (left_char != right_char)
            current_row.append(min(insert_cost, delete_cost, replace_cost))
        previous_row = current_row
    return previous_row[-1] / max(len(left), len(right))


def pairwise_semantic_distances(
    embedding_model: EmbeddingModel,
    new_text: str,
    candidates: Sequence[StoredEntityRecord],
) -> np.ndarray:
    new_embedding = normalize_embedding_matrix(embedding_model.embed([new_text]))[0]
    candidate_matrix = candidate_embedding_matrix(embedding_model, candidates)
    similarities = candidate_matrix @ new_embedding
    return np.clip(1.0 - similarities, 0.0, 2.0).astype(np.float32)


def candidate_embedding_matrix(
    embedding_model: EmbeddingModel,
    candidates: Sequence[StoredEntityRecord],
) -> np.ndarray:
    matrix = np.zeros((len(candidates), 0), dtype=np.float32)
    missing_indices: list[int] = []
    seeded_rows: list[tuple[int, np.ndarray]] = []
    for index, candidate in enumerate(candidates):
        if candidate.embedding is None:
            missing_indices.append(index)
            continue
        seeded_rows.append((index, np.asarray(candidate.embedding, dtype=np.float32)))

    generated_embeddings = embedding_model.embed(
        [candidates[index].comparison_text for index in missing_indices]
    ) if missing_indices else np.zeros((0, 0), dtype=np.float32)
    dimensions = infer_embedding_dimensions(seeded_rows, generated_embeddings)
    matrix = np.zeros((len(candidates), dimensions), dtype=np.float32)
    for index, embedding in seeded_rows:
        matrix[index, : min(dimensions, embedding.shape[0])] = embedding[:dimensions]
    for row_index, candidate_index in enumerate(missing_indices):
        matrix[candidate_index] = generated_embeddings[row_index]
    return normalize_embedding_matrix(matrix)


def infer_embedding_dimensions(
    seeded_rows: Sequence[tuple[int, np.ndarray]],
    generated_embeddings: np.ndarray,
) -> int:
    if generated_embeddings.size > 0:
        return int(generated_embeddings.shape[1])
    if seeded_rows:
        return int(seeded_rows[0][1].shape[0])
    return 0


def normalize_embedding_matrix(matrix: np.ndarray) -> np.ndarray:
    array = np.asarray(matrix, dtype=np.float32)
    if array.ndim == 1:
        array = array.reshape(1, -1)
    if array.size == 0:
        return array
    norms = np.linalg.norm(array, axis=1, keepdims=True)
    return np.divide(array, np.maximum(norms, 1e-12), out=np.zeros_like(array), where=norms > 0)


def merge_entity_payload(existing: Entity, new: Entity) -> Entity:
    return existing.model_copy(
        update={
            "confidence": max(existing.confidence, new.confidence),
            "source_count": existing.source_count + new.source_count,
            "last_updated": max(existing.last_updated, new.last_updated),
        }
    )


def create_decision(new_entity: ResolvableEntity) -> ResolutionDecision:
    return ResolutionDecision(
        action="create",
        new_entity=new_entity,
        matched_existing=None,
        lexical_distance=math.inf,
        semantic_distance=math.inf,
    )


def replace_existing_record(
    records: Sequence[StoredEntityRecord],
    old_record: StoredEntityRecord,
    new_record: StoredEntityRecord,
) -> list[StoredEntityRecord]:
    return [new_record if record.entity.id == old_record.entity.id else record for record in records]


def parse_stored_entity(record: dict[str, Any]) -> StoredEntityRecord | None:
    try:
        entity = Entity.model_validate(
            {
                "id": UUID(str(record["id"])),
                "entity_type": record["entity_type"],
                "confidence": float(record["confidence"]),
                "source_count": int(record["source_count"]),
                "last_updated": record["last_updated"],
            }
        )
    except (KeyError, TypeError, ValueError):
        return None
    canonical_name = str(record.get("canonical_name") or entity.id)
    embedding_value = record.get("embedding")
    embedding = tuple(float(value) for value in embedding_value) if isinstance(embedding_value, list) else None
    return StoredEntityRecord(entity=entity, canonical_name=canonical_name, embedding=embedding)
