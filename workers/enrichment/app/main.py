import asyncio
import os

from backend.app.bus import EventBusConfig

from .brain import BrainConfig, BrainRunner


async def main() -> None:
    brokers = os.getenv("REDPANDA_BROKERS", "localhost:19092")
    raw_topic = os.getenv("RAW_TOPIC", "osint.raw.events")
    runner = BrainRunner(
        BrainConfig(
            raw_topic=raw_topic,
            group_id=os.getenv("BRAIN_GROUP_ID", "osint-brain"),
            max_extraction_retries=int(os.getenv("BRAIN_MAX_EXTRACTION_RETRIES", "2")),
            llm_base_url=os.getenv("LLM_BASE_URL", "http://localhost:8088/v1"),
            llm_model=os.getenv("LLM_MODEL", "Qwen/Qwen3.5-4B"),
            extraction_temperature=float(os.getenv("BRAIN_EXTRACTION_TEMPERATURE", "0.1")),
            llm_timeout_seconds=float(os.getenv("BRAIN_LLM_TIMEOUT_SECONDS", "30")),
            llm_max_tokens=int(os.getenv("BRAIN_LLM_MAX_TOKENS", "2048")),
        ),
        event_bus_config=EventBusConfig(bootstrap_servers=brokers, client_id="osint-brain"),
    )
    await runner.run()


if __name__ == "__main__":
    asyncio.run(main())
