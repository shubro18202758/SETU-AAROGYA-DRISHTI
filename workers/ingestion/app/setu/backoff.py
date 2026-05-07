"""Per-source health tracker + circuit breaker for SETU connectors.

Goals:

* EWMA health score in ``[0.0, 1.0]`` per source-id (1.0 == perfectly healthy).
* When score drops **below 0.3** the breaker opens: subsequent polls are
  skipped and the next-poll delay grows exponentially (capped).
* On a probe success the breaker half-opens, then fully closes once health
  recovers above the recovery threshold.
* Pure-Python, no external deps. ``time_source`` injectable for tests.

Usage from :mod:`workers.ingestion.app.setu.registry`::

    breaker = ConnectorBreakers()
    if breaker.should_skip(source.id):
        await sleep(breaker.next_delay(source.id, base=interval))
        continue
    result = await poll_once(...)
    breaker.record(source.id, success=result.health.success)
"""

from __future__ import annotations

import logging
import time
from dataclasses import dataclass, field
from typing import Callable

LOGGER = logging.getLogger("setu.ingestion.backoff")

# Tuned for the brief: open below 0.3, fully recover at >= 0.7.
DEFAULT_OPEN_THRESHOLD: float = 0.3
DEFAULT_CLOSE_THRESHOLD: float = 0.7
DEFAULT_ALPHA: float = 0.3  # EWMA weight on the newest sample
DEFAULT_BACKOFF_BASE: float = 2.0
DEFAULT_BACKOFF_MAX: float = 16.0  # max multiplier on the source's interval


@dataclass(slots=True)
class _BreakerState:
    health: float = 1.0
    consecutive_failures: int = 0
    is_open: bool = False
    opened_at: float = 0.0


@dataclass(slots=True)
class ConnectorBreakers:
    """Track health + circuit-breaker state for many sources by id."""

    open_threshold: float = DEFAULT_OPEN_THRESHOLD
    close_threshold: float = DEFAULT_CLOSE_THRESHOLD
    alpha: float = DEFAULT_ALPHA
    backoff_base: float = DEFAULT_BACKOFF_BASE
    backoff_max: float = DEFAULT_BACKOFF_MAX
    time_source: Callable[[], float] = field(default=time.monotonic)
    _states: dict[str, _BreakerState] = field(default_factory=dict, init=False)

    def __post_init__(self) -> None:
        if not 0.0 < self.open_threshold < self.close_threshold <= 1.0:
            raise ValueError(
                "expected 0 < open_threshold < close_threshold <= 1; "
                f"got open={self.open_threshold} close={self.close_threshold}"
            )
        if not 0.0 < self.alpha <= 1.0:
            raise ValueError(f"alpha must be in (0, 1]; got {self.alpha}")
        if self.backoff_base <= 1.0:
            raise ValueError(f"backoff_base must be > 1; got {self.backoff_base}")
        if self.backoff_max < self.backoff_base:
            raise ValueError(
                f"backoff_max must be >= backoff_base; got {self.backoff_max}"
            )

    def _key(self, source_id: object) -> str:
        return str(source_id)

    def _state(self, source_id: object) -> _BreakerState:
        key = self._key(source_id)
        state = self._states.get(key)
        if state is None:
            state = _BreakerState()
            self._states[key] = state
        return state

    # ---- inspection -----------------------------------------------------

    def health(self, source_id: object) -> float:
        return self._state(source_id).health

    def is_open(self, source_id: object) -> bool:
        return self._state(source_id).is_open

    def snapshot(self) -> dict[str, dict[str, float | bool | int]]:
        return {
            key: {
                "health": st.health,
                "is_open": st.is_open,
                "consecutive_failures": st.consecutive_failures,
                "opened_at": st.opened_at,
            }
            for key, st in self._states.items()
        }

    # ---- runtime --------------------------------------------------------

    def should_skip(self, source_id: object) -> bool:
        """Return True if the caller should skip the next poll attempt."""
        state = self._state(source_id)
        return state.is_open

    def next_delay(self, source_id: object, *, base: float) -> float:
        """Compute the sleep delay for an open breaker (or ``base``)."""
        state = self._state(source_id)
        if not state.is_open and state.consecutive_failures == 0:
            return base
        # Exponential growth in the failure count, capped at backoff_max.
        multiplier = min(
            self.backoff_base ** max(state.consecutive_failures - 1, 0),
            self.backoff_max,
        )
        return base * multiplier

    def record(self, source_id: object, *, success: bool) -> None:
        """Update EWMA + breaker state from a poll outcome."""
        state = self._state(source_id)
        sample = 1.0 if success else 0.0
        state.health = (1.0 - self.alpha) * state.health + self.alpha * sample
        if success:
            state.consecutive_failures = 0
            if state.is_open and state.health >= self.close_threshold:
                LOGGER.info(
                    "breaker for source=%s closed (health=%.2f)", source_id, state.health
                )
                state.is_open = False
                state.opened_at = 0.0
        else:
            state.consecutive_failures += 1
            if not state.is_open and state.health < self.open_threshold:
                state.is_open = True
                state.opened_at = self.time_source()
                LOGGER.warning(
                    "breaker for source=%s opened (health=%.2f, failures=%d)",
                    source_id,
                    state.health,
                    state.consecutive_failures,
                )


__all__ = [
    "ConnectorBreakers",
    "DEFAULT_OPEN_THRESHOLD",
    "DEFAULT_CLOSE_THRESHOLD",
    "DEFAULT_ALPHA",
    "DEFAULT_BACKOFF_BASE",
    "DEFAULT_BACKOFF_MAX",
]
