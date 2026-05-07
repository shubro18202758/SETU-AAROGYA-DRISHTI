import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export type EntityKind = "PERSON" | "ORG" | "GEO" | "EVENT" | "URL" | "IP" | "EMAIL" | "HASH" | "MONEY" | "DATE" | "CVE";
type CoreEntityKind = Extract<EntityKind, "PERSON" | "ORG" | "GEO" | "EVENT">;

export interface ExtractedEntity {
  kind: EntityKind;
  value: string;
  count: number;
  confidence?: number;
}

interface ExtractedRelationship {
  source: string;
  target: string;
  confidence: number;
  validFrom: string;
  evidenceText: string;
}

interface RequestBody {
  text?: string;
  /** Optional search query — used to seed contextually relevant entities before processing feed text */
  query?: string;
}

const QWEN_MODEL = "qwen3.5:4b-q4_K_M";
const OLLAMA_BASE_URL = (process.env.OLLAMA_BASE_URL ?? "http://localhost:11434").replace(/\/+$/, "");
const QWEN_TIMEOUT_MS = Number(process.env.QWEN_EXTRACT_TIMEOUT_MS ?? 12_000);
const QWEN_MAX_CHARS = Number(process.env.QWEN_EXTRACT_MAX_CHARS ?? 18_000);
const CORE_ENTITY_KINDS = new Set<CoreEntityKind>(["ORG", "PERSON", "GEO", "EVENT"]);

const STOPWORDS = new Set([
  "The", "This", "That", "These", "Those", "There", "Then", "They", "Their", "And", "But", "For", "With", "From", "About",
  "Into", "Over", "Under", "After", "Before", "While", "When", "Where", "What", "Which", "Who", "How", "Why", "Today",
  "Yesterday", "Tomorrow", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday", "January",
  "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December",
  "New", "Old", "Update", "News", "Report", "Reuters", "AP", "BBC", "CNN", "Said", "Says", "Will", "Was", "Were",
  "Easily", "Security", "Compliance", "Potential", "Open-source", "AI-driven", "SAST",
]);

const ORG_SUFFIXES = /(Inc\.?|Incorporated|Corp\.?|Corporation|Ltd\.?|Limited|LLC|GmbH|AG|SA|PLC|Group|Holdings|Bank|Agency|Bureau|Ministry|Department|University|Institute|Foundation|Council|Committee|Authority|Lab|Labs|Technologies|Systems|Networks|Solutions|Software|Studios|Press|Media|Times|Post|Tribune|Journal|Herald|News)/;
const PRODUCT_ORG_HINTS = /(AI|API|App|Apps|Bot|Cloud|Code|Claude|Anthropic|OpenAI|Microsoft|Google|Meta|Amazon|Apple|GitHub|Cloudflare|Agent|Agents|Model|Models|Platform|Tool|Tools|Vendor|Vendors|SDK|Data|Caterer|Claw|Claw-Code|KAIROS|Engram|Bitterbot)/i;
const EVENT_HINTS = /(Breach|Breaches|Leak|Leaks|Leaked|Malware|Ransomware|Injection|Exploit|Campaign|Incident|Outage|Takedown|Requests|Sanction|Sanctions|Conflict|Crisis|Disruption|Watch|Signal|Attack|Compromise|Exposure|Disclosure|Outbreak|Epidemic|Pandemic|Infection|Contamination|Quarantine|Emergency|Alert|Warning|Surge|Deaths|Fatalities|Spreading|Casualties|Detection|Response|Seizure|Hijacking|Sabotage|Explosion|Collision|Detonation|Assassination|Shooting|Bombing)/i;
const KNOWN_SINGLE_ORGS = new Set(["Anthropic", "OpenAI", "GitHub", "Microsoft", "Google", "Meta", "Apple", "Amazon", "Cloudflare", "Bearer", "Myspace", "JumpWire", "ZenLedger", "Webscript.io", "Moz.com", "Docwire"]);

/** Known pathogen / disease names — matched case-insensitively → classified as EVENT */
const PATHOGEN_NAMES = new Set([
  "hantavirus", "ebola", "mpox", "monkeypox", "covid", "covid-19", "sars", "mers", "influenza",
  "h5n1", "h1n1", "h5n2", "h3n2", "cholera", "plague", "anthrax", "smallpox", "measles", "dengue",
  "zika", "marburg", "lassa", "nipah", "rabies", "typhoid", "hepatitis", "tuberculosis", "malaria",
  "norovirus", "salmonella", "listeria", "legionella", "botulism", "brucellosis", "leptospirosis",
  "candida", "monkeypox", "avian-flu", "bird-flu", "swine-flu", "west-nile", "encephalitis",
  "meningitis", "sepsis", "dysentery", "typhus", "diphtheria", "pertussis", "tetanus", "polio",
]);

/** Vessel / ship class words — used to detect maritime context in queries */
const VESSEL_WORDS = new Set([
  "ship", "vessel", "tanker", "freighter", "carrier", "warship", "submarine", "destroyer",
  "frigate", "cruiser", "ferry", "trawler", "supertanker", "cargo", "containership", "bulker",
  "drillship", "icebreaker", "cutter", "corvette", "gunboat", "patrol", "yacht",
]);
const GEO_HINTS = new Set([
  "City", "Province", "Region", "District", "County", "State", "Republic", "Kingdom", "Federation", "Emirates",
  "Island", "Islands", "Sea", "Ocean", "Bay", "Strait", "Mountain", "Mountains", "Valley", "River", "Desert", "Gulf",
]);
const COUNTRIES = new Set([
  "United States", "United Kingdom", "Russia", "China", "India", "Pakistan", "Germany", "France", "Italy", "Spain",
  "Japan", "South Korea", "North Korea", "Iran", "Iraq", "Israel", "Palestine", "Saudi Arabia", "Turkey", "Egypt",
  "Brazil", "Argentina", "Mexico", "Canada", "Australia", "Ukraine", "Belarus", "Poland", "Sweden", "Norway",
  "Finland", "Denmark", "Netherlands", "Belgium", "Switzerland", "Austria", "Greece", "Portugal", "Ireland",
  "Vietnam", "Thailand", "Indonesia", "Malaysia", "Singapore", "Philippines", "Bangladesh", "Sri Lanka", "Nepal",
  "Afghanistan", "Syria", "Yemen", "Lebanon", "Jordan", "Qatar", "Kuwait", "Bahrain", "Oman", "UAE",
  "Nigeria", "Kenya", "Ethiopia", "South Africa", "Morocco", "Algeria", "Tunisia", "Libya", "Sudan",
]);

const URL_RE = /\bhttps?:\/\/[^\s<>"')\]]+/g;
const EMAIL_RE = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,24}\b/g;
const IPV4_RE = /\b(?:(?:25[0-5]|2[0-4]\d|[01]?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|[01]?\d?\d)\b/g;
const HASH_RE = /\b[a-fA-F0-9]{32,64}\b/g;
const CVE_RE = /\bCVE-\d{4}-\d{4,7}\b/g;
const MONEY_RE = /(?:USD|EUR|GBP|JPY|INR|CNY|\$|€|£|¥|₹)\s?\d[\d,]*(?:\.\d+)?(?:\s?(?:billion|million|thousand|bn|mn|k))?/gi;
const DATE_RE = /\b(?:\d{4}-\d{2}-\d{2}|\d{1,2}\s(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s\d{4}|(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s\d{1,2},?\s\d{4})\b/g;
const PROPER_RE = /\b(?:[A-Z][a-zA-Z'’.-]+)(?:\s+(?:of|de|von|van|the)\s+[A-Z][a-zA-Z'’.-]+|\s+[A-Z][a-zA-Z'’.-]+){0,4}\b/g;

export async function POST(request: Request) {
  let body: RequestBody;
  try {
    body = (await request.json()) as RequestBody;
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }
  const text = typeof body.text === "string" ? body.text : "";
  if (text.length === 0) {
    return NextResponse.json({ entities: [], counts: {}, total: 0 });
  }
  if (text.length > 500_000) {
    return NextResponse.json({ error: "text too large (max 500k chars)" }, { status: 413 });
  }

  const qwenExtraction = await extractWithQwen(text, body.query);
  if (qwenExtraction.ok) {
    return NextResponse.json({
      ...qwenExtraction.result,
      engine: "qwen-ollama-primary",
      model: QWEN_MODEL,
      fallback: false,
      attempts: qwenExtraction.attempts,
    });
  }

  // Heuristic regex fallback — runs when Qwen/Ollama is unavailable or times out.
  // Guarantees entities are always extracted so the UI never shows an empty board.
  const heuristicResult = extractHeuristicEntities(text, body.query);
  return NextResponse.json({
    ...heuristicResult,
    engine: "heuristic-regex",
    model: "none",
    fallback: true,
    fallbackReason: qwenExtraction.reason,
    attempts: qwenExtraction.attempts,
  });
}

function extractHeuristicEntities(text: string, query?: string) {
  const buckets = new Map<string, ExtractedEntity>();
  const add = (kind: EntityKind, value: string) => {
    const trimmed = value.trim();
    if (trimmed.length === 0) {
      return;
    }
    const key = `${kind}:${trimmed.toLowerCase()}`;
    const existing = buckets.get(key);
    if (existing) {
      existing.count += 1;
    } else {
      buckets.set(key, { kind, value: trimmed, count: 1 });
    }
  };

  for (const match of text.matchAll(URL_RE)) {
    add("URL", match[0]);
  }
  for (const match of text.matchAll(EMAIL_RE)) {
    add("EMAIL", match[0]);
  }
  for (const match of text.matchAll(IPV4_RE)) {
    add("IP", match[0]);
  }
  for (const match of text.matchAll(HASH_RE)) {
    add("HASH", match[0]);
  }
  for (const match of text.matchAll(CVE_RE)) {
    add("CVE", match[0].toUpperCase());
  }
  for (const match of text.matchAll(MONEY_RE)) {
    add("MONEY", match[0]);
  }
  for (const match of text.matchAll(DATE_RE)) {
    add("DATE", match[0]);
  }

  // Country sweep
  for (const country of COUNTRIES) {
    const re = new RegExp(`\\b${escapeRegex(country)}\\b`, "g");
    const found = text.match(re);
    if (found && found.length > 0) {
      for (let i = 0; i < found.length; i += 1) {
        add("GEO", country);
      }
    }
  }

  // Proper-noun sequences => classify
  for (const match of text.matchAll(PROPER_RE)) {
    const phrase = normalizeProperPhrase(match[0]);
    if (phrase.length < 3) {
      continue;
    }
    if (STOPWORDS.has(phrase)) {
      continue;
    }
    const tokens = phrase.split(/\s+/);
    if (tokens.length === 1 && tokens[0] !== undefined && STOPWORDS.has(tokens[0])) {
      continue;
    }
    // Single-word pathogen/disease name → EVENT
    if (tokens.length === 1 && PATHOGEN_NAMES.has((tokens[0] ?? "").toLowerCase())) {
      add("EVENT", phrase);
      continue;
    }
    if (ORG_SUFFIXES.test(phrase)) {
      add("ORG", phrase);
      continue;
    }
    if (EVENT_HINTS.test(phrase) && !/^Claude Code$/i.test(phrase)) {
      add("EVENT", phrase);
      continue;
    }
    if (PRODUCT_ORG_HINTS.test(phrase)) {
      if (tokens.length > 1 || KNOWN_SINGLE_ORGS.has(phrase) || /[A-Z][a-z]+[A-Z]/.test(phrase) || /\.[a-z]{2,24}$/i.test(phrase)) {
        add("ORG", phrase);
      }
      continue;
    }
    if (tokens.some((token) => GEO_HINTS.has(token))) {
      add("GEO", phrase);
      continue;
    }
    if (tokens.length === 1) {
      if (KNOWN_SINGLE_ORGS.has(phrase) || /[A-Z][a-z]+[A-Z]/.test(phrase) || /\.[a-z]{2,24}$/i.test(phrase)) {
        add("ORG", phrase);
      }
      continue;
    }
    // 2-4 capitalized tokens: likely person or org
    if (tokens.length >= 2 && tokens.length <= 4) {
      add("PERSON", phrase);
    }
  }

  // ── Query-context seeding ───────────────────────────────────────────────
  // If the caller provides the original search query, extract entities from it
  // directly (case-insensitive) and boost their count so they surface at the
  // top of the result list — even when they are lowercase in the query string.
  const rawQuery = typeof query === "string" ? query.trim() : "";
  if (rawQuery.length > 0 && rawQuery.length < 2000) {
    const qLower = rawQuery.toLowerCase();
    const qTokens = qLower.split(/\s+/);

    // 1. Pathogen / disease names (case-insensitive dict lookup)
    for (const token of qTokens) {
      const clean = token.replace(/[^a-z0-9-]/g, "");
      if (PATHOGEN_NAMES.has(clean)) {
        const display = clean.charAt(0).toUpperCase() + clean.slice(1);
        add("EVENT", display); add("EVENT", display); add("EVENT", display);
      }
    }

    // 2. Vessel context: if query mentions a ship/vessel type, tag it
    if (qTokens.some((t) => VESSEL_WORDS.has(t.replace(/[^a-z]/g, "")))) {
      add("GEO", "Maritime vessel"); add("GEO", "Maritime vessel"); add("GEO", "Maritime vessel");
    }

    // 3. Country names in query (case-insensitive)
    for (const country of COUNTRIES) {
      if (qLower.includes(country.toLowerCase())) {
        add("GEO", country); add("GEO", country); add("GEO", country);
      }
    }

    // 4. CVE identifiers in query
    for (const match of rawQuery.matchAll(CVE_RE)) {
      add("CVE", match[0].toUpperCase()); add("CVE", match[0].toUpperCase()); add("CVE", match[0].toUpperCase());
    }

    // 5. Run PROPER_RE extraction on a title-cased version of the query so
    //    multi-word phrases like "Red Sea", "Indian Ocean", "Port of Hamburg"
    //    are picked up even when the user typed them in lower case.
    const titleQuery = rawQuery.replace(/(?:^|\s)([a-z])/g, (_, c: string) => ` ${c.toUpperCase()}`).trim();
    for (const match of titleQuery.matchAll(PROPER_RE)) {
      const phrase = normalizeProperPhrase(match[0]);
      if (phrase.length < 3 || STOPWORDS.has(phrase)) continue;
      const ptokens = phrase.split(/\s+/);
      if (ORG_SUFFIXES.test(phrase)) {
        add("ORG", phrase); add("ORG", phrase); add("ORG", phrase);
      } else if (EVENT_HINTS.test(phrase) && !/^Claude Code$/i.test(phrase)) {
        add("EVENT", phrase); add("EVENT", phrase); add("EVENT", phrase);
      } else if (ptokens.some((t) => GEO_HINTS.has(t))) {
        add("GEO", phrase); add("GEO", phrase); add("GEO", phrase);
      } else if (ptokens.length >= 2 && ptokens.length <= 4) {
        // Multi-word phrase from query — treat as GEO (geographic or named place) by default
        add("GEO", phrase); add("GEO", phrase); add("GEO", phrase);
      }
    }
  }

  const entities = [...buckets.values()].sort((a, b) => {
    if (b.count !== a.count) {
      return b.count - a.count;
    }
    return a.value.localeCompare(b.value);
  });

  // Assign deterministic confidence scores so downstream charts (Confidence
  // Spectrum, Threat Radar, Scatter) work even when Qwen/Ollama is offline.
  // Regex-exact kinds score higher; inferred proper-noun kinds score lower.
  const KIND_CONF: Partial<Record<EntityKind, number>> = {
    CVE: 0.93, IP: 0.91, EMAIL: 0.89, URL: 0.88, HASH: 0.86,
    MONEY: 0.84, DATE: 0.82, GEO: 0.76, ORG: 0.72, PERSON: 0.68, EVENT: 0.65,
  };
  for (const ent of entities) {
    const base = KIND_CONF[ent.kind] ?? 0.70;
    ent.confidence = Math.min(0.97, base + Math.min(0.06, ent.count * 0.01));
  }
  const counts = entities.reduce<Record<string, number>>((acc, entity) => {
    acc[entity.kind] = (acc[entity.kind] ?? 0) + 1;
    return acc;
  }, {});
  return { entities, counts, total: entities.length, relationships: [] as ExtractedRelationship[] };
}

async function extractWithQwen(text: string, query?: string): Promise<
  | { ok: true; result: { entities: ExtractedEntity[]; counts: Record<string, number>; total: number; relationships: ExtractedRelationship[] }; attempts: number }
  | { ok: false; reason: string; attempts: number }
> {
  if (process.env.QWEN_EXTRACT_DISABLED === "1") {
    return { ok: false, reason: "QWEN_EXTRACT_DISABLED=1", attempts: 0 };
  }

  const clippedText = text.length > QWEN_MAX_CHARS ? `${text.slice(0, QWEN_MAX_CHARS)}\n\n[TRUNCATED]` : text;
  const errorLog: string[] = [];
  const maxAttempts = 2;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), QWEN_TIMEOUT_MS);
    try {
      const response = await fetch(`${OLLAMA_BASE_URL}/api/generate`, {
        method: "POST",
        cache: "no-store",
        signal: controller.signal,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: QWEN_MODEL,
          stream: false,
          format: "json",
          think: false,
          keep_alive: "10m",
          system: buildQwenSystemPrompt(errorLog),
          prompt: buildQwenUserPrompt(clippedText, query),
          options: {
            temperature: 0.05,
            top_p: 0.65,
            repeat_penalty: 1.1,
            num_ctx: 8192,
            num_predict: 3200,
          },
        }),
      });
      if (!response.ok) {
        return { ok: false, reason: `Ollama returned ${response.status} ${response.statusText || "response"}`, attempts: attempt };
      }
      const payload = (await response.json()) as { response?: unknown; thinking?: unknown; model?: unknown };
      if (typeof payload.model === "string" && payload.model !== QWEN_MODEL) {
        return { ok: false, reason: `Ollama used ${payload.model}; expected ${QWEN_MODEL}`, attempts: attempt };
      }
      const raw = typeof payload.response === "string" && payload.response.trim().length > 0
        ? payload.response
        : typeof payload.thinking === "string" ? payload.thinking : "";
      const parsed = parseJsonObject(raw);
      const result = validateQwenExtraction(parsed);
      return { ok: true, result, attempts: attempt };
    } catch (error) {
      const message = error instanceof Error ? error.message : "unknown Qwen extraction error";
      errorLog.push(message);
      if (attempt === maxAttempts) {
        return { ok: false, reason: message, attempts: attempt };
      }
    } finally {
      clearTimeout(timeout);
    }
  }

  return { ok: false, reason: "Qwen extraction exhausted retries", attempts: maxAttempts };
}

function buildQwenSystemPrompt(errorLog: string[]): string {
  const retryNotice = errorLog.length > 0
    ? `\nPrevious validation errors to fix exactly:\n${errorLog.map((entry, index) => `${index + 1}. ${entry}`).join("\n")}`
    : "";
  return `You are ARGUS Brain Extract, a comprehensive OSINT entity extractor. Your output drives intelligence reports — maximising coverage of every entity tied to the query topic is the priority. Extract ALL named entities related to the incident; missing real entities is just as costly as including irrelevant ones.\nReturn strict JSON only — no markdown, no explanation, no chain-of-thought:\n{\n  "entities": [\n    { "entity_type": "ORG|PERSON|GEO|EVENT", "canonical_name": "string", "confidence": 0.0, "source_count": 1, "last_updated": "ISO-8601 timestamp" }\n  ],\n  "relationships": [\n    { "source": "canonical_name", "target": "canonical_name", "confidence": 0.0, "valid_from": "ISO-8601 timestamp", "evidence_text": "verbatim short quote from source text" }\n  ]\n}\nEXTRACTION RULES:\n1. RELEVANCE: Extract ALL entities that belong to or directly support the specific event/incident described by the analyst query. Include every named person, place, organisation, and event related to that topic. Exclude ONLY entities that belong to a completely unrelated story or incident with no connection to the query topic.\n2. PERSON: Include ALL named individuals connected to the described incident — victims, ship crew, officials, health responders, investigators, suspects, witnesses. Do NOT include people mentioned exclusively in a separate unrelated story that merely shares a keyword (e.g. a celebrity who died from the same disease in a completely different unrelated event).\n3. GEO: Include ALL locations named as sites, affected areas, ports of call, origin/destination, or relevant geography for the described event.\n4. ORG: Include ALL organisations named as participants, responders, operators, or authorities in the described event — health agencies, shipping companies, government bodies, hospitals, response teams.\n5. EVENT: Named crises, outbreaks, incidents, or operations tied to the query topic. Be specific (e.g. "2026 Cape Verde Cruise Ship Hantavirus Outbreak" not just "Outbreak").\n6. CONFIDENCE: Assign 0.70–0.95 for entities directly named and central to the incident. Assign 0.40–0.69 for entities mentioned in supporting context. Assign below 0.40 only for very peripheral mentions. Do NOT assign low confidence to entities you are confident belong to the described incident.\n7. COMPLETENESS: Extract ALL relevant entities — if the source text names 4 people, 5 places, and 3 orgs related to the query, list all 12. Only return an empty entities array if the text genuinely contains zero information about the query topic. Do NOT invent or guess entities not present in the source text.\n8. NO DUPLICATES: Deduplicate by canonical name within each entity_type.${retryNotice}`;
}

function buildQwenUserPrompt(text: string, query?: string): string {
  const activeQuery = typeof query === "string" && query.trim().length > 0 ? query.trim() : "not provided";
  return `Analyst query (RELEVANCE ANCHOR — extract all entities tied to this topic; exclude only entities from completely unrelated stories):\n${activeQuery}\n\nSource text (may contain multiple articles — use the relevance anchor to scope extraction, but be thorough and extract every person, place, organisation, and event related to the query topic):\n${text}`;
}

function validateQwenExtraction(value: unknown): { entities: ExtractedEntity[]; counts: Record<string, number>; total: number; relationships: ExtractedRelationship[] } {
  if (!isRecord(value)) {
    throw new Error("Qwen output was not a JSON object");
  }
  if (!Array.isArray(value.entities)) {
    throw new Error("Qwen output omitted entities[]");
  }

  const entityBuckets = new Map<string, ExtractedEntity>();
  for (const rawEntity of value.entities) {
    if (!isRecord(rawEntity)) {
      throw new Error("entity entry was not an object");
    }
    const kindValue = rawEntity.entity_type ?? rawEntity.kind;
    const nameValue = rawEntity.canonical_name ?? rawEntity.value;
    const confidenceValue = rawEntity.confidence;
    const sourceCountValue = rawEntity.source_count ?? rawEntity.count;
    if (typeof kindValue !== "string" || !CORE_ENTITY_KINDS.has(kindValue as CoreEntityKind)) {
      throw new Error(`invalid entity_type: ${String(kindValue)}`);
    }
    if (typeof nameValue !== "string" || nameValue.trim().length < 2 || nameValue.trim().length > 160) {
      throw new Error(`invalid canonical_name for ${kindValue}`);
    }
    if (typeof confidenceValue !== "number" || !Number.isFinite(confidenceValue) || confidenceValue < 0 || confidenceValue > 1) {
      throw new Error(`invalid confidence for ${nameValue}`);
    }
    if (typeof sourceCountValue !== "number" || !Number.isInteger(sourceCountValue) || sourceCountValue < 1) {
      throw new Error(`invalid source_count for ${nameValue}`);
    }

    const kind = kindValue as CoreEntityKind;
    const valueText = normalizeQwenName(nameValue);
    const key = `${kind}:${valueText.toLowerCase()}`;
    const existing = entityBuckets.get(key);
    if (existing) {
      existing.count += sourceCountValue;
      existing.confidence = Math.max(existing.confidence ?? 0, confidenceValue);
    } else {
      entityBuckets.set(key, { kind, value: valueText, count: sourceCountValue, confidence: confidenceValue });
    }
  }

  // Zero entities is a valid result — it means Qwen found nothing relevant to the query.

  const relationships: ExtractedRelationship[] = [];
  if (Array.isArray(value.relationships)) {
    for (const rawRelationship of value.relationships) {
      if (!isRecord(rawRelationship)) {
        continue;
      }
      const source = typeof rawRelationship.source === "string" ? normalizeQwenName(rawRelationship.source) : "";
      const target = typeof rawRelationship.target === "string" ? normalizeQwenName(rawRelationship.target) : "";
      const confidence = typeof rawRelationship.confidence === "number" ? rawRelationship.confidence : 0;
      const evidenceText = typeof rawRelationship.evidence_text === "string" ? rawRelationship.evidence_text.trim() : "";
      const validFrom = typeof rawRelationship.valid_from === "string" ? rawRelationship.valid_from : new Date().toISOString();
      if (source.length > 1 && target.length > 1 && Number.isFinite(confidence) && confidence >= 0 && confidence <= 1 && evidenceText.length > 0) {
        relationships.push({ source, target, confidence, validFrom, evidenceText: evidenceText.slice(0, 280) });
      }
    }
  }

  // Confidence thresholds: keep floors low so all relevant entities survive the filter.
  const CONFIDENCE_FLOOR: Partial<Record<CoreEntityKind, number>> = {
    PERSON: 0.35,
    ORG: 0.25,
    GEO: 0.20,
    EVENT: 0.20,
  };
  const filteredEntities = [...entityBuckets.values()].filter((e) => {
    const floor = CONFIDENCE_FLOOR[e.kind as CoreEntityKind] ?? 0.30;
    return (e.confidence ?? 0) >= floor;
  });

  const entities = filteredEntities.sort((a, b) => {
    if (b.count !== a.count) {
      return b.count - a.count;
    }
    return (b.confidence ?? 0) - (a.confidence ?? 0);
  });
  const counts = entities.reduce<Record<string, number>>((acc, entity) => {
    acc[entity.kind] = (acc[entity.kind] ?? 0) + 1;
    return acc;
  }, {});
  return { entities, counts, total: entities.length, relationships };
}

function parseJsonObject(raw: string): unknown {
  const cleaned = raw.trim().replace(/^```(?:json)?/i, "").replace(/```$/i, "").trim();
  try {
    return JSON.parse(cleaned) as unknown;
  } catch {
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");
    if (start >= 0 && end > start) {
      return JSON.parse(cleaned.slice(start, end + 1)) as unknown;
    }
    throw new Error("Qwen response was not valid JSON");
  }
}

function normalizeQwenName(value: string): string {
  return value.replace(/\s+/g, " ").replace(/[“”]/g, "\"").replace(/[’]/g, "'").trim();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeProperPhrase(value: string): string {
  return value
    .replace(/[’]/g, "'")
    .replace(/^(Ask|Show|Tell|Launch)\s+HN:?\s*/i, "")
    .replace(/^(Analyzing|Every|Major|Critical|Spread|Birth of|Us About|Potential)\s+/i, "")
    .replace(/\b(?:of|about)\b\s*$/i, "")
    .replace(/'s\b/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
