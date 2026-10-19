/**
 * Member-scope slots that request-builder assumes when the user states
 * nothing about them (MEMBER_ASSUMPTIONS in request-builder.ts). For each
 * one the catalog generator lists the outputs whose rule chain reads it
 * (`read_by` on the slot), so a lookup discloses the assumption only when
 * its output depends on it. Kept out of request-builder so the generator
 * can import it without loading the catalog.
 */
export const ASSUMED_MEMBER_SLOTS = [
  "member_is_us_citizen",
  "qualified_individual_social_security_number_included_on_return",
] as const;

export type AssumedMemberSlot = (typeof ASSUMED_MEMBER_SLOTS)[number];
