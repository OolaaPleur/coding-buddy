import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  copyRuntimeApp,
  resolveRuntimeMode,
  saveRuntimeMode,
  stableRuntimeAppDir,
  stableRuntimePaths,
} from "./runtime-app.ts";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("stable runtime app", () => {
  test("derives all registrations below the per-user app directory", () => {
    const paths = stableRuntimePaths("/home/user/.claude-buddy/app");

    expect(paths.mcpServer).toBe("/home/user/.claude-buddy/app/server/index.ts");
    expect(paths.mcpLauncher).toBe("/home/user/.claude-buddy/app/server/mcp-launcher.sh");
    expect(paths.statusline).toBe("/home/user/.claude-buddy/app/statusline/buddy-status.sh");
    expect(paths.combinedStatusline).toBe("/home/user/.claude-buddy/app/statusline/combined-status.sh");
    expect(paths.hooks).toBe("/home/user/.claude-buddy/app/hooks");
  });

  test("refreshes the copy and removes stale runtime files", () => {
    const root = mkdtempSync(join(tmpdir(), "coding-buddy-runtime-app-"));
    temporaryDirectories.push(root);
    for (const directory of ["core", "server", "hooks", "statusline", "scripts"]) {
      mkdirSync(join(root, directory), { recursive: true });
      writeFileSync(join(root, directory, "runtime.txt"), directory);
    }
    writeFileSync(join(root, "package.json"), "{\"name\":\"test\"}");

    const stateDir = join(root, "state");
    const appDir = copyRuntimeApp(root, stateDir);
    const stale = join(appDir, "stale.txt");
    writeFileSync(stale, "remove me");
    writeFileSync(join(root, "statusline", "runtime.txt"), "updated");

    expect(copyRuntimeApp(root, stateDir)).toBe(stableRuntimeAppDir(stateDir));
    expect(existsSync(stale)).toBe(false);
    expect(readFileSync(join(appDir, "statusline", "runtime.txt"), "utf8")).toBe("updated");
  });
});

describe("runtime mode", () => {
  function freshStateDir(): string {
    const dir = mkdtempSync(join(tmpdir(), "coding-buddy-runtime-mode-"));
    temporaryDirectories.push(dir);
    return dir;
  }

  test("defaults to the upstream copy mode", () => {
    expect(resolveRuntimeMode([], freshStateDir(), "/src/buddy")).toBe("copy");
  });

  test("explicit flags win over the saved marker", () => {
    const stateDir = freshStateDir();
    saveRuntimeMode(stateDir, "copy");
    expect(resolveRuntimeMode(["--in-place"], stateDir, "/src/buddy")).toBe("in-place");
    saveRuntimeMode(stateDir, "in-place");
    expect(resolveRuntimeMode(["--copy"], stateDir, "/src/buddy")).toBe("copy");
  });

  test("a saved marker survives a flagless reinstall (upgrade)", () => {
    const stateDir = freshStateDir();
    saveRuntimeMode(stateDir, "in-place");
    expect(resolveRuntimeMode([], stateDir, "/src/buddy")).toBe("in-place");
  });

  test("a registration already pointing at the working copy means in-place", () => {
    const stateDir = freshStateDir();
    expect(resolveRuntimeMode([], stateDir, "/src/buddy", "/src/buddy/")).toBe("in-place");
    expect(resolveRuntimeMode([], stateDir, "/src/buddy", join(stateDir, "app"))).toBe("copy");
  });

  test("an unknown marker value is ignored", () => {
    const stateDir = freshStateDir();
    writeFileSync(join(stateDir, "runtime-mode"), "bogus\n");
    expect(resolveRuntimeMode([], stateDir, "/src/buddy")).toBe("copy");
  });
});
