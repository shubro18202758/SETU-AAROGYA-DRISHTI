"""Indic→English translation provider.

We default to an identity translator that just returns the input text — this
keeps unit tests and CI fully offline. The IndicTrans2 distilled model
(`ai4bharat/indictrans2-indic-en-dist-200M`, MIT) is loaded only when
:class:`IndicTrans2Translator` is explicitly constructed and used.
"""

from __future__ import annotations

from collections.abc import Iterable
from dataclasses import dataclass
from typing import Protocol

from backend.app.schemas.health import LanguageSegment

INDIC_LANGS: frozenset[str] = frozenset({"hi", "ta", "te", "kn", "bn", "gu", "pa", "ml", "or"})


class Translator(Protocol):
    def translate_to_english(
        self,
        text: str,
        segments: tuple[LanguageSegment, ...],
    ) -> str | None:
        """Return English translation, or ``None`` when no translation needed."""


@dataclass(frozen=True, slots=True)
class IdentityTranslator(Translator):
    """No-op translator — used when no Indic content is detected (or in tests)."""

    def translate_to_english(
        self,
        text: str,
        segments: tuple[LanguageSegment, ...],
    ) -> str | None:
        if _has_indic(segments):
            return text  # echo back unchanged so downstream still sees a string
        return None


def _has_indic(segments: Iterable[LanguageSegment]) -> bool:
    return any(seg.language in INDIC_LANGS for seg in segments)


class IndicTrans2Translator(Translator):
    """ai4bharat/indictrans2-indic-en-dist-200M (lazy-loaded)."""

    def __init__(self, model_name: str = "ai4bharat/indictrans2-indic-en-dist-200M") -> None:
        self._model_name = model_name
        self._tokenizer = None
        self._model = None

    def _ensure(self) -> None:
        if self._model is not None:
            return
        from transformers import (  # type: ignore[import-not-found]
            AutoModelForSeq2SeqLM,
            AutoTokenizer,
        )

        self._tokenizer = AutoTokenizer.from_pretrained(self._model_name, trust_remote_code=True)
        self._model = AutoModelForSeq2SeqLM.from_pretrained(self._model_name, trust_remote_code=True)

    def translate_to_english(
        self,
        text: str,
        segments: tuple[LanguageSegment, ...],
    ) -> str | None:
        if not _has_indic(segments):
            return None
        self._ensure()
        assert self._tokenizer is not None and self._model is not None  # nosec  # noqa: S101
        inputs = self._tokenizer(text, return_tensors="pt", truncation=True, max_length=512)
        outputs = self._model.generate(  # type: ignore[union-attr]
            **inputs,
            max_new_tokens=512,
            num_beams=1,
            do_sample=False,
        )
        return self._tokenizer.batch_decode(outputs, skip_special_tokens=True)[0]


__all__ = ["Translator", "IdentityTranslator", "IndicTrans2Translator", "INDIC_LANGS"]
