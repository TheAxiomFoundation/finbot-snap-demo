import Link from "next/link";

import type { CoverageSummary } from "@/lib/coverage";
import { coverageSentence, incompleteSentence } from "@/lib/coverage";
import { MODEL_PROVIDER } from "@/lib/model-label";

/**
 * The notice every chat session starts under: an AI (named) writes the
 * replies, the answers are estimates rather than determinations, and the
 * assistant covers exactly the programs in the pinned catalog. Rendered
 * above the starters and the conversation, so it is the first thing in
 * view for every session, including after a starter or the compare toggle
 * resets the conversation.
 *
 * Coverage arrives precomputed from the server: the catalog itself is
 * several megabytes and must stay out of the client bundle.
 */
export function SessionNotice({
  modelLabel,
  coverage,
}: {
  modelLabel: string;
  coverage: CoverageSummary;
}) {
  return (
    <section id="about-this-assistant" className="session-notice" aria-labelledby="session-notice-title">
      <h2 id="session-notice-title" className="session-notice-title">
        You&rsquo;re chatting with an AI
      </h2>
      <ul className="session-notice-list">
        <li>
          <strong>An AI model writes every reply.</strong> This assistant runs on {MODEL_PROVIDER}&rsquo;s{" "}
          {modelLabel}. It is not a person and not a government agency.
        </li>
        <li>
          <strong>Answers are estimates, not determinations.</strong> They are not an application, an
          eligibility decision, or tax or legal advice, and shouldn&rsquo;t be used to decide anyone&rsquo;s
          eligibility. The model can misread a question or make mistakes, and the encoded rules can contain
          errors.
        </li>
        <li>
          <strong>For an official answer, go to the agency.</strong> Only the agency that runs a program can
          decide whether you qualify and how much you would get:{" "}
          <ExternalLink href="https://www.fna.usda.gov/snap/state-directory">SNAP offices by state</ExternalLink>,{" "}
          <ExternalLink href="https://www.usa.gov/benefits">other benefits</ExternalLink>,{" "}
          <ExternalLink href="https://www.irs.gov/help/let-us-help-you">IRS help</ExternalLink> or your
          state tax agency.
        </li>
        <li>
          <strong>It covers {coverage.total} programs:</strong> {coverageSentence(coverage)}. Axiom
          encoded their rules from statutes, regulations, and agency guidance. {incompleteSentence(coverage)}{" "}
          It is set up to estimate only these programs and should tell you when a question falls outside
          them.{" "}
          <details className="session-notice-details">
            <summary>What each group includes</summary>
            <dl>
              {coverage.groups.map((group) => (
                <div key={group.key}>
                  <dt>{group.heading}</dt>
                  <dd>
                    {group.members.join(", ")}
                    {group.flagged > 0 && (
                      <span className="session-notice-flagged">
                        {" "}
                        · {group.flagged === group.count
                          ? group.count === 1
                            ? "has flagged results"
                            : "all have flagged results"
                          : `${group.flagged} of ${group.count} have flagged results`}
                      </span>
                    )}
                  </dd>
                </div>
              ))}
            </dl>
            <Link href="/programs">Full list of programs and outputs</Link>
          </details>
        </li>
        <li>
          <strong>Your messages are sent to {MODEL_PROVIDER},</strong> and the household details you give
          go to Axiom&rsquo;s rules engine, hosted on Modal, to run the calculation. OpenAI may keep messages
          for a time, this site&rsquo;s server logs may record the details when a calculation fails, and the
          page uses Google Analytics and PostHog. Don&rsquo;t include names, Social Security numbers, or case
          or account numbers.
        </li>
      </ul>
      <p className="session-notice-foot">
        For adults, or with a parent&rsquo;s or guardian&rsquo;s permission. Spot a wrong answer?{" "}
        <ExternalLink href="https://axiom.org/contact">Tell us</ExternalLink>.
      </p>
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
