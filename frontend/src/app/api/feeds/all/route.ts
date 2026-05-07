/**
 * Multi-source aggregated feed — fetches from ALL available sources in parallel:
 *   HackerNews (Algolia), Reddit, GDELT, PubMed, WHO/CDC/ECDC RSS
 *
 * Returns a deduplicated, relevance-ranked aggregate with per-source breakdown metrics.
 * This is the endpoint used by the "All Sources" tab in the Signal Intake Sandbox.
 */
import { NextResponse } from "next/server";

import type { FeedItem } from "@/app/api/feeds/hackernews/route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export interface SourceMetric {
  source: string;
  label: string;
  count: number;
  scanned: number;
  latencyMs: number;
  ok: boolean;
  notice: string | null;
  fallback: boolean;
}

export interface AllFeedsResponse {
  query: string;
  count: number;
  scanned: number;
  fetchedAt: string;
  sources: SourceMetric[];
  items: FeedItem[];
}

interface SourceFetchResult {
  metric: SourceMetric;
  items: FeedItem[];
}

function clampInt(raw: string | null, min: number, max: number, fallback: number): number {
  if (raw === null) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

async function fetchSource(
  name: string,
  label: string,
  url: string,
): Promise<SourceFetchResult> {
  const start = Date.now();
  try {
    const response = await fetch(url, {
      cache: "no-store",
      signal: AbortSignal.timeout(12000),
      headers: { "user-agent": "osint-os/0.1" },
    });
    const latencyMs = Date.now() - start;
    if (!response.ok) {
      return {
        metric: { source: name, label, count: 0, scanned: 0, latencyMs, ok: false, notice: `HTTP ${response.status}`, fallback: false },
        items: [],
      };
    }
    const payload = (await response.json()) as {
      items?: FeedItem[];
      count?: number;
      scanned?: number;
      notice?: string | null;
      fallback?: boolean;
    };
    const items = payload.items ?? [];
    return {
      metric: {
        source: name,
        label,
        count: items.length,
        scanned: payload.scanned ?? items.length,
        latencyMs,
        ok: true,
        notice: payload.notice ?? null,
        fallback: payload.fallback === true,
      },
      items,
    };
  } catch (error) {
    return {
      metric: {
        source: name,
        label,
        count: 0,
        scanned: 0,
        latencyMs: Date.now() - start,
        ok: false,
        notice: error instanceof Error ? error.message : "fetch failed",
        fallback: false,
      },
      items: [],
    };
  }
}

/** Simple URL fingerprint for deduplication */
function itemKey(item: FeedItem): string {
  if (item.url) {
    try {
      const u = new URL(item.url);
      return `${u.hostname}${u.pathname}`.toLowerCase().replace(/\/+$/, "");
    } catch {
      // fall through
    }
  }
  return item.title.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().slice(0, 80);
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const query = (url.searchParams.get("q") ?? "").trim();
  const limit = clampInt(url.searchParams.get("limit"), 10, 150, 60);
  const perSource = Math.max(10, Math.ceil(limit / 4));

  if (query.length === 0) {
    return NextResponse.json({ error: "missing q" }, { status: 400 });
  }

  const base = new URL(request.url);
  base.pathname = "";
  // Build absolute URLs for each sub-feed
  const origin = `${base.protocol}//${base.host}`;

  const fetchTasks: Array<{ name: string; label: string; url: string }> = [
    {
      name: "hackernews",
      label: "Open Web (HN)",
      url: `${origin}/api/feeds/hackernews?q=${encodeURIComponent(query)}&limit=${perSource}`,
    },
    {
      name: "reddit",
      label: "Community (Reddit)",
      url: `${origin}/api/feeds/reddit?q=${encodeURIComponent(query)}&sort=new&limit=${perSource}`,
    },
    {
      name: "gdelt",
      label: "News Monitor (GDELT)",
      url: `${origin}/api/feeds/gdelt?q=${encodeURIComponent(query)}&limit=${perSource}`,
    },
    {
      name: "pubmed",
      label: "Biomedical (PubMed)",
      url: `${origin}/api/feeds/pubmed?q=${encodeURIComponent(query)}&limit=${perSource}`,
    },
    {
      name: "who",
      label: "Health Alerts (WHO/CDC/ECDC)",
      url: `${origin}/api/feeds/who?q=${encodeURIComponent(query)}&limit=${perSource}`,
    },
  ];

  const results = await Promise.all(
    fetchTasks.map((task) => fetchSource(task.name, task.label, task.url)),
  );

  // Merge and deduplicate items by URL fingerprint
  const seen = new Set<string>();
  const merged: FeedItem[] = [];

  for (const result of results) {
    for (const item of result.items) {
      const key = itemKey(item);
      if (!seen.has(key)) {
        seen.add(key);
        merged.push(item);
      }
    }
  }

  // Sort by publish date descending, fallback to insertion order
  merged.sort((a, b) => {
    const ta = a.publishedAt ? new Date(a.publishedAt).getTime() : 0;
    const tb = b.publishedAt ? new Date(b.publishedAt).getTime() : 0;
    return tb - ta;
  });

  const finalItems = merged.slice(0, limit);
  const totalScanned = results.reduce((sum, r) => sum + r.metric.scanned, 0);

  const response: AllFeedsResponse = {
    query,
    count: finalItems.length,
    scanned: totalScanned,
    fetchedAt: new Date().toISOString(),
    sources: results.map((r) => r.metric),
    items: finalItems,
  };

  return NextResponse.json(response);
}
