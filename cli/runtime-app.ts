import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join, resolve } from "path";

/**
 * Where the installer points Claude Code's registrations:
 *  - "copy":     a stable copy in <state>/app (upstream default — editing or
 *                pulling the working copy can't break running sessions);
 *  - "in-place": the working copy itself, so a `git pull` is the deploy.
 */
export type RuntimeMode = "copy" | "in-place";

/** Per-machine marker in the state dir, so `upgrade` keeps the chosen mode. */
export const RUNTIME_MODE_FILE = "runtime-mode";

/**
 * Pick the mode: an explicit flag wins, then the saved marker, then an
 * existing registration that already points at the working copy (machines
 * wired by hand before the marker existed), else the upstream "copy" default.
 */
export function resolveRuntimeMode(
  args: string[],
  stateDir: string,
  projectRoot: string,
  registeredCwd?: string,
): RuntimeMode {
  if (args.includes("--in-place")) return "in-place";
  if (args.includes("--copy")) return "copy";
  try {
    const saved = readFileSync(join(stateDir, RUNTIME_MODE_FILE), "utf8").trim();
    if (saved === "in-place" || saved === "copy") return saved;
  } catch { /* no marker yet */ }
  if (registeredCwd && resolve(registeredCwd) === resolve(projectRoot)) return "in-place";
  return "copy";
}

export function saveRuntimeMode(stateDir: string, mode: RuntimeMode): void {
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(stateDir, RUNTIME_MODE_FILE), mode + "\n");
}

export const RUNTIME_DIRECTORIES = [
  "core",
  "server",
  "hooks",
  "statusline",
  "scripts",
] as const;

export const RUNTIME_FILES = ["package.json", "bun.lock"] as const;

export function stableRuntimeAppDir(stateDir: string): string {
  return join(stateDir, "app");
}

export function stableRuntimePaths(appDir: string) {
  return {
    mcpServer: join(appDir, "server", "index.ts"),
    mcpLauncher: join(appDir, "server", "mcp-launcher.sh"),
    statusline: join(appDir, "statusline", "buddy-status.sh"),
    combinedStatusline: join(appDir, "statusline", "combined-status.sh"),
    hooks: join(appDir, "hooks"),
  };
}

/**
 * Replace the stable runtime copy. The app directory is owned by the
 * installer, so removing it first also removes files deleted by an upgrade.
 */
export function copyRuntimeApp(sourceRoot: string, stateDir: string): string {
  const appDir = stableRuntimeAppDir(stateDir);
  rmSync(appDir, { recursive: true, force: true });
  mkdirSync(appDir, { recursive: true });

  for (const directory of RUNTIME_DIRECTORIES) {
    const source = join(sourceRoot, directory);
    if (!existsSync(source)) throw new Error(`Missing runtime directory: ${source}`);
    cpSync(source, join(appDir, directory), { recursive: true, force: true });
  }

  for (const file of RUNTIME_FILES) {
    const source = join(sourceRoot, file);
    if (existsSync(source)) cpSync(source, join(appDir, file), { force: true });
  }

  return appDir;
}
