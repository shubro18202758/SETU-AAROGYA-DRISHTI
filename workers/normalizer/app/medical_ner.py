"""Medical entity recognition.

The default :class:`VocabMedicalNER` is a deterministic dictionary lookup
backed by ``infrastructure/vocab/medical_seed.json`` (SNOMED-CT, ICD-11,
WHO-DRUG seed list curated for the Coldrif demo). It runs offline, returns
:class:`MedicalEntity` instances with code mappings, and is what tests rely on.

For production we ship :class:`QwenMedicalNER` which prompts the local Qwen
TGI endpoint at ``llm_base_url`` for richer extraction. It falls back to the
vocab matcher on parse / network errors.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Protocol

import httpx
import orjson

from backend.app.schemas.health import (
    CodeSystem,
    MedicalEntity,
    MedicalEntityKind,
    TextSpan,
)


class MedicalNER(Protocol):
    async def extract(self, text: str) -> tuple[MedicalEntity, ...]: ...


@dataclass(frozen=True, slots=True)
class _VocabEntry:
    surface: str
    kind: MedicalEntityKind
    code_system: CodeSystem | None
    code: str | None


# Maps the JSON section name to the MedicalEntityKind we emit.
_SECTION_KIND: dict[str, MedicalEntityKind] = {
    "drugs": "DRUG",
    "symptoms": "SYMPTOM",
    "conditions": "CONDITION",
    "procedures": "PROCEDURE",
    "devices": "DEVICE",
    "adverse_events": "ADVERSE_EVENT",
    "facilities": "FACILITY",
    "demographics": "DEMOGRAPHIC",
}


def _load_vocab(vocab_path: Path) -> tuple[_VocabEntry, ...]:
    if not vocab_path.exists():
        return ()
    raw = json.loads(vocab_path.read_text(encoding="utf-8"))
    entries: list[_VocabEntry] = []
    for section, kind in _SECTION_KIND.items():
        for record in raw.get(section, ()) or ():
            surface = record.get("surface")
            if not surface:
                continue
            code_system = record.get("code_system") or None
            code = str(record["code"]) if record.get("code") else None
            entries.append(
                _VocabEntry(
                    surface=str(surface).strip(),
                    kind=kind,
                    code_system=code_system,
                    code=code,
                )
            )
            for syn in record.get("synonyms", ()) or ():
                entries.append(
                    _VocabEntry(
                        surface=str(syn).strip(),
                        kind=kind,
                        code_system=code_system,
                        code=code,
                    )
                )
    return tuple(entries)


class VocabMedicalNER(MedicalNER):
    """Deterministic case-insensitive whole-word vocab matcher."""

    def __init__(self, vocab_path: str | Path = "infrastructure/vocab/medical_seed.json") -> None:
        self._entries = _load_vocab(Path(vocab_path))
        # Pre-compile a regex per entry; whole-word boundaries to avoid
        # matching "fever" inside "feverish-but-fine". Allow unicode letters.
        self._compiled = tuple(
            (entry, re.compile(rf"(?<![\w]){re.escape(entry.surface)}(?![\w])", re.IGNORECASE))
            for entry in self._entries
        )

    async def extract(self, text: str) -> tuple[MedicalEntity, ...]:
        if not text or not self._compiled:
            return ()
        results: list[MedicalEntity] = []
        for entry, pattern in self._compiled:
            for m in pattern.finditer(text):
                start, end = m.span()
                surface = text[start:end][:512]
                results.append(
                    MedicalEntity(
                        kind=entry.kind,
                        surface=surface,
                        span=TextSpan(start=start, end=end, text=surface),
                        code_system=entry.code_system,
                        code=entry.code,
                        confidence=0.7,
                        negated=_looks_negated(text, start),
                        hypothetical=False,
                    )
                )
        # Deduplicate identical (kind, code, span) tuples while preserving order.
        seen: set[tuple[str, str | None, int, int]] = set()
        deduped: list[MedicalEntity] = []
        for ent in results:
            assert ent.span is not None  # noqa: S101  # span always set above
            key = (ent.kind, ent.code, ent.span.start, ent.span.end)
            if key in seen:
                continue
            seen.add(key)
            deduped.append(ent)
        return tuple(deduped)


_NEGATION_CUES = ("no ", "not ", "without ", "denies ", "नहीं", "இல்லை", "లేదు", "ಇಲ್ಲ")


def _looks_negated(text: str, start: int) -> bool:
    window = text[max(0, start - 24) : start].lower()
    return any(cue in window for cue in _NEGATION_CUES)


class QwenMedicalNER(MedicalNER):
    """Calls a local Qwen TGI server. Falls back to ``VocabMedicalNER`` on error."""

    def __init__(
        self,
        base_url: str,
        model: str,
        fallback: MedicalNER,
        *,
        client: httpx.AsyncClient | None = None,
        timeout_seconds: float = 20.0,
    ) -> None:
        self._base_url = base_url.rstrip("/")
        self._model = model
        self._fallback = fallback
        self._client = client
        self._timeout = timeout_seconds

    async def extract(self, text: str) -> tuple[MedicalEntity, ...]:
        client = self._client or httpx.AsyncClient(timeout=self._timeout)
        owns_client = self._client is None
        try:
            payload = {
                "model": self._model,
                "messages": [
                    {
                        "role": "system",
                        "content": (
                            "You are a clinical NLP extractor. Return strict JSON: "
                            '{"entities":[{"surface":..., "kind":"DRUG|SYMPTOM|CONDITION|'
                            'PROCEDURE|DEVICE|FACILITY|ADVERSE_EVENT|DEMOGRAPHIC", '
                            '"code_system":"SNOMED-CT|ICD-11|WHO-DRUG|null", '
                            '"code":"...", "negated":bool}]}. No prose.'
                        ),
                    },
                    {"role": "user", "content": text},
                ],
                "temperature": 0.0,
                "max_tokens": 512,
            }
            response = await client.post(f"{self._base_url}/chat/completions", json=payload)
            response.raise_for_status()
            content = response.json()["choices"][0]["message"]["content"]
            parsed: dict[str, Any] = orjson.loads(content)
            return _parse_qwen_entities(text, parsed)
        except Exception:  # noqa: BLE001  # any failure → fallback
            return await self._fallback.extract(text)
        finally:
            if owns_client:
                await client.aclose()


def _parse_qwen_entities(text: str, parsed: dict[str, Any]) -> tuple[MedicalEntity, ...]:
    out: list[MedicalEntity] = []
    for record in parsed.get("entities", ()) or ():
        surface = str(record.get("surface", "")).strip()
        if not surface:
            continue
        idx = text.lower().find(surface.lower())
        span: TextSpan | None = None
        if idx >= 0:
            span = TextSpan(start=idx, end=idx + len(surface), text=surface[:512])
        kind = record.get("kind", "SYMPTOM")
        out.append(
            MedicalEntity(
                kind=kind,
                surface=surface[:512],
                span=span,
                code_system=record.get("code_system") or None,
                code=str(record["code"]) if record.get("code") else None,
                confidence=float(record.get("confidence", 0.6)),
                negated=bool(record.get("negated", False)),
                hypothetical=bool(record.get("hypothetical", False)),
            )
        )
    return tuple(out)


__all__ = ["MedicalNER", "VocabMedicalNER", "QwenMedicalNER"]
