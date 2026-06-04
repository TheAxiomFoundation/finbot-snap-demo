import type { Metadata } from "next";

import type { Country } from "@/lib/catalog";
import { countryFromSearchParams, metadataForCountry } from "@/lib/country-copy";
import { FinBotPage } from "@/components/FinBotPage";

interface PageProps {
  searchParams?: Promise<{
    country?: string | string[];
  }>;
}

export default async function Page({ searchParams }: PageProps) {
  const params = await searchParams;
  const initialCountry: Country = countryFromSearchParams(params);

  return <FinBotPage initialCountry={initialCountry} />;
}

export async function generateMetadata({ searchParams }: PageProps): Promise<Metadata> {
  const params = await searchParams;
  return metadataForCountry(countryFromSearchParams(params));
}
