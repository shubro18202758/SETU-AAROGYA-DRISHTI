import { NextResponse } from "next/server";

import type { FeedItem } from "@/app/api/feeds/hackernews/route";
import { rankFeedItems, relevanceNotice } from "@/lib/feed-relevance";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RedditChild {
  data?: {
    id?: string;
    title?: string;
    permalink?: string;
    url?: string;
    author?: string;
    subreddit?: string;
    score?: number;
    num_comments?: number;
    created_utc?: number;
    over_18?: boolean;
  };
}

interface RedditListing {
  data?: { children?: RedditChild[] };
}

const ALLOWED_SUB = /^[A-Za-z0-9_]{2,30}$/;

export async function GET(request: Request) {
  const url = new URL(request.url);
  const query = (url.searchParams.get("q") ?? "").trim();
  const subreddit = (url.searchParams.get("sub") ?? "worldnews").trim();
  const sort = (url.searchParams.get("sort") ?? "new").trim();
  const limit = clampInt(url.searchParams.get("limit"), 5, 50, 25);

  if (query.length === 0 && !ALLOWED_SUB.test(subreddit)) {
    return NextResponse.json({ error: "invalid subreddit", items: [] }, { status: 400 });
  }
  if (!["new", "hot", "top", "rising"].includes(sort)) {
    return NextResponse.json({ error: "invalid sort", items: [] }, { status: 400 });
  }

  const endpoint = query.length > 0
    ? `https://www.reddit.com/search.json?q=${encodeURIComponent(query)}&sort=${sort}&limit=${Math.min(100, Math.max(limit, limit * 4))}&raw_json=1&type=link`
    : `https://www.reddit.com/r/${subreddit}/${sort}.json?limit=${limit}&raw_json=1`;
  try {
    const response = await fetch(endpoint, {
      headers: { accept: "application/json", "user-agent": "osint-os/0.1 (local analyst console)" },
      cache: "no-store",
      signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) {
      return NextResponse.json({ error: `Reddit API ${response.status}`, items: [] }, { status: 502 });
    }
    const payload = (await response.json()) as RedditListing;
    const rawItems: FeedItem[] = (payload.data?.children ?? [])
      .map((child) => child.data)
      .filter((data): data is NonNullable<RedditChild["data"]> => Boolean(data && data.id && data.title))
      .filter((data) => !data.over_18)
      .map((data) => ({
        id: `reddit:${data.id}`,
        source: "reddit",
        title: data.title ?? "(untitled)",
        url: data.url ?? (data.permalink ? `https://www.reddit.com${data.permalink}` : null),
        author: data.author ? `u/${data.author}` : null,
        publishedAt: typeof data.created_utc === "number" ? new Date(data.created_utc * 1000).toISOString() : null,
        score: typeof data.score === "number" ? data.score : null,
        comments: typeof data.num_comments === "number" ? data.num_comments : null,
        tags: [`r/${data.subreddit ?? subreddit}`, sort],
      }));
    const items = query.length > 0 ? rankFeedItems(rawItems, query, limit) : rawItems.slice(0, limit);
    return NextResponse.json({
      source: "reddit",
      query: query || subreddit,
      subreddit: query.length > 0 ? null : subreddit,
      sort,
      count: items.length,
      scanned: rawItems.length,
      notice: query.length > 0 ? relevanceNotice("Reddit", query, items.length) : null,
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
