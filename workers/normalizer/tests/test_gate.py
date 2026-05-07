"""Tests for the normalizer's MemoryPressureGate."""

from __future__ import annotations

import pytest

from workers.normalizer.app.gate import MemoryPressureGate


@pytest.mark.asyncio
async def test_acquire_is_noop_under_low_pressure() -> None:
    sleeps: list[float] = []

    async def fake_sleep(s: float) -> None:
        sleeps.append(s)

    gate = MemoryPressureGate(
        high_watermark=0.85,
        low_watermark=0.70,
        poll_interval_s=0.01,
        sampler=lambda: 0.10,
        sleep=fake_sleep,
    )
    await gate.acquire()
    assert sleeps == []
    assert not gate.closed
    assert gate.wait_count == 0


@pytest.mark.asyncio
async def test_acquire_blocks_until_pressure_recedes_below_low_watermark() -> None:
    pressures = iter([0.90, 0.88, 0.80, 0.65])  # high, still high, between, recovered
    sleeps: list[float] = []

    def sampler() -> float:
        return next(pressures)

    async def fake_sleep(s: float) -> None:
        sleeps.append(s)

    gate = MemoryPressureGate(
        high_watermark=0.85,
        low_watermark=0.70,
        poll_interval_s=0.5,
        sampler=sampler,
        sleep=fake_sleep,
    )
    await gate.acquire()
    # 1st sample: 0.90 (high → close, sleep). 2nd: 0.88 (still high, sleep).
    # 3rd: 0.80 (between, sleep). 4th: 0.65 (< low → reopen, return).
    assert sleeps == [0.5, 0.5, 0.5]
    assert not gate.closed
    assert gate.wait_count == 1
    assert gate.last_pressure == pytest.approx(0.65)


@pytest.mark.asyncio
async def test_gate_hysteresis_keeps_gate_closed_between_watermarks() -> None:
    # First call: sample 0.90 → closes, then 0.75 (above low) sleep, then 0.60 reopens.
    pressures = iter([0.90, 0.75, 0.60, 0.10])
    sleeps: list[float] = []

    gate = MemoryPressureGate(
        high_watermark=0.85,
        low_watermark=0.70,
        poll_interval_s=0.1,
        sampler=lambda: next(pressures),
        sleep=lambda s: _append(sleeps, s),
    )
    await gate.acquire()
    assert gate.wait_count == 1
    # Second acquire with pressure 0.10 → no-op.
    await gate.acquire()
    assert gate.wait_count == 1
    assert not gate.closed


async def _append(buf: list[float], s: float) -> None:
    buf.append(s)


def test_invalid_watermarks_raise() -> None:
    with pytest.raises(ValueError):
        MemoryPressureGate(high_watermark=0.5, low_watermark=0.7)
    with pytest.raises(ValueError):
        MemoryPressureGate(high_watermark=0.8, low_watermark=0.7, poll_interval_s=0.0)


@pytest.mark.asyncio
async def test_async_sampler_is_awaited() -> None:
    async def async_sampler() -> float:
        return 0.1

    gate = MemoryPressureGate(sampler=async_sampler)
    await gate.acquire()
    assert gate.last_pressure == pytest.approx(0.1)


@pytest.mark.asyncio
async def test_pressure_is_clamped_to_unit_interval() -> None:
    gate = MemoryPressureGate(sampler=lambda: -0.5)
    await gate.acquire()
    assert gate.last_pressure == 0.0

    gate2 = MemoryPressureGate(sampler=lambda: 99.0, poll_interval_s=0.01)
    # Will close on the first sample but never recover; provide a recovery
    # sequence via a list-backed sampler instead:
    seq = iter([99.0, 0.0])
    sleeps: list[float] = []

    async def fake_sleep(s: float) -> None:
        sleeps.append(s)

    gate3 = MemoryPressureGate(
        sampler=lambda: next(seq),
        sleep=fake_sleep,
        poll_interval_s=0.01,
    )
    await gate3.acquire()
    assert gate3.last_pressure == 0.0
    assert sleeps == [0.01]
