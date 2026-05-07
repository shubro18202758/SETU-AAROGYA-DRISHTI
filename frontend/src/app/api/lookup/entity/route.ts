import { NextResponse } from "next/server";

import type { EntityKind } from "@/app/api/extract/entities/route";
import { buildLocalGeoGraphPayload, buildLocalGraphSearchPayload } from "@/lib/argus-prototype";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type SourceStatus = "hit" | "modeled" | "miss" | "error" | "scoped";

interface DossierSource {
  id: string;
  name: string;
  category: string;
  status: SourceStatus;
  confidence: number;
  title: string;
  description: string;
  url: string | null;
}

interface DossierMention {
  source: string;
  title: string;
  url: string | null;
  publishedAt: string | null;
  detail: string;
}

interface WikiSearchResponse {
  query?: { search?: Array<{ title?: string; snippet?: string }> };
}

interface WikiSummary {
  title?: string;
  description?: string;
  extract?: string;
  content_urls?: { desktop?: { page?: string } };
  thumbnail?: { source?: string };
  type?: string;
  coordinates?: { lat?: number; lon?: number };
}

interface WikidataResponse {
  search?: Array<{ id?: string; label?: string; description?: string; concepturi?: string }>;
}

interface GdeltResponse {
  articles?: Array<{ url?: string; title?: string; seendate?: string; domain?: string; sourcecountry?: string; language?: string }>;
}

interface CisaKevResponse {
  vulnerabilities?: Array<{ cveID?: string; vendorProject?: string; product?: string; vulnerabilityName?: string; shortDescription?: string; requiredAction?: string; dueDate?: string; knownRansomwareCampaignUse?: string }>;
}

interface NominatimResult {
  display_name?: string;
  type?: string;
  class?: string;
  lat?: string;
  lon?: string;
  importance?: number;
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const rawTerm = (url.searchParams.get("q") ?? "").trim();
  const kind = parseKind(url.searchParams.get("kind"));

  if (rawTerm.length === 0) {
    return NextResponse.json({ error: "missing q" }, { status: 400 });
  }
  if (rawTerm.length > 200) {
    return NextResponse.json({ error: "term too long" }, { status: 400 });
  }

  const normalized = normalizeEntityTerm(rawTerm);
  const [wiki, wikidata, gdelt, cisa, geo] = await Promise.all([
    lookupWikipedia(normalized, kind),
    lookupWikidata(normalized),
    lookupGdelt(normalized),
    lookupCisaKev(normalized, kind),
    lookupGeo(normalized, kind),
  ]);

  const localGraph = buildLocalGraphSearchPayload(normalized);
  const localGraphSource: DossierSource = {
    id: "local-argus-graph",
    name: "Local ARGUS graph",
    category: "entity graph",
    status: "modeled",
    confidence: 0.72,
    title: `${localGraph.entities.length} seeded entities / ${localGraph.relationships.length} relationships`,
    description: "Prototype graph context is generated locally so entity pivots work without Docker or a remote graph service.",
    url: "/graphrag",
  };

  const sources = [wiki.source, wikidata.source, gdelt.source, cisa.source, geo.source, localGraphSource].filter((source): source is DossierSource => source !== null);
  const mentions = [...gdelt.mentions, ...cisa.mentions, ...geo.mentions].slice(0, 8);
  const summary = chooseSummary(normalized, kind, sources, wiki.summary, wikidata.summary, gdelt.summary, cisa.summary, geo.summary);
  const hitCount = sources.filter((source) => source.status === "hit" || source.status === "modeled").length;
  const confidence = Math.min(94, Math.round(42 + hitCount * 8 + mentions.length * 2 + localGraph.relationships.length + (kind === "CVE" && cisa.source?.status === "hit" ? 12 : 0)));

  return NextResponse.json({
    found: true,
    term: rawTerm,
    normalized,
    kind,
    title: wiki.title ?? wikidata.title ?? normalized,
    summary,
    confidence,
    sourceCount: hitCount,
    generatedAt: new Date().toISOString(),
    sources,
    mentions,
    graph: {
      entities: localGraph.entities,
      relationships: localGraph.relationships,
    },
  });
}

async function lookupWikipedia(term: string, kind: EntityKind): Promise<{ source: DossierSource | null; summary: string | null; title: string | null }> {
  const exact = await fetchWikipediaSummary(term);
  if (exact !== null) {
    return wikiHit(exact, "Wikipedia summary");
  }

  // Standard search — falls through on any failure so EVENT background ref can run.
  try {
    const searchEndpoint = new URL("https://en.wikipedia.org/w/api.php");
    searchEndpoint.searchParams.set("action", "query");
    searchEndpoint.searchParams.set("list", "search");
    searchEndpoint.searchParams.set("format", "json");
    searchEndpoint.searchParams.set("srlimit", "3");
    searchEndpoint.searchParams.set("srsearch", term);
    const response = await fetch(searchEndpoint.toString(), {
      headers: { accept: "application/json", "user-agent": "osint-os/0.1 (local analyst console)" },
      cache: "no-store",
      signal: AbortSignal.timeout(7000),
    });
    if (response.ok) {
      const payload = (await response.json()) as WikiSearchResponse;
      const candidateTitle = payload.query?.search?.find((item) => typeof item.title === "string" && item.title.length > 0)?.title;
      if (candidateTitle !== undefined && isWikipediaCandidateRelevant(term, candidateTitle, kind)) {
        const candidateSummary = await fetchWikipediaSummary(candidateTitle);
        if (candidateSummary !== null) {
          return wikiHit(candidateSummary, "Wikipedia search match");
        }
      }
    }
  } catch {
    // search failed — fall through to background reference or MISS
  }

  // For EVENT entities, Wikipedia rarely has a page for recent breaking incidents.
  // Try a background-reference lookup on the key noun (e.g. the pathogen name) to give the analyst useful context.
  if (kind === "EVENT") {
    const noun = extractEventKeyNoun(term);
    if (noun !== null) {
      try {
        const nounSummary = await fetchWikipediaSummary(noun);
        if (nounSummary !== null) {
          const extract = nounSummary.extract ?? nounSummary.description ?? null;
          return {
            title: null,
            summary: extract,
            source: {
              id: "wikipedia",
              name: "Wikipedia",
              category: "encyclopedia",
              status: "hit",
              confidence: 0.55,
              title: `${nounSummary.title ?? noun} (background reference)`,
              description: extract?.slice(0, 240) ?? "Background reference for the key subject of this event.",
              url: nounSummary.content_urls?.desktop?.page ?? null,
            },
          };
        }
      } catch {
        // background reference lookup failed — not critical
      }
    }
  }

  return sourceMiss("wikipedia", "Wikipedia", "encyclopedia", "No article matched this entity or its key subject.");
}

async function fetchWikipediaSummary(term: string): Promise<WikiSummary | null> {
  const slug = encodeURIComponent(term.replace(/\s+/g, "_"));
  const endpoint = `https://en.wikipedia.org/api/rest_v1/page/summary/${slug}?redirect=true`;
  const response = await fetch(endpoint, {
    headers: { accept: "application/json", "user-agent": "osint-os/0.1 (local analyst console)" },
    cache: "no-store",
    signal: AbortSignal.timeout(7000),
  });
  if (!response.ok) {
    return null;
  }
  const payload = (await response.json()) as WikiSummary;
  if (payload.type === "https://mediawiki.org/wiki/HyperSwitch/errors/not_found") {
    return null;
  }
  return payload;
}

function wikiHit(payload: WikiSummary, sourceName: string) {
  const summary = payload.extract ?? payload.description ?? null;
  return {
    title: payload.title ?? null,
    summary,
    source: {
      id: "wikipedia",
      name: sourceName,
      category: "encyclopedia",
      status: "hit" as const,
      confidence: 0.74,
      title: payload.title ?? "Wikipedia match",
      description: summary ?? "Matched an encyclopedia page but no extract was supplied.",
      url: payload.content_urls?.desktop?.page ?? null,
    },
  };
}

async function lookupWikidata(term: string): Promise<{ source: DossierSource | null; summary: string | null; title: string | null }> {
  try {
    const endpoint = new URL("https://www.wikidata.org/w/api.php");
    endpoint.searchParams.set("action", "wbsearchentities");
    endpoint.searchParams.set("language", "en");
    endpoint.searchParams.set("format", "json");
    endpoint.searchParams.set("limit", "5");
    endpoint.searchParams.set("search", term);
    const response = await fetch(endpoint.toString(), {
      headers: { accept: "application/json", "user-agent": "osint-os/0.1 (local analyst console)" },
      cache: "no-store",
      signal: AbortSignal.timeout(7000),
    });
    if (!response.ok) {
      return sourceMiss("wikidata", "Wikidata", "knowledge graph", `Wikidata returned ${response.status}`);
    }
    const payload = (await response.json()) as WikidataResponse;
    const match = payload.search?.find((item) => typeof item.label === "string" && item.label.length > 0);
    if (match === undefined) {
      return sourceMiss("wikidata", "Wikidata", "knowledge graph", "No knowledge graph entity matched the term.");
    }
    const description = match.description ?? "Knowledge graph entity matched without a public description.";
    return {
      title: match.label ?? null,
      summary: description,
      source: {
        id: "wikidata",
        name: "Wikidata",
        category: "knowledge graph",
        status: "hit",
        confidence: 0.7,
        title: `${match.label ?? term}${match.id ? ` (${match.id})` : ""}`,
        description,
        url: match.concepturi ?? (match.id ? `https://www.wikidata.org/wiki/${match.id}` : null),
      },
    };
  } catch (error) {
    return sourceError("wikidata", "Wikidata", "knowledge graph", error);
  }
}

async function lookupGdelt(term: string): Promise<{ source: DossierSource | null; summary: string | null; mentions: DossierMention[] }> {
  // Try the full term first, then fall back to simplified key terms (handles rate-limits and zero-result long names).
  const primary = await tryGdeltQuery(term, term);
  if (primary !== null) return primary;
  const simplified = simplifyEventQuery(term);
  if (simplified.length >= 4 && simplified.toLowerCase() !== term.toLowerCase().trim()) {
    const retry = await tryGdeltQuery(simplified, term);
    if (retry !== null) return retry;
  }
  return gdeltModeled(term, "No recent GDELT article matched this entity or its key terms.");
}

async function tryGdeltQuery(query: string, displayTerm: string): Promise<{ source: DossierSource; summary: string; mentions: DossierMention[] } | null> {
  try {
    const endpoint = new URL("https://api.gdeltproject.org/api/v2/doc/doc");
    endpoint.searchParams.set("query", query);
    endpoint.searchParams.set("mode", "ArtList");
    endpoint.searchParams.set("format", "json");
    endpoint.searchParams.set("maxrecords", "6");
    endpoint.searchParams.set("sort", "DateDesc");
    endpoint.searchParams.set("timespan", "30d");
    const response = await fetch(endpoint.toString(), {
      headers: { accept: "application/json", "user-agent": "osint-os/0.1 (local analyst console)" },
      cache: "no-store",
      signal: AbortSignal.timeout(7000),
    });
    if (!response.ok) return null;
    const payload = (await response.json()) as GdeltResponse;
    const articles = (payload.articles ?? []).filter((article) => typeof article.title === "string" && article.title.length > 0);
    if (articles.length === 0) return null;
    const mentions: DossierMention[] = articles.map((article) => ({
      source: article.domain ?? "GDELT",
      title: article.title ?? displayTerm,
      url: article.url ?? null,
      publishedAt: parseGdeltDate(article.seendate),
      detail: [article.sourcecountry, article.language].filter((value): value is string => typeof value === "string" && value.length > 0).join(" · ") || "GDELT article mention",
    }));
    return {
      summary: `${articles.length} recent GDELT article${articles.length === 1 ? "" : "s"} mention this entity or phrase.`,
      mentions,
      source: {
        id: "gdelt",
        name: "GDELT 2.0",
        category: "event stream",
        status: "hit",
        confidence: 0.68,
        title: `${articles.length} media mention${articles.length === 1 ? "" : "s"}`,
        description: "Global media stream used for event, theme, location, and tone corroboration.",
        url: `https://api.gdeltproject.org/api/v2/doc/doc?mode=ArtList&format=html&query=${encodeURIComponent(query)}`,
      },
    };
  } catch {
    return null;
  }
}

function simplifyEventQuery(term: string): string {
  return term
    .replace(/\b\d{4}\b/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .split(/\s+/)
    .filter((w) => w.length >= 4 && !/^(Cruise|Ferry|Vessel|Tanker|Freighter|Incident|Operation|Emergency|Attack|Crisis|Outbreak|Ship)$/i.test(w))
    .slice(0, 5)
    .join(" ");
}

function extractEventKeyNoun(term: string): string | null {
  const knownCauses = ["Hantavirus", "Ebola", "Mpox", "Covid-19", "SARS-CoV-2", "SARS", "MERS", "Influenza", "Cholera", "Plague", "Anthrax", "Marburg", "Lassa", "Nipah", "Dengue", "Zika", "Norovirus", "Measles", "Tuberculosis", "Typhoid", "Monkeypox"];
  for (const cause of knownCauses) {
    if (term.toLowerCase().includes(cause.toLowerCase())) return cause;
  }
  const tokens = term
    .replace(/\b\d{4}\b/g, "")
    .split(/\s+/)
    .filter((w) => w.length >= 5 && !/^(Cruise|Vessel|Tanker|Outbreak|Incident|Attack|Crisis|Operation|Emergency|Event|Major|Ship|Ferry)$/i.test(w));
  return tokens[0] ?? null;
}

function gdeltModeled(term: string, reason: string): { source: DossierSource; summary: string; mentions: DossierMention[] } {
  return {
    summary: `No live GDELT hit was available, so ARGUS keeps ${term} as a modeled collection target for follow-up media monitoring.`,
    mentions: [{ source: "local GDELT model", title: `${term} media watch`, url: null, publishedAt: new Date().toISOString(), detail: reason }],
    source: {
      id: "gdelt",
      name: "GDELT 2.0",
      category: "event stream",
      status: "modeled",
      confidence: 0.52,
      title: "Media watch target",
      description: reason,
      url: `https://api.gdeltproject.org/api/v2/doc/doc?mode=ArtList&format=html&query=${encodeURIComponent(term)}`,
    },
  };
}

async function lookupCisaKev(term: string, kind: EntityKind): Promise<{ source: DossierSource | null; summary: string | null; mentions: DossierMention[] }> {
  if (kind !== "CVE" && !/^CVE-\d{4}-\d{4,7}$/i.test(term)) {
    return {
      summary: null,
      mentions: [],
      source: {
        id: "cisa-kev",
        name: "CISA KEV / STIX lane",
        category: "threat intel",
        status: "scoped",
        confidence: 0.5,
        title: "Cyber lane available",
        description: "This lane is activated for CVEs, exploited vulnerabilities, indicators, and structured threat-intelligence objects.",
        url: "https://www.cisa.gov/known-exploited-vulnerabilities-catalog",
      },
    };
  }

  try {
    const response = await fetch("https://www.cisa.gov/sites/default/files/feeds/known_exploited_vulnerabilities.json", {
      headers: { accept: "application/json", "user-agent": "osint-os/0.1 (local analyst console)" },
      cache: "no-store",
      signal: AbortSignal.timeout(7000),
    });
    if (!response.ok) {
      return sourceMissWithMentions("cisa-kev", "CISA KEV", "threat intel", `CISA KEV returned ${response.status}`);
    }
    const payload = (await response.json()) as CisaKevResponse;
    const cve = term.toUpperCase();
    const match = payload.vulnerabilities?.find((item) => item.cveID?.toUpperCase() === cve);
    if (match === undefined) {
      return sourceMissWithMentions("cisa-kev", "CISA KEV", "threat intel", `${cve} is not listed in the known exploited vulnerabilities catalog.`);
    }
    const description = match.shortDescription ?? match.vulnerabilityName ?? `${cve} appears in the KEV catalog.`;
    return {
      summary: description,
      mentions: [{ source: "CISA KEV", title: `${match.cveID}: ${match.vulnerabilityName ?? "known exploited vulnerability"}`, url: "https://www.cisa.gov/known-exploited-vulnerabilities-catalog", publishedAt: match.dueDate ?? null, detail: match.requiredAction ?? "Review CISA KEV remediation guidance." }],
      source: {
        id: "cisa-kev",
        name: "CISA KEV",
        category: "threat intel",
        status: "hit",
        confidence: 0.86,
        title: `${match.vendorProject ?? "Unknown vendor"} · ${match.product ?? "unknown product"}`,
        description,
        url: "https://www.cisa.gov/known-exploited-vulnerabilities-catalog",
      },
    };
  } catch (error) {
    return sourceErrorWithMentions("cisa-kev", "CISA KEV", "threat intel", error);
  }
}

async function lookupGeo(term: string, kind: EntityKind): Promise<{ source: DossierSource | null; summary: string | null; mentions: DossierMention[] }> {
  const localGeo = buildLocalGeoGraphPayload(5000);
  const localMatch = localGeo.locations.find((location) => location.canonical_name.toLowerCase() === term.toLowerCase());
  if (localMatch !== undefined) {
    return {
      summary: `${localMatch.canonical_name} is plotted in the local ARGUS GEO graph with ${localGeo.relationships.length} relationship arcs available for map correlation.`,
      mentions: [{ source: "local GEO graph", title: localMatch.canonical_name, url: "/database", publishedAt: localMatch.last_updated, detail: `${localMatch.latitude}, ${localMatch.longitude}` }],
      source: {
        id: "local-geo",
        name: "Local GEO graph",
        category: "geospatial",
        status: "hit",
        confidence: localMatch.confidence,
        title: `${localMatch.latitude}, ${localMatch.longitude}`,
        description: "Resolved locally from the ARGUS prototype graph seed used by the globe and GEO metrics.",
        url: "/database",
      },
    };
  }
  if (kind !== "GEO") {
    return {
      summary: null,
      mentions: [],
      source: {
        id: "geo-resolver",
        name: "Geospatial resolver",
        category: "geospatial",
        status: "scoped",
        confidence: 0.5,
        title: "GEO lane available",
        description: "This lane resolves places into coordinates and links them to mapped graph relationships when the entity is a location.",
        url: null,
      },
    };
  }

  try {
    const endpoint = new URL("https://nominatim.openstreetmap.org/search");
    endpoint.searchParams.set("format", "jsonv2");
    endpoint.searchParams.set("limit", "3");
    endpoint.searchParams.set("q", term);
    const response = await fetch(endpoint.toString(), {
      headers: { accept: "application/json", "user-agent": "osint-os/0.1 (local analyst console)" },
      cache: "no-store",
      signal: AbortSignal.timeout(7000),
    });
    if (!response.ok) {
      return sourceMissWithMentions("geo-resolver", "OpenStreetMap Nominatim", "geospatial", `Nominatim returned ${response.status}`);
    }
    const payload = (await response.json()) as NominatimResult[];
    const match = payload.find((item) => typeof item.display_name === "string" && item.display_name.length > 0);
    if (match === undefined) {
      return sourceMissWithMentions("geo-resolver", "OpenStreetMap Nominatim", "geospatial", "No geocoding result matched this place name.");
    }
    const coordinates = [match.lat, match.lon].filter((value): value is string => typeof value === "string").join(", ");
    return {
      summary: `${term} geocoded as ${match.display_name}.`,
      mentions: [{ source: "OpenStreetMap", title: match.display_name ?? term, url: `https://www.openstreetmap.org/search?query=${encodeURIComponent(term)}`, publishedAt: null, detail: coordinates || "geocoded location" }],
      source: {
        id: "geo-resolver",
        name: "OpenStreetMap Nominatim",
        category: "geospatial",
        status: "hit",
        confidence: Math.min(0.82, Math.max(0.55, match.importance ?? 0.62)),
        title: match.display_name ?? term,
        description: `${match.class ?? "place"}${match.type ? ` · ${match.type}` : ""}${coordinates ? ` · ${coordinates}` : ""}`,
        url: `https://www.openstreetmap.org/search?query=${encodeURIComponent(term)}`,
      },
    };
  } catch (error) {
    return sourceErrorWithMentions("geo-resolver", "OpenStreetMap Nominatim", "geospatial", error);
  }
}

function chooseSummary(term: string, kind: EntityKind, sources: DossierSource[], ...candidates: Array<string | null>): string {
  const first = candidates.find((candidate) => typeof candidate === "string" && candidate.trim().length > 0);
  if (first !== undefined && first !== null) {
    return first;
  }
  // For EVENT entities with no source-derived summary, synthesize a useful incident description.
  if (kind === "EVENT") {
    return synthesizeEventSummary(term);
  }
  const activeSources = sources.filter((source) => source.status === "hit" || source.status === "modeled").map((source) => source.name).join(", ");
  return `${term} is tracked as ${kindLabel(kind)} in the local ARGUS prototype. The dossier combines ${activeSources || "local graph context"} with provenance notes so the entity remains actionable even when one public source has no exact page.`;
}

function synthesizeEventSummary(term: string): string {
  const yearMatch = /\b(\d{4})\b/.exec(term);
  const year = yearMatch?.[1] ?? null;
  const hasShip = /\b(cruise|ship|vessel|ferry|tanker|freighter)\b/i.test(term);
  const hasOutbreak = /\b(outbreak|epidemic|pandemic|spread|infection|disease)\b/i.test(term);
  const noun = extractEventKeyNoun(term);
  if (year !== null && noun !== null) {
    if (hasShip && hasOutbreak) {
      return `The ${term} is a ${year} maritime disease event. ARGUS is monitoring open-source media channels for coverage and will surface reporting as articles index in GDELT.`;
    }
    if (hasOutbreak) {
      return `The ${term} is a ${year} disease event. ARGUS is tracking news channels and will surface reporting as it becomes available.`;
    }
    return `The ${term} is a ${year} incident. ARGUS is monitoring open-source media for reporting on this event.`;
  }
  return `${term} is an active intelligence collection target. ARGUS is monitoring available open-source channels for related reporting.`;
}

function normalizeEntityTerm(raw: string): string {
  let term = raw
    .replace(/[’]/g, "'")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^(Ask|Show|Tell|Launch)\s+HN:\s*/i, "")
    .replace(/^(Analyzing|Major|Critical|Every|Spread|Birth of|The)\s+/i, "")
    .replace(/\b(?:Leak|Leaks|Leaked|Takedown Requests|Us About)\b.*$/i, "")
    .replace(/'s\b/g, "")
    .trim();
  if (term.length < 3) {
    term = raw.replace(/[’']/g, "").trim();
  }
  return term || raw;
}

function isWikipediaCandidateRelevant(term: string, candidateTitle: string, kind: EntityKind): boolean {
  const termTokens = keyTokens(term);
  const titleTokens = new Set(keyTokens(candidateTitle));
  if (termTokens.length === 0) {
    return true;
  }
  if (kind === "EVENT" || termTokens.length >= 2) {
    return termTokens.every((token) => titleTokens.has(token));
  }
  return titleTokens.has(termTokens[0] ?? "");
}

function keyTokens(value: string): string[] {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9\s.-]/g, " ")
    .split(/[\s.-]+/)
    .filter((token) => token.length > 2 && !new Set(["the", "and", "for", "with", "from", "about", "code", "data"]).has(token));
}

function parseKind(value: string | null): EntityKind {
  if (value === "PERSON" || value === "ORG" || value === "GEO" || value === "URL" || value === "IP" || value === "EMAIL" || value === "HASH" || value === "MONEY" || value === "DATE" || value === "CVE" || value === "EVENT") {
    return value;
  }
  return "ORG";
}

function sourceMiss(id: string, name: string, category: string, description: string) {
  return { title: null, summary: null, source: { id, name, category, status: "miss" as const, confidence: 0.2, title: "No exact hit", description, url: null } };
}

function sourceError(id: string, name: string, category: string, error: unknown) {
  return { title: null, summary: null, source: { id, name, category, status: "error" as const, confidence: 0.1, title: "Lookup error", description: error instanceof Error ? error.message : "Lookup failed", url: null } };
}

function sourceMissWithMentions(id: string, name: string, category: string, description: string) {
  return { summary: null, mentions: [], source: { id, name, category, status: "miss" as const, confidence: 0.2, title: "No exact hit", description, url: null } };
}

function sourceErrorWithMentions(id: string, name: string, category: string, error: unknown) {
  return { summary: null, mentions: [], source: { id, name, category, status: "error" as const, confidence: 0.1, title: "Lookup error", description: error instanceof Error ? error.message : "Lookup failed", url: null } };
}

function kindLabel(kind: EntityKind): string {
  if (kind === "ORG") return "an organization or product/entity cluster";
  if (kind === "PERSON") return "a person or named actor";
  if (kind === "GEO") return "a place or geography";
  if (kind === "CVE") return "a vulnerability identifier";
  if (kind === "EVENT") return "an event or incident cluster";
  return `a ${kind.toLowerCase()} artifact`;
}

function parseGdeltDate(raw: string | undefined): string | null {
  if (typeof raw !== "string" || raw.length < 14) {
    return null;
  }
  const match = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(raw);
  if (!match) {
    return null;
  }
  const [, y, m, d, hh, mm, ss] = match;
  const date = new Date(`${y}-${m}-${d}T${hh}:${mm}:${ss}Z`);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}