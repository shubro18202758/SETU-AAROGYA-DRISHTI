from __future__ import annotations

import tempfile
from datetime import UTC, datetime
from pathlib import Path

from backend.app.schemas import RawEvent
from workers.ingestion.app.processors.quantitative import (
    QuantitativeProcessorConfig,
    QuantitativeTelemetryProcessor,
)


def test_quantitative_processor_filters_aggregates_and_emits_raw_events() -> None:
    csv_text = "\n".join(
        [
            "timestamp,symbol,value",
            "2026-05-04T00:00:00Z,ALPHA,10",
            "2026-05-04T00:00:30Z,ALPHA,20",
            "2026-05-04T00:01:00Z,ALPHA,30",
            "2026-05-04T00:01:30Z,BETA,40",
        ]
    )
    with tempfile.TemporaryDirectory() as directory:
        csv_path = Path(directory) / "telemetry.csv"
        csv_path.write_text(csv_text, encoding="utf-8")
        processor = QuantitativeTelemetryProcessor(
            QuantitativeProcessorConfig(
                timestamp_column="timestamp",
                value_column="value",
                source_uri="https://example.test/telemetry.csv",
                group_columns=("symbol",),
                aggregate_every="1m",
                moving_average_windows=(2,),
                min_value=15,
                max_polars_threads=1,
            )
        )

        events = processor.process_file(csv_path, "csv")

    assert len(events) == 3
    assert all(isinstance(event, RawEvent) for event in events)
    payloads = [event.raw_markdown_payload for event in events]
    assert all("# Quantitative Signal Batch" in payload for payload in payloads)
    assert all("Moving average 2" in payload for payload in payloads)
    assert any("`ALPHA`" in payload and "Mean | 20" in payload for payload in payloads)
    assert any("`BETA`" in payload and "Maximum | 40" in payload for payload in payloads)


def test_quantitative_processor_applies_time_window() -> None:
    csv_text = "\n".join(
        [
            "timestamp,value",
            "2026-05-04T00:00:00Z,1",
            "2026-05-04T00:01:00Z,2",
            "2026-05-04T00:02:00Z,3",
        ]
    )
    with tempfile.TemporaryDirectory() as directory:
        csv_path = Path(directory) / "telemetry.csv"
        csv_path.write_text(csv_text, encoding="utf-8")
        processor = QuantitativeTelemetryProcessor(
            QuantitativeProcessorConfig(
                timestamp_column="timestamp",
                value_column="value",
                source_uri="https://example.test/telemetry.csv",
                aggregate_every="1m",
                moving_average_windows=(2,),
                start_time=datetime(2026, 5, 4, 0, 1, tzinfo=UTC),
                end_time=datetime(2026, 5, 4, 0, 2, tzinfo=UTC),
                max_polars_threads=1,
            )
        )

        events = processor.process_file(csv_path, "csv")

    assert len(events) == 1
    assert "Mean | 2" in events[0].raw_markdown_payload
    assert "2026-05-04T00:01:00" in events[0].raw_markdown_payload
