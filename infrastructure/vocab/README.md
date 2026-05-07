# SETU AAROGYA DRISHTI — Vocabulary Subsets

This directory holds **hand-curated open subsets** of medical terminologies used
by the SETU normalizer (`workers/normalizer`) for surface-form recognition and
by the regulatory exporters (`backend/app/setu/exporters.py`) for IDSP P-form
and PvPI ICSR (E2B R3-flat-draft) coding.

> **These subsets are demo / research artefacts only.** They are intentionally
> small, hand-picked, and biased toward the Coldrif / DEG / paediatric AKI
> reference scenario. They are **not** drop-in replacements for the licensed
> upstream distributions and **must not** be used to submit production
> regulatory filings without re-coding against a licensed dictionary.

## Files

| File | Code system | Concepts | Notes |
|------|-------------|----------|-------|
| `medical_seed.json` | mixed (`SNOMED-CT`, `ICD-11`, `WHO-DRUG`, `LOCAL`) | ~30 | Original PoC seed used by the normalizer's `vocab` loader (drugs / symptoms / conditions / adverse_events / facilities / demographics). Multilingual surface forms (en/hi/ta/te/kn). |
| `snomed_subset.json` | `SNOMED-CT` | ~25 | Paediatric AKI + cough-syrup signal-relevant clinical findings. |
| `meddra_subset.json` | `MedDRA` | ~27 | PvPI ICSR `reactionmeddrapt` candidates (E2B R3). |
| `icd10_subset.json` | `ICD-10` | ~27 | IDSP P-form syndrome coding + DEG toxicity. |

## Schema (subset files)

All subset files (other than the legacy `medical_seed.json`) share the same
shape:

```json
{
  "_meta": {
    "code_system": "<one of SNOMED-CT | MedDRA | ICD-10 | ICD-11 | WHO-DRUG | RxNorm | LOCAL>",
    "description": "...",
    "version": "0.1.0",
    "license": "Curation: CC-BY-SA-4.0. Upstream codes retain their own licenses.",
    "source": "...",
    "languages_curated": ["en", ...],
    "intended_use": "..."
  },
  "concepts": [
    {
      "code": "<canonical code string>",
      "preferred_term": "<canonical preferred term>",
      "synonyms": ["...", "..."]
    }
  ]
}
```

The `code_system` literal must be one of the values accepted by
`backend/app/schemas/health.py::CodeSystem`.

## Licensing notes

- **SNOMED-CT** is the property of SNOMED International. Member countries (incl.
  India via NRCeS) provide affiliate access. Production use requires a licence.
- **MedDRA®** is a registered trademark of ICH; production use requires a
  MedDRA MSSO subscription.
- **WHO ICD-10 / ICD-11** are © WHO. Public chapter listings are reproduced
  here under WHO's permitted uses for research and demonstration.
- **WHO-DRUG** identifiers in `medical_seed.json` are local placeholders unless
  explicitly noted; the real WHO Drug Dictionary requires a UMC subscription.
- **RxNorm** is in the public domain (NLM).

The **curation** (selection, grouping, multilingual synonym mappings) in this
folder is released under **CC-BY-SA-4.0**.

## Adding new concepts

1. Pick the right file by `code_system`.
2. Append a `{ "code", "preferred_term", "synonyms": [...] }` entry to
   `concepts`.
3. Bump `_meta.version` (semver: patch for additions, minor for schema changes).
4. Run the normalizer tests: `python -m pytest workers/normalizer/tests -q`.
5. If the concept must surface in IDSP/PvPI exports, add a regression covering
   it in `backend/tests/test_setu_exporters.py`.

## Roadmap

- Wire the normalizer's `vocab` loader to read all four files (currently only
  `medical_seed.json`).
- Add a `WHO-DRUG` subset once a free, redistributable mapping (e.g. RxNorm →
  WHO-DRUG bridge) is identified.
- Add SNOMED-CT Indian Edition mappings via NRCeS once licensing is confirmed.
