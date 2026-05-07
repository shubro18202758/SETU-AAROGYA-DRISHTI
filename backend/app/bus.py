from __future__ import annotations

import asyncio
import inspect
from collections.abc import AsyncIterator, Awaitable, Callable, Mapping, Sequence
from dataclasses import dataclass, replace
from importlib import import_module
from random import random
from typing import Any, Generic, TypeVar, cast

from pydantic import TypeAdapter, ValidationError

from .schemas import UniversalSchema

SchemaT = TypeVar("SchemaT", bound=UniversalSchema)
ProducerFactory = Callable[[], Any]
ConsumerFactory = Callable[[], Any]
Sleep = Callable[[float], Awaitable[None]]


@dataclass(frozen=True, slots=True)
class EventBusConfig:
    bootstrap_servers: str | Sequence[str] = "localhost:19092"
    client_id: str = "localized-osint"
    request_timeout_ms: int = 30_000
    linger_ms: int = 5
    max_batch_size: int = 131_072
    compression_type: str = "zstd"
    enable_auto_commit: bool = True
    auto_offset_reset: str = "earliest"
    max_poll_records: int = 250


@dataclass(frozen=True, slots=True)
class BackoffPolicy:
    max_attempts: int = 6
    initial_delay_seconds: float = 0.05
    max_delay_seconds: float = 3.0
    jitter_ratio: float = 0.15

    def delay_for_attempt(self, attempt: int) -> float:
        delay = min(self.initial_delay_seconds * (2 ** max(attempt - 1, 0)), self.max_delay_seconds)
        if self.jitter_ratio <= 0:
            return delay
        return delay + (delay * self.jitter_ratio * random())


@dataclass(frozen=True, slots=True)
class SendResult:
    delivered: bool
    topic: str
    attempts: int
    partition: int | None = None
    offset: int | None = None
    error: str | None = None


@dataclass(frozen=True, slots=True)
class ConsumedRecord(Generic[SchemaT]):
    value: SchemaT
    topic: str
    partition: int
    offset: int
    key: bytes | None
    timestamp: int | None
    headers: tuple[tuple[str, bytes], ...]


class EventBusBackpressureError(RuntimeError):
    def __init__(self, topic: str, attempts: int, cause: BaseException) -> None:
        super().__init__(f"event bus backpressure on {topic!r} after {attempts} attempts: {cause}")
        self.topic = topic
        self.attempts = attempts
        self.__cause__ = cause


class SchemaSerde(Generic[SchemaT]):
    def __init__(self, schema_type: type[SchemaT]) -> None:
        self.schema_type = schema_type
        self._adapter = TypeAdapter(schema_type)

    def serialize(self, value: SchemaT) -> bytes:
        if not isinstance(value, self.schema_type):
            raise TypeError(f"expected {self.schema_type.__name__}, got {type(value).__name__}")
        return self._adapter.dump_json(value)

    def deserialize(self, payload: bytes | bytearray | memoryview) -> SchemaT:
        return self._adapter.validate_json(bytes(payload))


async def _maybe_await(value: Any) -> Any:
    if inspect.isawaitable(value):
        return await value
    return value


def _default_transient_errors() -> tuple[type[BaseException], ...]:
    fallback_errors: tuple[type[BaseException], ...] = (TimeoutError, OSError)
    try:
        errors = import_module("aiokafka.errors")
    except ModuleNotFoundError:
        return fallback_errors

    names = (
        "KafkaConnectionError",
        "KafkaTimeoutError",
        "RequestTimedOutError",
        "NotLeaderForPartitionError",
        "LeaderNotAvailableError",
    )
    resolved = tuple(
        cast(type[BaseException], getattr(errors, name)) for name in names if hasattr(errors, name)
    )
    return resolved or fallback_errors


def _normalize_key(key: str | bytes | None) -> bytes | None:
    if key is None or isinstance(key, bytes):
        return key
    return key.encode("utf-8")


def _normalize_headers(headers: Mapping[str, str | bytes] | None) -> list[tuple[str, bytes]] | None:
    if headers is None:
        return None
    return [
        (name, value if isinstance(value, bytes) else value.encode("utf-8"))
        for name, value in headers.items()
    ]


class AsyncSchemaProducer(Generic[SchemaT]):
    def __init__(
        self,
        config: EventBusConfig,
        schema_type: type[SchemaT],
        *,
        producer_factory: ProducerFactory | None = None,
        backoff_policy: BackoffPolicy | None = None,
        transient_errors: tuple[type[BaseException], ...] | None = None,
        sleep: Sleep = asyncio.sleep,
    ) -> None:
        self.config = config
        self.serde = SchemaSerde(schema_type)
        self.backoff_policy = backoff_policy or BackoffPolicy()
        self._producer_factory = producer_factory or self._default_producer_factory
        self._transient_errors = transient_errors or _default_transient_errors()
        self._sleep = sleep
        self._producer: Any | None = None
        self._start_lock = asyncio.Lock()

    async def __aenter__(self) -> AsyncSchemaProducer[SchemaT]:
        await self.start()
        return self

    async def __aexit__(self, *_: object) -> None:
        await self.stop()

    def _default_producer_factory(self) -> Any:
        producer_cls = import_module("aiokafka").AIOKafkaProducer
        return producer_cls(
            bootstrap_servers=self.config.bootstrap_servers,
            client_id=self.config.client_id,
            acks="all",
            compression_type=self.config.compression_type,
            linger_ms=self.config.linger_ms,
            max_batch_size=self.config.max_batch_size,
            request_timeout_ms=self.config.request_timeout_ms,
        )

    async def start(self) -> None:
        async with self._start_lock:
            if self._producer is not None:
                return
            producer = await _maybe_await(self._producer_factory())
            await producer.start()
            self._producer = producer

    async def stop(self) -> None:
        async with self._start_lock:
            if self._producer is None:
                return
            producer = self._producer
            self._producer = None
            await producer.stop()

    async def send(
        self,
        topic: str,
        value: SchemaT,
        *,
        key: str | bytes | None = None,
        headers: Mapping[str, str | bytes] | None = None,
        raise_on_failure: bool = False,
    ) -> SendResult:
        payload = self.serde.serialize(value)
        normalized_key = _normalize_key(key)
        normalized_headers = _normalize_headers(headers)
        last_error: BaseException | None = None

        for attempt in range(1, self.backoff_policy.max_attempts + 1):
            await self.start()
            producer = self._producer
            if producer is None:
                raise RuntimeError("event bus producer failed to start")
            try:
                metadata = await producer.send_and_wait(
                    topic,
                    payload,
                    key=normalized_key,
                    headers=normalized_headers,
                )
                return SendResult(
                    delivered=True,
                    topic=topic,
                    attempts=attempt,
                    partition=getattr(metadata, "partition", None),
                    offset=getattr(metadata, "offset", None),
                )
            except self._transient_errors as exc:
                last_error = exc
                if attempt == self.backoff_policy.max_attempts:
                    break
                await self._sleep(self.backoff_policy.delay_for_attempt(attempt))

        if last_error is None:
            last_error = RuntimeError("send failed without a captured error")
        if raise_on_failure:
            raise EventBusBackpressureError(topic, self.backoff_policy.max_attempts, last_error)
        return SendResult(
            delivered=False,
            topic=topic,
            attempts=self.backoff_policy.max_attempts,
            error=str(last_error),
        )


class AsyncSchemaConsumer(Generic[SchemaT]):
    def __init__(
        self,
        config: EventBusConfig,
        schema_type: type[SchemaT],
        topics: Sequence[str],
        group_id: str,
        *,
        consumer_factory: ConsumerFactory | None = None,
        skip_invalid_payloads: bool = True,
    ) -> None:
        self.config = config
        self.serde = SchemaSerde(schema_type)
        self.topics = tuple(topics)
        self.group_id = group_id
        self.skip_invalid_payloads = skip_invalid_payloads
        self._consumer_factory = consumer_factory or self._default_consumer_factory
        self._consumer: Any | None = None
        self._start_lock = asyncio.Lock()

    async def __aenter__(self) -> AsyncSchemaConsumer[SchemaT]:
        await self.start()
        return self

    async def __aexit__(self, *_: object) -> None:
        await self.stop()

    def __aiter__(self) -> AsyncIterator[ConsumedRecord[SchemaT]]:
        return self.records()

    def _default_consumer_factory(self) -> Any:
        consumer_cls = import_module("aiokafka").AIOKafkaConsumer
        return consumer_cls(
            *self.topics,
            bootstrap_servers=self.config.bootstrap_servers,
            client_id=self.config.client_id,
            group_id=self.group_id,
            enable_auto_commit=self.config.enable_auto_commit,
            auto_offset_reset=self.config.auto_offset_reset,
            max_poll_records=self.config.max_poll_records,
            request_timeout_ms=self.config.request_timeout_ms,
        )

    async def start(self) -> None:
        async with self._start_lock:
            if self._consumer is not None:
                return
            consumer = await _maybe_await(self._consumer_factory())
            await consumer.start()
            self._consumer = consumer

    async def stop(self) -> None:
        async with self._start_lock:
            if self._consumer is None:
                return
            consumer = self._consumer
            self._consumer = None
            await consumer.stop()

    async def records(self) -> AsyncIterator[ConsumedRecord[SchemaT]]:
        await self.start()
        consumer = self._consumer
        if consumer is None:
            raise RuntimeError("event bus consumer failed to start")
        async for message in consumer:
            try:
                yield self._decode_message(message)
            except ValidationError:
                if not self.skip_invalid_payloads:
                    raise

    async def get_one(self) -> ConsumedRecord[SchemaT]:
        await self.start()
        consumer = self._consumer
        if consumer is None:
            raise RuntimeError("event bus consumer failed to start")
        message = await consumer.getone()
        return self._decode_message(message)

    def _decode_message(self, message: Any) -> ConsumedRecord[SchemaT]:
        headers = tuple(getattr(message, "headers", None) or ())
        return ConsumedRecord(
            value=self.serde.deserialize(message.value),
            topic=message.topic,
            partition=message.partition,
            offset=message.offset,
            key=message.key,
            timestamp=getattr(message, "timestamp", None),
            headers=headers,
        )


class EventBusConnectionPool:
    def __init__(self, config: EventBusConfig) -> None:
        self.config = config
        self._lock = asyncio.Lock()
        self._producers: dict[str, AsyncSchemaProducer[Any]] = {}
        self._consumers: dict[tuple[str, tuple[str, ...], str], AsyncSchemaConsumer[Any]] = {}

    async def producer(
        self,
        schema_type: type[SchemaT],
        *,
        client_id: str | None = None,
    ) -> AsyncSchemaProducer[SchemaT]:
        key = f"{client_id or self.config.client_id}:{schema_type.__module__}.{schema_type.__qualname__}"
        async with self._lock:
            if key not in self._producers:
                config = replace(self.config, client_id=client_id or self.config.client_id)
                self._producers[key] = AsyncSchemaProducer(config, schema_type)
            producer = cast(AsyncSchemaProducer[SchemaT], self._producers[key])
        await producer.start()
        return producer

    async def consumer(
        self,
        schema_type: type[SchemaT],
        topics: Sequence[str],
        group_id: str,
        *,
        client_id: str | None = None,
    ) -> AsyncSchemaConsumer[SchemaT]:
        topic_key = tuple(topics)
        key = (f"{client_id or self.config.client_id}:{schema_type.__module__}.{schema_type.__qualname__}", topic_key, group_id)
        async with self._lock:
            if key not in self._consumers:
                config = replace(self.config, client_id=client_id or self.config.client_id)
                self._consumers[key] = AsyncSchemaConsumer(config, schema_type, topic_key, group_id)
            consumer = cast(AsyncSchemaConsumer[SchemaT], self._consumers[key])
        await consumer.start()
        return consumer

    async def close(self) -> None:
        async with self._lock:
            producers = tuple(self._producers.values())
            consumers = tuple(self._consumers.values())
            self._producers.clear()
            self._consumers.clear()
        await asyncio.gather(*(consumer.stop() for consumer in consumers), return_exceptions=True)
        await asyncio.gather(*(producer.stop() for producer in producers), return_exceptions=True)


async def create_producer(bootstrap_servers: str) -> Any:
    producer_cls = import_module("aiokafka").AIOKafkaProducer
    producer = producer_cls(
        bootstrap_servers=bootstrap_servers,
        acks="all",
        compression_type="zstd",
        linger_ms=5,
        max_batch_size=131072,
    )
    await producer.start()
    return producer
