from __future__ import annotations

import asyncio
from collections.abc import Sequence
from datetime import UTC, datetime
from typing import Any, cast
from uuid import UUID

import numpy as np

from backend.app.schemas import Entity
from backend.app.schemas.core import EntityType
from workers.enrichment.app.entity_resolution import (
    EntityResolutionConfig,
    EntityResolver,
    ResolvableEntity,
    ResolutionDecision,
    StoredEntityRecord,
    normalize_entity_text,
    pairwise_levenshtein_distances,
    pairwise_semantic_distances,
)


class FakeEmbeddingModel:
    def embed(self, texts: Sequence[str]) -> np.ndarray:
        vectors: list[list[float]] = []
        for text in texts:
            normalized = normalize_entity_text(text)
            if normalized in {"corporation x", "x corporation"}:
                vectors.append([1.0, 0.0, 0.0])
            elif normalized == "harbor forum":
                vectors.append([0.0, 1.0, 0.0])
            else:
                vectors.append([0.0, 0.0, 1.0])
        return np.asarray(vectors, dtype=np.float32)


class FakeStore:
    def __init__(self, existing: list[StoredEntityRecord]) -> None:
        self.existing = existing
        self.fetches: list[dict[str, Any]] = []
        self.merged: list[ResolutionDecision] = []
        self.created: list[ResolutionDecision] = []

    async def fetch_existing_entities(
        self,
        *,
        entity_types: Sequence[str],
        limit: int,
    ) -> list[StoredEntityRecord]:
        self.fetches.append({"entity_types": entity_types, "limit": limit})
        return self.existing

    async def merge_entity(self, decision: ResolutionDecision) -> None:
        self.merged.append(decision)

    async def flag_new_entity(self, decision: ResolutionDecision) -> None:
        self.created.append(decision)


def make_entity(
    entity_id: str,
    entity_type: EntityType,
    *,
    source_count: int,
    last_updated: datetime,
    confidence: float = 0.8,
) -> Entity:
    return Entity(
        id=UUID(entity_id),
        entity_type=cast(Any, entity_type),
        confidence=confidence,
        source_count=source_count,
        last_updated=last_updated,
    )


def test_normalization_expands_common_organization_suffixes() -> None:
    assert normalize_entity_text("Corp. X") == "corporation x"
    assert normalize_entity_text("Corporation X") == "corporation x"


def test_vectorized_distance_helpers_rank_close_candidates() -> None:
    candidate = StoredEntityRecord(
        entity=make_entity(
            "11111111-1111-4111-8111-111111111111",
            "ORG",
            source_count=1,
            last_updated=datetime(2026, 5, 3, tzinfo=UTC),
        ),
        canonical_name="Corporation X",
        embedding=(1.0, 0.0, 0.0),
    )
    lexical = pairwise_levenshtein_distances(
        normalize_entity_text("Corp X"),
        [normalize_entity_text("Corporation X"), normalize_entity_text("Harbor Forum")],
    )
    semantic = pairwise_semantic_distances(FakeEmbeddingModel(), "Corp X", [candidate])

    assert lexical.shape == (2,)
    assert lexical[0] == 0.0
    assert lexical[1] > 0.5
    assert semantic.shape == (1,)
    assert semantic[0] == 0.0


def test_resolver_merges_semantic_duplicate_and_updates_counts() -> None:
    async def run() -> None:
        existing = StoredEntityRecord(
            entity=make_entity(
                "11111111-1111-4111-8111-111111111111",
                "ORG",
                source_count=3,
                last_updated=datetime(2026, 5, 3, tzinfo=UTC),
                confidence=0.76,
            ),
            canonical_name="Corporation X",
            embedding=(1.0, 0.0, 0.0),
        )
        new_entity = ResolvableEntity(
            entity=make_entity(
                "22222222-2222-4222-8222-222222222222",
                "ORG",
                source_count=2,
                last_updated=datetime(2026, 5, 4, tzinfo=UTC),
                confidence=0.91,
            ),
            surface_text="Corp X",
        )
        store = FakeStore([existing])
        resolver = EntityResolver(
            store,
            config=EntityResolutionConfig(semantic_merge_distance_threshold=0.01),
            embedding_model=FakeEmbeddingModel(),
        )

        decisions = await resolver.resolve_and_apply([new_entity])

        assert decisions[0].action == "merge"
        assert decisions[0].matched_existing == existing
        assert decisions[0].lexical_distance == 0.0
        assert decisions[0].semantic_distance == 0.0
        assert decisions[0].merged_entity is not None
        assert decisions[0].merged_entity.id == existing.entity.id
        assert decisions[0].merged_entity.source_count == 5
        assert decisions[0].merged_entity.confidence == 0.91
        assert decisions[0].merged_entity.last_updated == datetime(2026, 5, 4, tzinfo=UTC)
        assert store.merged == decisions
        assert store.created == []

    asyncio.run(run())


def test_resolver_flags_distinct_entity_for_new_node_creation() -> None:
    async def run() -> None:
        existing = StoredEntityRecord(
            entity=make_entity(
                "11111111-1111-4111-8111-111111111111",
                "ORG",
                source_count=3,
                last_updated=datetime(2026, 5, 3, tzinfo=UTC),
            ),
            canonical_name="Corporation X",
            embedding=(1.0, 0.0, 0.0),
        )
        new_entity = ResolvableEntity(
            entity=make_entity(
                "33333333-3333-4333-8333-333333333333",
                "ORG",
                source_count=1,
                last_updated=datetime(2026, 5, 4, tzinfo=UTC),
            ),
            surface_text="Harbor Forum",
        )
        store = FakeStore([existing])
        resolver = EntityResolver(
            store,
            config=EntityResolutionConfig(
                semantic_merge_distance_threshold=0.01,
                lexical_candidate_distance_threshold=0.05,
            ),
            embedding_model=FakeEmbeddingModel(),
        )

        decisions = await resolver.resolve_and_apply([new_entity])

        assert decisions[0].action == "create"
        assert decisions[0].should_create_node is True
        assert decisions[0].matched_existing == existing
        assert decisions[0].semantic_distance >= 1.0
        assert store.merged == []
        assert store.created == decisions

    asyncio.run(run())
