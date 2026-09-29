import type { Metadata } from "next";

import { PAGE_METADATA } from "@/lib/copy";
import { getCatalog } from "@/lib/catalog";
import { summarizeCoverage } from "@/lib/coverage";
import { FINBOT_MODEL_NAME } from "@/lib/model";
import { modelDisplayName } from "@/lib/model-label";
import { FinBotPage } from "@/components/FinBotPage";

export const metadata: Metadata = PAGE_METADATA;

export default function Page() {
  // Both read at build time. That matches what the deployment serves:
  // Vercel applies a changed FINBOT_MODEL only to new deployments, and a
  // new release pin means a new catalog and a new build.
  const coverage = summarizeCoverage(getCatalog().programs, (p) => p.display_name);
  return <FinBotPage modelLabel={modelDisplayName(FINBOT_MODEL_NAME)} coverage={coverage} />;
}
