"""X (Twitter) replay connector — replays JSON fixtures from disk.

We deliberately avoid the paid X API. For demos and CI we replay
pre-collected JSON snapshots that operators have curated locally
(``infrastructure/fixtures/x/*.json``). Each file may contain either:

* a single object with ``{ "tweets": [ ... ] }``, or
* a top-level array of tweet objects.

Each tweet object should have at least:

```
{
    "id": "1234567890",
    "text": "...",
    "author": "@handle",  # optional
    "created_at": "2025-10-04T08:21:00Z",  # optional
    "lang": "en"  # optional
}
```
"""

from __future__ import annotations

import asyncio
import json
import logging
from datetime import UTC, datetime
from pathlib import Path
from typing import Any
from uuid import uuid4

from backend.app.schemas import HealthMention, SourceConfig

from .base import ConnectorContext, ConnectorHealth, ConnectorResult, hash_author

logger = logging.getLogger(__name__)

_MAX_TEXT_LENGTH = 4_000


class XReplayFixtureConnector:
    name = "x_replay_fixture"
    connector_type = "x_fixture"

    def __init__(self, *, fixtures_root: str) -> None:
        self._root = Path(fixtures_root)

    @property
    def available(self) -> bool:
        return self._root.exists()

    async def poll(
        self,
        source: SourceConfig,
        context: ConnectorContext,
    ) -> ConnectorResult:
        if not self.available:
            return ConnectorResult(
                health=ConnectorHealth(success=False, error=f"fixtures_root_missing: {self._root}"),
                mentions=(),
            )

        params = source.connector_params
        relative_glob = str(params.get("glob", "*.json"))
        keywords = tuple(str(k).lower() for k in params.get("keywords", ()))

        try:
            tweets = await asyncio.to_thread(self._load_fixtures, relative_glob)
        except Exception as exc:  # noqa: BLE001
            return ConnectorResult(
                health=ConnectorHealth(success=False, error=str(exc)[:480]),
                mentions=(),
            )

        emitted: list[HealthMention] = []
        for tweet in tweets:
            text = str(tweet.get("text") or "").strip()[:_MAX_TEXT_LENGTH]
            if not text:
                continue
            if keywords and not any(k in text.lower() for k in keywords):
                continue
            tweet_id = str(tweet.get("id") or uuid4())
            author = str(tweet.get("author") or "x-anonymous")
            emitted.append(
                HealthMention(
                    id=uuid4(),
                    project_id=context.project_id,
                    source_config_id=source.id,
                    connector_type="x_fixture",
                    source_uri=f"https://x.com/i/web/status/{tweet_id}",
                    author_hash=hash_author(author),
                    fetched_at=datetime.now(UTC),
                    original_text=text,
                    locale_hint=str(tweet.get("lang")) if tweet.get("lang") else None,
                    extra={
                        "tweet_id": tweet_id,
                        "fixture_origin": str(tweet.get("__origin", "unknown")),
                        "created_at": str(tweet.get("created_at", "")),
                    },
                )
            )

        return ConnectorResult(
            health=ConnectorHealth(success=True, items_emitted=len(emitted)),
            mentions=tuple(emitted),
        )

    def _load_fixtures(self, relative_glob: str) -> list[dict[str, Any]]:
        out: list[dict[str, Any]] = []
        for path in sorted(self._root.glob(relative_glob)):
            try:
                payload = json.loads(path.read_text(encoding="utf-8"))
            except json.JSONDecodeError:
                logger.warning("Skipping invalid JSON fixture: %s", path)
                continue
            tweets = payload.get("tweets") if isinstance(payload, dict) else payload
            if not isinstance(tweets, list):
                continue
            for tweet in tweets:
                if isinstance(tweet, dict):
                    tweet.setdefault("__origin", path.name)
                    out.append(tweet)
        return out
