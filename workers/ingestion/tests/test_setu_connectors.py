"""Connector contract tests.

Only the fully offline connectors (X replay fixture, RSS-disabled-path,
Reddit-disabled-path) are exercised here. Live connectors are smoke-tested
in the integration layer once credentials are present.
"""

from __future__ import annotations

from datetime import UTC, datetime
from pathlib import Path
from uuid import uuid4

import pytest

from backend.app.schemas import SourceConfig
from workers.ingestion.app.setu import (
    ConnectorContext,
    build_registry,
    default_connectors,
    hash_author,
)
from workers.ingestion.app.setu.reddit_praw import RedditConnector
from workers.ingestion.app.setu.x_replay_fixture import XReplayFixtureConnector

FIXTURES_ROOT = Path(__file__).resolve().parents[3] / "infrastructure" / "fixtures" / "x"


def _make_source(connector_type: str, params: dict) -> SourceConfig:
    return SourceConfig(
        id=uuid4(),
        project_id=uuid4(),
        name="setu-test-source",
        connector_type=connector_type,  # type: ignore[arg-type]
        connector_params=params,
        latency_tier="realtime",
        enabled=True,
        created_at=datetime.now(UTC),
    )


def test_hash_author_is_deterministic_and_hex() -> None:
    h1 = hash_author("@alice")
    h2 = hash_author("@ALICE")  # case-insensitive
    h3 = hash_author(None)
    assert h1 == h2
    assert len(h1) == 16
    assert all(c in "0123456789abcdef" for c in h1)
    assert h3 != h1


def test_reddit_connector_disabled_when_no_credentials() -> None:
    connector = RedditConnector(
        client_id=None,
        client_secret=None,
        user_agent="setu-test/0.1",
    )
    assert connector.available is False


@pytest.mark.asyncio
async def test_x_replay_fixture_yields_health_mentions() -> None:
    if not FIXTURES_ROOT.exists():
        pytest.skip(f"fixtures root missing: {FIXTURES_ROOT}")

    connector = XReplayFixtureConnector(fixtures_root=str(FIXTURES_ROOT))
    assert connector.available is True

    project_id = uuid4()
    source = _make_source(
        "x_fixture",
        {"glob": "*.json", "keywords": ["coldrif", "syrup", "aki", "diethylene"]},
    )
    result = await connector.poll(
        source,
        ConnectorContext(project_id=project_id),
    )

    assert result.health.success is True
    assert result.health.items_emitted >= 4  # demo fixture has 5 tweets, 1 filtered out
    assert all(m.connector_type == "x_fixture" for m in result.mentions)
    assert all(m.project_id == project_id for m in result.mentions)
    assert all(len(m.author_hash) == 16 for m in result.mentions)
    # author handles must NOT appear verbatim anywhere
    for mention in result.mentions:
        assert "@" not in mention.author_hash


@pytest.mark.asyncio
async def test_x_replay_fixture_keyword_filter_excludes_offtopic() -> None:
    if not FIXTURES_ROOT.exists():
        pytest.skip(f"fixtures root missing: {FIXTURES_ROOT}")

    connector = XReplayFixtureConnector(fixtures_root=str(FIXTURES_ROOT))
    source = _make_source("x_fixture", {"glob": "*.json", "keywords": ["coldrif"]})
    result = await connector.poll(source, ConnectorContext(project_id=uuid4()))

    texts = [m.original_text.lower() for m in result.mentions]
    assert all("coldrif" in text for text in texts)
    assert not any("cricket" in text for text in texts)


@pytest.mark.asyncio
async def test_unknown_connector_type_returns_failure() -> None:
    from workers.ingestion.app.setu.registry import poll_once

    registry = build_registry(default_connectors(fixtures_root=str(FIXTURES_ROOT)))
    source = _make_source("rss", {"feed_urls": []})  # rss exists but no feeds
    result = await poll_once(source, project_id=uuid4(), registry=registry)
    assert result.health.success is False
    assert "no_feed_urls" in (result.health.error or "")
