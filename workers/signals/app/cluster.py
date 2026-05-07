"""Spatio-temporal cluster detection — Poisson grid scan stub.

Buckets observations into a coarse lat/lon grid (default 1° cells) over a
sliding day-window. For each cell, computes a Poisson log-likelihood ratio
against the global rate and surfaces cells whose excess is unlikely under the
null. Conservative defaults; a future iteration can swap in SatScan-style
Kulldorff scan or BOCPD.

Pure stdlib (math). No scipy required.
"""

from __future__ import annotations

import math
from collections import defaultdict
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from typing import Iterable


@dataclass(frozen=True, slots=True)
class Observation:
    lat: float
    lon: float
    timestamp: datetime
    weight: float = 1.0


@dataclass(frozen=True, slots=True)
class ClusterOutcome:
    centroid_lat: float
    centroid_lon: float
    radius_deg: float
    observed: int
    expected: float
    log_likelihood: float
    p_value: float
    population: int
    window_start: datetime
    window_end: datetime
    is_cluster: bool


@dataclass(slots=True)
class PoissonGridScanner:
    cell_deg: float = 1.0
    window_days: int = 7
    min_observed: int = 3
    min_log_likelihood: float = 4.0
    _observations: list[Observation] = field(default_factory=list)

    def observe(self, observation: Observation) -> None:
        self._observations.append(observation)

    def observe_many(self, observations: Iterable[Observation]) -> None:
        for o in observations:
            self.observe(o)

    def scan(self, *, now: datetime) -> tuple[ClusterOutcome, ...]:
        if not self._observations:
            return ()
        window_start = now - timedelta(days=self.window_days)
        recent = [o for o in self._observations if window_start <= o.timestamp <= now]
        total_weight = sum(o.weight for o in recent)
        if total_weight <= 0:
            return ()

        cells: dict[tuple[int, int], list[Observation]] = defaultdict(list)
        for o in recent:
            key = (
                int(math.floor(o.lat / self.cell_deg)),
                int(math.floor(o.lon / self.cell_deg)),
            )
            cells[key].append(o)

        cell_count = max(len(cells), 1)
        global_rate_per_cell = total_weight / cell_count

        outcomes: list[ClusterOutcome] = []
        for (cy, cx), members in cells.items():
            observed_weight = sum(m.weight for m in members)
            observed = int(round(observed_weight))
            expected = max(global_rate_per_cell, 1e-6)
            llr = _poisson_log_likelihood_ratio(observed_weight, expected)
            p_value = _approximate_chi_p_value(2 * llr)
            centroid_lat = (cy + 0.5) * self.cell_deg
            centroid_lon = (cx + 0.5) * self.cell_deg
            is_cluster = (
                observed >= self.min_observed
                and observed_weight > expected
                and llr >= self.min_log_likelihood
            )
            outcomes.append(
                ClusterOutcome(
                    centroid_lat=centroid_lat,
                    centroid_lon=centroid_lon,
                    radius_deg=self.cell_deg / 2,
                    observed=observed,
                    expected=expected,
                    log_likelihood=llr,
                    p_value=p_value,
                    population=len(members),
                    window_start=window_start,
                    window_end=now,
                    is_cluster=is_cluster,
                )
            )

        outcomes.sort(key=lambda c: c.log_likelihood, reverse=True)
        return tuple(outcomes)

    def reset(self) -> None:
        self._observations.clear()


def _poisson_log_likelihood_ratio(observed: float, expected: float) -> float:
    if observed <= 0 or expected <= 0:
        return 0.0
    if observed <= expected:
        return 0.0
    return observed * math.log(observed / expected) - (observed - expected)


def _approximate_chi_p_value(stat: float) -> float:
    """Survival of chi^2_1 ≈ erfc(sqrt(stat/2)). Clamped to [0, 1]."""
    if stat <= 0:
        return 1.0
    p = math.erfc(math.sqrt(stat / 2.0))
    return max(0.0, min(1.0, p))


__all__ = [
    "Observation",
    "ClusterOutcome",
    "PoissonGridScanner",
]
