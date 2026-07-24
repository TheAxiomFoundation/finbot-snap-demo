import assert from "node:assert/strict";

import { legalIdToUrl } from "../src/lib/legal-links";

assert.equal(
  legalIdToUrl("us:statutes/7/2017/a"),
  "https://app.axiom-foundation.org/us/statute/7/2017/a"
);
assert.equal(
  legalIdToUrl("us:statutes/7/2017/a#snap_regular_month_allotment"),
  "https://app.axiom-foundation.org/us/statute/7/2017/a"
);
assert.equal(
  legalIdToUrl("us-co:regulations/10-ccr-2506-1/4.207.3"),
  "https://app.axiom-foundation.org/us-co/regulation/10-ccr-2506-1/4.207.3"
);
assert.equal(
  legalIdToUrl("us:policies/usda/snap/fy-2026-cola/maximum-allotments"),
  "https://app.axiom-foundation.org/us/policy/usda/snap/fy-2026-cola/maximum-allotments"
);

console.log("legal link checks passed");
