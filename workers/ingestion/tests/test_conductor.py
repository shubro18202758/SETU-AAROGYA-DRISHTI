from __future__ import annotations

import asyncio
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any, cast
from uuid import uuid4

from backend.app.bus import SendResult
from backend.app.schemas import RawEvent, TargetURL
from workers.ingestion.app.conductor import (
    Conductor,
    ConductorConfig,
    ExtractionContext,
    MemoryPressureGate,
    PluginRegistry,
    ProxyPool,
    RateLimitExceeded,
    RateLimitPolicy,
)


@dataclass(frozen=True)
class FakeRecord:
    value: TargetURL


class FakeConsumer:
    def __init__(self, targets: list[TargetURL]) -> None:
        self.targets = targets
        self.started = False
        self.stopped = False

    async def start(self) -> None:
        self.started = True

    async def stop(self) -> None:
        self.stopped = True

    async def records(self) -> Any:
        for target in self.targets:
            yield FakeRecord(target)


class FakeProducer:
    def __init__(self) -> None:
        self.events: list[RawEvent] = []
        self.keys: list[str | bytes | None] = []
        self.started = False
        self.stopped = False

    async def start(self) -> None:
        self.started = True

    async def stop(self) -> None:
        self.stopped = True

    async def send(
        self,
        topic: str,
        value: RawEvent,
        *,
        key: str | bytes | None = None,
        headers: dict[str, str | bytes] | None = None,
    ) -> SendResult:
        self.events.append(value)
        self.keys.append(key)
        return SendResult(delivered=True, topic=topic, attempts=1, partition=0, offset=len(self.events))


class CapturingPlugin:
    name = "public-web"

    def __init__(self, failures_before_success: int = 0) -> None:
        self.failures_before_success = failures_before_success
        self.contexts: list[ExtractionContext] = []

    def can_handle(self, target: TargetURL) -> bool:
        return target.url.startswith("https://")

    async def extract(self, target: TargetURL, context: ExtractionContext) -> RawEvent:
        self.contexts.append(context)
        if self.failures_before_success > 0:
            self.failures_before_success -= 1
            raise RateLimitExceeded("remote source asked us to slow down", retry_after_seconds=0.5)
        return RawEvent(
            id=uuid4(),
            collector_name=self.name,
            source_uri=target.url,
            content_type="text/markdown",
            fetch_timestamp=datetime.now(UTC),
            raw_markdown_payload="# Public profile\n\nObserved at a community event.",
        )


def make_target(plugin_hint: str | None = None) -> TargetURL:
    return TargetURL(
        id=uuid4(),
        url="https://example.test/profile",
        submitted_at=datetime.now(UTC),
        plugin_hint=plugin_hint,
    )


def test_registry_resolves_dynamically_registered_plugin() -> None:
    registry = PluginRegistry()
    plugin = CapturingPlugin()

    registry.register(plugin)

    assert registry.resolve(make_target("public-web")) is plugin


def test_memory_gate_pauses_until_below_resume_threshold() -> None:
    async def run() -> None:
        samples = iter([0.83, 0.79, 0.73])
        sleeps: list[float] = []

        async def capture_sleep(delay: float) -> None:
            sleeps.append(delay)

        gate = MemoryPressureGate(
            pause_threshold=0.80,
            resume_threshold=0.74,
            poll_interval_seconds=0.25,
            read_utilization=lambda: next(samples),
            sleep=capture_sleep,
        )

        await gate.wait_until_available()

        assert gate.paused is False
        assert sleeps == [0.25, 0.25]

    asyncio.run(run())


def test_dispatch_rotates_proxies_and_backs_off_with_jitter_disabled() -> None:
    async def run() -> None:
        sleeps: list[float] = []
        plugin = CapturingPlugin(failures_before_success=1)
        registry = PluginRegistry()
        registry.register(plugin)
        producer = FakeProducer()

        async def capture_sleep(delay: float) -> None:
            sleeps.append(delay)

        conductor = Conductor(
            ConductorConfig(max_concurrency=2),
            registry,
            raw_event_producer=cast(Any, producer),
            proxy_pool=ProxyPool(["http://proxy-a.local:8080", "http://proxy-b.local:8080"]),
            rate_limit_policy=RateLimitPolicy(
                max_attempts=3,
                initial_delay_seconds=0.1,
                max_delay_seconds=1.0,
                jitter_ratio=0.0,
            ),
            sleep=capture_sleep,
        )

        result = await conductor.dispatch(make_target())

        assert result.dispatched is True
        assert result.attempts == 2
        assert sleeps == [0.5]
        assert [context.proxy for context in plugin.contexts] == [
            "http://proxy-a.local:8080",
            "http://proxy-b.local:8080",
        ]
        assert len(producer.events) == 1

    asyncio.run(run())


def test_run_reads_targets_and_publishes_raw_events() -> None:
    async def run() -> None:
        targets = [make_target(), make_target()]
        plugin = CapturingPlugin()
        registry = PluginRegistry()
        registry.register(plugin)
        consumer = FakeConsumer(targets)
        producer = FakeProducer()
        memory_gate = MemoryPressureGate(
            pause_threshold=0.80,
            resume_threshold=0.74,
            poll_interval_seconds=0.01,
            read_utilization=lambda: 0.10,
        )
        conductor = Conductor(
            ConductorConfig(max_concurrency=1),
            registry,
            target_consumer=cast(Any, consumer),
            raw_event_producer=cast(Any, producer),
            memory_gate=memory_gate,
            rate_limit_policy=RateLimitPolicy(jitter_ratio=0.0),
        )

        await conductor.run(max_records=2)

        assert consumer.started is True
        assert consumer.stopped is True
        assert producer.started is True
        assert producer.stopped is True
        assert len(producer.events) == 2
        assert producer.keys == [str(target.id) for target in targets]

    asyncio.run(run())
