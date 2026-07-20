import type { Metadata } from "next";

import { PAGE_METADATA } from "@/lib/copy";
import { FinBotPage } from "@/components/FinBotPage";

export const metadata: Metadata = PAGE_METADATA;

export default function Page() {
  return <FinBotPage />;
}
