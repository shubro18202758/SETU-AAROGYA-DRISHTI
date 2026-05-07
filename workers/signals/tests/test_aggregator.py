"""End-to-end aggregator test driven by a Coldrif-style synthetic stream."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from uuid import uuid4

from workers.signals.app.aggregator import AggregatorConfig, SignalAggregator
from backend.app.schemas.health import (
    MedicalAnnotation,
    MedicalEntity,
    SentimentScore,
)


PROJECT_ID = uuid4()
START = datetime(2025, 10, 1, tzinfo=timezone.utc)


def _annotation(*, drug: str | None, event: str | None, ts: datetime) -> MedicalAnnotation:
    entities: list[MedicalEntity] = []
    if drug:
        entities.append(
            MedicalEntity(
                kind="DRUG",
                surface=drug,
                code_system="WHO-DRUG",
                code=f"WD-{drug.upper()}",
                confidence=0.92,
            )
        )
    if event:
        entities.append(
            MedicalEntity(
                kind="ADVERSE_EVENT",
                surface=event,
                code_system="ICD-11",
                code=f"ICD-{event.upper()}",
                confidence=0.88,
            )
        )
    return MedicalAnnotation(
        mention_id=uuid4(),
        project_id=PROJECT_ID,
        medical_entities=tuple(entities),
        sentiment=SentimentScore(
            polarity=-0.6, subjectivity=0.5, model_version="lex/0.1", confidence=0.7
        ),
        annotated_at=ts,
        model_version="setu-test/0.1",
        confidence=0.85,
    )


def test_baseline_then_coldrif_spike_emits_adr_and_trend_signals():
    agg = SignalAggregator(
        project_id=PROJECT_ID,
        config=AggregatorConfig(min_adr_observed=3, min_adr_prr=2.0, min_adr_chi2=4.0),
    )

    # 7 days of background chatter: paracetamol+fever plus unrelated mentions.
    for day in range(7):
        ts = START + timedelta(days=day)
        for _ in range(5):
            agg.observe(
                _annotation(drug="paracetamol", event="fever", ts=ts),
                district="chennai",
                latitude=None,
                longitude=None,
                timestamp=ts,
            )
        # baseline of one coldrif-only mention/day so trend detector has history.
        agg.observe(
            _annotation(drug="coldrif", event=None, ts=ts),
            district="palakkad",
            latitude=10.78,
            longitude=76.65,
            timestamp=ts,
        )

    # Day 8: cluster of Coldrif + AKI reports from Palakkad.
    surge_day = START + timedelta(days=8)
    emitted = []
    last_ann = _annotation(drug="coldrif", event="aki", ts=surge_day)
    for _ in range(12):
        emitted.extend(
            agg.observe(
                last_ann,
                district="palakkad",
                latitude=10.78,
                longitude=76.65,
                timestamp=surge_day,
            )
        )
    # Force the open day-8 buckets to be evaluated by the trend detector.
    emitted.extend(agg.flush(annotation=last_ann))

    kinds = {s.kind for s in emitted}
    assert "adr" in kinds, f"expected ADR signal, got {kinds}"
    assert "trend" in kinds, f"expected trend signal, got {kinds}"

    # Audit chain integrity.
    assert agg.audit.length >= 2
    assert agg.audit.verify() is True

    # Signals carry mention evidence and project linkage.
    for sig in emitted:
        assert sig.project_id == PROJECT_ID
        assert len(sig.evidence_mention_ids) == 1
        assert sig.audit_chain_head is not None


def test_negated_entities_do_not_contribute():
    agg = SignalAggregator(project_id=PROJECT_ID)
    ts = START
    ann = MedicalAnnotation(
        mention_id=uuid4(),
        project_id=PROJECT_ID,
        medical_entities=(
            MedicalEntity(
                kind="DRUG", surface="coldrif", code_system="WHO-DRUG", code="WD-COLDRIF",
                confidence=0.9, negated=True,
            ),
            MedicalEntity(
                kind="ADVERSE_EVENT", surface="aki", code_system="ICD-11", code="ICD-AKI",
                confidence=0.9, hypothetical=True,
            ),
        ),
        annotated_at=ts,
        model_version="setu-test/0.1",
        confidence=0.5,
    )
    out = agg.observe(ann, district=None, latitude=None, longitude=None, timestamp=ts)
    assert out == []


def test_off_topic_mentions_do_nothing():
    agg = SignalAggregator(project_id=PROJECT_ID)
    ts = START
    ann = MedicalAnnotation(
        mention_id=uuid4(),
        project_id=PROJECT_ID,
        medical_entities=(),
        annotated_at=ts,
        model_version="setu-test/0.1",
        confidence=0.1,
    )
    assert agg.observe(ann, district=None, latitude=None, longitude=None, timestamp=ts) == []
