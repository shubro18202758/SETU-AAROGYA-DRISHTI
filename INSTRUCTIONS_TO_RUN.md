# 🚀 SETU AAROGYA DRISHTI — Instructions to Run

> Complete step-by-step guide for reviewers, judges, and contributors to get the full
> SETU AAROGYA DRISHTI health-intelligence platform running locally from scratch.

---

## Table of Contents

1. [System Requirements](#1-system-requirements)
2. [Repository Setup](#2-repository-setup)
3. [Environment Configuration](#3-environment-configuration)
4. [Preflight Check](#4-preflight-check)
5. [Path A — Full Docker Stack (Recommended)](#5-path-a--full-docker-stack-recommended)
6. [Path B — Local Dev Mode (No Docker)](#6-path-b--local-dev-mode-no-docker)
7. [Verifying Every Service](#7-verifying-every-service)
8. [Kafka Topics Bootstrap](#8-kafka-topics-bootstrap)
9. [Running the Test Suite](#9-running-the-test-suite)
10. [API Quick Tour with cURL](#10-api-quick-tour-with-curl)
11. [Operator Console (Frontend)](#11-operator-console-frontend)
12. [Sending a Live Signal (End-to-End Demo)](#12-sending-a-live-signal-end-to-end-demo)
13. [Stopping & Cleaning Up](#13-stopping--cleaning-up)
14. [Troubleshooting Reference](#14-troubleshooting-reference)

---

## 1. System Requirements

### Mandatory

| Component | Minimum | Recommended |
|---|---|---|
| **OS** | Linux (Ubuntu 22.04+), macOS 14+, Windows 11 (WSL2) | Ubuntu 22.04 LTS |
| **CPU** | 6 cores | 12+ cores |
| **RAM** | 16 GB | 32 GB |
| **Disk** | 30 GB free | 60 GB SSD |
| **Docker** | 25.x + Compose v2.24+ | Latest |
| **Python** | 3.12+ | 3.12.x |
| **Node.js** | 20 LTS | 22 LTS |

### For LLM Inference (Qwen3.5-4B via TGI)

| Component | Minimum | Notes |
|---|---|---|
| **NVIDIA GPU** | 8 GB VRAM (RTX 3060 / T4) | 4-bit NF4 quantization active |
| **CUDA** | 12.1+ | |
| **nvidia-container-toolkit** | Latest | Required for GPU passthrough to Docker |

> **No GPU?** The LLM container will not start. You can still run the SETU REST API,
> graph, frontend, and Kafka pipeline by commenting out the `llm:` service in
> `docker-compose.yml` and setting `LLM_BASE_URL` to any OpenAI-compatible endpoint
> (e.g., Ollama, OpenAI, Azure OpenAI).

### Verify GPU access

```bash
# Linux / WSL2
nvidia-smi
docker run --rm --gpus all nvidia/cuda:12.6.3-base-ubuntu24.04 nvidia-smi
```

```powershell
# Windows PowerShell (if using Docker Desktop with WSL2 backend)
nvidia-smi
docker run --rm --gpus all nvidia/cuda:12.6.3-base-ubuntu24.04 nvidia-smi
```

---

## 2. Repository Setup

### Clone from GitHub

```bash
git clone https://github.com/shubro18202758/SETU-AAROGYA-DRISHTI.git
cd SETU-AAROGYA-DRISHTI
```

### Or extract from the provided ZIP

```bash
unzip SETU-AAROGYA-DRISHTI-source.zip -d SETU-AAROGYA-DRISHTI
cd SETU-AAROGYA-DRISHTI
```

---

## 3. Environment Configuration

### Step 1 — Copy the example env file

```bash
# Linux / macOS / WSL2
cp .env.example .env

# Windows PowerShell
Copy-Item .env.example .env
```

### Step 2 — Edit `.env`

Open `.env` in any text editor and fill in the values:

```dotenv
# ── Required ─────────────────────────────────────────────────────────────────

# ArcadeDB admin password (used for the graph database)
# Must match what the container is started with — default is fine for local dev
ARCADEDB_ROOT_PASSWORD=change-me-local-only

# HuggingFace Hub token — needed to download Qwen/Qwen3.5-4B on first boot
# Get yours at https://huggingface.co/settings/tokens
HUGGING_FACE_HUB_TOKEN=hf_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx

# ── Optional — connector credentials ─────────────────────────────────────────

# Reddit API (for Reddit ingestion connector)
# Create an app at https://www.reddit.com/prefs/apps
REDDIT_CLIENT_ID=
REDDIT_CLIENT_SECRET=

# YouTube cookies file path (for authenticated YouTube scraping)
YOUTUBE_COOKIES_PATH=

# Telegram MTProto credentials (for Telegram channel monitoring)
# Get from https://my.telegram.org/apps
TELEGRAM_API_ID=
TELEGRAM_API_HASH=

# GPU visibility — leave as "all" unless you have multiple GPUs
NVIDIA_VISIBLE_DEVICES=all
```

> **Minimum viable config**: You only _need_ `HUGGING_FACE_HUB_TOKEN` and
> `ARCADEDB_ROOT_PASSWORD` to run the full stack. All connector credentials are
> optional — connectors silently disable themselves when credentials are absent.

---

## 4. Preflight Check

Run the bundled preflight script to validate your environment **before** starting
any containers:

```bash
# Linux / macOS / WSL2
chmod +x scripts/preflight.sh
./scripts/preflight.sh
```

```powershell
# Windows PowerShell
.\scripts\preflight.ps1
```

**What it checks:**
- Docker daemon is running
- `docker compose` config is valid (no YAML errors)
- NVIDIA GPU is visible inside a test container

A clean run looks like:

```
Checking Docker...
Checking Compose file...
Checking NVIDIA GPU visibility...
+-----------------------------------------------------------------------------+
| NVIDIA-SMI 560.35   Driver Version: 560.35   CUDA Version: 12.6            |
+-------------------+----------------------+----------------------------------+
| GPU  Name         | Persistence-M        | Bus-Id          ...              |
```

---

## 5. Path A — Full Docker Stack (Recommended)

This is the **one-command approach**. Everything — Redpanda, ArcadeDB, TGI LLM,
backend API, all workers, and the Next.js frontend — runs in Docker containers.

### Step 1 — Pull base images

```bash
docker compose pull redpanda arcadedb
```

### Step 2 — Build application images

```bash
docker compose --profile app build
```

> First build takes ~5–8 minutes (Python + Node.js layer caching).
> Subsequent builds are incremental and fast.

### Step 3 — Start infrastructure services first

```bash
docker compose up redpanda arcadedb -d
```

Wait for healthy status (~30 seconds):

```bash
docker compose ps
```

Both services should show `(healthy)` before continuing.

### Step 4 — Start the LLM container

> ⚠️ This step downloads Qwen/Qwen3.5-4B (~2.5 GB) on **first run only**.
> Ensure your `HUGGING_FACE_HUB_TOKEN` is set in `.env`.

```bash
docker compose up llm -d
```

Monitor the download and model load:

```bash
docker compose logs -f llm
```

The LLM is ready when you see:
```
{"message":"Connected"}
```
or the health check passes (`(healthy)` in `docker compose ps`).
This typically takes **3–5 minutes** on first run, ~60 seconds on restart.

### Step 5 — Start the full application stack

```bash
docker compose --profile app up -d
```

This starts:
- `osint-backend` — FastAPI on port `8000`
- `osint-ingest-worker` — OSINT ingestion pipeline
- `osint-enrich-worker` — LLM extraction / entity enrichment
- `setu-normalizer-worker` — Indic NLP + PII redaction
- `setu-signals-worker` — Signal detection (ADR / cluster / trend)
- `osint-db-writer` — ArcadeDB graph writer
- `osint-frontend` — Next.js operator console on port `3000`

### Step 6 (Optional) — Start the Redpanda Console

```bash
docker compose --profile ops up console -d
```

Redpanda Console (Kafka UI) available at `http://localhost:8080`.

### Step 7 — Verify everything is healthy

```bash
docker compose ps
```

Expected output (all services `(healthy)` or `Up`):

```
NAME                     STATUS              PORTS
osint-arcadedb           Up (healthy)        0.0.0.0:2480->2480/tcp
osint-backend            Up                  0.0.0.0:8000->8000/tcp
osint-db-writer          Up
osint-enrich-worker      Up
osint-frontend           Up                  0.0.0.0:3000->3000/tcp
osint-ingest-worker      Up
osint-qwen35-4b-tgi      Up (healthy)        0.0.0.0:8088->80/tcp
osint-redpanda           Up (healthy)        0.0.0.0:19092->19092/tcp
setu-normalizer-worker   Up
setu-signals-worker      Up
```

---

## 6. Path B — Local Dev Mode (No Docker)

Use this path when you want to iterate on Python or TypeScript code without
rebuilding containers. You still need Docker for Redpanda and ArcadeDB.

### Step 1 — Start only infrastructure via Docker

```bash
docker compose up redpanda arcadedb -d
```

### Step 2 — Backend (FastAPI)

```bash
# From the repo root
cd backend

# Create and activate virtualenv
python -m venv .venv
source .venv/bin/activate          # Linux / macOS
.\.venv\Scripts\Activate.ps1       # Windows PowerShell

# Install dependencies
pip install -e ".[dev]"

# Start the dev server
cd ..
python -m uvicorn backend.app.dev:app \
    --host 127.0.0.1 \
    --port 8000 \
    --reload
```

> `backend.app.dev` is a thin wrapper around `backend.app.main` with hot-reload
> enabled and mock data seeded. The `--reload` flag enables file-watch restart.

The API is available at `http://127.0.0.1:8000`.
Interactive docs: `http://127.0.0.1:8000/docs`.

### Step 3 — Frontend (Next.js)

Open a **new terminal**:

```bash
cd frontend
npm install
npm run dev
```

The operator console is available at `http://localhost:3000`.

> **Hot Module Replacement (HMR)** is active via Turbopack. Changes to
> `frontend/src/` are reflected instantly in the browser.

### Step 4 — Ingestion Worker (optional)

```bash
cd workers/ingestion
python -m venv .venv && source .venv/bin/activate
pip install -e ".[dev]"
python -m app.main
```

### Step 5 — Enrichment Worker (optional)

```bash
cd workers/enrichment
python -m venv .venv && source .venv/bin/activate
pip install -e ".[dev]"
python -m app.main
```

---

## 7. Verifying Every Service

After startup, run these one-liner health checks to confirm each component is alive:

### Redpanda (Kafka broker)

```bash
# Topic list via Redpanda HTTP Proxy
curl -s http://localhost:18082/topics | python -m json.tool
```

### ArcadeDB (Graph database)

```bash
# Server readiness
curl -s http://localhost:2480/api/v1/ready

# List databases (authenticates with root credentials)
curl -s -u root:change-me-local-only \
    http://localhost:2480/api/v1/databases | python -m json.tool
```

### TGI LLM (Qwen3.5-4B)

```bash
# Health endpoint
curl -s http://localhost:8088/health

# Quick inference test (~2 second response)
curl -s http://localhost:8088/v1/completions \
    -H "Content-Type: application/json" \
    -d '{"model":"Qwen/Qwen3.5-4B","prompt":"Hello","max_tokens":5}' \
    | python -m json.tool
```

### Backend API (FastAPI)

```bash
# Root health check
curl -s http://localhost:8000/health

# OpenAPI spec
curl -s http://localhost:8000/openapi.json | python -m json.tool | head -40
```

### Frontend (Next.js)

```bash
curl -si http://localhost:3000 | head -5
# Expected: HTTP/1.1 200 OK
```

---

## 8. Kafka Topics Bootstrap

Redpanda auto-creates topics on first message. To pre-create them explicitly:

```bash
# Exec into the Redpanda container
docker exec -it osint-redpanda bash

# Create all OSINT + SETU topics
rpk topic create \
    osint.targets.urls \
    osint.raw.events \
    osint.events.high_confidence \
    osint.graph.write \
    setu.signals.firehose \
    setu.audit.events \
    setu.mentions.raw \
    setu.mentions.normalized \
    setu.mentions.medical \
    setu.signals.adr \
    setu.signals.trend \
    setu.signals.cluster \
    --partitions 3 \
    --replicas 1

# List all topics to verify
rpk topic list

exit
```

Or via the Redpanda HTTP Proxy (no shell needed):

```bash
# Create osint.raw.events via REST
curl -s -X POST http://localhost:18082/topics/osint.raw.events \
    -H "Content-Type: application/vnd.kafka.v2+json" \
    -d '{"records":[]}' 
```

---

## 9. Running the Test Suite

Each package has its own test suite. Run them from the **repo root**.

### Backend tests

```bash
cd backend
python -m venv .venv && source .venv/bin/activate
pip install -e ".[dev]"
cd ..
python -m pytest backend/tests/ -v
```

Expected tests:
- `test_bus.py` — Redpanda bus helpers
- `test_intelligence.py` — GraphRAG embedding + ArcadeDB query logic
- `test_schemas.py` — Pydantic schema validation (core + health)

### Enrichment worker tests

```bash
cd workers/enrichment
python -m venv .venv && source .venv/bin/activate
pip install -e ".[dev]"
cd ../..
python -m pytest workers/enrichment/tests/ -v
```

Expected tests:
- `test_brain.py` — LLM extraction pipeline (mocked TGI client)
- `test_entity_resolution.py` — BLAKE2b embedding + fuzzy merge logic

### Ingestion worker tests

```bash
cd workers/ingestion
python -m venv .venv && source .venv/bin/activate
pip install -e ".[dev]"
cd ../..
python -m pytest workers/ingestion/tests/ -v
```

Expected tests:
- `test_conductor.py` — Rate limiter, concurrency manager
- `test_quantitative_processor.py` — Numeric time-series parsing
- `test_web_extraction.py` — Playwright web scraper (requires Chromium)

### Writer worker tests

```bash
cd workers/writer
python -m venv .venv && source .venv/bin/activate
pip install -e ".[dev]"
cd ../..
python -m pytest workers/writer/tests/ -v
```

### Run all tests at once (from repo root)

```bash
# Assumes all virtualenvs are already activated / dependencies installed
python -m pytest backend/tests/ workers/enrichment/tests/ \
    workers/ingestion/tests/ workers/writer/tests/ \
    -v --tb=short 2>&1 | tee test-results.txt
```

---

## 10. API Quick Tour with cURL

All examples assume the backend is running at `http://localhost:8000`.

### Health check

```bash
curl -s http://localhost:8000/health | python -m json.tool
```

```json
{"status": "ok", "version": "0.1.0"}
```

### SETU Projects — list all projects

```bash
curl -s http://localhost:8000/api/setu/projects | python -m json.tool
```

### SETU Projects — create a new project

```bash
curl -s -X POST http://localhost:8000/api/setu/projects \
    -H "Content-Type: application/json" \
    -d '{
        "name": "Dengue Cluster Watch — Delhi 2026",
        "description": "Monitor Delhi social media for dengue outbreak signals",
        "keywords": ["dengue", "बुखार", "डेंगू", "fever", "platelet count"],
        "geo_scope": "Delhi, India"
    }' | python -m json.tool
```

### SETU Sources — add a Reddit source

```bash
# Replace <project_id> with the UUID returned above
curl -s -X POST http://localhost:8000/api/setu/projects/<project_id>/sources \
    -H "Content-Type: application/json" \
    -d '{
        "connector_type": "reddit",
        "target": "r/india+r/Delhi+r/IndianMedicalAssociation",
        "config": {"limit": 100, "time_filter": "day"}
    }' | python -m json.tool
```

### SETU Signals — list all signals for a project

```bash
curl -s "http://localhost:8000/api/setu/projects/<project_id>/signals" \
    | python -m json.tool
```

### SETU Signals — triage a signal

```bash
curl -s -X POST \
    http://localhost:8000/api/setu/projects/<project_id>/signals/<signal_id>/triage \
    -H "Content-Type: application/json" \
    -d '{
        "decision": "ESCALATE",
        "reviewer_id": "reviewer-demo-001",
        "notes": "Cluster pattern matches ILI case definition — refer to IDSP"
    }' | python -m json.tool
```

### SETU Exports — IDSP P-form (outbreak alert PDF precursor)

```bash
curl -s "http://localhost:8000/api/setu/projects/<project_id>/signals/<signal_id>/export/idsp-p-form" \
    | python -m json.tool
```

### SETU Exports — PVPI ICSR (pharmacovigilance report, ICH-E2B R3 JSON)

```bash
curl -s "http://localhost:8000/api/setu/projects/<project_id>/signals/<signal_id>/export/pvpi-icsr" \
    | python -m json.tool
```

### Intelligence — GraphRAG semantic query

```bash
curl -s -X POST http://localhost:8000/api/intelligence/query \
    -H "Content-Type: application/json" \
    -d '{
        "query": "dengue fever outbreak Delhi hospital",
        "top_k": 5,
        "traversal_hops": 3
    }' | python -m json.tool
```

### Intelligence — Geo graph (entity map for globe visualization)

```bash
curl -s "http://localhost:8000/api/intelligence/geo-graph?limit=500" \
    | python -m json.tool | head -60
```

### Interactive API docs

Open in browser: **`http://localhost:8000/docs`**

Swagger UI with full schema documentation, live request execution, and response
examples for every endpoint.

---

## 11. Operator Console (Frontend)

Open **`http://localhost:3000`** in your browser.

### Dashboard panels

| Panel | Path | Description |
|---|---|---|
| **Live Feed** | `/` (default) | Real-time ingestion ticker with confidence scoring |
| **Signals** | `/` (signals tab) | SETU health signal cards (ADR, cluster, trend, misinfo) |
| **Entities** | `/entities` | Knowledge graph entity browser with vector similarity |
| **GraphRAG** | `/graphrag` | Interactive 3-hop semantic query interface |
| **Streams** | `/streams` | Kafka topic message explorer |
| **Alerts** | `/alerts` | Triage queue — escalate, dismiss, annotate signals |
| **Reports** | `/reports` | IDSP P-form and PVPI ICSR export center |
| **Database** | `/database` | ArcadeDB graph browser |
| **Settings** | `/settings` | Connector configuration, model toggles, thresholds |

### Globe visualization

The main dashboard includes a **MapLibre GL 5.24** threat-intelligence heatmap:
- Entity geo-coordinates rendered as a 3D globe
- HNSW similarity clusters shown as animated pulse rings
- Click any entity node to open its GraphRAG subgraph
- Filter by signal kind (ADR / cluster / trend / misinformation)

### WebSocket live stream

The frontend auto-connects to `ws://localhost:8000/ws/events` on load.
High-confidence events (>0.7 score) from Redpanda are pushed in real-time and
appear in the **Live Signals** ticker without page refresh.

---

## 12. Sending a Live Signal (End-to-End Demo)

This walkthrough demonstrates the complete ingestion → enrichment → graph → alert
pipeline from a single HTTP call.

### Step 1 — Publish a raw event to Redpanda

```bash
# Inject a synthetic disease report into the ingestion topic
curl -s -X POST http://localhost:18082/topics/osint.raw.events \
    -H "Content-Type: application/vnd.kafka.json.v2+json" \
    -d '{
        "records": [{
            "value": {
                "source": "reddit",
                "url": "https://reddit.com/r/Delhi/demo-post",
                "text": "मेरे परिवार में 3 लोगों को तेज बुखार और जोड़ों में दर्द है। डॉक्टर ने डेंगू का टेस्ट करवाने को कहा। दिल्ली में बहुत फैल रहा है।",
                "lang": "hi",
                "timestamp": "2026-05-07T10:00:00Z",
                "geo": {"lat": 28.6139, "lon": 77.2090, "place": "Delhi, India"}
            }
        }]
    }'
```

### Step 2 — Watch the enrichment worker process it

```bash
docker compose logs -f enrich-worker
```

You should see the LLM extraction pipeline:
```
INFO:brain: Extracting entities from 1 event(s)
INFO:brain: Extracted: [SYMPTOM:fever, SYMPTOM:joint_pain, CONDITION:dengue_fever, LOCATION:Delhi]
INFO:brain: Published to osint.enriched.events
```

### Step 3 — Check ArcadeDB for new entities

```bash
curl -s -u root:change-me-local-only \
    -X POST http://localhost:2480/api/v1/query/osint \
    -H "Content-Type: application/json" \
    -d '{"language":"sql","command":"SELECT * FROM Entity ORDER BY @rid DESC LIMIT 5"}' \
    | python -m json.tool
```

### Step 4 — Query via GraphRAG

```bash
curl -s -X POST http://localhost:8000/api/intelligence/query \
    -H "Content-Type: application/json" \
    -d '{"query": "dengue fever Delhi joints", "top_k": 3}' \
    | python -m json.tool
```

### Step 5 — Check the SETU signals endpoint

```bash
# List recently generated signals
curl -s http://localhost:8000/api/setu/signals/recent | python -m json.tool
```

### Step 6 — See it on the dashboard

Refresh `http://localhost:3000` — the new entity should appear on the globe
and in the Live Signals ticker within seconds.

---

## 13. Stopping & Cleaning Up

### Stop all containers (preserve data volumes)

```bash
docker compose --profile app down
```

### Stop and remove all containers + volumes (full reset)

```bash
docker compose --profile app down -v
```

> ⚠️ `-v` **deletes all data** including Redpanda messages, ArcadeDB graph, and
> cached HuggingFace model weights. You will need to re-download Qwen3.5-4B (~2.5 GB)
> on next startup.

### Stop only infrastructure (keep LLM running)

```bash
docker compose stop backend frontend ingest-worker enrich-worker \
    normalizer-worker signals-worker writer-worker
```

### Remove built images (free disk space)

```bash
docker compose --profile app down --rmi local
```

---

## 14. Troubleshooting Reference

### `docker: Error response from daemon: could not select device driver "nvidia"`

NVIDIA container toolkit is not installed or not enabled.

```bash
# Ubuntu
distribution=$(. /etc/os-release; echo $ID$VERSION_ID)
curl -s -L https://nvidia.github.io/libnvidia-container/gpgkey | sudo apt-key add -
curl -s -L https://nvidia.github.io/libnvidia-container/$distribution/libnvidia-container.list \
    | sudo tee /etc/apt/sources.list.d/nvidia-container-toolkit.list
sudo apt-get update && sudo apt-get install -y nvidia-container-toolkit
sudo nvidia-ctk runtime configure --runtime=docker
sudo systemctl restart docker
```

---

### LLM container stays in `(starting)` for >10 minutes

```bash
docker compose logs llm | tail -40
```

Common causes:
- `HUGGING_FACE_HUB_TOKEN` not set → model download fails with 401
- Insufficient VRAM → OOM on model load; use `CUDA_MEMORY_FRACTION=0.30` in `.env`
- Slow internet → large model download; wait it out or pre-download manually:

```bash
# Pre-download Qwen3.5-4B to local hf-cache volume
docker run --rm \
    -v $(pwd)/hf-cache:/data \
    -e HUGGING_FACE_HUB_TOKEN=hf_xxx \
    ghcr.io/huggingface/text-generation-inference:latest \
    text-generation-server download-weights Qwen/Qwen3.5-4B
```

---

### ArcadeDB `osint` database does not exist

The database is created automatically via `arcadedb.server.defaultDatabases`.
If it's missing:

```bash
curl -s -u root:change-me-local-only \
    -X POST http://localhost:2480/api/v1/create/osint \
    | python -m json.tool
```

---

### `BROKER_NOT_AVAILABLE` from Redpanda

Redpanda takes ~25 seconds to become healthy. Wait for:
```
docker compose ps redpanda   # must show (healthy)
```
If it never becomes healthy:

```bash
docker compose logs redpanda | grep -i error | tail -20
docker compose restart redpanda
```

---

### Backend fails to start: `Connection refused` to ArcadeDB or Redpanda

Start infrastructure before the app profile:

```bash
docker compose up redpanda arcadedb -d
# Wait 30 seconds
docker compose --profile app up -d
```

---

### Frontend `npm run dev` fails: `MODULE_NOT_FOUND`

```bash
cd frontend
rm -rf node_modules .next
npm install
npm run dev
```

---

### Backend local dev: `ModuleNotFoundError: No module named 'app'`

Run from the **repo root**, not from inside `backend/`:

```bash
# Correct — from repo root
python -m uvicorn backend.app.dev:app --host 127.0.0.1 --port 8000 --reload

# Wrong — do NOT do this
cd backend && python -m uvicorn app.dev:app
```

---

### Port already in use

| Port | Service | Kill command |
|---|---|---|
| `8000` | Backend API | `lsof -ti:8000 \| xargs kill` |
| `3000` | Frontend | `lsof -ti:3000 \| xargs kill` |
| `8088` | TGI LLM | `lsof -ti:8088 \| xargs kill` |
| `19092` | Redpanda Kafka | `lsof -ti:19092 \| xargs kill` |
| `2480` | ArcadeDB HTTP | `lsof -ti:2480 \| xargs kill` |
| `8080` | Redpanda Console | `lsof -ti:8080 \| xargs kill` |

Windows PowerShell equivalent:
```powershell
# Find and kill process on port 8000
(Get-NetTCPConnection -LocalPort 8000 -ErrorAction SilentlyContinue).OwningProcess |
    ForEach-Object { Stop-Process -Id $_ -Force }
```

---

### `ARCADEDB_ROOT_PASSWORD` mismatch

If you changed the password in `.env` after the volume was created, the volume
still uses the old password. Reset it:

```bash
docker compose down -v     # ⚠️ deletes all graph data
docker compose up arcadedb -d
```

---

## Service Port Reference

| Service | Port | URL |
|---|---|---|
| Backend FastAPI | `8000` | http://localhost:8000 |
| Frontend Next.js | `3000` | http://localhost:3000 |
| TGI LLM (Qwen) | `8088` | http://localhost:8088 |
| ArcadeDB HTTP | `2480` | http://localhost:2480 |
| ArcadeDB Binary | `2424` | `arcadedb://localhost:2424` |
| Redpanda Kafka | `19092` | `localhost:19092` |
| Redpanda HTTP Proxy | `18082` | http://localhost:18082 |
| Redpanda Schema Registry | `18081` | http://localhost:18081 |
| Redpanda Console (ops) | `8080` | http://localhost:8080 |

---

*Maintained by the SETU AAROGYA DRISHTI team — last updated May 2026*
