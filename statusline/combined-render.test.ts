import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Rendering tests for combined-status.sh: prompt-cache countdown on the model
// line, rate-limit reset handling, and the widest-variant-that-fits fallback.

const temporaryDirectories: string[] = [];
const combinedScript = join(import.meta.dir, "combined-status.sh");
const buddyScript = join(import.meta.dir, "buddy-status.sh");

const ESC = "\x1b";
const DIM = `${ESC}[2m`;
const GREEN = `${ESC}[32m`;
const YELLOW = `${ESC}[33m`;
const RED = `${ESC}[31m`;
const NC = `${ESC}[0m`;
const BRAILLE = "⠀";

// Art rows carry a unique marker so the stat text left of the art can be cut
// out of a rendered line without guessing at column positions.
const ART_ROWS = ["<A0>", "<A1>", "<A2>", "<A3>", "<A4>"];
const SPAWN_TIMEOUT_MS = 30_000;

function makeTempDir(prefix: string) {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

// Same shape as createStatuslineFixture in buddy-status.test.ts, plus a
// per-test XDG_STATE_HOME for the context-history files.
function createFixture(name = "Nimbus") {
  const configDir = makeTempDir("coding-buddy-combined-");
  const xdgStateHome = makeTempDir("coding-buddy-combined-xdg-");
  const stateDir = join(configDir, "buddy-state");
  mkdirSync(stateDir);
  writeFileSync(join(stateDir, "config.json"), JSON.stringify({}));
  writeFileSync(join(stateDir, "status.json"), JSON.stringify({
    name,
    rarity: "common",
    stars: "",
    shiny: false,
    reaction: "",
    achievement: "",
    level: 1,
    mood: "focused",
    frames: [ART_ROWS.join("\n")],
    frameSequence: [0],
  }));
  return { configDir, xdgStateHome };
}

type Fixture = ReturnType<typeof createFixture>;

function run(script: string, fixture: Fixture, input: unknown, columns: number) {
  const result = spawnSync("bash", [script], {
    env: {
      ...process.env,
      CLAUDE_CONFIG_DIR: fixture.configDir,
      XDG_STATE_HOME: fixture.xdgStateHome,
      CLAUDE_CODE_SESSION_ID: "",
      TMUX_PANE: "",
      BUDDY_FAKE_NOW: "0",
      BUDDY_STATUSLINE_ROWS: "50",
      BUDDY_STATUSLINE_COLS: String(columns),
      TERM: "xterm-256color",
      NO_COLOR: "",
      BUDDY_SHELL: "",
      BUDDY_DISABLE: "",
    },
    input: `${JSON.stringify(input)}\n`,
    stdout: "pipe",
    stderr: "pipe",
  });
  const raw = result.stdout.toString();
  return { status: result.status, raw, plain: stripAnsi(raw) };
}

function runCombined(fixture: Fixture, input: unknown, columns = 120) {
  return run(combinedScript, fixture, input, columns);
}

function stripAnsi(text: string) {
  return text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
}

// The stat text merged into each art row (rows 1..4), "" when nothing was merged.
function statTexts(plain: string) {
  const lines = plain.split("\n");
  return ART_ROWS.slice(1).map((marker) => {
    const line = lines.find((candidate) => candidate.includes(marker));
    if (line === undefined) throw new Error(`art row ${marker} missing from output:\n${plain}`);
    expect(line.startsWith(BRAILLE)).toBe(true);
    return line.slice(BRAILLE.length, line.indexOf(marker)).trimEnd();
  });
}

function statStartingWith(plain: string, prefix: string) {
  return statTexts(plain).find((text) => text.startsWith(prefix));
}

function nowSeconds() {
  return Math.floor(Date.now() / 1000);
}

const MODEL = {
  model: { id: "claude-opus-5-5", display_name: "Opus 5.5" },
  effort: { level: "high" },
  thinking: { enabled: true },
};
const MODEL_TEXT = "Opus 5.5 [hig] ~";

function baseInput(extra: Record<string, unknown> = {}) {
  return {
    context_window: { used_percentage: 16 },
    ...MODEL,
    ...extra,
  };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("combined statusline: prompt-cache countdown", () => {
  function renderCache(expiresAt: unknown) {
    const fixture = createFixture();
    const result = runCombined(fixture, baseInput({ prompt_cache: { expires_at: expiresAt } }));
    expect(result.status).toBe(0);
    return { ...result, modelLine: statStartingWith(result.plain, "Opus 5.5") };
  }

  test("shows a dim minutes countdown when more than 10 minutes remain", () => {
    const { raw, modelLine } = renderCache(nowSeconds() + 2820);

    expect(modelLine).toMatch(/^Opus 5\.5 \[hig\] ~ {2}cache 4[67]m$/);
    expect(raw).toMatch(/ {2}\x1b\[2mcache 4[67]m\x1b\[0m/);
    expect(raw).not.toContain(`${YELLOW}cache`);
    expect(raw).not.toContain(`${RED}cache`);
  });

  test("uses the hours style from fmt_countdown beyond one hour", () => {
    const { raw, modelLine } = renderCache(nowSeconds() + 3750);

    expect(modelLine).toMatch(/^Opus 5\.5 \[hig\] ~ {2}cache 1h0[12]m$/);
    expect(raw).toMatch(/\x1b\[2mcache 1h0[12]m\x1b\[0m/);
  });

  test("stays dim just above the 10 minute threshold", () => {
    const { raw, modelLine } = renderCache(nowSeconds() + 660);

    expect(modelLine).toMatch(/ {2}cache 1[01]m$/);
    expect(raw).toMatch(/\x1b\[2mcache 1[01]m\x1b\[0m/);
  });

  test("turns yellow under 10 minutes", () => {
    const { raw, modelLine } = renderCache(nowSeconds() + 540);

    expect(modelLine).toMatch(/^Opus 5\.5 \[hig\] ~ {2}cache [89]m$/);
    expect(raw).toMatch(/ {2}\x1b\[33mcache [89]m\x1b\[0m/);
    expect(raw).not.toContain(`${DIM}cache`);
  });

  test("shows <1m in yellow under 60 seconds", () => {
    const { raw, modelLine } = renderCache(nowSeconds() + 45);

    expect(modelLine).toBe(`${MODEL_TEXT}  cache <1m`);
    expect(raw).toContain(`  ${YELLOW}cache <1m${NC}`);
  });

  test.each([
    ["just expired", -5],
    ["expired an hour ago", -3600],
  ])("shows COLD in red when %s", (_label, offset) => {
    const { raw, modelLine } = renderCache(nowSeconds() + offset);

    expect(modelLine).toBe(`${MODEL_TEXT}  cache COLD`);
    expect(raw).toContain(`  ${RED}cache COLD${NC}`);
  });

  test("leaves the model line unchanged without a prompt_cache field", () => {
    const fixture = createFixture();
    const result = runCombined(fixture, baseInput());

    expect(result.status).toBe(0);
    expect(statStartingWith(result.plain, "Opus 5.5")).toBe(MODEL_TEXT);
    expect(result.plain).not.toContain("cache");
    expect(result.raw).toContain(`${DIM}Opus 5.5${NC}${DIM} [hig] ~${NC}`);
  });

  test.each([
    ["null expires_at", { expires_at: null }],
    ["empty prompt_cache", {}],
  ])("shows no cache text for %s", (_label, promptCache) => {
    const fixture = createFixture();
    const result = runCombined(fixture, baseInput({ prompt_cache: promptCache }));

    expect(result.status).toBe(0);
    expect(statStartingWith(result.plain, "Opus 5.5")).toBe(MODEL_TEXT);
    expect(result.plain).not.toContain("cache");
  });
});

describe("combined statusline: rate-limit reset", () => {
  function renderLimits(rateLimits: Record<string, unknown> | undefined) {
    const fixture = createFixture();
    const result = runCombined(fixture, baseInput(rateLimits ? { rate_limits: rateLimits } : {}));
    expect(result.status).toBe(0);
    return {
      ...result,
      fiveHour: statStartingWith(result.plain, "5h"),
      sevenDay: statStartingWith(result.plain, "7d"),
    };
  }

  test("shows the percentage and a countdown while the window is still open", () => {
    const now = nowSeconds();
    const { raw, fiveHour, sevenDay } = renderLimits({
      five_hour: { used_percentage: 63, resets_at: now + 9800 },
      seven_day: { used_percentage: 11, resets_at: now + 200_000 },
    });

    expect(fiveHour).toMatch(/^5h {2}63% █{6}░{4} 2h4[23]m$/);
    expect(sevenDay).toBe("7d  11% █░░░░░░░░░ 2d7h");
    expect(raw).toContain(`${YELLOW} 63%${NC}`);
    expect(raw).toContain(`${GREEN} 11%${NC}`);
    expect(raw).toMatch(/\x1b\[2m 2h4[23]m\x1b\[0m/);
    expect(raw).toContain(`${DIM} 2d7h${NC}`);
  });

  test("shows 0% with an empty bar and no countdown once resets_at has passed", () => {
    const now = nowSeconds();
    const { raw, fiveHour, sevenDay } = renderLimits({
      five_hour: { used_percentage: 63, resets_at: now - 60 },
      seven_day: { used_percentage: 88, resets_at: now - 86_400 },
    });

    expect(fiveHour).toBe("5h   0% ░░░░░░░░░░");
    expect(sevenDay).toBe("7d   0% ░░░░░░░░░░");
    expect(raw).toContain(`${DIM}5h${NC} ${GREEN}  0%${NC} ${GREEN}${NC}${DIM}░░░░░░░░░░${NC}`);
    expect(raw).not.toContain("63%");
    expect(raw).not.toContain("88%");
  });

  test("resets each window independently", () => {
    const now = nowSeconds();
    const { fiveHour, sevenDay } = renderLimits({
      five_hour: { used_percentage: 63, resets_at: now - 60 },
      seven_day: { used_percentage: 11, resets_at: now + 200_000 },
    });

    expect(fiveHour).toBe("5h   0% ░░░░░░░░░░");
    expect(sevenDay).toBe("7d  11% █░░░░░░░░░ 2d7h");
  });

  test("keeps the percentage and shows no countdown when resets_at is missing", () => {
    const { fiveHour } = renderLimits({ five_hour: { used_percentage: 63 } });

    expect(fiveHour).toBe("5h  63% ██████░░░░");
  });

  test("omits a line whose percentage is absent", () => {
    const now = nowSeconds();
    const { plain, fiveHour, sevenDay } = renderLimits({
      five_hour: { resets_at: now + 9800 },
      seven_day: { used_percentage: 11, resets_at: now + 200_000 },
    });

    expect(fiveHour).toBeUndefined();
    expect(sevenDay).toBe("7d  11% █░░░░░░░░░ 2d7h");
    // The remaining lines close the gap: ctx, 7d, model on consecutive rows.
    expect(statTexts(plain)).toEqual(["ctx  16% ██░░░░░░░░", "7d  11% █░░░░░░░░░ 2d7h", MODEL_TEXT, ""]);
  });

  test("omits both lines without rate_limits", () => {
    const { plain, fiveHour, sevenDay } = renderLimits(undefined);

    expect(fiveHour).toBeUndefined();
    expect(sevenDay).toBeUndefined();
    expect(statTexts(plain)).toEqual(["ctx  16% ██░░░░░░░░", MODEL_TEXT, "", ""]);
  });

  // Found while writing these tests, not fixed here: fmt_countdown returns
  // " 0m" for a reset less than 60 s away, so the 5h/7d line reads
  // "5h  63% ██████░░░░ 0m" for the last minute of a window. The cache
  // countdown special-cases the same range as "<1m".
  test.todo("shows a sub-minute rate-limit countdown as something other than 0m");
});

describe("combined statusline: width fallback", () => {
  // A long buddy name widens the sprite column, which shrinks the run of
  // leading spaces the stats are merged into. With the default short name the
  // panel never gets narrow enough to leave the tokens-only variant.
  const WIDE_NAME = "Nimbus-The-Wide-Penguin";
  const WIDTHS = [140, 110, 100, 90, 80, 74, 70, 66, 62, 58, 54, 40];
  const CTX_BASE = "ctx  16% ██░░░░░░░░";
  const CTX_TOKENS = `${CTX_BASE} 311k/1M`;
  const CTX_FULL = /^ctx {2}16% ██░░░░░░░░ 311k\/1M [▁▂▃▄▅▆▇█]{2} \+161k$/;
  const SESSION_ID = "combined-render-width";

  function widthInput(tokens: number) {
    const now = nowSeconds();
    return {
      session_id: SESSION_ID,
      context_window: {
        used_percentage: 16,
        context_window_size: 1_000_000,
        current_usage: {
          input_tokens: tokens - 1200,
          cache_creation_input_tokens: 200,
          cache_read_input_tokens: 1000,
        },
      },
      ...MODEL,
      prompt_cache: { expires_at: now + 2820 },
      rate_limits: {
        five_hour: { used_percentage: 63, resets_at: now + 9800 },
        seven_day: { used_percentage: 11, resets_at: now + 200_000 },
      },
    };
  }

  // Two samples for the same session and state dir are needed before the
  // sparkline and delta exist; later renders at the same token count reuse them.
  function primedFixture() {
    const fixture = createFixture(WIDE_NAME);
    expect(runCombined(fixture, widthInput(150_000), 140).status).toBe(0);
    return fixture;
  }

  function ctxRank(text: string) {
    if (CTX_FULL.test(text)) return 3;
    if (text === CTX_TOKENS) return 2;
    if (text === CTX_BASE) return 1;
    if (text === "") return 0;
    throw new Error(`unexpected ctx line: ${JSON.stringify(text)}`);
  }

  function modelRank(text: string) {
    if (/^Opus 5\.5 \[hig\] ~ {2}cache 4[67]m$/.test(text)) return 2;
    if (text === MODEL_TEXT) return 1;
    if (text === "") return 0;
    throw new Error(`unexpected model line: ${JSON.stringify(text)}`);
  }

  function sweep() {
    const fixture = primedFixture();
    return WIDTHS.map((columns) => {
      const result = runCombined(fixture, widthInput(311_000), columns);
      expect(result.status).toBe(0);
      const [ctx, , , model] = statTexts(result.plain);
      return { columns, ctx: ctxRank(ctx), model: modelRank(model), result };
    });
  }

  function expectNeverWidens(ranks: number[]) {
    for (let index = 1; index < ranks.length; index++) {
      expect(ranks[index]).toBeLessThanOrEqual(ranks[index - 1]);
    }
  }

  test("first render of a session shows tokens without sparkline or delta", () => {
    const fixture = createFixture(WIDE_NAME);
    const result = runCombined(fixture, widthInput(311_000), 140);

    expect(result.status).toBe(0);
    expect(statTexts(result.plain)[0]).toBe(CTX_TOKENS);
  });

  test("second sample adds a coloured sparkline and the turn delta", () => {
    const fixture = primedFixture();
    const result = runCombined(fixture, widthInput(311_000), 140);

    expect(result.status).toBe(0);
    expect(statTexts(result.plain)[0]).toBe(`${CTX_TOKENS} ▄█ +161k`);
    expect(result.raw).toContain(`${DIM}311k/1M${NC} ${GREEN}▄█${NC} ${DIM}+161k${NC}`);
  });

  test("ctx line steps down full → tokens → base → dropped as the panel narrows", () => {
    const rows = sweep();
    const ranks = rows.map((row) => row.ctx);

    expectNeverWidens(ranks);
    expect(new Set(ranks)).toEqual(new Set([3, 2, 1, 0]));
    expect(ranks[0]).toBe(3);
    expect(ranks[ranks.length - 1]).toBe(0);
  }, SPAWN_TIMEOUT_MS);

  test("model line drops the cache countdown before the model name", () => {
    const rows = sweep();
    const ranks = rows.map((row) => row.model);

    expectNeverWidens(ranks);
    expect(ranks[0]).toBe(2);
    expect(ranks).toContain(1);
    // Losing the countdown must not cost the model name at that width.
    for (const row of rows) {
      if (row.model === 1) expect(row.result.plain).not.toContain("cache");
    }
  }, SPAWN_TIMEOUT_MS);

  test("a stat that does not fit leaves the buddy line unchanged", () => {
    const fixture = primedFixture();
    const input = widthInput(311_000);
    const combined = runCombined(fixture, input, 40);
    const buddyOnly = run(buddyScript, fixture, input, 40);

    expect(combined.status).toBe(0);
    expect(buddyOnly.status).toBe(0);
    expect(statTexts(combined.plain)[0]).toBe("");

    const combinedLines = combined.raw.split("\n");
    const buddyLines = buddyOnly.raw.split("\n");
    const ctxRow = combinedLines.findIndex((line) => line.includes(ART_ROWS[1]));
    expect(ctxRow).toBeGreaterThanOrEqual(0);
    expect(combinedLines[ctxRow]).toBe(buddyLines[ctxRow]);
    expect(combinedLines.length).toBe(buddyLines.length);
  });
});
