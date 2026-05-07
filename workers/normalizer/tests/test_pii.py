"""Tests for the PII redactor."""

from __future__ import annotations

from workers.normalizer.app.pii import redact


def test_redact_aadhaar_with_separator() -> None:
    text = "patient aadhaar 1234 5678 9012 reported fever"
    result = redact(text)
    assert "[AADHAAR]" in result.redacted_text
    assert "1234" not in result.redacted_text
    assert len(result.findings) == 1
    assert result.findings[0].kind == "aadhaar"


def test_redact_pan_uppercase() -> None:
    result = redact("PAN ABCDE1234F belongs to user")
    assert "[PAN]" in result.redacted_text
    assert result.findings[0].kind == "pan"


def test_redact_indian_mobile_with_country_code() -> None:
    result = redact("call me on +91-9876543210 for details")
    assert "[MOBILE]" in result.redacted_text
    assert result.findings[0].kind == "mobile"


def test_redact_email() -> None:
    result = redact("contact patient@example.com today")
    assert "[EMAIL]" in result.redacted_text
    assert result.findings[0].kind == "email"


def test_redact_url() -> None:
    result = redact("see https://news.example.in/story for more")
    assert "[URL]" in result.redacted_text
    assert result.findings[0].kind == "url_handle"


def test_redact_at_handle() -> None:
    result = redact("thanks @drsharma for the response")
    assert "[USER]" in result.redacted_text
    assert result.findings[0].kind == "username"


def test_redact_disabled_returns_input_untouched() -> None:
    raw = "aadhaar 1234 5678 9012"
    result = redact(raw, enabled=False)
    assert result.redacted_text == raw
    assert result.findings == ()


def test_redact_no_pii_returns_unchanged_with_empty_findings() -> None:
    raw = "child developed fever after taking syrup"
    result = redact(raw)
    assert result.redacted_text == raw
    assert result.findings == ()


def test_redact_findings_have_correct_spans_against_input() -> None:
    text = "email patient@example.com about results"
    result = redact(text)
    finding = result.findings[0]
    assert text[finding.span.start : finding.span.end] == "patient@example.com"


def test_redact_handles_multiple_pii_in_one_string() -> None:
    text = "call 9876543210 or write to a@b.co — aadhaar 1234 5678 9012"
    result = redact(text)
    kinds = {f.kind for f in result.findings}
    assert {"mobile", "email", "aadhaar"}.issubset(kinds)
    assert "9876543210" not in result.redacted_text
    assert "a@b.co" not in result.redacted_text
    assert "1234 5678 9012" not in result.redacted_text
