import type { NextConfig } from "next";
import path from "node:path";

const config: NextConfig = {
  // Served under https://axiom.org/gallery/chatbot via the main site's
  // reverse proxy, like the other demos in the gallery.
  basePath: "/gallery/chatbot",
  // Pin the workspace root so Next doesn't grab the parent directory's lockfile.
  outputFileTracingRoot: path.resolve(__dirname),
};

export default config;
