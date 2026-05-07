# Workers

Workers consume from Redpanda topics and write normalized observations, entities, relationships, and embeddings to ArcadeDB through the backend or direct database clients.

- `ingestion`: source-specific collectors and raw event producers.
- `enrichment`: local LLM and extraction pipeline consumers.

The built-in ingestion plugin `advanced-web` uses Crawl4AI for fresh, browser-backed HTML to GFM extraction with Shadow DOM flattening, consent-overlay cleanup, density-bounded Markdown, proxy-aware retries, and long-running session recycling.

The quantitative processor `osint-quantitative-processor` uses Polars lazy frames for CSV, NDJSON, and API JSON-array telemetry. It caps Polars worker threads through `QUANT_POLARS_MAX_THREADS` / `POLARS_MAX_THREADS`, applies predicate pushdown, computes moving averages, and emits discrete `RawEvent` JSONL summaries.
