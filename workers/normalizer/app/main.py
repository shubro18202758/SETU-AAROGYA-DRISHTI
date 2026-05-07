"""Normalizer worker entrypoint.

Consumes :class:`HealthMention` records from ``setu.mentions.raw`` and
publishes:

* :class:`NormalizedMention` → ``setu.mentions.normalized``
* :class:`MedicalAnnotation` → ``setu.mentions.medical``

Heavy NLP backends (MuRIL, IndicTrans2, Qwen) are opt-in via env flags so
the same image can run in a tiny CI sandbox or a full GPU box.
"""

from __future__ import annotations

import asyncio
import logging
import os
import signal
from dataclasses import dataclass

import httpx

from backend.app.bus import (
    AsyncSchemaConsumer,
    AsyncSchemaProducer,
    EventBusConfig,
)
from backend.app.schemas.health import (
    HealthMention,
    MedicalAnnotation,
    NormalizedMention,
)
from backend.app.topics import (
    SETU_MENTIONS_MEDICAL,
    SETU_MENTIONS_NORMALIZED,
    SETU_MENTIONS_RAW,
)

from .gate import MemoryPressureGate
from .lang_id import LanguageIdentifier, MurilLanguageIdentifier, ScriptHeuristicIdentifier
from .medical_ner import MedicalNER, QwenMedicalNER, VocabMedicalNER
from .misinfo import RuleMisinfoDetector
from .pipeline import Normalizer
from .sentiment import LexiconSentiment
from .translate import IdentityTranslator, IndicTrans2Translator, Translator

LOGGER = logging.getLogger("setu.normalizer")


@dataclass(frozen=True, slots=True)
class WorkerConfig:
    bootstrap_servers: str = "localhost:19092"
    raw_topic: str = SETU_MENTIONS_RAW
    normalized_topic: str = SETU_MENTIONS_NORMALIZED
    medical_topic: str = SETU_MENTIONS_MEDICAL
    group_id: str = "setu-normalizer"
    llm_base_url: str = "http://localhost:8088/v1"
    llm_model: str = "Qwen/Qwen3.5-4B"
    indic_lang_id_enabled: bool = True
    indic_translate_enabled: bool = True
    pii_enabled: bool = True
    use_qwen_ner: bool = True
    vocab_path: str = "infrastructure/vocab/medical_seed.json"
    indic_lang_id_model: str = "google/muril-base-cased"
    indic_translate_model: str = "ai4bharat/indictrans2-indic-en-dist-200M"
    pipeline_version: str = "setu-normalizer/0.1"
    memory_gate_enabled: bool = True
    memory_gate_high: float = 0.85
    memory_gate_low: float = 0.70
    memory_gate_poll_s: float = 0.5

    @classmethod
    def from_env(cls) -> "WorkerConfig":
        def _bool(name: str, default: bool) -> bool:
            value = os.getenv(name)
            if value is None:
                return default
            return value.strip().lower() in {"1", "true", "yes", "on"}

        return cls(
            bootstrap_servers=os.getenv("REDPANDA_BROKERS", cls.bootstrap_servers),
            raw_topic=os.getenv("MENTIONS_RAW_TOPIC", cls.raw_topic),
            normalized_topic=os.getenv("MENTIONS_NORMALIZED_TOPIC", cls.normalized_topic),
            medical_topic=os.getenv("MENTIONS_MEDICAL_TOPIC", cls.medical_topic),
            group_id=os.getenv("NORMALIZER_GROUP_ID", cls.group_id),
            llm_base_url=os.getenv("LLM_BASE_URL", cls.llm_base_url),
            llm_model=os.getenv("LLM_MODEL", cls.llm_model),
            indic_lang_id_enabled=_bool("INDIC_LANG_ID_ENABLED", cls.indic_lang_id_enabled),
            indic_translate_enabled=_bool("INDIC_TRANSLATE_ENABLED", cls.indic_translate_enabled),
            pii_enabled=_bool("PII_REDACTION_ENABLED", cls.pii_enabled),
            use_qwen_ner=_bool("QWEN_NER_ENABLED", cls.use_qwen_ner),
            vocab_path=os.getenv("VOCAB_PATH", cls.vocab_path),
            indic_lang_id_model=os.getenv("INDIC_LANG_ID_MODEL", cls.indic_lang_id_model),
            indic_translate_model=os.getenv("INDIC_TRANSLATE_MODEL", cls.indic_translate_model),
            pipeline_version=os.getenv("PIPELINE_VERSION", cls.pipeline_version),
            memory_gate_enabled=_bool("MEMORY_GATE_ENABLED", cls.memory_gate_enabled),
            memory_gate_high=float(
                os.getenv("MEMORY_GATE_HIGH", str(cls.memory_gate_high))
            ),
            memory_gate_low=float(
                os.getenv("MEMORY_GATE_LOW", str(cls.memory_gate_low))
            ),
            memory_gate_poll_s=float(
                os.getenv("MEMORY_GATE_POLL_S", str(cls.memory_gate_poll_s))
            ),
        )


def _build_lang_identifier(config: WorkerConfig) -> LanguageIdentifier:
    if not config.indic_lang_id_enabled:
        return ScriptHeuristicIdentifier()
    try:
        return MurilLanguageIdentifier(config.indic_lang_id_model)
    except Exception as exc:  # noqa: BLE001  # missing transformers / torch
        LOGGER.warning("falling back to heuristic lang-ID: %s", exc)
        return ScriptHeuristicIdentifier()


def _build_translator(config: WorkerConfig) -> Translator:
    if not config.indic_translate_enabled:
        return IdentityTranslator()
    try:
        return IndicTrans2Translator(config.indic_translate_model)
    except Exception as exc:  # noqa: BLE001
        LOGGER.warning("falling back to identity translator: %s", exc)
        return IdentityTranslator()


def _build_medical_ner(config: WorkerConfig, http_client: httpx.AsyncClient | None) -> MedicalNER:
    vocab = VocabMedicalNER(config.vocab_path)
    if not config.use_qwen_ner:
        return vocab
    return QwenMedicalNER(
        base_url=config.llm_base_url,
        model=config.llm_model,
        fallback=vocab,
        client=http_client,
    )


def build_normalizer(
    config: WorkerConfig,
    *,
    http_client: httpx.AsyncClient | None = None,
) -> Normalizer:
    return Normalizer(
        lang_identifier=_build_lang_identifier(config),
        translator=_build_translator(config),
        medical_ner=_build_medical_ner(config, http_client),
        sentiment=LexiconSentiment(),
        misinfo=RuleMisinfoDetector(),
        pipeline_version=config.pipeline_version,
        pii_enabled=config.pii_enabled,
    )


async def run(config: WorkerConfig | None = None) -> None:
    """Long-running consumer loop."""
    config = config or WorkerConfig.from_env()
    bus = EventBusConfig(
        bootstrap_servers=config.bootstrap_servers,
        client_id="setu-normalizer",
    )

    http_client = httpx.AsyncClient(timeout=20.0)
    normalizer = build_normalizer(config, http_client=http_client)
    gate: MemoryPressureGate | None = None
    if config.memory_gate_enabled:
        gate = MemoryPressureGate(
            high_watermark=config.memory_gate_high,
            low_watermark=config.memory_gate_low,
            poll_interval_s=config.memory_gate_poll_s,
        )

    consumer = AsyncSchemaConsumer(
        bus, HealthMention, [config.raw_topic], group_id=config.group_id
    )
    normalized_producer: AsyncSchemaProducer[NormalizedMention] = AsyncSchemaProducer(
        bus, NormalizedMention
    )
    medical_producer: AsyncSchemaProducer[MedicalAnnotation] = AsyncSchemaProducer(
        bus, MedicalAnnotation
    )

    stop_event = asyncio.Event()

    def _handle_stop(*_: object) -> None:
        LOGGER.info("normalizer worker received stop signal")
        stop_event.set()

    loop = asyncio.get_running_loop()
    for sig_name in ("SIGINT", "SIGTERM"):
        sig = getattr(signal, sig_name, None)
        if sig is not None:
            try:
                loop.add_signal_handler(sig, _handle_stop)
            except NotImplementedError:  # Windows / non-main thread
                signal.signal(sig, _handle_stop)

    await consumer.start()
    await normalized_producer.start()
    await medical_producer.start()
    LOGGER.info("setu-normalizer started; topics=%s", config.raw_topic)

    try:
        consume_task = asyncio.create_task(
            _consume_forever(
                consumer,
                normalizer,
                normalized_producer,
                medical_producer,
                config,
                gate=gate,
            )
        )
        stop_task = asyncio.create_task(stop_event.wait())
        done, pending = await asyncio.wait(
            {consume_task, stop_task}, return_when=asyncio.FIRST_COMPLETED
        )
        for task in pending:
            task.cancel()
        for task in done:
            exc = task.exception()
            if exc is not None and not isinstance(exc, asyncio.CancelledError):
                raise exc
    finally:
        await consumer.stop()
        await normalized_producer.stop()
        await medical_producer.stop()
        await http_client.aclose()


async def _consume_forever(
    consumer: AsyncSchemaConsumer[HealthMention],
    normalizer: Normalizer,
    normalized_producer: AsyncSchemaProducer[NormalizedMention],
    medical_producer: AsyncSchemaProducer[MedicalAnnotation],
    config: WorkerConfig,
    *,
    gate: MemoryPressureGate | None = None,
) -> None:
    async for record in consumer.records():
        if gate is not None:
            await gate.acquire()
        try:
            outcome = await normalizer.process(record.value)
        except Exception:  # noqa: BLE001
            LOGGER.exception("normalizer pipeline failed for mention=%s", record.value.id)
            continue
        await normalized_producer.send(
            config.normalized_topic, outcome.normalized, key=str(outcome.normalized.mention_id)
        )
        await medical_producer.send(
            config.medical_topic, outcome.medical, key=str(outcome.medical.mention_id)
        )


def main() -> None:
    logging.basicConfig(
        level=os.getenv("LOG_LEVEL", "INFO"),
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
    )
    asyncio.run(run())


if __name__ == "__main__":
    main()
