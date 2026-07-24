#!/usr/bin/env python3
"""Recompute the PolicyEngine side of scripts/oracle-cases.json.

Runs each case's `pe.situation` through policyengine_us and compares against
the frozen `pe_values`. Pass --update to rewrite pe_values (and pe_version)
in place — do that when bumping policyengine-us, then re-run
`bun run test:oracle` to confirm our engine still agrees.

Usage:
    python3 scripts/oracle-pe.py            # verify frozen values
    python3 scripts/oracle-pe.py --update   # refresh frozen values
"""
import json
import sys
from importlib.metadata import version
from pathlib import Path

CASES_PATH = Path(__file__).parent / "oracle-cases.json"


def build_situation(spec: dict) -> dict:
    """Expand the compact case format into a full policyengine_us situation:
    every person is a member of one tax unit / family / spm unit / household,
    each in their own marital unit."""
    people = spec["people"]
    names = list(people.keys())
    situation = {
        "people": people,
        "tax_units": {"tu": {"members": names, **spec.get("tax_units", {}).get("tu", {})}},
        "families": {"f": {"members": names}},
        "marital_units": {f"m{i}": {"members": [n]} for i, n in enumerate(names)},
        "spm_units": {"spm": {"members": names, **spec.get("spm_units", {}).get("spm", {})}},
        "households": {"hh": {"members": names, "state_code": {"2026": spec["state"]}}},
    }
    return situation


def main() -> int:
    update = "--update" in sys.argv
    doc = json.loads(CASES_PATH.read_text())

    from policyengine_us import Simulation  # slow import — after arg parsing

    pe_version = version("policyengine_us")
    print(f"policyengine_us {pe_version} (frozen: {doc['pe_version']})")

    failures = 0
    for case in doc["cases"]:
        sim = Simulation(situation=build_situation(case["pe"]["situation"]))
        computed = {}
        for out in case["pe"]["outputs"]:
            value = float(sim.calculate(out["variable"], out["period"])[0])
            computed[out["variable"]] = round(value, 2)
        frozen = case.get("pe_values", {})
        drift = {
            k: (frozen.get(k), v)
            for k, v in computed.items()
            if frozen.get(k) is None or abs(frozen[k] - v) > 0.011
        }
        status = "ok  " if not drift else "DRIFT"
        if drift and not update:
            failures += 1
        print(f"{status} {case['id']:22s} {computed}" + (f"  (frozen: {frozen})" if drift else ""))
        if update:
            case["pe_values"] = computed

    if update:
        doc["pe_version"] = pe_version
        CASES_PATH.write_text(json.dumps(doc, indent=1) + "\n")
        print(f"updated {CASES_PATH.name}")
        return 0
    if failures:
        print(f"\n{failures} case(s) drifted from frozen values — rerun with --update after review")
        return 1
    print("\nall frozen PolicyEngine values verified")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
