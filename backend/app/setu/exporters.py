"""Regulatory form exporters for SETU AAROGYA DRISHTI signals.

Two mandatory exporters ship in this module:

* :func:`build_idsp_p_form` — Integrated Disease Surveillance Programme
  **P-form** (Presumptive case line-list / outbreak alert). Used by district
  surveillance officers for cluster + outbreak signals.
* :func:`build_pvpi_icsr` — Pharmacovigilance Programme of India **ICSR**
  (Individual Case Safety Report) shaped after the ICH-E2B(R3) JSON profile
  used by VigiFlow. Used for adverse-drug-reaction signals.

Both functions are pure: they take a :class:`Signal` (plus optional
:class:`Project` context) and return a JSON-serialisable ``dict``. They never
mutate inputs, never perform IO, and never call out to LLMs. They are
idempotent — calling twice with the same inputs returns equal payloads.

The output is a **draft** intended for analyst review prior to submission;
it is *not* directly transmitted to any government endpoint.
"""

from __future__ import annotations

from collections.abc import Iterable, Mapping
from datetime import datetime, timezone
from typing import Any

from backend.app.schemas.health import (
    AdverseEventStatistic,
    ClusterStatistic,
    CodeMapping,
    Project,
    Signal,
    TrendStatistic,
)

__all__ = [
    "ExporterError",
    "build_idsp_p_form",
    "build_pvpi_icsr",
]


class ExporterError(ValueError):
    """Raised when a signal lacks the data required by a given exporter."""


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _iso(value: datetime) -> str:
    if value.tzinfo is None:
        value = value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc).isoformat()


def _codes_by_system(codes: Iterable[CodeMapping]) -> dict[str, list[dict[str, str]]]:
    grouped: dict[str, list[dict[str, str]]] = {}
    for code in codes:
        bucket = grouped.setdefault(code.code_system, [])
        entry: dict[str, str] = {"code": code.code, "surface": code.surface}
        if code.display_name is not None:
            entry["display"] = code.display_name
        bucket.append(entry)
    return grouped


def _project_block(project: Project | None) -> dict[str, Any]:
    if project is None:
        return {}
    return {
        "project_id": str(project.id),
        "project_slug": project.slug,
        "project_name": project.name,
        "project_owner": project.owner,
    }


# ---------------------------------------------------------------------------
# IDSP P-form (outbreak / cluster line-list)
# ---------------------------------------------------------------------------


def build_idsp_p_form(
    signal: Signal,
    *,
    project: Project | None = None,
    reporter: str = "SETU AAROGYA DRISHTI (auto-draft)",
    case_definition: str | None = None,
) -> dict[str, Any]:
    """Build a CDSCO/IDSP P-form draft from a cluster or trend signal.

    The P-form structure mirrors the printed CDSCO IDSP weekly form:

    * ``form_type`` — always ``"IDSP-P"``.
    * ``header`` — reporter, generation timestamp, source signal id.
    * ``outbreak`` — disease/syndrome, district, dates, presumptive case count.
    * ``statistics`` — cluster / trend numeric evidence.
    * ``codes`` — coded medical concepts grouped by code system.
    * ``narrative`` — analyst-facing explanation copied from the signal.

    Raises :class:`ExporterError` if the signal lacks any cluster *and* trend
    statistic, since the P-form is meaningless without spatial or temporal
    context.
    """

    if signal.cluster_stat is None and signal.trend_stat is None:
        raise ExporterError(
            "IDSP P-form requires either cluster_stat or trend_stat on the signal"
        )

    outbreak: dict[str, Any] = {
        "syndrome_or_disease": signal.title,
        "district": signal.district,
        "presumptive_case_count": (
            signal.cluster_stat.observed if signal.cluster_stat is not None
            else int(round(signal.trend_stat.current)) if signal.trend_stat is not None
            else 0
        ),
        "started_at": _iso(signal.started_at),
        "detected_at": _iso(signal.detected_at),
    }
    if case_definition is not None:
        outbreak["case_definition"] = case_definition

    statistics: dict[str, Any] = {}
    if signal.cluster_stat is not None:
        statistics["cluster"] = _cluster_block(signal.cluster_stat)
    if signal.trend_stat is not None:
        statistics["trend"] = _trend_block(signal.trend_stat)

    return {
        "form_type": "IDSP-P",
        "form_version": "2024.1-draft",
        "header": {
            "generated_at": _iso(datetime.now(timezone.utc)),
            "reporter": reporter,
            "signal_id": str(signal.id),
            "signal_kind": signal.kind,
            "signal_score": signal.score,
            "signal_status": signal.status,
            "audit_chain_head": signal.audit_chain_head,
            **_project_block(project),
        },
        "outbreak": outbreak,
        "statistics": statistics,
        "codes": _codes_by_system(signal.codes),
        "narrative": signal.explanation,
        "evidence_mention_count": len(signal.evidence_mention_ids),
        "evidence_mention_ids": [str(uid) for uid in signal.evidence_mention_ids],
    }


def _cluster_block(cluster: ClusterStatistic) -> dict[str, Any]:
    return {
        "centroid_lat": cluster.centroid_lat,
        "centroid_lon": cluster.centroid_lon,
        "radius_deg": cluster.radius_deg,
        "population": cluster.population,
        "observed": cluster.observed,
        "expected": cluster.expected,
        "log_likelihood": cluster.log_likelihood,
        "p_value": cluster.p_value,
        "window_start": _iso(cluster.window_start),
        "window_end": _iso(cluster.window_end),
    }


def _trend_block(trend: TrendStatistic) -> dict[str, Any]:
    block: dict[str, Any] = {
        "keyword": trend.keyword,
        "z_score": trend.z_score,
        "baseline": trend.baseline,
        "current": trend.current,
        "window_start": _iso(trend.window_start),
        "window_end": _iso(trend.window_end),
    }
    if trend.district is not None:
        block["district"] = trend.district
    return block


# ---------------------------------------------------------------------------
# PvPI ICSR (E2B(R3) shape)
# ---------------------------------------------------------------------------


def build_pvpi_icsr(
    signal: Signal,
    *,
    project: Project | None = None,
    sender_organisation: str = "SETU AAROGYA DRISHTI (auto-draft)",
    sender_country: str = "IN",
    additional_patient_attrs: Mapping[str, Any] | None = None,
) -> dict[str, Any]:
    """Build a PvPI ICSR draft (ICH-E2B(R3)-shaped JSON) from an ADR signal.

    The output is intentionally a *flattened JSON view* of the E2B(R3)
    structure (not the full XML tree) so that analysts can review and edit
    fields before submission to VigiFlow / NCC-PvPI.

    Raises :class:`ExporterError` if ``signal.kind != "adr"`` or
    ``signal.adr_stat is None`` — the form is meaningless without a
    quantified drug/event pair.
    """

    if signal.kind != "adr":
        raise ExporterError(
            f"PvPI ICSR requires an ADR signal; got kind={signal.kind!r}"
        )
    if signal.adr_stat is None:
        raise ExporterError("PvPI ICSR requires signal.adr_stat to be populated")

    adr: AdverseEventStatistic = signal.adr_stat
    drug_codes = [c for c in signal.codes if c.code_system in {"WHO-DRUG", "RxNorm"}]
    reaction_codes = [
        c for c in signal.codes if c.code_system in {"MedDRA", "SNOMED-CT", "ICD-11", "ICD-10"}
    ]

    patient: dict[str, Any] = {
        "patientidentifier": f"setu-aggregate-{signal.id}",
        "patientonsetage_unit": "unknown",
        "patientsex": "unknown",
        "note": (
            "Patient-level data not available; ICSR derived from aggregate social "
            "listening signal. Manual case follow-up required prior to submission."
        ),
    }
    if additional_patient_attrs:
        for key, value in additional_patient_attrs.items():
            patient[key] = value

    drug_block: dict[str, Any] = {
        "medicinalproduct": adr.drug,
        "drugcharacterization": "1",  # 1 = suspect drug per E2B
        "drugindication": None,
        "actiondrug": None,
    }
    if drug_codes:
        drug_block["drugcoding"] = [
            {"system": c.code_system, "code": c.code, "surface": c.surface}
            for c in drug_codes
        ]

    reaction_block: dict[str, Any] = {
        "reactionmeddrapt": adr.event,
        "reactionoutcome": "unknown",
    }
    if reaction_codes:
        reaction_block["reactioncoding"] = [
            {"system": c.code_system, "code": c.code, "surface": c.surface}
            for c in reaction_codes
        ]

    return {
        "form_type": "PvPI-ICSR",
        "form_version": "E2B(R3)-flat-draft",
        "safetyreportid": f"SETU-{signal.id}",
        "safetyreportversion": 1,
        "primarysourcecountry": sender_country,
        "occurcountry": sender_country,
        "transmissiondate": _iso(datetime.now(timezone.utc)),
        "reporttype": "2",  # 2 = report from study (closest match for aggregate signal)
        "serious": "1" if signal.score >= 0.7 else "2",
        "sender": {
            "sendertype": "2",  # 2 = pharmacovigilance centre
            "senderorganization": sender_organisation,
        },
        "primarysource": {
            "qualification": "5",  # 5 = consumer / non-health professional
            "reportercountry": sender_country,
        },
        "patient": patient,
        "drugs": [drug_block],
        "reactions": [reaction_block],
        "statistics": {
            "observed": adr.observed,
            "expected": adr.expected,
            "prr": adr.prr,
            "ror": adr.ror,
            "ic": adr.ic,
            "ic_lower": adr.ic_lower,
            "chi_squared": adr.chi_squared,
            "window_start": _iso(adr.window_start),
            "window_end": _iso(adr.window_end),
        },
        "narrative": signal.explanation,
        "header": {
            "generated_at": _iso(datetime.now(timezone.utc)),
            "signal_id": str(signal.id),
            "signal_score": signal.score,
            "signal_status": signal.status,
            "audit_chain_head": signal.audit_chain_head,
            **_project_block(project),
        },
        "evidence_mention_count": len(signal.evidence_mention_ids),
        "evidence_mention_ids": [str(uid) for uid in signal.evidence_mention_ids],
    }
