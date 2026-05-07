"""FastAPI router for the SETU AAROGYA DRISHTI surface.

All endpoints are mounted under ``/api/setu``. The router takes a
:class:`SetuStore` and is therefore trivially testable with the in-memory
implementation; production wiring will swap in an ArcadeDB-backed store
without touching this file.
"""

from __future__ import annotations

from collections.abc import Mapping
from datetime import datetime, timezone
from typing import Any, Literal
from uuid import UUID, uuid4

from fastapi import APIRouter, HTTPException, Query, Response, status
from pydantic import BaseModel, ConfigDict, Field

from backend.app.schemas.health import (
    AdverseEventStatistic,
    AuditEntry,
    ClusterStatistic,
    KeywordSet,
    Project,
    ProjectStatus,
    Signal,
    SignalKind,
    SignalStatus,
    SourceConfig,
    SourceHealthSnapshot,
    TrendStatistic,
    TriageDecision,
)

from .store import SetuStore
from .exporters import ExporterError, build_idsp_p_form, build_pvpi_icsr


# ---------------------------------------------------------------------------
# Request bodies (mutable inputs — separate from the strict frozen schemas).
# ---------------------------------------------------------------------------


class _RequestBase(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)


class ProjectCreateRequest(_RequestBase):
    slug: str = Field(min_length=1, max_length=128, pattern=r"^[a-z0-9][a-z0-9_-]*$")
    name: str = Field(min_length=1, max_length=512)
    description: str = Field(min_length=1, max_length=8192)
    owner: str = Field(min_length=1, max_length=512)
    status: ProjectStatus = "active"


class ProjectUpdateRequest(_RequestBase):
    name: str | None = Field(default=None, min_length=1, max_length=512)
    description: str | None = Field(default=None, min_length=1, max_length=8192)
    owner: str | None = Field(default=None, min_length=1, max_length=512)
    status: ProjectStatus | None = None
    keyword_set_id: UUID | None = None


class SourceCreateRequest(_RequestBase):
    name: str = Field(min_length=1, max_length=512)
    connector_type: Literal["reddit", "youtube", "rss", "telegram", "web", "x_fixture"]
    connector_params: Mapping[str, Any] = Field(default_factory=dict)
    latency_tier: Literal["realtime", "daily", "weekly"] = "daily"
    enabled: bool = True


class KeywordSetCreateRequest(_RequestBase):
    terms: tuple[str, ...] = Field(min_length=1, max_length=2048)
    synonyms: Mapping[str, tuple[str, ...]] = Field(default_factory=dict)
    languages: tuple[str, ...] = Field(default_factory=tuple)
    approved_by: str | None = Field(default=None, min_length=1, max_length=512)


class TriageRequest(_RequestBase):
    actor: str = Field(min_length=1, max_length=512)
    decision: Literal["confirm", "reject", "more_data"]
    rationale: str | None = Field(default=None, min_length=1, max_length=8192)


class SourceHealthRequest(_RequestBase):
    health_score: float = Field(ge=0.0, le=1.0)
    uptime_ratio: float = Field(ge=0.0, le=1.0)
    error_rate: float = Field(ge=0.0, le=1.0)
    throughput_per_min: float = Field(ge=0.0, default=0.0)


class SignalCreateRequest(_RequestBase):
    kind: SignalKind
    score: float = Field(ge=0.0, le=1.0)
    title: str = Field(min_length=1, max_length=512)
    explanation: str = Field(min_length=1, max_length=8192)
    district: str | None = Field(default=None, min_length=1, max_length=512)
    started_at: datetime
    detected_at: datetime | None = None
    adr_stat: dict[str, Any] | None = None
    trend_stat: dict[str, Any] | None = None
    cluster_stat: dict[str, Any] | None = None


class AuditAppendRequest(_RequestBase):
    actor: str = Field(min_length=1, max_length=512)
    action: str = Field(min_length=1, max_length=512)
    payload_summary: str = Field(min_length=1, max_length=512)
    payload: Mapping[str, Any] = Field(default_factory=dict)
    signal_id: UUID | None = None
    mention_id: UUID | None = None


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


import hashlib
import json as _json

try:  # pragma: no cover - exercised only when blake3 is installed.
    from blake3 import blake3 as _blake3  # type: ignore[import-not-found]

    def _digest(data: bytes) -> str:
        return _blake3(data).hexdigest()
except ImportError:

    def _digest(data: bytes) -> str:
        return hashlib.blake2b(data, digest_size=32).hexdigest()


_GENESIS_HASH = "0" * 64


def _canonical(payload: Mapping[str, Any]) -> bytes:
    return _json.dumps(payload, sort_keys=True, separators=(",", ":"), default=str).encode("utf-8")


def _chain_hash(prev_hash: str, payload: Mapping[str, Any]) -> str:
    return _digest(prev_hash.encode("ascii") + b"|" + _canonical(payload))


def _utcnow() -> datetime:
    return datetime.now(tz=timezone.utc)


async def _require_project(store: SetuStore, project_id: UUID) -> Project:
    project = await store.get_project(project_id)
    if project is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, f"project {project_id} not found")
    return project


async def _require_signal(store: SetuStore, signal_id: UUID) -> Signal:
    signal = await store.get_signal(signal_id)
    if signal is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, f"signal {signal_id} not found")
    return signal


# ---------------------------------------------------------------------------
# Router factory
# ---------------------------------------------------------------------------


def create_setu_router(store: SetuStore) -> APIRouter:
    router = APIRouter(prefix="/api/setu", tags=["setu"])

    # Projects ----------------------------------------------------------
    @router.get("/projects", response_model=list[Project])
    async def list_projects() -> list[Project]:
        return list(await store.list_projects())

    @router.post(
        "/projects", response_model=Project, status_code=status.HTTP_201_CREATED
    )
    async def create_project(payload: ProjectCreateRequest) -> Project:
        existing = await store.list_projects()
        if any(project.slug == payload.slug for project in existing):
            raise HTTPException(
                status.HTTP_409_CONFLICT, f"project slug {payload.slug!r} already exists"
            )
        now = _utcnow()
        project = Project(
            id=uuid4(),
            slug=payload.slug,
            name=payload.name,
            description=payload.description,
            owner=payload.owner,
            status=payload.status,
            keyword_set_id=None,
            source_ids=(),
            created_at=now,
            updated_at=now,
        )
        return await store.upsert_project(project)

    @router.get("/projects/{project_id}", response_model=Project)
    async def get_project(project_id: UUID) -> Project:
        return await _require_project(store, project_id)

    @router.patch("/projects/{project_id}", response_model=Project)
    async def update_project(project_id: UUID, payload: ProjectUpdateRequest) -> Project:
        existing = await _require_project(store, project_id)
        updates: dict[str, Any] = {"updated_at": _utcnow()}
        for field_name in ("name", "description", "owner", "status", "keyword_set_id"):
            value = getattr(payload, field_name)
            if value is not None:
                updates[field_name] = value
        return await store.upsert_project(existing.model_copy(update=updates))

    @router.delete(
        "/projects/{project_id}",
        status_code=status.HTTP_204_NO_CONTENT,
        response_class=Response,
    )
    async def delete_project(project_id: UUID) -> Response:
        if not await store.delete_project(project_id):
            raise HTTPException(status.HTTP_404_NOT_FOUND, f"project {project_id} not found")
        return Response(status_code=status.HTTP_204_NO_CONTENT)

    # Sources -----------------------------------------------------------
    @router.get("/projects/{project_id}/sources", response_model=list[SourceConfig])
    async def list_sources(project_id: UUID) -> list[SourceConfig]:
        await _require_project(store, project_id)
        return list(await store.list_sources(project_id))

    @router.post(
        "/projects/{project_id}/sources",
        response_model=SourceConfig,
        status_code=status.HTTP_201_CREATED,
    )
    async def create_source(project_id: UUID, payload: SourceCreateRequest) -> SourceConfig:
        project = await _require_project(store, project_id)
        source = SourceConfig(
            id=uuid4(),
            project_id=project_id,
            name=payload.name,
            connector_type=payload.connector_type,
            connector_params=payload.connector_params,
            latency_tier=payload.latency_tier,
            enabled=payload.enabled,
            health_score=1.0,
            last_success_at=None,
            last_error=None,
            created_at=_utcnow(),
        )
        created = await store.upsert_source(source)
        if source.id not in project.source_ids:
            await store.upsert_project(
                project.model_copy(
                    update={
                        "source_ids": (*project.source_ids, source.id),
                        "updated_at": _utcnow(),
                    }
                )
            )
        return created

    @router.delete(
        "/projects/{project_id}/sources/{source_id}",
        status_code=status.HTTP_204_NO_CONTENT,
        response_class=Response,
    )
    async def delete_source(project_id: UUID, source_id: UUID) -> Response:
        project = await _require_project(store, project_id)
        if not await store.delete_source(source_id):
            raise HTTPException(status.HTTP_404_NOT_FOUND, f"source {source_id} not found")
        await store.upsert_project(
            project.model_copy(
                update={
                    "source_ids": tuple(existing for existing in project.source_ids if existing != source_id),
                    "updated_at": _utcnow(),
                }
            )
        )
        return Response(status_code=status.HTTP_204_NO_CONTENT)

    @router.put(
        "/projects/{project_id}/sources/{source_id}/health",
        response_model=SourceHealthSnapshot,
    )
    async def update_source_health(
        project_id: UUID, source_id: UUID, payload: SourceHealthRequest
    ) -> SourceHealthSnapshot:
        await _require_project(store, project_id)
        snapshot = SourceHealthSnapshot(
            source_config_id=source_id,
            health_score=payload.health_score,
            uptime_ratio=payload.uptime_ratio,
            error_rate=payload.error_rate,
            last_success_at=_utcnow(),
            throughput_per_min=payload.throughput_per_min,
            snapshot_at=_utcnow(),
        )
        return await store.upsert_source_health(snapshot)

    # Keywords ----------------------------------------------------------
    @router.get(
        "/projects/{project_id}/keywords", response_model=list[KeywordSet]
    )
    async def list_keyword_sets(project_id: UUID) -> list[KeywordSet]:
        await _require_project(store, project_id)
        return list(await store.list_keyword_sets(project_id))

    @router.post(
        "/projects/{project_id}/keywords",
        response_model=KeywordSet,
        status_code=status.HTTP_201_CREATED,
    )
    async def create_keyword_set(
        project_id: UUID, payload: KeywordSetCreateRequest
    ) -> KeywordSet:
        await _require_project(store, project_id)
        existing = await store.list_keyword_sets(project_id)
        next_version = max((ks.version for ks in existing), default=-1) + 1
        keyword_set = KeywordSet(
            id=uuid4(),
            project_id=project_id,
            version=next_version,
            terms=payload.terms,
            synonyms=payload.synonyms,
            languages=payload.languages,
            code_mappings=(),
            approved_by=payload.approved_by,
            approved_at=_utcnow() if payload.approved_by else None,
            created_at=_utcnow(),
        )
        return await store.upsert_keyword_set(keyword_set)

    # Signals + triage --------------------------------------------------
    @router.get("/projects/{project_id}/signals", response_model=list[Signal])
    async def list_signals(
        project_id: UUID,
        kind: SignalKind | None = Query(default=None),
        signal_status: SignalStatus | None = Query(default=None, alias="status"),
        limit: int = Query(default=100, ge=1, le=1000),
    ) -> list[Signal]:
        await _require_project(store, project_id)
        return list(
            await store.list_signals(
                project_id, kind=kind, status=signal_status, limit=limit
            )
        )

    @router.post(
        "/projects/{project_id}/signals",
        response_model=Signal,
        status_code=status.HTTP_201_CREATED,
    )
    async def create_signal(project_id: UUID, payload: SignalCreateRequest) -> Signal:
        await _require_project(store, project_id)
        adr = (
            AdverseEventStatistic.model_validate(payload.adr_stat, strict=False)
            if payload.adr_stat is not None
            else None
        )
        trend = (
            TrendStatistic.model_validate(payload.trend_stat, strict=False)
            if payload.trend_stat is not None
            else None
        )
        cluster = (
            ClusterStatistic.model_validate(payload.cluster_stat, strict=False)
            if payload.cluster_stat is not None
            else None
        )
        signal = Signal(
            id=uuid4(),
            project_id=project_id,
            kind=payload.kind,
            score=payload.score,
            title=payload.title,
            explanation=payload.explanation,
            district=payload.district,
            started_at=payload.started_at,
            detected_at=payload.detected_at or _utcnow(),
            adr_stat=adr,
            trend_stat=trend,
            cluster_stat=cluster,
        )
        return await store.upsert_signal(signal)

    @router.get("/signals/{signal_id}", response_model=Signal)
    async def get_signal(signal_id: UUID) -> Signal:
        return await _require_signal(store, signal_id)

    @router.post("/signals/{signal_id}/triage", response_model=Signal)
    async def triage_signal(signal_id: UUID, payload: TriageRequest) -> Signal:
        await _require_signal(store, signal_id)
        decision = TriageDecision(
            signal_id=signal_id,
            actor=payload.actor,
            decision=payload.decision,
            rationale=payload.rationale,
            decided_at=_utcnow(),
        )
        return await store.record_triage(decision)

    @router.get(
        "/signals/{signal_id}/triage", response_model=list[TriageDecision]
    )
    async def list_triage(signal_id: UUID) -> list[TriageDecision]:
        await _require_signal(store, signal_id)
        return list(await store.list_triage_decisions(signal_id))

    # Regulatory exporters ---------------------------------------------
    @router.get("/signals/{signal_id}/forms/idsp")
    async def export_idsp_form(signal_id: UUID) -> dict[str, Any]:
        signal = await _require_signal(store, signal_id)
        project = await store.get_project(signal.project_id)
        try:
            return build_idsp_p_form(signal, project=project)
        except ExporterError as exc:
            raise HTTPException(status.HTTP_409_CONFLICT, str(exc)) from exc

    @router.get("/signals/{signal_id}/forms/pvpi")
    async def export_pvpi_icsr(signal_id: UUID) -> dict[str, Any]:
        signal = await _require_signal(store, signal_id)
        project = await store.get_project(signal.project_id)
        try:
            return build_pvpi_icsr(signal, project=project)
        except ExporterError as exc:
            raise HTTPException(status.HTTP_409_CONFLICT, str(exc)) from exc

    # Audit chain -------------------------------------------------------
    @router.get("/audit", response_model=list[AuditEntry])
    async def list_audit(
        project_id: UUID | None = Query(default=None),
        signal_id: UUID | None = Query(default=None),
        limit: int = Query(default=200, ge=1, le=2000),
    ) -> list[AuditEntry]:
        return list(
            await store.list_audit(
                project_id=project_id, signal_id=signal_id, limit=limit
            )
        )

    @router.post(
        "/audit",
        response_model=AuditEntry,
        status_code=status.HTTP_201_CREATED,
    )
    async def append_audit(payload: AuditAppendRequest) -> AuditEntry:
        if payload.signal_id is not None:
            await _require_signal(store, payload.signal_id)
        existing = await store.list_audit(limit=2000)
        sequence = len(existing)
        prev_hash = existing[-1].payload_hash if existing else _GENESIS_HASH
        body = dict(payload.payload)
        body.setdefault("action", payload.action)
        body.setdefault("actor", payload.actor)
        if payload.signal_id is not None:
            body.setdefault("signal_id", str(payload.signal_id))
        if payload.mention_id is not None:
            body.setdefault("mention_id", str(payload.mention_id))
        new_hash = _chain_hash(prev_hash, body)
        entry = AuditEntry(
            id=uuid4(),
            sequence=sequence,
            prev_hash=prev_hash,
            payload_hash=new_hash,
            actor=payload.actor,
            action=payload.action,
            signal_id=payload.signal_id,
            mention_id=payload.mention_id,
            payload_summary=payload.payload_summary,
            recorded_at=_utcnow(),
        )
        return await store.append_audit(entry)

    return router


__all__ = ["create_setu_router"]
