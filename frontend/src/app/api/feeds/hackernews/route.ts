import { NextResponse } from "next/server";

import { rankFeedItems, relevanceNotice, type FeedRelevance } from "@/lib/feed-relevance";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface AlgoliaHit {
  objectID: string;
  title?: string | null;
  story_title?: string | null;
  url?: string | null;
  story_url?: string | null;
  author?: string | null;
  points?: number | null;
  num_comments?: number | null;
  created_at?: string | null;
  _tags?: string[] | null;
}

interface AlgoliaResponse {
  hits?: AlgoliaHit[];
}

export interface FeedItem {
  id: string;
  source: "hackernews" | "reddit" | "gdelt";
  title: string;
  url: string | null;
  author: string | null;
  publishedAt: string | null;
  score: number | null;
  comments: number | null;
  tags: string[];
  relevance?: FeedRelevance;
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const query = (url.searchParams.get("q") ?? "").trim();
  const tags = (url.searchParams.get("tags") ?? "story").trim();
  const limit = clampInt(url.searchParams.get("limit"), 5, 50, 20);

  const endpoint = new URL(query.length > 0 ? "https://hn.algolia.com/api/v1/search" : "https://hn.algolia.com/api/v1/search_by_date");
  if (query.length > 0) {
    endpoint.searchParams.set("query", query);
  }
  endpoint.searchParams.set("tags", tags);
  endpoint.searchParams.set("hitsPerPage", String(Math.min(100, Math.max(limit, limit * 4))));

  try {
    const response = await fetch(endpoint.toString(), {
      headers: { accept: "application/json" },
      cache: "no-store",
      signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) {
      return NextResponse.json({ error: `HackerNews API ${response.status}`, items: [] }, { status: 502 });
    }
    const payload = (await response.json()) as AlgoliaResponse;
    const rawItems: FeedItem[] = (payload.hits ?? []).map((hit) => ({
      id: `hn:${hit.objectID}`,
      source: "hackernews",
      title: hit.title ?? hit.story_title ?? "(untitled)",
      url: hit.url ?? hit.story_url ?? `https://news.ycombinator.com/item?id=${hit.objectID}`,
      author: hit.author ?? null,
      publishedAt: hit.created_at ?? null,
      score: typeof hit.points === "number" ? hit.points : null,
      comments: typeof hit.num_comments === "number" ? hit.num_comments : null,
      tags: hit._tags ?? [],
    }));
    const items = rankFeedItems(rawItems, query, limit);
    return NextResponse.json({
      source: "hackernews",
      query,
      count: items.length,
      scanned: rawItems.length,
      notice: relevanceNotice("HackerNews", query, items.length),
      items,
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "fetch failed", items: [] },
      { status: 502 },
    );
  }
}

function clampInt(raw: string | null, min: number, max: number, fallback: number): number {
  if (raw === null) {
    return fallback;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, parsed));
}
