import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Per-turn context history of statusline/combined-status.sh ("Context extras"
// block, turn_samples) and its turn-end marker writer hooks/ctx-turn.sh.

const temporaryDirectories: string[] = [];
const combinedScript = join(import.meta.dir, "combined-status.sh");
const turnHookScript = join(import.meta.dir, "..", "hooks", "ctx-turn.sh");

const SPARK_CHARS = "▁▂▃▄▅▆▇█";
const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]/g;
// ctx <pct>% <10-cell bar> <used>[/<window>] [<sparkline> <delta>]
const CTX_LINE = new RegExp(
  `ctx\\s+(-|\\d+)% [█░]{10}(?: (\\S+))?(?: ([${SPARK_CHARS}]+) ([+-]\\S+))?`,
);

type Fixture = { configDir: string; stateHome: string; historyDir: string };

function createFixture(): Fixture {
  const configDir = mkdtempSync(join(tmpdir(), "coding-buddy-ctxhist-"));
  temporaryDirectories.push(configDir);
  const stateDir = join(configDir, "buddy-state");
  mkdirSync(stateDir);
  writeFileSync(join(stateDir, "config.json"), JSON.stringify({}));
  writeFileSync(join(stateDir, "status.json"), JSON.stringify({
    name: "Nimbus",
    rarity: "common",
    stars: "",
    shiny: false,
    reaction: "",
    achievement: "",
    level: 1,
    mood: "focused",
    frames: ["  art"],
    frameSequence: [0],
  }));
  const stateHome = mkdtempSync(join(tmpdir(), "coding-buddy-ctxhist-state-"));
  temporaryDirectories.push(stateHome);
  return { configDir, stateHome, historyDir: join(stateHome, "claude-ctx-history") };
}

function scriptEnv(fixture: Fixture) {
  return {
    ...process.env,
    CLAUDE_CONFIG_DIR: fixture.configDir,
    CLAUDE_CODE_SESSION_ID: "",
    TMUX_PANE: "",
    BUDDY_STATUSLINE_COLS: "140",
    BUDDY_STATUSLINE_ROWS: "50",
    TERM: "xterm-256color",
    NO_COLOR: "",
    BUDDY_SHELL: "",
    BUDDY_DISABLE: "",
    XDG_STATE_HOME: fixture.stateHome,
  };
}

type ContextWindow = Record<string, unknown>;

/** Status-line payload whose context tokens come from current_usage. */
function usage(tokens: number, size = 1_000_000): ContextWindow {
  return {
    used_percentage: Math.round((tokens / size) * 100),
    context_window_size: size,
    // Split across the three summed fields so the sum itself is exercised.
    current_usage: {
      input_tokens: tokens % 1000,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: tokens - (tokens % 1000),
      output_tokens: 777_777, // must not be counted
    },
  };
}

type Rendered = {
  line: string;
  pct: string;
  used: string | undefined;
  spark: string | undefined;
  delta: string | undefined;
};

function render(fixture: Fixture, contextWindow: ContextWindow, sessionId = "sess-1"): Rendered {
  const result = spawnSync("bash", [combinedScript], {
    env: scriptEnv(fixture),
    input: JSON.stringify({
      session_id: sessionId,
      context_window: contextWindow,
      model: { id: "test-model", display_name: "Test" },
    }) + "\n",
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(result.status).toBe(0);
  const plain = result.stdout.toString().replace(ANSI, "");
  const line = plain.split("\n").find((candidate) => CTX_LINE.test(candidate));
  if (line === undefined) throw new Error(`no ctx line in statusline output:\n${plain}`);
  const match = line.match(CTX_LINE)!;
  return { line, pct: match[1], used: match[2], spark: match[3], delta: match[4] };
}

function readHistory(fixture: Fixture, sessionId = "sess-1") {
  return JSON.parse(readFileSync(join(fixture.historyDir, `hist.${sessionId}.json`), "utf8")) as {
    samples: number[];
    marker: string;
    open: boolean;
  };
}

function writeHistory(
  fixture: Fixture,
  state: { samples: number[]; marker: string; open: boolean },
  sessionId = "sess-1",
) {
  mkdirSync(fixture.historyDir, { recursive: true });
  writeFileSync(join(fixture.historyDir, `hist.${sessionId}.json`), JSON.stringify(state));
}

const testStartSeconds = Date.now() / 1000;

/** A turn-end marker far enough in the past that the 3 s "late reading" window is closed. */
function oldMarker(n: number) {
  return (testStartSeconds - 100 + n).toFixed(9);
}

/** Simulates hooks/ctx-turn.sh ending a turn (same format as `date +%s.%N`). */
function writeMarker(fixture: Fixture, marker: string, sessionId = "sess-1") {
  mkdirSync(fixture.historyDir, { recursive: true });
  writeFileSync(join(fixture.historyDir, `turn.${sessionId}`), marker + "\n");
}

function runTurnHook(fixture: Fixture, input: string) {
  return spawnSync("bash", [turnHookScript], {
    env: scriptEnv(fixture),
    input,
    stdout: "pipe",
    stderr: "pipe",
  });
}

function historyFiles(fixture: Fixture) {
  return existsSync(fixture.historyDir) ? readdirSync(fixture.historyDir).sort() : [];
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("combined statusline context history", () => {
  test("first render shows tokens/window without sparkline or delta and seeds one sample", () => {
    const fixture = createFixture();

    const first = render(fixture, usage(156_500));

    expect(first.pct).toBe("16");
    expect(first.used).toBe("156k/1M");
    expect(first.spark).toBeUndefined();
    expect(first.delta).toBeUndefined();
    expect(first.line).not.toMatch(/[+-]\d/);
    expect(readHistory(fixture)).toEqual({ samples: [156_500], marker: "", open: false });
    expect(historyFiles(fixture)).toEqual(["hist.sess-1.json"]);
  });

  test("an unchanged reading does not add a sample", () => {
    const fixture = createFixture();

    render(fixture, usage(100_000));
    const again = render(fixture, usage(100_000));

    expect(again.spark).toBeUndefined();
    expect(readHistory(fixture)).toEqual({ samples: [100_000], marker: "", open: false });
  });

  test("growth within an open turn keeps updating the last sample and the delta", () => {
    const fixture = createFixture();

    render(fixture, usage(100_000));
    const opened = render(fixture, usage(150_000));
    expect(opened.used).toBe("150k/1M");
    expect(opened.spark).toBe("▆█");
    expect(opened.delta).toBe("+50k");
    expect(readHistory(fixture)).toEqual({ samples: [100_000, 150_000], marker: "", open: true });

    const grown = render(fixture, usage(200_000));
    expect(grown.used).toBe("200k/1M");
    expect(grown.spark).toBe("▅█");
    expect(grown.delta).toBe("+100k");
    expect(readHistory(fixture)).toEqual({ samples: [100_000, 200_000], marker: "", open: true });
  });

  test("a marker change closes the turn and the next token change appends a new sample", () => {
    const fixture = createFixture();
    const marker = oldMarker(1);

    render(fixture, usage(100_000));
    render(fixture, usage(150_000));
    writeMarker(fixture, marker);

    // The first render after the Stop hook stores the turn's final reading.
    const closed = render(fixture, usage(170_000));
    expect(closed.delta).toBe("+70k");
    expect(readHistory(fixture)).toEqual({ samples: [100_000, 170_000], marker, open: false });

    // Idle renders between turns change nothing.
    render(fixture, usage(170_000));
    expect(readHistory(fixture)).toEqual({ samples: [100_000, 170_000], marker, open: false });

    // Same (old) marker, new reading: the next turn has started.
    const next = render(fixture, usage(200_000));
    expect(next.spark).toBe("▅▇█");
    expect(next.delta).toBe("+30k");
    expect(readHistory(fixture)).toEqual({
      samples: [100_000, 170_000, 200_000],
      marker,
      open: true,
    });
  });

  test("a marker change with no open turn records a changed reading as a closed sample", () => {
    const fixture = createFixture();
    const marker = oldMarker(1);

    render(fixture, usage(100_000));
    writeMarker(fixture, marker);
    const closed = render(fixture, usage(130_000));

    expect(closed.delta).toBe("+30k");
    expect(readHistory(fixture)).toEqual({ samples: [100_000, 130_000], marker, open: false });
  });

  test("a late reading within 3 s of a fresh marker overwrites instead of appending", () => {
    const fixture = createFixture();

    render(fixture, usage(100_000));
    render(fixture, usage(150_000));
    const marker = (Date.now() / 1000).toFixed(9);
    writeMarker(fixture, marker);
    render(fixture, usage(170_000));
    expect(readHistory(fixture)).toEqual({ samples: [100_000, 170_000], marker, open: false });

    const late = render(fixture, usage(175_000));

    expect(late.used).toBe("175k/1M");
    expect(late.spark).toBe("▅█");
    expect(late.delta).toBe("+75k");
    expect(readHistory(fixture)).toEqual({ samples: [100_000, 175_000], marker, open: false });
  });

  test("an unparsable marker is never treated as a just-closed turn", () => {
    const fixture = createFixture();
    writeHistory(fixture, { samples: [100_000, 170_000], marker: "garbage", open: false });
    writeMarker(fixture, "garbage");

    render(fixture, usage(175_000));

    expect(readHistory(fixture)).toEqual({
      samples: [100_000, 170_000, 175_000],
      marker: "garbage",
      open: true,
    });
  });

  test("after more than 12 turns shows 12 sparkline chars and stores at most 13 samples", () => {
    const fixture = createFixture();
    const turns = 15;
    let last: Rendered | undefined;

    render(fixture, usage(10_000));
    for (let turn = 1; turn <= turns; turn++) {
      const tokens = 10_000 + turn * 10_000;
      render(fixture, usage(tokens));          // turn in progress
      writeMarker(fixture, oldMarker(turn));   // Stop hook
      last = render(fixture, usage(tokens));   // final reading closes it
      expect(readHistory(fixture).samples.length).toBeLessThanOrEqual(13);
    }

    const expectedSamples = Array.from({ length: 13 }, (_, index) => 40_000 + index * 10_000);
    expect(readHistory(fixture)).toEqual({
      samples: expectedSamples,
      marker: oldMarker(turns),
      open: false,
    });
    expect([...last!.spark!]).toHaveLength(12);
    // Last 12 of the 13 stored samples (50k..160k), each int(v / max * 8) capped at 7.
    expect(last!.spark).toBe("▃▄▄▅▅▆▆▇▇███");
    expect(last!.delta).toBe("+10k");
    expect(last!.used).toBe("160k/1M");
  }, 60_000);

  test("an oversized history file is trimmed to 13 samples on the next change", () => {
    const fixture = createFixture();
    const marker = oldMarker(1);
    const seeded = Array.from({ length: 20 }, (_, index) => 1_000 * (index + 1));
    writeHistory(fixture, { samples: seeded, marker, open: false });
    writeMarker(fixture, marker);

    const rendered = render(fixture, usage(21_000));

    expect([...rendered.spark!]).toHaveLength(12);
    expect(readHistory(fixture).samples).toEqual([...seeded.slice(-12), 21_000]);
  });

  test("a drop in tokens (compaction) renders a negative delta", () => {
    const fixture = createFixture();
    const marker = oldMarker(1);

    render(fixture, usage(100_000));
    render(fixture, usage(300_000));
    writeMarker(fixture, marker);
    render(fixture, usage(300_000));

    const compacted = render(fixture, usage(20_000));

    expect(compacted.used).toBe("20k/1M");
    expect(compacted.spark).toBe("▃█▁");
    expect(compacted.delta).toBe("-280k");
    expect(readHistory(fixture)).toEqual({
      samples: [100_000, 300_000, 20_000],
      marker,
      open: true,
    });
  });

  test("falls back to used_percentage * context_window_size without current_usage", () => {
    const fixture = createFixture();

    const first = render(fixture, { used_percentage: 25, context_window_size: 200_000 });
    expect(first.pct).toBe("25");
    expect(first.used).toBe("50k/200k");
    expect(first.spark).toBeUndefined();
    expect(readHistory(fixture).samples).toEqual([50_000]);

    // current_usage: null (as sent before the first response) also falls back.
    const second = render(fixture, {
      used_percentage: 30,
      context_window_size: 200_000,
      current_usage: null,
    });
    expect(second.used).toBe("60k/200k");
    expect(second.delta).toBe("+10k");
    expect(readHistory(fixture).samples).toEqual([50_000, 60_000]);
  });

  test("current_usage wins over the percentage fallback", () => {
    const fixture = createFixture();

    const rendered = render(fixture, {
      used_percentage: 50,
      context_window_size: 200_000,
      current_usage: {
        input_tokens: 1_000,
        cache_creation_input_tokens: 2_000,
        cache_read_input_tokens: 30_000,
      },
    });

    expect(rendered.used).toBe("33k/200k");
    expect(readHistory(fixture).samples).toEqual([33_000]);
  });

  test("shows no token count and writes no history when neither source is available", () => {
    const fixture = createFixture();

    const rendered = render(fixture, { used_percentage: 28 });

    expect(rendered.pct).toBe("28");
    expect(rendered.used).toBeUndefined();
    expect(historyFiles(fixture)).toEqual([]);
  });

  test("keeps separate history per session", () => {
    const fixture = createFixture();

    render(fixture, usage(100_000), "sess-a");
    render(fixture, usage(150_000), "sess-a");
    const other = render(fixture, usage(40_000), "sess-b");

    expect(other.spark).toBeUndefined();
    expect(readHistory(fixture, "sess-a").samples).toEqual([100_000, 150_000]);
    expect(readHistory(fixture, "sess-b").samples).toEqual([40_000]);
  });

  test("without a session id shows tokens but keeps no history", () => {
    const fixture = createFixture();

    render(fixture, usage(100_000), "");
    const second = render(fixture, usage(150_000), "");

    expect(second.used).toBe("150k/1M");
    expect(second.spark).toBeUndefined();
    expect(historyFiles(fixture)).toEqual([]);
  });

  test.each([
    [950, 1_000_000, "950/1M"],
    [1_000, 1_000_000, "1.0k/1M"],
    [1_500, 1_000_000, "1.5k/1M"],
    [9_999, 1_000_000, "10.0k/1M"],
    [10_000, 1_000_000, "10k/1M"],
    // round() is banker's rounding: 156.5 -> 156, 157.5 -> 158.
    [156_500, 1_000_000, "156k/1M"],
    [157_500, 1_000_000, "158k/1M"],
    [311_000, 1_000_000, "311k/1M"],
    [999_499, 2_000_000, "999k/2M"],
    [999_500, 2_000_000, "1M/2M"],
    [1_250_000, 2_000_000, "1.2M/2M"],
    [100_000, 200_000, "100k/200k"],
  ])("formats %i tokens of a %i window as %s", (tokens, size, expected) => {
    const fixture = createFixture();

    expect(render(fixture, usage(tokens, size)).used).toBe(expected);
  });

  test("formats sub-thousand and fractional-k deltas", () => {
    const fixture = createFixture();

    render(fixture, usage(10_000));
    expect(render(fixture, usage(10_950)).delta).toBe("+950");
    expect(render(fixture, usage(11_500)).delta).toBe("+1.5k");
    expect(render(fixture, usage(8_500)).delta).toBe("-1.5k");
  });
});

describe("ctx-turn Stop hook", () => {
  test("writes a timestamp marker for the session", () => {
    const fixture = createFixture();
    const before = Date.now() / 1000;

    const result = runTurnHook(fixture, JSON.stringify({ session_id: "abc-123" }) + "\n");

    expect(result.status).toBe(0);
    expect(historyFiles(fixture)).toEqual(["turn.abc-123"]);
    const marker = readFileSync(join(fixture.historyDir, "turn.abc-123"), "utf8").trim();
    expect(marker).toMatch(/^\d+\.\d+$/);
    expect(Number(marker)).toBeGreaterThanOrEqual(before - 1);
    expect(Number(marker)).toBeLessThanOrEqual(Date.now() / 1000 + 1);
  });

  test.each([
    ["an empty object", "{}\n"],
    ["a null session id", '{"session_id":null}\n'],
    ["an empty session id", '{"session_id":""}\n'],
    ["a session id with no usable characters", '{"session_id":"../.."}\n'],
    ["invalid JSON", "not json\n"],
    ["empty stdin", ""],
  ])("writes nothing and exits 0 for %s", (_label, input) => {
    const fixture = createFixture();

    const result = runTurnHook(fixture, input);

    expect(result.status).toBe(0);
    expect(historyFiles(fixture)).toEqual([]);
  });

  test("sanitizes session ids to [A-Za-z0-9_-]", () => {
    const fixture = createFixture();

    const result = runTurnHook(fixture, JSON.stringify({ session_id: "../a b/c$d.e_F-1" }) + "\n");

    expect(result.status).toBe(0);
    expect(historyFiles(fixture)).toEqual(["turn.abcde_F-1"]);
    expect(readdirSync(fixture.stateHome)).toEqual(["claude-ctx-history"]);
  });

  test("statusline reads the marker the hook wrote for the same raw session id", () => {
    const fixture = createFixture();
    const rawSessionId = "../a b/c$d.e_F-1";

    render(fixture, usage(100_000), rawSessionId);
    render(fixture, usage(150_000), rawSessionId);
    expect(runTurnHook(fixture, JSON.stringify({ session_id: rawSessionId }) + "\n").status).toBe(0);
    render(fixture, usage(160_000), rawSessionId);

    expect(historyFiles(fixture)).toEqual(["hist.abcde_F-1.json", "turn.abcde_F-1"]);
    const history = readHistory(fixture, "abcde_F-1");
    expect(history.samples).toEqual([100_000, 160_000]);
    expect(history.open).toBe(false);
    expect(history.marker).toBe(
      readFileSync(join(fixture.historyDir, "turn.abcde_F-1"), "utf8").trim(),
    );
  });
});
