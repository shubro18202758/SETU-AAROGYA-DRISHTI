"""YouTube comments connector backed by yt-dlp.

`yt-dlp` is GPL-friendly, free, and supports comment extraction without an
API key (uses the public web endpoints). Each ``connector_params.video_ids``
entry is harvested for top-level comments.
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

_MAX_COMMENTS = 200
_MAX_TEXT_LENGTH = 4_000


class YouTubeCommentsConnector:
    name = "youtube_comments"
    connector_type = "youtube"

    def __init__(self, *, cookies_path: str | None = None) -> None:
        self._cookies_path = cookies_path

    @property
    def available(self) -> bool:
        try:
            import yt_dlp  # type: ignore[import-not-found]  # noqa: F401
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
                health=ConnectorHealth(success=False, error="yt_dlp_unavailable"),
                mentions=(),
            )

        params = source.connector_params
        video_ids = tuple(params.get("video_ids", ()))
        if not video_ids:
            return ConnectorResult(
                health=ConnectorHealth(success=False, error="no_video_ids"),
                mentions=(),
            )

        max_comments = int(params.get("max_comments", _MAX_COMMENTS))
        keywords = tuple(str(k).lower() for k in params.get("keywords", ()))

        all_mentions: list[HealthMention] = []
        for video_id in video_ids:
            try:
                comments = await asyncio.to_thread(self._extract_comments, video_id, max_comments)
            except Exception as exc:  # noqa: BLE001
                logger.warning("yt-dlp failed for %s: %s", video_id, exc)
                continue

            for comment in comments:
                text = (comment.get("text") or "").strip()[:_MAX_TEXT_LENGTH]
                if not text:
                    continue
                if keywords and not any(k in text.lower() for k in keywords):
                    continue
                all_mentions.append(
                    HealthMention(
                        id=uuid4(),
                        project_id=context.project_id,
                        source_config_id=source.id,
                        connector_type="youtube",
                        source_uri=f"https://www.youtube.com/watch?v={video_id}",
                        author_hash=hash_author(comment.get("author")),
                        fetched_at=datetime.now(UTC),
                        original_text=text,
                        extra={
                            "video_id": video_id,
                            "like_count": int(comment.get("like_count") or 0),
                            "is_pinned": bool(comment.get("is_pinned", False)),
                        },
                    )
                )

        return ConnectorResult(
            health=ConnectorHealth(success=True, items_emitted=len(all_mentions)),
            mentions=tuple(all_mentions),
        )

    def _extract_comments(self, video_id: str, max_comments: int) -> list[dict[str, Any]]:
        import yt_dlp  # type: ignore[import-not-found]

        opts: dict[str, Any] = {
            "quiet": True,
            "skip_download": True,
            "getcomments": True,
            "extract_flat": False,
            "extractor_args": {"youtube": {"max_comments": [str(max_comments), "0", "0", "0"]}},
        }
        if self._cookies_path:
            opts["cookiefile"] = self._cookies_path

        with yt_dlp.YoutubeDL(opts) as ydl:
            info = ydl.extract_info(f"https://www.youtube.com/watch?v={video_id}", download=False)
        return list(info.get("comments") or [])[:max_comments]
