import { NextResponse, type NextRequest } from "next/server";

export const runtime = "edge";

const BACKEND_BASE_URL =
  process.env.INTELLIGENCE_API_BASE_URL ?? process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:8000";

const FORWARD_HEADERS = ["accept", "content-type", "authorization"] as const;

async function proxy(
  request: NextRequest,
  context: { params: Promise<{ path?: string[] }> },
): Promise<NextResponse> {
  const { path = [] } = await context.params;
  const search = request.nextUrl.search;
  const targetUrl = `${BACKEND_BASE_URL}/api/setu/${path.join("/")}${search}`;

  const headers = new Headers();
  for (const name of FORWARD_HEADERS) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }

  const init: RequestInit = {
    method: request.method,
    headers,
    cache: "no-store",
  };

  if (request.method !== "GET" && request.method !== "HEAD" && request.method !== "DELETE") {
    init.body = await request.text();
  }

  try {
    const response = await fetch(targetUrl, init);
    if (response.status === 204) {
      return new NextResponse(null, { status: 204 });
    }
    const text = await response.text();
    const responseHeaders = new Headers();
    const ct = response.headers.get("content-type");
    if (ct) responseHeaders.set("content-type", ct);
    return new NextResponse(text, { status: response.status, headers: responseHeaders });
  } catch (error) {
    return NextResponse.json(
      { detail: "setu_proxy_unreachable", message: error instanceof Error ? error.message : "unknown" },
      { status: 502 },
    );
  }
}

export const GET = proxy;
export const POST = proxy;
export const PATCH = proxy;
export const PUT = proxy;
export const DELETE = proxy;
