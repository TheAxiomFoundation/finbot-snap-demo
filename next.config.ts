import type { NextConfig } from "next";
import path from "node:path";

const config: NextConfig = {
  // Pin the workspace root so Next doesn't grab the parent directory's lockfile.
  outputFileTracingRoot: path.resolve(__dirname),
};

export default config;
