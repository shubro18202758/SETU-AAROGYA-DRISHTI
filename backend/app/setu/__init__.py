"""SETU AAROGYA DRISHTI backend module — REST API + in-memory store.

The store is intentionally process-local; an ArcadeDB-backed implementation
will replace it without changing the router contract (Phase 8).
"""

from .api import create_setu_router
from .arcade_store import ArcadeDBSetuStore
from .store import InMemorySetuStore, SetuStore

__all__ = [
    "ArcadeDBSetuStore",
    "InMemorySetuStore",
    "SetuStore",
    "create_setu_router",
]
