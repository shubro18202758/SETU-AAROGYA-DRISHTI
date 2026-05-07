from __future__ import annotations

import re
from collections.abc import Iterable, Mapping
from datetime import datetime, timezone
from typing import Annotated, Any, Final, Literal, Self
from urllib.parse import urlparse
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

EntityType = Literal["ORG", "PERSON", "GEO", "EVENT"]

Confidence = Annotated[float, Field(strict=True, ge=0.0, le=1.0)]
SourceCount = Annotated[int, Field(strict=True, ge=0)]
EvidenceText = Annotated[str, Field(strict=True, min_length=1, max_length=8192)]
ContentType = Annotated[
    str,
    Field(
        strict=True,
        min_length=3,
        max_length=255,
        pattern=r"^[a-z0-9][a-z0-9!#$&^_.+-]*/[a-z0-9][a-z0-9!#$&^_.+-]*(;.*)?$",
    ),
]
SourceUri = Annotated[str, Field(strict=True, min_length=1, max_length=4096)]
CollectorName = Annotated[str, Field(strict=True, min_length=1, max_length=128)]
RawMarkdownPayload = Annotated[str, Field(strict=True, min_length=1, max_length=4_000_000)]
TargetUrlValue = Annotated[str, Field(strict=True, min_length=8, max_length=4096)]
PluginName = Annotated[str, Field(strict=True, min_length=1, max_length=128, pattern=r"^[a-zA-Z0-9_.:-]+$")]
CanonicalName = Annotated[str, Field(strict=True, min_length=1, max_length=512)]

FORBIDDEN_DOMAIN_TERMS: Final[frozenset[str]] = frozenset(
    {
        "attack",
        "bearish",
        "bullish",
        "campaign",
        "exploit",
        "ioc",
        "malware",
        "risk",
        "sentiment",
        "target",
        "threat",
        "threats",
        "vulnerability",
    }
)
FORBIDDEN_DOMAIN_TERM_PATTERN: Final[re.Pattern[str]] = re.compile(
    r"\b(" + "|".join(sorted(map(re.escape, FORBIDDEN_DOMAIN_TERMS), key=len, reverse=True)) + r")\b",
    re.IGNORECASE,
)


def _iter_strings(value: Any) -> Iterable[str]:
    if isinstance(value, str):
        yield value
        return

    if isinstance(value, Mapping):
        for key, nested_value in value.items():
            yield from _iter_strings(key)
            yield from _iter_strings(nested_value)
        return

    if isinstance(value, BaseModel):
        yield from _iter_strings(value.model_dump(mode="python"))
        return

    if isinstance(value, Iterable):
        for nested_value in value:
            yield from _iter_strings(nested_value)


def _reject_domain_terms(value: str) -> None:
    match = FORBIDDEN_DOMAIN_TERM_PATTERN.search(value)
    if match is not None:
        raise ValueError(f"domain-specific terminology is not allowed: {match.group(0)!r}")


def _require_aware_utc_timestamp(value: datetime) -> datetime:
    if value.tzinfo is None or value.utcoffset() is None:
        raise ValueError("timestamp must be timezone-aware")
    return value.astimezone(timezone.utc)


class UniversalSchema(BaseModel):
    model_config = ConfigDict(
        extra="forbid",
        frozen=True,
        strict=True,
        str_strip_whitespace=True,
        validate_default=True,
    )

    @model_validator(mode="after")
    def reject_domain_specific_values(self) -> Self:
        for value in _iter_strings(self.model_dump(mode="python")):
            _reject_domain_terms(value)
        return self


class Entity(UniversalSchema):
    id: UUID = Field(description="Globally unique identifier.")
    entity_type: EntityType
    confidence: Confidence
    source_count: SourceCount
    last_updated: datetime

    @field_validator("last_updated")
    @classmethod
    def validate_last_updated(cls, value: datetime) -> datetime:
        return _require_aware_utc_timestamp(value)


class Relationship(UniversalSchema):
    confidence: Confidence
    valid_from: datetime
    evidence_text: EvidenceText

    @field_validator("valid_from")
    @classmethod
    def validate_valid_from(cls, value: datetime) -> datetime:
        return _require_aware_utc_timestamp(value)


class GraphEntityUpsert(UniversalSchema):
    entity: Entity
    canonical_name: CanonicalName


class GraphRelationshipUpsert(UniversalSchema):
    source_entity_id: UUID
    destination_entity_id: UUID
    relationship: Relationship


class GraphWriteBatch(UniversalSchema):
    id: UUID = Field(description="Globally unique graph write batch identifier.")
    created_at: datetime
    entities: tuple[GraphEntityUpsert, ...] = Field(default_factory=tuple)
    relationships: tuple[GraphRelationshipUpsert, ...] = Field(default_factory=tuple)

    @field_validator("created_at")
    @classmethod
    def validate_created_at(cls, value: datetime) -> datetime:
        return _require_aware_utc_timestamp(value)


class EventEntityNotification(UniversalSchema):
    id: UUID = Field(description="Globally unique event notification identifier.")
    entity: Entity
    canonical_name: CanonicalName
    persisted_at: datetime
    source_batch_id: UUID

    @field_validator("persisted_at")
    @classmethod
    def validate_persisted_at(cls, value: datetime) -> datetime:
        return _require_aware_utc_timestamp(value)


class RawEvent(UniversalSchema):
    id: UUID = Field(description="Globally unique raw event identifier.")
    collector_name: CollectorName
    source_uri: SourceUri
    content_type: ContentType
    fetch_timestamp: datetime
    raw_markdown_payload: RawMarkdownPayload

    @field_validator("content_type", mode="before")
    @classmethod
    def normalize_content_type(cls, value: Any) -> Any:
        if isinstance(value, str):
            return value.strip().lower()
        return value

    @field_validator("fetch_timestamp")
    @classmethod
    def validate_fetch_timestamp(cls, value: datetime) -> datetime:
        return _require_aware_utc_timestamp(value)


class TargetURL(UniversalSchema):
    id: UUID = Field(description="Globally unique target URL identifier.")
    url: TargetUrlValue
    submitted_at: datetime
    plugin_hint: PluginName | None = None

    @field_validator("url")
    @classmethod
    def validate_url(cls, value: str) -> str:
        parsed = urlparse(value)
        if parsed.scheme not in {"http", "https"} or not parsed.netloc:
            raise ValueError("url must be an absolute HTTP or HTTPS URL")
        return value

    @field_validator("submitted_at")
    @classmethod
    def validate_submitted_at(cls, value: datetime) -> datetime:
        return _require_aware_utc_timestamp(value)
