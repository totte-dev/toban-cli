/**
 * Detect the correct install command based on lockfile presence.
 * Supports bun, pnpm, yarn, and npm.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";

export function detectInstallCommand(dir: string): string | null {
  if (existsSync(join(dir, "bun.lockb")) || existsSync(join(dir, "bun.lock"))) return "bun install";
  if (existsSync(join(dir, "pnpm-lock.yaml"))) return "pnpm install";
  if (existsSync(join(dir, "yarn.lock"))) return "yarn install";
  if (existsSync(join(dir, "package-lock.json"))) return "npm ci";
  if (existsSync(join(dir, "package.json"))) return "npm install";
  return null;
}
