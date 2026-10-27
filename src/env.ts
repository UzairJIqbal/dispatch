import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { paths } from "./paths.js";

let loaded = false;

/** Loads .env once with Node's own loader. Variables already set win. */
export function loadEnv(): void {
  if (loaded) return;
  loaded = true;
  if (existsSync(paths.env)) process.loadEnvFile(paths.env);
}

let sha: string | undefined;

/** The commit that produced a result. GIT_SHA wins (set in Docker later); "-dirty" marks uncommitted changes. */
export function gitSha(): string {
  if (sha !== undefined) return sha;
  const fromEnv = process.env.GIT_SHA;
  if (fromEnv) return (sha = fromEnv);
  try {
    const head = execFileSync("git", ["rev-parse", "--short=12", "HEAD"], { cwd: paths.root, encoding: "utf8" }).trim();
    const dirty = execFileSync("git", ["status", "--porcelain"], { cwd: paths.root, encoding: "utf8" }).trim() !== "";
    sha = dirty ? `${head}-dirty` : head;
  } catch {
    sha = "unknown";
  }
  return sha;
}
