"""ADR (Adverse Drug Reaction) disproportionality statistics.

Implements PRR (Proportional Reporting Ratio), ROR (Reporting Odds Ratio),
and IC (Information Component, Bayesian shrinkage estimator used by the WHO
Uppsala Monitoring Centre). Pure-Python — no numpy/scipy required so the
worker fits in a slim container.

References (open):
* Evans et al., "Use of proportional reporting ratios (PRRs)…" (2001).
* Bate & Evans, "Quantitative signal detection using IC", 2009.
* WHO-UMC vigiBase signal detection methodology.

Thresholds match the conventional WHO-UMC / EMA regulatory floor:
    PRR ≥ 2 AND chi-squared (Yates) ≥ 4 AND observed ≥ 3
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from datetime import datetime
from typing import Final, Mapping

# A tiny constant guards against log(0) / divide-by-zero on edge counts.
_EPS: Final[float] = 0.5  # standard Haldane–Anscombe correction


@dataclass(frozen=True, slots=True)
class ContingencyCounts:
    """2x2 contingency for (drug=D, event=E) vs the rest of the database."""

    a: int  # D & E
    b: int  # D & ¬E
    c: int  # ¬D & E
    d: int  # ¬D & ¬E

    @property
    def n(self) -> int:
        return self.a + self.b + self.c + self.d


@dataclass(frozen=True, slots=True)
class ADRResult:
    drug: str
    event: str
    observed: int
    expected: float
    prr: float
    ror: float
    ic: float
    ic_lower: float
    chi_squared: float
    window_start: datetime
    window_end: datetime
    is_signal: bool


def chi_squared_yates(counts: ContingencyCounts) -> float:
    """Yates-corrected chi-squared for a 2x2 table."""
    a, b, c, d = counts.a, counts.b, counts.c, counts.d
    n = counts.n
    if n == 0:
        return 0.0
    row1 = a + b
    row2 = c + d
    col1 = a + c
    col2 = b + d
    if row1 == 0 or row2 == 0 or col1 == 0 or col2 == 0:
        return 0.0
    numerator = n * max(0.0, abs(a * d - b * c) - n / 2.0) ** 2
    denominator = float(row1 * row2 * col1 * col2)
    return numerator / denominator


def proportional_reporting_ratio(counts: ContingencyCounts) -> float:
    a, b, c, d = counts.a, counts.b, counts.c, counts.d
    drug_total = a + b
    other_total = c + d
    if drug_total == 0 or other_total == 0:
        return 0.0
    p_event_given_drug = (a + _EPS) / (drug_total + _EPS)
    p_event_given_other = (c + _EPS) / (other_total + _EPS)
    if p_event_given_other == 0:
        return 0.0
    return p_event_given_drug / p_event_given_other


def reporting_odds_ratio(counts: ContingencyCounts) -> float:
    a = counts.a + _EPS
    b = counts.b + _EPS
    c = counts.c + _EPS
    d = counts.d + _EPS
    return (a * d) / (b * c)


def information_component(counts: ContingencyCounts) -> tuple[float, float]:
    """Bayesian shrinkage IC with 95% credibility lower bound.

    Implements the BCPNN simplification used in vigiBase: IC = log2(observed /
    expected) with a posterior variance approximation. Returns (ic, ic_lower).
    """
    a = counts.a
    n = counts.n
    if n == 0:
        return 0.0, 0.0
    drug_total = counts.a + counts.b
    event_total = counts.a + counts.c
    if drug_total == 0 or event_total == 0:
        return 0.0, 0.0
    expected = (drug_total * event_total) / n
    if expected <= 0:
        return 0.0, 0.0
    ic = math.log2((a + _EPS) / (expected + _EPS))
    # Approximate variance of IC (Bate 1998): 1/ln(2)^2 * (1/(a+0.5) - 1/n + ...)
    # We use the conservative form: var ≈ 1/(a+0.5).
    variance = 1.0 / max(a + _EPS, 1.0)
    sd = math.sqrt(variance) / math.log(2)
    return ic, ic - 1.96 * sd


def evaluate(
    drug: str,
    event: str,
    counts: ContingencyCounts,
    *,
    window_start: datetime,
    window_end: datetime,
    min_observed: int = 3,
    min_prr: float = 2.0,
    min_chi_squared: float = 4.0,
) -> ADRResult:
    """Compute all four statistics + signal verdict for a single (drug, event)."""
    prr = proportional_reporting_ratio(counts)
    ror = reporting_odds_ratio(counts)
    ic, ic_lower = information_component(counts)
    chi2 = chi_squared_yates(counts)
    drug_total = counts.a + counts.b
    event_total = counts.a + counts.c
    expected = (drug_total * event_total) / counts.n if counts.n else 0.0

    is_signal = (
        counts.a >= min_observed
        and prr >= min_prr
        and chi2 >= min_chi_squared
    )

    return ADRResult(
        drug=drug,
        event=event,
        observed=counts.a,
        expected=max(expected, _EPS),
        prr=max(prr, _EPS),
        ror=max(ror, _EPS),
        ic=ic,
        ic_lower=ic_lower,
        chi_squared=max(chi2, _EPS),
        window_start=window_start,
        window_end=window_end,
        is_signal=is_signal,
    )


def build_contingency(
    drug: str,
    event: str,
    counts_by_pair: Mapping[tuple[str, str], int],
) -> ContingencyCounts:
    """Materialise a 2x2 table from a (drug, event) → count mapping."""
    a = counts_by_pair.get((drug, event), 0)
    b = sum(v for (d, e), v in counts_by_pair.items() if d == drug and e != event)
    c = sum(v for (d, e), v in counts_by_pair.items() if d != drug and e == event)
    d = sum(v for (d_, e), v in counts_by_pair.items() if d_ != drug and e != event)
    return ContingencyCounts(a=a, b=b, c=c, d=d)


__all__ = [
    "ContingencyCounts",
    "ADRResult",
    "chi_squared_yates",
    "proportional_reporting_ratio",
    "reporting_odds_ratio",
    "information_component",
    "evaluate",
    "build_contingency",
]
