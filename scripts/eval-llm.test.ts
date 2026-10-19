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
});
