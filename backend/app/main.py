from contextlib import asynccontextmanager
from collections.abc import AsyncIterator

from fastapi import FastAPI

from .intelligence import (
    ArcadeDBGraphRAGRepository,
    EventNotificationHub,
    IntelligenceService,
    LocalQueryEmbeddingModel,
    WebSocketConnectionManager,
    create_intelligence_router,
    make_event_notification_consumer,
)
from .settings import get_settings
from .setu import InMemorySetuStore, create_setu_router
from .setu.seeds import seed_dev_setu_store
from .storage import ArcadeDBClient


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    hub = app.state.event_notification_hub
    settings = get_settings()
    if app.state.start_event_consumer:
        await hub.start(
            lambda: make_event_notification_consumer(
                bootstrap_servers=settings.redpanda_brokers,
                topic=settings.event_notification_topic,
            )
        )
    if app.state.seed_setu_store:
        await seed_dev_setu_store(app.state.setu_store)
    try:
        yield
    finally:
        await hub.stop()


def create_app(*, start_event_consumer: bool = True, seed_setu_store: bool = False) -> FastAPI:
    settings = get_settings()
    database_client = ArcadeDBClient(
        settings.arcadedb_url,
        settings.arcadedb_database,
        settings.arcadedb_user,
        settings.arcadedb_password,
    )
    intelligence_service = IntelligenceService(
        ArcadeDBGraphRAGRepository(database_client),
        LocalQueryEmbeddingModel(settings.evidence_embedding_dimensions),
    )
    event_hub = EventNotificationHub(WebSocketConnectionManager())
    setu_store = InMemorySetuStore()
    app = FastAPI(title="SETU AAROGYA DRISHTI Intelligence Console", version="0.1.0", lifespan=lifespan)
    app.state.event_notification_hub = event_hub
    app.state.intelligence_service = intelligence_service
    app.state.setu_store = setu_store
    app.state.start_event_consumer = start_event_consumer
    app.state.seed_setu_store = seed_setu_store
    app.include_router(create_intelligence_router(intelligence_service, event_hub))
    app.include_router(create_setu_router(setu_store))

    @app.get("/healthz")
    async def healthz() -> dict[str, str]:
        current_settings = get_settings()
        return {
            "status": "ok",
            "bus": current_settings.redpanda_brokers,
            "database": current_settings.arcadedb_database,
            "llm_model": current_settings.llm_model,
        }

    @app.get("/config")
    async def config() -> dict[str, str]:
        current_settings = get_settings()
        return {
            "redpanda_brokers": current_settings.redpanda_brokers,
            "arcadedb_url": current_settings.arcadedb_url,
            "llm_base_url": current_settings.llm_base_url,
            "llm_model": current_settings.llm_model,
        }

    return app


app = create_app()
