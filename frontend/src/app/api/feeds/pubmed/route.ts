/**
 * PubMed / NCBI Entrez feed — real live crawling using the free NCBI E-utilities API.
 * No API key required for up to 3 requests/second (no key) or 10/s (with key).
 * Searches PubMed for relevant biomedical literature related to the query.
 */
import { NextResponse } from "next/server";

import type { FeedItem } from "@/app/api/feeds/hackernews/route";
import { rankFeedItems, relevanceNotice } from "@/lib/feed-relevance";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NCBI_BASE = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils";
const NCBI_API_KEY = process.env.NCBI_API_KEY ?? "";

interface ESearchResult {
  esearchresult?: {
    idlist?: string[];
    count?: string;
  };
}

interface ESummaryResultInner {
  uids?: string[];
  [key: string]: EDocSummary | string[] | undefined;
}

interface ESummaryResult {
  result?: ESummaryResultInner;
}

interface EDocSummary {
  uid?: string;
  title?: string;
  sortpubdate?: string;
  fulljournalname?: string;
  authors?: Array<{ name?: string }>;
  doi?: string;
  pubtype?: string[];
  source?: string;
}

function clampInt(raw: string | null, min: number, max: number, fallback: number): number {
  if (raw === null) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const query = (url.searchParams.get("q") ?? "").trim();
  const limit = clampInt(url.searchParams.get("limit"), 5, 50, 20);

  if (query.length === 0) {
    return NextResponse.json({ error: "missing q", items: [] }, { status: 400 });
  }

  const keyParam = NCBI_API_KEY ? `&api_key=${encodeURIComponent(NCBI_API_KEY)}` : "";
  // Build a health-intelligence focused PubMed query
  const pubmedQuery = `${query}[All Fields] AND ("last 90 days"[PDat] OR "last year"[PDat])`;

  try {
    // Step 1: ESearch — get IDs for recent relevant articles
    const searchUrl = `${NCBI_BASE}/esearch.fcgi?db=pubmed&term=${encodeURIComponent(pubmedQuery)}&retmax=${limit * 2}&retmode=json&sort=date${keyParam}`;
    const searchResponse = await fetch(searchUrl, {
      headers: { "user-agent": "osint-os/0.1 (public-health surveillance)" },
      cache: "no-store",
      signal: AbortSignal.timeout(10000),
    });

    if (!searchResponse.ok) {
      return NextResponse.json({ source: "pubmed", query, count: 0, error: `PubMed ESearch ${searchResponse.status}`, items: [] }, { status: 502 });
    }

    const searchData = (await searchResponse.json()) as ESearchResult;
    const ids = searchData.esearchresult?.idlist ?? [];

    if (ids.length === 0) {
      return NextResponse.json({
        source: "pubmed",
        query,
        count: 0,
        scanned: 0,
        notice: `No PubMed articles found for "${query}" in the last year.`,
        items: [],
      });
    }

    // Step 2: ESummary — get article metadata for the IDs
    const summaryUrl = `${NCBI_BASE}/esummary.fcgi?db=pubmed&id=${ids.join(",")}&retmode=json${keyParam}`;
    const summaryResponse = await fetch(summaryUrl, {
      headers: { "user-agent": "osint-os/0.1 (public-health surveillance)" },
      cache: "no-store",
      signal: AbortSignal.timeout(10000),
    });

    if (!summaryResponse.ok) {
      return NextResponse.json({ source: "pubmed", query, count: 0, error: `PubMed ESummary ${summaryResponse.status}`, items: [] }, { status: 502 });
    }

    const summaryData = (await summaryResponse.json()) as ESummaryResult;
    const result = summaryData.result ?? {};
    const uids: string[] = (result.uids as string[] | undefined) ?? ids;

    const rawItems: FeedItem[] = uids
      .map((uid) => result[uid] as EDocSummary | undefined)
      .filter((doc): doc is EDocSummary => Boolean(doc && typeof doc === "object" && "uid" in doc))
      .map((doc) => {
        const pmid = doc.uid ?? "";
        const firstAuthor = doc.authors?.[0]?.name ?? null;
        const journal = doc.fulljournalname ?? doc.source ?? null;
        const pubDate = doc.sortpubdate ? new Date(doc.sortpubdate).toISOString() : null;
        const doi = doc.doi;
        const articleUrl = doi
          ? `https://doi.org/${doi}`
          : `https://pubmed.ncbi.nlm.nih.gov/${pmid}/`;

        return {
          id: `pubmed:${pmid}`,
          source: "pubmed" as unknown as "gdelt", // satisfy union type — mapped later
          title: doc.title ?? "(untitled)",
          url: articleUrl,
          author: firstAuthor,
          publishedAt: pubDate,
          score: null,
          comments: null,
          tags: [
            journal ?? "pubmed",
            ...(doc.pubtype?.slice(0, 2) ?? []),
          ].filter(Boolean),
        } satisfies FeedItem;
      });

    const items = rankFeedItems(rawItems, query, limit);
    return NextResponse.json({
      source: "pubmed",
      query,
      count: items.length,
      scanned: rawItems.length,
      totalFound: searchData.esearchresult?.count ?? rawItems.length,
      notice: relevanceNotice("PubMed", query, items.length),
      items,
    });
  } catch (error) {
    return NextResponse.json(
      { source: "pubmed", query, count: 0, error: error instanceof Error ? error.message : "fetch failed", items: [] },
      { status: 502 },
    );
  }
}
