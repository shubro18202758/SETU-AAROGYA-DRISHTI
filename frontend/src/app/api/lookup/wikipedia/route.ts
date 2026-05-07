import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface WikiSummary {
  title?: string;
  description?: string;
  extract?: string;
  content_urls?: { desktop?: { page?: string } };
  thumbnail?: { source?: string };
  type?: string;
  coordinates?: { lat?: number; lon?: number };
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const term = (url.searchParams.get("q") ?? "").trim();
  if (term.length === 0) {
    return NextResponse.json({ error: "missing q" }, { status: 400 });
  }
  if (term.length > 200) {
    return NextResponse.json({ error: "term too long" }, { status: 400 });
  }

  const slug = encodeURIComponent(term.replace(/\s+/g, "_"));
  const endpoint = `https://en.wikipedia.org/api/rest_v1/page/summary/${slug}?redirect=true`;

  try {
    const response = await fetch(endpoint, {
      headers: { accept: "application/json", "user-agent": "osint-os/0.1 (local analyst console)" },
      cache: "no-store",
      signal: AbortSignal.timeout(8000),
    });
    if (response.status === 404) {
      return NextResponse.json({ found: false, term }, { status: 404 });
    }
    if (!response.ok) {
      return NextResponse.json({ error: `Wikipedia ${response.status}`, found: false }, { status: 502 });
    }
    const payload = (await response.json()) as WikiSummary;
    return NextResponse.json({
      found: true,
      term,
      title: payload.title ?? term,
      description: payload.description ?? null,
      extract: payload.extract ?? null,
      type: payload.type ?? null,
      url: payload.content_urls?.desktop?.page ?? null,
      thumbnail: payload.thumbnail?.source ?? null,
      coordinates: payload.coordinates && typeof payload.coordinates.lat === "number" && typeof payload.coordinates.lon === "number"
        ? { lat: payload.coordinates.lat, lon: payload.coordinates.lon }
        : null,
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "fetch failed", found: false },
      { status: 502 },
    );
  }
}
