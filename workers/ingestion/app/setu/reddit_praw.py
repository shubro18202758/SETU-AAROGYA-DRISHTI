"""Reddit connector backed by PRAW.

PRAW (the Python Reddit API Wrapper) ships under the BSD-2 license and uses
Reddit's public OAuth API at no cost — exactly the kind of source we are
willing to depend on (no scraping, no paid API tier).

If credentials are missing the connector reports ``available = False`` and the
runner skips it cleanly; this lets the rest of the system run during demos
without requiring every operator to register a Reddit app.
"""

from __future__ import annotations

import asyncio
import logging
from datetime import UTC, datetime
from typing import Any
from uuid import uuid4

from backend.app.schemas import HealthMention, SourceConfig

from .base import ConnectorContext, ConnectorHealth, ConnectorResult, hash_author

logger = logging.getLogger(__name__)

_DEFAULT_LIMIT = 50
_MAX_TEXT_LENGTH = 8_000


class RedditConnector:
    name = "reddit_praw"
    connector_type = "reddit"

    def __init__(
        self,
        *,
        client_id: str | None,
        client_secret: str | None,
        user_agent: str,
    ) -> None:
        self._client_id = client_id
        self._client_secret = client_secret
        self._user_agent = user_agent
        self._reddit: Any | None = None

    @property
    def available(self) -> bool:
        return bool(self._client_id and self._client_secret)

    def _get_client(self) -> Any | None:
        if not self.available:
            return None
        if self._reddit is not None:
            return self._reddit
        try:
            import praw  # type: ignore[import-not-found]
        except ImportError:
            logger.warning("praw not installed; Reddit connector disabled")
            return None
        self._reddit = praw.Reddit(
            client_id=self._client_id,
            client_secret=self._client_secret,
            user_agent=self._user_agent,
            check_for_async=False,
        )
        self._reddit.read_only = True
        return self._reddit

    async def poll(
        self,
        source: SourceConfig,
        context: ConnectorContext,
    ) -> ConnectorResult:
        if not self.available:
            return ConnectorResult(
                health=ConnectorHealth(success=False, error="missing_credentials"),
                mentions=(),
            )

        client = self._get_client()
        if client is None:
            return ConnectorResult(
                health=ConnectorHealth(success=False, error="praw_unavailable"),
                mentions=(),
            )

        params = source.connector_params
        subreddits = tuple(params.get("subreddits", ()))
        if not subreddits:
            return ConnectorResult(
                health=ConnectorHealth(success=False, error="no_subreddits_configured"),
                mentions=(),
            )

        keywords = tuple(str(k).lower() for k in params.get("keywords", ()))
        limit = int(params.get("limit", _DEFAULT_LIMIT))

        try:
            mentions = await asyncio.to_thread(
                self._collect,
                client=client,
                source=source,
                project_id=context.project_id,
                subreddits=subreddits,
                keywords=keywords,
                limit=limit,
            )
        except Exception as exc:  # noqa: BLE001 - surface any PRAW error as connector failure
            logger.exception("Reddit poll failed for source %s", source.id)
            return ConnectorResult(
                health=ConnectorHealth(success=False, error=str(exc)[:480]),
                mentions=(),
            )

        return ConnectorResult(
            health=ConnectorHealth(success=True, items_emitted=len(mentions)),
            mentions=tuple(mentions),
        )

    def _collect(
        self,
        *,
        client: Any,
        source: SourceConfig,
        project_id: Any,
        subreddits: tuple[str, ...],
        keywords: tuple[str, ...],
        limit: int,
    ) -> list[HealthMention]:
        emitted: list[HealthMention] = []
        joined = "+".join(subreddits)
        subreddit = client.subreddit(joined)

        for submission in subreddit.new(limit=limit):
            text = (submission.title or "") + "\n\n" + (submission.selftext or "")
            text = text.strip()[:_MAX_TEXT_LENGTH]
            if not text:
                continue
            if keywords and not any(k in text.lower() for k in keywords):
                continue
            emitted.append(
                HealthMention(
                    id=uuid4(),
                    project_id=project_id,
                    source_config_id=source.id,
                    connector_type="reddit",
                    source_uri=f"https://www.reddit.com{submission.permalink}",
                    author_hash=hash_author(getattr(submission.author, "name", None)),
                    fetched_at=datetime.now(UTC),
                    original_text=text,
                    extra={
                        "subreddit": str(submission.subreddit),
                        "score": int(getattr(submission, "score", 0) or 0),
                        "num_comments": int(getattr(submission, "num_comments", 0) or 0),
                        "kind": "submission",
                    },
                )
            )
        return emitted
