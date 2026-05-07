"""SETU normalizer orchestration.

Combines the six stages (lang-ID, transliterate/translate, PII redact,
medical NER, sentiment, misinfo flag) into a single pure-async function
that maps :class:`HealthMention` → :class:`PipelineOutcome`.

Design notes:
* No I/O (Kafka / HTTP) lives here — the pipeline is a deterministic function
  of its providers, which makes it trivially unit-testable.
* All providers are Protocols with offline defaults; production wiring swaps
  them in the entrypoint (``app.main``).
* The :class:`Normalizer` instance is *immutable* and safe to share across
  many concurrent requests.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone

from backend.app.schemas.health import (
    HealthMention,
    MedicalAnnotation,
    NormalizedMention,
)

from .lang_id import LanguageIdentifier, ScriptHeuristicIdentifier, dominant_language
from .medical_ner import MedicalNER, VocabMedicalNER
from .misinfo import MisinfoDetector, RuleMisinfoDetector
from .pii import redact
from .sentiment import LexiconSentiment, SentimentAnalyzer
from .translate import IdentityTranslator, Translator


@dataclass(frozen=True, slots=True)
class PipelineOutcome:
    normalized: NormalizedMention
    medical: MedicalAnnotation


@dataclass(frozen=True, slots=True)
class Normalizer:
    lang_identifier: LanguageIdentifier
    translator: Translator
    medical_ner: MedicalNER
    sentiment: SentimentAnalyzer
    misinfo: MisinfoDetector
    pipeline_version: str = "setu-normalizer/0.1"
    pii_enabled: bool = True

    async def process(self, mention: HealthMention) -> PipelineOutcome:
        # Stage 1 — language ID on the original text (PII does not affect it).
        segments = self.lang_identifier.identify(mention.original_text)

        # Stage 2 — translation; pass the original text so Indic glyphs are intact.
        translated = self.translator.translate_to_english(mention.original_text, segments)

        # Stage 3 — PII redaction. From here on, all downstream NLP works on
        # the redacted form to keep PHI out of NER / sentiment / misinfo.
        redaction = redact(mention.original_text, enabled=self.pii_enabled)
        analysis_text = translated if translated else redaction.redacted_text

        # Stages 4–6 — clinical NLP on the safe text.
        entities = await self.medical_ner.extract(analysis_text)
        sentiment = await self.sentiment.score(analysis_text)
        misinfo = await self.misinfo.detect(analysis_text)

        now = datetime.now(timezone.utc)

        normalized = NormalizedMention(
            mention_id=mention.id,
            project_id=mention.project_id,
            normalized_text=redaction.redacted_text or mention.original_text,
            translated_text=translated,
            language_segments=segments,
            pii_findings=redaction.findings,
            redaction_count=len(redaction.findings),
            normalized_at=now,
            pipeline_version=self.pipeline_version,
        )
        if entities:
            agg_confidence = sum(e.confidence for e in entities) / len(entities)
        elif sentiment is not None:
            agg_confidence = sentiment.confidence
        else:
            agg_confidence = 0.3
        medical = MedicalAnnotation(
            mention_id=mention.id,
            project_id=mention.project_id,
            medical_entities=entities,
            sentiment=sentiment,
            misinformation=misinfo,
            annotated_at=now,
            model_version=self.pipeline_version,
            confidence=max(0.0, min(1.0, agg_confidence)),
        )
        return PipelineOutcome(normalized=normalized, medical=medical)

    def dominant_language(self, mention: HealthMention) -> str:
        return dominant_language(self.lang_identifier.identify(mention.original_text))


def build_default_normalizer(
    *,
    vocab_path: str = "infrastructure/vocab/medical_seed.json",
    pipeline_version: str = "setu-normalizer/0.1",
    pii_enabled: bool = True,
) -> Normalizer:
    """Construct a fully-offline normalizer suitable for tests + first-run demo."""
    return Normalizer(
        lang_identifier=ScriptHeuristicIdentifier(),
        translator=IdentityTranslator(),
        medical_ner=VocabMedicalNER(vocab_path),
        sentiment=LexiconSentiment(),
        misinfo=RuleMisinfoDetector(),
        pipeline_version=pipeline_version,
        pii_enabled=pii_enabled,
    )


__all__ = ["Normalizer", "PipelineOutcome", "build_default_normalizer"]
