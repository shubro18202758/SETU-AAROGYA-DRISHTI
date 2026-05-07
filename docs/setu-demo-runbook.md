# SETU AAROGYA DRISHTI — Demo Runbook (Coldrif MP DEG Cough-Syrup Outbreak)

This runbook walks an evaluator from a clean checkout to a fully-seeded
SETU dashboard reproducing the **Coldrif / Madhya Pradesh Diethylene
Glycol (DEG) cough-syrup AKI cluster** demonstration.

> **Note**: All data in the seed script is synthetic / illustrative. Real
> Coldrif investigations were carried out by CDSCO + state drug controllers
> using authoritative channels.

---

## 0. Prerequisites

- Windows 11 with PowerShell 7 (commands below assume `;` as separator).
  Linux/macOS users substitute `&&`.
- Python 3.12+ on `PATH`.
- Node.js 20+ and npm 10+ on `PATH`.
- Docker Desktop (only required for the optional Redpanda + ArcadeDB
  infra — the demo runs fine with the in-memory store).
- ≥ 8 GB free RAM. No GPU required for the demo (LLMs are mocked at
  this phase; live LLM scoring lands in Phase 8).

---

## 1. Install backend dependencies

```powershell
cd c:\Users\sayan\Downloads\OSINT
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -e backend
```

Verify the SETU test suite passes (10/10):

```powershell
python -m pytest backend/tests/test_setu_api.py -q
```

Expected tail:

```
..........                                                              [100%]
10 passed in ~1s
```

---

## 2. Start the FastAPI backend

```powershell
cd c:\Users\sayan\Downloads\OSINT
.\.venv\Scripts\Activate.ps1
uvicorn backend.app.main:app --reload --port 8000
```

Smoke-check:

```powershell
curl http://localhost:8000/api/setu/projects
# → []
```

---

## 3. Seed the Coldrif MP demo

In a **second** PowerShell window:

```powershell
cd c:\Users\sayan\Downloads\OSINT
.\.venv\Scripts\Activate.ps1
python scripts/seed_setu_demo.py
```

The script is idempotent — re-running it skips already-seeded artefacts.

Expected console output (abbreviated):

```
[setu-seed] backend = http://localhost:8000
[setu-seed] project setu-coldrif-mp ready (id=...)
[setu-seed] + source reddit-india-public
[setu-seed] + source reddit-medicalindia
[setu-seed] + source youtube-health-shorts
[setu-seed] + source idsp-rss
[setu-seed] + source telegram-mp-health
[setu-seed] + source web-parenting-forums
[setu-seed] + source x-fixture-replay
[setu-seed] + keyword set v1 (5 languages)
[setu-seed] + signal ADR Coldrif × Acute Kidney Injury
[setu-seed] + signal Trend spike: cough syrup AKI mentions (MP)
[setu-seed] + signal Cluster: Chhindwara pediatric AKI
[setu-seed] + signal Cluster: Betul pediatric AKI
[setu-seed] + signal Cluster: Narmadapuram pediatric AKI
[setu-seed] + audit chain bootstrapped (6 entries)
[setu-seed] done.
```

If the second run is invoked, expect `= source ...` / `= signal ...`
(skipped) instead of `+`.

Verify via API:

```powershell
curl http://localhost:8000/api/setu/projects
curl http://localhost:8000/api/setu/audit?limit=10
```

The first audit entry must show `prev_hash = "0000...0000"` (64 zeros);
each subsequent entry's `prev_hash` must equal the previous entry's
`payload_hash`.

---

## 4. Start the frontend

In a **third** PowerShell window:

```powershell
cd c:\Users\sayan\Downloads\OSINT\frontend
npm install        # only first time
npm run dev
```

Open <http://localhost:3000/setu> in a browser.

---

## 5. Demo walkthrough (≈ 8 minutes)

| # | Page | Talking points |
|---|---|---|
| 1 | `/setu` | Landing tiles: 1 active project, 7 sources (6 enabled + 1 fixture), 5 signals, ledger length. Click into the project. |
| 2 | `/setu/projects/setu-coldrif-mp` | Show owner, status, slug, keyword-set version v1 (en/hi/ta/te/kn). Highlight that approval (`approved_by`) is required before workers consume the version. |
| 3 | `/setu/triage` | Five signals listed by score. Open the **Cluster: Chhindwara** signal → `cluster_stat` shows `observed=14, expected=2.1, log_likelihood=18.7, p≈0.0008`. Click **Confirm** → POST `/triage` → status flips to `confirmed`, audit ledger gains an entry. |
| 4 | `/setu/sources` | All 7 sources rendered with last health snapshot. Latency tier and connector type per row. |
| 5 | `/setu/audit` | Every row shows **VALID** badge (BLAKE3/BLAKE2b chain recomputed in browser). Tamper-test: in DevTools Network panel, replay an audit POST with a swapped `prev_hash` → row turns **BROKEN** with a red badge. |
| 6 | `/setu/map` | Three cluster pins (Chhindwara, Betul, Narmadapuram) — placeholder cards in this phase; Phase 8 swaps in MapLibre. |

---

## 6. Tear-down

- **Backend store** is in-memory: stop `uvicorn` (Ctrl-C) and all data
  vanishes. Re-seed by repeating step 3.
- **Frontend**: Ctrl-C in the `npm run dev` terminal.
- **Optional infra** (`docker-compose down -v`) is only needed if you
  brought up Redpanda/ArcadeDB; the demo as scripted does not require it.

---

## 7. Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `ConnectError` from seed script | Backend not started yet | Start `uvicorn` (step 2) |
| `409` on second seed run | Idempotency check failed; project already exists with different shape | Stop backend (memory wipe) and re-seed |
| Frontend shows "Failed to fetch" on `/setu` | Wrong backend port | The edge proxy targets `http://127.0.0.1:8000` by default. Override with `BACKEND_BASE_URL` env var when starting `npm run dev` |
| Audit row shows **BROKEN** unexpectedly | A direct DB write bypassed the API | All writes must go through `POST /api/setu/audit`; never persist `AuditEntry` rows manually |
| `pytest` fails with `ImportError: blake3` | `blake3` is optional | The code falls back to `hashlib.blake2b(digest_size=32)` automatically; no action needed |

---

## 8. What this demo deliberately does **not** prove

- Live multilingual NER + drug/symptom linking (mocked seed data).
- True PRR/ROR/IC computation from raw mentions (statistics here are
  precomputed — the worker pipeline that derives them from streamed
  mentions lands in Phase 8).
- IDSP P-form / PvPI ICSR JSON exporters (Phase 8).
- ArcadeDB-backed durability (in-memory store today; swap-in lands in Phase 8).
- Real Leaflet/MapLibre map (placeholder cards today).

See [docs/setu-architecture.md](setu-architecture.md) §6 and
[`/memories/session/plan.md`](../../memories/session/plan.md) Phase 8 for
the deferred work list.
