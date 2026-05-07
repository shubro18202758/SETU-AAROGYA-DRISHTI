import asyncio
from dataclasses import dataclass
from datetime import UTC, datetime
from uuid import uuid4

from backend.app.bus import (
    AsyncSchemaConsumer,
    AsyncSchemaProducer,
    BackoffPolicy,
    EventBusConfig,
    SchemaSerde,
)
from backend.app.schemas import RawEvent


class TransientBackpressure(Exception):
    pass


@dataclass(frozen=True)
class FakeMetadata:
    partition: int
    offset: int


@dataclass(frozen=True)
class FakeMessage:
    value: bytes
    topic: str = "osint.raw.events"
    partition: int = 0
    offset: int = 11
    key: bytes | None = None
    timestamp: int | None = 1_777_891_200_000
    headers: list[tuple[str, bytes]] | None = None


class FakeProducer:
    def __init__(self, failures_before_success: int) -> None:
        self.failures_before_success = failures_before_success
        self.started = False
        self.stopped = False
        self.payloads: list[bytes] = []

    async def start(self) -> None:
        self.started = True

    async def stop(self) -> None:
        self.stopped = True

    async def send_and_wait(self, topic: str, value: bytes, **_: object) -> FakeMetadata:
        self.payloads.append(value)
        if self.failures_before_success > 0:
            self.failures_before_success -= 1
            raise TransientBackpressure("broker queue saturated")
        return FakeMetadata(partition=2, offset=42)


class FakeConsumer:
    def __init__(self, message: FakeMessage) -> None:
        self.message = message
        self.started = False
        self.stopped = False

    async def start(self) -> None:
        self.started = True

    async def stop(self) -> None:
        self.stopped = True

    async def getone(self) -> FakeMessage:
        return self.message


def make_raw_event() -> RawEvent:
    return RawEvent(
        id=uuid4(),
        collector_name="public-web",
        source_uri="https://example.test/profile",
        content_type="text/markdown",
        fetch_timestamp=datetime.now(UTC),
        raw_markdown_payload="# Public profile\n\nObserved at a community event.",
    )


def test_schema_serde_round_trips_raw_event() -> None:
    event = make_raw_event()
    serde = SchemaSerde(RawEvent)

    restored = serde.deserialize(serde.serialize(event))

    assert restored == event


def test_consumer_deserializes_schema_payload() -> None:
    async def run() -> None:
        event = make_raw_event()
        message = FakeMessage(value=SchemaSerde(RawEvent).serialize(event))
        fake_consumer = FakeConsumer(message)
        consumer = AsyncSchemaConsumer(
            EventBusConfig(),
            RawEvent,
            ["osint.raw.events"],
            "schema-tests",
            consumer_factory=lambda: fake_consumer,
        )

        record = await consumer.get_one()

        assert fake_consumer.started is True
        assert record.value == event
        assert record.topic == "osint.raw.events"
        await consumer.stop()
        assert fake_consumer.stopped is True

    asyncio.run(run())


def test_producer_uses_exponential_backoff_for_transient_pressure() -> None:
    async def run() -> None:
        event = make_raw_event()
        delays: list[float] = []
        fake_producer = FakeProducer(failures_before_success=2)

        async def capture_sleep(delay: float) -> None:
            delays.append(delay)

        producer = AsyncSchemaProducer(
            EventBusConfig(),
            RawEvent,
            producer_factory=lambda: fake_producer,
            transient_errors=(TransientBackpressure,),
            backoff_policy=BackoffPolicy(
                max_attempts=4,
                initial_delay_seconds=0.1,
                max_delay_seconds=1.0,
                jitter_ratio=0.0,
            ),
            sleep=capture_sleep,
        )

        result = await producer.send("osint.raw.events", event)

        assert result.delivered is True
        assert result.attempts == 3
        assert result.partition == 2
        assert result.offset == 42
        assert delays == [0.1, 0.2]
        assert fake_producer.started is True

    asyncio.run(run())


def test_producer_degrades_after_backoff_budget_is_exhausted() -> None:
    async def run() -> None:
        event = make_raw_event()
        delays: list[float] = []
        fake_producer = FakeProducer(failures_before_success=10)

        async def capture_sleep(delay: float) -> None:
            delays.append(delay)

        producer = AsyncSchemaProducer(
            EventBusConfig(),
            RawEvent,
            producer_factory=lambda: fake_producer,
            transient_errors=(TransientBackpressure,),
            backoff_policy=BackoffPolicy(
                max_attempts=3,
                initial_delay_seconds=0.1,
                max_delay_seconds=1.0,
                jitter_ratio=0.0,
            ),
            sleep=capture_sleep,
        )

        result = await producer.send("osint.raw.events", event)

        assert result.delivered is False
        assert result.attempts == 3
        assert result.error == "broker queue saturated"
        assert delays == [0.1, 0.2]

    asyncio.run(run())
