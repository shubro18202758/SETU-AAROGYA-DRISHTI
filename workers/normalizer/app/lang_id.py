"""Token-level language identification for Indic + English social text.

Default implementation is a fast offline Unicode-script classifier covering
the five SETU target languages (en, hi, ta, te, kn). The MuRIL CPU model is
available via :class:`MurilLanguageIdentifier` but only loaded if explicitly
constructed, so unit tests and CI never require ``transformers``/``torch``.

A "segment" is a contiguous run of tokens sharing the same dominant script.
"""

from __future__ import annotations

import re
import unicodedata
from collections.abc import Iterable
from dataclasses import dataclass
from typing import Final, Protocol

from backend.app.schemas.health import LanguageSegment, TextSpan

# Map Unicode script → (ISO 639-1 language code, script tag we use in schema).
_SCRIPT_TO_LANG: Final[dict[str, tuple[str, str]]] = {
    "DEVANAGARI": ("hi", "Deva"),
    "TAMIL": ("ta", "Taml"),
    "TELUGU": ("te", "Telu"),
    "KANNADA": ("kn", "Knda"),
    "BENGALI": ("bn", "Beng"),
    "GUJARATI": ("gu", "Gujr"),
    "GURMUKHI": ("pa", "Guru"),
    "MALAYALAM": ("ml", "Mlym"),
    "ORIYA": ("or", "Orya"),
    "ARABIC": ("ar", "Arab"),
    "LATIN": ("en", "Latn"),
}

_TOKEN_PATTERN = re.compile(r"\S+")


class LanguageIdentifier(Protocol):
    """Strategy: classify tokens / spans into LanguageSegments."""

    def identify(self, text: str) -> tuple[LanguageSegment, ...]: ...


@dataclass(frozen=True, slots=True)
class _ScriptToken:
    start: int
    end: int
    script: str  # Unicode script name


def _dominant_script(token: str) -> str:
    counts: dict[str, int] = {}
    for ch in token:
        if ch.isspace():
            continue
        try:
            name = unicodedata.name(ch, "")
        except ValueError:
            continue
        head = name.split(" ", 1)[0]
        if head in {"DIGIT", "FULL", "COMMA", "QUESTION", "EXCLAMATION"}:
            continue
        # Heuristic: extract Unicode script via unicodedata.category fallback.
        # `unicodedata` does not expose script directly in stdlib; use the
        # name prefix family (e.g. "DEVANAGARI LETTER KA" → "DEVANAGARI").
        for script in _SCRIPT_TO_LANG:
            if name.startswith(script):
                counts[script] = counts.get(script, 0) + 1
                break
    if not counts:
        return "LATIN"  # default for punctuation-only / digit-only tokens
    return max(counts.items(), key=lambda item: item[1])[0]


class ScriptHeuristicIdentifier(LanguageIdentifier):
    """Fast offline identifier — groups consecutive tokens of the same script."""

    def identify(self, text: str) -> tuple[LanguageSegment, ...]:
        if not text.strip():
            return ()

        tokens: list[_ScriptToken] = []
        for m in _TOKEN_PATTERN.finditer(text):
            tokens.append(_ScriptToken(m.start(), m.end(), _dominant_script(m.group())))

        if not tokens:
            return ()

        segments: list[LanguageSegment] = []
        run_start = tokens[0].start
        run_end = tokens[0].end
        run_script = tokens[0].script
        for tok in tokens[1:]:
            if tok.script == run_script:
                run_end = tok.end
                continue
            segments.append(_to_segment(text, run_start, run_end, run_script))
            run_start, run_end, run_script = tok.start, tok.end, tok.script
        segments.append(_to_segment(text, run_start, run_end, run_script))
        return tuple(segments)


def _to_segment(text: str, start: int, end: int, script: str) -> LanguageSegment:
    lang, script_tag = _SCRIPT_TO_LANG.get(script, ("en", "Latn"))
    surface = text[start:end][:512]
    return LanguageSegment(
        span=TextSpan(start=start, end=end, text=surface),
        language=lang,
        script=script_tag,  # type: ignore[arg-type]
        confidence=0.85,  # heuristic; MuRIL impl returns the model softmax
    )


class MurilLanguageIdentifier(LanguageIdentifier):
    """MuRIL-backed identifier (lazy-loaded, CPU). Optional."""

    def __init__(self, model_name: str = "google/muril-base-cased") -> None:
        self._model_name = model_name
        self._pipeline = None

    def _ensure(self) -> None:
        if self._pipeline is not None:
            return
        from transformers import pipeline  # type: ignore[import-not-found]

        self._pipeline = pipeline(
            "text-classification",
            model=self._model_name,
            tokenizer=self._model_name,
            device=-1,
        )

    def identify(self, text: str) -> tuple[LanguageSegment, ...]:
        # MuRIL is multilingual but not a language-ID head out-of-the-box; in
        # practice we run the script heuristic first and only ask MuRIL to
        # disambiguate Latin runs (Hinglish / romanised Indic). For now we
        # delegate entirely to the heuristic — wire the model later when a
        # fine-tuned head is ready in /models.
        self._ensure()
        return ScriptHeuristicIdentifier().identify(text)


def dominant_language(segments: Iterable[LanguageSegment]) -> str:
    """Return the language with the most characters covered."""
    totals: dict[str, int] = {}
    for seg in segments:
        totals[seg.language] = totals.get(seg.language, 0) + (seg.span.end - seg.span.start)
    if not totals:
        return "en"
    return max(totals.items(), key=lambda item: item[1])[0]


__all__ = [
    "LanguageIdentifier",
    "ScriptHeuristicIdentifier",
    "MurilLanguageIdentifier",
    "dominant_language",
]
