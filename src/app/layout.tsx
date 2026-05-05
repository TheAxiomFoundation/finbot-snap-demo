import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "FinBot — Axiom-grounded benefits assistant",
  description:
    "OpenAI on top of the Axiom rules engine. Real Colorado SNAP allotments, real citations, no invented numbers.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
