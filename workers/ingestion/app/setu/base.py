"""Base contracts for SETU social-listening connectors."""

from __future__ import annotations

import hashlib
from collections.abc import AsyncIterator
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any, Protocol

from backend.app.schemas import HealthMention, SourceConfig


def hash_author(handle: str | None, *, salt: str = "setu-v1") -> str:
    """Stable, salted, non-reversible hash for an author handle.

    PRIMARY PII guard at the connector boundary. We never persist the raw
    handle anywhere downstream; only this 16-hex truncation appears on the
    wire and in storage.
    """

    payload = f"{salt}::{(handle or 'anonymous').strip().lower()}".encode()
    return hashlib.blake2b(payload, digest_size=8).hexdigest()


@dataclass(frozen=True, slots=True)
class ConnectorContext:
    """Per-poll execution context."""

    project_id: Any  # UUID; kept Any to stay decoupled from pydantic at module level
    started_at: datetime = field(default_factory=lambda: datetime.now(UTC))
    cursor: str | None = None  # opaque per-source resume token


@dataclass(frozen=True, slots=True)
class ConnectorHealth:
    """Reported by each connector after every poll cycle."""

    success: bool
    items_emitted: int = 0
    error: str | None = None
    next_cursor: str | None = None


@dataclass(frozen=True, slots=True)
class ConnectorResult:
    health: ConnectorHealth
    mentions: tuple[HealthMention, ...]


class SetuConnector(Protocol):
    """Pollable social-listening source.

    Implementations:
      * ``reddit_praw.RedditConnector`` — PRAW, free, requires app credentials.
      * ``youtube_comments.YouTubeCommentsConnector`` — yt-dlp, no API key.
      * ``rss_feeds.RssFeedConnector`` — feedparser, fully offline-friendly.
      * ``telegram_public.TelegramConnector`` — Telethon, free tier.
      * ``web_forum.WebForumConnector`` — wraps Crawl4AI for forum HTML.
      * ``x_replay_fixture.XReplayFixtureConnector`` — replays JSON dumps
        for offline demos / CI.
    """

    name: str
    connector_type: str

    @property
    def available(self) -> bool:
        """Return True if this connector has the credentials/files it needs."""
        ...

    async def poll(
        self,
        source: SourceConfig,
        context: ConnectorContext,
    ) -> ConnectorResult:
        ...


async def empty_async_iter() -> AsyncIterator[HealthMention]:  # pragma: no cover - helper
    if False:
        yield  # type: ignore[unreachable]
