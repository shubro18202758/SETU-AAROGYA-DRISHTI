"""In-memory async-safe store for SETU entities.

This is the canonical interface for the API layer. The production swap-in
will be an ArcadeDB-backed implementation — Phase 8 — but every router
contract here is exercised against :class:`InMemorySetuStore` in tests so
the Protocol stays honest.
"""

from __future__ import annotations

import asyncio
from collections.abc import Iterable, Sequence
from datetime import datetime, timezone
from typing import Protocol
from uuid import UUID

from backend.app.schemas.health import (
    AuditEntry,
    HealthMention,
    KeywordSet,
    MedicalAnnotation,
    NormalizedMention,
    Project,
    Signal,
    SourceConfig,
    SourceHealthSnapshot,
    TriageDecision,
)


def _utcnow() -> datetime:
    return datetime.now(tz=timezone.utc)


class SetuStore(Protocol):
    # Projects ----------------------------------------------------------
    async def list_projects(self) -> tuple[Project, ...]: ...
    async def get_project(self, project_id: UUID) -> Project | None: ...
    async def upsert_project(self, project: Project) -> Project: ...
    async def delete_project(self, project_id: UUID) -> bool: ...

    # Sources -----------------------------------------------------------
    async def list_sources(self, project_id: UUID) -> tuple[SourceConfig, ...]: ...
    async def upsert_source(self, source: SourceConfig) -> SourceConfig: ...
    async def delete_source(self, source_id: UUID) -> bool: ...
    async def upsert_source_health(self, snapshot: SourceHealthSnapshot) -> SourceHealthSnapshot: ...
    async def get_source_health(self, source_id: UUID) -> SourceHealthSnapshot | None: ...

    # Keywords ----------------------------------------------------------
    async def list_keyword_sets(self, project_id: UUID) -> tuple[KeywordSet, ...]: ...
    async def upsert_keyword_set(self, keyword_set: KeywordSet) -> KeywordSet: ...
    async def get_keyword_set(self, keyword_set_id: UUID) -> KeywordSet | None: ...

    # Mentions / annotations -------------------------------------------
    async def record_mention(self, mention: HealthMention) -> HealthMention: ...
    async def record_normalized(self, normalized: NormalizedMention) -> NormalizedMention: ...
    async def record_annotation(self, annotation: MedicalAnnotation) -> MedicalAnnotation: ...
    async def get_mention(self, mention_id: UUID) -> HealthMention | None: ...

    # Signals + triage --------------------------------------------------
    async def list_signals(
        self,
        project_id: UUID,
        *,
        kind: str | None = None,
        status: str | None = None,
        limit: int = 100,
    ) -> tuple[Signal, ...]: ...
    async def get_signal(self, signal_id: UUID) -> Signal | None: ...
    async def upsert_signal(self, signal: Signal) -> Signal: ...
    async def record_triage(self, decision: TriageDecision) -> Signal: ...
    async def list_triage_decisions(self, signal_id: UUID) -> tuple[TriageDecision, ...]: ...

    # Audit chain -------------------------------------------------------
    async def append_audit(self, entry: AuditEntry) -> AuditEntry: ...
    async def list_audit(
        self, *, project_id: UUID | None = None, signal_id: UUID | None = None, limit: int = 200
    ) -> tuple[AuditEntry, ...]: ...


class InMemorySetuStore:
    """Process-local async-safe SETU store. Backed by simple dicts + a lock."""

    def __init__(self) -> None:
        self._lock = asyncio.Lock()
        self._projects: dict[UUID, Project] = {}
        self._sources: dict[UUID, SourceConfig] = {}
        self._source_health: dict[UUID, SourceHealthSnapshot] = {}
        self._keyword_sets: dict[UUID, KeywordSet] = {}
        self._mentions: dict[UUID, HealthMention] = {}
        self._normalized: dict[UUID, NormalizedMention] = {}
        self._annotations: dict[UUID, MedicalAnnotation] = {}
        self._signals: dict[UUID, Signal] = {}
        self._triage: dict[UUID, list[TriageDecision]] = {}
        self._audit: list[AuditEntry] = []

    # Projects ----------------------------------------------------------
    async def list_projects(self) -> tuple[Project, ...]:
        async with self._lock:
            return tuple(sorted(self._projects.values(), key=lambda project: project.created_at))

    async def get_project(self, project_id: UUID) -> Project | None:
        async with self._lock:
            return self._projects.get(project_id)

    async def upsert_project(self, project: Project) -> Project:
        async with self._lock:
            self._projects[project.id] = project
            return project

    async def delete_project(self, project_id: UUID) -> bool:
        async with self._lock:
            return self._projects.pop(project_id, None) is not None

    # Sources -----------------------------------------------------------
    async def list_sources(self, project_id: UUID) -> tuple[SourceConfig, ...]:
        async with self._lock:
            return tuple(
                source
                for source in self._sources.values()
                if source.project_id == project_id
            )

    async def upsert_source(self, source: SourceConfig) -> SourceConfig:
        async with self._lock:
            self._sources[source.id] = source
            return source

    async def delete_source(self, source_id: UUID) -> bool:
        async with self._lock:
            removed = self._sources.pop(source_id, None) is not None
            self._source_health.pop(source_id, None)
            return removed

    async def upsert_source_health(self, snapshot: SourceHealthSnapshot) -> SourceHealthSnapshot:
        async with self._lock:
            self._source_health[snapshot.source_config_id] = snapshot
            return snapshot

    async def get_source_health(self, source_id: UUID) -> SourceHealthSnapshot | None:
        async with self._lock:
            return self._source_health.get(source_id)

    # Keywords ----------------------------------------------------------
    async def list_keyword_sets(self, project_id: UUID) -> tuple[KeywordSet, ...]:
        async with self._lock:
            return tuple(
                ks
                for ks in self._keyword_sets.values()
                if ks.project_id == project_id
            )

    async def upsert_keyword_set(self, keyword_set: KeywordSet) -> KeywordSet:
        async with self._lock:
            self._keyword_sets[keyword_set.id] = keyword_set
            return keyword_set

    async def get_keyword_set(self, keyword_set_id: UUID) -> KeywordSet | None:
        async with self._lock:
            return self._keyword_sets.get(keyword_set_id)

    # Mentions / annotations -------------------------------------------
    async def record_mention(self, mention: HealthMention) -> HealthMention:
        async with self._lock:
            self._mentions[mention.id] = mention
            return mention

    async def record_normalized(self, normalized: NormalizedMention) -> NormalizedMention:
        async with self._lock:
            self._normalized[normalized.mention_id] = normalized
            return normalized

    async def record_annotation(self, annotation: MedicalAnnotation) -> MedicalAnnotation:
        async with self._lock:
            self._annotations[annotation.mention_id] = annotation
            return annotation

    async def get_mention(self, mention_id: UUID) -> HealthMention | None:
        async with self._lock:
            return self._mentions.get(mention_id)

    # Signals + triage --------------------------------------------------
    async def list_signals(
        self,
        project_id: UUID,
        *,
        kind: str | None = None,
        status: str | None = None,
        limit: int = 100,
    ) -> tuple[Signal, ...]:
        async with self._lock:
            results = [
                signal
                for signal in self._signals.values()
                if signal.project_id == project_id
                and (kind is None or signal.kind == kind)
                and (status is None or signal.status == status)
            ]
        results.sort(key=lambda signal: signal.detected_at, reverse=True)
        return tuple(results[: max(limit, 0)])

    async def get_signal(self, signal_id: UUID) -> Signal | None:
        async with self._lock:
            return self._signals.get(signal_id)

    async def upsert_signal(self, signal: Signal) -> Signal:
        async with self._lock:
            self._signals[signal.id] = signal
            return signal

    async def record_triage(self, decision: TriageDecision) -> Signal:
        async with self._lock:
            existing = self._signals.get(decision.signal_id)
            if existing is None:
                raise KeyError(decision.signal_id)
            self._triage.setdefault(decision.signal_id, []).append(decision)
            new_status: str
            if decision.decision == "confirm":
                new_status = "confirmed"
            elif decision.decision == "reject":
                new_status = "rejected"
            else:
                new_status = "more_data"
            updated = existing.model_copy(update={"status": new_status, "assignee": decision.actor})
            self._signals[decision.signal_id] = updated
            return updated

    async def list_triage_decisions(self, signal_id: UUID) -> tuple[TriageDecision, ...]:
        async with self._lock:
            return tuple(self._triage.get(signal_id, ()))

    # Audit -------------------------------------------------------------
    async def append_audit(self, entry: AuditEntry) -> AuditEntry:
        async with self._lock:
            self._audit.append(entry)
            return entry

    async def list_audit(
        self,
        *,
        project_id: UUID | None = None,
        signal_id: UUID | None = None,
        limit: int = 200,
    ) -> tuple[AuditEntry, ...]:
        async with self._lock:
            entries: Iterable[AuditEntry] = self._audit
            if signal_id is not None:
                entries = (e for e in entries if e.signal_id == signal_id)
            if project_id is not None:
                # AuditEntry has no project_id field; filter via signal lookup.
                signals = self._signals
                entries = (
                    e
                    for e in entries
                    if e.signal_id is not None
                    and signals.get(e.signal_id) is not None
                    and signals[e.signal_id].project_id == project_id
                )
            return tuple(list(entries)[-max(limit, 0):])

    # Test helpers ------------------------------------------------------
    def seed_audit(self, entries: Sequence[AuditEntry]) -> None:
        self._audit.extend(entries)


__all__ = ["InMemorySetuStore", "SetuStore", "_utcnow"]
