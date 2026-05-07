"""Tests for SETU regulatory form exporters (IDSP P-form + PvPI ICSR)."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from uuid import uuid4

import pytest

from backend.app.schemas.health import (
    AdverseEventStatistic,
    ClusterStatistic,
    CodeMapping,
    Project,
    Signal,
    TrendStatistic,
)
from backend.app.setu.exporters import (
    ExporterError,
    build_idsp_p_form,
    build_pvpi_icsr,
)


def _utcnow() -> datetime:
    return datetime.now(tz=timezone.utc)


def _project() -> Project:
    now = _utcnow()
    return Project(
        id=uuid4(),
        slug="setu-mp",
        name="MP Cough Syrup Watch",
        description="Madhya Pradesh paediatric ADR cluster surveillance.",
        owner="ops@setu.test",
        created_at=now,
        updated_at=now,
    )


def _cluster_stat() -> ClusterStatistic:
    started = _utcnow() - timedelta(hours=12)
    return ClusterStatistic(
        centroid_lat=22.057,
        centroid_lon=78.939,
        radius_deg=0.45,
        population=2_090_000,
        observed=14,
        expected=2.1,
        log_likelihood=18.7,
        p_value=0.0008,
        window_start=started,
        window_end=_utcnow(),
    )


def _trend_stat() -> TrendStatistic:
    started = _utcnow() - timedelta(days=2)
    return TrendStatistic(
        keyword="aki paediatric",
        district="Chhindwara",
        z_score=4.7,
        baseline=3.0,
        current=18.0,
        window_start=started,
        window_end=_utcnow(),
    )


def _adr_stat() -> AdverseEventStatistic:
    started = _utcnow() - timedelta(days=7)
    return AdverseEventStatistic(
        drug="coldrif",
        event="acute kidney injury",
        observed=14,
        expected=1.8,
        prr=7.8,
        ror=8.4,
        ic=2.6,
        ic_lower=1.9,
        chi_squared=42.5,
        window_start=started,
        window_end=_utcnow(),
    )


def _cluster_signal(*, project_id, codes=()) -> Signal:
    started = _utcnow() - timedelta(hours=12)
    return Signal(
        id=uuid4(),
        project_id=project_id,
        kind="cluster",
        score=0.92,
        title="Paediatric AKI cluster — Chhindwara",
        explanation="Spatial cluster of paediatric AKI mentions co-occurring with Coldrif syrup.",
        evidence_mention_ids=(uuid4(), uuid4(), uuid4()),
        codes=codes,
        district="Chhindwara",
        started_at=started,
        detected_at=_utcnow(),
        audit_chain_head="a" * 64,
        cluster_stat=_cluster_stat(),
    )


def _adr_signal(*, project_id, codes=()) -> Signal:
    started = _utcnow() - timedelta(days=7)
    return Signal(
        id=uuid4(),
        project_id=project_id,
        kind="adr",
        score=0.85,
        title="Coldrif ↔ AKI disproportionality",
        explanation="PRR and IC025 elevated for coldrif/AKI pair across MP listening sources.",
        evidence_mention_ids=(uuid4(), uuid4()),
        codes=codes,
        district="Chhindwara",
        started_at=started,
        detected_at=_utcnow(),
        audit_chain_head="b" * 64,
        adr_stat=_adr_stat(),
    )


# ---------------------------------------------------------------------------
# IDSP P-form
# ---------------------------------------------------------------------------


def test_build_idsp_p_form_with_cluster_stat_happy_path() -> None:
    project = _project()
    codes = (
        CodeMapping(surface="acute kidney injury", code_system="SNOMED-CT", code="14669001",
                    display_name="Acute renal failure syndrome"),
        CodeMapping(surface="coldrif", code_system="WHO-DRUG", code="DEG-001"),
    )
    signal = _cluster_signal(project_id=project.id, codes=codes)

    form = build_idsp_p_form(signal, project=project)

    assert form["form_type"] == "IDSP-P"
    assert form["form_version"] == "2024.1-draft"
    assert form["header"]["signal_id"] == str(signal.id)
    assert form["header"]["project_slug"] == "setu-mp"
    assert form["header"]["audit_chain_head"] == "a" * 64
    assert form["outbreak"]["district"] == "Chhindwara"
    assert form["outbreak"]["presumptive_case_count"] == 14
    assert "cluster" in form["statistics"]
    assert form["statistics"]["cluster"]["observed"] == 14
    assert "trend" not in form["statistics"]
    assert set(form["codes"].keys()) == {"SNOMED-CT", "WHO-DRUG"}
    assert form["evidence_mention_count"] == 3
    assert len(form["evidence_mention_ids"]) == 3


def test_build_idsp_p_form_with_only_trend_stat() -> None:
    project = _project()
    signal = _cluster_signal(project_id=project.id)
    # Replace cluster_stat with trend_stat via a fresh model instance.
    signal = signal.model_copy(update={
        "kind": "trend",
        "cluster_stat": None,
        "trend_stat": _trend_stat(),
    })

    form = build_idsp_p_form(signal)

    assert form["form_type"] == "IDSP-P"
    assert form["statistics"] == {"trend": form["statistics"]["trend"]}
    assert form["statistics"]["trend"]["z_score"] == 4.7
    assert form["outbreak"]["presumptive_case_count"] == 18  # round(current=18.0)
    # No project context provided => header has no project_* keys.
    assert "project_slug" not in form["header"]


def test_build_idsp_p_form_raises_when_no_cluster_or_trend() -> None:
    project = _project()
    signal = _cluster_signal(project_id=project.id).model_copy(update={
        "cluster_stat": None,
        "trend_stat": None,
    })

    with pytest.raises(ExporterError, match="cluster_stat or trend_stat"):
        build_idsp_p_form(signal)


def test_build_idsp_p_form_with_case_definition_kwarg() -> None:
    project = _project()
    signal = _cluster_signal(project_id=project.id)
    form = build_idsp_p_form(
        signal, project=project, case_definition="Paediatric AKI <12y, sCr >2x baseline."
    )
    assert form["outbreak"]["case_definition"].startswith("Paediatric AKI")


def test_build_idsp_p_form_is_idempotent_modulo_generated_at() -> None:
    project = _project()
    signal = _cluster_signal(project_id=project.id)

    a = build_idsp_p_form(signal, project=project)
    b = build_idsp_p_form(signal, project=project)

    a_h = {k: v for k, v in a["header"].items() if k != "generated_at"}
    b_h = {k: v for k, v in b["header"].items() if k != "generated_at"}
    assert a_h == b_h
    a_no_h = {k: v for k, v in a.items() if k != "header"}
    b_no_h = {k: v for k, v in b.items() if k != "header"}
    assert a_no_h == b_no_h


# ---------------------------------------------------------------------------
# PvPI ICSR
# ---------------------------------------------------------------------------


def test_build_pvpi_icsr_happy_path() -> None:
    project = _project()
    codes = (
        CodeMapping(surface="coldrif", code_system="WHO-DRUG", code="DEG-001"),
        CodeMapping(surface="acute kidney injury", code_system="MedDRA",
                    code="10069339", display_name="Acute kidney injury"),
        CodeMapping(surface="acute kidney injury", code_system="ICD-10", code="N17.9"),
    )
    signal = _adr_signal(project_id=project.id, codes=codes)

    icsr = build_pvpi_icsr(signal, project=project)

    assert icsr["form_type"] == "PvPI-ICSR"
    assert icsr["form_version"] == "E2B(R3)-flat-draft"
    assert icsr["safetyreportid"] == f"SETU-{signal.id}"
    assert icsr["serious"] == "1"  # score 0.85 >= 0.7
    assert icsr["primarysourcecountry"] == "IN"
    assert icsr["sender"]["senderorganization"].startswith("SETU")
    assert icsr["patient"]["patientidentifier"].startswith("setu-aggregate-")

    # Drug coding picks up WHO-DRUG only.
    drug = icsr["drugs"][0]
    assert drug["medicinalproduct"] == "coldrif"
    assert drug["drugcharacterization"] == "1"
    drug_systems = {c["system"] for c in drug["drugcoding"]}
    assert drug_systems == {"WHO-DRUG"}

    # Reaction coding picks up MedDRA + ICD-10 (not WHO-DRUG).
    reaction = icsr["reactions"][0]
    assert reaction["reactionmeddrapt"] == "acute kidney injury"
    reaction_systems = {c["system"] for c in reaction["reactioncoding"]}
    assert reaction_systems == {"MedDRA", "ICD-10"}

    assert icsr["statistics"]["prr"] == 7.8
    assert icsr["statistics"]["ic_lower"] == 1.9
    assert icsr["header"]["project_slug"] == "setu-mp"
    assert icsr["evidence_mention_count"] == 2


def test_build_pvpi_icsr_marks_low_score_as_non_serious() -> None:
    project = _project()
    signal = _adr_signal(project_id=project.id).model_copy(update={"score": 0.55})
    icsr = build_pvpi_icsr(signal, project=project)
    assert icsr["serious"] == "2"


def test_build_pvpi_icsr_rejects_non_adr_signal() -> None:
    project = _project()
    signal = _cluster_signal(project_id=project.id)  # kind="cluster"
    with pytest.raises(ExporterError, match="ADR signal"):
        build_pvpi_icsr(signal, project=project)


def test_build_pvpi_icsr_rejects_when_adr_stat_missing() -> None:
    project = _project()
    signal = _adr_signal(project_id=project.id).model_copy(update={"adr_stat": None})
    with pytest.raises(ExporterError, match="adr_stat"):
        build_pvpi_icsr(signal, project=project)


def test_build_pvpi_icsr_includes_additional_patient_attrs() -> None:
    project = _project()
    signal = _adr_signal(project_id=project.id)
    icsr = build_pvpi_icsr(
        signal,
        project=project,
        additional_patient_attrs={"patientonsetage": "8", "patientonsetage_unit": "year"},
    )
    assert icsr["patient"]["patientonsetage"] == "8"
    assert icsr["patient"]["patientonsetage_unit"] == "year"


def test_build_pvpi_icsr_omits_drugcoding_when_no_drug_codes() -> None:
    project = _project()
    codes = (
        CodeMapping(surface="acute kidney injury", code_system="MedDRA", code="10069339"),
    )
    signal = _adr_signal(project_id=project.id, codes=codes)
    icsr = build_pvpi_icsr(signal, project=project)
    assert "drugcoding" not in icsr["drugs"][0]
    assert "reactioncoding" in icsr["reactions"][0]


def test_build_pvpi_icsr_is_idempotent_modulo_timestamps() -> None:
    project = _project()
    signal = _adr_signal(project_id=project.id)
    a = build_pvpi_icsr(signal, project=project)
    b = build_pvpi_icsr(signal, project=project)

    for payload in (a, b):
        payload["transmissiondate"] = ""
        payload["header"]["generated_at"] = ""
    assert a == b
