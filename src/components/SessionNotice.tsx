import Link from "next/link";

import type { CoverageSummary } from "@/lib/coverage";
import { coverageSentence } from "@/lib/coverage";
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
          <a href="https://www.fna.usda.gov/snap/state-directory" target="_blank" rel="noreferrer">
            SNAP offices by state
          </a>
          ,{" "}
          <a href="https://www.usa.gov/benefits" target="_blank" rel="noreferrer">
            other benefits
          </a>
          ,{" "}
          <a href="https://www.irs.gov/help/let-us-help-you" target="_blank" rel="noreferrer">
            IRS help
          </a>
          .
        </li>
        <li>
          <strong>It covers {coverage.total} programs:</strong> {coverageSentence(coverage)}. Axiom
          encoded their rules from statutes, regulations, and agency guidance.
          {coverage.incomplete > 0 && (
            <>
              {" "}
              For {coverage.incomplete} of them, the main result is flagged as not fully encoded yet.
            </>
          )}{" "}
          It can&rsquo;t estimate other programs or places.{" "}
          <details className="session-notice-details">
            <summary>Where each program applies</summary>
            <dl>
              {coverage.groups.map((group) => (
                <div key={group.key}>
                  <dt>{group.heading}</dt>
                  <dd>{group.members.join(", ")}</dd>
                </div>
              ))}
            </dl>
            <Link href="/programs">Full list of programs and outputs</Link>
          </details>
        </li>
        <li>
          <strong>Your messages are sent to {MODEL_PROVIDER},</strong> and the household details you give
          go to Axiom&rsquo;s rules engine to run the calculation. Don&rsquo;t include names, Social Security
          numbers, or case or account numbers.
        </li>
      </ul>
      <p className="session-notice-foot">
        For adults, or with a parent&rsquo;s or guardian&rsquo;s permission. Spot a wrong answer?{" "}
        <a href="https://axiom.org/contact" target="_blank" rel="noreferrer">
          Tell us
        </a>
        .
      </p>
    </section>
  );
}
