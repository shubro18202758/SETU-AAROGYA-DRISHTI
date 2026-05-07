"""End-to-end tests for the SETU normalizer pipeline.

All tests run fully offline using the default providers (no transformers,
no httpx). The Coldrif demo strings double as multilingual fixtures for
language identification + medical NER.
"""

from __future__ import annotations

from datetime import datetime, timezone
from uuid import uuid4

import pytest

from backend.app.schemas.health import HealthMention
from workers.normalizer.app.pipeline import build_default_normalizer


def _mention(text: str) -> HealthMention:
    return HealthMention(
        id=uuid4(),
        project_id=uuid4(),
        source_config_id=uuid4(),
        connector_type="x_fixture",
        source_uri="fixture://coldrif/demo",
        author_hash="0123456789abcdef" * 2,
        fetched_at=datetime.now(timezone.utc),
        original_text=text,
    )


@pytest.mark.asyncio
async def test_pipeline_emits_normalized_and_medical() -> None:
    normalizer = build_default_normalizer()
    outcome = await normalizer.process(_mention("child developed fever after Coldrif syrup"))

    assert outcome.normalized.mention_id == outcome.medical.mention_id
    assert outcome.normalized.pipeline_version == "setu-normalizer/0.1"
    assert outcome.medical.model_version == "setu-normalizer/0.1"


@pytest.mark.asyncio
async def test_pipeline_redacts_pii_before_ner() -> None:
    normalizer = build_default_normalizer()
    text = "patient (aadhaar 1234 5678 9012) developed fever after Coldrif"
    outcome = await normalizer.process(_mention(text))

    assert "1234 5678 9012" not in outcome.normalized.normalized_text
    assert outcome.normalized.redaction_count == 1
    # NER must still find the medical entities on the redacted text.
    surfaces = {e.surface.lower() for e in outcome.medical.medical_entities}
    assert "fever" in surfaces
    assert "coldrif" in surfaces
    # And the entity spans must point inside the *redacted* text.
    for entity in outcome.medical.medical_entities:
        if entity.span is not None:
            redacted = outcome.normalized.normalized_text
            assert redacted[entity.span.start : entity.span.end].lower() == entity.surface.lower()


@pytest.mark.asyncio
async def test_pipeline_lang_id_detects_hindi_devanagari() -> None:
    normalizer = build_default_normalizer()
    outcome = await normalizer.process(
        _mention("मेरे बच्चे को कोल्डरिफ के बाद बुखार हो गया")
    )
    languages = {seg.language for seg in outcome.normalized.language_segments}
    assert "hi" in languages
    # Identity translator echoes original text when Indic content is detected.
    assert outcome.normalized.translated_text is not None


@pytest.mark.asyncio
async def test_pipeline_lang_id_detects_tamil() -> None:
    normalizer = build_default_normalizer()
    outcome = await normalizer.process(
        _mention("என் குழந்தைக்கு Coldrif பின் காய்ச்சல் வந்தது")
    )
    languages = {seg.language for seg in outcome.normalized.language_segments}
    assert "ta" in languages


@pytest.mark.asyncio
async def test_pipeline_skips_translation_for_pure_english() -> None:
    normalizer = build_default_normalizer()
    outcome = await normalizer.process(_mention("child has fever and vomiting"))
    assert outcome.normalized.translated_text is None


@pytest.mark.asyncio
async def test_pipeline_vocab_ner_finds_multiple_entities() -> None:
    normalizer = build_default_normalizer()
    text = "outbreak of dengue fever; patient given paracetamol with acute kidney injury"
    outcome = await normalizer.process(_mention(text))

    surfaces = {e.surface.lower() for e in outcome.medical.medical_entities}
    kinds = {e.kind for e in outcome.medical.medical_entities}
    assert "paracetamol" in surfaces
    assert "fever" in surfaces or "dengue" in surfaces or "dengue fever" in surfaces
    assert "DRUG" in kinds
    assert "SYMPTOM" in kinds or "CONDITION" in kinds


@pytest.mark.asyncio
async def test_pipeline_handles_empty_segments_gracefully() -> None:
    normalizer = build_default_normalizer()
    outcome = await normalizer.process(_mention("..."))
    assert outcome.normalized.language_segments == () or all(
        seg.language == "en" for seg in outcome.normalized.language_segments
    )
    assert outcome.medical.medical_entities == ()


@pytest.mark.asyncio
async def test_pipeline_attaches_sentiment_and_misinfo() -> None:
    normalizer = build_default_normalizer()
    outcome = await normalizer.process(
        _mention("Coldrif is dangerous and harmful — it caused vomiting and pain")
    )
    assert outcome.medical.sentiment is not None
    assert outcome.medical.sentiment.polarity <= 0.0
    assert outcome.medical.misinformation is not None
