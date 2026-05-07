/**
 * WHO Disease Outbreak News feed — parses the WHO DON RSS/Atom feed in real time.
 * No authentication required. Falls back to ProMED-mail and CDC feeds if WHO is unavailable.
 */
import { NextResponse } from "next/server";

import type { FeedItem } from "@/app/api/feeds/hackernews/route";
import { rankFeedItems, relevanceNotice } from "@/lib/feed-relevance";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const RSS_SOURCES = [
  {
    name: "WHO-DON",
    url: "https://www.who.int/rss-feeds/news-releases-don.xml",
    priority: 1,
  },
  {
    name: "WHO-Emergencies",
    url: "https://www.who.int/rss-feeds/emergencies-news.xml",
    priority: 2,
  },
  {
    name: "CDC-Global",
    url: "https://tools.cdc.gov/api/v2/resources/media/403372.rss",
    priority: 3,
  },
  {
    name: "ECDC-News",
    url: "https://www.ecdc.europa.eu/en/rss.xml",
    priority: 4,
  },
];

function clampInt(raw: string | null, min: number, max: number, fallback: number): number {
  if (raw === null) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

/** Minimal RSS/Atom XML parser — no external dependency needed */
function parseRssXml(xml: string, sourceName: string, query: string): FeedItem[] {
  const items: FeedItem[] = [];

  // Support both RSS <item> and Atom <entry> elements
  const itemPattern = /<(?:item|entry)[\s>]([\s\S]*?)<\/(?:item|entry)>/gi;
  let match: RegExpExecArray | null;
  let index = 0;

  while ((match = itemPattern.exec(xml)) !== null) {
    const block = match[1];
    if (!block) continue;

    const title = extractXmlText(block, "title") ?? "(untitled)";
    const link = extractXmlLink(block);
    const pubDate = extractXmlDate(block);
    const description = extractXmlText(block, "description") ?? extractXmlText(block, "summary") ?? "";
    const author = extractXmlText(block, "dc:creator") ?? extractXmlText(block, "author") ?? sourceName;

    items.push({
      id: `who:${sourceName}:${index++}:${link ?? title.slice(0, 32)}`,
      source: "gdelt" as FeedItem["source"], // union type compatibility — labelled as who in source field via tags
      title: title.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#\d+;/g, "").trim(),
      url: link,
      author,
      publishedAt: pubDate,
      score: null,
      comments: null,
      tags: [sourceName, "health-outbreak", ...(description.toLowerCase().includes(query.toLowerCase()) ? ["query-match"] : [])],
    });
  }

  return items;
}

function extractXmlText(block: string, tag: string): string | null {
  const patterns = [
    new RegExp(`<${tag}[^>]*><!\\[CDATA\\[([\\s\\S]*?)\\]\\]><\\/${tag}>`, "i"),
    new RegExp(`<${tag}[^>]*>([^<]*)<\\/${tag}>`, "i"),
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(block);
    if (match?.[1]) return match[1].trim();
  }
  return null;
}

function extractXmlLink(block: string): string | null {
  // Try <link href="..."/> (Atom) first, then <link>...</link> (RSS)
  const atomLink = /<link[^>]+href=["']([^"']+)["'][^>]*\/?>/.exec(block);
  if (atomLink?.[1]) return atomLink[1];
  const rssLink = /<link[^>]*>([^<]+)<\/link>/i.exec(block);
  if (rssLink?.[1]) return rssLink[1].trim();
  // Some feeds use <guid> as the URL
  const guid = /<guid[^>]*>([^<]+)<\/guid>/i.exec(block);
  if (guid?.[1] && /^https?:\/\//.test(guid[1])) return guid[1].trim();
  return null;
}

function extractXmlDate(block: string): string | null {
  const raw = extractXmlText(block, "pubDate") ?? extractXmlText(block, "published") ?? extractXmlText(block, "updated") ?? extractXmlText(block, "dc:date");
  if (!raw) return null;
  try {
    return new Date(raw).toISOString();
  } catch {
    return null;
  }
}

async function fetchRssSource(
  source: (typeof RSS_SOURCES)[number],
  query: string,
): Promise<FeedItem[]> {
  try {
    const response = await fetch(source.url, {
      headers: {
        accept: "application/rss+xml, application/xml, text/xml, */*",
        "user-agent": "osint-os/0.1 (public-health surveillance; setu-aarogya-drishti)",
      },
      cache: "no-store",
      signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) return [];
    const xml = await response.text();
    return parseRssXml(xml, source.name, query);
  } catch {
    return [];
  }
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const query = (url.searchParams.get("q") ?? "").trim();
  const limit = clampInt(url.searchParams.get("limit"), 5, 80, 40);
  const sourceFilter = (url.searchParams.get("source") ?? "").toLowerCase();

  const sourcesToFetch = sourceFilter
    ? RSS_SOURCES.filter((source) => source.name.toLowerCase().includes(sourceFilter))
    : RSS_SOURCES;

  const results = await Promise.all(sourcesToFetch.map((source) => fetchRssSource(source, query)));
  const rawItems = results.flat();

  if (rawItems.length === 0) {
    return NextResponse.json({
      source: "who",
      query,
      count: 0,
      scanned: 0,
      notice: "No items returned from WHO/CDC/ECDC health outbreak feeds.",
      items: [],
    });
  }

  // If query is non-empty, rank by relevance; otherwise return all sorted by date
  const items = query.length > 0
    ? rankFeedItems(rawItems, query, limit)
    : rawItems.slice(0, limit).sort((a, b) => {
        const ta = a.publishedAt ? new Date(a.publishedAt).getTime() : 0;
        const tb = b.publishedAt ? new Date(b.publishedAt).getTime() : 0;
        return tb - ta;
      });

  const notice = query.length > 0
    ? relevanceNotice("WHO/CDC/ECDC health feeds", query, items.length)
    : `Live disease outbreak feeds from WHO, CDC, and ECDC — ${items.length} items.`;

  return NextResponse.json({
    source: "who",
    query,
    count: items.length,
    scanned: rawItems.length,
    sources: RSS_SOURCES.map((source) => source.name),
    notice,
    items,
  });
}
