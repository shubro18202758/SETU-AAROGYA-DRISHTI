"""Aggregator — converts MedicalAnnotation streams into Signal candidates.

The aggregator is intentionally pure: ``observe(annotation, district, ts)``
mutates internal counters and returns lists of :class:`Signal` objects when a
detector trips. The async worker (``main.py``) wraps this with a Kafka
consumer/producer.
"""

from __future__ import annotations

from collections import defaultdict
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Iterable
from uuid import UUID, uuid4

from backend.app.schemas.health import (
    AdverseEventStatistic,
    ClusterStatistic,
    CodeMapping,
    MedicalAnnotation,
    Signal,
    TrendStatistic,
)

from .adr import ContingencyCounts, build_contingency, evaluate
from .audit import AuditChain
from .cluster import Observation, PoissonGridScanner
from .trend import TrendDetector

_ADVERSE_KINDS = frozenset({"ADVERSE_EVENT", "SYMPTOM", "CONDITION"})
_DRUG_KINDS = frozenset({"DRUG"})


@dataclass(slots=True)
class AggregatorConfig:
    bucket_seconds: int = 86_400  # daily buckets
    trend_window: int = 14
    cluster_cell_deg: float = 1.0
    cluster_window_days: int = 7
    min_adr_observed: int = 3
    min_adr_prr: float = 2.0
    min_adr_chi2: float = 4.0


@dataclass(slots=True)
class SignalAggregator:
    project_id: UUID
    config: AggregatorConfig = field(default_factory=AggregatorConfig)
    audit: AuditChain = field(default_factory=AuditChain)
    trend: TrendDetector = field(init=False)
    cluster: PoissonGridScanner = field(init=False)
    pair_counts: dict[tuple[str, str], int] = field(default_factory=lambda: defaultdict(int))
    bucket_counts: dict[tuple[str, str | None, int], int] = field(
        default_factory=lambda: defaultdict(int)
    )
    # Most recent bucket index per (keyword, district); used to detect when a
    # bucket has *closed* so we forward exactly one trend observation per day.
    last_bucket: dict[tuple[str, str | None], int] = field(default_factory=dict)

    def __post_init__(self) -> None:
        self.trend = TrendDetector(
            window=self.config.trend_window,
        )
        self.cluster = PoissonGridScanner(
            cell_deg=self.config.cluster_cell_deg,
            window_days=self.config.cluster_window_days,
        )

    # ------------------------------------------------------------------ helpers
    def _bucket(self, ts: datetime) -> int:
        return int(ts.timestamp() // self.config.bucket_seconds)

    def _bucket_bounds(self, bucket: int) -> tuple[datetime, datetime]:
        start = datetime.fromtimestamp(bucket * self.config.bucket_seconds, tz=timezone.utc)
        end = start + timedelta(seconds=self.config.bucket_seconds)
        return start, end

    @staticmethod
    def _pick_codes(annotation: MedicalAnnotation) -> tuple[list[str], list[str]]:
        drugs: list[str] = []
        events: list[str] = []
        for entity in annotation.medical_entities:
            if entity.negated or entity.hypothetical:
                continue
            label = entity.code or entity.surface.lower()
            if entity.kind in _DRUG_KINDS:
                drugs.append(label)
            elif entity.kind in _ADVERSE_KINDS:
                events.append(label)
        return drugs, events

    # --------------------------------------------------------------- public API
    def observe(
        self,
        annotation: MedicalAnnotation,
        *,
        district: str | None,
        latitude: float | None,
        longitude: float | None,
        timestamp: datetime,
    ) -> list[Signal]:
        drugs, events = self._pick_codes(annotation)
        if not drugs and not events:
            return []

        signals: list[Signal] = []
        bucket = self._bucket(timestamp)
        bucket_start, bucket_end = self._bucket_bounds(bucket)

        # Update co-occurrence + trend counters.
        for drug in drugs:
            for event in events:
                self.pair_counts[(drug, event)] += 1

        for keyword in {*drugs, *events}:
            key = (keyword, district)
            prev_bucket = self.last_bucket.get(key)
            if prev_bucket is not None and prev_bucket != bucket:
                # Bucket transitioned — forward the closed bucket's total.
                closed_count = self.bucket_counts[(keyword, district, prev_bucket)]
                prev_start, prev_end = self._bucket_bounds(prev_bucket)
                outcome = self.trend.observe(
                    keyword=keyword,
                    district=district,
                    count=float(closed_count),
                    bucket_start=prev_start,
                    bucket_end=prev_end,
                )
                if outcome.is_spike:
                    signals.append(self._build_trend_signal(annotation, outcome))
            self.bucket_counts[(keyword, district, bucket)] += 1
            self.last_bucket[key] = bucket

        # ADR co-occurrence evaluation.
        for drug in drugs:
            for event in events:
                counts = build_contingency(drug, event, self.pair_counts)
                result = evaluate(
                    drug,
                    event,
                    counts,
                    window_start=bucket_start,
                    window_end=bucket_end,
                    min_observed=self.config.min_adr_observed,
                    min_prr=self.config.min_adr_prr,
                    min_chi_squared=self.config.min_adr_chi2,
                )
                if result.is_signal:
                    signals.append(self._build_adr_signal(annotation, result))

        # Optional spatial scan if coordinates were supplied.
        if latitude is not None and longitude is not None:
            self.cluster.observe(
                Observation(lat=latitude, lon=longitude, timestamp=timestamp)
            )
            for cluster_outcome in self.cluster.scan(now=timestamp):
                if cluster_outcome.is_cluster:
                    signals.append(self._build_cluster_signal(annotation, cluster_outcome))

        # Record audit entries for every emitted signal.
        for signal in signals:
            self.audit.append(
                actor="setu-signals-worker",
                action=f"emit-{signal.kind}",
                payload={
                    "signal_id": str(signal.id),
                    "kind": signal.kind,
                    "score": signal.score,
                },
                signal_id=signal.id,
                summary=signal.title,
            )
        return signals

    def flush(self, *, annotation: MedicalAnnotation | None = None) -> list[Signal]:
        """Forward any open buckets to the trend detector.

        Call after a batch of observations to evaluate the most recent (still
        open) buckets. Without this, the final bucket remains pending until a
        later observation transitions it.
        """
        signals: list[Signal] = []
        for (keyword, district), bucket in list(self.last_bucket.items()):
            count = self.bucket_counts.get((keyword, district, bucket), 0)
            if count <= 0:
                continue
            start, end = self._bucket_bounds(bucket)
            outcome = self.trend.observe(
                keyword=keyword,
                district=district,
                count=float(count),
                bucket_start=start,
                bucket_end=end,
            )
            if outcome.is_spike and annotation is not None:
                signals.append(self._build_trend_signal(annotation, outcome))
        # Avoid double-counting on subsequent flushes.
        self.last_bucket.clear()
        for signal in signals:
            self.audit.append(
                actor="setu-signals-worker",
                action=f"emit-{signal.kind}",
                payload={
                    "signal_id": str(signal.id),
                    "kind": signal.kind,
                    "score": signal.score,
                },
                signal_id=signal.id,
                summary=signal.title,
            )
        return signals

    # ----------------------------------------------------- signal constructors
    def _now(self) -> datetime:
        return datetime.now(tz=timezone.utc)

    def _common_codes(self, annotation: MedicalAnnotation) -> tuple[CodeMapping, ...]:
        codes: list[CodeMapping] = []
        seen: set[tuple[str, str]] = set()
        for entity in annotation.medical_entities:
            if entity.code_system and entity.code:
                key = (entity.code_system, entity.code)
                if key in seen:
                    continue
                seen.add(key)
                codes.append(
                    CodeMapping(
                        surface=entity.surface,
                        code_system=entity.code_system,
                        code=entity.code,
                        display_name=entity.surface,
                    )
                )
        return tuple(codes)

    def _build_adr_signal(self, annotation: MedicalAnnotation, result) -> Signal:
        adr_stat = AdverseEventStatistic(
            drug=result.drug,
            event=result.event,
            observed=result.observed,
            expected=result.expected,
            prr=result.prr,
            ror=result.ror,
            ic=result.ic,
            ic_lower=result.ic_lower,
            chi_squared=result.chi_squared,
            window_start=result.window_start,
            window_end=result.window_end,
        )
        score = min(1.0, max(0.0, result.prr / 10.0))
        return Signal(
            id=uuid4(),
            project_id=annotation.project_id,
            kind="adr",
            score=score,
            title=f"Possible ADR: {result.drug} ↔ {result.event}",
            explanation=(
                f"PRR={result.prr:.2f}, ROR={result.ror:.2f}, IC={result.ic:.2f} "
                f"(lower 95% {result.ic_lower:.2f}), chi²={result.chi_squared:.2f}, "
                f"observed={result.observed}, expected={result.expected:.2f}."
            ),
            evidence_mention_ids=(annotation.mention_id,),
            codes=self._common_codes(annotation),
            district=None,
            started_at=result.window_start,
            detected_at=self._now(),
            audit_chain_head=self.audit.head,
            adr_stat=adr_stat,
        )

    def _build_trend_signal(self, annotation: MedicalAnnotation, outcome) -> Signal:
        trend_stat = TrendStatistic(
            keyword=outcome.keyword,
            district=outcome.district,
            z_score=outcome.z_score,
            baseline=outcome.baseline,
            current=outcome.current,
            window_start=outcome.window_start,
            window_end=outcome.window_end,
        )
        score = min(1.0, max(0.0, outcome.z_score / 10.0))
        return Signal(
            id=uuid4(),
            project_id=annotation.project_id,
            kind="trend",
            score=score,
            title=f"Volume spike: {outcome.keyword}"
            + (f" in {outcome.district}" if outcome.district else ""),
            explanation=(
                f"z={outcome.z_score:.2f}, current={outcome.current:.1f}, "
                f"baseline={outcome.baseline:.1f}."
            ),
            evidence_mention_ids=(annotation.mention_id,),
            codes=self._common_codes(annotation),
            district=outcome.district,
            started_at=outcome.window_start,
            detected_at=self._now(),
            audit_chain_head=self.audit.head,
            trend_stat=trend_stat,
        )

    def _build_cluster_signal(self, annotation: MedicalAnnotation, outcome) -> Signal:
        cluster_stat = ClusterStatistic(
            centroid_lat=outcome.centroid_lat,
            centroid_lon=outcome.centroid_lon,
            radius_deg=outcome.radius_deg,
            population=outcome.population,
            observed=outcome.observed,
            expected=outcome.expected,
            log_likelihood=outcome.log_likelihood,
            p_value=outcome.p_value,
            window_start=outcome.window_start,
            window_end=outcome.window_end,
        )
        score = min(1.0, max(0.0, outcome.log_likelihood / 20.0))
        return Signal(
            id=uuid4(),
            project_id=annotation.project_id,
            kind="cluster",
            score=score,
            title=(
                f"Spatial cluster ({outcome.observed} reports near "
                f"{outcome.centroid_lat:.1f},{outcome.centroid_lon:.1f})"
            ),
            explanation=(
                f"observed={outcome.observed}, expected={outcome.expected:.2f}, "
                f"LLR={outcome.log_likelihood:.2f}, p≈{outcome.p_value:.3f}."
            ),
            evidence_mention_ids=(annotation.mention_id,),
            codes=self._common_codes(annotation),
            district=None,
            started_at=outcome.window_start,
            detected_at=self._now(),
            audit_chain_head=self.audit.head,
            cluster_stat=cluster_stat,
        )

    def observe_many(
        self,
        annotations: Iterable[tuple[MedicalAnnotation, str | None, float | None, float | None, datetime]],
    ) -> list[Signal]:
        emitted: list[Signal] = []
        for ann, district, lat, lon, ts in annotations:
            emitted.extend(
                self.observe(ann, district=district, latitude=lat, longitude=lon, timestamp=ts)
            )
        return emitted


__all__ = ["AggregatorConfig", "SignalAggregator"]
