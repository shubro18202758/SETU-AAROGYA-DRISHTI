"""Telegram public-channel connector backed by Telethon.

Telethon talks to Telegram's free MTProto API. Only **public** channels listed
in the source config are read; we never crawl direct messages or private
groups. The session file lives in ``infrastructure/fixtures/`` so an operator
can authenticate once and reuse the session across container restarts.
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


class TelegramConnector:
    name = "telegram_public"
    connector_type = "telegram"

    def __init__(
        self,
        *,
        api_id: int | None,
        api_hash: str | None,
        session_path: str | None,
    ) -> None:
        self._api_id = api_id
        self._api_hash = api_hash
        self._session_path = session_path
        self._client: Any | None = None
        self._client_lock = asyncio.Lock()

    @property
    def available(self) -> bool:
        return bool(self._api_id and self._api_hash and self._session_path)

    async def _get_client(self) -> Any | None:
        if not self.available:
            return None
        async with self._client_lock:
            if self._client is not None:
                return self._client
            try:
                from telethon import TelegramClient  # type: ignore[import-not-found]
            except ImportError:
                logger.warning("telethon not installed; Telegram connector disabled")
                return None
            self._client = TelegramClient(self._session_path, self._api_id, self._api_hash)
            await self._client.connect()
            if not await self._client.is_user_authorized():
                logger.warning("Telegram session at %s is not authorized", self._session_path)
                await self._client.disconnect()
                self._client = None
                return None
            return self._client

    async def poll(
        self,
        source: SourceConfig,
        context: ConnectorContext,
    ) -> ConnectorResult:
        if not self.available:
            return ConnectorResult(
                health=ConnectorHealth(success=False, error="missing_telegram_credentials"),
                mentions=(),
            )

        client = await self._get_client()
        if client is None:
            return ConnectorResult(
                health=ConnectorHealth(success=False, error="telethon_unavailable_or_unauthorized"),
                mentions=(),
            )

        params = source.connector_params
        channels = tuple(params.get("channels", ()))
        limit = int(params.get("limit", 50))
        keywords = tuple(str(k).lower() for k in params.get("keywords", ()))

        emitted: list[HealthMention] = []
        for channel in channels:
            try:
                async for message in client.iter_messages(channel, limit=limit):
                    text = (getattr(message, "text", "") or "").strip()[:_MAX_TEXT_LENGTH]
                    if not text:
                        continue
                    if keywords and not any(k in text.lower() for k in keywords):
                        continue
                    sender = await message.get_sender() if message.sender_id else None
                    sender_name = getattr(sender, "username", None) or getattr(sender, "first_name", None)
                    emitted.append(
                        HealthMention(
                            id=uuid4(),
                            project_id=context.project_id,
                            source_config_id=source.id,
                            connector_type="telegram",
                            source_uri=f"https://t.me/{channel}/{message.id}",
                            author_hash=hash_author(sender_name),
                            fetched_at=datetime.now(UTC),
                            original_text=text,
                            extra={
                                "channel": str(channel),
                                "message_id": int(message.id),
                                "views": int(getattr(message, "views", 0) or 0),
                            },
                        )
                    )
            except Exception as exc:  # noqa: BLE001
                logger.warning("Telegram poll failed for %s: %s", channel, exc)
                continue

        return ConnectorResult(
            health=ConnectorHealth(success=True, items_emitted=len(emitted)),
            mentions=tuple(emitted),
        )
