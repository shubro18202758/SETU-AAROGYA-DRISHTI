from __future__ import annotations

import asyncio
import inspect
from collections.abc import AsyncIterator, Awaitable, Callable, Iterable, Sequence
from dataclasses import dataclass, field
from datetime import UTC, datetime
from importlib import import_module, metadata
from random import random
from time import monotonic as default_monotonic
from typing import Any, Protocol, TypeVar, cast

from backend.app.bus import AsyncSchemaConsumer, AsyncSchemaProducer, EventBusConfig
from backend.app.schemas import RawEvent, TargetURL

Sleep = Callable[[float], Awaitable[None]]
MemoryUtilizationReader = Callable[[], float]


@dataclass(frozen=True, slots=True)
class ConductorConfig:
    target_topic: str = "osint.targets.urls"
    raw_event_topic: str = "osint.raw.events"
    group_id: str = "osint-conductor"
    max_concurrency: int = 32
    memory_pause_threshold: float = 0.80
    memory_resume_threshold: float = 0.74
    memory_poll_interval_seconds: float = 1.0
    plugin_entry_point_group: str = "localized_osint.collectors"


@dataclass(frozen=True, slots=True)
class RateLimitPolicy:
    max_attempts: int = 5
    initial_delay_seconds: float = 0.25
    max_delay_seconds: float = 30.0
    jitter_ratio: float = 0.20
    per_plugin_interval_seconds: float = 0.0

    def delay_for_attempt(self, attempt: int) -> float:
        base_delay = min(
            self.initial_delay_seconds * (2 ** max(attempt - 1, 0)),
            self.max_delay_seconds,
        )
        if self.jitter_ratio <= 0:
            return base_delay
        return base_delay + (base_delay * self.jitter_ratio * random())


@dataclass(frozen=True, slots=True)
class ExtractionContext:
    proxy: str | None
    attempt: int
    fetched_at: datetime = field(default_factory=lambda: datetime.now(UTC))


@dataclass(frozen=True, slots=True)
class DispatchResult:
    target: TargetURL
    plugin_name: str | None
    dispatched: bool
    attempts: int = 0
    raw_event: RawEvent | None = None
    error: str | None = None


class CollectorPlugin(Protocol):
    name: str

    def can_handle(self, target: TargetURL) -> bool:
        ...

    async def extract(self, target: TargetURL, context: ExtractionContext) -> RawEvent:
        ...


PluginFactory = Callable[[], CollectorPlugin]
PluginLike = CollectorPlugin | type[CollectorPlugin] | PluginFactory


class RateLimitExceeded(RuntimeError):
    def __init__(self, message: str = "rate limit exceeded", retry_after_seconds: float | None = None) -> None:
        super().__init__(message)
        self.retry_after_seconds = retry_after_seconds


class TransientExtractionError(RuntimeError):
    pass


class PluginRegistry:
    def __init__(self) -> None:
        self._plugins: dict[str, CollectorPlugin] = {}

    def register(self, plugin: CollectorPlugin) -> CollectorPlugin:
        if not plugin.name:
            raise ValueError("plugin name must not be empty")
        self._plugins[plugin.name] = plugin
        return plugin

    def unregister(self, name: str) -> None:
        self._plugins.pop(name, None)

    def get(self, name: str) -> CollectorPlugin | None:
        return self._plugins.get(name)

    def all(self) -> tuple[CollectorPlugin, ...]:
        return tuple(self._plugins.values())

    def resolve(self, target: TargetURL) -> CollectorPlugin | None:
        if target.plugin_hint is not None:
            plugin = self.get(target.plugin_hint)
            if plugin is not None and plugin.can_handle(target):
                return plugin
            return None

        return next((plugin for plugin in self._plugins.values() if plugin.can_handle(target)), None)

    def load_entry_points(self, group: str) -> None:
        entry_points = metadata.entry_points()
        try:
            candidates = entry_points.select(group=group)
        except AttributeError:
            candidates = cast(Any, entry_points).get(group, ())

        for entry_point in candidates:
            self.register(_materialize_plugin(entry_point.load()))


def _materialize_plugin(candidate: PluginLike) -> CollectorPlugin:
    if inspect.isclass(candidate):
        return cast(type[CollectorPlugin], candidate)()
    if callable(candidate) and not hasattr(candidate, "extract"):
        return cast(PluginFactory, candidate)()
    return cast(CollectorPlugin, candidate)


async def _maybe_await(value: Any) -> Any:
    if inspect.isawaitable(value):
        return await value
    return value


class ProxyPool:
    def __init__(self, proxies: Iterable[str] = ()) -> None:
        self._proxies = tuple(proxy for proxy in proxies if proxy)
        self._index = 0
        self._lock = asyncio.Lock()

    async def next_proxy(self) -> str | None:
        if not self._proxies:
            return None
        async with self._lock:
            proxy = self._proxies[self._index % len(self._proxies)]
            self._index += 1
            return proxy


class MemoryPressureGate:
    def __init__(
        self,
        *,
        pause_threshold: float,
        resume_threshold: float,
        poll_interval_seconds: float,
        read_utilization: MemoryUtilizationReader | None = None,
        sleep: Sleep = asyncio.sleep,
    ) -> None:
        if resume_threshold > pause_threshold:
            raise ValueError("resume threshold must be less than or equal to pause threshold")
        self.pause_threshold = pause_threshold
        self.resume_threshold = resume_threshold
        self.poll_interval_seconds = poll_interval_seconds
        self._read_utilization = read_utilization or _system_memory_utilization
        self._sleep = sleep
        self._paused = False

    @property
    def paused(self) -> bool:
        return self._paused

    async def wait_until_available(self) -> None:
        while True:
            utilization = self._read_utilization()
            if self._paused:
                if utilization <= self.resume_threshold:
                    self._paused = False
                    return
            elif utilization < self.pause_threshold:
                return
            else:
                self._paused = True

            await self._sleep(self.poll_interval_seconds)


def _system_memory_utilization() -> float:
    psutil = import_module("psutil")
    return float(psutil.virtual_memory().percent) / 100.0


class PluginRateLimiter:
    def __init__(
        self,
        policy: RateLimitPolicy,
        *,
        monotonic: Callable[[], float] | None = None,
        sleep: Sleep = asyncio.sleep,
    ) -> None:
        self.policy = policy
        self._monotonic = monotonic or default_monotonic
        self._sleep = sleep
        self._next_available_at: dict[str, float] = {}
        self._lock = asyncio.Lock()

    async def wait_for_slot(self, plugin_name: str) -> None:
        if self.policy.per_plugin_interval_seconds <= 0:
            return

        async with self._lock:
            now = self._monotonic()
            next_available_at = self._next_available_at.get(plugin_name, now)
            wait_seconds = max(0.0, next_available_at - now)
            self._next_available_at[plugin_name] = max(now, next_available_at) + self._interval_with_jitter()

        if wait_seconds > 0:
            await self._sleep(wait_seconds)

    def _interval_with_jitter(self) -> float:
        interval = self.policy.per_plugin_interval_seconds
        if self.policy.jitter_ratio <= 0:
            return interval
        return interval + (interval * self.policy.jitter_ratio * random())


class Conductor:
    def __init__(
        self,
        config: ConductorConfig,
        registry: PluginRegistry,
        *,
        event_bus_config: EventBusConfig | None = None,
        target_consumer: AsyncSchemaConsumer[TargetURL] | None = None,
        raw_event_producer: AsyncSchemaProducer[RawEvent] | None = None,
        memory_gate: MemoryPressureGate | None = None,
        proxy_pool: ProxyPool | None = None,
        rate_limit_policy: RateLimitPolicy | None = None,
        sleep: Sleep = asyncio.sleep,
    ) -> None:
        self.config = config
        self.registry = registry
        self.event_bus_config = event_bus_config or EventBusConfig(client_id="osint-conductor")
        self.target_consumer = target_consumer
        self.raw_event_producer = raw_event_producer
        self.memory_gate = memory_gate or MemoryPressureGate(
            pause_threshold=config.memory_pause_threshold,
            resume_threshold=config.memory_resume_threshold,
            poll_interval_seconds=config.memory_poll_interval_seconds,
            sleep=sleep,
        )
        self.proxy_pool = proxy_pool or ProxyPool()
        self.rate_limit_policy = rate_limit_policy or RateLimitPolicy()
        self.rate_limiter = PluginRateLimiter(self.rate_limit_policy, sleep=sleep)
        self._sleep = sleep
        self._pending: set[asyncio.Task[DispatchResult]] = set()
        self._stop_event = asyncio.Event()

    async def start(self) -> None:
        if self.target_consumer is None:
            self.target_consumer = AsyncSchemaConsumer(
                self.event_bus_config,
                TargetURL,
                [self.config.target_topic],
                self.config.group_id,
            )
        if self.raw_event_producer is None:
            self.raw_event_producer = AsyncSchemaProducer(self.event_bus_config, RawEvent)
        await self.target_consumer.start()
        await self.raw_event_producer.start()

    async def stop(self) -> None:
        self._stop_event.set()
        pending = tuple(self._pending)
        for task in pending:
            task.cancel()
        await asyncio.gather(*pending, return_exceptions=True)
        self._pending.clear()
        if self.target_consumer is not None:
            await self.target_consumer.stop()
        if self.raw_event_producer is not None:
            await self.raw_event_producer.stop()
        await asyncio.gather(
            *(
                _maybe_await(close())
                for plugin in self.registry.all()
                if callable(close := getattr(plugin, "close", None))
            ),
            return_exceptions=True,
        )

    async def run(self, *, max_records: int | None = None) -> None:
        await self.start()
        assert self.target_consumer is not None
        processed = 0
        try:
            async for record in self.target_consumer.records():
                if self._stop_event.is_set():
                    break
                await self.memory_gate.wait_until_available()
                await self._wait_for_capacity()
                task = asyncio.create_task(self.dispatch(record.value))
                self._pending.add(task)
                task.add_done_callback(self._pending.discard)
                processed += 1
                if max_records is not None and processed >= max_records:
                    break
            await self._drain_pending()
        finally:
            await self.stop()

    async def dispatch(self, target: TargetURL) -> DispatchResult:
        plugin = self.registry.resolve(target)
        if plugin is None:
            return DispatchResult(
                target=target,
                plugin_name=None,
                dispatched=False,
                error="no registered plugin can handle target",
            )

        attempts = 0
        last_error: BaseException | None = None
        for attempt in range(1, self.rate_limit_policy.max_attempts + 1):
            attempts = attempt
            await self.rate_limiter.wait_for_slot(plugin.name)
            context = ExtractionContext(proxy=await self.proxy_pool.next_proxy(), attempt=attempt)
            try:
                raw_event = await plugin.extract(target, context)
                await self._publish(raw_event, target)
                return DispatchResult(
                    target=target,
                    plugin_name=plugin.name,
                    dispatched=True,
                    attempts=attempts,
                    raw_event=raw_event,
                )
            except (RateLimitExceeded, TransientExtractionError, TimeoutError, OSError) as exc:
                last_error = exc
                if attempt == self.rate_limit_policy.max_attempts:
                    break
                delay = self.rate_limit_policy.delay_for_attempt(attempt)
                if isinstance(exc, RateLimitExceeded) and exc.retry_after_seconds is not None:
                    delay = max(delay, exc.retry_after_seconds)
                await self._sleep(delay)

        return DispatchResult(
            target=target,
            plugin_name=plugin.name,
            dispatched=False,
            attempts=attempts,
            error=str(last_error) if last_error is not None else "dispatch failed",
        )

    async def _publish(self, raw_event: RawEvent, target: TargetURL) -> None:
        if self.raw_event_producer is None:
            raise RuntimeError("raw event producer has not been started")
        result = await self.raw_event_producer.send(
            self.config.raw_event_topic,
            raw_event,
            key=str(target.id),
            headers={"collector-target-id": str(target.id)},
        )
        if not result.delivered:
            raise TransientExtractionError(result.error or "raw event publish failed")

    async def _wait_for_capacity(self) -> None:
        while len(self._pending) >= self.config.max_concurrency:
            done, _ = await asyncio.wait(self._pending, return_when=asyncio.FIRST_COMPLETED)
            for task in done:
                task.result()

    async def _drain_pending(self) -> None:
        if not self._pending:
            return
        done = await asyncio.gather(*self._pending, return_exceptions=True)
        self._pending.clear()
        for result in done:
            if isinstance(result, BaseException):
                raise result


async def target_stream_from_records(records: Sequence[TargetURL]) -> AsyncIterator[TargetURL]:
    for record in records:
        yield record