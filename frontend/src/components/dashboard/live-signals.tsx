"use client";

import { memo, useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, ChevronRight, Loader2, RadioTower, Trash2, WifiOff } from "lucide-react";

import { useLiveEventSignals } from "@/hooks/use-live-event-signals";
import { cn } from "@/lib/utils";
import type { ConnectedEntity, LiveEventConnectionStatus, LiveEventSignal } from "@/types/intelligence";
import { Button } from "@/components/ui/button";
import { Panel, PanelBody, PanelHeader, PanelTitle } from "@/components/ui/panel";
import { ProgressBar } from "@/components/ui/progress";
import { ScrollArea } from "@/components/ui/scroll-area";
import { StatusPill } from "@/components/ui/status-pill";

const COLLAPSED_ROW_HEIGHT = 58;
const EXPANDED_ROW_HEIGHT = 174;
const OVERSCAN_ROWS = 5;

type ExpansionState =
  | { status: "idle"; entities: ConnectedEntity[] }
  | { status: "loading"; entities: ConnectedEntity[] }
  | { status: "ready"; entities: ConnectedEntity[] }
  | { status: "error"; entities: ConnectedEntity[]; message: string };

interface LiveSignalsProps {
  className?: string;
  enabled?: boolean;
}

interface VirtualRow {
  index: number;
  signal: LiveEventSignal;
  top: number;
  height: number;
}

export function LiveSignals({ className, enabled = true }: LiveSignalsProps) {
  const { events, status, lastError, clear } = useLiveEventSignals({ maxEvents: 600, enabled });
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [expansions, setExpansions] = useState<Record<string, ExpansionState>>({});
  const virtualContainerRef = useRef<HTMLDivElement | null>(null);
  const { scrollRef, totalHeight, virtualRows, onScroll } = useVirtualSignalRows(events, expandedId);
  const connectionTone = getConnectionTone(status);

  useLayoutEffect(() => {
    if (virtualContainerRef.current !== null) {
      virtualContainerRef.current.style.height = `${totalHeight}px`;
    }
  }, [totalHeight]);

  const loadConnectedEntities = useCallback(async (signal: LiveEventSignal) => {
    setExpansions((current) => ({
      ...current,
      [signal.id]: { status: "loading", entities: current[signal.id]?.entities ?? [] },
    }));

    try {
      const response = await fetch(`/api/intelligence/events/${encodeURIComponent(signal.eventEntityId)}/entities`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ canonicalName: signal.canonicalName, timestamp: signal.timestamp }),
      });
      const payload = (await response.json()) as unknown;
      if (!response.ok) {
        throw new Error(getErrorMessage(payload));
      }
      setExpansions((current) => ({
        ...current,
        [signal.id]: { status: "ready", entities: parseConnectedEntities(payload) },
      }));
    } catch (error) {
      setExpansions((current) => ({
        ...current,
        [signal.id]: {
          status: "error",
          entities: current[signal.id]?.entities ?? [],
          message: error instanceof Error ? error.message : "Connected entity lookup failed.",
        },
      }));
    }
  }, []);

  const toggleExpanded = useCallback(
    (signal: LiveEventSignal) => {
      const nextExpandedId = expandedId === signal.id ? null : signal.id;
      setExpandedId(nextExpandedId);
      if (nextExpandedId !== null && expansions[signal.id] === undefined) {
        void loadConnectedEntities(signal);
      }
    },
    [expandedId, expansions, loadConnectedEntities],
  );

  return (
    <Panel id="live-signals" className={cn("min-w-0", className)}>
      <PanelHeader>
        <div className="min-w-0">
          <PanelTitle>Live Signals</PanelTitle>
          <div className="truncate text-xs text-muted">High-confidence EVENT stream</div>
        </div>
        <div className="flex items-center gap-2">
          <StatusPill tone={connectionTone}>{formatStatus(status)}</StatusPill>
          <Button size="icon" variant="ghost" onClick={clear} aria-label="Clear live signals">
            <Trash2 size={15} aria-hidden="true" />
          </Button>
        </div>
      </PanelHeader>
      <PanelBody className="p-0">
        <div className="grid min-w-[760px] grid-cols-[86px_minmax(190px,1fr)_160px_170px_34px] border-b border-border px-3 py-2 text-xs font-medium uppercase tracking-normal text-muted">
          <span>Type</span>
          <span>Event</span>
          <span>Timestamp</span>
          <span>Confidence</span>
          <span />
        </div>
        <ScrollArea ref={scrollRef} className="h-[378px]" onScroll={onScroll}>
          {events.length === 0 ? (
            <EmptySignals status={status} lastError={lastError} />
          ) : (
            <div ref={virtualContainerRef} className="relative min-w-[760px]">
              {virtualRows.map((row) => (
                <SignalRow
                  key={row.signal.id}
                  expansion={expansions[row.signal.id] ?? { status: "idle", entities: [] }}
                  height={row.height}
                  isExpanded={expandedId === row.signal.id}
                  signal={row.signal}
                  top={row.top}
                  onToggle={toggleExpanded}
                />
              ))}
            </div>
          )}
        </ScrollArea>
      </PanelBody>
    </Panel>
  );
}

const SignalRow = memo(function SignalRow({
  expansion,
  height,
  isExpanded,
  signal,
  top,
  onToggle,
}: {
  expansion: ExpansionState;
  height: number;
  isExpanded: boolean;
  signal: LiveEventSignal;
  top: number;
  onToggle: (signal: LiveEventSignal) => void;
}) {
  const confidencePercent = signal.confidence * 100;
  const confidenceTone = getConfidenceTone(signal.confidence);
  const rowRef = useRef<HTMLDivElement | null>(null);

  useLayoutEffect(() => {
    if (rowRef.current !== null) {
      rowRef.current.style.height = `${height}px`;
      rowRef.current.style.transform = `translateY(${top}px)`;
    }
  }, [height, top]);

  return (
    <div ref={rowRef} className="absolute left-0 right-0 border-b border-border/70">
      <button
        type="button"
        data-expanded={isExpanded ? "true" : "false"}
        className="grid h-[58px] w-full grid-cols-[86px_minmax(190px,1fr)_160px_170px_34px] items-center gap-0 px-3 text-left text-sm outline-none transition hover:bg-white/4 focus-visible:bg-white/5 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent-cyan/60"
        onClick={() => onToggle(signal)}
      >
        <span className="font-semibold text-accent-amber">{signal.eventType}</span>
        <span className="min-w-0 pr-3">
          <span className="block truncate font-medium text-foreground">{signal.canonicalName}</span>
          <span className="block truncate text-xs text-muted">Batch {signal.sourceBatchId}</span>
        </span>
        <time className="text-xs text-muted" dateTime={signal.timestamp}>
          {formatTimestamp(signal.timestamp)}
        </time>
        <span className="grid gap-1 pr-3">
          <span className="flex items-center justify-between text-xs">
            <span className="text-muted">Score</span>
            <span className="font-medium text-foreground">{confidencePercent.toFixed(1)}%</span>
          </span>
          <ProgressBar value={confidencePercent} tone={confidenceTone} />
        </span>
        <span className="grid place-items-center text-muted">{isExpanded ? <ChevronDown size={16} aria-hidden="true" /> : <ChevronRight size={16} aria-hidden="true" />}</span>
      </button>
      {isExpanded ? <ConnectedEntityPanel expansion={expansion} /> : null}
    </div>
  );
});

function ConnectedEntityPanel({ expansion }: { expansion: ExpansionState }) {
  return (
    <div className="mx-3 mb-3 grid min-h-[104px] gap-2 rounded-md border border-border bg-panel-strong p-3 text-sm">
      {expansion.status === "loading" ? (
        <div className="flex items-center gap-2 text-muted">
          <Loader2 size={15} className="animate-spin text-accent-cyan" aria-hidden="true" />
          Loading connected entities
        </div>
      ) : null}
      {expansion.status === "error" ? <div className="text-accent-rose">{expansion.message}</div> : null}
      {expansion.status === "ready" && expansion.entities.length === 0 ? <div className="text-muted">No ORG, PERSON, or GEO nodes returned for this event.</div> : null}
      {expansion.entities.length > 0 ? (
        <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
          {expansion.entities.map((entity) => (
            <div key={entity.id} className="grid gap-1 rounded-md border border-border bg-background/60 px-2.5 py-2">
              <div className="flex items-center justify-between gap-2">
                <StatusPill tone={getEntityTone(entity.entityType)}>{entity.entityType}</StatusPill>
                <span className="text-xs text-muted">{entity.confidence === null ? "n/a" : `${(entity.confidence * 100).toFixed(0)}%`}</span>
              </div>
              <div className="truncate font-medium">{entity.canonicalName}</div>
              <div className="truncate text-xs text-muted">{entity.lastUpdated === null ? entity.id : formatTimestamp(entity.lastUpdated)}</div>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function EmptySignals({ status, lastError }: { status: LiveEventConnectionStatus; lastError: string | null }) {
  const Icon = status === "error" ? WifiOff : RadioTower;
  return (
    <div className="grid h-full min-h-[300px] place-items-center px-4 text-center text-sm text-muted">
      <div className="grid gap-2 justify-items-center">
        <Icon size={22} className={status === "error" ? "text-accent-rose" : "text-accent-cyan"} aria-hidden="true" />
        <div>{lastError ?? "Waiting for high-confidence EVENT entities"}</div>
      </div>
    </div>
  );
}

function useVirtualSignalRows(events: LiveEventSignal[], expandedId: string | null) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const scrollAnimationFrameRef = useRef<number | null>(null);
  const latestScrollTopRef = useRef(0);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(378);

  const rowMetrics = useMemo(() => {
    const offsets: number[] = [];
    const heights: number[] = [];
    let totalHeight = 0;
    for (const event of events) {
      offsets.push(totalHeight);
      const height = expandedId === event.id ? EXPANDED_ROW_HEIGHT : COLLAPSED_ROW_HEIGHT;
      heights.push(height);
      totalHeight += height;
    }
    return { offsets, heights, totalHeight };
  }, [events, expandedId]);

  useLayoutEffect(() => {
    const element = scrollRef.current;
    if (element === null) {
      return;
    }
    setViewportHeight(element.clientHeight);
    const observer = new ResizeObserver(([entry]) => {
      if (entry !== undefined) {
        setViewportHeight(entry.contentRect.height);
      }
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const onScroll = useCallback((event: React.UIEvent<HTMLDivElement>) => {
    latestScrollTopRef.current = event.currentTarget.scrollTop;
    if (scrollAnimationFrameRef.current !== null) {
      return;
    }
    scrollAnimationFrameRef.current = window.requestAnimationFrame(() => {
      scrollAnimationFrameRef.current = null;
      setScrollTop(latestScrollTopRef.current);
    });
  }, []);

  const virtualRows = useMemo<VirtualRow[]>(() => {
    if (events.length === 0) {
      return [];
    }
    const startIndex = Math.max(findRowIndex(rowMetrics.offsets, scrollTop) - OVERSCAN_ROWS, 0);
    const endOffset = scrollTop + viewportHeight;
    let endIndex = startIndex;
    while (endIndex < events.length) {
      const currentOffset = rowMetrics.offsets[endIndex];
      if (currentOffset === undefined || currentOffset >= endOffset) {
        break;
      }
      endIndex += 1;
    }
    endIndex = Math.min(endIndex + OVERSCAN_ROWS, events.length - 1);

    const rows: VirtualRow[] = [];
    for (let index = startIndex; index <= endIndex; index += 1) {
      const signal = events[index];
      const top = rowMetrics.offsets[index];
      const height = rowMetrics.heights[index];
      if (signal !== undefined && top !== undefined && height !== undefined) {
        rows.push({ index, signal, top, height });
      }
    }
    return rows;
  }, [events, rowMetrics.heights, rowMetrics.offsets, scrollTop, viewportHeight]);

  return { scrollRef, totalHeight: rowMetrics.totalHeight, virtualRows, onScroll };
}

function findRowIndex(offsets: number[], offset: number): number {
  let low = 0;
  let high = Math.max(offsets.length - 1, 0);
  while (low < high) {
    const midpoint = Math.floor((low + high + 1) / 2);
    if ((offsets[midpoint] ?? 0) <= offset) {
      low = midpoint;
    } else {
      high = midpoint - 1;
    }
  }
  return low;
}

function parseConnectedEntities(payload: unknown): ConnectedEntity[] {
  if (!isRecord(payload) || !Array.isArray(payload.entities)) {
    return [];
  }
  return payload.entities.filter(isConnectedEntity);
}

function isConnectedEntity(value: unknown): value is ConnectedEntity {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    (value.entityType === "ORG" || value.entityType === "PERSON" || value.entityType === "GEO") &&
    typeof value.canonicalName === "string" &&
    (typeof value.confidence === "number" || value.confidence === null) &&
    (typeof value.lastUpdated === "string" || value.lastUpdated === null)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function getErrorMessage(payload: unknown): string {
  if (isRecord(payload) && typeof payload.error === "string") {
    return payload.error;
  }
  return "Connected entity lookup failed.";
}

function getConnectionTone(status: LiveEventConnectionStatus): "green" | "amber" | "rose" | "cyan" {
  if (status === "open") {
    return "green";
  }
  if (status === "error") {
    return "rose";
  }
  if (status === "connecting") {
    return "amber";
  }
  return "cyan";
}

function formatStatus(status: LiveEventConnectionStatus): string {
  return status === "open" ? "Listening" : status;
}

function getConfidenceTone(confidence: number): "green" | "cyan" | "amber" | "rose" {
  if (confidence >= 0.94) {
    return "green";
  }
  if (confidence >= 0.9) {
    return "cyan";
  }
  if (confidence >= 0.85) {
    return "amber";
  }
  return "rose";
}

function getEntityTone(entityType: ConnectedEntity["entityType"]): "blue" | "cyan" | "green" {
  if (entityType === "ORG") {
    return "blue";
  }
  if (entityType === "PERSON") {
    return "cyan";
  }
  return "green";
}

function formatTimestamp(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return new Intl.DateTimeFormat("en", {
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(date);
}
