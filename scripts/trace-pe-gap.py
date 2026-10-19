"""Read-only PolicyEngine trace of the same SNAP household as trace-snap-gap.ts.

Run in a PolicyEngine environment; results checkpoint to docs/bbce-evidence/snap-gap-pe.json.
No oracle fixtures are refreshed and no Axiom-labelled outputs are computed here.
"""
import json
from importlib.metadata import version
from pathlib import Path

from policyengine_us import Simulation

rows = []
variables = [
    "snap", "is_snap_eligible", "snap_max_allotment", "snap_gross_income",
    "snap_earned_income_deduction", "snap_standard_deduction",
    "snap_utility_allowance", "snap_net_income_pre_shelter",
    "snap_excess_shelter_expense_deduction", "snap_net_income",
    "snap_expected_contribution", "snap_normal_allotment", "snap_unit_size",
    "tanf", "ssi", "snap_unearned_income", "snap_dependent_care_deduction",
]
for state in ["CA", "CO"]:
    for period in ["2026-09", "2026-10"]:
        for heating in [0, 2400]:
            people = {
                "parent": {"age": {"2026": 35}, "employment_income": {"2026": 39600}, "ssi": {"2026": 0}},
                "kid1": {"age": {"2026": 8}}, "kid2": {"age": {"2026": 5}},
            }
            names = list(people)
            situation = {
                "people": people,
                "tax_units": {"tu": {"members": names}},
                "families": {"f": {"members": names}},
                "marital_units": {f"m{i}": {"members": [name]} for i, name in enumerate(names)},
                "spm_units": {"spm": {"members": names,
                    "housing_cost": {"2026": 21600},
                    "heating_cooling_expense": {"2026": heating},
                    "tanf": {"2026": 0},
                }},
                "households": {"hh": {"members": names, "state_code": {"2026": state}}},
            }
            sim = Simulation(situation=situation)
            values = {}
            for name in variables:
                try:
                    values[name] = [float(v) for v in sim.calculate(name, period)]
                except Exception as error:
                    values[name] = {"error": str(error)}
            row = {"state": state, "period": period, "annual_heating_expense": heating, "values": values}
            rows.append(row)
            Path("docs/bbce-evidence/snap-gap-pe.json").write_text(json.dumps({"pe_version": version("policyengine_us"), "rows": rows}, indent=2) + "\n")
            print(json.dumps(row), flush=True)
