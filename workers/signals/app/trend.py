"""Trend detection — rolling z-score with EWMA baseline.

Counts arrive as (timestamp, keyword, district) buckets. The detector keeps a
fixed-size deque per (keyword, district) and emits a TrendOutcome when the
current bucket's count exceeds the EWMA baseline by ``min_z`` standard
deviations.

Pure stdlib; no pandas/numpy needed for the demo workload.
"""

from __future__ import annotations

import math
from collections import deque
from dataclasses import dataclass, field
from datetime import datetime
from typing import Deque


@dataclass(frozen=True, slots=True)
class TrendOutcome:
    keyword: str
    district: str | None
    z_score: float
    baseline: float
    current: float
    window_start: datetime
    window_end: datetime
    is_spike: bool


@dataclass(slots=True)
class _Series:
    counts: Deque[float]
    timestamps: Deque[datetime]
    ewma: float = 0.0
    ewma_var: float = 0.0
    initialised: bool = False


@dataclass(slots=True)
class TrendDetector:
    """Per-(keyword, district) rolling baseline + spike detector."""

    window: int = 14
    alpha: float = 0.3  # EWMA smoothing for the baseline
    min_observations: int = 5
    min_z: float = 3.0
    _series: dict[tuple[str, str | None], _Series] = field(default_factory=dict)

    def observe(
        self,
        *,
        keyword: str,
        district: str | None,
        count: float,
        bucket_start: datetime,
        bucket_end: datetime,
    ) -> TrendOutcome:
        key = (keyword, district)
        series = self._series.get(key)
        if series is None:
            series = _Series(counts=deque(maxlen=self.window), timestamps=deque(maxlen=self.window))
            self._series[key] = series

        # Compute outcome against the *previous* baseline before folding the
        # new observation in — that way the spike isn't smoothed away.
        baseline = series.ewma if series.initialised else max(count, 1.0)
        variance = series.ewma_var if series.initialised else 1.0
        std_dev = math.sqrt(max(variance, 1.0))
        z = (count - baseline) / std_dev if std_dev > 0 else 0.0
        is_spike = (
            len(series.counts) >= self.min_observations
            and z >= self.min_z
            and count >= max(baseline * 1.5, 3.0)
        )

        # Update rolling state.
        series.counts.append(count)
        series.timestamps.append(bucket_end)
        if not series.initialised:
            series.ewma = count
            series.ewma_var = max(count, 1.0)
            series.initialised = True
        else:
            prev = series.ewma
            series.ewma = self.alpha * count + (1 - self.alpha) * prev
            series.ewma_var = (
                self.alpha * (count - prev) ** 2 + (1 - self.alpha) * series.ewma_var
            )

        return TrendOutcome(
            keyword=keyword,
            district=district,
            z_score=z,
            baseline=max(baseline, 1e-6),
            current=max(count, 1e-6),
            window_start=bucket_start,
            window_end=bucket_end,
            is_spike=is_spike,
        )

    def reset(self) -> None:
        self._series.clear()


__all__ = ["TrendDetector", "TrendOutcome"]
