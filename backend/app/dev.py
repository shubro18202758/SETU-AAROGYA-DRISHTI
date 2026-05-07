"""Local dev entrypoint for the standalone SETU prototype.

Use when running the backend without docker-compose. It disables the Redpanda
consumer and seeds the process-local SETU store with a realistic pilot workload.
"""

from backend.app.main import create_app

app = create_app(start_event_consumer=False, seed_setu_store=True)
