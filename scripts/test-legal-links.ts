import assert from "node:assert/strict";

import { legalIdToUrl } from "../src/lib/legal-links";

assert.equal(
  legalIdToUrl("uk:regulations/uksi/2013/376/24A"),
  "https://www.legislation.gov.uk/uksi/2013/376/regulation/24A"
);
assert.equal(
  legalIdToUrl("uk:regulations/uksi/2013/376/schedule/4/paragraph/22"),
  "https://www.legislation.gov.uk/uksi/2013/376/schedule/4/paragraph/22"
);
assert.equal(
  legalIdToUrl("uk:statutes/ukpga/2012/5/8"),
  "https://www.legislation.gov.uk/ukpga/2012/5/section/8"
);
assert.equal(
  legalIdToUrl("uk:statutes/ukpga/2007/3/35#personal_allowance"),
  "https://www.legislation.gov.uk/ukpga/2007/3/section/35"
);
assert.equal(
  legalIdToUrl("us:statutes/7/2017/a"),
  "https://app.axiom-foundation.org/us/statute/7/2017/a"
);

console.log("legal link checks passed");
