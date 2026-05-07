# Observability

Keep the local baseline lightweight before adding dashboards:

- Redpanda exposes broker health through `rpk` and Console under the `ops` profile.
- Backend and workers should emit structured JSON logs.
- LLM latency, token counts, and cache misses should be recorded per enrichment task.
- ArcadeDB query timings should be logged around write-heavy ingestion paths.
