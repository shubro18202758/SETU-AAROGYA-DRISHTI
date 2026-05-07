import { NextResponse, type NextRequest } from "next/server";

import { buildLocalGraphSearchPayload } from "@/lib/argus-prototype";

export const runtime = "edge";

interface SearchBody {
  query?: unknown;
}

export async function POST(request: NextRequest) {
  const body = (await request.json()) as SearchBody;
  const query = typeof body.query === "string" ? body.query.trim() : "";
  if (!query) {
    return NextResponse.json({ error: "query is required" }, { status: 400 });
  }

  const apiBaseUrl = process.env.INTELLIGENCE_API_BASE_URL ?? process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:8000";
  try {
    const response = await fetch(`${apiBaseUrl}/intelligence/graphrag`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query }),
      cache: "no-store",
    });

    const payload = (await response.json()) as unknown;
    if (!response.ok) {
      return NextResponse.json(buildLocalGraphSearchPayload(query));
    }
    return NextResponse.json(payload, { status: response.status });
  } catch {
    return NextResponse.json(buildLocalGraphSearchPayload(query));
  }
}
