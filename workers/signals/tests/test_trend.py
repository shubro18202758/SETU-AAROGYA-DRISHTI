"""Tests for the rolling z-score trend detector."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

from workers.signals.app.trend import TrendDetector


START = datetime(2025, 10, 1, tzinfo=timezone.utc)


def _bucket(day: int) -> tuple[datetime, datetime]:
    s = START + timedelta(days=day)
    return s, s + timedelta(days=1)


def test_no_spike_during_warmup():
    det = TrendDetector(window=14, min_observations=5, min_z=3.0)
    spikes = []
    for day in range(4):  # only 4 obs -> below min_observations
        s, e = _bucket(day)
        out = det.observe(keyword="coldrif", district="palakkad", count=2, bucket_start=s, bucket_end=e)
        if out.is_spike:
            spikes.append(out)
    assert spikes == []


def test_spike_detected_after_baseline_established():
    det = TrendDetector(window=14, min_observations=5, min_z=3.0, alpha=0.3)
    # Stable baseline of 2 reports/day for 7 days.
    for day in range(7):
        s, e = _bucket(day)
        det.observe(keyword="coldrif", district="palakkad", count=2.0, bucket_start=s, bucket_end=e)
    # Sudden surge.
    s, e = _bucket(7)
    out = det.observe(keyword="coldrif", district="palakkad", count=40.0, bucket_start=s, bucket_end=e)
    assert out.is_spike is True
    assert out.z_score > 3.0
    assert out.current == 40.0
    assert out.baseline < 5.0


def test_independent_keywords_have_separate_state():
    det = TrendDetector(window=14, min_observations=3, min_z=2.0)
    for day in range(5):
        s, e = _bucket(day)
        det.observe(keyword="cricket", district=None, count=100.0, bucket_start=s, bucket_end=e)
        det.observe(keyword="coldrif", district=None, count=1.0, bucket_start=s, bucket_end=e)
    s, e = _bucket(5)
    surge = det.observe(keyword="coldrif", district=None, count=20.0, bucket_start=s, bucket_end=e)
    assert surge.is_spike is True
    quiet = det.observe(keyword="cricket", district=None, count=110.0, bucket_start=s, bucket_end=e)
    assert quiet.is_spike is False


def test_district_separation():
    det = TrendDetector(window=14, min_observations=3, min_z=2.0)
    for day in range(5):
        s, e = _bucket(day)
        det.observe(keyword="coldrif", district="chennai", count=2.0, bucket_start=s, bucket_end=e)
    s, e = _bucket(5)
    out = det.observe(keyword="coldrif", district="palakkad", count=2.0, bucket_start=s, bucket_end=e)
    # First sample in palakkad — should not spike (warmup).
    assert out.is_spike is False
