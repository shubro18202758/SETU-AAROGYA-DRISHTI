"""Seed the SETU AAROGYA DRISHTI demo dataset against a running backend.

Story
-----
The seeded scenario re-creates an India-specific public-health surveillance
exercise inspired by the **2025 Coldrif diethylene-glycol (DEG) cough-syrup
incident** in Madhya Pradesh, where multiple paediatric patients in
Chhindwara and adjacent districts presented with acute kidney injury (AKI)
after taking a contaminated paracetamol-based syrup. The seeded project
contains:

* one SETU project (``setu-coldrif-mp``)
* six free-tier source connectors (Reddit, YouTube, RSS, Telegram, web forum,
  X replay fixture)
* one approved keyword set covering English, Hindi, Tamil, Telugu, Kannada
  drug + symptom + facility terms
* five surfaceable signals: ADR (PRR/ROR/IC), trend (z-score), and three
  spatial clusters (Poisson grid scan) anchored on Chhindwara, Betul,
  Hoshangabad
* an audit ledger with project bootstrap + per-signal "emit" entries chained
  via BLAKE3 (or BLAKE2b fallback)

Usage
-----
::

    # 1. Start backend (in another terminal)
    cd backend && uvicorn backend.app.main:app --reload --port 8000

    # 2. Seed
    python scripts/seed_setu_demo.py

    # 3. Open the SETU shell
    cd frontend && npm run dev   # then http://localhost:3000/setu

The script is **idempotent**: re-running it skips creation of objects whose
slugs / names already exist.

The seed only depends on httpx (already in backend deps). It writes nothing
to disk — the in-memory backend store holds the demo data until the backend
restarts, mirroring the eventual ArcadeDB swap-in semantics.
"""

from __future__ import annotations

import argparse
import sys
from datetime import datetime, timedelta, timezone
from typing import Any

import httpx

DEFAULT_BACKEND = "http://localhost:8000"
PROJECT_SLUG = "setu-coldrif-mp"


def _utcnow() -> datetime:
    return datetime.now(tz=timezone.utc)


def _iso(dt: datetime) -> str:
    return dt.isoformat()


# ---------------------------------------------------------------------------
# Idempotency helpers
# ---------------------------------------------------------------------------


def _find_project(client: httpx.Client, slug: str) -> dict[str, Any] | None:
    response = client.get("/api/setu/projects")
    response.raise_for_status()
    for project in response.json():
        if project["slug"] == slug:
            return project
    return None


def _existing_source_names(client: httpx.Client, project_id: str) -> set[str]:
    response = client.get(f"/api/setu/projects/{project_id}/sources")
    response.raise_for_status()
    return {source["name"] for source in response.json()}


def _existing_signal_titles(client: httpx.Client, project_id: str) -> set[str]:
    response = client.get(f"/api/setu/projects/{project_id}/signals")
    response.raise_for_status()
    return {signal["title"] for signal in response.json()}


# ---------------------------------------------------------------------------
# Seed payload builders
# ---------------------------------------------------------------------------


def _project_payload() -> dict[str, Any]:
    return {
        "slug": PROJECT_SLUG,
        "name": "Coldrif DEG — Madhya Pradesh AKI Watch",
        "description": (
            "Real-time social listening for the Coldrif diethylene-glycol "
            "contamination incident across Chhindwara, Betul, and adjacent "
            "Madhya Pradesh districts. Tracks paediatric AKI signals across "
            "Reddit, YouTube, RSS health bulletins, Telegram public groups, "
            "Indian regional health forums, and X (replay fixture)."
        ),
        "owner": "drishti-ops@setu.bharat.gov.in",
        "status": "active",
    }


def _source_payloads() -> list[dict[str, Any]]:
    return [
        {
            "name": "Reddit r/india + r/IndianMedical (Coldrif)",
            "connector_type": "reddit",
            "connector_params": {
                "subreddits": ["india", "IndianMedical", "delhi", "indore"],
                "query": "Coldrif OR cough syrup OR DEG OR diethylene glycol",
                "comment_depth": 2,
            },
            "latency_tier": "realtime",
        },
        {
            "name": "YouTube comments — health bulletins",
            "connector_type": "youtube",
            "connector_params": {
                "video_ids": [],
                "channel_handles": ["@aiims_official", "@MoHFW_INDIA"],
                "language_hint": "hi",
            },
            "latency_tier": "daily",
        },
        {
            "name": "RSS — IDSP / state health bulletins",
            "connector_type": "rss",
            "connector_params": {
                "feeds": [
                    "https://idsp.mohfw.gov.in/index.php?option=com_content&view=article&id=406&Itemid=140",
                    "https://www.who.int/india/rss-feeds",
                ],
                "user_agent": "SETU-AarogyaDrishti/0.1 (+contact: ops@setu.bharat.gov.in)",
            },
            "latency_tier": "daily",
        },
        {
            "name": "Telegram — MP health public groups",
            "connector_type": "telegram",
            "connector_params": {
                "channels": ["@mp_health_alerts", "@india_pharmacovig"],
                "history_limit": 200,
            },
            "latency_tier": "realtime",
        },
        {
            "name": "Web forum — India parenting / health",
            "connector_type": "web",
            "connector_params": {
                "seed_urls": [
                    "https://www.indiaparenting.com/forum/",
                    "https://www.medindia.net/forums/",
                ],
                "robots_respect": True,
                "max_pages_per_run": 25,
            },
            "latency_tier": "weekly",
        },
        {
            "name": "X replay fixture — Coldrif demo",
            "connector_type": "x_fixture",
            "connector_params": {
                "fixture_path": "infrastructure/fixtures/x/coldrif_demo.json"
            },
            "latency_tier": "realtime",
        },
    ]


def _keyword_payload() -> dict[str, Any]:
    return {
        "terms": (
            # English
            "coldrif", "cough syrup", "diethylene glycol", "DEG",
            "acute kidney injury", "AKI", "paediatric AKI",
            "paracetamol syrup", "syrup contamination",
            # Hindi (Devanagari)
            "कफ सिरप", "सिरप से मौत", "बच्चों में किडनी फेल",
            "डायथिलीन ग्लाइकोल",
            # Tamil
            "இருமல் சிரப்", "குழந்தைகள் சிறுநீரகம் செயலிழப்பு",
            # Telugu
            "దగ్గు సిరప్", "పిల్లల కిడ్నీ వైఫల్యం",
            # Kannada
            "ಕೆಮ್ಮು ಸಿರಪ್", "ಮಕ್ಕಳ ಮೂತ್ರಪಿಂಡ ವೈಫಲ್ಯ",
        ),
        "synonyms": {
            "coldrif": ("Coldrif syrup", "Coldrif cough syrup", "Coldrif paediatric"),
            "AKI": ("acute renal failure", "ARF", "kidney failure"),
            "DEG": ("diethylene glycol", "ethylene glycol contamination"),
        },
        "languages": ("en", "hi", "ta", "te", "kn"),
        "approved_by": "drishti-ops@setu.bharat.gov.in",
    }


def _signal_payloads() -> list[dict[str, Any]]:
    """Five demo signals: 1 ADR, 1 trend, 3 spatial clusters."""
    now = _utcnow()
    window_start = now - timedelta(days=7)
    window_end = now

    return [
        # --- ADR signal: Coldrif × AKI ---
        {
            "kind": "adr",
            "score": 0.94,
            "title": "ADR: Coldrif × paediatric AKI (PRR=12.4)",
            "explanation": (
                "Disproportionality across the rolling 7-day window: 47 mentions "
                "co-mention Coldrif and acute kidney injury vs. 3.8 expected. "
                "PRR=12.4, ROR=14.1, IC=3.7 (lower bound 2.9, χ²=189). "
                "Above all three thresholds — IDSP P-form draft attached."
            ),
            "district": "Madhya Pradesh (statewide)",
            "started_at": _iso(window_start),
            "detected_at": _iso(now),
            "adr_stat": {
                "drug": "Coldrif",
                "event": "acute kidney injury",
                "observed": 47,
                "expected": 3.8,
                "prr": 12.4,
                "ror": 14.1,
                "ic": 3.7,
                "ic_lower": 2.9,
                "chi_squared": 189.0,
                "window_start": _iso(window_start),
                "window_end": _iso(window_end),
            },
        },
        # --- Trend signal: search-term spike ---
        {
            "kind": "trend",
            "score": 0.88,
            "title": "Trend: 'cough syrup death' z=6.1 (statewide MP)",
            "explanation": (
                "Z-score 6.1 over 28-day baseline (current=312/day, baseline=42/day). "
                "Spike correlates with mainstream news coverage but precedes by ~36h, "
                "consistent with grassroots reporting from affected families."
            ),
            "district": "Madhya Pradesh (statewide)",
            "started_at": _iso(window_start),
            "detected_at": _iso(now),
            "trend_stat": {
                "keyword": "cough syrup death",
                "district": "Madhya Pradesh",
                "z_score": 6.1,
                "baseline": 42.0,
                "current": 312.0,
                "window_start": _iso(window_start),
                "window_end": _iso(window_end),
            },
        },
        # --- Cluster: Chhindwara epicenter ---
        {
            "kind": "cluster",
            "score": 0.96,
            "title": "Cluster: Chhindwara paediatric AKI epicenter",
            "explanation": (
                "Poisson grid scan: 14 paediatric AKI mentions within 50 km radius "
                "of Chhindwara town vs. 2.1 expected. Log-likelihood 18.7, p<0.001. "
                "Recommend immediate IDSP escalation + facility-level chart review."
            ),
            "district": "Chhindwara",
            "started_at": _iso(window_start),
            "detected_at": _iso(now),
            "cluster_stat": {
                "centroid_lat": 22.057,
                "centroid_lon": 78.939,
                "radius_deg": 0.45,
                "population": 2_090_000,
                "observed": 14,
                "expected": 2.1,
                "log_likelihood": 18.7,
                "p_value": 0.0008,
                "window_start": _iso(window_start),
                "window_end": _iso(window_end),
            },
        },
        # --- Cluster: Betul ---
        {
            "kind": "cluster",
            "score": 0.81,
            "title": "Cluster: Betul secondary signal",
            "explanation": (
                "Secondary cluster ~120 km north of Chhindwara. 6 paediatric AKI "
                "mentions vs. 1.4 expected (LL=4.9, p=0.018). Likely common supply "
                "chain — same distributor flagged in Telegram chatter."
            ),
            "district": "Betul",
            "started_at": _iso(window_start),
            "detected_at": _iso(now),
            "cluster_stat": {
                "centroid_lat": 21.901,
                "centroid_lon": 77.901,
                "radius_deg": 0.35,
                "population": 1_575_000,
                "observed": 6,
                "expected": 1.4,
                "log_likelihood": 4.9,
                "p_value": 0.018,
                "window_start": _iso(window_start),
                "window_end": _iso(window_end),
            },
        },
        # --- Cluster: Hoshangabad / Narmadapuram ---
        {
            "kind": "cluster",
            "score": 0.72,
            "title": "Cluster: Narmadapuram (Hoshangabad) low-conf",
            "explanation": (
                "Tertiary low-confidence cluster in Narmadapuram district. 4 "
                "mentions vs. 1.2 expected (LL=2.8, p=0.061). Below significance "
                "but adjacent — flag for analyst review, not auto-escalation."
            ),
            "district": "Narmadapuram",
            "started_at": _iso(window_start),
            "detected_at": _iso(now),
            "cluster_stat": {
                "centroid_lat": 22.751,
                "centroid_lon": 77.731,
                "radius_deg": 0.30,
                "population": 1_240_000,
                "observed": 4,
                "expected": 1.2,
                "log_likelihood": 2.8,
                "p_value": 0.061,
                "window_start": _iso(window_start),
                "window_end": _iso(window_end),
            },
        },
    ]


# ---------------------------------------------------------------------------
# Driver
# ---------------------------------------------------------------------------


def seed(backend_url: str) -> None:
    with httpx.Client(base_url=backend_url, timeout=30.0) as client:
        # 1. project
        project = _find_project(client, PROJECT_SLUG)
        if project is None:
            response = client.post("/api/setu/projects", json=_project_payload())
            response.raise_for_status()
            project = response.json()
            print(f"[+] project created: {project['slug']} ({project['id']})")
        else:
            print(f"[=] project exists: {project['slug']} ({project['id']})")
        project_id = project["id"]

        # 2. sources
        existing_sources = _existing_source_names(client, project_id)
        for source in _source_payloads():
            if source["name"] in existing_sources:
                print(f"[=] source exists: {source['name']}")
                continue
            response = client.post(
                f"/api/setu/projects/{project_id}/sources", json=source
            )
            response.raise_for_status()
            print(f"[+] source created: {source['name']}")

        # 3. keyword set (always append a new version on re-run is allowed,
        #    but skip if v0 already exists to keep the demo deterministic)
        keyword_response = client.get(f"/api/setu/projects/{project_id}/keywords")
        keyword_response.raise_for_status()
        if keyword_response.json():
            print("[=] keyword set already approved (skipping)")
        else:
            response = client.post(
                f"/api/setu/projects/{project_id}/keywords", json=_keyword_payload()
            )
            response.raise_for_status()
            print(f"[+] keyword set v{response.json()['version']} approved")

        # 4. signals
        existing_titles = _existing_signal_titles(client, project_id)
        seeded_signals: list[dict[str, Any]] = []
        for signal in _signal_payloads():
            if signal["title"] in existing_titles:
                print(f"[=] signal exists: {signal['title']}")
                continue
            response = client.post(
                f"/api/setu/projects/{project_id}/signals", json=signal
            )
            response.raise_for_status()
            created = response.json()
            seeded_signals.append(created)
            print(f"[+] signal created [{created['kind']}]: {created['title']}")

        # 5. audit chain — bootstrap + per-signal entries
        audit_response = client.get(
            "/api/setu/audit", params={"project_id": project_id, "limit": 1}
        )
        audit_response.raise_for_status()
        if not audit_response.json():
            client.post(
                "/api/setu/audit",
                json={
                    "actor": "seed-script",
                    "action": "project-bootstrap",
                    "payload_summary": f"seeded project {PROJECT_SLUG}",
                    "payload": {"project_id": project_id, "slug": PROJECT_SLUG},
                },
            ).raise_for_status()
            print("[+] audit: project-bootstrap entry written")

        for created in seeded_signals:
            client.post(
                "/api/setu/audit",
                json={
                    "actor": "seed-script",
                    "action": f"emit-{created['kind']}",
                    "payload_summary": created["title"][:120],
                    "signal_id": created["id"],
                    "payload": {
                        "kind": created["kind"],
                        "score": created["score"],
                        "district": created.get("district"),
                    },
                },
            ).raise_for_status()
            print(f"[+] audit: emit entry for {created['kind']} signal")

        print()
        print("=" * 60)
        print(f"SETU demo project ready at {backend_url}/api/setu/projects")
        print(f"Frontend: http://localhost:3000/setu (select '{project['name']}')")
        print("=" * 60)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Seed the SETU AAROGYA DRISHTI Coldrif demo dataset."
    )
    parser.add_argument(
        "--backend-url",
        default=DEFAULT_BACKEND,
        help=f"Backend base URL (default: {DEFAULT_BACKEND})",
    )
    args = parser.parse_args(argv)
    try:
        seed(args.backend_url)
    except httpx.HTTPError as exc:
        print(f"ERROR: backend request failed: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":  # pragma: no cover
    sys.exit(main())
