/**
 * SETU AAROGYA DRISHTI — TypeScript mirrors of `backend/app/schemas/health.py`.
 *
 * Shape-only contracts for the `/api/setu/*` REST surface. Kept structurally
 * close to Pydantic models so JSON returned by the FastAPI router can be cast
 * with minimal validation.
 */

export type ConnectorType = "reddit" | "youtube" | "rss" | "telegram" | "web" | "x_fixture";
export type LatencyTier = "realtime" | "daily" | "weekly";
export type ProjectStatus = "active" | "paused" | "archived";
export type SignalKind = "adr" | "trend" | "cluster" | "misinformation";
export type SignalStatus = "new" | "triaged" | "confirmed" | "rejected" | "more_data";
export type CodeSystem = "SNOMED-CT" | "ICD-11" | "ICD-10" | "WHO-DRUG" | "RxNorm" | "MedDRA" | "LOCAL";
export type TriageAction = "confirm" | "reject" | "more_data";

export interface SetuCodeMapping {
  surface: string;
  code_system: CodeSystem;
  code: string;
  display_name: string | null;
}

export interface SetuKeywordSet {
  id: string;
  project_id: string;
  version: number;
  terms: string[];
  synonyms: Record<string, string[]>;
  languages: string[];
  code_mappings: SetuCodeMapping[];
  approved_by: string | null;
  approved_at: string | null;
  created_at: string;
}

export interface SetuSourceConfig {
  id: string;
  project_id: string;
  name: string;
  connector_type: ConnectorType;
  connector_params: Record<string, unknown>;
  latency_tier: LatencyTier;
  enabled: boolean;
  health_score: number;
  last_success_at: string | null;
  last_error: string | null;
  created_at: string;
}

export interface SetuProject {
  id: string;
  slug: string;
  name: string;
  description: string;
  owner: string;
  status: ProjectStatus;
  keyword_set_id: string | null;
  source_ids: string[];
  created_at: string;
  updated_at: string;
}

export interface SetuAdverseEventStatistic {
  drug: string;
  event: string;
  observed: number;
  expected: number;
  prr: number;
  ror: number;
  ic: number;
  ic_lower: number;
  chi_squared: number;
  window_start: string;
  window_end: string;
}

export interface SetuTrendStatistic {
  keyword: string;
  district: string | null;
  z_score: number;
  baseline: number;
  current: number;
  window_start: string;
  window_end: string;
}

export interface SetuClusterStatistic {
  centroid_lat: number;
  centroid_lon: number;
  radius_deg: number;
  population: number;
  observed: number;
  expected: number;
  log_likelihood: number;
  p_value: number;
  window_start: string;
  window_end: string;
}

export interface SetuSignal {
  id: string;
  project_id: string;
  kind: SignalKind;
  score: number;
  title: string;
  explanation: string;
  evidence_mention_ids: string[];
  codes: SetuCodeMapping[];
  district: string | null;
  started_at: string;
  detected_at: string;
  status: SignalStatus;
  assignee: string | null;
  audit_chain_head: string | null;
  adr_stat: SetuAdverseEventStatistic | null;
  trend_stat: SetuTrendStatistic | null;
  cluster_stat: SetuClusterStatistic | null;
}

export interface SetuTriageDecision {
  signal_id: string;
  actor: string;
  decision: TriageAction;
  rationale: string | null;
  decided_at: string;
}

export interface SetuAuditEntry {
  id: string;
  sequence: number;
  prev_hash: string;
  payload_hash: string;
  actor: string;
  action: string;
  signal_id: string | null;
  mention_id: string | null;
  payload_summary: string;
  recorded_at: string;
}

export interface SetuSourceHealthSnapshot {
  source_config_id: string;
  health_score: number;
  uptime_ratio: number;
  error_rate: number;
  last_success_at: string | null;
  throughput_per_min: number;
  snapshot_at: string;
}
