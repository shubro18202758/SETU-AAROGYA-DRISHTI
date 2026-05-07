# Architecture

## Runtime Flow

1. Ingestion workers normalize source events and publish raw envelopes to Redpanda.
2. Enrichment workers consume raw events, call the local Qwen service when language reasoning is needed, and publish enriched envelopes.
3. Backend APIs coordinate analyst workflows, durable writes, and query endpoints.
4. ArcadeDB stores source documents, extracted entities, graph relationships, and embedding payloads in one multi-model engine.
5. Frontend provides the local operator console.

## Component Rationale

Redpanda keeps the event bus fast and compact for a single workstation while preserving Kafka compatibility. TGI gives a production-grade local inference server with explicit 4-bit quantization controls. ArcadeDB keeps document, graph, and vector-oriented state together instead of creating a RAM-heavy polyglot data tier.
