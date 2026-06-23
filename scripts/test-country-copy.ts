import assert from "node:assert/strict";

import {
  countryFromRequestBody,
  countryFromSearchParams,
  inputPlaceholderForCountry,
  metadataForCountry,
  normalizeCountry,
  rawSystemPromptForCountry,
} from "../src/lib/country-copy";

const usPlaceholder = inputPlaceholderForCountry("us");
const ukPlaceholder = inputPlaceholderForCountry("uk");
const ukRawPrompt = rawSystemPromptForCountry("uk");
const usMetadata = metadataForCountry("us");
const ukMetadata = metadataForCountry("uk");

assert.equal(normalizeCountry("uk"), "uk");
assert.equal(normalizeCountry("us"), "us");
assert.equal(normalizeCountry("fr"), "us");
assert.equal(countryFromRequestBody({ country: "uk" }), "uk");
assert.equal(countryFromRequestBody({ country: "fr" }), "us");
assert.equal(countryFromSearchParams({ country: ["uk"] }), "uk");
assert.equal(countryFromSearchParams({ country: "uk" }), "uk");
assert.equal(countryFromSearchParams({ country: "us" }), "us");
assert.match(usPlaceholder, /SNAP/);
assert.match(usPlaceholder, /CO, CA, or NY/);
assert.match(ukPlaceholder, /Universal Credit/);
assert.match(ukPlaceholder, /personal allowance/);
assert.doesNotMatch(ukPlaceholder, /SNAP|CO, CA, or NY|Colorado|California|New York/);
assert.match(ukRawPrompt, /UK tax-and-benefits assistant/);
assert.match(ukRawPrompt, /Do not answer with US benefits/);
assert.match(ukRawPrompt, /SNAP\/Food Stamps/);
assert.match(ukRawPrompt, /Benefits\.gov/);
assert.match(usMetadata.description, /SNAP/);
assert.doesNotMatch(usMetadata.description, /Universal Credit/);
assert.match(ukMetadata.title, /Axiom-grounded tax and benefits/);
assert.doesNotMatch(ukMetadata.title, /FinBot/);
assert.doesNotMatch(usMetadata.title, /FinBot/);
assert.match(ukMetadata.description, /Universal Credit/);
assert.doesNotMatch(ukMetadata.description, /SNAP|Colorado|California|New York/);

console.log("country copy checks passed");
