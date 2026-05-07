"""ArcadeDB-backed implementation of :class:`SetuStore`.

This is the production swap-in for :class:`InMemorySetuStore`. The contract
is identical (it implements the :class:`SetuStore` Protocol), so the FastAPI
router is constructed exactly the same way. The 14 SETU API tests continue
to run against the in-memory reference; this module is exercised by a
dedicated round-trip test suite using :class:`InMemoryArcadeDBClient`
(``backend/tests/test_setu_arcade_store.py``) so we don't require a live
ArcadeDB cluster in CI.

Design choices
--------------

* **Storage layout**: one document type per logical collection. Every
  document carries a ``payload`` STRING column containing the Pydantic
  ``model_dump_json()`` round-trip so we never have to keep the SQL schema
  in lock-step with the schema module. Index columns (``id``,
  ``project_id``, etc.) are duplicated outside the payload purely for
  filtering.

* **Concurrency**: a per-instance ``asyncio.Lock`` serialises bootstrap;
  individual operations rely on ArcadeDB's own MVCC. The lock is also used
  for triage status transitions so the read-modify-write stays atomic.

* **No raw string interpolation** for filter values — every dynamic value
  is bound via ArcadeDB's ``:param`` mechanism (now supported by
  :meth:`ArcadeDBClient.command`).
"""

from __future__ import annotations

import asyncio
from collections.abc import Iterable, Mapping
from datetime import datetime, timezone
from typing import Any
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
from backend.app.storage import ArcadeDBClient


# ---------------------------------------------------------------------------
# Bootstrap DDL
# ---------------------------------------------------------------------------


_DOC_TYPES: tuple[tuple[str, tuple[str, ...]], ...] = (
    # (type_name, (indexed_property_names...))  — payload column always added.
    ("SetuProject", ("id",)),
    ("SetuSource", ("id", "project_id")),
    ("SetuSourceHealth", ("source_config_id",)),
    ("SetuKeywordSet", ("id", "project_id")),
    ("SetuMention", ("id",)),
    ("SetuNormalized", ("mention_id",)),
    ("SetuAnnotation", ("mention_id",)),
    ("SetuSignal", ("id", "project_id", "kind", "status")),
    ("SetuTriage", ("signal_id",)),
    ("SetuAudit", ("id", "signal_id")),
)


def _bootstrap_statements() -> tuple[str, ...]:
    stmts: list[str] = []
    for type_name, indexed in _DOC_TYPES:
        stmts.append(f"CREATE DOCUMENT TYPE IF NOT EXISTS {type_name}")
        for col in indexed:
            stmts.append(f"CREATE PROPERTY IF NOT EXISTS {type_name}.{col} STRING")
        stmts.append(f"CREATE PROPERTY IF NOT EXISTS {type_name}.payload STRING")
        # Primary key column is the first indexed property.
        if indexed:
            stmts.append(
                f"CREATE INDEX IF NOT EXISTS ON {type_name} ({indexed[0]}) UNIQUE"
            )
    return tuple(stmts)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _utcnow() -> datetime:
    return datetime.now(tz=timezone.utc)


def _payload(record: Mapping[str, Any]) -> str | None:
    raw = record.get("payload")
    return raw if isinstance(raw, str) else None


def _decode(record: Mapping[str, Any], model: type) -> Any | None:
    raw = _payload(record)
    if raw is None:
        return None
    return model.model_validate_json(raw)


def _decode_many(rows: Iterable[Mapping[str, Any]], model: type) -> list[Any]:
    out: list[Any] = []
    for row in rows:
        decoded = _decode(row, model)
        if decoded is not None:
            out.append(decoded)
    return out


# ---------------------------------------------------------------------------
# Store
# ---------------------------------------------------------------------------


class ArcadeDBSetuStore:
    """Production SetuStore backed by ArcadeDB documents."""

    def __init__(self, client: ArcadeDBClient) -> None:
        self._client = client
        self._lock = asyncio.Lock()
        self._bootstrapped = False

    # ------------------------------------------------------------------
    # Bootstrap
    # ------------------------------------------------------------------
    async def ensure_schema(self) -> None:
        """Idempotent DDL bootstrap. Safe to call repeatedly."""
        async with self._lock:
            if self._bootstrapped:
                return
            for stmt in _bootstrap_statements():
                await self._client.command("sql", stmt)
            self._bootstrapped = True

    async def _ready(self) -> None:
        if not self._bootstrapped:
            await self.ensure_schema()

    async def _exec(
        self, command: str, params: dict[str, Any] | None = None
    ) -> list[dict[str, Any]]:
        await self._ready()
        return await self._client.command("sql", command, params)

    @staticmethod
    def _upsert_sql(type_name: str, columns: tuple[str, ...], key_col: str) -> str:
        sets = ", ".join(f"{col} = :{col}" for col in columns)
        return f"UPDATE {type_name} SET {sets} UPSERT WHERE {key_col} = :{key_col}"

    @staticmethod
    def _dump(model) -> str:  # type: ignore[no-untyped-def]
        return model.model_dump_json()

    # ------------------------------------------------------------------
    # Projects
    # ------------------------------------------------------------------
    async def list_projects(self) -> tuple[Project, ...]:
        rows = await self._exec("SELECT FROM SetuProject")
        projects = _decode_many(rows, Project)
        projects.sort(key=lambda p: p.created_at)
        return tuple(projects)

    async def get_project(self, project_id: UUID) -> Project | None:
        rows = await self._exec(
            "SELECT FROM SetuProject WHERE id = :id",
            {"id": str(project_id)},
        )
        if not rows:
            return None
        return _decode(rows[0], Project)

    async def upsert_project(self, project: Project) -> Project:
        await self._exec(
            self._upsert_sql("SetuProject", ("id", "payload"), "id"),
            {"id": str(project.id), "payload": self._dump(project)},
        )
        return project

    async def delete_project(self, project_id: UUID) -> bool:
        rows = await self._exec(
            "DELETE FROM SetuProject WHERE id = :id",
            {"id": str(project_id)},
        )
        return bool(rows and rows[0].get("count", 0) > 0)

    # ------------------------------------------------------------------
    # Sources
    # ------------------------------------------------------------------
    async def list_sources(self, project_id: UUID) -> tuple[SourceConfig, ...]:
        rows = await self._exec(
            "SELECT FROM SetuSource WHERE project_id = :project_id",
            {"project_id": str(project_id)},
        )
        return tuple(_decode_many(rows, SourceConfig))

    async def upsert_source(self, source: SourceConfig) -> SourceConfig:
        await self._exec(
            self._upsert_sql("SetuSource", ("id", "project_id", "payload"), "id"),
            {
                "id": str(source.id),
                "project_id": str(source.project_id),
                "payload": self._dump(source),
            },
        )
        return source

    async def delete_source(self, source_id: UUID) -> bool:
        rows = await self._exec(
            "DELETE FROM SetuSource WHERE id = :id",
            {"id": str(source_id)},
        )
        # Cascade health snapshot; ignore count.
        await self._exec(
            "DELETE FROM SetuSourceHealth WHERE source_config_id = :source_config_id",
            {"source_config_id": str(source_id)},
        )
        return bool(rows and rows[0].get("count", 0) > 0)

    async def upsert_source_health(
        self, snapshot: SourceHealthSnapshot
    ) -> SourceHealthSnapshot:
        await self._exec(
            self._upsert_sql(
                "SetuSourceHealth",
                ("source_config_id", "payload"),
                "source_config_id",
            ),
            {
                "source_config_id": str(snapshot.source_config_id),
                "payload": self._dump(snapshot),
            },
        )
        return snapshot

    async def get_source_health(
        self, source_id: UUID
    ) -> SourceHealthSnapshot | None:
        rows = await self._exec(
            "SELECT FROM SetuSourceHealth WHERE source_config_id = :source_config_id",
            {"source_config_id": str(source_id)},
        )
        if not rows:
            return None
        return _decode(rows[0], SourceHealthSnapshot)

    # ------------------------------------------------------------------
    # Keywords
    # ------------------------------------------------------------------
    async def list_keyword_sets(self, project_id: UUID) -> tuple[KeywordSet, ...]:
        rows = await self._exec(
            "SELECT FROM SetuKeywordSet WHERE project_id = :project_id",
            {"project_id": str(project_id)},
        )
        return tuple(_decode_many(rows, KeywordSet))

    async def upsert_keyword_set(self, keyword_set: KeywordSet) -> KeywordSet:
        await self._exec(
            self._upsert_sql(
                "SetuKeywordSet", ("id", "project_id", "payload"), "id"
            ),
            {
                "id": str(keyword_set.id),
                "project_id": str(keyword_set.project_id),
                "payload": self._dump(keyword_set),
            },
        )
        return keyword_set

    async def get_keyword_set(self, keyword_set_id: UUID) -> KeywordSet | None:
        rows = await self._exec(
            "SELECT FROM SetuKeywordSet WHERE id = :id",
            {"id": str(keyword_set_id)},
        )
        if not rows:
            return None
        return _decode(rows[0], KeywordSet)

    # ------------------------------------------------------------------
    # Mentions / annotations
    # ------------------------------------------------------------------
    async def record_mention(self, mention: HealthMention) -> HealthMention:
        await self._exec(
            self._upsert_sql("SetuMention", ("id", "payload"), "id"),
            {"id": str(mention.id), "payload": self._dump(mention)},
        )
        return mention

    async def record_normalized(
        self, normalized: NormalizedMention
    ) -> NormalizedMention:
        await self._exec(
            self._upsert_sql(
                "SetuNormalized", ("mention_id", "payload"), "mention_id"
            ),
            {
                "mention_id": str(normalized.mention_id),
                "payload": self._dump(normalized),
            },
        )
        return normalized

    async def record_annotation(
        self, annotation: MedicalAnnotation
    ) -> MedicalAnnotation:
        await self._exec(
            self._upsert_sql(
                "SetuAnnotation", ("mention_id", "payload"), "mention_id"
            ),
            {
                "mention_id": str(annotation.mention_id),
                "payload": self._dump(annotation),
            },
        )
        return annotation

    async def get_mention(self, mention_id: UUID) -> HealthMention | None:
        rows = await self._exec(
            "SELECT FROM SetuMention WHERE id = :id",
            {"id": str(mention_id)},
        )
        if not rows:
            return None
        return _decode(rows[0], HealthMention)

    # ------------------------------------------------------------------
    # Signals + triage
    # ------------------------------------------------------------------
    async def list_signals(
        self,
        project_id: UUID,
        *,
        kind: str | None = None,
        status: str | None = None,
        limit: int = 100,
    ) -> tuple[Signal, ...]:
        conditions = ["project_id = :project_id"]
        params: dict[str, Any] = {"project_id": str(project_id)}
        if kind is not None:
            conditions.append("kind = :kind")
            params["kind"] = kind
        if status is not None:
            conditions.append("status = :status")
            params["status"] = status
        rows = await self._exec(
            f"SELECT FROM SetuSignal WHERE {' AND '.join(conditions)}",
            params,
        )
        signals = _decode_many(rows, Signal)
        signals.sort(key=lambda s: s.detected_at, reverse=True)
        return tuple(signals[: max(limit, 0)])

    async def get_signal(self, signal_id: UUID) -> Signal | None:
        rows = await self._exec(
            "SELECT FROM SetuSignal WHERE id = :id",
            {"id": str(signal_id)},
        )
        if not rows:
            return None
        return _decode(rows[0], Signal)

    async def upsert_signal(self, signal: Signal) -> Signal:
        await self._exec(
            self._upsert_sql(
                "SetuSignal",
                ("id", "project_id", "kind", "status", "payload"),
                "id",
            ),
            {
                "id": str(signal.id),
                "project_id": str(signal.project_id),
                "kind": signal.kind,
                "status": signal.status,
                "payload": self._dump(signal),
            },
        )
        return signal

    async def record_triage(self, decision: TriageDecision) -> Signal:
        # Atomic: read-modify-write the signal status under our own lock.
        async with self._lock:
            existing = await self._signal_locked(decision.signal_id)
            if existing is None:
                raise KeyError(decision.signal_id)
            # Append decision row (no UPSERT — multiple decisions per signal).
            # Use a synthetic key (signal_id + decided_at iso) so we still get
            # uniqueness without forcing the schema to know about it.
            row_key = f"{decision.signal_id}:{decision.decided_at.isoformat()}"
            await self._client.command(
                "sql",
                "INSERT INTO SetuTriage SET signal_id = :signal_id, "
                "row_key = :row_key, payload = :payload",
                {
                    "signal_id": str(decision.signal_id),
                    "row_key": row_key,
                    "payload": self._dump(decision),
                },
            )
            new_status: str
            if decision.decision == "confirm":
                new_status = "confirmed"
            elif decision.decision == "reject":
                new_status = "rejected"
            else:
                new_status = "more_data"
            updated = existing.model_copy(
                update={"status": new_status, "assignee": decision.actor}
            )
            await self._client.command(
                "sql",
                self._upsert_sql(
                    "SetuSignal",
                    ("id", "project_id", "kind", "status", "payload"),
                    "id",
                ),
                {
                    "id": str(updated.id),
                    "project_id": str(updated.project_id),
                    "kind": updated.kind,
                    "status": updated.status,
                    "payload": self._dump(updated),
                },
            )
            return updated

    async def _signal_locked(self, signal_id: UUID) -> Signal | None:
        # Bypass the outer lock acquisition (already held).
        if not self._bootstrapped:
            for stmt in _bootstrap_statements():
                await self._client.command("sql", stmt)
            self._bootstrapped = True
        rows = await self._client.command(
            "sql",
            "SELECT FROM SetuSignal WHERE id = :id",
            {"id": str(signal_id)},
        )
        if not rows:
            return None
        return _decode(rows[0], Signal)

    async def list_triage_decisions(
        self, signal_id: UUID
    ) -> tuple[TriageDecision, ...]:
        rows = await self._exec(
            "SELECT FROM SetuTriage WHERE signal_id = :signal_id",
            {"signal_id": str(signal_id)},
        )
        decisions = _decode_many(rows, TriageDecision)
        decisions.sort(key=lambda d: d.decided_at)
        return tuple(decisions)

    # ------------------------------------------------------------------
    # Audit
    # ------------------------------------------------------------------
    async def append_audit(self, entry: AuditEntry) -> AuditEntry:
        await self._exec(
            self._upsert_sql(
                "SetuAudit", ("id", "signal_id", "payload"), "id"
            ),
            {
                "id": str(entry.id),
                "signal_id": str(entry.signal_id) if entry.signal_id else "",
                "payload": self._dump(entry),
            },
        )
        return entry

    async def list_audit(
        self,
        *,
        project_id: UUID | None = None,
        signal_id: UUID | None = None,
        limit: int = 200,
    ) -> tuple[AuditEntry, ...]:
        if signal_id is not None:
            rows = await self._exec(
                "SELECT FROM SetuAudit WHERE signal_id = :signal_id",
                {"signal_id": str(signal_id)},
            )
        else:
            rows = await self._exec("SELECT FROM SetuAudit")

        entries = _decode_many(rows, AuditEntry)
        if project_id is not None:
            # Cross-reference via signals.
            signal_rows = await self._exec(
                "SELECT FROM SetuSignal WHERE project_id = :project_id",
                {"project_id": str(project_id)},
            )
            allowed = {
                s.id for s in _decode_many(signal_rows, Signal)
            }
            entries = [
                e for e in entries if e.signal_id is not None and e.signal_id in allowed
            ]
        entries.sort(key=lambda e: e.sequence)
        return tuple(entries[-max(limit, 0):])


__all__ = ["ArcadeDBSetuStore"]
