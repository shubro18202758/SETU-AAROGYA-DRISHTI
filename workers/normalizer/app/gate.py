"""Memory-pressure gate for the SETU normalizer.

The normalizer co-resides with Qwen-3.5-4B and IndicTrans2 distilled on an
8 GB VRAM box. When system memory pressure (RSS or VRAM) gets close to the
limit we must throttle ingestion rather than OOM-crash. This module
implements an asyncio-friendly back-pressure gate that is:

* Pure-Python / dependency-free at import time. ``psutil`` is optional and
  only consulted by the default sampler when present.
* Test-friendly: the pressure source is an injectable callable returning a
  float in ``[0.0, 1.0]`` (1.0 == fully exhausted).
* Backward-compatible: no callsite is forced to use it. The normalizer
  worker will ``await gate.acquire()`` before each pipeline invocation;
  when pressure stays under the high-watermark the call is a no-op.

Two-watermark hysteresis avoids flapping:

* ``high_watermark`` (default 0.85) — once crossed, the gate closes.
* ``low_watermark``  (default 0.70) — gate stays closed until pressure
  recedes below this value, then re-opens.
"""

from __future__ import annotations

import asyncio
import logging
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from typing import Final

LOGGER = logging.getLogger("setu.normalizer.gate")

PressureSampler = Callable[[], float] | Callable[[], Awaitable[float]]


def _default_sampler() -> float:
    """Return host memory pressure in ``[0.0, 1.0]`` using ``psutil`` if available."""
    try:
        import psutil  # type: ignore[import-not-found]
    except ImportError:
        return 0.0
    try:
        return float(psutil.virtual_memory().percent) / 100.0
    except Exception:  # noqa: BLE001 - psutil platform quirks
        return 0.0


_DEFAULT_HIGH: Final[float] = 0.85
_DEFAULT_LOW: Final[float] = 0.70
_DEFAULT_POLL: Final[float] = 0.5


@dataclass(slots=True)
class MemoryPressureGate:
    """Asyncio gate that blocks while system memory pressure is high."""

    high_watermark: float = _DEFAULT_HIGH
    low_watermark: float = _DEFAULT_LOW
    poll_interval_s: float = _DEFAULT_POLL
    sampler: PressureSampler = field(default=_default_sampler)
    sleep: Callable[[float], Awaitable[None]] = field(default=asyncio.sleep)
    _closed: bool = field(default=False, init=False)
    _waits: int = field(default=0, init=False)
    _last_pressure: float = field(default=0.0, init=False)

    def __post_init__(self) -> None:
        if not 0.0 < self.low_watermark < self.high_watermark <= 1.0:
            raise ValueError(
                "expected 0 < low_watermark < high_watermark <= 1, "
                f"got low={self.low_watermark} high={self.high_watermark}"
            )
        if self.poll_interval_s <= 0:
            raise ValueError(f"poll_interval_s must be > 0, got {self.poll_interval_s}")

    @property
    def closed(self) -> bool:
        """True iff the gate is currently throttling callers."""
        return self._closed

    @property
    def wait_count(self) -> int:
        """Number of times :meth:`acquire` has had to sleep at least once."""
        return self._waits

    @property
    def last_pressure(self) -> float:
        return self._last_pressure

    async def _sample(self) -> float:
        result = self.sampler()
        if asyncio.iscoroutine(result):
            value = await result
        else:
            value = result  # type: ignore[assignment]
        try:
            pressure = float(value)
        except (TypeError, ValueError):
            return 0.0
        if pressure < 0.0:
            pressure = 0.0
        elif pressure > 1.0:
            pressure = 1.0
        self._last_pressure = pressure
        return pressure

    async def acquire(self) -> None:
        """Block until pressure is acceptable. No-op on the happy path."""
        pressure = await self._sample()
        if not self._closed and pressure < self.high_watermark:
            return

        # Either we just crossed high, or we are already closed and waiting
        # for low watermark.
        if not self._closed:
            self._closed = True
            LOGGER.warning(
                "memory pressure %.2f >= %.2f; closing gate", pressure, self.high_watermark
            )

        slept = False
        while True:
            if pressure < self.low_watermark:
                if self._closed:
                    LOGGER.info(
                        "memory pressure %.2f < %.2f; reopening gate",
                        pressure,
                        self.low_watermark,
                    )
                self._closed = False
                if slept:
                    self._waits += 1
                return
            await self.sleep(self.poll_interval_s)
            slept = True
            pressure = await self._sample()


__all__ = ["MemoryPressureGate", "PressureSampler"]
