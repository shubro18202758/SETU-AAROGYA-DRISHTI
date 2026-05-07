"""Tests for the SETU FastAPI router (in-memory store)."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from uuid import uuid4

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from backend.app.schemas.health import (
    AdverseEventStatistic,
    AuditEntry,
    CodeMapping,
    Signal,
)
from backend.app.setu import InMemorySetuStore, create_setu_router


def _build_app() -> tuple[FastAPI, InMemorySetuStore]:
    store = InMemorySetuStore()
    app = FastAPI()
    app.include_router(create_setu_router(store))
    return app, store


def _utcnow() -> datetime:
    return datetime.now(tz=timezone.utc)


# ---------------------------------------------------------------------------
# Project lifecycle
# ---------------------------------------------------------------------------


def test_project_lifecycle_create_get_patch_delete() -> None:
    app, _ = _build_app()
    client = TestClient(app)

    # initially empty
    response = client.get("/api/setu/projects")
    assert response.status_code == 200
    assert response.json() == []

    # create
    payload = {
        "slug": "setu-coldrif",
        "name": "Coldrif Surveillance",
        "description": "Track Coldrif-related ADRs across Kerala.",
        "owner": "ops@setu.test",
    }
    create_response = client.post("/api/setu/projects", json=payload)
    assert create_response.status_code == 201, create_response.text
    project = create_response.json()
    assert project["slug"] == "setu-coldrif"
    assert project["status"] == "active"
    project_id = project["id"]

    # duplicate slug rejected
    dup_response = client.post("/api/setu/projects", json=payload)
    assert dup_response.status_code == 409

    # get
    get_response = client.get(f"/api/setu/projects/{project_id}")
    assert get_response.status_code == 200
    assert get_response.json()["id"] == project_id

    # patch
    patch_response = client.patch(
        f"/api/setu/projects/{project_id}",
        json={"status": "paused", "name": "Coldrif Watch"},
    )
    assert patch_response.status_code == 200
    patched = patch_response.json()
    assert patched["status"] == "paused"
    assert patched["name"] == "Coldrif Watch"

    # delete
    delete_response = client.delete(f"/api/setu/projects/{project_id}")
    assert delete_response.status_code == 204
    assert client.get(f"/api/setu/projects/{project_id}").status_code == 404


def test_project_unknown_returns_404() -> None:
    app, _ = _build_app()
    client = TestClient(app)
    missing = uuid4()
    assert client.get(f"/api/setu/projects/{missing}").status_code == 404
    assert client.delete(f"/api/setu/projects/{missing}").status_code == 404


# ---------------------------------------------------------------------------
# Sources + health
# ---------------------------------------------------------------------------


def _create_project(client: TestClient, slug: str = "p1") -> str:
    response = client.post(
        "/api/setu/projects",
        json={
            "slug": slug,
            "name": "P",
            "description": "d",
            "owner": "o@x.test",
        },
    )
    assert response.status_code == 201, response.text
    return response.json()["id"]


def test_source_create_list_health_delete() -> None:
    app, _ = _build_app()
    client = TestClient(app)
    project_id = _create_project(client)

    create = client.post(
        f"/api/setu/projects/{project_id}/sources",
        json={
            "name": "Coldrif Subreddit",
            "connector_type": "reddit",
            "connector_params": {"subreddits": ["india"]},
            "latency_tier": "daily",
        },
    )
    assert create.status_code == 201, create.text
    source = create.json()
    assert source["connector_type"] == "reddit"

    listed = client.get(f"/api/setu/projects/{project_id}/sources").json()
    assert len(listed) == 1 and listed[0]["id"] == source["id"]

    health_response = client.put(
        f"/api/setu/projects/{project_id}/sources/{source['id']}/health",
        json={"health_score": 0.8, "uptime_ratio": 0.95, "error_rate": 0.05},
    )
    assert health_response.status_code == 200
    snapshot = health_response.json()
    assert snapshot["health_score"] == 0.8

    delete = client.delete(
        f"/api/setu/projects/{project_id}/sources/{source['id']}"
    )
    assert delete.status_code == 204
    assert client.get(f"/api/setu/projects/{project_id}/sources").json() == []


def test_source_create_unknown_project_404() -> None:
    app, _ = _build_app()
    client = TestClient(app)
    response = client.post(
        f"/api/setu/projects/{uuid4()}/sources",
        json={"name": "X", "connector_type": "rss"},
    )
    assert response.status_code == 404


# ---------------------------------------------------------------------------
# Keyword sets versioning
# ---------------------------------------------------------------------------


def test_keyword_set_versioning_increments() -> None:
    app, _ = _build_app()
    client = TestClient(app)
    project_id = _create_project(client)

    first = client.post(
        f"/api/setu/projects/{project_id}/keywords",
        json={"terms": ["coldrif", "aki"]},
    ).json()
    second = client.post(
        f"/api/setu/projects/{project_id}/keywords",
        json={"terms": ["coldrif", "aki", "kidney injury"]},
    ).json()
    assert first["version"] == 0
    assert second["version"] == 1

    listed = client.get(f"/api/setu/projects/{project_id}/keywords").json()
    assert {entry["version"] for entry in listed} == {0, 1}


# ---------------------------------------------------------------------------
# Signals + triage
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_signal_listing_and_triage_flow() -> None:
    app, store = _build_app()
    client = TestClient(app)
    project_id_str = _create_project(client)
    from uuid import UUID as _UUID

    project_id = _UUID(project_id_str)
    now = _utcnow()
    adr_stat = AdverseEventStatistic(
        drug="coldrif",
        event="aki",
        observed=12,
        expected=2.0,
        prr=4.5,
        ror=5.0,
        ic=2.1,
        ic_lower=1.4,
        chi_squared=18.2,
        window_start=now - timedelta(days=1),
        window_end=now,
    )
    signal = Signal(
        id=uuid4(),
        project_id=project_id,
        kind="adr",
        score=0.92,
        title="Coldrif → AKI surge",
        explanation="PRR/ROR/IC all above thresholds in Palakkad cluster.",
        evidence_mention_ids=(uuid4(),),
        codes=(
            CodeMapping(
                surface="coldrif",
                code_system="WHO-DRUG",
                code="W-COLDRIF-001",
                display_name="Coldrif Cough Syrup",
            ),
        ),
        district="palakkad",
        started_at=now - timedelta(days=1),
        detected_at=now,
        adr_stat=adr_stat,
    )
    await store.upsert_signal(signal)

    # list
    listing = client.get(f"/api/setu/projects/{project_id}/signals").json()
    assert len(listing) == 1 and listing[0]["id"] == str(signal.id)

    # filter by kind
    other = client.get(
        f"/api/setu/projects/{project_id}/signals", params={"kind": "trend"}
    ).json()
    assert other == []

    # triage confirm
    triage_response = client.post(
        f"/api/setu/signals/{signal.id}/triage",
        json={
            "actor": "analyst@setu.test",
            "decision": "confirm",
            "rationale": "Cluster verified against state line list.",
        },
    )
    assert triage_response.status_code == 200, triage_response.text
    confirmed = triage_response.json()
    assert confirmed["status"] == "confirmed"
    assert confirmed["assignee"] == "analyst@setu.test"

    # triage history
    history = client.get(f"/api/setu/signals/{signal.id}/triage").json()
    assert len(history) == 1 and history[0]["decision"] == "confirm"


def test_triage_unknown_signal_404() -> None:
    app, _ = _build_app()
    client = TestClient(app)
    response = client.post(
        f"/api/setu/signals/{uuid4()}/triage",
        json={"actor": "a", "decision": "confirm"},
    )
    assert response.status_code == 404


# ---------------------------------------------------------------------------
# Audit chain endpoint
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_audit_listing_filters_by_signal() -> None:
    app, store = _build_app()
    client = TestClient(app)
    signal_id = uuid4()
    other_id = uuid4()
    now = _utcnow()
    entries = [
        AuditEntry(
            id=uuid4(),
            sequence=0,
            prev_hash="0" * 64,
            payload_hash="a" * 64,
            actor="setu-signals-worker",
            action="emit-adr",
            signal_id=signal_id,
            mention_id=None,
            payload_summary="adr emitted",
            recorded_at=now,
        ),
        AuditEntry(
            id=uuid4(),
            sequence=1,
            prev_hash="a" * 64,
            payload_hash="b" * 64,
            actor="setu-signals-worker",
            action="emit-trend",
            signal_id=other_id,
            mention_id=None,
            payload_summary="trend emitted",
            recorded_at=now,
        ),
    ]
    for entry in entries:
        await store.append_audit(entry)

    all_entries = client.get("/api/setu/audit").json()
    assert len(all_entries) == 2

    filtered = client.get("/api/setu/audit", params={"signal_id": str(signal_id)}).json()
    assert len(filtered) == 1 and filtered[0]["signal_id"] == str(signal_id)


# ---------------------------------------------------------------------------
# Signal create + audit append (seed-friendly endpoints)
# ---------------------------------------------------------------------------


def test_create_signal_endpoint_persists_cluster_stat() -> None:
    app, _ = _build_app()
    client = TestClient(app)
    project = client.post(
        "/api/setu/projects",
        json={
            "slug": "setu-mp",
            "name": "MP Cough Syrup",
            "description": "Madhya Pradesh paediatric ADR cluster watch.",
            "owner": "ops@setu.test",
        },
    ).json()
    started = (_utcnow() - timedelta(hours=12)).isoformat()
    payload = {
        "kind": "cluster",
        "score": 0.92,
        "title": "Paediatric AKI cluster — Chhindwara",
        "explanation": "Spatial cluster of paediatric AKI mentions co-occurring with Coldrif syrup.",
        "district": "Chhindwara",
        "started_at": started,
        "cluster_stat": {
            "centroid_lat": 22.057,
            "centroid_lon": 78.939,
            "radius_deg": 0.45,
            "population": 2_090_000,
            "observed": 14,
            "expected": 2.1,
            "log_likelihood": 18.7,
            "p_value": 0.0008,
            "window_start": started,
            "window_end": _utcnow().isoformat(),
        },
    }
    response = client.post(f"/api/setu/projects/{project['id']}/signals", json=payload)
    assert response.status_code == 201, response.text
    body = response.json()
    assert body["kind"] == "cluster"
    assert body["status"] == "new"
    assert body["cluster_stat"]["observed"] == 14
    assert body["district"] == "Chhindwara"


def test_append_audit_endpoint_chains_blake3_hashes() -> None:
    app, _ = _build_app()
    client = TestClient(app)
    first = client.post(
        "/api/setu/audit",
        json={
            "actor": "seed",
            "action": "project-bootstrap",
            "payload_summary": "seeded coldrif project",
            "payload": {"slug": "setu-mp"},
        },
    )
    assert first.status_code == 201, first.text
    e1 = first.json()
    assert e1["sequence"] == 0
    assert e1["prev_hash"] == "0" * 64
    assert e1["payload_hash"] != e1["prev_hash"]

    second = client.post(
        "/api/setu/audit",
        json={
            "actor": "seed",
            "action": "signal-emitted",
            "payload_summary": "cluster signal — Chhindwara",
            "payload": {"district": "Chhindwara", "score": 0.92},
        },
    )
    assert second.status_code == 201, second.text
    e2 = second.json()
    assert e2["sequence"] == 1
    assert e2["prev_hash"] == e1["payload_hash"]
    assert e2["payload_hash"] != e2["prev_hash"]



# ---------------------------------------------------------------------------
# Regulatory exporter endpoints (IDSP P-form + PvPI ICSR)
# ---------------------------------------------------------------------------


def _create_cluster_signal(client: TestClient) -> tuple[str, str]:
    project = client.post(
        "/api/setu/projects",
        json={
            "slug": "setu-mp-forms",
            "name": "MP Forms",
            "description": "Form export tests.",
            "owner": "ops@setu.test",
        },
    ).json()
    started = (_utcnow() - timedelta(hours=12)).isoformat()
    sig = client.post(
        f"/api/setu/projects/{project['id']}/signals",
        json={
            "kind": "cluster",
            "score": 0.92,
            "title": "Paediatric AKI cluster — Chhindwara",
            "explanation": "Spatial cluster of paediatric AKI mentions.",
            "district": "Chhindwara",
            "started_at": started,
            "cluster_stat": {
                "centroid_lat": 22.057,
                "centroid_lon": 78.939,
                "radius_deg": 0.45,
                "population": 2_090_000,
                "observed": 14,
                "expected": 2.1,
                "log_likelihood": 18.7,
                "p_value": 0.0008,
                "window_start": started,
                "window_end": _utcnow().isoformat(),
            },
        },
    ).json()
    return project["id"], sig["id"]


def test_export_idsp_form_endpoint_returns_form_for_cluster_signal() -> None:
    app, _ = _build_app()
    client = TestClient(app)
    _, signal_id = _create_cluster_signal(client)

    response = client.get(f"/api/setu/signals/{signal_id}/forms/idsp")
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["form_type"] == "IDSP-P"
    assert body["outbreak"]["district"] == "Chhindwara"
    assert body["statistics"]["cluster"]["observed"] == 14
    assert body["header"]["project_slug"] == "setu-mp-forms"


def test_export_pvpi_endpoint_rejects_cluster_signal_with_409() -> None:
    app, _ = _build_app()
    client = TestClient(app)
    _, signal_id = _create_cluster_signal(client)

    response = client.get(f"/api/setu/signals/{signal_id}/forms/pvpi")
    assert response.status_code == 409
    assert "ADR signal" in response.json()["detail"]


def test_export_pvpi_endpoint_returns_form_for_adr_signal() -> None:
    app, _ = _build_app()
    client = TestClient(app)
    project = client.post(
        "/api/setu/projects",
        json={
            "slug": "setu-pvpi",
            "name": "PvPI",
            "description": "PvPI export tests.",
            "owner": "ops@setu.test",
        },
    ).json()
    started = (_utcnow() - timedelta(days=7)).isoformat()
    sig = client.post(
        f"/api/setu/projects/{project['id']}/signals",
        json={
            "kind": "adr",
            "score": 0.85,
            "title": "Coldrif ↔ AKI disproportionality",
            "explanation": "PRR/IC025 elevated for coldrif/AKI.",
            "district": "Chhindwara",
            "started_at": started,
            "adr_stat": {
                "drug": "coldrif",
                "event": "acute kidney injury",
                "observed": 14,
                "expected": 1.8,
                "prr": 7.8,
                "ror": 8.4,
                "ic": 2.6,
                "ic_lower": 1.9,
                "chi_squared": 42.5,
                "window_start": started,
                "window_end": _utcnow().isoformat(),
            },
        },
    ).json()

    response = client.get(f"/api/setu/signals/{sig['id']}/forms/pvpi")
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["form_type"] == "PvPI-ICSR"
    assert body["safetyreportid"] == f"SETU-{sig['id']}"
    assert body["serious"] == "1"
    assert body["statistics"]["prr"] == 7.8
    assert body["header"]["project_slug"] == "setu-pvpi"


def test_export_form_endpoints_404_on_unknown_signal() -> None:
    app, _ = _build_app()
    client = TestClient(app)
    missing = uuid4()
    assert client.get(f"/api/setu/signals/{missing}/forms/idsp").status_code == 404
    assert client.get(f"/api/setu/signals/{missing}/forms/pvpi").status_code == 404
