import { readFileSync } from "node:fs";
import path from "node:path";
import { runInNewContext } from "node:vm";
import fc from "fast-check";
import * as jsxRuntime from "react/jsx-runtime";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";

import { isFramed, MAX_LINK_QUESTION_LENGTH, parseChatLaunch, prepareChatLaunch, withoutQuestionParam } from "./chat-launch";

// Compile once during setup; each behavior test only executes the component.
const chatFilename = path.resolve(__dirname, "../components/Chat.tsx");
const chatSource = ts.transpileModule(readFileSync(chatFilename, "utf8"), {
  fileName: chatFilename,
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
}).outputText;

describe("chat link parameters", () => {
  it("prefills without submitting unless both a question and go=1 are present", () => {
    expect(parseChatLaunch("?q=Can+I+get+SNAP%3F&compare=1")).toEqual({
      compare: true, question: "Can I get SNAP?", autoSubmit: false,
    });
    expect(parseChatLaunch("?q=hello&go=1").autoSubmit).toBe(true);
    // Inside another site's frame, go=1 only prefills: no model call without a click.
    expect(parseChatLaunch("?q=hello&go=1", true).autoSubmit).toBe(false);
    expect(parseChatLaunch("?q=hello&go=1", true).question).toBe("hello");
    expect(parseChatLaunch("?go=1").autoSubmit).toBe(false);
    expect(parseChatLaunch("?q=%20%00&go=1").autoSubmit).toBe(false);
    expect(parseChatLaunch("?q=hello&go=true&compare=true")).toEqual({
      compare: false, question: "hello", autoSubmit: false,
    });
  });

  it("keeps arbitrary questions bounded and strips control characters", () => {
    fc.assert(fc.property(fc.string({ maxLength: 2000 }), (question) => {
      const result = parseChatLaunch(`?${new URLSearchParams({ q: question, go: "1" })}`);
      expect(result.question.length).toBeLessThanOrEqual(MAX_LINK_QUESTION_LENGTH);
      expect(result.question).not.toMatch(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/);
      expect(result.autoSubmit).toBe(result.question.length > 0);
    }));
    expect(parseChatLaunch(`?q=${"a".repeat(700)}`).question).toHaveLength(500);
  });

  it("preserves markup as plain text, including malformed percent encoding", () => {
    const question = '<script>alert("x")</script><img src=x onerror=alert(1)>';
    expect(parseChatLaunch(`?${new URLSearchParams({ q: question })}`).question).toBe(question);
    expect(parseChatLaunch("?q=%E0%A4%A").question.length).toBeGreaterThan(0);
  });

  it("removes all question values from analytics URLs and preserves other options", () => {
    fc.assert(fc.property(fc.string(), (question) => {
      const url = new URL("https://axiom.org/gallery/chatbot?compare=1&go=1#about-this-assistant");
      url.searchParams.append("q", question);
      url.searchParams.append("q", question);
      const clean = new URL(withoutQuestionParam(url.href));
      expect(clean.searchParams.has("q")).toBe(false);
      expect(clean.searchParams.get("compare")).toBe("1");
      expect(clean.searchParams.get("go")).toBe("1");
      expect(clean.hash).toBe(url.hash);
    }));
  });

  it("preserves launch options before clearing question text from the browser URL", () => {
    const replaceState = vi.fn();
    const browser = {
      location: { href: "https://axiom.org/gallery/chatbot?q=hello&compare=1&go=1", search: "?q=hello&compare=1&go=1" },
      history: { state: { existing: true }, replaceState },
    } as unknown as Parameters<typeof prepareChatLaunch>[0];
    prepareChatLaunch(browser);
    expect(browser.__finbotChatLaunch).toEqual({ compare: true, question: "hello", autoSubmit: true });
    expect(replaceState).toHaveBeenCalledWith({ existing: true }, "", "https://axiom.org/gallery/chatbot?compare=1&go=1");
  });
});

/** Exercise the actual component's startup effects without a browser or API. */
function chatHarness(search: string, savedLaunch?: ReturnType<typeof parseChatLaunch>) {
  const effects: Array<() => void> = [];
  const hookValues: unknown[] = [];
  const compareUpdates = vi.fn();
  let hookIndex = 0;
  const chat = {
    messages: [{ id: "existing", role: "assistant", content: "Earlier answer" }],
    input: "", isLoading: false, error: undefined,
    handleInputChange: vi.fn(), handleSubmit: vi.fn(), setInput: vi.fn(), setMessages: vi.fn(),
    append: vi.fn().mockResolvedValue("new-turn"),
  };
  chat.setInput.mockImplementation((value: string) => { chat.input = value; });
  const exports: { Chat?: () => React.ReactElement } = {};
  const modules: Record<string, unknown> = {
    "@ai-sdk/react": { useChat: () => chat },
    "react": {
      useState(initial: unknown) {
        const index = hookIndex++;
        if (!(index in hookValues)) hookValues[index] = initial;
        return [hookValues[index], (value: unknown) => {
          if (index === 0) compareUpdates(value);
          hookValues[index] = typeof value === "function" ? value(hookValues[index]) : value;
        }];
      },
      useRef(initial: unknown) {
        const index = hookIndex++;
        if (!(index in hookValues)) hookValues[index] = { current: initial };
        return hookValues[index];
      },
      useEffect(effect: () => void) { effects.push(effect); },
    },
    "react/jsx-runtime": jsxRuntime,
    "@/lib/copy": {}, "@/lib/starters": { STARTERS: [] },
    "@/lib/chat-launch": { parseChatLaunch },
    "./AssistantTurn": { AssistantTurn: () => null },
    "./MarkdownText": { MarkdownText: () => null }, "./RunningPill": { RunningPill: () => null },
  };
  const browser = { location: { search }, __finbotChatLaunch: savedLaunch };
  runInNewContext(chatSource, {
    exports, window: browser,
    require(name: string) {
      if (!(name in modules)) throw new Error(`Unmocked dependency: ${name}`);
      return modules[name];
    },
  });
  const render = () => {
    hookIndex = 0;
    const element = exports.Chat!();
    for (const effect of effects.splice(0)) effect();
    return element;
  };
  return { chat, compareUpdates, render, browser };
}

describe("Chat startup from links", () => {
  it("enables comparison and prefills a question without clearing existing messages", () => {
    const { chat, compareUpdates, render } = chatHarness("?compare=1&q=hello");
    render();
    expect(compareUpdates).toHaveBeenCalledWith(true);
    expect(chat.setMessages).not.toHaveBeenCalled();
    expect(chat.setInput).toHaveBeenCalledWith("hello");
    expect(chat.append).not.toHaveBeenCalled();
  });

  it("submits only once for go=1, including repeated startup effects", () => {
    const { chat, render } = chatHarness("?q=hello&go=1");
    render();
    render();
    expect(chat.append).toHaveBeenCalledExactlyOnceWith({ role: "user", content: "hello" });
    expect(chat.setMessages).not.toHaveBeenCalled();
  });

  it("uses the launch preserved before analytics stripped q from the address", () => {
    const { chat, compareUpdates, render, browser } = chatHarness("?compare=1&go=1", parseChatLaunch("?compare=1&go=1&q=hello"));
    render();
    expect(compareUpdates).toHaveBeenCalledWith(true);
    expect(chat.append).toHaveBeenCalledWith({ role: "user", content: "hello" });
    expect(browser.__finbotChatLaunch).toBeUndefined();
  });

  it("renders a prefilled markup payload as escaped textarea text", () => {
    const question = '<img src=x onerror="alert(1)"><script>alert(1)</script>';
    const { render } = chatHarness(`?${new URLSearchParams({ q: question })}`);
    render();
    const html = renderToStaticMarkup(render());
    expect(html).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<img");
  });
});

describe("isFramed", () => {
  it("detects frames, including a cross-origin top that throws", () => {
    const win = {} as { self: unknown; top: unknown };
    win.self = win;
    win.top = win;
    expect(isFramed(win)).toBe(false);
    expect(isFramed({ self: {}, top: {} })).toBe(true);
    const crossOrigin = { self: {} } as { self: unknown; top?: unknown };
    Object.defineProperty(crossOrigin, "top", { get() { throw new Error("SecurityError"); } });
    expect(isFramed(crossOrigin)).toBe(true);
  });
});
