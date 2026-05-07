from __future__ import annotations

import asyncio
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any
from uuid import uuid4

from backend.app.schemas import RawEvent, TargetURL
from workers.ingestion.app.conductor import ExtractionContext, RateLimitExceeded, TransientExtractionError
from workers.ingestion.app.plugins.web_extraction import (
    AdvancedWebExtractionPlugin,
    AntiBotDetector,
    AntiBotTier,
    ContextDensityLimiter,
    WebExtractionConfig,
)


class FakeConfig:
    def __init__(self, **kwargs: Any) -> None:
        self.kwargs = kwargs


class FakeCacheMode:
    BYPASS = "BYPASS"


@dataclass(frozen=True)
class FakeMarkdown:
    raw_markdown: str
    fit_markdown: str


@dataclass(frozen=True)
class FakeResult:
    success: bool = True
    markdown: FakeMarkdown | str = ""
    html: str = ""
    cleaned_html: str = ""
    status_code: int = 200
    error_message: str = ""


class FakeCrawler:
    def __init__(self, result: FakeResult) -> None:
        self.result = result
        self.started = False
        self.closed = False
        self.calls: list[tuple[str, Any]] = []
        self.killed_sessions: list[str] = []

    async def start(self) -> None:
        self.started = True

    async def close(self) -> None:
        self.closed = True

    async def arun(self, url: str, config: Any) -> FakeResult:
        self.calls.append((url, config))
        return self.result

    async def kill_session(self, session_id: str) -> None:
        self.killed_sessions.append(session_id)


class FakeComponents:
    AsyncWebCrawler = FakeCrawler
    BrowserConfig = FakeConfig
    CrawlerRunConfig = FakeConfig
    CacheMode = FakeCacheMode
    DefaultMarkdownGenerator = FakeConfig
    PruningContentFilter = FakeConfig


@contextmanager
def raises(expected_error: type[BaseException]) -> Any:
    try:
        yield
    except expected_error:
        return
    raise AssertionError(f"expected {expected_error.__name__} to be raised")


def make_target() -> TargetURL:
    return TargetURL(
        id=uuid4(),
        url="https://example.test/profile",
        submitted_at=datetime.now(UTC),
    )


def test_density_limiter_stops_after_context_is_sufficient() -> None:
    markdown = "\n\n".join(
        [
            "Cookie settings",
            "# Public Profile\n\nAlice coordinates community logistics across regions and publishes regular operational notes.",
            "## Background\n\nThe profile includes education, affiliations, event attendance, and contact history with enough detail for analyst review.",
            "## Overflow\n\n" + "additional context " * 1_000,
        ]
    )
    limiter = ContextDensityLimiter(threshold=0.45, min_chars=160, max_chars=600)

    limited = limiter.limit(markdown)

    assert "Cookie settings" not in limited
    assert "Public Profile" in limited
    assert "Overflow" not in limited


def test_anti_bot_detector_classifies_three_tiers() -> None:
    detector = AntiBotDetector()

    assert detector.classify(FakeResult(status_code=429)).tier is AntiBotTier.SOFT_RATE_LIMIT
    assert detector.classify(FakeResult(html="Checking your browser before access")).tier is AntiBotTier.INTERACTIVE_CHALLENGE
    assert detector.classify(FakeResult(status_code=403, html="Access denied")).tier is AntiBotTier.HARD_BLOCK


def test_plugin_generates_raw_event_with_crawl4ai_runtime_config() -> None:
    async def run() -> None:
        markdown = FakeMarkdown(
            raw_markdown="# Raw\n\nFallback body",
            fit_markdown="# Public Profile\n\nObserved at a community event with enough contextual detail for review.",
        )
        crawler = FakeCrawler(FakeResult(markdown=markdown, html="<main>ok</main>"))
        plugin = AdvancedWebExtractionPlugin(
            WebExtractionConfig(
                min_context_chars=40,
                density_threshold=0.35,
                max_session_uses=2,
                check_robots_txt=True,
            ),
            crawl4ai_components=FakeComponents(),
            crawler_factory=lambda _: crawler,
        )

        event = await plugin.extract(
            make_target(),
            ExtractionContext(proxy="http://proxy-a.local:8080", attempt=1),
        )

        assert isinstance(event, RawEvent)
        assert event.collector_name == "advanced-web"
        assert event.content_type == "text/markdown; variant=gfm"
        assert "Public Profile" in event.raw_markdown_payload
        assert crawler.started is True
        run_config = crawler.calls[0][1]
        assert run_config.kwargs["cache_mode"] == "BYPASS"
        assert run_config.kwargs["flatten_shadow_dom"] is True
        assert run_config.kwargs["remove_consent_popups"] is True
        assert run_config.kwargs["remove_overlay_elements"] is True
        assert run_config.kwargs["proxy_config"] == "http://proxy-a.local:8080"
        assert run_config.kwargs["check_robots_txt"] is True
        await plugin.close()
        assert crawler.closed is True
        assert len(crawler.killed_sessions) == 1

    asyncio.run(run())


def test_plugin_recycles_session_after_configured_use_budget() -> None:
    async def run() -> None:
        markdown = FakeMarkdown(
            raw_markdown="# Raw\n\nFallback body",
            fit_markdown="# Public Profile\n\nObserved at a community event with enough contextual detail for review.",
        )
        crawler = FakeCrawler(FakeResult(markdown=markdown))
        plugin = AdvancedWebExtractionPlugin(
            WebExtractionConfig(min_context_chars=40, density_threshold=0.35, max_session_uses=1),
            crawl4ai_components=FakeComponents(),
            crawler_factory=lambda _: crawler,
        )

        await plugin.extract(make_target(), ExtractionContext(proxy=None, attempt=1))
        await plugin.extract(make_target(), ExtractionContext(proxy=None, attempt=2))

        assert len(crawler.calls) == 2
        assert len(crawler.killed_sessions) == 1
        first_session = crawler.calls[0][1].kwargs["session_id"]
        second_session = crawler.calls[1][1].kwargs["session_id"]
        assert first_session != second_session

    asyncio.run(run())


def test_plugin_escalates_soft_blocks_through_conductor_retry_contract() -> None:
    async def run() -> None:
        crawler = FakeCrawler(FakeResult(success=False, status_code=429, error_message="too many requests"))
        plugin = AdvancedWebExtractionPlugin(
            WebExtractionConfig(),
            crawl4ai_components=FakeComponents(),
            crawler_factory=lambda _: crawler,
        )

        with raises(RateLimitExceeded):
            await plugin.extract(make_target(), ExtractionContext(proxy=None, attempt=1))

    asyncio.run(run())


def test_plugin_recycles_session_on_interactive_challenge() -> None:
    async def run() -> None:
        crawler = FakeCrawler(FakeResult(success=False, html="captcha required"))
        plugin = AdvancedWebExtractionPlugin(
            WebExtractionConfig(),
            crawl4ai_components=FakeComponents(),
            crawler_factory=lambda _: crawler,
        )

        with raises(RateLimitExceeded):
            await plugin.extract(make_target(), ExtractionContext(proxy=None, attempt=1))

        assert len(crawler.killed_sessions) == 1

    asyncio.run(run())


def test_plugin_surfaces_hard_blocks_as_transient_failures() -> None:
    async def run() -> None:
        crawler = FakeCrawler(FakeResult(success=False, status_code=403, html="Access denied"))
        plugin = AdvancedWebExtractionPlugin(
            WebExtractionConfig(),
            crawl4ai_components=FakeComponents(),
            crawler_factory=lambda _: crawler,
        )

        with raises(TransientExtractionError):
            await plugin.extract(make_target(), ExtractionContext(proxy=None, attempt=1))

    asyncio.run(run())
