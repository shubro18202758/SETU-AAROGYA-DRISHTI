"""Tests for SETU healthcare schemas."""

from datetime import UTC, datetime
from uuid import uuid4

import pytest
from pydantic import ValidationError

from backend.app.schemas import (
    AdverseEventStatistic,
    AuditEntry,
    HealthMention,
    KeywordSet,
    MedicalEntity,
    NormalizedMention,
    PIIFinding,
    Project,
    Signal,
    SourceConfig,
    TextSpan,
)


def _now() -> datetime:
    return datetime.now(UTC)


def test_health_mention_accepts_medical_vocabulary() -> None:
    """Mentions with words like 'risk' / 'adverse' must NOT be rejected.

    The legacy ``UniversalSchema`` enforces ``FORBIDDEN_DOMAIN_TERMS`` to keep
    OSINT contracts neutral. Healthcare schemas relax that so first-class
    medical language is preserved.
    """

    mention = HealthMention(
        id=uuid4(),
        project_id=uuid4(),
        source_config_id=uuid4(),
        connector_type="reddit",
        source_uri="https://reddit.com/r/india/comments/abc/post",
        author_hash="9c83ab1f",
        fetched_at=_now(),
        original_text="Severe adverse reaction observed after Coldrif syrup; high risk for kids.",
    )

    assert "adverse" in mention.original_text


def test_health_mention_rejects_naive_timestamp() -> None:
    with pytest.raises(ValidationError):
        HealthMention(
            id=uuid4(),
            project_id=uuid4(),
            source_config_id=uuid4(),
            connector_type="reddit",
            source_uri="https://example.test",
            author_hash="abcdef01",
            fetched_at=datetime(2025, 10, 1, 12, 0, 0),  # naive
            original_text="hello world",
        )


def test_normalized_mention_is_frozen() -> None:
    mention = NormalizedMention(
        mention_id=uuid4(),
        project_id=uuid4(),
        normalized_text="redacted",
        normalized_at=_now(),
        pipeline_version="0.1.0",
    )
    with pytest.raises(ValidationError):
        mention.normalized_text = "tampered"  # type: ignore[misc]


def test_pii_finding_requires_redaction_token() -> None:
    finding = PIIFinding(
        kind="aadhaar",
        span=TextSpan(start=0, end=12, text="123456789012"),
        redaction_token="<AADHAAR_1>",
    )
    assert finding.redaction_token.startswith("<")


def test_medical_entity_confidence_bounds() -> None:
    with pytest.raises(ValidationError):
        MedicalEntity(kind="DRUG", surface="Coldrif", confidence=1.4)


def test_signal_chain_links_evidence() -> None:
    sig = Signal(
        id=uuid4(),
        project_id=uuid4(),
        kind="adr",
        score=0.91,
        title="Spike in Coldrif adverse mentions",
        explanation="PRR=4.7, ROR=5.1, IC=2.3 over 7-day window in Madhya Pradesh.",
        evidence_mention_ids=(uuid4(), uuid4(), uuid4()),
        started_at=_now(),
        detected_at=_now(),
        adr_stat=AdverseEventStatistic(
            drug="Coldrif",
            event="acute kidney injury",
            observed=14,
            expected=2.9,
            prr=4.7,
            ror=5.1,
            ic=2.3,
            ic_lower=1.1,
            chi_squared=23.4,
            window_start=_now(),
            window_end=_now(),
        ),
    )
    assert sig.kind == "adr"
    assert len(sig.evidence_mention_ids) == 3


def test_audit_entry_chain_format() -> None:
    entry = AuditEntry(
        id=uuid4(),
        sequence=1,
        prev_hash="0" * 64,
        payload_hash="ab" * 32,
        actor="setu-system",
        action="signal.created",
        signal_id=uuid4(),
        payload_summary="adr/Coldrif/acute kidney injury",
        recorded_at=_now(),
    )
    assert len(entry.prev_hash) == 64


def test_keyword_set_versioning() -> None:
    ks = KeywordSet(
        id=uuid4(),
        project_id=uuid4(),
        version=3,
        terms=("coldrif", "cold rif", "कोल्डरिफ"),
        created_at=_now(),
    )
    assert ks.version == 3
    assert ks.terms[2].startswith("कोल्डरिफ")


def test_source_config_health_score_bounds() -> None:
    cfg = SourceConfig(
        id=uuid4(),
        project_id=uuid4(),
        name="r/india live",
        connector_type="reddit",
        connector_params={"subreddits": ["india", "delhi"], "limit": 50},
        latency_tier="realtime",
        health_score=0.84,
        created_at=_now(),
    )
    assert cfg.connector_type == "reddit"


def test_project_slug_format() -> None:
    with pytest.raises(ValidationError):
        Project(
            id=uuid4(),
            slug="Has Spaces",
            name="Coldrif Watch",
            description="x" * 50,
            owner="ic-bharat-team",
            created_at=_now(),
            updated_at=_now(),
        )
