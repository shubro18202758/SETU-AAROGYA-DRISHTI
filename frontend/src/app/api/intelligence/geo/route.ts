import { NextResponse, type NextRequest } from "next/server";

import { buildLocalGeoGraphPayload } from "@/lib/argus-prototype";

export const runtime = "edge";

export async function GET(request: NextRequest) {
  const limit = request.nextUrl.searchParams.get("limit") ?? "5000";
  const parsedLimit = Number(limit) || 5000;
  const apiBaseUrl = process.env.INTELLIGENCE_API_BASE_URL ?? process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:8000";
  try {
    const response = await fetch(`${apiBaseUrl}/intelligence/geo?limit=${encodeURIComponent(limit)}`, {
      method: "GET",
      headers: { accept: "application/json" },
      cache: "no-store",
    });

    const payload = (await response.json()) as unknown;
    if (!response.ok) {
      return NextResponse.json(buildLocalGeoGraphPayload(parsedLimit));
    }
    return NextResponse.json(payload, { status: response.status });
  } catch {
    return NextResponse.json(buildLocalGeoGraphPayload(parsedLimit));
  }
}
