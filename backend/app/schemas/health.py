"""Schemas for SETU AAROGYA DRISHTI — generic social listening + public health.

These models are intentionally separated from :mod:`backend.app.schemas.core`:

* The OSINT prototype enforces ``FORBIDDEN_DOMAIN_TERMS`` (e.g. "risk",
  "threat", "campaign") which would reject most healthcare content.
* Healthcare payloads need additional structure (language segments, codes,
  redactions, audit chaining) that is irrelevant to the legacy graph schema.

We therefore introduce :class:`HealthBaseSchema` — same Pydantic ergonomics
(strict, frozen, forbid extras) **without** the domain-term validator — and
build all SETU models on top of it. Legacy schemas remain untouched.
"""

from __future__ import annotations

from collections.abc import Mapping
from datetime import datetime, timezone
from typing import Annotated, Any, Final, Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, field_validator

# ---------------------------------------------------------------------------
# Base + shared aliases
# ---------------------------------------------------------------------------

ConnectorType = Literal[
    "reddit",
    "youtube",
    "rss",
    "telegram",
    "web",
    "x_fixture",
]

LatencyTier = Literal["realtime", "daily", "weekly"]

ProjectStatus = Literal["active", "paused", "archived"]

SignalKind = Literal["adr", "trend", "cluster", "misinformation"]

SignalStatus = Literal["new", "triaged", "confirmed", "rejected", "more_data"]

MedicalEntityKind = Literal[
    "DRUG",
    "SYMPTOM",
    "CONDITION",
    "PROCEDURE",
    "DEVICE",
    "FACILITY",
    "ADVERSE_EVENT",
    "DEMOGRAPHIC",
]

CodeSystem = Literal[
    "SNOMED-CT",
    "ICD-11",
    "ICD-10",
    "WHO-DRUG",
    "RxNorm",
    "MedDRA",
    "LOCAL",
]

PIIKind = Literal[
    "aadhaar",
    "pan",
    "mobile",
    "email",
    "name",
    "address",
    "username",
    "url_handle",
]

LanguageCode = Annotated[str, Field(strict=True, min_length=2, max_length=8, pattern=r"^[a-z]{2,3}(-[A-Za-z0-9]{2,8})?$")]
Slug = Annotated[str, Field(strict=True, min_length=1, max_length=128, pattern=r"^[a-z0-9][a-z0-9_-]*$")]
ShortText = Annotated[str, Field(strict=True, min_length=1, max_length=512)]
LongText = Annotated[str, Field(strict=True, min_length=1, max_length=8192)]
RawText = Annotated[str, Field(strict=True, min_length=1, max_length=65_536)]
ConfidenceFloat = Annotated[float, Field(strict=True, ge=0.0, le=1.0)]
PolarityFloat = Annotated[float, Field(strict=True, ge=-1.0, le=1.0)]
NonNegativeInt = Annotated[int, Field(strict=True, ge=0)]
PositiveFloat = Annotated[float, Field(strict=True, ge=0.0)]
HashHex = Annotated[str, Field(strict=True, min_length=8, max_length=128, pattern=r"^[0-9a-f]+$")]


def _require_aware_utc(value: datetime) -> datetime:
    if value.tzinfo is None or value.utcoffset() is None:
        raise ValueError("timestamp must be timezone-aware UTC")
    return value.astimezone(timezone.utc)


class HealthBaseSchema(BaseModel):
    """Strict base model for all SETU healthcare schemas.

    Same guarantees as :class:`UniversalSchema` (frozen, strict, no extras,
    whitespace-stripped strings) but **without** the FORBIDDEN_DOMAIN_TERMS
    rejection — terms like ``"risk"``/``"adverse"`` are first-class here.
    """

    model_config = ConfigDict(
        extra="forbid",
        frozen=True,
        strict=True,
        str_strip_whitespace=True,
        validate_default=True,
    )


# ---------------------------------------------------------------------------
# Project / Source / Keyword administration
# ---------------------------------------------------------------------------


class CodeMapping(HealthBaseSchema):
    """Map a free-text term to a coded medical concept."""

    surface: ShortText
    code_system: CodeSystem
    code: ShortText
    display_name: ShortText | None = None


class KeywordSet(HealthBaseSchema):
    id: UUID
    project_id: UUID
    version: NonNegativeInt
    terms: tuple[ShortText, ...] = Field(min_length=1, max_length=2048)
    synonyms: Mapping[str, tuple[str, ...]] = Field(default_factory=dict)
    languages: tuple[LanguageCode, ...] = Field(default_factory=tuple)
    code_mappings: tuple[CodeMapping, ...] = Field(default_factory=tuple)
    approved_by: ShortText | None = None
    approved_at: datetime | None = None
    created_at: datetime

    @field_validator("created_at")
    @classmethod
    def _aware_created_at(cls, value: datetime) -> datetime:
        return _require_aware_utc(value)

    @field_validator("approved_at")
    @classmethod
    def _aware_approved_at(cls, value: datetime | None) -> datetime | None:
        return _require_aware_utc(value) if value is not None else None


class SourceConfig(HealthBaseSchema):
    id: UUID
    project_id: UUID
    name: ShortText
    connector_type: ConnectorType
    connector_params: Mapping[str, Any] = Field(default_factory=dict)
    latency_tier: LatencyTier = "daily"
    enabled: bool = True
    health_score: ConfidenceFloat = 1.0
    last_success_at: datetime | None = None
    last_error: ShortText | None = None
    created_at: datetime

    @field_validator("created_at")
    @classmethod
    def _aware_created_at(cls, value: datetime) -> datetime:
        return _require_aware_utc(value)

    @field_validator("last_success_at")
    @classmethod
    def _aware_last_success(cls, value: datetime | None) -> datetime | None:
        return _require_aware_utc(value) if value is not None else None


class Project(HealthBaseSchema):
    id: UUID
    slug: Slug
    name: ShortText
    description: LongText
    owner: ShortText
    status: ProjectStatus = "active"
    keyword_set_id: UUID | None = None
    source_ids: tuple[UUID, ...] = Field(default_factory=tuple)
    created_at: datetime
    updated_at: datetime

    @field_validator("created_at", "updated_at")
    @classmethod
    def _aware_ts(cls, value: datetime) -> datetime:
        return _require_aware_utc(value)


# ---------------------------------------------------------------------------
# Mentions, language segmentation, NLP results
# ---------------------------------------------------------------------------


class TextSpan(HealthBaseSchema):
    start: NonNegativeInt
    end: NonNegativeInt
    text: ShortText


class LanguageSegment(HealthBaseSchema):
    span: TextSpan
    language: LanguageCode
    script: Literal["Latn", "Deva", "Taml", "Telu", "Knda", "Beng", "Guru", "Gujr", "Mlym", "Orya", "Arab", "Mixed"] = "Latn"
    confidence: ConfidenceFloat


class PIIFinding(HealthBaseSchema):
    kind: PIIKind
    span: TextSpan
    redaction_token: ShortText


class MedicalEntity(HealthBaseSchema):
    kind: MedicalEntityKind
    surface: ShortText
    span: TextSpan | None = None
    code_system: CodeSystem | None = None
    code: ShortText | None = None
    confidence: ConfidenceFloat
    negated: bool = False
    hypothetical: bool = False


class SentimentScore(HealthBaseSchema):
    polarity: PolarityFloat
    subjectivity: ConfidenceFloat
    model_version: ShortText
    confidence: ConfidenceFloat


class MisinformationFlag(HealthBaseSchema):
    label: Literal["likely_misinformation", "sarcasm", "coordinated_inauthentic", "clean"]
    confidence: ConfidenceFloat
    rationale: LongText | None = None


class HealthMention(HealthBaseSchema):
    """Raw social-listening mention from a connector.

    Conceptually parallels :class:`backend.app.schemas.core.RawEvent` but
    carries source/project linkage and a hashed author handle (PII-safe).
    """

    id: UUID
    project_id: UUID
    source_config_id: UUID
    connector_type: ConnectorType
    source_uri: ShortText
    author_hash: HashHex
    fetched_at: datetime
    original_text: RawText
    locale_hint: LanguageCode | None = None
    extra: Mapping[str, Any] = Field(default_factory=dict)

    @field_validator("fetched_at")
    @classmethod
    def _aware_fetched_at(cls, value: datetime) -> datetime:
        return _require_aware_utc(value)


class NormalizedMention(HealthBaseSchema):
    """Output of the normaliser worker (lang-ID + redaction + translation)."""

    mention_id: UUID
    project_id: UUID
    normalized_text: RawText
    translated_text: RawText | None = None
    language_segments: tuple[LanguageSegment, ...] = Field(default_factory=tuple)
    pii_findings: tuple[PIIFinding, ...] = Field(default_factory=tuple)
    redaction_count: NonNegativeInt = 0
    normalized_at: datetime
    pipeline_version: ShortText

    @field_validator("normalized_at")
    @classmethod
    def _aware_normalized_at(cls, value: datetime) -> datetime:
        return _require_aware_utc(value)


class MedicalAnnotation(HealthBaseSchema):
    """Output of the medical NER + sentiment pass."""

    mention_id: UUID
    project_id: UUID
    medical_entities: tuple[MedicalEntity, ...] = Field(default_factory=tuple)
    sentiment: SentimentScore | None = None
    misinformation: MisinformationFlag | None = None
    annotated_at: datetime
    model_version: ShortText
    confidence: ConfidenceFloat

    @field_validator("annotated_at")
    @classmethod
    def _aware_annotated_at(cls, value: datetime) -> datetime:
        return _require_aware_utc(value)


# ---------------------------------------------------------------------------
# Signals (ADR / trend / cluster) + audit ledger
# ---------------------------------------------------------------------------


class AdverseEventStatistic(HealthBaseSchema):
    drug: ShortText
    event: ShortText
    observed: NonNegativeInt
    expected: PositiveFloat
    prr: PositiveFloat
    ror: PositiveFloat
    ic: float
    ic_lower: float
    chi_squared: PositiveFloat
    window_start: datetime
    window_end: datetime

    @field_validator("window_start", "window_end")
    @classmethod
    def _aware_window(cls, value: datetime) -> datetime:
        return _require_aware_utc(value)


class TrendStatistic(HealthBaseSchema):
    keyword: ShortText
    district: ShortText | None = None
    z_score: float
    baseline: PositiveFloat
    current: PositiveFloat
    window_start: datetime
    window_end: datetime

    @field_validator("window_start", "window_end")
    @classmethod
    def _aware_window(cls, value: datetime) -> datetime:
        return _require_aware_utc(value)


class ClusterStatistic(HealthBaseSchema):
    centroid_lat: Annotated[float, Field(strict=True, ge=-90.0, le=90.0)]
    centroid_lon: Annotated[float, Field(strict=True, ge=-180.0, le=180.0)]
    radius_deg: PositiveFloat
    population: NonNegativeInt = 0
    observed: NonNegativeInt
    expected: PositiveFloat
    log_likelihood: float
    p_value: ConfidenceFloat
    window_start: datetime
    window_end: datetime

    @field_validator("window_start", "window_end")
    @classmethod
    def _aware_window(cls, value: datetime) -> datetime:
        return _require_aware_utc(value)


class Signal(HealthBaseSchema):
    """Surfaceable signal — appears in the triage queue and on dashboards."""

    id: UUID
    project_id: UUID
    kind: SignalKind
    score: ConfidenceFloat
    title: ShortText
    explanation: LongText
    evidence_mention_ids: tuple[UUID, ...] = Field(default_factory=tuple)
    codes: tuple[CodeMapping, ...] = Field(default_factory=tuple)
    district: ShortText | None = None
    started_at: datetime
    detected_at: datetime
    status: SignalStatus = "new"
    assignee: ShortText | None = None
    audit_chain_head: HashHex | None = None
    adr_stat: AdverseEventStatistic | None = None
    trend_stat: TrendStatistic | None = None
    cluster_stat: ClusterStatistic | None = None

    @field_validator("started_at", "detected_at")
    @classmethod
    def _aware_ts(cls, value: datetime) -> datetime:
        return _require_aware_utc(value)


class TriageDecision(HealthBaseSchema):
    signal_id: UUID
    actor: ShortText
    decision: Literal["confirm", "reject", "more_data"]
    rationale: LongText | None = None
    decided_at: datetime

    @field_validator("decided_at")
    @classmethod
    def _aware_decided_at(cls, value: datetime) -> datetime:
        return _require_aware_utc(value)


class AuditEntry(HealthBaseSchema):
    """Single link in the BLAKE3 hash chain."""

    id: UUID
    sequence: NonNegativeInt
    prev_hash: HashHex
    payload_hash: HashHex
    actor: ShortText
    action: ShortText
    signal_id: UUID | None = None
    mention_id: UUID | None = None
    payload_summary: ShortText
    recorded_at: datetime

    @field_validator("recorded_at")
    @classmethod
    def _aware_recorded_at(cls, value: datetime) -> datetime:
        return _require_aware_utc(value)


# ---------------------------------------------------------------------------
# Health monitoring & forms
# ---------------------------------------------------------------------------


class SourceHealthSnapshot(HealthBaseSchema):
    source_config_id: UUID
    health_score: ConfidenceFloat
    uptime_ratio: ConfidenceFloat
    error_rate: ConfidenceFloat
    last_success_at: datetime | None = None
    throughput_per_min: PositiveFloat = 0.0
    snapshot_at: datetime

    @field_validator("snapshot_at")
    @classmethod
    def _aware_snapshot_at(cls, value: datetime) -> datetime:
        return _require_aware_utc(value)

    @field_validator("last_success_at")
    @classmethod
    def _aware_last_success(cls, value: datetime | None) -> datetime | None:
        return _require_aware_utc(value) if value is not None else None


class PrefilledForm(HealthBaseSchema):
    """Government-system-ready form payload (JSON, not a real submission)."""

    form_kind: Literal["IDSP_P", "PvPI_ICSR"]
    signal_id: UUID
    payload: Mapping[str, Any]
    generated_at: datetime
    schema_version: ShortText

    @field_validator("generated_at")
    @classmethod
    def _aware_generated_at(cls, value: datetime) -> datetime:
        return _require_aware_utc(value)


__all__: Final[tuple[str, ...]] = (
    "HealthBaseSchema",
    "ConnectorType",
    "LatencyTier",
    "ProjectStatus",
    "SignalKind",
    "SignalStatus",
    "MedicalEntityKind",
    "CodeSystem",
    "PIIKind",
    "CodeMapping",
    "KeywordSet",
    "SourceConfig",
    "Project",
    "TextSpan",
    "LanguageSegment",
    "PIIFinding",
    "MedicalEntity",
    "SentimentScore",
    "MisinformationFlag",
    "HealthMention",
    "NormalizedMention",
    "MedicalAnnotation",
    "AdverseEventStatistic",
    "TrendStatistic",
    "ClusterStatistic",
    "Signal",
    "TriageDecision",
    "AuditEntry",
    "SourceHealthSnapshot",
    "PrefilledForm",
)
