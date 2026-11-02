import posthog from "posthog-js";

import { prepareChatLaunch } from "./lib/chat-launch";

declare global {
  interface Window {
    __posthogInitialized?: boolean;
  }
}

if (typeof window !== "undefined" && !window.__posthogInitialized) {
  // A prefilled question is chat content. Remove it from the address before
  // PostHog pageviews/replay and the later Google Analytics scripts start.
  prepareChatLaunch(window);
  window.__posthogInitialized = true;
  posthog.init("phc_mrEaBroaYTRUrdkfhJYBGMpafKXWEdUyw5VPQnheh37m", {
    api_host: "https://us.i.posthog.com",
    defaults: "2026-01-30",
    person_profiles: "identified_only",
    respect_dnt: true,
    capture_pageview: "history_change",
    // Console events bypass ph-no-capture and can contain tool arguments.
    enable_recording_console_log: false,
    // Request and response bodies carry household facts and replies, both
    // ways. posthog-js lets a local false override the project's remote
    // network-capture setting, so replays never record them whatever the
    // dashboard says (the session notice promises the conversation is masked).
    session_recording: { recordBody: false, recordHeaders: false },
  });
}
