# ArcadeDB

ArcadeDB is the single native multi-model database for this local architecture. It avoids splitting document, graph, and vector-oriented state across separate services.

Initial logical model:

- Documents: `Source`, `RawObservation`, `Evidence`, `AnalystNote`
- Vertices: `Entity`, `Identity`, `Location`, `Organization`, `Event`
- Edges: `MENTIONS`, `LOCATED_AT`, `AFFILIATED_WITH`, `OBSERVED_IN`, `DERIVED_FROM`
- Vector payloads: embedding fields are stored alongside observations or entities so retrieval and graph traversal stay co-located.

The Compose JVM cap is intentionally small. If graph traversals or vector indexes grow, raise `JAVA_OPTS -Xmx` before adding another database service.
