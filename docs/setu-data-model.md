# SETU AAROGYA DRISHTI — Data Model

All schemas live in [backend/app/schemas/health.py](../backend/app/schemas/health.py)
and inherit from `HealthBaseSchema`:

```python
class HealthBaseSchema(BaseModel):
    model_config = ConfigDict(
        extra="forbid",
        frozen=True,
        strict=True,
        str_strip_whitespace=True,
        validate_default=True,
    )
```

`HashHex` is the canonical hex-digest type:

```python
HashHex = Annotated[
    str,
    Field(strict=True, min_length=8, max_length=128, pattern=r"^[0-9a-f]+$"),
]
```

All `datetime` fields are validated as **timezone-aware UTC** via `_require_aware_utc`.

---

## 1. Project administration

### `Project`
| Field | Type | Notes |
|---|---|---|
| `id` | `UUID` | PK |
| `slug` | `str (1..128)` | URL-safe unique handle |
| `name` | `str (1..256)` | Display name |
| `description` | `str (1..2048)` | Free text |
| `owner` | `str (1..256)` | email or service principal |
| `status` | `Literal["active","paused","archived"]` | default `active` |
| `created_at` | `datetime` | server-set |
| `updated_at` | `datetime` | server-set on PATCH |

### `SourceConfig`
| Field | Type | Notes |
|---|---|---|
| `id` | `UUID` | PK |
| `project_id` | `UUID` | FK → Project |
| `name` | `str` | Unique within project |
| `connector_type` | `Literal["reddit","youtube","rss","telegram","web","x_fixture"]` | |
| `connector_params` | `Mapping[str, Any]` | Connector-specific config |
| `latency_tier` | `Literal["realtime","hourly","daily","weekly"]` | |
| `enabled` | `bool` | default `True` |

### `SourceHealthSnapshot`
| Field | Type | Notes |
|---|---|---|
| `source_id` | `UUID` | FK |
| `health_score` | `float [0..1]` | rolling composite |
| `uptime_ratio` | `float [0..1]` | last 24h |
| `error_rate` | `float [0..1]` | |
| `throughput_per_min` | `float ≥ 0` | |
| `recorded_at` | `datetime` | |

### `KeywordSet`
| Field | Type | Notes |
|---|---|---|
| `id` | `UUID` | PK |
| `project_id` | `UUID` | FK |
| `version` | `int ≥ 0` | server-incremented per project |
| `terms` | `tuple[str, ...]` | non-empty |
| `synonyms` | `Mapping[str, tuple[str, ...]]` | term → variants |
| `languages` | `tuple[str, ...]` | ISO 639-1, e.g. `("en","hi","ta")` |
| `code_mappings` | `tuple[CodeMapping, ...]` | SNOMED/MedDRA/ICD-10 |
| `approved_by` | `str \| None` | required before workers consume it |
| `approved_at` | `datetime \| None` | |
| `created_at` | `datetime` | |

### `CodeMapping`
| Field | Type |
|---|---|
| `term` | `str` |
| `system` | `Literal["SNOMED","MedDRA","ICD10","CTCAE","RxNorm"]` |
| `code` | `str` |
| `display` | `str` |

---

## 2. Mention pipeline

### `HealthMention`
| Field | Type | Notes |
|---|---|---|
| `id` | `UUID` | |
| `source_id` | `UUID` | FK |
| `external_id` | `str` | source-native id, used for dedupe |
| `text` | `str (1..16384)` | raw post / comment / article body |
| `author` | `str \| None` | redacted by normalizer |
| `language_hint` | `str \| None` | ISO 639-1 |
| `captured_at` | `datetime` | when the connector saw it |

### `NormalizedMention`
| Field | Type | Notes |
|---|---|---|
| `id` | `UUID` | |
| `mention_id` | `UUID` | FK → HealthMention |
| `text` | `str` | post-redaction, post-translation |
| `language` | `str` | detected ISO 639-1 |
| `translated_from` | `str \| None` | source language if translated |
| `redacted_pii_count` | `int ≥ 0` | |

### `MedicalAnnotation`
| Field | Type | Notes |
|---|---|---|
| `id` | `UUID` | |
| `normalized_mention_id` | `UUID` | FK |
| `entity_type` | `Literal["drug","symptom","facility","location","dose","route"]` | |
| `surface_form` | `str` | as it appears in text |
| `code_mapping` | `CodeMapping \| None` | nullable when below confidence |
| `confidence` | `float [0..1]` | |
| `start` / `end` | `int ≥ 0` | char offsets |

---

## 3. Signals + statistics

### `Signal`
| Field | Type | Notes |
|---|---|---|
| `id` | `UUID` | |
| `project_id` | `UUID` | FK |
| `kind` | `Literal["adr","trend","cluster","narrative"]` | |
| `score` | `float [0..1]` | |
| `title` | `str (1..512)` | |
| `explanation` | `str (1..8192)` | |
| `evidence_mention_ids` | `tuple[UUID, ...]` | |
| `codes` | `tuple[CodeMapping, ...]` | |
| `district` | `str \| None` | India admin-2 |
| `started_at` | `datetime` | window start |
| `detected_at` | `datetime` | when emitted |
| `status` | `Literal["new","in_review","confirmed","rejected","more_data"]` | |
| `assignee` | `str \| None` | set by triage |
| `audit_chain_head` | `HashHex \| None` | latest audit hash for this signal |
| `adr_stat` | `AdverseEventStatistic \| None` | only when `kind == "adr"` |
| `trend_stat` | `TrendStatistic \| None` | only when `kind == "trend"` |
| `cluster_stat` | `ClusterStatistic \| None` | only when `kind == "cluster"` |

### `AdverseEventStatistic`  (PRR / ROR / IC)
| Field | Type | Notes |
|---|---|---|
| `drug` | `str` | |
| `event` | `str` | adverse event term |
| `observed` / `expected` | `int ≥ 0` / `float ≥ 0` | |
| `prr` | `float ≥ 0` | Proportional Reporting Ratio |
| `ror` | `float ≥ 0` | Reporting Odds Ratio |
| `ic` | `float` | Information Component (BCPNN) |
| `ic_lower` | `float` | 95% lower CI of IC |
| `chi_squared` | `float ≥ 0` | |
| `window_start` / `window_end` | `datetime` | |

A signal is auto-emitted when **all three thresholds** are met:
`PRR ≥ 2`, `chi_squared ≥ 4`, `IC_lower > 0`.

### `TrendStatistic`
| Field | Type | Notes |
|---|---|---|
| `keyword` | `str` | |
| `district` | `str` | |
| `z_score` | `float` | vs. 28-day baseline |
| `baseline` / `current` | `float ≥ 0` | mentions/day |
| `window_start` / `window_end` | `datetime` | |

Auto-emit threshold: `z_score ≥ 4.0`.

### `ClusterStatistic`  (Poisson grid scan)
| Field | Type | Notes |
|---|---|---|
| `centroid_lat` / `centroid_lon` | `float` | WGS84 |
| `radius_deg` | `float ≥ 0` | scan window radius |
| `population` | `int ≥ 0` | catchment denominator |
| `observed` / `expected` | `int ≥ 0` / `float ≥ 0` | |
| `log_likelihood` | `float ≥ 0` | |
| `p_value` | `float [0..1]` | Monte-Carlo |
| `window_start` / `window_end` | `datetime` | |

Auto-emit threshold: `p_value ≤ 0.01` and `observed ≥ 5`.

---

## 4. Triage + audit

### `TriageDecision`
| Field | Type | Notes |
|---|---|---|
| `signal_id` | `UUID` | FK |
| `actor` | `str` | analyst principal |
| `decision` | `Literal["confirm","reject","request_more","escalate"]` | |
| `rationale` | `str (1..2048)` | |
| `decided_at` | `datetime` | |

Posting a triage decision updates `Signal.status`:
| decision | resulting status |
|---|---|
| `confirm` | `confirmed` |
| `reject` | `rejected` |
| `request_more` | `more_data` |
| `escalate` | stays `in_review`, but `assignee` set |

### `AuditEntry`
| Field | Type | Notes |
|---|---|---|
| `id` | `UUID` | |
| `sequence` | `int ≥ 0` | strictly monotonic per store |
| `prev_hash` | `HashHex` | genesis = `"0" * 64` |
| `payload_hash` | `HashHex` | `blake3(prev_hash + "|" + canonical_json(payload))` |
| `actor` | `str` | |
| `action` | `str` | e.g. `emit-cluster`, `triage-confirm` |
| `signal_id` | `UUID \| None` | when scoped |
| `mention_id` | `UUID \| None` | when scoped |
| `payload_summary` | `str (1..512)` | human-readable preview |
| `recorded_at` | `datetime` | |

---

## 5. Invariants

1. Every `datetime` is timezone-aware UTC.
2. `prev_hash`, `payload_hash` always 64 lowercase hex characters when using
   the BLAKE2b-256 fallback (BLAKE3 also yields 64 hex chars for `hexdigest()`).
3. `KeywordSet.version` is monotonically increasing per project; the API auto-assigns it.
4. Posting `/api/setu/audit` always re-reads `prev_hash` from the in-memory
   ledger tail — never trust client-supplied hashes.
5. A `Signal` never carries more than one of `adr_stat` / `trend_stat` /
   `cluster_stat`; the kind discriminates which is populated.
6. `Project.slug` is unique across the entire store; duplicate POSTs return 409.
