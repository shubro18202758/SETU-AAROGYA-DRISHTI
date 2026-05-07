import { NextResponse } from "next/server";

import type { FeedItem } from "@/app/api/feeds/hackernews/route";
import { rankFeedItems, relevanceNotice } from "@/lib/feed-relevance";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface GdeltArticle {
  url?: string;
  title?: string;
  seendate?: string;
  domain?: string;
  language?: string;
  sourcecountry?: string;
}

interface GdeltResponse {
  articles?: GdeltArticle[];
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const query = (url.searchParams.get("q") ?? "adverse event OR vaccine OR outbreak").trim();
  const limit = clampInt(url.searchParams.get("limit"), 5, 75, 25);

  const endpoint = new URL("https://api.gdeltproject.org/api/v2/doc/doc");
  endpoint.searchParams.set("query", query);
  endpoint.searchParams.set("mode", "ArtList");
  endpoint.searchParams.set("format", "json");
  endpoint.searchParams.set("maxrecords", String(limit));
  endpoint.searchParams.set("sort", "DateDesc");
  // GDELT often returns 0 results without a timespan window. 24h keeps it fresh
  // while still hitting cached buckets reliably.
  endpoint.searchParams.set("timespan", "24h");

  try {
    const response = await fetch(endpoint.toString(), {
      headers: { accept: "application/json", "user-agent": "osint-os/0.1" },
      cache: "no-store",
      signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) {
      return NextResponse.json(localGdeltPayload(query, limit, `GDELT API ${response.status}`));
    }
    const text = await response.text();
    let payload: GdeltResponse;
    try {
      payload = JSON.parse(text) as GdeltResponse;
    } catch {
      return NextResponse.json(localGdeltPayload(query, limit, "GDELT returned non-JSON"));
    }
    const rawItems: FeedItem[] = (payload.articles ?? []).map((article, index) => ({
      id: `gdelt:${article.url ?? index}`,
      source: "gdelt",
      title: article.title ?? "(untitled)",
      url: article.url ?? null,
      author: article.domain ?? null,
      publishedAt: parseGdeltDate(article.seendate),
      score: null,
      comments: null,
      tags: [article.sourcecountry, article.language].filter((value): value is string => typeof value === "string" && value.length > 0),
    }));
    if (rawItems.length === 0) {
      return NextResponse.json(localGdeltPayload(query, limit, "GDELT returned no articles for this window"));
    }
    const items = rankFeedItems(rawItems, query, limit);
    return NextResponse.json({ source: "gdelt", query, count: items.length, scanned: rawItems.length, notice: relevanceNotice("GDELT", query, items.length), items });
  } catch (error) {
    return NextResponse.json(localGdeltPayload(query, limit, error instanceof Error ? error.message : "fetch failed"));
  }
}

function localGdeltPayload(query: string, limit: number, notice: string) {
  const items = buildLocalGdeltItems(query, limit);
  return {
    source: "gdelt" as const,
    query,
    count: items.length,
    fallback: true,
    notice: `Public GDELT unavailable (${notice}); using local analyst seed stream`,
    items,
  };
}

function buildLocalGdeltItems(query: string, limit: number): FeedItem[] {
  const queryTag = compactTag(query) || "watchlist";
  const slug = queryTag.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "watchlist";
  const now = Date.now();
  const templates = localTemplatesForQuery(queryTag);

  return templates.slice(0, Math.min(limit, templates.length)).map((template, index) => ({
    id: `gdelt:local:${slug}:${index}`,
    source: "gdelt",
    title: template.title,
    url: `https://api.gdeltproject.org/api/v2/doc/doc?mode=ArtList&format=html&query=${encodeURIComponent(query)}`,
    author: "local GDELT fallback",
    publishedAt: new Date(now - index * 15 * 60_000).toISOString(),
    score: null,
    comments: null,
    tags: [queryTag, "local-fallback", ...template.tags],
  }));
}

function localTemplatesForQuery(query: string): Array<{ title: string; tags: string[] }> {
  const lower = query.toLowerCase();
  if (/fever|rash|dizziness|symptom|hospital|admission|clinic|patient/.test(lower)) {
    return [
      { title: `${query}: symptom trend monitoring target for district media and public-health bulletin reporting`, tags: ["symptom-trend", "district", "bulletin"] },
      { title: `${query}: local collection gap queued for source diversity and clinical triage correlation`, tags: ["collection-gap", "clinical-review", "triage"] },
      { title: `${query}: patient-experience watch requires source corroboration before escalation`, tags: ["patient-experience", "corroboration"] },
    ];
  }
  if (/vaccine|drug|medicine|tablet|adverse|side effect|reaction|pvpi|icsr/.test(lower)) {
    return [
      { title: `${query}: adverse-event disproportionality watch for PRR, ROR, and IC review`, tags: ["adr", "prr", "ror"] },
      { title: `${query}: local collection gap queued for PvPI ICSR and source-history correlation`, tags: ["pvpi", "icsr", "correlation"] },
      { title: `${query}: medicine-safety signal requires clinical reviewer confirmation`, tags: ["medicine-safety", "clinical-review"] },
    ];
  }
  if (/misinformation|rumour|rumor|claim|home remedy|false|hoax/.test(lower)) {
    return [
      { title: `${query}: misinformation watch queued for claim, source, and language-pattern review`, tags: ["misinformation", "claim-review"] },
      { title: `${query}: local collection gap queued for repeated-claim and district spread analysis`, tags: ["claim-spread", "district"] },
      { title: `${query}: public communication review required before escalation`, tags: ["public-communication", "review"] },
    ];
  }
  return [
    { title: `${query}: local public-health collection target awaiting live source corroboration`, tags: ["collection-target", "public-health"] },
    { title: `${query}: source-diversity watch queued for media, audit, and district pivots`, tags: ["source-diversity", "audit"] },
    { title: `${query}: analyst review required before treating modeled signal as confirmed reporting`, tags: ["analyst-review", "provenance"] },
  ];
}

function compactTag(query: string): string {
  return query.replace(/\s+/g, " ").trim().slice(0, 48);
}

function parseGdeltDate(raw: string | undefined): string | null {
  if (typeof raw !== "string" || raw.length < 14) {
    return null;
  }
  // GDELT format: YYYYMMDDTHHMMSSZ
  const match = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(raw);
  if (!match) {
    return null;
  }
  const [, y, m, d, hh, mm, ss] = match;
  const iso = `${y}-${m}-${d}T${hh}:${mm}:${ss}Z`;
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
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
