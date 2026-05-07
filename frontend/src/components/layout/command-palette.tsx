"use client";

import { useEffect, useMemo, useState } from "react";
import { Brain, Building2, CalendarClock, Loader2, MapPin, Search, UserRound, WifiOff, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Kbd } from "@/components/ui/kbd";
import { ScrollArea } from "@/components/ui/scroll-area";

type EntityKind = "PERSON" | "ORG" | "GEO" | "EVENT";

interface SearchEntity {
  id: string;
  name: string;
  kind: EntityKind;
  score: number | null;
  context: string;
}

type SearchStatus = "idle" | "loading" | "ready" | "error";

interface GraphNodePayload {
  id?: unknown;
  entity_type?: unknown;
  canonical_name?: unknown;
  confidence?: unknown;
  source_count?: unknown;
  last_updated?: unknown;
}

const icons = {
  PERSON: UserRound,
  ORG: Building2,
  GEO: MapPin,
  EVENT: CalendarClock,
} satisfies Record<EntityKind, typeof UserRound>;

export function CommandPalette({ enabled = true }: { enabled?: boolean }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchEntity[]>([]);
  const [status, setStatus] = useState<SearchStatus>("idle");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setOpen((current) => !current);
      }
      if (event.key === "Escape") {
        setOpen(false);
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  useEffect(() => {
    const trimmedQuery = query.trim();
    if (trimmedQuery.length < 2) {
      setResults([]);
      setStatus("idle");
      setError(null);
      return;
    }

    if (!enabled) {
      setResults([]);
      setStatus("error");
      setError("Intelligence API offline.");
      return;
    }

    const controller = new AbortController();
    const timer = setTimeout(async () => {
      setStatus("loading");
      setError(null);
      try {
        const response = await fetch("/api/intelligence/search", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ query: trimmedQuery }),
          cache: "no-store",
          signal: controller.signal,
        });
        const payload = (await response.json()) as unknown;
        if (!response.ok) {
          throw new Error(readError(payload));
        }
        setResults(parseSearchResults(payload));
        setStatus("ready");
      } catch (searchError) {
        if (controller.signal.aborted) {
          return;
        }
        setResults([]);
        setStatus("error");
        setError(searchError instanceof Error ? searchError.message : "GraphRAG search failed.");
      }
    }, 280);

    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [enabled, query]);

  const filtered = useMemo(() => results, [results]);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        suppressHydrationWarning
        className="flex h-9 min-w-0 flex-1 items-center gap-2 rounded-md border border-border bg-panel px-3 text-left text-sm text-muted outline-none transition hover:border-accent-cyan/50 hover:text-foreground focus-visible:ring-2 focus-visible:ring-accent-cyan/70"
      >
        <Search size={16} aria-hidden="true" />
        <span className="truncate">Search entities, relationships, events</span>
        <span className="ml-auto hidden items-center gap-1 sm:flex">
          <Kbd>Ctrl</Kbd>
          <Kbd>K</Kbd>
        </span>
      </button>

      {open ? (
        <div className="fixed inset-0 z-50 bg-black/60 p-3 backdrop-blur-sm" role="presentation" onMouseDown={() => setOpen(false)}>
          <div
            role="dialog"
            aria-modal="true"
            aria-label="Global entity search"
            className="mx-auto mt-20 w-full max-w-2xl rounded-md border border-border bg-panel shadow-2xl shadow-black/50"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <div className="flex items-center gap-2 border-b border-border p-3">
              <Brain size={17} className="text-accent-cyan" aria-hidden="true" />
              <Input autoFocus value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Global entity search" />
              <Button size="icon" variant="ghost" onClick={() => setOpen(false)} aria-label="Close search">
                <X size={16} aria-hidden="true" />
              </Button>
            </div>
            <ScrollArea className="max-h-[420px] p-2">
              {status === "idle" ? <PaletteEmptyState icon={Search} message="GraphRAG entity search is idle." /> : null}
              {status === "loading" ? <PaletteEmptyState icon={Loader2} message="Searching local graph" spinning /> : null}
              {status === "error" ? <PaletteEmptyState icon={WifiOff} message={error ?? "GraphRAG search failed."} tone="rose" /> : null}
              {status === "ready" && filtered.length === 0 ? <PaletteEmptyState icon={Search} message="No graph entities matched this query." /> : null}
              {filtered.map((entity) => {
                const Icon = icons[entity.kind];
                return (
                  <button
                    key={entity.id}
                    type="button"
                    className="grid w-full grid-cols-[32px_1fr_auto] items-center gap-3 rounded-md px-2 py-2 text-left hover:bg-white/5"
                  >
                    <span className="grid size-8 place-items-center rounded-md bg-white/5 text-accent-blue">
                      <Icon size={16} aria-hidden="true" />
                    </span>
                    <span className="min-w-0">
                      <span className="block truncate text-sm font-medium text-foreground">{entity.name}</span>
                      <span className="block truncate text-xs text-muted">{entity.context}</span>
                    </span>
                    <span className="text-xs text-muted">{entity.kind} - {formatScore(entity.score)}</span>
                  </button>
                );
              })}
            </ScrollArea>
          </div>
        </div>
      ) : null}
    </>
  );
}

function PaletteEmptyState({ icon: Icon, message, spinning = false, tone = "cyan" }: { icon: typeof Search; message: string; spinning?: boolean; tone?: "cyan" | "rose" }) {
  return (
    <div className="grid min-h-[180px] place-items-center px-4 text-center text-sm text-muted">
      <div className="grid justify-items-center gap-2">
        <Icon size={22} className={`${spinning ? "animate-spin" : ""} ${tone === "rose" ? "text-accent-rose" : "text-accent-cyan"}`} aria-hidden="true" />
        <div>{message}</div>
      </div>
    </div>
  );
}

function parseSearchResults(payload: unknown): SearchEntity[] {
  if (!isRecord(payload) || !Array.isArray(payload.entities)) {
    return [];
  }
  return payload.entities.map(parseGraphNode).filter((entity): entity is SearchEntity => entity !== null).slice(0, 25);
}

function parseGraphNode(value: unknown): SearchEntity | null {
  if (!isRecord(value)) {
    return null;
  }
  const node = value as GraphNodePayload;
  const id = asString(node.id);
  const kind = parseEntityKind(node.entity_type);
  if (id === null || kind === null) {
    return null;
  }
  const sourceCount = asNumber(node.source_count);
  const lastUpdated = asString(node.last_updated);
  return {
    id,
    kind,
    name: asString(node.canonical_name) ?? id,
    score: asNumber(node.confidence),
    context: sourceCount === null ? formatLastUpdated(lastUpdated) : `${sourceCount} source${sourceCount === 1 ? "" : "s"} - ${formatLastUpdated(lastUpdated)}`,
  };
}

function parseEntityKind(value: unknown): EntityKind | null {
  return value === "PERSON" || value === "ORG" || value === "GEO" || value === "EVENT" ? value : null;
}

function formatScore(value: number | null): string {
  return value === null ? "n/a" : value.toFixed(2);
}

function formatLastUpdated(value: string | null): string {
  if (value === null) {
    return "no timestamp";
  }
  return new Intl.DateTimeFormat("en", { month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit" }).format(new Date(value));
}

function readError(payload: unknown): string {
  if (isRecord(payload) && typeof payload.error === "string") {
    return payload.error;
  }
  if (isRecord(payload) && typeof payload.detail === "string") {
    return payload.detail;
  }
  return "GraphRAG search failed.";
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
