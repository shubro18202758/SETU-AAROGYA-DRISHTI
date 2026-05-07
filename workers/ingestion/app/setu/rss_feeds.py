"""RSS / Atom feed connector backed by feedparser.

Feedparser is BSD-licensed, dependency-light, and works fully offline against
cached XML — making it a perfect demo source. Use it for health-news outlets,
PIB releases, MoHFW bulletins, ICMR press notes, etc.
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

_MAX_TEXT_LENGTH = 8_000


class RssFeedConnector:
    name = "rss_feeds"
    connector_type = "rss"

    @property
    def available(self) -> bool:
        try:
            import feedparser  # type: ignore[import-not-found]  # noqa: F401
        except ImportError:
            return False
        return True

    async def poll(
        self,
        source: SourceConfig,
        context: ConnectorContext,
    ) -> ConnectorResult:
        if not self.available:
            return ConnectorResult(
                health=ConnectorHealth(success=False, error="feedparser_unavailable"),
                mentions=(),
            )

        params = source.connector_params
        feed_urls = tuple(params.get("feed_urls", ()))
        if not feed_urls:
            return ConnectorResult(
                health=ConnectorHealth(success=False, error="no_feed_urls"),
                mentions=(),
            )

        keywords = tuple(str(k).lower() for k in params.get("keywords", ()))

        emitted: list[HealthMention] = []
        for url in feed_urls:
            try:
                entries = await asyncio.to_thread(self._parse, url)
            except Exception as exc:  # noqa: BLE001
                logger.warning("RSS parse failed for %s: %s", url, exc)
                continue

            for entry in entries:
                title = (entry.get("title") or "").strip()
                summary = (entry.get("summary") or entry.get("description") or "").strip()
                text = (title + "\n\n" + summary).strip()[:_MAX_TEXT_LENGTH]
                if not text:
                    continue
                if keywords and not any(k in text.lower() for k in keywords):
                    continue
                link = entry.get("link") or url
                author = entry.get("author") or "rss"
                emitted.append(
                    HealthMention(
                        id=uuid4(),
                        project_id=context.project_id,
                        source_config_id=source.id,
                        connector_type="rss",
                        source_uri=str(link),
                        author_hash=hash_author(author),
                        fetched_at=datetime.now(UTC),
                        original_text=text,
                        extra={
                            "feed_url": url,
                            "guid": entry.get("id") or entry.get("link") or "",
                        },
                    )
                )

        return ConnectorResult(
            health=ConnectorHealth(success=True, items_emitted=len(emitted)),
            mentions=tuple(emitted),
        )

    def _parse(self, url: str) -> list[dict[str, Any]]:
        import feedparser  # type: ignore[import-not-found]

        parsed = feedparser.parse(url)
        return [dict(entry) for entry in (parsed.entries or [])]
