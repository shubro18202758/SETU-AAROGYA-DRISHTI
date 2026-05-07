import asyncio
import os

from backend.app.bus import EventBusConfig

from .conductor import Conductor, ConductorConfig, PluginRegistry, ProxyPool, RateLimitPolicy
from .plugins import AdvancedWebExtractionPlugin, WebExtractionConfig


def _env_bool(name: str, default: bool) -> bool:
    raw = os.getenv(name)
    if raw is None:
        return default
    return raw.strip().lower() not in {"0", "false", "no", "off"}


async def main() -> None:
    brokers = os.getenv("REDPANDA_BROKERS", "localhost:19092")
    registry = PluginRegistry()
    registry.load_entry_points(os.getenv("PLUGIN_ENTRY_POINT_GROUP", "localized_osint.collectors"))
    if _env_bool("ENABLE_DEFAULT_WEB_PLUGIN", True):
        registry.register(
            AdvancedWebExtractionPlugin(
                WebExtractionConfig(
                    page_timeout_ms=int(os.getenv("WEB_EXTRACT_PAGE_TIMEOUT_MS", "60000")),
                    min_context_chars=int(os.getenv("WEB_EXTRACT_MIN_CONTEXT_CHARS", "1600")),
                    max_context_chars=int(os.getenv("WEB_EXTRACT_MAX_CONTEXT_CHARS", "120000")),
                    density_threshold=float(os.getenv("WEB_EXTRACT_DENSITY_THRESHOLD", "0.72")),
                    max_session_uses=int(os.getenv("WEB_EXTRACT_MAX_SESSION_USES", "30")),
                    max_session_age_seconds=float(os.getenv("WEB_EXTRACT_MAX_SESSION_AGE_SECONDS", "900")),
                    crawl4ai_max_retries=int(os.getenv("WEB_EXTRACT_CRAWL4AI_MAX_RETRIES", "2")),
                    check_robots_txt=_env_bool("WEB_EXTRACT_CHECK_ROBOTS_TXT", True),
                    enable_stealth=_env_bool("WEB_EXTRACT_ENABLE_STEALTH", False),
                    simulate_user=_env_bool("WEB_EXTRACT_SIMULATE_USER", False),
                    override_navigator=_env_bool("WEB_EXTRACT_OVERRIDE_NAVIGATOR", False),
                )
            )
        )

    proxies = tuple(
        proxy.strip()
        for proxy in os.getenv("COLLECTOR_PROXIES", "").split(",")
        if proxy.strip()
    )

    conductor = Conductor(
        ConductorConfig(
            target_topic=os.getenv("TARGET_TOPIC", "osint.targets.urls"),
            raw_event_topic=os.getenv("RAW_TOPIC", "osint.raw.events"),
            group_id=os.getenv("CONDUCTOR_GROUP_ID", "osint-conductor"),
            max_concurrency=int(os.getenv("CONDUCTOR_MAX_CONCURRENCY", "32")),
            memory_pause_threshold=float(os.getenv("CONDUCTOR_MEMORY_PAUSE_THRESHOLD", "0.80")),
            memory_resume_threshold=float(os.getenv("CONDUCTOR_MEMORY_RESUME_THRESHOLD", "0.74")),
        ),
        registry,
        event_bus_config=EventBusConfig(bootstrap_servers=brokers, client_id="osint-conductor"),
        proxy_pool=ProxyPool(proxies),
        rate_limit_policy=RateLimitPolicy(
            max_attempts=int(os.getenv("CONDUCTOR_MAX_ATTEMPTS", "5")),
            initial_delay_seconds=float(os.getenv("CONDUCTOR_INITIAL_BACKOFF_SECONDS", "0.25")),
            max_delay_seconds=float(os.getenv("CONDUCTOR_MAX_BACKOFF_SECONDS", "30.0")),
            jitter_ratio=float(os.getenv("CONDUCTOR_JITTER_RATIO", "0.20")),
            per_plugin_interval_seconds=float(os.getenv("CONDUCTOR_PLUGIN_INTERVAL_SECONDS", "0.0")),
        ),
    )
    await conductor.run()


if __name__ == "__main__":
    asyncio.run(main())
