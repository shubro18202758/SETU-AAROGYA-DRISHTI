# Redpanda

Redpanda is used as the universal data bus because it gives Kafka-compatible streaming with lower local operational overhead than a JVM/ZooKeeper stack.

Suggested initial topics:

```text
osint.raw.events
osint.enriched.events
osint.entities.upserts
osint.graph.edges
osint.graph.write
osint.events.high_confidence
osint.alerts
```

The Compose service is intentionally single-node for a local workstation but keeps Kafka-compatible interfaces so the topology can later scale to a clustered deployment.
