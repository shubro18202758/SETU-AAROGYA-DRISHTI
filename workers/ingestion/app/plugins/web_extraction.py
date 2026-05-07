from __future__ import annotations

import inspect
import re
from dataclasses import dataclass
from datetime import UTC, datetime
from enum import IntEnum
from importlib import import_module
from time import monotonic
from typing import Any, Protocol, cast
from urllib.parse import urlparse
from uuid import uuid4

from backend.app.schemas import RawEvent, TargetURL

from ..conductor import ExtractionContext, RateLimitExceeded, TransientExtractionError

CONSENT_AND_SHADOW_DOM_JS = r"""
(() => {
  const consentText = /\b(accept all|agree|i accept|allow all|reject all|manage choices|cookie settings|consent|gdpr|privacy preferences)\b/i;
  const candidates = Array.from(document.querySelectorAll('button, [role="button"], a, input[type="button"], input[type="submit"]'));
  for (const element of candidates.slice(0, 120)) {
    const label = `${element.innerText || element.value || element.getAttribute('aria-label') || ''}`.trim();
    if (label && consentText.test(label)) {
      try { element.click(); } catch (_) {}
    }
  }

  const overlayText = /\b(cookie|consent|privacy preferences|gdpr|subscribe to|sign up for|newsletter)\b/i;
  const blockers = Array.from(document.querySelectorAll('dialog, [role="dialog"], [aria-modal="true"], div, section, aside'));
  for (const element of blockers.slice(0, 400)) {
    const style = window.getComputedStyle(element);
    const fixed = style.position === 'fixed' || style.position === 'sticky';
    const large = element.getBoundingClientRect().height > window.innerHeight * 0.18;
    const text = (element.innerText || '').slice(0, 500);
    if ((fixed || large) && overlayText.test(text)) {
      element.setAttribute('data-osint-removed-overlay', 'true');
      element.remove();
    }
  }

  const visited = new WeakSet();
  const flatten = (root) => {
    if (!root || visited.has(root)) return;
    visited.add(root);
    const elements = root.querySelectorAll ? Array.from(root.querySelectorAll('*')) : [];
    for (const element of elements) {
      if (element.shadowRoot && !element.hasAttribute('data-osint-shadow-flattened')) {
        const flattened = document.createElement('section');
        flattened.setAttribute('data-osint-shadow-host', element.tagName.toLowerCase());
        flattened.innerHTML = element.shadowRoot.innerHTML;
        element.appendChild(flattened);
        element.setAttribute('data-osint-shadow-flattened', 'true');
        flatten(flattened);
      }
    }
  };
  flatten(document);
})();
"""

TOKEN_PATTERN = re.compile(r"[A-Za-z0-9][A-Za-z0-9_'-]{2,}")
HTML_TAG_PATTERN = re.compile(r"<[^>]+>")
BOILERPLATE_PATTERN = re.compile(
    r"\b(cookie|consent|privacy policy|terms of service|subscribe|newsletter|sign in|"
    r"advertisement|all rights reserved|enable javascript|share this|follow us)\b",
    re.IGNORECASE,
)
STOPWORDS = frozenset(
    {
        "about",
        "after",
        "also",
        "and",
        "are",
        "but",
        "can",
        "for",
        "from",
        "has",
        "have",
        "into",
        "not",
        "that",
        "the",
        "their",
        "this",
        "was",
        "were",
        "with",
        "you",
        "your",
    }
)


class Crawl4AIComponents(Protocol):
    AsyncWebCrawler: Any
    BrowserConfig: Any
    CrawlerRunConfig: Any
    CacheMode: Any
    DefaultMarkdownGenerator: Any
    PruningContentFilter: Any


class CrawlRuntime(Protocol):
    async def start(self) -> None:
        ...

    async def close(self) -> None:
        ...

    async def arun(self, url: str, config: Any) -> Any:
        ...


class AntiBotTier(IntEnum):
    NONE = 0
    SOFT_RATE_LIMIT = 1
    INTERACTIVE_CHALLENGE = 2
    HARD_BLOCK = 3


@dataclass(frozen=True, slots=True)
class AntiBotSignal:
    tier: AntiBotTier
    reason: str = ""
    retry_after_seconds: float | None = None


@dataclass(frozen=True, slots=True)
class WebExtractionConfig:
    name: str = "advanced-web"
    page_timeout_ms: int = 60_000
    word_count_threshold: int = 8
    pruning_threshold: float = 0.42
    min_context_chars: int = 1_600
    max_context_chars: int = 120_000
    density_threshold: float = 0.72
    max_session_uses: int = 30
    max_session_age_seconds: float = 900.0
    crawl4ai_max_retries: int = 2
    delay_before_return_html: float = 0.25
    scan_full_page: bool = True
    max_scroll_steps: int = 8
    scroll_delay: float = 0.15
    check_robots_txt: bool = True
    user_agent_mode: str = "random"
    enable_stealth: bool = False
    simulate_user: bool = False
    override_navigator: bool = False


@dataclass(slots=True)
class _SessionState:
    session_id: str
    created_at: float
    uses: int = 0


async def _maybe_await(value: Any) -> Any:
    if inspect.isawaitable(value):
        return await value
    return value


def load_crawl4ai_components() -> Crawl4AIComponents:
    crawl4ai = import_module("crawl4ai")
    markdown = import_module("crawl4ai.markdown_generation_strategy")
    filters = import_module("crawl4ai.content_filter_strategy")

    @dataclass(frozen=True, slots=True)
    class Components:
        AsyncWebCrawler: Any = crawl4ai.AsyncWebCrawler
        BrowserConfig: Any = crawl4ai.BrowserConfig
        CrawlerRunConfig: Any = crawl4ai.CrawlerRunConfig
        CacheMode: Any = crawl4ai.CacheMode
        DefaultMarkdownGenerator: Any = markdown.DefaultMarkdownGenerator
        PruningContentFilter: Any = filters.PruningContentFilter

    return cast(Crawl4AIComponents, Components())


class SessionRecycler:
    def __init__(self, *, max_uses: int, max_age_seconds: float) -> None:
        self.max_uses = max_uses
        self.max_age_seconds = max_age_seconds
        self._state: _SessionState | None = None

    async def next_session_id(self, crawler: CrawlRuntime) -> str:
        now = monotonic()
        if self._state is None:
            self._state = self._new_state(now)
        elif self._state.uses >= self.max_uses or now - self._state.created_at >= self.max_age_seconds:
            await self.recycle(crawler)

        assert self._state is not None
        self._state.uses += 1
        return self._state.session_id

    async def recycle(self, crawler: CrawlRuntime) -> None:
        if self._state is not None:
            await self._kill_session(crawler, self._state.session_id)
        self._state = self._new_state(monotonic())

    async def close(self, crawler: CrawlRuntime) -> None:
        if self._state is not None:
            await self._kill_session(crawler, self._state.session_id)
        self._state = None

    def _new_state(self, now: float) -> _SessionState:
        return _SessionState(session_id=f"advanced-web-{uuid4()}", created_at=now)

    async def _kill_session(self, crawler: CrawlRuntime, session_id: str) -> None:
        kill_session = getattr(crawler, "kill_session", None)
        if callable(kill_session):
            await _maybe_await(kill_session(session_id))


class ContextDensityLimiter:
    def __init__(self, *, threshold: float, min_chars: int, max_chars: int) -> None:
        self.threshold = threshold
        self.min_chars = min_chars
        self.max_chars = max_chars

    def limit(self, markdown: str) -> str:
        cleaned = normalize_gfm(markdown)
        blocks = [block.strip() for block in re.split(r"\n{2,}", cleaned) if block.strip()]
        selected: list[str] = []

        for block in blocks:
            if self._is_low_value_block(block):
                continue
            candidate = "\n\n".join((*selected, block))
            if len(candidate) > self.max_chars:
                break
            selected.append(block)
            if len(candidate) >= self.min_chars and self.contextual_density(candidate) >= self.threshold:
                break

        if not selected and cleaned:
            return cleaned[: self.max_chars].strip()
        return "\n\n".join(selected).strip()

    def contextual_density(self, markdown: str) -> float:
        tokens = [token.lower() for token in TOKEN_PATTERN.findall(markdown)]
        if not tokens:
            return 0.0
        meaningful = [token for token in tokens if token not in STOPWORDS]
        lexical_signal = len(meaningful) / len(tokens)
        unique_signal = min(len(set(meaningful)) / 160.0, 1.0)
        structure_signal = min((markdown.count("\n#") + markdown.count("\n- ") + markdown.count("|")) / 24.0, 1.0)
        return min((lexical_signal * 0.60) + (unique_signal * 0.30) + (structure_signal * 0.10), 1.0)

    def _is_low_value_block(self, block: str) -> bool:
        tokens = TOKEN_PATTERN.findall(block)
        return len(tokens) < 8 and BOILERPLATE_PATTERN.search(block) is not None


class AntiBotDetector:
    soft_patterns = (
        re.compile(r"\btoo many requests\b", re.IGNORECASE),
        re.compile(r"\brate limit(?:ed)?\b", re.IGNORECASE),
        re.compile(r"\btemporarily unavailable\b", re.IGNORECASE),
    )
    challenge_patterns = (
        re.compile(r"\bcaptcha\b", re.IGNORECASE),
        re.compile(r"\bhcaptcha\b", re.IGNORECASE),
        re.compile(r"\brecaptcha\b", re.IGNORECASE),
        re.compile(r"\bchecking your browser\b", re.IGNORECASE),
        re.compile(r"\bjust a moment\b", re.IGNORECASE),
        re.compile(r"cf-chl|cloudflare", re.IGNORECASE),
    )
    hard_patterns = (
        re.compile(r"\baccess denied\b", re.IGNORECASE),
        re.compile(r"\bforbidden\b", re.IGNORECASE),
        re.compile(r"\bautomated access\b", re.IGNORECASE),
        re.compile(r"\bblocked by\b", re.IGNORECASE),
    )

    def classify(self, result: Any) -> AntiBotSignal:
        status_code = int(getattr(result, "status_code", 0) or getattr(result, "status", 0) or 0)
        haystack = "\n".join(
            str(part or "")
            for part in (
                getattr(result, "error_message", ""),
                getattr(result, "html", "")[:60_000],
                getattr(result, "cleaned_html", "")[:60_000],
                _extract_markdown(result)[:60_000],
            )
        )
        if status_code in {401, 403} or any(pattern.search(haystack) for pattern in self.hard_patterns):
            return AntiBotSignal(AntiBotTier.HARD_BLOCK, "hard anti-bot block", retry_after_seconds=30.0)
        if status_code in {429, 503} or any(pattern.search(haystack) for pattern in self.soft_patterns):
            return AntiBotSignal(AntiBotTier.SOFT_RATE_LIMIT, "soft rate limit", retry_after_seconds=5.0)
        if any(pattern.search(haystack) for pattern in self.challenge_patterns):
            return AntiBotSignal(AntiBotTier.INTERACTIVE_CHALLENGE, "interactive challenge", retry_after_seconds=15.0)
        return AntiBotSignal(AntiBotTier.NONE)


class AdvancedWebExtractionPlugin:
    def __init__(
        self,
        config: WebExtractionConfig | None = None,
        *,
        crawl4ai_components: Crawl4AIComponents | None = None,
        crawler_factory: Any | None = None,
    ) -> None:
        self.config = config or WebExtractionConfig()
        self.name = self.config.name
        self._components = crawl4ai_components
        self._crawler_factory = crawler_factory
        self._crawler: CrawlRuntime | None = None
        self._session_recycler = SessionRecycler(
            max_uses=self.config.max_session_uses,
            max_age_seconds=self.config.max_session_age_seconds,
        )
        self._density_limiter = ContextDensityLimiter(
            threshold=self.config.density_threshold,
            min_chars=self.config.min_context_chars,
            max_chars=self.config.max_context_chars,
        )
        self._anti_bot_detector = AntiBotDetector()

    def can_handle(self, target: TargetURL) -> bool:
        parsed = urlparse(target.url)
        return parsed.scheme in {"http", "https"} and bool(parsed.netloc)

    async def extract(self, target: TargetURL, context: ExtractionContext) -> RawEvent:
        crawler = await self._ensure_crawler()
        session_id = await self._session_recycler.next_session_id(crawler)
        result = await crawler.arun(target.url, config=self._build_run_config(session_id, context.proxy))
        signal = self._anti_bot_detector.classify(result)
        if signal.tier is not AntiBotTier.NONE:
            if signal.tier >= AntiBotTier.INTERACTIVE_CHALLENGE:
                await self._session_recycler.recycle(crawler)
            self._raise_for_anti_bot_signal(signal)

        if not bool(getattr(result, "success", False)):
            raise TransientExtractionError(str(getattr(result, "error_message", "crawl failed")))

        markdown = self._density_limiter.limit(_extract_markdown(result))
        if not markdown:
            raise TransientExtractionError("crawl produced no markdown content")

        return RawEvent(
            id=uuid4(),
            collector_name=self.name,
            source_uri=target.url,
            content_type="text/markdown; variant=gfm",
            fetch_timestamp=datetime.now(UTC),
            raw_markdown_payload=markdown,
        )

    async def close(self) -> None:
        if self._crawler is None:
            return
        await self._session_recycler.close(self._crawler)
        await self._crawler.close()
        self._crawler = None

    async def _ensure_crawler(self) -> CrawlRuntime:
        if self._crawler is not None:
            return self._crawler
        components = self._get_components()
        browser_config = components.BrowserConfig(
            browser_type="chromium",
            headless=True,
            text_mode=True,
            light_mode=True,
            avoid_ads=True,
            java_script_enabled=True,
            user_agent_mode=self.config.user_agent_mode,
            enable_stealth=self.config.enable_stealth,
            verbose=False,
        )
        crawler = (
            self._crawler_factory(browser_config)
            if self._crawler_factory is not None
            else components.AsyncWebCrawler(config=browser_config)
        )
        self._crawler = await _maybe_await(crawler)
        await self._crawler.start()
        return self._crawler

    def _get_components(self) -> Crawl4AIComponents:
        if self._components is None:
            self._components = load_crawl4ai_components()
        return self._components

    def _build_run_config(self, session_id: str, proxy: str | None) -> Any:
        components = self._get_components()
        content_filter = components.PruningContentFilter(
            threshold=self.config.pruning_threshold,
            threshold_type="fixed",
        )
        markdown_generator = components.DefaultMarkdownGenerator(
            content_filter=content_filter,
            options={"ignore_links": False, "body_width": 0},
        )
        return components.CrawlerRunConfig(
            cache_mode=components.CacheMode.BYPASS,
            markdown_generator=markdown_generator,
            session_id=session_id,
            page_timeout=self.config.page_timeout_ms,
            wait_until="networkidle",
            delay_before_return_html=self.config.delay_before_return_html,
            word_count_threshold=self.config.word_count_threshold,
            excluded_tags=["script", "style", "noscript"],
            remove_overlay_elements=True,
            remove_consent_popups=True,
            flatten_shadow_dom=True,
            js_code=[CONSENT_AND_SHADOW_DOM_JS],
            scan_full_page=self.config.scan_full_page,
            max_scroll_steps=self.config.max_scroll_steps,
            scroll_delay=self.config.scroll_delay,
            check_robots_txt=self.config.check_robots_txt,
            proxy_config=proxy,
            max_retries=self.config.crawl4ai_max_retries,
            simulate_user=self.config.simulate_user,
            override_navigator=self.config.override_navigator,
            magic=True,
            verbose=False,
        )

    def _raise_for_anti_bot_signal(self, signal: AntiBotSignal) -> None:
        message = f"{signal.reason}; retrying via Conductor proxy escalation"
        if signal.tier is AntiBotTier.HARD_BLOCK:
            raise TransientExtractionError(message)
        raise RateLimitExceeded(message, retry_after_seconds=signal.retry_after_seconds)


def normalize_gfm(markdown: str) -> str:
    markdown = re.sub(r"<!--.*?-->", "", markdown, flags=re.DOTALL)
    markdown = HTML_TAG_PATTERN.sub("", markdown)
    markdown = re.sub(r"[ \t]+\n", "\n", markdown)
    markdown = re.sub(r"\n{3,}", "\n\n", markdown)
    return markdown.strip()


def _extract_markdown(result: Any) -> str:
    markdown = getattr(result, "markdown", "")
    if isinstance(markdown, str):
        return markdown
    for attr in ("fit_markdown", "raw_markdown"):
        value = getattr(markdown, attr, None)
        if value:
            return str(value)
    return ""
