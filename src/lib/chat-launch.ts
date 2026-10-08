/** Link parameters are plain text and can only trigger a request with go=1. */
export const MAX_LINK_QUESTION_LENGTH = 500;

export interface ChatLaunch {
  compare: boolean;
  question: string;
  autoSubmit: boolean;
}

export function parseChatLaunch(search: string): ChatLaunch {
  const params = new URLSearchParams(search);
  // Remove control characters (except useful whitespace) and directional
  // controls; React renders the remaining question as text in the composer.
  const question = (params.get("q") ?? "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, "")
    .slice(0, MAX_LINK_QUESTION_LENGTH)
    .trim();
  return {
    compare: params.get("compare") === "1",
    question,
    autoSubmit: params.get("go") === "1" && question.length > 0,
  };
}

/** Keep questions out of analytics URLs while retaining other link options. */
export function withoutQuestionParam(href: string): string {
  try {
    const url = new URL(href);
    if (!url.searchParams.has("q")) return href;
    url.searchParams.delete("q");
    return url.href;
  } catch {
    return href;
  }
}

declare global {
  interface Window {
    __finbotChatLaunch?: ChatLaunch;
  }
}

/** Runs before analytics starts, preserving the question for React hydration. */
export function prepareChatLaunch(browser: Pick<Window, "location" | "history" | "__finbotChatLaunch">): void {
  if (!browser.location) return;
  browser.__finbotChatLaunch ??= parseChatLaunch(browser.location.search);
  const clean = withoutQuestionParam(browser.location.href);
  if (clean !== browser.location.href) {
    browser.history.replaceState(browser.history.state, "", clean);
  }
}
