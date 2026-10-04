import { readFileSync } from "node:fs";
import path from "node:path";
import { runInNewContext } from "node:vm";
import * as ai from "ai";
import { convertArrayToReadableStream, MockLanguageModelV1 } from "ai/test";
import fc from "fast-check";
import posthog from "posthog-js";
import ts from "typescript";
import { afterEach, describe, expect, it, vi } from "vitest";

import { tools } from "./tools";

vi.mock("posthog-js", () => ({ default: { init: vi.fn() } }));

const recordingConsole = () => ({
  log: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(),
  debug: vi.fn(), trace: vi.fn(), table: vi.fn(),
});

// Execute the actual Next modules with their dependencies substituted. This
// avoids a DOM/test-renderer dependency and resolves the app's @/ aliases.
function loadSource<T>(file: string, modules: Record<string, unknown>, console: ReturnType<typeof recordingConsole>): T {
  const filename = path.resolve(__dirname, "..", file);
  const { outputText } = ts.transpileModule(readFileSync(filename, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
    fileName: filename,
  });
  const exports = {};
  runInNewContext(outputText, {
    exports, console, Error, Response, AbortSignal,
    process: { env: { OPENAI_API_KEY: "offline-test" } },
    require(name: string) {
      if (!(name in modules)) throw new Error(`Unmocked dependency: ${name}`);
      return modules[name];
    },
  }, { filename });
  return exports as T;
}

function chatErrorHandler(console: ReturnType<typeof recordingConsole>) {
  let options: { onError?: (error: Error) => void } | undefined;
  const stop = new Error("captured useChat options");
  const { Chat } = loadSource<{ Chat: () => unknown }>("components/Chat.tsx", {
    "@ai-sdk/react": { useChat(value: typeof options) { options = value; throw stop; } },
    "react": {}, "react/jsx-runtime": {},
    "@/lib/copy": {}, "@/lib/starters": {},
    "./AssistantTurn": {}, "./MarkdownText": {}, "./RunningPill": {},
  }, console);
  expect(() => Chat()).toThrow(stop);
  return (error: Error) => options?.onError?.(error);
}

afterEach(() => vi.unstubAllGlobals());

describe("conversation privacy", () => {
  it("explicitly disables PostHog console recording, overriding remote settings", async () => {
    vi.resetModules();
    vi.stubGlobal("window", {});
    await import("../instrumentation-client");
    expect(posthog.init).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({
      enable_recording_console_log: false,
    }));
  });

  it("keeps household facts out of the client console after a failed compute repair", async () => {
    const facts = { household_size: 3, monthly_income: 1373 };
    const repair = vi.fn().mockRejectedValue(new Error("repair failed"));
    const model = new MockLanguageModelV1({
      doStream: async () => ({
        stream: convertArrayToReadableStream([
          { type: "tool-call", toolCallType: "function", toolCallId: "bad-compute", toolName: "compute", args: JSON.stringify({ program: 123, facts }) },
          { type: "finish", finishReason: "tool-calls", usage: { promptTokens: 1, completionTokens: 1 } },
        ]),
        rawCall: { rawPrompt: null, rawSettings: {} },
      }),
    });
    const serverConsole = recordingConsole();
    const { POST } = loadSource<{ POST: (request: Request) => Promise<Response> }>("app/api/chat/route.ts", {
      "ai": { ...ai, generateObject: repair },
      "@/lib/model": { FINBOT_MODEL_NAME: "offline-test", finbotModel: () => model },
      "@/lib/prefetch": { prefetchSection: () => null },
      "@/lib/prompts": { buildSystemPrompt: () => "offline test" },
      "@/lib/rate-limit": { enforceRateLimit: () => null },
      "@/lib/tools": { tools },
    }, serverConsole);
    const response = await POST(new Request("http://localhost/api/chat", {
      method: "POST", body: JSON.stringify({ messages: [{ role: "user", content: "Compute my estimate." }] }),
    }));
    const body = await response.text();
    const errorPart = body.split("\n").find((line) => line.startsWith("3:"));
    expect(errorPart).toBeDefined();
    const message = JSON.parse(errorPart!.slice(2)) as string;
    expect(message).toContain("AI_InvalidToolArgumentsError");
    expect(message).toContain(JSON.stringify(facts));
    expect(repair).toHaveBeenCalledOnce();
    // The notice already discloses server failure logs; keep that behavior.
    expect(serverConsole.warn.mock.calls.flat().join(" ")).toContain(JSON.stringify(facts));

    const clientConsole = recordingConsole();
    chatErrorHandler(clientConsole)(new Error(message));
    for (const method of Object.values(clientConsole)) expect(method).not.toHaveBeenCalled();
  });

  it("never writes error facts to any client console method, for arbitrary household values", () => {
    const clientConsole = recordingConsole();
    const onError = chatErrorHandler(clientConsole);
    fc.assert(fc.property(
      fc.dictionary(fc.string({ minLength: 1 }), fc.oneof(fc.boolean(), fc.integer(), fc.string())),
      (facts) => {
        onError(new Error(`Invalid arguments for tool compute: ${JSON.stringify({ program: 123, facts })}`));
        for (const method of Object.values(clientConsole)) expect(method).not.toHaveBeenCalled();
      }
    ), { numRuns: 100 });
  });
});
