"""Web-forum connector — wraps the existing OSINT crawler for HTML pages.

Many Indian forums (HealthUnlocked clones, MyMedicalMantra threads, etc.)
expose plain HTML at predictable URLs. Rather than re-implement scraping,
this connector defers to the OSINT ``web_extraction`` plugin used by the
generic engine, then wraps the resulting markdown in a
:class:`HealthMention`.
"""

from __future__ import annotations

import logging
from datetime import UTC, datetime
from typing import Any
from uuid import uuid4

from backend.app.schemas import HealthMention, SourceConfig, TargetURL

from .base import ConnectorContext, ConnectorHealth, ConnectorResult, hash_author

logger = logging.getLogger(__name__)

_MAX_TEXT_LENGTH = 16_000


class WebForumConnector:
    name = "web_forum"
    connector_type = "web"

    def __init__(self) -> None:
        self._plugin: Any | None = None

    @property
    def available(self) -> bool:
        return True  # always available; gracefully degrades if Crawl4AI missing

    def _get_plugin(self) -> Any | None:
        if self._plugin is not None:
            return self._plugin
        try:
            from ..plugins.web_extraction import WebExtractionPlugin  # type: ignore[attr-defined]
        except (ImportError, AttributeError):
            logger.warning("web_extraction plugin unavailable; WebForumConnector disabled")
            return None
        self._plugin = WebExtractionPlugin()
        return self._plugin

    async def poll(
        self,
        source: SourceConfig,
        context: ConnectorContext,
    ) -> ConnectorResult:
        plugin = self._get_plugin()
        if plugin is None:
            return ConnectorResult(
                health=ConnectorHealth(success=False, error="web_extraction_unavailable"),
                mentions=(),
            )

        params = source.connector_params
        urls = tuple(params.get("urls", ()))
        if not urls:
            return ConnectorResult(
                health=ConnectorHealth(success=False, error="no_urls_configured"),
                mentions=(),
            )

        keywords = tuple(str(k).lower() for k in params.get("keywords", ()))

        from ..conductor import ExtractionContext  # local import to avoid cycle

        emitted: list[HealthMention] = []
        for url in urls:
            try:
                target = TargetURL(
                    id=uuid4(),
                    url=url,
                    submitted_at=datetime.now(UTC),
                    plugin_hint="web_extraction",
                )
                raw_event = await plugin.extract(
                    target,
                    ExtractionContext(proxy=None, attempt=1),
                )
            except Exception as exc:  # noqa: BLE001
                logger.warning("WebForum extract failed for %s: %s", url, exc)
                continue

            text = raw_event.raw_markdown_payload.strip()[:_MAX_TEXT_LENGTH]
            if not text:
                continue
            if keywords and not any(k in text.lower() for k in keywords):
                continue
            emitted.append(
                HealthMention(
                    id=uuid4(),
                    project_id=context.project_id,
                    source_config_id=source.id,
                    connector_type="web",
                    source_uri=str(raw_event.source_uri),
                    author_hash=hash_author("web-anonymous"),
                    fetched_at=datetime.now(UTC),
                    original_text=text,
                    extra={"raw_event_id": str(raw_event.id)},
                )
            )

        return ConnectorResult(
            health=ConnectorHealth(success=True, items_emitted=len(emitted)),
            mentions=tuple(emitted),
        )
