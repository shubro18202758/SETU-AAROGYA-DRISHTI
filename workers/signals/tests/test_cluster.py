"""Tests for the Poisson grid scanner."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

from workers.signals.app.cluster import Observation, PoissonGridScanner


NOW = datetime(2025, 10, 14, tzinfo=timezone.utc)


def test_no_clusters_for_empty_input():
    scanner = PoissonGridScanner()
    assert scanner.scan(now=NOW) == ()


def test_concentrated_observations_form_cluster():
    scanner = PoissonGridScanner(cell_deg=1.0, window_days=7, min_observed=3, min_log_likelihood=2.0)
    # 8 reports in roughly the same 1° cell (Palakkad ~10.78N, 76.65E).
    for i in range(8):
        scanner.observe(
            Observation(lat=10.7 + 0.01 * i, lon=76.6 + 0.01 * i, timestamp=NOW - timedelta(hours=i))
        )
    # And a few scattered reports far away.
    scanner.observe(Observation(lat=-20.0, lon=-50.0, timestamp=NOW - timedelta(days=1)))
    scanner.observe(Observation(lat=40.0, lon=80.0, timestamp=NOW - timedelta(days=2)))

    outcomes = scanner.scan(now=NOW)
    clusters = [o for o in outcomes if o.is_cluster]
    assert len(clusters) >= 1
    top = clusters[0]
    assert 10 <= top.centroid_lat <= 11
    assert 76 <= top.centroid_lon <= 77
    assert top.observed >= 3


def test_excludes_observations_outside_window():
    scanner = PoissonGridScanner(cell_deg=1.0, window_days=7, min_observed=3)
    for _ in range(10):
        scanner.observe(Observation(lat=10.5, lon=76.5, timestamp=NOW - timedelta(days=30)))
    outcomes = scanner.scan(now=NOW)
    # All observations are stale; nothing should remain in-window.
    assert outcomes == ()
