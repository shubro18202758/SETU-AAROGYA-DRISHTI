# SETU AAROGYA DRISHTI — System Architecture

> **Pan IIT Hackathon — AI for Bharat, Theme 6**: Real-Time Social Listening
> for Patient Experience & Safety Signals (Pharmacovigilance, ADR Detection,
> Outbreak Pre-warning).

This document describes the production-shaped architecture of the SETU
AAROGYA DRISHTI subsystem grafted on top of the ARGUS-21 OSINT platform.
Everything here is **additive** to the existing OSINT stack — no ARGUS
component was removed or renamed. SETU re-uses ARGUS's bus, storage primitives,
and frontend shell.

---

## 1. Design tenets

| Tenet | Implementation |
|---|---|
| **Free / open-source only** | No paid APIs (no Brandwatch, Talkwalker, Sprinklr). All connectors target free public sources or bring-your-own credentials for free tiers. |
| **Local LLMs, ≤8 GB VRAM** | Ollama + llama.cpp via the existing `infrastructure/llm` profile. Default models: `llama3.2:3b-instruct`, `xlm-roberta-base` for multilingual NER/classification. No outbound LLM calls required. |
| **Strict typing end-to-end** | Pydantic v2 strict schemas (`HealthBaseSchema`, `frozen=True`, `extra="forbid"`); TypeScript strict mode + `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes`. |
| **Tamper-evident audit** | BLAKE3 hash-chain (BLAKE2b-256 fallback when `blake3` not installed) over every analyst decision and signal emission. Genesis hash = `"0" * 64`. |
| **India-first multilingual** | Languages: en, hi, ta, te, kn (extensible). Devanagari, Tamil, Telugu, Kannada keyword expansion. |
| **Backward compatibility** | All ARGUS routes (`/api/feeds`, `/api/intelligence`, `/api/extract`, `/api/lookup`, `/api/system`) and pages remain. SETU mounts under `/api/setu/*` and `/setu/*`. |
| **Statistical rigor** | PRR + ROR + IC (with 95% CI) for ADR disproportionality, z-score for trend detection, Poisson grid scan + log-likelihood + p-value for spatial clusters. |
| **Regulatory exporters** | Drafts CDSCO IDSP P-form (outbreak report) and PvPI ICSR (Individual Case Safety Report) JSON for any confirmed signal. |

---

## 2. High-level component diagram

```
┌────────────────────────────── EDGE / FRONTEND ──────────────────────────────┐
│  Next.js 16 (App Router, Turbopack)                                         │
│   ┌──────────────┐ ┌──────────────┐ ┌──────────────┐ ┌──────────────┐       │
│   │ /setu        │ │ /setu/triage │ │ /setu/audit  │ │ /setu/map    │ ...   │
│   └──────┬───────┘ └──────┬───────┘ └──────┬───────┘ └──────┬───────┘       │
│          │                │                │                │               │
│   ┌──────▼────────────────▼────────────────▼────────────────▼──────┐        │
│   │  Edge proxy:  /api/setu/[...path]  (runtime = "edge")          │        │
│   └──────────────────────────────┬────────────────────────────────┘         │
└──────────────────────────────────┼──────────────────────────────────────────┘
                                   │
                                   ▼
┌──────────────────────────── BACKEND (FastAPI) ──────────────────────────────┐
│  app.state.setu_store : SetuStore (Protocol)                                │
│  ──────────────────────────────────────────────                             │
│   /api/setu/projects   (CRUD + PATCH + DELETE)                              │
│   /api/setu/projects/{id}/sources    (CRUD + PUT health)                    │
│   /api/setu/projects/{id}/keywords   (auto-versioning)                      │
│   /api/setu/projects/{id}/signals    (GET list + POST create)               │
│   /api/setu/signals/{id}/triage      (POST + GET history)                   │
│   /api/setu/audit                    (GET filter + POST append)             │
│                                                                             │
│  In-memory impl now (asyncio.Lock + dict). ArcadeDB swap-in later.          │
└──────────────────────────────────┬──────────────────────────────────────────┘
                                   │ (writes)
        ┌──────────────────────────┼─────────────────────────┐
        │                          │                         │
        ▼                          ▼                         ▼
┌──────────────────┐    ┌─────────────────────┐    ┌───────────────────────┐
│ workers/ingestion│    │ workers/normalizer  │    │ workers/signals       │
│  ──────────────  │    │  ─────────────────  │    │  ────────────────     │
│ Reddit, YouTube, │───►│ langid + drug NER + │───►│ PRR/ROR/IC ADR        │
│ RSS, Telegram,   │    │ symptom NER + geo   │    │ z-score trend         │
│ web scrape, X    │    │ resolver (India     │    │ Poisson grid cluster  │
│ replay fixture   │    │ districts gazette)  │    │ BLAKE3 audit emit     │
└──────────────────┘    └─────────────────────┘    └───────────┬───────────┘
                                                               │
                                                               ▼
                                                  ┌───────────────────────┐
                                                  │ regulatory exporters  │
                                                  │  IDSP P-form (PDF/JSON│
                                                  │  PvPI ICSR JSON       │
                                                  └───────────────────────┘
```

---

## 3. Bounded contexts

### 3.1 Project administration
- **Project** = one campaign with a slug, owner, status (`active`/`paused`/`archived`).
- **SourceConfig** = one connector instance bound to a project (Reddit, YouTube, RSS, Telegram, web, X fixture, …) with `connector_params` (free-form `Mapping[str, Any]`) + `latency_tier` (`realtime`/`hourly`/`daily`/`weekly`).
- **KeywordSet** = an immutable, auto-versioned bundle of `terms`, `synonyms`, `languages`, and optional `code_mappings` (SNOMED, MedDRA, ICD-10). Approval required (`approved_by`, `approved_at`) before workers consume the version.

### 3.2 Mention pipeline
- **HealthMention** = raw, untranslated, untyped text from a connector with `source_id`, `external_id`, `captured_at`, `language_hint`.
- **NormalizedMention** = mention after language detection, profanity/PII redaction, and translation (when target ≠ `en`).
- **MedicalAnnotation** = one or more drug / symptom / facility / location entities pulled from a normalized mention by the NER worker, each linked to a code mapping when confidence ≥ threshold.

### 3.3 Signals + triage + audit
- **Signal** = an emitted hypothesis (`kind ∈ {adr, trend, cluster, narrative}`). Carries one of `adr_stat`, `trend_stat`, `cluster_stat`, plus `score ∈ [0,1]`, `evidence_mention_ids`, `district`, `started_at`, `detected_at`, `status ∈ {new, in_review, confirmed, rejected, more_data}`.
- **TriageDecision** = analyst action on a signal (`actor`, `decision ∈ {confirm, reject, request_more, escalate}`, `rationale`, `decided_at`).
- **AuditEntry** = append-only ledger row. Every mutation that matters (project bootstrap, signal emission, triage decision, regulatory export) writes one entry. Each carries `sequence`, `prev_hash`, `payload_hash`, `actor`, `action`, `payload_summary`, optional `signal_id` / `mention_id`.

---

## 4. Audit chain protocol

1. The first entry uses `prev_hash = "0" * 64` (genesis).
2. For every subsequent entry, `prev_hash = previous_entry.payload_hash`.
3. `payload_hash = blake3(prev_hash.ascii() + b"|" + canonical_json(payload))`.
4. `canonical_json` = `json.dumps(payload, sort_keys=True, separators=(",", ":"), default=str).encode("utf-8")`.
5. When `blake3` is not installed (e.g. backend baseline), `hashlib.blake2b(data, digest_size=32)` produces the same 64-hex-char output.
6. The frontend `/setu/audit` page recomputes the chain client-side and renders **VALID** / **BROKEN** for each row.

---

## 5. Why FastAPI + Next.js + Pydantic v2

- The existing ARGUS shell already runs on this stack — re-using it removes
  an entire deployment surface.
- Pydantic v2 strict mode (`frozen=True`, `extra="forbid"`) is the cheapest
  way to make every wire payload self-validating; combined with
  `HashHex = Annotated[str, Field(strict=True, pattern=r"^[0-9a-f]+$",
  min_length=8, max_length=128)]` it eliminates a whole class of audit-chain
  bugs at the type boundary.
- Next.js edge runtime proxies at `/api/setu/[...path]` keep the browser
  origin clean (no CORS) without needing a heavyweight reverse proxy in dev.

---

## 6. What is **not** in scope yet (Phase 8 work)

- Full SNOMED / MedDRA / ICD-10 reference loading (currently just enough for
  demo).
- IDSP P-form & PvPI ICSR exporters (schemas exist; emitters TBD).
- `MemoryPressureGate` (worker backpressure under low VRAM).
- Per-connector circuit-breaker on `health_score < 0.3`.
- Differential-privacy noise on aggregate counts.
- Real Leaflet/MapLibre map (placeholder cards today).
- ArcadeDB-backed `SetuStore` swap-in.

These are tracked in [`/memories/session/plan.md`](../../memories/session/plan.md) Phase 8.
