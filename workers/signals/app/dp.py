"""Differential privacy noise utilities for the SETU signals worker.

Implements the Laplace mechanism with an epsilon-aware budget tracker so
public-facing aggregates (cluster counts, district trends) can be perturbed
before they leave the platform. The Laplace mechanism adds noise drawn from
``Lap(sensitivity / epsilon)`` to a numeric query result and provides
``epsilon``-differential privacy when ``sensitivity`` upper-bounds the L1
sensitivity of the query.

The module is intentionally dependency-free (uses ``random`` only) so it can
be exercised by unit tests with a seeded :class:`random.Random` for
deterministic verification.

Key invariants enforced at the boundary:

* ``epsilon`` and ``sensitivity`` are strictly positive floats.
* The budget tracker rejects queries that would exceed the remaining budget
  *before* drawing noise so callers can safely retry with a smaller epsilon.
* ``laplace_noise`` returns a single sample from ``Lap(0, scale)`` where
  ``scale = sensitivity / epsilon``.

This module does not implement advanced composition (only basic sequential
composition); upstream callers that need tighter accounting should plug in
their own accountant.
"""

from __future__ import annotations

import math
import random
from dataclasses import dataclass, field

__all__ = [
    "PrivacyBudgetExhausted",
    "DPParameters",
    "PrivacyAccountant",
    "laplace_noise",
    "noisy_count",
    "noisy_sum",
]


class PrivacyBudgetExhausted(RuntimeError):
    """Raised when a query would exceed the remaining epsilon budget."""


@dataclass(slots=True, frozen=True)
class DPParameters:
    """Parameters for a single Laplace-mechanism query."""

    epsilon: float
    sensitivity: float

    def __post_init__(self) -> None:
        if not math.isfinite(self.epsilon) or self.epsilon <= 0:
            raise ValueError("epsilon must be a finite positive float")
        if not math.isfinite(self.sensitivity) or self.sensitivity <= 0:
            raise ValueError("sensitivity must be a finite positive float")

    @property
    def scale(self) -> float:
        return self.sensitivity / self.epsilon


def laplace_noise(scale: float, *, rng: random.Random | None = None) -> float:
    """Draw a single sample from ``Lap(0, scale)``.

    Uses inverse-CDF sampling so the result is deterministic for a seeded
    :class:`random.Random` instance.
    """
    if not math.isfinite(scale) or scale <= 0:
        raise ValueError("scale must be a finite positive float")
    rng = rng if rng is not None else random.Random()
    # Sample u ∈ (-0.5, 0.5) and apply Laplace inverse CDF.
    u = rng.random() - 0.5
    sign = -1.0 if u < 0 else 1.0
    # Clamp to avoid log(0); the open interval is (-0.5, 0.5) but random()
    # returns [0.0, 1.0), so u may equal -0.5 exactly.
    magnitude = max(1e-12, 1.0 - 2.0 * abs(u))
    return -scale * sign * math.log(magnitude)


def noisy_count(
    true_count: int,
    params: DPParameters,
    *,
    rng: random.Random | None = None,
    non_negative: bool = True,
) -> float:
    """Add Laplace noise to an integer count.

    When ``non_negative`` is true the result is clamped at zero, which is the
    customary post-processing for count queries (post-processing preserves the
    DP guarantee).
    """
    noisy = float(true_count) + laplace_noise(params.scale, rng=rng)
    return max(0.0, noisy) if non_negative else noisy


def noisy_sum(
    true_sum: float,
    params: DPParameters,
    *,
    rng: random.Random | None = None,
) -> float:
    """Add Laplace noise to a numeric sum query."""
    return true_sum + laplace_noise(params.scale, rng=rng)


@dataclass(slots=True)
class PrivacyAccountant:
    """Sequential-composition epsilon accountant.

    Tracks the cumulative epsilon spent across queries and refuses queries
    that would breach the configured ``budget``. This is *basic* sequential
    composition: epsilons add up. Callers needing advanced/RDP composition
    should implement their own accountant.
    """

    budget: float
    spent: float = 0.0
    rng: random.Random = field(default_factory=random.Random)

    def __post_init__(self) -> None:
        if not math.isfinite(self.budget) or self.budget <= 0:
            raise ValueError("budget must be a finite positive float")
        if self.spent < 0:
            raise ValueError("spent must be non-negative")

    @property
    def remaining(self) -> float:
        return max(0.0, self.budget - self.spent)

    def can_spend(self, epsilon: float) -> bool:
        return epsilon > 0 and (self.spent + epsilon) <= self.budget + 1e-12

    def _charge(self, epsilon: float) -> None:
        if not self.can_spend(epsilon):
            raise PrivacyBudgetExhausted(
                f"requested epsilon={epsilon} exceeds remaining budget "
                f"{self.remaining} (budget={self.budget}, spent={self.spent})"
            )
        self.spent += epsilon

    def noisy_count(self, true_count: int, params: DPParameters, *, non_negative: bool = True) -> float:
        self._charge(params.epsilon)
        return noisy_count(true_count, params, rng=self.rng, non_negative=non_negative)

    def noisy_sum(self, true_sum: float, params: DPParameters) -> float:
        self._charge(params.epsilon)
        return noisy_sum(true_sum, params, rng=self.rng)
