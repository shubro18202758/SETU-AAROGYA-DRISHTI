"""Misinformation / sarcasm flag.

Rule-based first pass that flags well-known misinformation tropes and obvious
sarcasm cues. This keeps a stable, audit-friendly baseline while leaving room
for an LLM-based classifier to override the Protocol later.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Protocol

from backend.app.schemas.health import MisinformationFlag

_MISINFO_PATTERNS = (
    re.compile(r"\bvaccin\w* (?:cause|causes) (?:autism|infertility|death)\b", re.IGNORECASE),
    re.compile(r"\b5g\s+(?:causes|spreads)\b", re.IGNORECASE),
    re.compile(r"\bplandemic\b", re.IGNORECASE),
    re.compile(r"\b(cures?|cured)\s+(cancer|covid|hiv)\b", re.IGNORECASE),
    re.compile(r"\bgo[a]?[u]?mutra\s+cure\b", re.IGNORECASE),
)
_SARCASM_PATTERNS = (
    re.compile(r"\b(?:yeah|sure|right),?\s+(?:right|sure|ok+)\b", re.IGNORECASE),
    re.compile(r"\b(?:totally|definitely)\s+not\b", re.IGNORECASE),
    re.compile(r"/s\b"),
)
_COORDINATED_PATTERNS = (
    re.compile(r"#?\b(boycott|banthis)\w*\b", re.IGNORECASE),
)


class MisinfoDetector(Protocol):
    async def detect(self, text: str) -> MisinformationFlag | None: ...


@dataclass(frozen=True, slots=True)
class RuleMisinfoDetector(MisinfoDetector):
    async def detect(self, text: str) -> MisinformationFlag | None:
        if not text.strip():
            return None

        for pattern in _MISINFO_PATTERNS:
            if pattern.search(text):
                return MisinformationFlag(
                    label="likely_misinformation",
                    confidence=0.7,
                    rationale=f"matched misinfo pattern: {pattern.pattern}"[:8192],
                )

        for pattern in _SARCASM_PATTERNS:
            if pattern.search(text):
                return MisinformationFlag(
                    label="sarcasm",
                    confidence=0.55,
                    rationale=f"matched sarcasm cue: {pattern.pattern}"[:8192],
                )

        for pattern in _COORDINATED_PATTERNS:
            if pattern.search(text):
                return MisinformationFlag(
                    label="coordinated_inauthentic",
                    confidence=0.5,
                    rationale=f"matched coordination cue: {pattern.pattern}"[:8192],
                )

        return MisinformationFlag(label="clean", confidence=0.4, rationale=None)


__all__ = ["MisinfoDetector", "RuleMisinfoDetector"]
