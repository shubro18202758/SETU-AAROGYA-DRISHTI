"""Development seed data for the SETU AAROGYA DRISHTI store.

The seed runs only for the local dev entrypoint. It creates real records in the
SETU store so the UI can exercise the project/source/signal/audit APIs without
hard-coded dashboard numbers.
"""

from __future__ import annotations

import hashlib
import json
from datetime import datetime, timedelta, timezone
from typing import Any
from uuid import NAMESPACE_URL, UUID, uuid5

from backend.app.schemas.health import (
    AdverseEventStatistic,
    AuditEntry,
    ClusterStatistic,
    CodeMapping,
    KeywordSet,
    Project,
    Signal,
    SourceConfig,
    SourceHealthSnapshot,
    TrendStatistic,
)

from .store import SetuStore


_GENESIS_HASH = "0" * 64


def _id(name: str) -> UUID:
    return uuid5(NAMESPACE_URL, f"setu-aarogya-drishti-dev:{name}")


def _utcnow() -> datetime:
    return datetime.now(tz=timezone.utc)


def _chain_hash(prev_hash: str, payload: dict[str, Any]) -> str:
    body = json.dumps(payload, sort_keys=True, separators=(",", ":"), default=str).encode("utf-8")
    return hashlib.blake2b(prev_hash.encode("ascii") + b"|" + body, digest_size=32).hexdigest()


async def seed_dev_setu_store(store: SetuStore) -> None:
    """Populate an empty SETU store with a small operational pilot dataset."""

    if await store.list_projects():
        return

    now = _utcnow()
    window_start = now - timedelta(days=7)
    window_end = now

    fever = CodeMapping(surface="fever", code_system="SNOMED-CT", code="386661006", display_name="Fever")
    rash = CodeMapping(surface="rash", code_system="MedDRA", code="10037844", display_name="Rash")
    vaccine = CodeMapping(surface="vaccine", code_system="WHO-DRUG", code="VACCINE", display_name="Vaccine product mention")
    dizziness = CodeMapping(surface="dizziness", code_system="SNOMED-CT", code="404640003", display_name="Dizziness")

    sources = (
        SourceConfig(
            id=_id("source-idsp-rss"),
            project_id=_id("project-pilot"),
            name="IDSP public bulletin RSS",
            connector_type="rss",
            connector_params={"feed_urls": ["https://example.local/idsp/public-bulletins.xml"]},
            latency_tier="daily",
            enabled=True,
            health_score=0.97,
            last_success_at=now - timedelta(minutes=21),
            created_at=now - timedelta(days=10),
        ),
        SourceConfig(
            id=_id("source-pvpi-web"),
            project_id=_id("project-pilot"),
            name="PvPI safety watch intake",
            connector_type="web",
            connector_params={"scope": "adverse-event-public-pages"},
            latency_tier="daily",
            enabled=True,
            health_score=0.94,
            last_success_at=now - timedelta(minutes=34),
            created_at=now - timedelta(days=9),
        ),
        SourceConfig(
            id=_id("source-community"),
            project_id=_id("project-pilot"),
            name="Regional community posts",
            connector_type="reddit",
            connector_params={"queries": ["fever rash vaccine", "hospital admission dizziness"]},
            latency_tier="realtime",
            enabled=True,
            health_score=0.91,
            last_success_at=now - timedelta(minutes=8),
            created_at=now - timedelta(days=8),
        ),
        SourceConfig(
            id=_id("source-news"),
            project_id=_id("project-pilot"),
            name="District news monitor",
            connector_type="web",
            connector_params={"queries": ["public health fever cluster", "medicine side effect"]},
            latency_tier="realtime",
            enabled=True,
            health_score=0.89,
            last_success_at=now - timedelta(minutes=13),
            created_at=now - timedelta(days=8),
        ),
    )

    keyword_set = KeywordSet(
        id=_id("keyword-set-pilot"),
        project_id=_id("project-pilot"),
        version=1,
        terms=("fever", "rash", "dizziness", "vaccine reaction", "hospital admission", "medicine side effect"),
        synonyms={
            "fever": ("high temperature", "bukhar"),
            "rash": ("skin eruption", "daane"),
            "dizziness": ("chakkar", "vertigo"),
        },
        languages=("en", "hi", "ta", "te", "kn"),
        code_mappings=(fever, rash, vaccine, dizziness),
        approved_by="public-health-ops",
        approved_at=now - timedelta(days=6),
        created_at=now - timedelta(days=7),
    )

    project = Project(
        id=_id("project-pilot"),
        slug="maharashtra-safety-pilot",
        name="Maharashtra Patient Safety Pilot",
        description="Multilingual public-health social listening for adverse event, misinformation, trend, and district-cluster signals.",
        owner="SETU Public Health Cell",
        status="active",
        keyword_set_id=keyword_set.id,
        source_ids=tuple(source.id for source in sources),
        created_at=now - timedelta(days=10),
        updated_at=now - timedelta(minutes=8),
    )

    signals = (
        Signal(
            id=_id("signal-adr-fever-rash"),
            project_id=project.id,
            kind="adr",
            score=0.88,
            title="Fever and rash reports above expected baseline",
            explanation="ADR disproportionality detector found elevated fever+rash co-mentions against the seven-day baseline. PRR/ROR/IC all clear the review threshold and require clinical triage before escalation.",
            codes=(fever, rash, vaccine),
            district="Pune",
            started_at=window_start,
            detected_at=now - timedelta(minutes=18),
            status="new",
            adr_stat=AdverseEventStatistic(
                drug="vaccine product mention",
                event="fever with rash",
                observed=42,
                expected=17.6,
                prr=2.41,
                ror=2.86,
                ic=1.29,
                ic_lower=0.74,
                chi_squared=9.8,
                window_start=window_start,
                window_end=window_end,
            ),
        ),
        Signal(
            id=_id("signal-trend-dizziness"),
            project_id=project.id,
            kind="trend",
            score=0.76,
            title="Dizziness mentions rising in community channels",
            explanation="Keyword trend monitor detected a z-score spike for dizziness-related terms after language normalization across English and Hindi posts.",
            codes=(dizziness,),
            district="Nagpur",
            started_at=window_start,
            detected_at=now - timedelta(minutes=43),
            status="more_data",
            trend_stat=TrendStatistic(
                keyword="dizziness",
                district="Nagpur",
                z_score=3.4,
                baseline=11.2,
                current=31.0,
                window_start=window_start,
                window_end=window_end,
            ),
        ),
        Signal(
            id=_id("signal-cluster-pune"),
            project_id=project.id,
            kind="cluster",
            score=0.82,
            title="Spatial cluster near Pune urban corridor",
            explanation="Poisson grid scan detected a compact district-level cluster with observed reports materially above population-adjusted expectation.",
            codes=(fever, rash),
            district="Pune",
            started_at=window_start,
            detected_at=now - timedelta(minutes=31),
            status="triaged",
            cluster_stat=ClusterStatistic(
                centroid_lat=18.5204,
                centroid_lon=73.8567,
                radius_deg=0.34,
                population=6800000,
                observed=58,
                expected=22.4,
                log_likelihood=17.9,
                p_value=0.006,
                window_start=window_start,
                window_end=window_end,
            ),
        ),
        Signal(
            id=_id("signal-misinfo-remedy"),
            project_id=project.id,
            kind="misinformation",
            score=0.69,
            title="Unverified home-remedy claim circulating with symptom posts",
            explanation="Misinformation classifier flagged repeated claims advising unverified treatment instead of clinical care. Analyst review is required before public communication tagging.",
            codes=(fever,),
            district="Mumbai Suburban",
            started_at=window_start,
            detected_at=now - timedelta(hours=2),
            status="new",
        ),
    )

    await store.upsert_project(project)
    await store.upsert_keyword_set(keyword_set)
    for source in sources:
        await store.upsert_source(source)
        await store.upsert_source_health(
            SourceHealthSnapshot(
                source_config_id=source.id,
                health_score=source.health_score,
                uptime_ratio=max(0.0, source.health_score - 0.02),
                error_rate=round(1.0 - source.health_score, 2),
                last_success_at=source.last_success_at,
                throughput_per_min=12.0 if source.latency_tier == "realtime" else 2.5,
                snapshot_at=now,
            )
        )
    for signal in signals:
        await store.upsert_signal(signal)

    prev_hash = _GENESIS_HASH
    for sequence, (action, actor, signal_id, summary) in enumerate(
        (
            ("seed_project", "dev-bootstrap", None, "Created Maharashtra patient safety pilot"),
            ("source_health_snapshot", "connector-monitor", None, "Recorded connector health snapshots"),
            ("signal_detected", "signal-engine", signals[0].id, "ADR signal crossed triage threshold"),
            ("signal_detected", "cluster-engine", signals[2].id, "District cluster queued for review"),
        )
    ):
        payload = {"action": action, "actor": actor, "signal_id": str(signal_id) if signal_id else None, "summary": summary}
        payload_hash = _chain_hash(prev_hash, payload)
        await store.append_audit(
            AuditEntry(
                id=_id(f"audit-{sequence}"),
                sequence=sequence,
                prev_hash=prev_hash,
                payload_hash=payload_hash,
                actor=actor,
                action=action,
                signal_id=signal_id,
                mention_id=None,
                payload_summary=summary,
                recorded_at=now - timedelta(minutes=50 - sequence * 9),
            )
        )
        prev_hash = payload_hash


__all__ = ["seed_dev_setu_store"]