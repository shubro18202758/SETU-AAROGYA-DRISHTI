import { NextResponse, type NextRequest } from "next/server";

import type { ConnectedEntity, ConnectedEntityKind } from "@/types/intelligence";

export const runtime = "edge";

const CONNECTED_ENTITY_TYPES = new Set<ConnectedEntityKind>(["ORG", "PERSON", "GEO"]);

interface ConnectedEntitiesRequest {
  canonicalName?: unknown;
  timestamp?: unknown;
}

interface GraphNodePayload {
  id?: unknown;
  entity_type?: unknown;
  confidence?: unknown;
  canonical_name?: unknown;
  last_updated?: unknown;
}

interface GraphRAGPayload {
  entities?: unknown;
}

export async function POST(request: NextRequest, context: { params: Promise<{ eventId: string }> }) {
  const { eventId } = await context.params;
  const body = (await request.json()) as ConnectedEntitiesRequest;
  const canonicalName = typeof body.canonicalName === "string" ? body.canonicalName.trim() : "";
  const timestamp = typeof body.timestamp === "string" ? body.timestamp.trim() : "";
  const apiBaseUrl = process.env.INTELLIGENCE_API_BASE_URL ?? process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:8000";

  const response = await fetch(`${apiBaseUrl}/intelligence/graphrag`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query: buildConnectedEntityQuery(eventId, canonicalName, timestamp) }),
    cache: "no-store",
  });

  const payload = (await response.json()) as GraphRAGPayload;
  if (!response.ok) {
    return NextResponse.json({ error: "Backend GraphRAG lookup failed." }, { status: response.status });
  }

  return NextResponse.json({ eventId, entities: parseConnectedEntities(payload) });
}

function buildConnectedEntityQuery(eventId: string, canonicalName: string, timestamp: string): string {
  const subject = canonicalName.length > 0 ? canonicalName : eventId;
  const timeHint = timestamp.length > 0 ? ` around ${timestamp}` : "";
  return `Connected ORG PERSON GEO entities associated with EVENT ${subject}${timeHint}`;
}

function parseConnectedEntities(payload: GraphRAGPayload): ConnectedEntity[] {
  if (!Array.isArray(payload.entities)) {
    return [];
  }
  return payload.entities.map(toConnectedEntity).filter((entity): entity is ConnectedEntity => entity !== null);
}

function toConnectedEntity(value: unknown): ConnectedEntity | null {
  if (!isRecord(value)) {
    return null;
  }
  const node = value as GraphNodePayload;
  const entityType = asConnectedEntityKind(node.entity_type);
  if (entityType === null) {
    return null;
  }
  const id = asString(node.id);
  const canonicalName = asString(node.canonical_name);
  if (id === null || canonicalName === null) {
    return null;
  }
  return {
    id,
    entityType,
    canonicalName,
    confidence: asNullableNumber(node.confidence),
    lastUpdated: asString(node.last_updated),
  };
}

function asConnectedEntityKind(value: unknown): ConnectedEntityKind | null {
  if (value === "ORG" || value === "PERSON" || value === "GEO") {
    return value;
  }
  return null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function asNullableNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
