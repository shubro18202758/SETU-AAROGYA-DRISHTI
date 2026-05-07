"""Tests for the signals worker shutdown flush helper."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from uuid import uuid4

import pytest

from backend.app.schemas.health import (
    MedicalAnnotation,
    MedicalEntity,
    SentimentScore,
)
from workers.signals.app.aggregator import AggregatorConfig, SignalAggregator
from workers.signals.app.main import WorkerConfig, _flush_aggregators


PROJECT_ID = uuid4()
START = datetime(2025, 11, 1, tzinfo=timezone.utc)


def _annotation(*, drug: str | None, event: str | None, ts: datetime) -> MedicalAnnotation:
    entities: list[MedicalEntity] = []
    if drug:
        entities.append(
            MedicalEntity(
                kind="DRUG",
                surface=drug,
                code_system="WHO-DRUG",
                code=f"WD-{drug.upper()}",
                confidence=0.9,
            )
        )
    if event:
        entities.append(
            MedicalEntity(
                kind="ADVERSE_EVENT",
                surface=event,
                code_system="ICD-11",
                code=f"ICD-{event.upper()}",
                confidence=0.9,
            )
        )
    return MedicalAnnotation(
        mention_id=uuid4(),
        project_id=PROJECT_ID,
        medical_entities=tuple(entities),
        sentiment=SentimentScore(
            polarity=-0.5, subjectivity=0.5, model_version="lex/0.1", confidence=0.7
        ),
        annotated_at=ts,
        model_version="setu-test/0.1",
        confidence=0.85,
    )


class _FakeProducer:
    def __init__(self) -> None:
        self.calls: list[tuple[str, str, str]] = []

    async def send(self, topic: str, value, key: str) -> None:  # type: ignore[no-untyped-def]
        self.calls.append((topic, str(getattr(value, "id", "")), key))


def _config() -> WorkerConfig:
    return WorkerConfig(
        brokers="localhost:9092",
        mentions_topic="m",
        firehose_topic="firehose",
        adr_topic="adr",
        trend_topic="trend",
        cluster_topic="cluster",
        audit_topic="audit",
        group_id="g",
        audit_chain_enabled=True,
    )


@pytest.mark.asyncio
async def test_flush_aggregators_drains_open_buckets_and_publishes() -> None:
    agg = SignalAggregator(
        project_id=PROJECT_ID,
        config=AggregatorConfig(min_adr_observed=3, min_adr_prr=2.0, min_adr_chi2=4.0),
    )

    # Build baseline so the trend detector has history for the surge keywords.
    for day in range(7):
        ts = START + timedelta(days=day)
        for _ in range(3):
            agg.observe(
                _annotation(drug="paracetamol", event="fever", ts=ts),
                district="chennai",
                latitude=None,
                longitude=None,
                timestamp=ts,
            )
        # 1 baseline coldrif/day in palakkad so the trend detector has history
        # for the surge keyword/district pair.
        agg.observe(
            _annotation(drug="coldrif", event=None, ts=ts),
            district="palakkad",
            latitude=10.78,
            longitude=76.65,
            timestamp=ts,
        )

    surge_day = START + timedelta(days=8)
    last_ann = _annotation(drug="coldrif", event="aki", ts=surge_day)
    for _ in range(15):
        agg.observe(
            last_ann,
            district="palakkad",
            latitude=10.78,
            longitude=76.65,
            timestamp=surge_day,
        )

    sig_producer = _FakeProducer()
    audit_producer = _FakeProducer()

    total = await _flush_aggregators(
        {PROJECT_ID: agg},
        {PROJECT_ID: last_ann},
        config=_config(),
        signal_producer=sig_producer,  # type: ignore[arg-type]
        audit_producer=audit_producer,  # type: ignore[arg-type]
    )

    assert total > 0, "expected at least one trend signal from open bucket"
    # Each emitted signal is published twice (kind topic + firehose).
    assert len(sig_producer.calls) == total * 2
    # Audit chain must have a matching entry per emitted signal.
    assert len(audit_producer.calls) == total


@pytest.mark.asyncio
async def test_flush_aggregators_is_safe_with_no_annotation_seen() -> None:
    agg = SignalAggregator(project_id=PROJECT_ID)
    sig_producer = _FakeProducer()
    audit_producer = _FakeProducer()

    total = await _flush_aggregators(
        {PROJECT_ID: agg},
        {},  # no annotation tracked
        config=_config(),
        signal_producer=sig_producer,  # type: ignore[arg-type]
        audit_producer=audit_producer,  # type: ignore[arg-type]
    )

    assert total == 0
    assert sig_producer.calls == []
    assert audit_producer.calls == []
