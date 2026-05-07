"""Tests for the BLAKE3 / blake2b audit chain."""

from __future__ import annotations

from datetime import datetime, timezone
from uuid import uuid4

from workers.signals.app.audit import GENESIS_HASH, AuditChain, chain_hash


def test_empty_chain_verifies():
    chain = AuditChain()
    assert chain.length == 0
    assert chain.head == GENESIS_HASH
    assert chain.verify() is True


def test_append_links_prev_hash():
    chain = AuditChain()
    e1 = chain.append(actor="setu", action="emit-adr", payload={"v": 1})
    e2 = chain.append(actor="setu", action="emit-adr", payload={"v": 2})
    assert e1.prev_hash == GENESIS_HASH
    assert e2.prev_hash == e1.payload_hash
    assert chain.head == e2.payload_hash
    assert chain.verify() is True


def test_chain_hash_deterministic():
    payload = {"signal_id": "abc", "score": 0.9}
    h1 = chain_hash(GENESIS_HASH, payload)
    h2 = chain_hash(GENESIS_HASH, payload)
    assert h1 == h2
    assert len(h1) == 64


def test_tampering_detected():
    chain = AuditChain()
    chain.append(actor="setu", action="a", payload={"v": 1})
    chain.append(actor="setu", action="b", payload={"v": 2})
    # Mutate sequence on the second entry to simulate reordering.
    bad = chain.entries[1].model_copy(update={"sequence": 5})
    chain.entries[1] = bad
    assert chain.verify() is False


def test_signal_id_propagates():
    chain = AuditChain()
    sid = uuid4()
    entry = chain.append(actor="setu", action="emit-adr", payload={"x": 1}, signal_id=sid)
    assert entry.signal_id == sid
    assert entry.recorded_at.tzinfo is not None
    # round-trip serialisation works.
    assert entry.recorded_at <= datetime.now(tz=timezone.utc)
