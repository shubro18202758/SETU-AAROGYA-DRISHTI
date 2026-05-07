export type ArgusDomain = "finance" | "geopolitics" | "defense" | "cyber" | "supply-chain" | "humanitarian";
export type ArgusSignalPosture = "ARGUS" | "TITAN" | "Finance" | "ORACLE";

export interface ArgusDoctrineSource {
  id: string;
  name: string;
  role: string;
  cadence: string;
  coverage: string;
  domains: ArgusDomain[];
  confidenceBase: number;
  mode: "connected" | "modeled" | "analyst";
}

export interface ArgusSignalInput {
  focusEntity: string;
  posture: ArgusSignalPosture;
  totalItems: number;
  sourcesActive: number;
  totalEntities: number;
  leadCount: number;
  urgentCount: number;
  geoLocations: number;
  geoRelationships: number;
}

export interface ArgusSignalSnapshot {
  focusEntity: string;
  posture: ArgusSignalPosture;
  confidence: number;
  band: "watch" | "triage" | "escalate";
  action: string;
  signal: string;
  reasoning: string[];
  collectionRequirements: Array<{ id: string; label: string; status: "satisfied" | "partial" | "open"; detail: string }>;
}

export const ARGUS_DOCTRINE_SOURCES: ArgusDoctrineSource[] = [
  {
    id: "gdelt",
    name: "GDELT / global media",
    role: "event, theme, location, tone stream",
    cadence: "15 min",
    coverage: "worldwide news and knowledge graph",
    domains: ["geopolitics", "supply-chain", "humanitarian"],
    confidenceBase: 0.72,
    mode: "connected",
  },
  {
    id: "hn-reddit",
    name: "HN + Reddit public discourse",
    role: "early chatter, weak signals, analyst leads",
    cadence: "live",
    coverage: "technology, cyber, market sentiment",
    domains: ["cyber", "finance"],
    confidenceBase: 0.58,
    mode: "connected",
  },
  {
    id: "acled",
    name: "ACLED-style event ledger",
    role: "conflict and protest event normalization",
    cadence: "near real-time",
    coverage: "political violence and unrest",
    domains: ["geopolitics", "humanitarian", "defense"],
    confidenceBase: 0.78,
    mode: "modeled",
  },
  {
    id: "cisa-stix",
    name: "CISA KEV + STIX/TAXII",
    role: "structured threat relationships and remediation priority",
    cadence: "catalog updates",
    coverage: "vulnerabilities, indicators, threat objects",
    domains: ["cyber"],
    confidenceBase: 0.82,
    mode: "modeled",
  },
  {
    id: "edgar-market",
    name: "EDGAR + market signals",
    role: "filings, ownership, options, company health context",
    cadence: "filing/event driven",
    coverage: "public companies and financial disclosures",
    domains: ["finance", "supply-chain"],
    confidenceBase: 0.76,
    mode: "modeled",
  },
  {
    id: "verification",
    name: "Bellingcat-style verification",
    role: "geolocation, chronology, provenance, corroboration",
    cadence: "analyst review",
    coverage: "claims, imagery, source caveats",
    domains: ["geopolitics", "defense", "humanitarian"],
    confidenceBase: 0.86,
    mode: "analyst",
  },
];

export function buildArgusSignalSnapshot(input: ArgusSignalInput): ArgusSignalSnapshot {
  const sourceCoverage = Math.min(1, input.sourcesActive / 3);
  const evidenceDepth = Math.min(1, input.totalItems / 45);
  const entityDepth = Math.min(1, input.totalEntities / 18);
  const analystDepth = Math.min(1, input.leadCount / 4);
  const geoDepth = Math.min(1, (input.geoLocations + input.geoRelationships) / 14);
  const urgencyLift = Math.min(0.08, input.urgentCount * 0.04);
  const postureLift = input.posture === "TITAN" && geoDepth > 0.5 ? 0.04 : input.posture === "Finance" && analystDepth > 0 ? 0.03 : 0;
  const confidence = Math.round(Math.min(94, 38 + sourceCoverage * 20 + evidenceDepth * 14 + entityDepth * 10 + analystDepth * 8 + geoDepth * 10 + (urgencyLift + postureLift) * 100));
  const band: ArgusSignalSnapshot["band"] = confidence >= 78 || input.urgentCount > 0 ? "escalate" : confidence >= 60 ? "triage" : "watch";
  const action = band === "escalate" ? "Escalate to analyst review" : band === "triage" ? "Hold in active triage" : "Keep collecting";
  const signal = `${input.posture} signal on ${input.focusEntity}: ${confidence}% confidence`;

  return {
    focusEntity: input.focusEntity,
    posture: input.posture,
    confidence,
    band,
    action,
    signal,
    reasoning: [
      `${input.sourcesActive}/3 connected feeds are contributing ${input.totalItems} observations into the local event stream.`,
      `${input.totalEntities} extracted entities and ${input.leadCount} analyst leads provide the first resolution layer.`,
      `${input.geoLocations} GEO nodes and ${input.geoRelationships} relationship arcs seed the temporal graph context.`,
      input.urgentCount > 0 ? `${input.urgentCount} urgent lead${input.urgentCount === 1 ? " raises" : "s raise"} the review priority.` : "No urgent lead is forcing escalation; confidence is driven by source diversity.",
    ],
    collectionRequirements: [
      {
        id: "PIR-01",
        label: "Entity continuity",
        status: input.totalEntities > 0 || input.leadCount > 0 ? "satisfied" : "partial",
        detail: input.totalEntities > 0 ? "Named entities are available for resolution." : "Promoted leads can seed entity resolution.",
      },
      {
        id: "PIR-02",
        label: "Independent corroboration",
        status: input.sourcesActive >= 3 ? "satisfied" : input.sourcesActive >= 2 ? "partial" : "open",
        detail: `${input.sourcesActive}/3 local feeds have reported during this session.`,
      },
      {
        id: "PIR-03",
        label: "GEO anchoring",
        status: input.geoLocations > 0 ? "satisfied" : "open",
        detail: input.geoLocations > 0 ? `${input.geoLocations} places are available for map correlation.` : "No place nodes are plotted yet.",
      },
      {
        id: "PIR-04",
        label: "Provenance caveats",
        status: input.leadCount > 0 ? "partial" : "open",
        detail: input.leadCount > 0 ? "Local lead queue preserves analyst-provided source labels." : "Add one lead to preserve analyst provenance.",
      },
    ],
  };
}

/** Detect query domain so the local graph returns contextually relevant entities */
function detectQueryDomain(q: string): "disease" | "maritime" | "cyber" | "geopolitical" | "finance" {
  const qL = q.toLowerCase();
  if (/\b(hantavirus|ebola|mpox|monkeypox|covid|sars|mers|influenza|h5n1|h1n1|cholera|plague|measles|dengue|zika|marburg|lassa|nipah|rabies|typhoid|hepatitis|tuberculosis|malaria|norovirus|outbreak|epidemic|pandemic|infection|pathogen|quarantine|biosafety|disease|virus|who|cdc|ecdc|health emergency)\b/.test(qL)) return "disease";
  if (/\b(ship|vessel|tanker|maritime|port|sea\b|strait|ocean|cargo|shipping|coast guard|fleet|harbor|dock|sailor|navy|freighter|carrier|supertanker|drillship|bulker|imo|piracy|pirate|hijack)\b/.test(qL)) return "maritime";
  if (/\b(cve-\d{4}|exploit|ransomware|breach|malware|phishing|hack|vulnerab|zero-day|botnet|ddos|intrusion|apt|threat actor|stix|taxii|cisa|kev|rootkit|trojan|spyware|backdoor|c2|c&c)\b/.test(qL)) return "cyber";
  if (/\b(stock|market|financial|fund|investor|trade|tariff|sanction|gdp|imf|world bank|equity|bond|forex|bitcoin|crypto|currency|inflation|interest rate|earnings|ipo|merger|acquisition)\b/.test(qL)) return "finance";
  return "geopolitical";
}

export function buildLocalGraphSearchPayload(query: string) {
  const normalized = query.trim() || "Mumbai dengue surveillance zone";
  const slug = normalized.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "watchlist";
  const generatedAt = new Date().toISOString();
  const domain = detectQueryDomain(normalized);

  // Deterministic per-query hash so edge count varies (2–4) across different entities
  const slugHash = slug.split("").reduce((acc, c) => (acc * 31 + c.charCodeAt(0)) >>> 0, 0);

  // ── Domain-specific entity templates ───────────────────────────────────
  let entities: Array<{ id: string; entity_type: string; canonical_name: string; confidence: number; source_count: number; last_updated: string }>;
  let allRelationships: Array<{ id: string; source_entity_id: string; destination_entity_id: string; confidence: number; evidence_text: string }>;

  if (domain === "disease") {
    entities = [
      { id: `event:${slug}:signal`, entity_type: "EVENT", canonical_name: `${normalized} signal cluster`, confidence: 0.84, source_count: 3, last_updated: generatedAt },
      { id: "org:who", entity_type: "ORG", canonical_name: "World Health Organization (WHO)", confidence: 0.88, source_count: 4, last_updated: generatedAt },
      { id: "org:cdc", entity_type: "ORG", canonical_name: "Centers for Disease Control (CDC)", confidence: 0.81, source_count: 3, last_updated: generatedAt },
      { id: "org:ecdc", entity_type: "ORG", canonical_name: "European Centre for Disease Prevention (ECDC)", confidence: 0.76, source_count: 2, last_updated: generatedAt },
      { id: "person:epidemiologist", entity_type: "PERSON", canonical_name: "Field epidemiologist", confidence: 0.62, source_count: 1, last_updated: generatedAt },
    ];
    allRelationships = [
      { id: `edge:${slug}:event-who`, source_entity_id: `event:${slug}:signal`, destination_entity_id: "org:who", confidence: 0.82, evidence_text: "WHO is the primary international coordination body for disease outbreak response and global health emergency declarations." },
      { id: `edge:${slug}:who-cdc`, source_entity_id: "org:who", destination_entity_id: "org:cdc", confidence: 0.78, evidence_text: "CDC and WHO maintain bilateral reporting and surge deployment arrangements for major outbreak investigations." },
      { id: `edge:${slug}:event-cdc`, source_entity_id: `event:${slug}:signal`, destination_entity_id: "org:cdc", confidence: 0.75, evidence_text: "US CDC deploys Epidemic Intelligence Service officers for outbreak field investigation and laboratory confirmation." },
      { id: `edge:${slug}:analyst-review`, source_entity_id: "person:epidemiologist", destination_entity_id: `event:${slug}:signal`, confidence: 0.64, evidence_text: "Field epidemiologists provide case count, exposure risk, and transmission route assessments for the focus event." },
    ];
  } else if (domain === "maritime") {
    entities = [
      { id: `event:${slug}:signal`, entity_type: "EVENT", canonical_name: `${normalized} signal cluster`, confidence: 0.84, source_count: 3, last_updated: generatedAt },
      { id: "geo:maritime-corridor", entity_type: "GEO", canonical_name: "Strategic maritime corridor", confidence: 0.88, source_count: 4, last_updated: generatedAt },
      { id: "org:imo", entity_type: "ORG", canonical_name: "International Maritime Organization (IMO)", confidence: 0.82, source_count: 3, last_updated: generatedAt },
      { id: "org:coast-guard", entity_type: "ORG", canonical_name: "Coast Guard / maritime authority", confidence: 0.71, source_count: 2, last_updated: generatedAt },
      { id: "person:maritime-analyst", entity_type: "PERSON", canonical_name: "Maritime risk analyst", confidence: 0.62, source_count: 1, last_updated: generatedAt },
    ];
    allRelationships = [
      { id: `edge:${slug}:event-corridor`, source_entity_id: `event:${slug}:signal`, destination_entity_id: "geo:maritime-corridor", confidence: 0.82, evidence_text: "GDELT media clustering links the focus event to a strategic maritime geography with source diversity and time proximity." },
      { id: `edge:${slug}:corridor-imo`, source_entity_id: "geo:maritime-corridor", destination_entity_id: "org:imo", confidence: 0.78, evidence_text: "IMO provides the regulatory and incident-reporting framework for maritime events along international shipping lanes." },
      { id: `edge:${slug}:event-coastguard`, source_entity_id: `event:${slug}:signal`, destination_entity_id: "org:coast-guard", confidence: 0.69, evidence_text: "Coast Guard and naval authorities are the primary responders for vessel incidents, piracy, and maritime safety events." },
      { id: `edge:${slug}:analyst-review`, source_entity_id: "person:maritime-analyst", destination_entity_id: `event:${slug}:signal`, confidence: 0.64, evidence_text: "Maritime risk analysts assess AIS track data, port state reports, and insurance signals to reconstruct incident timelines." },
    ];
  } else if (domain === "cyber") {
    entities = [
      { id: `event:${slug}:signal`, entity_type: "EVENT", canonical_name: `${normalized} signal cluster`, confidence: 0.84, source_count: 3, last_updated: generatedAt },
      { id: "org:cyber-response-teams", entity_type: "ORG", canonical_name: "Cyber response teams", confidence: 0.88, source_count: 4, last_updated: generatedAt },
      { id: "org:cisa", entity_type: "ORG", canonical_name: "CISA / national cyber authority", confidence: 0.82, source_count: 3, last_updated: generatedAt },
      { id: "org:threat-intelligence-vendors", entity_type: "ORG", canonical_name: "Threat intelligence vendors", confidence: 0.76, source_count: 3, last_updated: generatedAt },
      { id: "person:regional-risk-analyst", entity_type: "PERSON", canonical_name: "Regional risk analyst", confidence: 0.62, source_count: 1, last_updated: generatedAt },
    ];
    allRelationships = [
      { id: `edge:${slug}:event-cert`, source_entity_id: `event:${slug}:signal`, destination_entity_id: "org:cyber-response-teams", confidence: 0.82, evidence_text: "CISA/STIX-inspired threat objects are modeled as connected entities when CVE or cyber terms appear in the feed stream." },
      { id: `edge:${slug}:cert-cisa`, source_entity_id: "org:cyber-response-teams", destination_entity_id: "org:cisa", confidence: 0.78, evidence_text: "National CERT teams coordinate with CISA and sector-specific ISACs for vulnerability triage and remediation guidance." },
      { id: `edge:${slug}:event-intel`, source_entity_id: `event:${slug}:signal`, destination_entity_id: "org:threat-intelligence-vendors", confidence: 0.71, evidence_text: "Commercial threat intelligence feeds contribute IOC enrichment and TTP mapping for active campaigns." },
      { id: `edge:${slug}:analyst-review`, source_entity_id: "person:regional-risk-analyst", destination_entity_id: `event:${slug}:signal`, confidence: 0.64, evidence_text: "Bellingcat-style verification requires analyst review of chronology, geolocation, and source caveats before escalation." },
    ];
  } else if (domain === "finance") {
    entities = [
      { id: `event:${slug}:signal`, entity_type: "EVENT", canonical_name: `${normalized} signal cluster`, confidence: 0.84, source_count: 3, last_updated: generatedAt },
      { id: "org:imf", entity_type: "ORG", canonical_name: "International Monetary Fund (IMF)", confidence: 0.86, source_count: 4, last_updated: generatedAt },
      { id: "org:central-banks", entity_type: "ORG", canonical_name: "Central banking authorities", confidence: 0.81, source_count: 3, last_updated: generatedAt },
      { id: "org:market-regulators", entity_type: "ORG", canonical_name: "Market regulatory bodies", confidence: 0.74, source_count: 2, last_updated: generatedAt },
      { id: "person:financial-analyst", entity_type: "PERSON", canonical_name: "Financial intelligence analyst", confidence: 0.62, source_count: 1, last_updated: generatedAt },
    ];
    allRelationships = [
      { id: `edge:${slug}:event-imf`, source_entity_id: `event:${slug}:signal`, destination_entity_id: "org:imf", confidence: 0.82, evidence_text: "IMF monitors systemic financial risk and sovereign debt signals, providing early-warning indicators for macroeconomic events." },
      { id: `edge:${slug}:imf-banks`, source_entity_id: "org:imf", destination_entity_id: "org:central-banks", confidence: 0.78, evidence_text: "Central bank policy actions are coordinated through IMF frameworks during financial instability events." },
      { id: `edge:${slug}:event-regulators`, source_entity_id: `event:${slug}:signal`, destination_entity_id: "org:market-regulators", confidence: 0.69, evidence_text: "Market regulators issue sanctions, trading halts, and disclosure requirements in response to financial market events." },
      { id: `edge:${slug}:analyst-review`, source_entity_id: "person:financial-analyst", destination_entity_id: `event:${slug}:signal`, confidence: 0.64, evidence_text: "Financial intelligence analysts correlate EDGAR filings, options flow, and market sentiment to reconstruct event impact." },
    ];
  } else {
    // Geopolitical / default
    entities = [
      { id: `event:${slug}:signal`, entity_type: "EVENT", canonical_name: `${normalized} signal cluster`, confidence: 0.84, source_count: 3, last_updated: generatedAt },
      { id: "geo:red-sea", entity_type: "GEO", canonical_name: "Red Sea maritime corridor", confidence: 0.88, source_count: 4, last_updated: generatedAt },
      { id: "org:global-shipping-operators", entity_type: "ORG", canonical_name: "Global shipping operators", confidence: 0.76, source_count: 3, last_updated: generatedAt },
      { id: "org:cyber-response-teams", entity_type: "ORG", canonical_name: "Cyber response teams", confidence: 0.71, source_count: 2, last_updated: generatedAt },
      { id: "person:regional-risk-analyst", entity_type: "PERSON", canonical_name: "Regional risk analyst", confidence: 0.62, source_count: 1, last_updated: generatedAt },
    ];
    allRelationships = [
      { id: `edge:${slug}:event-geo`, source_entity_id: `event:${slug}:signal`, destination_entity_id: "geo:red-sea", confidence: 0.82, evidence_text: "GDELT-style media clustering links the focus event to a strategic maritime geography with source diversity and time proximity." },
      { id: `edge:${slug}:geo-shipping`, source_entity_id: "geo:red-sea", destination_entity_id: "org:global-shipping-operators", confidence: 0.78, evidence_text: "Supply-chain exposure is inferred when port, sea lane, insurer, and logistics mentions converge around the same corridor." },
      { id: `edge:${slug}:event-cyber`, source_entity_id: `event:${slug}:signal`, destination_entity_id: "org:cyber-response-teams", confidence: 0.69, evidence_text: "CISA/STIX-inspired threat objects remain modeled as connected entities when cyber terms or CVE references appear in the feed stream." },
      { id: `edge:${slug}:analyst-review`, source_entity_id: "person:regional-risk-analyst", destination_entity_id: `event:${slug}:signal`, confidence: 0.64, evidence_text: "Bellingcat-style verification requires analyst review of chronology, geolocation, and source caveats before escalation." },
    ];
  }

  const relationships = allRelationships.slice(0, 2 + (slugHash % 3)); // 2, 3, or 4 edges

  return {
    query: normalized,
    vector_top_k: 5,
    traversal_hops: 2,
    fallback: true,
    generated_at: generatedAt,
    entities,
    relationships,
    seed_relationships: relationships.slice(0, 2),
  };
}

export function buildLocalGeoGraphPayload(limit: number) {
  const generatedAt = new Date().toISOString();
  const locations = [
    location("geo:red-sea", "Red Sea maritime corridor", 20.6, 38.6, 0.88, 5, generatedAt),
    location("geo:mumbai-port", "Mumbai Port", 18.946, 72.844, 0.86, 4, generatedAt),
    location("geo:taiwan-strait", "Taiwan Strait", 24.4, 119.9, 0.82, 4, generatedAt),
    location("geo:zhengzhou", "Zhengzhou", 34.7466, 113.6254, 0.77, 3, generatedAt),
    location("geo:silicon-valley", "Silicon Valley", 37.3875, -122.0575, 0.74, 3, generatedAt),
    location("geo:brussels", "Brussels", 50.8503, 4.3517, 0.72, 2, generatedAt),
  ].slice(0, Math.max(0, Math.min(limit, 6)));

  const connectedEntities = [
    connected("org:global-shipping-operators", "ORG", "Global shipping operators", 0.76, generatedAt),
    connected("org:chip-supply-chain", "ORG", "Semiconductor supply chain", 0.73, generatedAt),
    connected("org:cyber-response-teams", "ORG", "Cyber response teams", 0.71, generatedAt),
    connected("person:regional-risk-analyst", "PERSON", "Regional risk analyst", 0.62, generatedAt),
  ];

  return {
    generated_at: generatedAt,
    limit,
    fallback: true,
    locations,
    connected_entities: connectedEntities,
    relationships: [
      relationship("rel:red-sea-shipping", "geo:red-sea", "org:global-shipping-operators", 0.81, "Maritime risk reporting intersects with shipping, insurance, and port disruption signals.", generatedAt),
      relationship("rel:mumbai-shipping", "geo:mumbai-port", "org:global-shipping-operators", 0.74, "Port and logistics watchlist nodes preserve regional exposure for supply-chain analysis.", generatedAt),
      relationship("rel:taiwan-chip", "geo:taiwan-strait", "org:chip-supply-chain", 0.79, "Strategic geography connects semiconductor production exposure with regional military and diplomatic signals.", generatedAt),
      relationship("rel:zhengzhou-chip", "geo:zhengzhou", "org:chip-supply-chain", 0.7, "Manufacturing hub references provide supply-chain continuity context for market and geopolitical questions.", generatedAt),
      relationship("rel:brussels-cyber", "geo:brussels", "org:cyber-response-teams", 0.68, "Government and policy sources contribute structured cyber risk and sanctions context.", generatedAt),
      relationship("rel:silicon-cyber", "geo:silicon-valley", "org:cyber-response-teams", 0.66, "Technology-sector chatter links vulnerabilities, cloud providers, and incident response organizations.", generatedAt),
      relationship("rel:red-sea-analyst", "geo:red-sea", "person:regional-risk-analyst", 0.63, "Analyst verification remains attached to the claim trail as provenance, not as an unreviewed fact.", generatedAt),
    ],
  };
}

function location(id: string, canonicalName: string, latitude: number, longitude: number, confidence: number, sourceCount: number, lastUpdated: string) {
  return { id, canonical_name: canonicalName, confidence, source_count: sourceCount, last_updated: lastUpdated, latitude, longitude };
}

function connected(id: string, entityType: "ORG" | "PERSON", canonicalName: string, confidence: number, lastUpdated: string) {
  return { id, entity_type: entityType, canonical_name: canonicalName, confidence, last_updated: lastUpdated };
}

function relationship(id: string, sourceEntityId: string, destinationEntityId: string, confidence: number, evidenceText: string, validFrom: string) {
  return { id, source_entity_id: sourceEntityId, destination_entity_id: destinationEntityId, confidence, valid_from: validFrom, evidence_text: evidenceText };
}