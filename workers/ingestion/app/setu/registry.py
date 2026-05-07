"""Default registry of SETU connectors and a small async polling runner."""

from __future__ import annotations

import asyncio
import logging
from collections.abc import Iterable, Mapping
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any

from backend.app.schemas import HealthMention, SourceConfig

from .backoff import ConnectorBreakers
from .base import ConnectorContext, ConnectorResult, SetuConnector
from .reddit_praw import RedditConnector
from .rss_feeds import RssFeedConnector
from .telegram_public import TelegramConnector
from .web_forum import WebForumConnector
from .x_replay_fixture import XReplayFixtureConnector
from .youtube_comments import YouTubeCommentsConnector

logger = logging.getLogger(__name__)


@dataclass(frozen=True, slots=True)
class RunnerConfig:
    realtime_interval_s: float = 30.0
    daily_interval_s: float = 6 * 60 * 60.0
    weekly_interval_s: float = 7 * 24 * 60 * 60.0


def default_connectors(
    *,
    reddit_client_id: str | None = None,
    reddit_client_secret: str | None = None,
    reddit_user_agent: str = "setu-aarogya-drishti/0.1",
    youtube_cookies_path: str | None = None,
    telegram_api_id: int | None = None,
    telegram_api_hash: str | None = None,
    telegram_session_path: str | None = None,
    fixtures_root: str = "./infrastructure/fixtures/x",
) -> tuple[SetuConnector, ...]:
    return (
        RedditConnector(
            client_id=reddit_client_id,
            client_secret=reddit_client_secret,
            user_agent=reddit_user_agent,
        ),
        YouTubeCommentsConnector(cookies_path=youtube_cookies_path),
        RssFeedConnector(),
        TelegramConnector(
            api_id=telegram_api_id,
            api_hash=telegram_api_hash,
            session_path=telegram_session_path,
        ),
        WebForumConnector(),
        XReplayFixtureConnector(fixtures_root=fixtures_root),
    )


def build_registry(connectors: Iterable[SetuConnector]) -> Mapping[str, SetuConnector]:
    return {connector.connector_type: connector for connector in connectors}


async def poll_once(
    source: SourceConfig,
    *,
    project_id: Any,
    registry: Mapping[str, SetuConnector],
    cursor: str | None = None,
) -> ConnectorResult:
    connector = registry.get(source.connector_type)
    if connector is None:
        from .base import ConnectorHealth

        return ConnectorResult(
            health=ConnectorHealth(success=False, error=f"no_connector_for_type:{source.connector_type}"),
            mentions=(),
        )
    context = ConnectorContext(project_id=project_id, started_at=datetime.now(UTC), cursor=cursor)
    return await connector.poll(source, context)


async def run_forever(
    sources: Iterable[SourceConfig],
    *,
    project_id: Any,
    registry: Mapping[str, SetuConnector],
    on_mentions: Any,  # async callable: tuple[HealthMention, ...] -> None
    config: RunnerConfig | None = None,
    sleep: Any = asyncio.sleep,
    breakers: ConnectorBreakers | None = None,
) -> None:
    config = config or RunnerConfig()
    breakers = breakers if breakers is not None else ConnectorBreakers()
    intervals = {
        "realtime": config.realtime_interval_s,
        "daily": config.daily_interval_s,
        "weekly": config.weekly_interval_s,
    }

    async def _loop_one(source: SourceConfig) -> None:
        interval = intervals[source.latency_tier]
        while True:
            if breakers.should_skip(source.id):
                delay = breakers.next_delay(source.id, base=interval)
                logger.info(
                    "circuit breaker open for source=%s; sleeping %.1fs before probe",
                    source.id,
                    delay,
                )
                await sleep(delay)
                # Probe attempt below; record outcome to allow recovery.
            try:
                result = await poll_once(source, project_id=project_id, registry=registry)
                if result.mentions:
                    await on_mentions(result.mentions)
                breakers.record(source.id, success=result.health.success)
                if not result.health.success:
                    logger.warning(
                        "connector %s for source %s reported failure: %s",
                        source.connector_type,
                        source.id,
                        result.health.error,
                    )
            except Exception:  # noqa: BLE001
                breakers.record(source.id, success=False)
                logger.exception("connector loop crashed for source %s", source.id)
            delay = breakers.next_delay(source.id, base=interval)
            await sleep(delay)

    await asyncio.gather(*(_loop_one(source) for source in sources if source.enabled))


__all__ = [
    "ConnectorBreakers",
    "RunnerConfig",
    "default_connectors",
    "build_registry",
    "poll_once",
    "run_forever",
]
