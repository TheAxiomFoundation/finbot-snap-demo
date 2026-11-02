import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import fc from "fast-check";
import ts from "typescript";
import { describe, expect, it } from "vitest";

// Run the real entry point against synthetic AI SDK stream data. Every
// case's numeric/tool requirements are satisfied so only the disclaimer
// being tested can change the eval outcome; no app or model is contacted.
const script = ts.transpileModule(
  readFileSync(new URL("./eval-llm.ts", import.meta.url), "utf8"),
  { compilerOptions: { target: ts.ScriptTarget.ES2022 } }
).outputText;

async function evaluateReply(reply: string) {
  const output: string[] = [];
  let exitCode: number | undefined;
  const amounts = [773, 994, 571, 572, 298, 923];
  const stream = [
    `0:${JSON.stringify(`${amounts.map((amount) => `$${amount}`).join(" ")}. Some programs are incomplete. WIC is not encoded. ${reply}`)}`,
    `9:${JSON.stringify({ toolName: "compute", args: {} })}`,
    `a:${JSON.stringify({ result: { amounts } })}`,
  ].join("\n");

  await runInNewContext(script, {
    AbortSignal,
    console: { log: (...args: unknown[]) => output.push(args.join(" ")) },
    fetch: async () => new Response(stream),
    process: { env: {}, exit: (code: number) => { exitCode = code; } },
  });

  return { exitCode, overclaims: output.filter((line) => line.includes("reply overclaims:")) };
}

const claim = fc.constantFrom(
  "certified", "verified", "validated", "guaranteed",
  "official determination", "official decision", "official answer", "official amount",
  "official figure", "official result", "official estimate"
);

describe("LLM eval overclaim negation", () => {
  it("accepts an ordinary no-guaranteed-amount disclaimer", async () => {
    expect(await evaluateReply("There is no guaranteed amount.")).toEqual({ exitCode: 0, overclaims: [] });
  });

  it("rejects an unrelated no before a guaranteed claim", async () => {
    const result = await evaluateReply("No problem, this is guaranteed.");
    expect(result.exitCode).toBe(1);
    expect(result.overclaims).toHaveLength(6);
    expect(result.overclaims.every((line) => line.includes('"guaranteed"'))).toBe(true);
  });

  it.each([
    "This is not guaranteed.",
    "This isn't guaranteed.",
    "This isn’t guaranteed.",
    "This is never guaranteed.",
    "This is not an official determination.",
    "This is not an official eligibility determination.",
    "This isn't an official SNAP benefit amount.",
    "The amount cannot be guaranteed.",
    "These figures have not been verified.",
    "It is not yet certified.",
    // Review of #75: a negation carries across a coordinated list of claim
    // words and adverbs.
    "These results are not certified or guaranteed.",
    "These figures have not been verified or certified.",
    "It is not officially certified.",
    "These are not legally verified figures.",
    "This estimate is not certified, verified, or guaranteed.",
    "Estimates, not official determinations.",
    "This is not your official California SNAP benefit amount.",
    "This is not the official, final determination.",
    "Axiom does not certify this amount.",
    "The amount is not officially determined.",
  ])("preserves the existing disclaimer: %s", async (reply) => {
    expect(await evaluateReply(reply)).toEqual({ exitCode: 0, overclaims: [] });
  });

  it("accepts no immediately before every forbidden claim regardless of case or whitespace", async () => {
    await fc.assert(fc.asyncProperty(
      claim, fc.constantFrom(" ", "  ", "\t", "\n"), fc.boolean(),
      async (word, space, uppercase) => {
        const phrase = `no${space}${word}`;
        expect(await evaluateReply(`There is ${uppercase ? phrase.toUpperCase() : phrase}.`))
          .toEqual({ exitCode: 0, overclaims: [] });
      }
    ));
  });

  it("does not let an unrelated no excuse any forbidden claim", async () => {
    await fc.assert(fc.asyncProperty(
      claim, fc.constantFrom(" problem, this is ", " worries; this is ", " delay: this is ", " problem. This is "),
      async (word, between) => {
        const result = await evaluateReply(`No${between}${word}.`);
        expect(result.exitCode).toBe(1);
        expect(result.overclaims).toHaveLength(6);
      }
    ));
  });

  // #35: a negation must modify the claim itself, and "official" with words
  // between it and its noun is still a claim.
  it.each([
    ["Do not worry; this is guaranteed.", "guaranteed"],
    ["Don't worry, this is guaranteed.", "guaranteed"],
    ["Never mind the details: it is verified.", "verified"],
    ["It's not complicated, and the result is certified.", "certified"],
    ["This is the official eligibility determination.", "official eligibility determination"],
    ["Not to worry, this is an official SNAP benefit amount.", "official SNAP benefit amount"],
    ["No problem: here is your official eligibility decision.", "official eligibility decision"],
    // Review of #75: overclaims that passed at 9f7da6e.
    ["This is your official California SNAP benefit amount.", "official California SNAP benefit amount"],
    ["This is the official, final determination.", "official, final determination"],
    ["Axiom certifies this amount.", "certifies"],
    ["Your amount is officially determined.", "officially determined"],
    // A list after a negation of something else is still a claim.
    ["Do not worry: it is certified, verified, and guaranteed.", "certified"],
  ])("rejects an overclaim the negation does not modify: %s", async (reply, claimed) => {
    const result = await evaluateReply(reply);
    expect(result.exitCode).toBe(1);
    expect(result.overclaims.filter((line) => line.includes(`"${claimed}"`))).toHaveLength(6);
  });

  it("carries a negation across any coordinated list of claim words and adverbs", async () => {
    const item = fc.constantFrom("certified", "verified", "validated", "guaranteed", "officially certified", "legally verified");
    const joiner = fc.constantFrom(" or ", ", or ", " nor ", ", ", " and ");
    await fc.assert(fc.asyncProperty(
      fc.constantFrom("not", "never", "cannot be", "isn't", "have not been"), fc.array(fc.tuple(joiner, item), { minLength: 1, maxLength: 3 }), item,
      async (negation, rest, first) => {
        const list = first + rest.map(([j, w]) => j + w).join("");
        expect(await evaluateReply(`These figures are ${negation} ${list}.`)).toEqual({ exitCode: 0, overclaims: [] });
      }
    ));
  });

  it("rejects any forbidden claim after a negation of something else", async () => {
    await fc.assert(fc.asyncProperty(
      claim, fc.constantFrom("Do not worry; this is ", "Don't panic, it is ", "Never fear: this is ", "It is not hard, and this is "),
      async (word, lead) => {
        const result = await evaluateReply(`${lead}${word}.`);
        expect(result.exitCode).toBe(1);
        expect(result.overclaims).toHaveLength(6);
      }
    ));
  });
});
