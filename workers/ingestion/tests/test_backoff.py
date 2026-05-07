"""Tests for the SETU connector circuit breaker."""

from __future__ import annotations

import pytest

from workers.ingestion.app.setu.backoff import ConnectorBreakers


def test_initial_state_is_healthy_and_closed() -> None:
    breakers = ConnectorBreakers()
    assert breakers.health("src-1") == 1.0
    assert not breakers.is_open("src-1")
    assert not breakers.should_skip("src-1")
    assert breakers.next_delay("src-1", base=10.0) == 10.0


def test_repeated_failures_open_breaker_below_threshold() -> None:
    breakers = ConnectorBreakers(
        open_threshold=0.3,
        close_threshold=0.7,
        alpha=0.5,  # aggressive: each failure pulls health towards 0
        backoff_base=2.0,
        backoff_max=8.0,
    )
    sid = "src-flaky"
    # Health: 1.0 → 0.5 → 0.25 (open)
    breakers.record(sid, success=False)
    assert breakers.health(sid) == pytest.approx(0.5)
    assert not breakers.is_open(sid)
    breakers.record(sid, success=False)
    assert breakers.health(sid) == pytest.approx(0.25)
    assert breakers.is_open(sid)
    assert breakers.should_skip(sid)


def test_open_breaker_uses_exponential_backoff_capped_at_max() -> None:
    breakers = ConnectorBreakers(
        open_threshold=0.3,
        alpha=0.9,
        backoff_base=2.0,
        backoff_max=8.0,
    )
    sid = "src-bad"
    # 3 failures → health goes very low; consecutive_failures = 3
    for _ in range(3):
        breakers.record(sid, success=False)
    assert breakers.is_open(sid)
    # multiplier = 2 ** (3-1) = 4 → delay = 4 * base
    assert breakers.next_delay(sid, base=5.0) == pytest.approx(20.0)
    # Many more failures: capped at backoff_max=8
    for _ in range(10):
        breakers.record(sid, success=False)
    assert breakers.next_delay(sid, base=5.0) == pytest.approx(40.0)


def test_successful_probe_recovers_breaker_when_health_crosses_close_threshold() -> None:
    breakers = ConnectorBreakers(
        open_threshold=0.3,
        close_threshold=0.7,
        alpha=0.5,
    )
    sid = "src-recovering"
    # Open it.
    for _ in range(3):
        breakers.record(sid, success=False)
    assert breakers.is_open(sid)

    # Successes: 0.125 → 0.5625 (still open) → 0.78125 (>= 0.7, close)
    breakers.record(sid, success=True)
    assert breakers.is_open(sid)
    breakers.record(sid, success=True)
    assert not breakers.is_open(sid)
    assert breakers.snapshot()[sid]["consecutive_failures"] == 0


def test_success_resets_consecutive_failure_count() -> None:
    breakers = ConnectorBreakers(alpha=0.5)
    sid = "src-mixed"
    breakers.record(sid, success=False)
    breakers.record(sid, success=False)
    snap = breakers.snapshot()[sid]
    assert snap["consecutive_failures"] == 2
    breakers.record(sid, success=True)
    snap = breakers.snapshot()[sid]
    assert snap["consecutive_failures"] == 0


def test_invalid_thresholds_raise() -> None:
    with pytest.raises(ValueError):
        ConnectorBreakers(open_threshold=0.7, close_threshold=0.3)
    with pytest.raises(ValueError):
        ConnectorBreakers(alpha=0.0)
    with pytest.raises(ValueError):
        ConnectorBreakers(backoff_base=1.0)
    with pytest.raises(ValueError):
        ConnectorBreakers(backoff_base=2.0, backoff_max=1.0)


def test_snapshot_exposes_breaker_state() -> None:
    breakers = ConnectorBreakers()
    breakers.record("a", success=True)
    breakers.record("b", success=False)
    snap = breakers.snapshot()
    assert set(snap.keys()) == {"a", "b"}
    assert snap["a"]["health"] > snap["b"]["health"]
