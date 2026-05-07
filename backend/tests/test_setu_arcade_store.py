"""Round-trip tests for :class:`ArcadeDBSetuStore`.

We don't require a live ArcadeDB cluster — instead we run the store against
:class:`InMemoryArcadeDBClient`, a tiny SQL pattern-matcher that handles
only the ``UPDATE … UPSERT``, ``INSERT``, ``SELECT … WHERE …`` and
``DELETE`` shapes the store actually emits. This keeps CI fast and offline
while still exercising the SQL-emission boundary.
"""

from __future__ import annotations

import re
from collections.abc import Mapping
from datetime import datetime, timedelta, timezone
from typing import Any
from uuid import UUID, uuid4

import pytest

from backend.app.schemas.health import (
    AuditEntry,
    Project,
    Signal,
    SourceConfig,
    SourceHealthSnapshot,
    TriageDecision,
)
from backend.app.setu.arcade_store import ArcadeDBSetuStore


# ---------------------------------------------------------------------------
# In-memory ArcadeDB fake
# ---------------------------------------------------------------------------


_RX_UPSERT = re.compile(
    r"UPDATE\s+(\w+)\s+SET\s+(.+?)\s+UPSERT\s+WHERE\s+(\w+)\s*=\s*:(\w+)",
    re.IGNORECASE | re.DOTALL,
)
_RX_INSERT = re.compile(
    r"INSERT\s+INTO\s+(\w+)\s+SET\s+(.+)", re.IGNORECASE | re.DOTALL
)
_RX_SELECT = re.compile(
    r"SELECT\s+FROM\s+(\w+)(?:\s+WHERE\s+(.+))?", re.IGNORECASE | re.DOTALL
)
_RX_DELETE = re.compile(
    r"DELETE\s+FROM\s+(\w+)\s+WHERE\s+(\w+)\s*=\s*:(\w+)",
    re.IGNORECASE | re.DOTALL,
)
_RX_AND = re.compile(r"\s+AND\s+", re.IGNORECASE)
_RX_COND = re.compile(r"(\w+)\s*=\s*:(\w+)")
_RX_SET = re.compile(r"(\w+)\s*=\s*:(\w+)")


def _parse_sets(set_clause: str, params: Mapping[str, Any]) -> dict[str, Any]:
    pairs = [s.strip() for s in set_clause.split(",")]
    row: dict[str, Any] = {}
    for pair in pairs:
        match = _RX_SET.match(pair)
        if not match:
            raise AssertionError(f"unparsable SET fragment: {pair!r}")
        col, param = match.group(1), match.group(2)
        if param not in params:
            raise AssertionError(f"missing bound param :{param}")
        row[col] = params[param]
    return row


def _matches(row: Mapping[str, Any], where: str, params: Mapping[str, Any]) -> bool:
    for clause in _RX_AND.split(where.strip()):
        match = _RX_COND.match(clause.strip())
        if not match:
            raise AssertionError(f"unparsable WHERE fragment: {clause!r}")
        col, param = match.group(1), match.group(2)
        if row.get(col) != params.get(param):
            return False
    return True


class InMemoryArcadeDBClient:
    """Minimal fake satisfying the ArcadeDBClient surface used by the store."""

    def __init__(self) -> None:
        self.tables: dict[str, list[dict[str, Any]]] = {}
        self.commands: list[tuple[str, dict[str, Any]]] = []

    async def command(
        self,
        language: str,
        command: str,
        params: dict[str, Any] | None = None,
    ) -> list[dict[str, Any]]:
        assert language == "sql"
        params = params or {}
        self.commands.append((command, dict(params)))
        text = command.strip().rstrip(";").strip()
        upper = text.upper()
        if upper.startswith(("CREATE DOCUMENT TYPE", "CREATE PROPERTY", "CREATE INDEX")):
            return []
        if (m := _RX_UPSERT.match(text)) is not None:
            type_name, sets, key_col, key_param = m.groups()
            row = _parse_sets(sets, params)
            table = self.tables.setdefault(type_name, [])
            target = params[key_param]
            for existing in table:
                if existing.get(key_col) == target:
                    existing.update(row)
                    return [{"count": 1}]
            table.append(row)
            return [{"count": 1}]
        if (m := _RX_INSERT.match(text)) is not None:
            type_name, sets = m.groups()
            row = _parse_sets(sets, params)
            self.tables.setdefault(type_name, []).append(row)
            return [{"count": 1}]
        if (m := _RX_DELETE.match(text)) is not None:
            type_name, key_col, key_param = m.groups()
            target = params[key_param]
            table = self.tables.get(type_name, [])
            kept = [row for row in table if row.get(key_col) != target]
            removed = len(table) - len(kept)
            self.tables[type_name] = kept
            return [{"count": removed}]
        if (m := _RX_SELECT.match(text)) is not None:
            type_name, where = m.groups()
            rows = list(self.tables.get(type_name, []))
            if where:
                rows = [r for r in rows if _matches(r, where, params)]
            return rows
        raise AssertionError(f"unsupported SQL: {text!r}")


# ---------------------------------------------------------------------------
# Builders
# ---------------------------------------------------------------------------


def _now() -> datetime:
    return datetime.now(tz=timezone.utc).replace(microsecond=0)


def _project(*, slug: str = "demo") -> Project:
    now = _now()
    return Project(
        id=uuid4(),
        slug=slug,
        name="Demo project",
        description="A SETU demo project for ArcadeDB round-trip tests.",
        owner="qa",
        status="active",
        created_at=now,
        updated_at=now,
    )


def _source(project_id: UUID) -> SourceConfig:
    return SourceConfig(
        id=uuid4(),
        project_id=project_id,
        name="Demo RSS",
        connector_type="rss",
        connector_params={"feed_urls": ("https://example.org/feed.xml",)},
        latency_tier="daily",
        enabled=True,
        created_at=_now(),
    )


def _signal(project_id: UUID, *, kind: str = "trend", status: str = "new") -> Signal:
    now = _now()
    return Signal(
        id=uuid4(),
        project_id=project_id,
        kind=kind,  # type: ignore[arg-type]
        score=0.7,
        title="Spike in Chennai",
        explanation="Trend detector observed a 4-sigma jump on day 8.",
        district="chennai",
        started_at=now - timedelta(days=1),
        detected_at=now,
        status=status,  # type: ignore[arg-type]
    )


def _audit(signal_id: UUID, *, sequence: int) -> AuditEntry:
    return AuditEntry(
        id=uuid4(),
        sequence=sequence,
        prev_hash="0" * 64,
        payload_hash="a" * 64,
        actor="signals-worker",
        action="signal.emit",
        signal_id=signal_id,
        payload_summary="trend signal observed",
        recorded_at=_now(),
    )


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_bootstrap_emits_ddl_once():
    client = InMemoryArcadeDBClient()
    store = ArcadeDBSetuStore(client)
    await store.ensure_schema()
    await store.ensure_schema()  # idempotent
    ddl = [c for c, _ in client.commands if c.startswith("CREATE")]
    assert len(ddl) > 0
    # Second call must NOT re-issue any DDL.
    create_indexes = [c for c in ddl if c.startswith("CREATE INDEX")]
    assert len(create_indexes) == 10  # one per doc type


@pytest.mark.asyncio
async def test_project_round_trip():
    store = ArcadeDBSetuStore(InMemoryArcadeDBClient())
    project = _project()
    await store.upsert_project(project)
    fetched = await store.get_project(project.id)
    assert fetched == project
    listed = await store.list_projects()
    assert listed == (project,)


@pytest.mark.asyncio
async def test_project_delete_returns_true_only_when_present():
    store = ArcadeDBSetuStore(InMemoryArcadeDBClient())
    project = _project()
    await store.upsert_project(project)
    assert await store.delete_project(project.id) is True
    assert await store.delete_project(project.id) is False
    assert await store.get_project(project.id) is None


@pytest.mark.asyncio
async def test_sources_listed_per_project_and_health_cascades():
    store = ArcadeDBSetuStore(InMemoryArcadeDBClient())
    project_a = _project(slug="alpha")
    project_b = _project(slug="bravo")
    src_a1 = _source(project_a.id)
    src_a2 = _source(project_a.id)
    src_b1 = _source(project_b.id)
    for s in (src_a1, src_a2, src_b1):
        await store.upsert_source(s)

    listed_a = await store.list_sources(project_a.id)
    assert {s.id for s in listed_a} == {src_a1.id, src_a2.id}
    listed_b = await store.list_sources(project_b.id)
    assert {s.id for s in listed_b} == {src_b1.id}

    snapshot = SourceHealthSnapshot(
        source_config_id=src_a1.id,
        health_score=0.9,
        uptime_ratio=0.99,
        error_rate=0.01,
        snapshot_at=_now(),
    )
    await store.upsert_source_health(snapshot)
    assert await store.get_source_health(src_a1.id) == snapshot

    assert await store.delete_source(src_a1.id) is True
    assert await store.get_source_health(src_a1.id) is None  # cascade
    assert {s.id for s in await store.list_sources(project_a.id)} == {src_a2.id}


@pytest.mark.asyncio
async def test_signal_filters_and_limit():
    store = ArcadeDBSetuStore(InMemoryArcadeDBClient())
    project = _project()
    trend_new = _signal(project.id, kind="trend", status="new")
    trend_triaged = _signal(project.id, kind="trend", status="triaged")
    cluster_new = _signal(project.id, kind="cluster", status="new")
    for s in (trend_new, trend_triaged, cluster_new):
        await store.upsert_signal(s)

    all_signals = await store.list_signals(project.id)
    assert len(all_signals) == 3

    trends = await store.list_signals(project.id, kind="trend")
    assert {s.id for s in trends} == {trend_new.id, trend_triaged.id}

    new_only = await store.list_signals(project.id, status="new")
    assert {s.id for s in new_only} == {trend_new.id, cluster_new.id}

    limited = await store.list_signals(project.id, limit=1)
    assert len(limited) == 1


@pytest.mark.asyncio
async def test_triage_appends_decision_and_updates_signal_status():
    store = ArcadeDBSetuStore(InMemoryArcadeDBClient())
    project = _project()
    signal = _signal(project.id)
    await store.upsert_signal(signal)

    decision = TriageDecision(
        signal_id=signal.id,
        actor="analyst.alice",
        decision="confirm",
        rationale="Independent IDSP confirmation came in.",
        decided_at=_now(),
    )
    updated = await store.record_triage(decision)
    assert updated.status == "confirmed"
    assert updated.assignee == "analyst.alice"

    refetched = await store.get_signal(signal.id)
    assert refetched is not None
    assert refetched.status == "confirmed"

    decisions = await store.list_triage_decisions(signal.id)
    assert decisions == (decision,)


@pytest.mark.asyncio
async def test_triage_unknown_signal_raises_keyerror():
    store = ArcadeDBSetuStore(InMemoryArcadeDBClient())
    decision = TriageDecision(
        signal_id=uuid4(),
        actor="analyst.bob",
        decision="reject",
        decided_at=_now(),
    )
    with pytest.raises(KeyError):
        await store.record_triage(decision)


@pytest.mark.asyncio
async def test_audit_filtered_by_signal_and_project():
    store = ArcadeDBSetuStore(InMemoryArcadeDBClient())
    project_a = _project(slug="alpha")
    project_b = _project(slug="bravo")
    sig_a = _signal(project_a.id)
    sig_b = _signal(project_b.id)
    await store.upsert_signal(sig_a)
    await store.upsert_signal(sig_b)

    entries_a = [_audit(sig_a.id, sequence=i) for i in range(3)]
    entries_b = [_audit(sig_b.id, sequence=i) for i in range(2)]
    for e in entries_a + entries_b:
        await store.append_audit(e)

    by_signal = await store.list_audit(signal_id=sig_a.id)
    assert {e.id for e in by_signal} == {e.id for e in entries_a}
    assert [e.sequence for e in by_signal] == [0, 1, 2]

    by_project = await store.list_audit(project_id=project_a.id)
    assert {e.id for e in by_project} == {e.id for e in entries_a}

    all_entries = await store.list_audit()
    assert len(all_entries) == 5
