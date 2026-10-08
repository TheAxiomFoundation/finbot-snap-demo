import Link from "next/link";

import type { CoverageSummary } from "@/lib/coverage";
import { coverageSentence, incompleteSentence } from "@/lib/coverage";
import { MODEL_PROVIDER } from "@/lib/model-label";

/**
 * A compact AI/estimate disclosure with details available on request.
 * Coverage is precomputed on the server to keep the catalog out of the bundle.
 */
export function SessionNotice({
  modelLabel,
  coverage,
}: {
  modelLabel: string;
  coverage: CoverageSummary;
}) {
  return (
    <section id="about-this-assistant" className="session-notice" aria-label="About this assistant">
      <p className="session-notice-line">
        AI replies from {MODEL_PROVIDER}&rsquo;s {modelLabel}. Estimates from encoded rules that may be incomplete.
      </p>
      <details className="session-notice-details">
        <summary>Details</summary>
        <div className="session-notice-body">
          <p>
            The AI and encoded rules can make mistakes. Answers are estimates, not agency decisions
            or tax or legal advice. For an official determination, contact your{" "}
            <ExternalLink href="https://www.fna.usda.gov/snap/state-directory">SNAP office</ExternalLink>,{" "}
            <ExternalLink href="https://www.usa.gov/benefits">benefits agency</ExternalLink> or{" "}
            <ExternalLink href="https://www.irs.gov/help/let-us-help-you">tax agency</ExternalLink>.
          </p>
          <p>
            {coverage.total} encoded programs: {coverageSentence(coverage)}. {incompleteSentence(coverage)}{" "}
            <Link href="/programs">See coverage by state and program</Link>.
          </p>
          <p>
            Messages go to {MODEL_PROVIDER}; calculation inputs go to Axiom&rsquo;s engine on Modal
            and may appear in server error logs. Google Analytics measures page views, scrolling,
            time on the page and outbound links. PostHog measures page use and records sessions,
            with the conversation, draft messages and chat errors masked; console recording is
            disabled. Prefilled question text is removed from the page URL before analytics starts.
            Initial link URLs can appear in hosting logs.
            Don&rsquo;t include names, Social Security numbers, or case or account numbers.
          </p>
          <p>
            Spot a wrong answer? <ExternalLink href="https://axiom.org/contact">Tell us</ExternalLink>.
          </p>
        </div>
      </details>
    </section>
  );
}

/** New-tab link that says so to screen readers: leaving would drop the chat. */
function ExternalLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noreferrer">
      {children}
      <span className="sr-only"> (opens in a new tab)</span>
    </a>
  );
}
