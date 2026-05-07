from __future__ import annotations

import argparse
import asyncio
import os
import tempfile
from collections.abc import Iterable, Sequence
from contextlib import suppress
from dataclasses import dataclass
from datetime import UTC, datetime
from importlib import import_module
from pathlib import Path
from typing import Any, Literal
from uuid import uuid4

import orjson

from backend.app.schemas import RawEvent

InputFormat = Literal["csv", "json-array", "ndjson"]


@dataclass(frozen=True, slots=True)
class QuantitativeProcessorConfig:
    timestamp_column: str
    value_column: str
    source_uri: str
    collector_name: str = "quantitative-telemetry"
    group_columns: tuple[str, ...] = ()
    aggregate_every: str = "1m"
    moving_average_windows: tuple[int, ...] = (5, 20)
    min_value: float | None = None
    max_value: float | None = None
    start_time: datetime | None = None
    end_time: datetime | None = None
    timestamp_epoch_unit: Literal["s", "ms", "us", "ns"] | None = None
    json_array_pointer: str = "item"
    max_polars_threads: int | None = None


class QuantitativeTelemetryProcessor:
    def __init__(self, config: QuantitativeProcessorConfig) -> None:
        self.config = config

    def process_file(self, path: str | Path, input_format: InputFormat) -> list[RawEvent]:
        materialized_paths: list[Path] = []
        try:
            scan_path = Path(path)
            scan_format = input_format
            if input_format == "json-array":
                scan_path = self._json_array_to_ndjson(scan_path)
                materialized_paths.append(scan_path)
                scan_format = "ndjson"
            lazy_frame = self._scan_lazy(scan_path, scan_format)
            return self.events_from_lazy_frame(lazy_frame)
        finally:
            for temporary_path in materialized_paths:
                with suppress(FileNotFoundError):
                    temporary_path.unlink()

    async def process_api(self, api_url: str, input_format: InputFormat) -> list[RawEvent]:
        materialized_paths: list[Path] = []
        try:
            payload_path = await self._download_api_payload(api_url, input_format)
            materialized_paths.append(payload_path)
            return self.process_file(payload_path, input_format)
        finally:
            for temporary_path in materialized_paths:
                with suppress(FileNotFoundError):
                    temporary_path.unlink()

    def events_from_lazy_frame(self, lazy_frame: Any) -> list[RawEvent]:
        polars = _polars(self.config.max_polars_threads)
        aggregate_frame = self._build_aggregate_plan(lazy_frame, polars)
        frame = _collect_streaming(aggregate_frame)
        return [self._row_to_raw_event(row) for row in frame.iter_rows(named=True)]

    def _scan_lazy(self, path: Path, input_format: InputFormat) -> Any:
        polars = _polars(self.config.max_polars_threads)
        if input_format == "csv":
            return polars.scan_csv(path, infer_schema_length=10_000, try_parse_dates=False)
        if input_format == "ndjson":
            return polars.scan_ndjson(path, infer_schema_length=10_000)
        raise ValueError(f"unsupported lazy input format: {input_format}")

    def _build_aggregate_plan(self, lazy_frame: Any, polars: Any) -> Any:
        timestamp_expr = _timestamp_expr(polars, self.config)
        value_expr = polars.col(self.config.value_column).cast(polars.Float64).alias("__value")
        frame = lazy_frame.with_columns(timestamp_expr, value_expr).drop_nulls(["__timestamp", "__value"])

        filters = []
        if self.config.start_time is not None:
            filters.append(polars.col("__timestamp") >= _as_utc(self.config.start_time))
        if self.config.end_time is not None:
            filters.append(polars.col("__timestamp") < _as_utc(self.config.end_time))
        if self.config.min_value is not None:
            filters.append(polars.col("__value") >= self.config.min_value)
        if self.config.max_value is not None:
            filters.append(polars.col("__value") <= self.config.max_value)
        for predicate in filters:
            frame = frame.filter(predicate)

        sort_columns = [*self.config.group_columns, "__timestamp"]
        frame = frame.sort(sort_columns)
        moving_average_columns = []
        for window in self.config.moving_average_windows:
            if window <= 0:
                raise ValueError("moving average windows must be positive integers")
            expression = polars.col("__value").rolling_mean(window_size=window, min_samples=1)
            if self.config.group_columns:
                expression = expression.over(self.config.group_columns)
            alias = f"moving_average_{window}"
            moving_average_columns.append(alias)
            frame = frame.with_columns(expression.alias(alias))

        frame = frame.with_columns(
            polars.col("__timestamp").dt.truncate(self.config.aggregate_every).alias("__bucket")
        )
        group_by_columns = ["__bucket", *self.config.group_columns]
        aggregations = [
            polars.len().alias("row_count"),
            polars.col("__value").mean().alias("value_mean"),
            polars.col("__value").min().alias("value_min"),
            polars.col("__value").max().alias("value_max"),
            polars.col("__value").std().alias("value_stddev"),
        ]
        aggregations.extend(
            polars.col(column_name).last().alias(f"{column_name}_latest")
            for column_name in moving_average_columns
        )
        return frame.group_by(group_by_columns).agg(aggregations).sort(group_by_columns)

    def _row_to_raw_event(self, row: dict[str, Any]) -> RawEvent:
        markdown = _format_row_markdown(row, self.config)
        return RawEvent(
            id=uuid4(),
            collector_name=self.config.collector_name,
            source_uri=self.config.source_uri,
            content_type="text/markdown; variant=gfm",
            fetch_timestamp=datetime.now(UTC),
            raw_markdown_payload=markdown,
        )

    def _json_array_to_ndjson(self, json_path: Path) -> Path:
        ijson = import_module("ijson")
        output = tempfile.NamedTemporaryFile(delete=False, suffix=".ndjson")
        output_path = Path(output.name)
        output.close()
        try:
            with json_path.open("rb") as source, output_path.open("wb") as destination:
                for item in ijson.items(source, self.config.json_array_pointer):
                    destination.write(orjson.dumps(item))
                    destination.write(b"\n")
            return output_path
        except Exception:
            with suppress(FileNotFoundError):
                output_path.unlink()
            raise

    async def _download_api_payload(self, api_url: str, input_format: InputFormat) -> Path:
        httpx = import_module("httpx")
        suffix = ".csv" if input_format == "csv" else ".json"
        output = tempfile.NamedTemporaryFile(delete=False, suffix=suffix)
        output_path = Path(output.name)
        output.close()
        try:
            async with httpx.AsyncClient(timeout=None, follow_redirects=True) as client:
                async with client.stream("GET", api_url) as response:
                    response.raise_for_status()
                    with output_path.open("wb") as destination:
                        async for chunk in response.aiter_bytes(chunk_size=1 << 20):
                            destination.write(chunk)
            return output_path
        except Exception:
            with suppress(FileNotFoundError):
                output_path.unlink()
            raise


def _polars(max_threads: int | None) -> Any:
    thread_budget = max_threads or int(os.getenv("QUANT_POLARS_MAX_THREADS", "0") or "0")
    if thread_budget <= 0:
        thread_budget = max(1, min(4, (os.cpu_count() or 2) // 2))
    os.environ.setdefault("POLARS_MAX_THREADS", str(thread_budget))
    return import_module("polars")


def _timestamp_expr(polars: Any, config: QuantitativeProcessorConfig) -> Any:
    source = polars.col(config.timestamp_column)
    if config.timestamp_epoch_unit is not None:
        return polars.from_epoch(
            source.cast(polars.Int64),
            time_unit=config.timestamp_epoch_unit,
        ).alias("__timestamp")
    return source.cast(polars.Utf8).str.to_datetime(strict=False, time_zone="UTC").alias("__timestamp")


def _collect_streaming(lazy_frame: Any) -> Any:
    try:
        return lazy_frame.collect(engine="streaming")
    except TypeError:
        return lazy_frame.collect(streaming=True)


def _as_utc(value: datetime) -> datetime:
    if value.tzinfo is None or value.utcoffset() is None:
        return value.replace(tzinfo=UTC)
    return value.astimezone(UTC)


def _format_row_markdown(row: dict[str, Any], config: QuantitativeProcessorConfig) -> str:
    bucket = _format_value(row["__bucket"])
    lines = [
        "# Quantitative Signal Batch",
        "",
        f"- Time bucket: `{bucket}`",
        f"- Row count: `{row['row_count']}`",
    ]
    for column_name in config.group_columns:
        lines.append(f"- Group `{column_name}`: `{_format_value(row.get(column_name))}`")

    lines.extend(
        [
            "",
            "| Measure | Value |",
            "| --- | ---: |",
            f"| Mean | {_format_number(row.get('value_mean'))} |",
            f"| Minimum | {_format_number(row.get('value_min'))} |",
            f"| Maximum | {_format_number(row.get('value_max'))} |",
            f"| Standard deviation | {_format_number(row.get('value_stddev'))} |",
        ]
    )
    for window in config.moving_average_windows:
        lines.append(
            f"| Moving average {window} | {_format_number(row.get(f'moving_average_{window}_latest'))} |"
        )
    return "\n".join(lines)


def _format_number(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, float):
        return f"{value:.6g}"
    return str(value)


def _format_value(value: Any) -> str:
    if isinstance(value, datetime):
        return value.astimezone(UTC).isoformat()
    return str(value)


def _parse_datetime(value: str | None) -> datetime | None:
    if value is None:
        return None
    normalized = value.replace("Z", "+00:00")
    return _as_utc(datetime.fromisoformat(normalized))


def _split_group_columns(values: Sequence[str]) -> tuple[str, ...]:
    columns: list[str] = []
    for value in values:
        columns.extend(column.strip() for column in value.split(",") if column.strip())
    return tuple(columns)


def _write_jsonl(events: Iterable[RawEvent], output: Path | None) -> None:
    if output is None:
        for event in events:
            print(event.model_dump_json())
        return
    with output.open("w", encoding="utf-8") as file:
        for event in events:
            file.write(event.model_dump_json())
            file.write("\n")


async def run_cli(args: argparse.Namespace) -> int:
    source_uri = args.source_uri or args.api_url or Path(args.input).resolve().as_uri()
    processor = QuantitativeTelemetryProcessor(
        QuantitativeProcessorConfig(
            timestamp_column=args.timestamp_column,
            value_column=args.value_column,
            source_uri=source_uri,
            collector_name=args.collector_name,
            group_columns=_split_group_columns(args.group_by),
            aggregate_every=args.aggregate_every,
            moving_average_windows=tuple(args.moving_average_window),
            min_value=args.min_value,
            max_value=args.max_value,
            start_time=_parse_datetime(args.start_time),
            end_time=_parse_datetime(args.end_time),
            timestamp_epoch_unit=args.timestamp_epoch_unit,
            json_array_pointer=args.json_array_pointer,
            max_polars_threads=args.polars_threads,
        )
    )
    if args.api_url:
        events = await processor.process_api(args.api_url, args.format)
    else:
        events = processor.process_file(args.input, args.format)
    _write_jsonl(events, Path(args.output) if args.output else None)
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Process large quantitative telemetry into RawEvent JSONL.")
    source = parser.add_mutually_exclusive_group(required=True)
    source.add_argument("--input", help="Path to a CSV, NDJSON, or JSON array file.")
    source.add_argument("--api-url", help="HTTP API URL returning CSV, NDJSON, or a JSON array.")
    parser.add_argument("--format", choices=("csv", "json-array", "ndjson"), required=True)
    parser.add_argument("--timestamp-column", required=True)
    parser.add_argument("--value-column", required=True)
    parser.add_argument("--group-by", action="append", default=[])
    parser.add_argument("--aggregate-every", default="1m")
    parser.add_argument("--moving-average-window", action="append", type=int, default=[5, 20])
    parser.add_argument("--min-value", type=float)
    parser.add_argument("--max-value", type=float)
    parser.add_argument("--start-time")
    parser.add_argument("--end-time")
    parser.add_argument("--timestamp-epoch-unit", choices=("s", "ms", "us", "ns"))
    parser.add_argument("--json-array-pointer", default="item")
    parser.add_argument("--source-uri")
    parser.add_argument("--collector-name", default="quantitative-telemetry")
    parser.add_argument("--polars-threads", type=int)
    parser.add_argument("--output", help="Optional JSONL output path. Defaults to stdout.")
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    return asyncio.run(run_cli(build_parser().parse_args(argv)))


if __name__ == "__main__":
    raise SystemExit(main())
