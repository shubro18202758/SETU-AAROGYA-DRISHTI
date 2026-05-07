from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    # --- Legacy OSINT runtime ---------------------------------------------
    redpanda_brokers: str = "localhost:19092"
    arcadedb_url: str = "http://localhost:2480"
    arcadedb_database: str = "osint"
    arcadedb_user: str = "root"
    arcadedb_password: str = "change-me-local-only"
    llm_base_url: str = "http://localhost:8088/v1"
    llm_model: str = "Qwen/Qwen3.5-4B"
    evidence_embedding_dimensions: int = 192
    event_notification_topic: str = "osint.events.high_confidence"

    # --- SETU AAROGYA DRISHTI ---------------------------------------------
    setu_enabled: bool = True
    setu_event_topic: str = "setu.signals.firehose"
    setu_audit_topic: str = "setu.audit.events"
    pii_redaction_enabled: bool = True
    audit_chain_enabled: bool = True
    models_cache_dir: str = "./infrastructure/models"
    fixtures_dir: str = "./infrastructure/fixtures"
    vocab_dir: str = "./infrastructure/vocab"

    # Connector credentials (all optional — connector disables if missing)
    reddit_client_id: str | None = None
    reddit_client_secret: str | None = None
    reddit_user_agent: str = "setu-aarogya-drishti/0.1 (by /u/setu-bot)"
    youtube_cookies_path: str | None = None
    telegram_api_id: int | None = None
    telegram_api_hash: str | None = None
    telegram_session_path: str | None = None

    # Indic NLP toggles (lazy-load to respect 8GB VRAM)
    indic_lang_id_enabled: bool = True
    indic_translate_enabled: bool = True
    indic_translate_model: str = "ai4bharat/indictrans2-indic-en-dist-200M"
    indic_lang_id_model: str = "google/muril-base-cased"


@lru_cache
def get_settings() -> Settings:
    return Settings()
