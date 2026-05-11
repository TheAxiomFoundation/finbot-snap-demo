#!/usr/bin/env python3
"""Derive the CO SNAP runtime schema from the compiled axiom-rules-engine artifact.

This script does NOT maintain a list of expected inputs — it walks the compiled
program's IR, finds every ``{kind: input, name: X}`` reference, groups by the
enclosing rule's entity, and infers each input's dtype from the surrounding
expression context.

Output: src/lib/programs/co-snap-base.ts — a generated module the runtime uses
to assemble a complete engine request with sensible defaults for every input
the program reaches, then overlays the user-facing facts on top.

Re-run this whenever rulespec-us-co or rulespec-us change shape:
    bash scripts/build-artifacts.sh && python3 scripts/regenerate-co-snap-base.py
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

ARTIFACT = Path(
    "/Users/pavelmakarchuk/finbot-snap-demo/engine/artifacts/co-snap.compiled.json"
)
TEST_FIXTURE = Path(
    "/Users/pavelmakarchuk/finbot-snap-demo/engine/rulespec-us-co/policies/cdhs/snap/"
    "fy-2026-benefit-calculation.test.yaml"
)
OUTPUT = Path(
    "/Users/pavelmakarchuk/finbot-snap-demo/src/lib/programs/co-snap-base.ts"
)


def values_from_test_fixture() -> dict[str, dict]:
    """Authoritative dtypes AND default values for every input the verified
    test fixture sets. Returns ``{local_name: {dtype, default}}``.

    The fixture's first case is a complete, engine-accepted scenario, so it's
    the right ground truth where it overlaps with the inferred schema.
    """
    import yaml

    cases = yaml.safe_load(TEST_FIXTURE.read_text())
    out: dict[str, dict] = {}
    case = cases[0] if isinstance(cases, list) and cases else {}

    def js_dtype(v) -> str:
        if isinstance(v, bool):
            return "bool"
        if isinstance(v, int):
            return "integer"
        if isinstance(v, float):
            return "decimal"
        if isinstance(v, str) and len(v) == 10 and v[4] == "-" and v[7] == "-":
            return "date"
        return "text"

    def collect(scope_dict):
        for full_id, value in scope_dict.items():
            if "#input." not in full_id:
                continue
            local = full_id.split("#input.", 1)[1]
            out[local] = {"dtype": js_dtype(value), "default": value}

    inputs = case.get("input", {})
    if isinstance(inputs, dict):
        collect(inputs)
        members = inputs.get(
            "us:statutes/7/2012/j#relation.member_of_household", []
        )
        if isinstance(members, list):
            for m in members:
                if isinstance(m, dict):
                    collect(m)
    return out


# Aggregator IR kinds whose inner predicate flips entity scope to the relation's
# *related* entity. For this program there is exactly one relation,
# `member_of_household`, which connects Household ↔ Person, so any aggregator
# over it scopes inner inputs to Person.
RELATION_RELATED_ENTITY = {"member_of_household": "Person"}
AGGREGATOR_KINDS = {"count_related", "sum_related", "any_where", "all_where"}


def parents_of_input_refs(node, *, parent=None, scope_entity=None):
    """Yield (parent_expr, input_node, scope_entity) for every input ref in the IR.

    `scope_entity` flips when we descend into a relation aggregator's inner
    expression — that's the entity the input is keyed against in the dataset.
    """
    if isinstance(node, dict):
        if node.get("kind") == "input":
            yield (parent, node, scope_entity)
            return
        if node.get("kind") in AGGREGATOR_KINDS:
            inner_scope = RELATION_RELATED_ENTITY.get(node.get("relation"), scope_entity)
            for k, v in node.items():
                # Only recurse into the inner expression(s); skip metadata fields.
                if k in {"where", "value", "expr"}:
                    yield from parents_of_input_refs(v, parent=node, scope_entity=inner_scope)
            return
        for v in node.values():
            yield from parents_of_input_refs(v, parent=node, scope_entity=scope_entity)
    elif isinstance(node, list):
        for v in node:
            yield from parents_of_input_refs(v, parent=parent, scope_entity=scope_entity)


NUMERIC_PARENT_KINDS = {
    "add", "sub", "mul", "div", "min", "max", "floor", "ratio", "currency",
    "comparison", "abs", "round", "sum", "sum_related", "parameter_lookup",
}
DATE_PARENT_KINDS = {"date_add_days", "days_between", "period_start", "period_end"}


def infer_dtype(parent_kind: str | None, sibling: dict | None) -> str:
    """Best-effort dtype inference from the parent expression.

    Falls back to ``bool`` because most context-free input refs in axiom rules
    are predicate flags. Comparisons against integer or decimal literals yield
    integer/decimal respectively.
    """
    if parent_kind in {"and", "or", "not"}:
        return "bool"
    if parent_kind in DATE_PARENT_KINDS:
        return "date"
    if parent_kind == "comparison" and isinstance(sibling, dict):
        # Look at the sibling literal kind, e.g. `member_age >= 60`
        if sibling.get("kind") == "literal":
            inner = sibling.get("value", {})
            sub = inner.get("kind")
            if sub in {"integer", "decimal", "bool"}:
                return sub
    if parent_kind in NUMERIC_PARENT_KINDS:
        return "decimal"
    return "bool"


def find_input_dtypes(prog) -> dict[str, str]:
    """For every input name, pick the strongest dtype signal across all uses."""
    candidates: dict[str, list[str]] = {}
    for parent, node, _scope in parents_of_input_refs(prog):
        name = node["name"]
        parent_kind = parent.get("kind") if isinstance(parent, dict) else None

        # For comparison parents, find the *other* operand to read its literal type.
        sibling = None
        if parent_kind == "comparison" and isinstance(parent, dict):
            for k in ("left", "right"):
                v = parent.get(k)
                if v is not node and isinstance(v, dict):
                    sibling = v
                    break

        candidates.setdefault(name, []).append(infer_dtype(parent_kind, sibling))

    # Resolution: integer beats decimal beats date beats bool, then any concrete
    # dtype beats bool fallback. Tied ties → first observed.
    rank = {"integer": 4, "decimal": 3, "date": 2, "bool": 1}
    out: dict[str, str] = {}
    for name, dtypes in candidates.items():
        out[name] = max(dtypes, key=lambda d: rank.get(d, 0))
    return out


def find_inputs_by_entity(prog) -> dict[str, set[str]]:
    """Group input names by entity scope, accounting for relation aggregators
    that flip scope to the related entity.

    Note: an input may appear in multiple entity scopes if it's used both
    directly by an entity's rule AND inside a relation aggregator that targets
    that same entity from the other side. We let it land in every scope it's
    referenced in — the dataset just sets it on each entity it touches.
    """
    by_entity: dict[str, set[str]] = {}
    for rule in prog["derived"]:
        outer_entity = rule.get("entity", "Household")
        for _parent, node, scope in parents_of_input_refs(
            rule.get("expr"), scope_entity=outer_entity
        ):
            by_entity.setdefault(scope or outer_entity, set()).add(node["name"])
    return by_entity


def default_for(dtype: str):
    return {"bool": False, "integer": 0, "decimal": 0, "date": "2026-01-01"}.get(dtype, False)


def main() -> int:
    if not ARTIFACT.exists():
        print(f"artifact missing: {ARTIFACT}", file=sys.stderr)
        return 1
    artifact = json.loads(ARTIFACT.read_text())
    prog = artifact["program"]

    inferred_dtypes = find_input_dtypes(prog)
    fixture = values_from_test_fixture()
    by_entity = find_inputs_by_entity(prog)

    household = sorted(by_entity.get("Household", set()))
    person = sorted(by_entity.get("Person", set()))

    # Every encoded output, with entity scope and dtype. The chat surface
    # exposes the Household ones directly through compute_co_snap; the rest
    # are reachable via the lookup_value tool, which routes the query to the
    # right entity_id based on `entity`.
    all_outputs = []
    for rule in prog["derived"]:
        if not rule.get("id"):
            continue
        all_outputs.append({
            "name": rule["name"],
            "id": rule["id"],
            "entity": rule.get("entity", "Household"),
            "semantics": rule.get("semantics", "scalar"),
            "dtype": rule.get("dtype"),
            "unit": rule.get("unit"),
            "source": rule.get("source"),
        })

    # Quick by-name lookup for the Household-scope subset that compute_co_snap
    # surfaces. Keeps the existing buildRequest path simple.
    surface_outputs = {
        o["name"]: o["id"] for o in all_outputs if o["entity"] == "Household"
    }

    # Walk every rulespec YAML in rulespec-us and rulespec-us-co; map the file path
    # used as a legal-ID prefix (e.g. ``us:statutes/7/2017/a``) onto the
    # corpus_citation_path declared in module.source_verification (e.g.
    # ``us/statute/7/2017/a``). Used by fetch_citation so we hit a real
    # axiom-corpus document instead of the 404-prone structural rewrite.
    import yaml
    corpus_paths: dict[str, str] = {}
    repos = {
        "us": Path("/Users/pavelmakarchuk/finbot-snap-demo/engine/rulespec-us"),
        "us-co": Path("/Users/pavelmakarchuk/finbot-snap-demo/engine/rulespec-us-co"),
    }
    for prefix, root in repos.items():
        if not root.exists():
            continue
        for yaml_path in root.rglob("*.yaml"):
            if yaml_path.name.endswith(".test.yaml"):
                continue
            try:
                doc = yaml.safe_load(yaml_path.read_text())
            except Exception:
                continue
            if not isinstance(doc, dict) or doc.get("format") != "rulespec/v1":
                continue
            module = doc.get("module") or {}
            verification = (module.get("source_verification") or {}) if isinstance(module, dict) else {}
            corpus_path = None
            if isinstance(verification, dict):
                corpus_path = verification.get("corpus_citation_path")
                if not corpus_path:
                    paths = verification.get("corpus_citation_paths")
                    if isinstance(paths, list) and paths:
                        corpus_path = paths[0]
            if not corpus_path:
                continue
            # Build the legal-id prefix from the file path: e.g. file
            # rulespec-us-co/regulations/10-ccr-2506-1/4.207.3.yaml under repo
            # ``us-co`` becomes ``us-co:regulations/10-ccr-2506-1/4.207.3``.
            rel = yaml_path.relative_to(root).with_suffix("").as_posix()
            corpus_paths[f"{prefix}:{rel}"] = corpus_path

    def slot(name: str) -> dict:
        if name in fixture:
            return {"name": name, "dtype": fixture[name]["dtype"], "default": fixture[name]["default"]}
        dtype = inferred_dtypes.get(name, "bool")
        return {"name": name, "dtype": dtype, "default": default_for(dtype)}

    out = {
        "schema": "co-snap.fy-2026",
        "household_inputs": [slot(n) for n in household],
        "person_inputs": [slot(n) for n in person],
        "relations": ["us:statutes/7/2012/j#relation.member_of_household"],
        # surface outputs are the Household-scope subset compute_co_snap renders.
        "outputs_by_name": surface_outputs,
        # Every encoded output across the program; lookup_value uses this to
        # find an output's entity scope and dtype before querying.
        "all_outputs": all_outputs,
        # File-path → corpus_citation_path map for fetch_citation.
        "corpus_paths": corpus_paths,
    }

    body = (
        "// Auto-generated from engine/artifacts/co-snap.compiled.json.\n"
        "// Run: bash scripts/build-artifacts.sh && python3 scripts/regenerate-co-snap-base.py\n"
        "// Schema is derived from the compiled axiom-rules-engine program — every input the\n"
        "// engine reaches is listed here with an inferred dtype and a sensible default.\n"
        "// DO NOT EDIT BY HAND.\n\n"
        f"export const CO_SNAP_BASE = {json.dumps(out, indent=2)} as const;\n"
    )
    OUTPUT.write_text(body)
    print(
        f"wrote {OUTPUT.name}: {len(household)} household inputs, "
        f"{len(person)} person inputs, {len(surface_outputs)} surface outputs, "
        f"{len(all_outputs)} total outputs, {len(corpus_paths)} corpus-path mappings"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
