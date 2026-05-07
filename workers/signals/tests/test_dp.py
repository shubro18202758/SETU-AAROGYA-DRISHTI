"""Tests for the differential-privacy noise utilities."""

from __future__ import annotations

import math
import random
import statistics

import pytest

from workers.signals.app.dp import (
    DPParameters,
    PrivacyAccountant,
    PrivacyBudgetExhausted,
    laplace_noise,
    noisy_count,
    noisy_sum,
)


def test_dp_parameters_validation() -> None:
    with pytest.raises(ValueError):
        DPParameters(epsilon=0, sensitivity=1)
    with pytest.raises(ValueError):
        DPParameters(epsilon=-0.1, sensitivity=1)
    with pytest.raises(ValueError):
        DPParameters(epsilon=1, sensitivity=0)
    with pytest.raises(ValueError):
        DPParameters(epsilon=math.inf, sensitivity=1)


def test_dp_parameters_scale() -> None:
    p = DPParameters(epsilon=0.5, sensitivity=1.0)
    assert p.scale == pytest.approx(2.0)


def test_laplace_noise_is_deterministic_with_seeded_rng() -> None:
    rng_a = random.Random(42)
    rng_b = random.Random(42)
    samples_a = [laplace_noise(1.5, rng=rng_a) for _ in range(50)]
    samples_b = [laplace_noise(1.5, rng=rng_b) for _ in range(50)]
    assert samples_a == samples_b


def test_laplace_noise_zero_mean_unit_variance() -> None:
    """Empirical mean ~0 and variance ~2*scale^2 over many samples."""
    rng = random.Random(2024)
    scale = 1.0
    n = 5000
    samples = [laplace_noise(scale, rng=rng) for _ in range(n)]
    mean = statistics.fmean(samples)
    var = statistics.pvariance(samples)
    # Laplace(0, b) has mean 0 and variance 2*b^2 = 2.
    assert abs(mean) < 0.1, f"mean too large: {mean}"
    assert 1.5 < var < 2.5, f"variance off: {var}"


def test_laplace_noise_invalid_scale() -> None:
    with pytest.raises(ValueError):
        laplace_noise(0.0)
    with pytest.raises(ValueError):
        laplace_noise(-1.0)


def test_noisy_count_clamps_at_zero_by_default() -> None:
    rng = random.Random(0)
    # tiny sensitivity, large epsilon → very small noise scale
    params = DPParameters(epsilon=10.0, sensitivity=1.0)
    val = noisy_count(0, params, rng=rng)
    assert val >= 0.0


def test_noisy_count_can_be_negative_when_unclamped() -> None:
    rng = random.Random(1)
    params = DPParameters(epsilon=0.01, sensitivity=1.0)  # huge noise
    # Try a few seeds to find a negative one — guaranteed eventually.
    saw_negative = False
    for seed in range(20):
        v = noisy_count(0, params, rng=random.Random(seed), non_negative=False)
        if v < 0:
            saw_negative = True
            break
    assert saw_negative, "noisy_count(non_negative=False) should permit negatives"


def test_noisy_sum_adds_noise_around_true_value() -> None:
    rng = random.Random(7)
    params = DPParameters(epsilon=2.0, sensitivity=1.0)
    samples = [noisy_sum(100.0, params, rng=rng) for _ in range(2000)]
    mean = statistics.fmean(samples)
    assert abs(mean - 100.0) < 1.0


def test_privacy_accountant_tracks_budget() -> None:
    acct = PrivacyAccountant(budget=1.0, rng=random.Random(0))
    assert acct.remaining == 1.0
    acct.noisy_count(5, DPParameters(epsilon=0.4, sensitivity=1.0))
    assert acct.spent == pytest.approx(0.4)
    assert acct.remaining == pytest.approx(0.6)
    acct.noisy_sum(10.0, DPParameters(epsilon=0.5, sensitivity=1.0))
    assert acct.spent == pytest.approx(0.9)


def test_privacy_accountant_refuses_overspend() -> None:
    acct = PrivacyAccountant(budget=0.5, rng=random.Random(0))
    acct.noisy_count(3, DPParameters(epsilon=0.4, sensitivity=1.0))
    with pytest.raises(PrivacyBudgetExhausted):
        acct.noisy_count(2, DPParameters(epsilon=0.2, sensitivity=1.0))
    # The failed query must not have charged the budget.
    assert acct.spent == pytest.approx(0.4)


def test_privacy_accountant_can_spend_predicate() -> None:
    acct = PrivacyAccountant(budget=1.0)
    assert acct.can_spend(0.5)
    assert acct.can_spend(1.0)
    assert not acct.can_spend(1.1)
    assert not acct.can_spend(0.0)


def test_privacy_accountant_validation() -> None:
    with pytest.raises(ValueError):
        PrivacyAccountant(budget=0)
    with pytest.raises(ValueError):
        PrivacyAccountant(budget=1.0, spent=-0.1)
