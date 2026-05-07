"""Canonical topic names for the event bus.

OSINT (legacy) topics keep the ``osint.*`` prefix so the original prototype keeps
working unchanged. SETU AAROGYA DRISHTI uses the ``setu.*`` namespace exclusively
to avoid collisions while sharing the same Redpanda cluster.
"""

from __future__ import annotations

from typing import Final

# --- Legacy OSINT topics (do not rename) -----------------------------------
OSINT_TARGETS_URLS: Final[str] = "osint.targets.urls"
OSINT_RAW_EVENTS: Final[str] = "osint.raw.events"
OSINT_ENRICHED_EVENTS: Final[str] = "osint.enriched.events"
OSINT_GRAPH_WRITE: Final[str] = "osint.graph.write"
OSINT_EVENTS_HIGH_CONFIDENCE: Final[str] = "osint.events.high_confidence"

# --- SETU AAROGYA DRISHTI topics --------------------------------------------
SETU_SOURCES_CONFIG: Final[str] = "setu.sources.config"
SETU_MENTIONS_RAW: Final[str] = "setu.mentions.raw"
SETU_MENTIONS_NORMALIZED: Final[str] = "setu.mentions.normalized"
SETU_MENTIONS_MEDICAL: Final[str] = "setu.mentions.medical"
SETU_SIGNALS_ADR: Final[str] = "setu.signals.adr"
SETU_SIGNALS_TREND: Final[str] = "setu.signals.trend"
SETU_SIGNALS_CLUSTER: Final[str] = "setu.signals.cluster"
SETU_SIGNALS_FIREHOSE: Final[str] = "setu.signals.firehose"
SETU_AUDIT_EVENTS: Final[str] = "setu.audit.events"

__all__ = [
    "OSINT_TARGETS_URLS",
    "OSINT_RAW_EVENTS",
    "OSINT_ENRICHED_EVENTS",
    "OSINT_GRAPH_WRITE",
    "OSINT_EVENTS_HIGH_CONFIDENCE",
    "SETU_SOURCES_CONFIG",
    "SETU_MENTIONS_RAW",
    "SETU_MENTIONS_NORMALIZED",
    "SETU_MENTIONS_MEDICAL",
    "SETU_SIGNALS_ADR",
    "SETU_SIGNALS_TREND",
    "SETU_SIGNALS_CLUSTER",
    "SETU_SIGNALS_FIREHOSE",
    "SETU_AUDIT_EVENTS",
]
