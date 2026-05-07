"""BLAKE3 audit chain for SETU signals + triage decisions.

Every appended entry binds to the previous entry's hash via
``new_hash = blake3(prev_hash || canonical_json(payload))``. The chain head
is exposed for downstream signals so triage decisions can cite the proof.

If the optional :mod:`blake3` extension is unavailable at runtime the chain
falls back to ``hashlib.blake2b`` so unit tests still pass — the topology
(prev → next) is identical, only the underlying hash function changes.
"""

from __future__ import annotations

import hashlib
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Mapping
from uuid import UUID, uuid4

import orjson

from backend.app.schemas.health import AuditEntry

try:  # pragma: no cover - exercised only when blake3 is installed.
    from blake3 import blake3 as _blake3  # type: ignore[import-not-found]

    def _hash(data: bytes) -> str:
        return _blake3(data).hexdigest()

    HASH_NAME = "blake3"
except ImportError:  # pragma: no cover - default in CI
    def _hash(data: bytes) -> str:
        return hashlib.blake2b(data, digest_size=32).hexdigest()

    HASH_NAME = "blake2b"


GENESIS_HASH: str = "0" * 64


def canonical_json(payload: Mapping[str, Any]) -> bytes:
    return orjson.dumps(payload, option=orjson.OPT_SORT_KEYS)


def chain_hash(prev_hash: str, payload: Mapping[str, Any]) -> str:
    digest_input = prev_hash.encode("ascii") + b"|" + canonical_json(payload)
    return _hash(digest_input)


@dataclass(slots=True)
class AuditChain:
    """In-memory append-only chain. Production deployments persist to ArcadeDB."""

    entries: list[AuditEntry] = field(default_factory=list)

    @property
    def head(self) -> str:
        return self.entries[-1].payload_hash if self.entries else GENESIS_HASH

    @property
    def length(self) -> int:
        return len(self.entries)

    def append(
        self,
        *,
        actor: str,
        action: str,
        payload: Mapping[str, Any],
        signal_id: UUID | None = None,
        mention_id: UUID | None = None,
        summary: str | None = None,
        recorded_at: datetime | None = None,
    ) -> AuditEntry:
        prev_hash = self.head
        new_hash = chain_hash(prev_hash, payload)
        entry = AuditEntry(
            id=uuid4(),
            sequence=len(self.entries),
            prev_hash=prev_hash,
            payload_hash=new_hash,
            actor=actor,
            action=action,
            signal_id=signal_id,
            mention_id=mention_id,
            payload_summary=(summary or action)[:512],
            recorded_at=recorded_at or datetime.now(tz=timezone.utc),
        )
        self.entries.append(entry)
        return entry

    def verify(self) -> bool:
        prev_hash = GENESIS_HASH
        for index, entry in enumerate(self.entries):
            if entry.sequence != index:
                return False
            if entry.prev_hash != prev_hash:
                return False
            prev_hash = entry.payload_hash
        return True


__all__ = [
    "AuditChain",
    "GENESIS_HASH",
    "HASH_NAME",
    "canonical_json",
    "chain_hash",
]
