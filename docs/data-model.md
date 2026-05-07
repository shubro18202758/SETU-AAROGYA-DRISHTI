# Data Model

## Event Envelope

```json
{
  "source": "string",
  "kind": "raw_observation",
  "observed_at": "2026-05-04T00:00:00Z",
  "content": {},
  "provenance": {},
  "classification": "local"
}
```

## RawEvent Schema

```json
{
  "id": "2e5f69d9-311f-4b7a-a21b-1a0a87094e63",
  "collector_name": "public-web",
  "source_uri": "https://example.test/profile",
  "content_type": "text/markdown",
  "fetch_timestamp": "2026-05-04T00:00:00Z",
  "raw_markdown_payload": "# Public profile\n\nObserved at a community event."
}
```

`RawEvent` is immutable and strict: timestamps must be timezone-aware, unknown fields are rejected, and forbidden domain-specific terms are rejected before events enter the stream.

## TargetURL Schema

Targets are consumed by the collector Conductor from `osint.targets.urls`.

```json
{
  "id": "8cde0f8c-0871-43e7-9470-545aef072e7a",
  "url": "https://example.test/profile",
  "submitted_at": "2026-05-04T00:00:00Z",
  "plugin_hint": "public-web"
}
```

`plugin_hint` is optional. When omitted, the Conductor asks the dynamic plugin registry for the first plugin that can handle the URL.

## Storage Principles

- Keep raw observations immutable.
- Store extracted entities as graph vertices with provenance edges back to evidence.
- Keep embedding payloads next to the document or entity they represent.
- Prefer append-only event topics and idempotent database upserts.

## GraphWriteBatch Schema

The database writer consumes `GraphWriteBatch` messages from `osint.graph.write` after extraction, validation, and entity resolution. Each batch contains deduplicated entity upserts plus relationship edge upserts with resolved source and destination entity IDs.

Relationship edges are immutable historical records: the writer derives an edge identity from source entity, destination entity, `valid_from`, and `evidence_text`. A new `valid_from` creates a new edge instead of overwriting past connections.

The writer stores a compact embedding of each relationship `evidence_text` directly on the edge property `evidence_embedding` and bootstraps an ArcadeDB `LSM_VECTOR` index on that property for HNSW-backed similarity search.
