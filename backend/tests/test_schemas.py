from datetime import UTC, datetime
from uuid import uuid4

import pytest
from pydantic import ValidationError

from backend.app.schemas import Entity, RawEvent, Relationship, TargetURL


def test_entity_accepts_universal_fields() -> None:
    entity = Entity(
        id=uuid4(),
        entity_type="PERSON",
        confidence=0.92,
        source_count=3,
        last_updated=datetime.now(UTC),
    )

    assert entity.entity_type == "PERSON"


def test_entity_rejects_unknown_type() -> None:
    with pytest.raises(ValidationError):
        Entity(
            id=uuid4(),
            entity_type="ASSET",
            confidence=0.7,
            source_count=1,
            last_updated=datetime.now(UTC),
        )


def test_relationship_rejects_domain_terms() -> None:
    with pytest.raises(ValidationError):
        Relationship(
            confidence=0.8,
            valid_from=datetime.now(UTC),
            evidence_text="The post describes a bearish movement.",
        )


def test_timestamps_must_be_timezone_aware() -> None:
    with pytest.raises(ValidationError):
        Relationship(
            confidence=0.8,
            valid_from=datetime(2026, 5, 4, 12, 0, 0),
            evidence_text="Observed at a public event.",
        )


def test_raw_event_accepts_web_collector_payload() -> None:
    event = RawEvent(
        id=uuid4(),
        collector_name="public-web",
        source_uri="https://example.test/profile",
        content_type="Text/Markdown; charset=UTF-8",
        fetch_timestamp=datetime.now(UTC),
        raw_markdown_payload="# Public profile\n\nObserved at a community event.",
    )

    assert event.content_type == "text/markdown; charset=utf-8"


def test_raw_event_rejects_domain_specific_payload() -> None:
    with pytest.raises(ValidationError):
        RawEvent(
            id=uuid4(),
            collector_name="public-web",
            source_uri="https://example.test/profile",
            content_type="text/markdown",
            fetch_timestamp=datetime.now(UTC),
            raw_markdown_payload="This source repeats the word threat.",
        )


def test_target_url_accepts_absolute_http_url() -> None:
    target = TargetURL(
        id=uuid4(),
        url="https://example.test/profile",
        submitted_at=datetime.now(UTC),
        plugin_hint="public-web",
    )

    assert target.url == "https://example.test/profile"


def test_target_url_rejects_relative_url() -> None:
    with pytest.raises(ValidationError):
        TargetURL(
            id=uuid4(),
            url="/relative/path",
            submitted_at=datetime.now(UTC),
        )
