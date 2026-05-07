"""SETU signals worker entrypoint.

Consumes :data:`backend.app.topics.SETU_MENTIONS_MEDICAL`, feeds each
``MedicalAnnotation`` into :class:`SignalAggregator`, and re-publishes the
emitted :class:`Signal` events on the per-kind topics plus a firehose. Every
emitted signal also drops an :class:`AuditEntry` on the audit topic.
"""

from __future__ import annotations

import asyncio
import logging
import os
import signal
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Mapping
from uuid import UUID, uuid4

from backend.app.bus import (
    AsyncSchemaConsumer,
    AsyncSchemaProducer,
    EventBusConfig,
)
from backend.app.schemas.health import AuditEntry, MedicalAnnotation, Signal
from backend.app.topics import (
    SETU_AUDIT_EVENTS,
    SETU_MENTIONS_MEDICAL,
    SETU_SIGNALS_ADR,
    SETU_SIGNALS_CLUSTER,
    SETU_SIGNALS_FIREHOSE,
    SETU_SIGNALS_TREND,
)

from .aggregator import AggregatorConfig, SignalAggregator

LOG = logging.getLogger("setu.signals")


@dataclass(frozen=True, slots=True)
class WorkerConfig:
    brokers: str
    mentions_topic: str
    firehose_topic: str
    adr_topic: str
    trend_topic: str
    cluster_topic: str
    audit_topic: str
    group_id: str
    audit_chain_enabled: bool

    @classmethod
    def from_env(cls) -> "WorkerConfig":
        return cls(
            brokers=os.environ.get("REDPANDA_BROKERS", "localhost:9092"),
            mentions_topic=os.environ.get("MENTIONS_MEDICAL_TOPIC", SETU_MENTIONS_MEDICAL),
            firehose_topic=os.environ.get("SIGNALS_FIREHOSE_TOPIC", SETU_SIGNALS_FIREHOSE),
            adr_topic=os.environ.get("SIGNALS_ADR_TOPIC", SETU_SIGNALS_ADR),
            trend_topic=os.environ.get("SIGNALS_TREND_TOPIC", SETU_SIGNALS_TREND),
            cluster_topic=os.environ.get("SIGNALS_CLUSTER_TOPIC", SETU_SIGNALS_CLUSTER),
            audit_topic=os.environ.get("AUDIT_TOPIC", SETU_AUDIT_EVENTS),
            group_id=os.environ.get("SIGNALS_GROUP_ID", "setu-signals"),
            audit_chain_enabled=os.environ.get("AUDIT_CHAIN_ENABLED", "true").lower() == "true",
        )


def _kind_topic(config: WorkerConfig, kind: str) -> str:
    return {
        "adr": config.adr_topic,
        "trend": config.trend_topic,
        "cluster": config.cluster_topic,
    }.get(kind, config.firehose_topic)


def _extract_geo(
    annotation: MedicalAnnotation, extra: Mapping[str, object] | None
) -> tuple[str | None, float | None, float | None]:
    extra = extra or {}
    raw_district = extra.get("district")
    district = raw_district if isinstance(raw_district, str) else None
    raw_lat = extra.get("latitude")
    raw_lon = extra.get("longitude")
    lat = float(raw_lat) if isinstance(raw_lat, (int, float)) else None
    lon = float(raw_lon) if isinstance(raw_lon, (int, float)) else None
    return district, lat, lon


async def run(config: WorkerConfig | None = None) -> None:
    config = config or WorkerConfig.from_env()
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")

    bus = EventBusConfig(bootstrap_servers=config.brokers, client_id=config.group_id)
    consumer: AsyncSchemaConsumer[MedicalAnnotation] = AsyncSchemaConsumer(  # type: ignore[type-var]
        bus,
        MedicalAnnotation,
        [config.mentions_topic],
        group_id=config.group_id,
    )
    signal_producer: AsyncSchemaProducer[Signal] = AsyncSchemaProducer(  # type: ignore[type-var]
        bus, Signal
    )
    audit_producer: AsyncSchemaProducer[AuditEntry] = AsyncSchemaProducer(  # type: ignore[type-var]
        bus, AuditEntry
    )

    aggregators: dict[UUID, SignalAggregator] = {}
    last_annotation: dict[UUID, MedicalAnnotation] = {}

    await asyncio.gather(consumer.start(), signal_producer.start(), audit_producer.start())
    LOG.info("signals worker started: %s -> firehose=%s", config.mentions_topic, config.firehose_topic)

    try:
        async for record in consumer.records():
            annotation = record.value
            agg = aggregators.get(annotation.project_id)
            if agg is None:
                agg = SignalAggregator(
                    project_id=annotation.project_id,
                    config=AggregatorConfig(),
                )
                aggregators[annotation.project_id] = agg

            district, lat, lon = _extract_geo(annotation, getattr(record, "headers", None))
            ts = annotation.annotated_at or datetime.now(tz=timezone.utc)
            try:
                emitted = agg.observe(
                    annotation,
                    district=district,
                    latitude=lat,
                    longitude=lon,
                    timestamp=ts,
                )
            except Exception:  # pragma: no cover - defensive
                LOG.exception("aggregator failed for project %s", annotation.project_id)
                continue

            last_annotation[annotation.project_id] = annotation
            await _publish_signals(
                emitted,
                config=config,
                signal_producer=signal_producer,
                audit_producer=audit_producer,
                audit_chain=agg.audit,
            )
    finally:
        # Drain any open trend buckets so the final batch isn't silently dropped.
        try:
            await _flush_aggregators(
                aggregators,
                last_annotation,
                config=config,
                signal_producer=signal_producer,
                audit_producer=audit_producer,
            )
        except Exception:  # pragma: no cover - defensive shutdown path
            LOG.exception("flush during shutdown failed")
        await asyncio.gather(
            consumer.stop(),
            signal_producer.stop(),
            audit_producer.stop(),
            return_exceptions=True,
        )


async def _publish_signals(
    signals: list[Signal],
    *,
    config: WorkerConfig,
    signal_producer: AsyncSchemaProducer[Signal],
    audit_producer: AsyncSchemaProducer[AuditEntry],
    audit_chain,
) -> None:
    for sig in signals:
        await signal_producer.send(_kind_topic(config, sig.kind), sig, key=str(sig.id))
        await signal_producer.send(config.firehose_topic, sig, key=str(sig.id))
        if config.audit_chain_enabled and audit_chain.entries:
            entry = audit_chain.entries[-1]
            await audit_producer.send(config.audit_topic, entry, key=str(entry.id))


async def _flush_aggregators(
    aggregators: Mapping[UUID, SignalAggregator],
    last_annotation: Mapping[UUID, MedicalAnnotation],
    *,
    config: WorkerConfig,
    signal_producer: AsyncSchemaProducer[Signal],
    audit_producer: AsyncSchemaProducer[AuditEntry],
) -> int:
    """Flush every aggregator's open buckets, publishing emitted signals.

    Returns the total number of signals emitted across all aggregators.
    """
    total = 0
    for project_id, agg in aggregators.items():
        annotation = last_annotation.get(project_id)
        try:
            emitted = agg.flush(annotation=annotation)
        except Exception:  # pragma: no cover - defensive
            LOG.exception("flush failed for project %s", project_id)
            continue
        if not emitted:
            continue
        total += len(emitted)
        await _publish_signals(
            emitted,
            config=config,
            signal_producer=signal_producer,
            audit_producer=audit_producer,
            audit_chain=agg.audit,
        )
    if total:
        LOG.info("flushed %d signals across %d aggregators on shutdown", total, len(aggregators))
    return total


def _install_signal_handlers(loop: asyncio.AbstractEventLoop, stop_event: asyncio.Event) -> None:
    def _stop(*_: object) -> None:
        stop_event.set()

    for sig_name in ("SIGINT", "SIGTERM"):
        sig = getattr(signal, sig_name, None)
        if sig is None:
            continue
        try:
            loop.add_signal_handler(sig, _stop)
        except (NotImplementedError, RuntimeError):
            try:
                signal.signal(sig, _stop)
            except (ValueError, OSError):
                pass


async def _main() -> None:
    stop_event = asyncio.Event()
    loop = asyncio.get_running_loop()
    _install_signal_handlers(loop, stop_event)
    runner = asyncio.create_task(run())
    waiter = asyncio.create_task(stop_event.wait())
    done, pending = await asyncio.wait({runner, waiter}, return_when=asyncio.FIRST_COMPLETED)
    for task in pending:
        task.cancel()
    for task in done:
        if task is runner:
            task.result()


def main() -> None:
    try:
        asyncio.run(_main())
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
