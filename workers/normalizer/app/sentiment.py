"""Lightweight sentiment scoring.

The default :class:`LexiconSentiment` is a transparent rule-based scorer with
a small bilingual cue list. The model is intentionally simple (and safe) — it
exists to seed the SETU triage heuristics with directional polarity for
patient-experience signals; advanced classifiers should override the
:class:`SentimentAnalyzer` Protocol later.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Protocol

from backend.app.schemas.health import SentimentScore

_POSITIVE = (
    "good", "great", "better", "relief", "thanks", "helpful", "safe",
    "अच्छा", "बेहतर", "ठीक", "நன்றி", "మంచి", "ಚೆನ್ನಾಗಿದೆ",
)
_NEGATIVE = (
    "bad", "worse", "pain", "vomit", "vomiting", "fever", "die", "death",
    "danger", "dangerous", "fake", "scared", "afraid", "harm", "harmful",
    "खराब", "दर्द", "मौत", "खतरा", "வலி", "నొప్పి", "ಸಾವು",
)
_SUBJECTIVE_CUES = ("i ", "we ", "my ", "मेरा", "எங்கள்", "మా", "ನನ್ನ", "feel", "think", "believe")


def _count_hits(text: str, cues: tuple[str, ...]) -> int:
    lowered = text.lower()
    total = 0
    for cue in cues:
        # Cheap whole-token matching for ASCII; substring for non-ASCII.
        if cue.isascii():
            total += len(re.findall(rf"(?<![\w]){re.escape(cue)}(?![\w])", lowered))
        else:
            total += lowered.count(cue.lower())
    return total


class SentimentAnalyzer(Protocol):
    async def score(self, text: str) -> SentimentScore | None: ...


@dataclass(frozen=True, slots=True)
class LexiconSentiment(SentimentAnalyzer):
    model_version: str = "setu-lexicon/0.1"

    async def score(self, text: str) -> SentimentScore | None:
        if not text.strip():
            return None
        positive = _count_hits(text, _POSITIVE)
        negative = _count_hits(text, _NEGATIVE)
        subjective = _count_hits(text, _SUBJECTIVE_CUES)
        if positive == 0 and negative == 0 and subjective == 0:
            return SentimentScore(
                polarity=0.0,
                subjectivity=0.0,
                model_version=self.model_version,
                confidence=0.2,
            )
        denom = max(positive + negative, 1)
        polarity = max(-1.0, min(1.0, (positive - negative) / denom))
        subjectivity = max(0.0, min(1.0, subjective / max(positive + negative + subjective, 1)))
        confidence = max(0.3, min(0.9, (positive + negative + subjective) / 6))
        return SentimentScore(
            polarity=polarity,
            subjectivity=subjectivity,
            model_version=self.model_version,
            confidence=confidence,
        )


__all__ = ["SentimentAnalyzer", "LexiconSentiment"]
