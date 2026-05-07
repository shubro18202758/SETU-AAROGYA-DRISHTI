"""PII redaction for SETU mentions.

Goal: ensure PHI/PII never reaches downstream NLP, vector store, or audit log.
The redactor recognises Indian-context identifiers (Aadhaar, PAN, mobile),
plus generic email / URL handles / @mentions. All findings are returned with
spans and a stable redaction token so the downstream pipeline can audit which
characters were modified.

The implementation is regex-only and offline; it never calls a model.
"""

from __future__ import annotations

import re
from collections.abc import Iterable
from dataclasses import dataclass
from typing import Final

from backend.app.schemas.health import PIIFinding, PIIKind, TextSpan

# --- Patterns ---------------------------------------------------------------
# All patterns are intentionally conservative — false negatives are preferred
# over corrupting medical text. Strict word boundaries where possible.

_AADHAAR = re.compile(r"\b\d{4}[-\s]?\d{4}[-\s]?\d{4}\b")
_PAN = re.compile(r"\b[A-Z]{5}\d{4}[A-Z]\b")
_MOBILE_IN = re.compile(r"\b(?:\+?91[-\s]?|0)?[6-9]\d{9}\b")
_EMAIL = re.compile(r"\b[\w.+-]+@[\w-]+\.[\w.-]+\b")
_URL_HANDLE = re.compile(r"https?://[^\s)<>]+", re.IGNORECASE)
_AT_HANDLE = re.compile(r"(?<![A-Za-z0-9_])@[A-Za-z0-9_]{2,32}\b")

_PATTERN_TABLE: Final[tuple[tuple[PIIKind, re.Pattern[str], str], ...]] = (
    ("aadhaar", _AADHAAR, "[AADHAAR]"),
    ("pan", _PAN, "[PAN]"),
    ("mobile", _MOBILE_IN, "[MOBILE]"),
    ("email", _EMAIL, "[EMAIL]"),
    ("url_handle", _URL_HANDLE, "[URL]"),
    ("username", _AT_HANDLE, "[USER]"),
)


@dataclass(frozen=True, slots=True)
class RedactionResult:
    redacted_text: str
    findings: tuple[PIIFinding, ...]


def redact(text: str, *, enabled: bool = True) -> RedactionResult:
    """Replace recognised PII with stable redaction tokens.

    Returns the rewritten string and the list of findings (with original
    spans relative to the *input* text, not the rewritten output, so callers
    can correlate with raw evidence if needed).
    """
    if not enabled or not text:
        return RedactionResult(redacted_text=text, findings=())

    findings: list[PIIFinding] = []
    matches: list[tuple[int, int, PIIKind, str]] = []
    for kind, pattern, token in _PATTERN_TABLE:
        for m in pattern.finditer(text):
            start, end = m.span()
            matches.append((start, end, kind, token))

    if not matches:
        return RedactionResult(redacted_text=text, findings=())

    # Resolve overlapping matches deterministically: earliest-start wins,
    # ties broken by longest match. Skip matches that overlap an accepted one.
    matches.sort(key=lambda t: (t[0], -(t[1] - t[0])))
    accepted: list[tuple[int, int, PIIKind, str]] = []
    last_end = -1
    for start, end, kind, token in matches:
        if start < last_end:
            continue
        accepted.append((start, end, kind, token))
        last_end = end

    # Build redacted text by walking accepted matches in order.
    pieces: list[str] = []
    cursor = 0
    for start, end, kind, token in accepted:
        pieces.append(text[cursor:start])
        pieces.append(token)
        surface = text[start:end]
        findings.append(
            PIIFinding(
                kind=kind,
                span=TextSpan(start=start, end=end, text=surface[:512]),
                redaction_token=token,
            )
        )
        cursor = end
    pieces.append(text[cursor:])

    return RedactionResult(redacted_text="".join(pieces), findings=tuple(findings))


def count_findings(findings: Iterable[PIIFinding]) -> int:
    return sum(1 for _ in findings)


__all__ = ["RedactionResult", "redact", "count_findings"]
