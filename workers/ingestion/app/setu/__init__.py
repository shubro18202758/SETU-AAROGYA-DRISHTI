"""SETU AAROGYA DRISHTI ingestion connectors.

These are *pollers* (subscribe to a source, periodically harvest new items),
distinct from OSINT URL-target collector plugins. Each connector exposes a
single async generator that yields :class:`HealthMention` objects.
"""

from .base import (
    ConnectorContext,
    ConnectorHealth,
    ConnectorResult,
    SetuConnector,
    hash_author,
)
from .registry import build_registry, default_connectors

__all__ = [
    "ConnectorContext",
    "ConnectorHealth",
    "ConnectorResult",
    "SetuConnector",
    "build_registry",
    "default_connectors",
    "hash_author",
]
