import type { NextConfig } from "next";
import path from "node:path";

const config: NextConfig = {
  // Served under https://axiom.org/chatbot via the main site's reverse proxy.
  basePath: "/chatbot",
  // Pin the workspace root so Next doesn't grab the parent directory's lockfile.
  outputFileTracingRoot: path.resolve(__dirname),
};

export default config;
