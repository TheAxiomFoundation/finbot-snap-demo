/**
 * Fetch the pinned rulespec-us program-artifacts release into engine/artifacts/.
 *
 * Reads artifacts.lock.json (the single pin for the whole app), downloads
 * manifest.json plus every `<slug>.compiled.json` / `<slug>.rulespec.yaml`
 * release asset, and verifies each compiled artifact against the manifest's
 * `artifact_sha256`. Files that already exist with a matching hash are skipped,
 * so re-runs are cheap and idempotent.
 *
 * Run: bun run artifacts:fetch   (or: npx tsx scripts/fetch-artifacts.ts)
 */
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(path.join(import.meta.dirname ?? __dirname, ".."));
const LOCK_PATH = path.join(ROOT, "artifacts.lock.json");
const ARTIFACTS_DIR = path.join(ROOT, "engine", "artifacts");

interface Lock {
  repo: string;
  release_tag: string;
  corpus_sha: string;
  engine: { repo: string; ref: string };
}

interface ManifestProgram {
  jurisdiction: string;
  program_id: string;
  period: string;
  spec_path: string;
  spec_sha256: string;
  outputs: string[];
  artifact: string;
  artifact_sha256: string;
  counts: { derived: number; parameters: number; relations: number };
}

export interface Manifest {
  format_version: number;
  corpus: { repo: string; sha: string; dirty: boolean };
  programs: ManifestProgram[];
}

function releaseAssetUrl(lock: Lock, asset: string): string {
  return `https://github.com/${lock.repo}/releases/download/${lock.release_tag}/${asset}`;
}

function sha256(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

async function fileSha256(p: string): Promise<string | null> {
  try {
    return sha256(await fs.readFile(p));
  } catch {
    return null;
  }
}

async function download(url: string): Promise<Buffer> {
  const r = await fetch(url, { redirect: "follow" });
  if (!r.ok) throw new Error(`download failed ${r.status}: ${url}`);
  return Buffer.from(await r.arrayBuffer());
}

async function main() {
  const lock = JSON.parse(await fs.readFile(LOCK_PATH, "utf8")) as Lock;
  await fs.mkdir(ARTIFACTS_DIR, { recursive: true });

  console.log(`==> release ${lock.release_tag} from ${lock.repo}`);
  const manifestBuf = await download(releaseAssetUrl(lock, "manifest.json"));
  const manifest = JSON.parse(manifestBuf.toString("utf8")) as Manifest;

  if (manifest.corpus.sha !== lock.corpus_sha) {
    throw new Error(
      `corpus sha mismatch: manifest says ${manifest.corpus.sha}, lock pins ${lock.corpus_sha}`
    );
  }
  if (manifest.corpus.dirty) {
    throw new Error("refusing a release built from a dirty corpus checkout");
  }
  await fs.writeFile(path.join(ARTIFACTS_DIR, "manifest.json"), manifestBuf);

  let downloaded = 0;
  let skipped = 0;
  for (const program of manifest.programs) {
    const slug = program.artifact.replace(/\.compiled\.json$/, "");

    // Compiled artifact — sha256-verified against the manifest.
    const artifactPath = path.join(ARTIFACTS_DIR, program.artifact);
    if ((await fileSha256(artifactPath)) === program.artifact_sha256) {
      skipped++;
    } else {
      const buf = await download(releaseAssetUrl(lock, program.artifact));
      const actual = sha256(buf);
      if (actual !== program.artifact_sha256) {
        throw new Error(
          `sha256 mismatch for ${program.artifact}: expected ${program.artifact_sha256}, got ${actual}`
        );
      }
      await fs.writeFile(artifactPath, buf);
      downloaded++;
      console.log(`  fetched ${program.artifact}`);
    }

    // Composed rulespec YAML — used by the catalog generator for module.summary.
    // The manifest doesn't hash it, so presence is the skip criterion.
    const yamlName = `${slug}.rulespec.yaml`;
    const yamlPath = path.join(ARTIFACTS_DIR, yamlName);
    try {
      await fs.access(yamlPath);
    } catch {
      const buf = await download(releaseAssetUrl(lock, yamlName));
      await fs.writeFile(yamlPath, buf);
      console.log(`  fetched ${yamlName}`);
    }
  }

  console.log(
    `==> ${manifest.programs.length} programs: ${downloaded} artifacts downloaded, ${skipped} already valid`
  );
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
