"""Tests for ADR disproportionality statistics."""

from __future__ import annotations

import math
from datetime import datetime, timezone

from workers.signals.app.adr import (
    ContingencyCounts,
    build_contingency,
    chi_squared_yates,
    evaluate,
    information_component,
    proportional_reporting_ratio,
    reporting_odds_ratio,
)


WIN_START = datetime(2025, 10, 1, tzinfo=timezone.utc)
WIN_END = datetime(2025, 10, 14, tzinfo=timezone.utc)


def test_prr_classic_textbook_value():
    # Evans 2001 example-style: a=10, b=20, c=100, d=1000.
    counts = ContingencyCounts(a=10, b=20, c=100, d=1000)
    prr = proportional_reporting_ratio(counts)
    # Expected proportion-with-event in drug arm: ~10/30 = 0.333; in rest: 100/1100 ≈ 0.091.
    # Ratio ≈ 3.67, with Haldane correction slightly lower.
    assert 3.0 < prr < 4.0


def test_ror_with_correction_strictly_positive():
    counts = ContingencyCounts(a=10, b=20, c=100, d=1000)
    ror = reporting_odds_ratio(counts)
    # (10.5*1000.5)/(20.5*100.5) ≈ 5.10
    assert 4.5 < ror < 5.5


def test_ic_positive_when_observed_exceeds_expected():
    counts = ContingencyCounts(a=10, b=20, c=100, d=1000)
    ic, lower = information_component(counts)
    assert ic > 0
    assert lower < ic


def test_ic_zero_when_no_data():
    ic, lower = information_component(ContingencyCounts(0, 0, 0, 0))
    assert ic == 0.0 and lower == 0.0


def test_chi_squared_yates_positive():
    counts = ContingencyCounts(a=10, b=20, c=100, d=1000)
    chi2 = chi_squared_yates(counts)
    assert chi2 > 4.0  # comfortably exceeds the WHO-UMC floor


def test_chi_squared_zero_for_independent_table():
    # Perfectly proportional → chi² ≈ 0.
    counts = ContingencyCounts(a=10, b=10, c=10, d=10)
    chi2 = chi_squared_yates(counts)
    assert chi2 == 0.0 or chi2 < 1.0


def test_evaluate_emits_signal_for_strong_association():
    counts = ContingencyCounts(a=10, b=20, c=100, d=1000)
    result = evaluate(
        "coldrif",
        "aki",
        counts,
        window_start=WIN_START,
        window_end=WIN_END,
    )
    assert result.is_signal is True
    assert result.observed == 10
    assert result.prr > 2.0
    assert result.chi_squared > 4.0
    assert math.isfinite(result.ic)


def test_evaluate_does_not_signal_below_threshold():
    counts = ContingencyCounts(a=2, b=20, c=100, d=1000)  # observed < 3
    result = evaluate("coldrif", "fever", counts, window_start=WIN_START, window_end=WIN_END)
    assert result.is_signal is False


def test_build_contingency_matches_manual_counts():
    pair_counts = {
        ("coldrif", "aki"): 10,
        ("coldrif", "fever"): 5,
        ("paracetamol", "aki"): 3,
        ("paracetamol", "fever"): 50,
    }
    counts = build_contingency("coldrif", "aki", pair_counts)
    assert counts.a == 10
    assert counts.b == 5
    assert counts.c == 3
    assert counts.d == 50


def test_evaluate_handles_zero_counts_gracefully():
    counts = ContingencyCounts(0, 0, 0, 0)
    result = evaluate("x", "y", counts, window_start=WIN_START, window_end=WIN_END)
    assert result.is_signal is False
    assert result.observed == 0
