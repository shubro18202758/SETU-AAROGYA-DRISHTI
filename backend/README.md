# Backend

FastAPI control plane for source registration, task submission, graph/document lookup, and local LLM-assisted analysis.

The backend talks to:

- Redpanda for event intake and durable work queues.
- ArcadeDB for document, graph, and vector-aware persistence.
- TGI for local Qwen inference through the OpenAI-compatible API surface.

## Intelligence API

- `POST /intelligence/graphrag` embeds a natural language query, uses ArcadeDB vector search over `SemanticRelationship.evidence_embedding` to retrieve the top 5 relationship edges, then expands the connected graph 3 hops outward and returns the subgraph.
- `WS /intelligence/events` streams high-confidence `EVENT` entity notifications from `osint.events.high_confidence` after the database writer persists them.
