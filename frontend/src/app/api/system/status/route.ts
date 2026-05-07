import { NextResponse } from "next/server";

export const runtime = "edge";

const PROBE_TIMEOUT_MS = 2500;

type ServiceKey = "backend" | "redpanda" | "arcadedb" | "llm";
type ServiceState = "online" | "degraded" | "offline";

interface ServiceProbeConfig {
  key: ServiceKey;
  name: string;
  url: string;
  onlineStatuses: number[];
  requiredModel?: string;
}

interface ServiceProbeResult {
  key: ServiceKey;
  name: string;
  state: ServiceState;
  detail: string;
  latencyMs: number | null;
  checkedAt: string;
}

export async function GET() {
  const apiBaseUrl = trimTrailingSlash(process.env.INTELLIGENCE_API_BASE_URL ?? process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:8000");
  const redpandaProxyUrl = trimTrailingSlash(process.env.REDPANDA_PROXY_URL ?? "http://localhost:18082");
  const arcadeDbUrl = trimTrailingSlash(process.env.ARCADEDB_URL ?? "http://localhost:2480");
  const ollamaBaseUrl = trimTrailingSlash(process.env.OLLAMA_BASE_URL ?? "http://localhost:11434");
  const qwenModel = "qwen3.5:4b-q4_K_M";
  const llmHealthUrl = process.env.LLM_HEALTH_URL ?? `${ollamaBaseUrl}/api/tags`;

  const probes: ServiceProbeConfig[] = [
    { key: "backend", name: "Intelligence API", url: `${apiBaseUrl}/healthz`, onlineStatuses: [200] },
    { key: "redpanda", name: "Redpanda", url: `${redpandaProxyUrl}/brokers`, onlineStatuses: [200] },
    { key: "arcadedb", name: "ArcadeDB", url: arcadeDbUrl, onlineStatuses: [200, 401, 403] },
    { key: "llm", name: "Qwen 3.5 4B", url: llmHealthUrl, onlineStatuses: [200], requiredModel: qwenModel },
  ];

  const services = await Promise.all(probes.map(probeService));
  const onlineCount = services.filter((service) => service.state === "online").length;
  const degradedCount = services.filter((service) => service.state === "degraded").length;
  const summaryState = onlineCount === services.length ? "online" : onlineCount === 0 && degradedCount === 0 ? "offline" : "degraded";

  return NextResponse.json({
    generatedAt: new Date().toISOString(),
    summary: {
      state: summaryState,
      online: onlineCount,
      degraded: degradedCount,
      total: services.length,
    },
    services,
  });
}

async function probeService(config: ServiceProbeConfig): Promise<ServiceProbeResult> {
  const startedAt = performance.now();
  const checkedAt = new Date().toISOString();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);

  try {
    const response = await fetch(config.url, {
      cache: "no-store",
      signal: controller.signal,
      headers: { accept: "application/json,text/plain,*/*" },
    });
    const latencyMs = Math.round(performance.now() - startedAt);
    const bodyText = await response.text().catch(() => "");
    const hasRequiredModel = config.requiredModel ? hasOllamaModel(bodyText, config.requiredModel) : true;
    const state = config.onlineStatuses.includes(response.status) && hasRequiredModel ? "online" : "degraded";
    return {
      key: config.key,
      name: config.name,
      state,
      detail: state === "online" ? describeOnlineService(config.key, bodyText, config.requiredModel) : describeDegradedService(config, response.status, response.statusText || "response", bodyText),
      latencyMs,
      checkedAt,
    };
  } catch {
    const state = config.key === "backend" ? "offline" : "degraded";
    return {
      key: config.key,
      name: config.name,
      state,
      detail: describeLocalFallback(config.key),
      latencyMs: 0,
      checkedAt,
    };
  } finally {
    clearTimeout(timeout);
  }
}

function describeLocalFallback(key: ServiceKey): string {
  if (key === "backend") {
    return "local · Next.js routes";
  }
  if (key === "redpanda") {
    return "local · in-browser event bus";
  }
  if (key === "arcadedb") {
    return "local · in-memory lead store";
  }
  return "local · Qwen unavailable, extractor will fall back";
}

function describeOnlineService(key: ServiceKey, bodyText: string, requiredModel?: string): string {
  if (key === "backend") {
    const payload = parseJsonObject(bodyText);
    const database = typeof payload?.database === "string" ? payload.database : "graph API";
    const model = typeof payload?.llm_model === "string" ? payload.llm_model : "local model";
    return `${database} via ${model}`;
  }
  if (key === "llm") {
    return requiredModel ? `Ollama ready · ${requiredModel}` : "Ollama ready";
  }
  if (key === "redpanda") {
    return "Kafka API reachable";
  }
  if (key === "arcadedb") {
    return "HTTP endpoint reachable";
  }
  return "health endpoint ready";
}

function describeDegradedService(config: ServiceProbeConfig, status: number, statusText: string, bodyText: string): string {
  if (config.key === "llm" && config.requiredModel && !hasOllamaModel(bodyText, config.requiredModel)) {
    return `Ollama reachable, missing ${config.requiredModel}`;
  }
  return `${status} ${statusText}`;
}

function hasOllamaModel(bodyText: string, model: string): boolean {
  const payload = parseJsonObject(bodyText);
  const models = Array.isArray(payload?.models) ? payload.models : [];
  return models.some((entry) => typeof entry === "object" && entry !== null && "name" in entry && (entry as { name?: unknown }).name === model);
}

function parseJsonObject(text: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(text) as unknown;
    return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}