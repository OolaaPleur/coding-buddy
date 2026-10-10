# claude-buddy

A coding companion for Claude Code — animated buddy in the status line, driven by an MCP server.

## Stack

- **Runtime**: [bun](https://bun.sh) for all TypeScript (server + CLI)
- **MCP server**: `server/index.ts` — serves the `/buddy` slash commands and manages buddy state
- **Status line**: `statusline/combined-status.sh` — bash script injecting stats + buddy art into Claude Code's status line
- **Hooks**: `hooks/*.sh` — react to tool use, file edits, name mentions, mood

## Commands

```bash
bun test              # run test suite (56 tests, ~65 ms)
bun run typecheck     # tsc --noEmit
bun run server        # start MCP server manually
bun run install-buddy # install / reinstall into current Claude Code profile
bun run upgrade       # upgrade in place
bun run uninstall     # remove from Claude Code profile
bun run doctor        # diagnose install issues
bun run show          # print buddy card to terminal
bun run test-statusline  # render statusline for visual review
```

## Project layout

```
server/        TypeScript MCP server — state, art, engine, reactions, achievements
cli/           CLI tools — install, upgrade, doctor, show, etc.
statusline/    combined-status.sh + buddy-status.sh (bash, keep buddy-status.sh clean for upstream)
hooks/         PostToolUse / UserPromptSubmit / Stop hook scripts
scripts/       gen-emoji-widths.ts, snapshot-statusline.sh
```

## Status line JSON (Claude Code → combined-status.sh)

Claude Code sends this JSON on stdin every `refreshInterval` seconds:

```json
{
  "session_id": "0b1c2d3e-...",
  "context_window": {
    "used_percentage": 28,
    "context_window_size": 200000,
    "current_usage": {
      "input_tokens": 1200,
      "cache_creation_input_tokens": 4800,
      "cache_read_input_tokens": 50000
    }
  },
  "prompt_cache": { "expires_at": 1778600000 },
  "model": { "id": "claude-sonnet-4-6", "display_name": "Sonnet 4.6" },
  "rate_limits": {
    "five_hour": { "used_percentage": 63, "resets_at": 1778602800 },
    "seven_day":  { "used_percentage": 11, "resets_at": 1779181200 }
  },
  "cost": { "total_cost_usd": 0.89 },
  "workspace": { "current_dir": "/home/user" }
}
```

`rate_limits` is only present for Claude Max subscribers. The combined script gracefully omits those bars when absent. `prompt_cache.expires_at` and `rate_limits.*.resets_at` are epoch seconds.

### What the combined status line shows

Beyond the ctx/5h/7d bars and the model name:

- **ctx line**: tokens used / window (`56k/200k`; used = sum of the three `current_usage` fields, else derived from `used_percentage`), a sparkline of context size at the end of each of the last 12 turns, and the last turn's delta (`+3.2k`).
- **model line**: prompt-cache countdown (`cache 47m`), yellow under 10 min, `cache COLD` in red once expired.
- **5h / 7d bars**: show 0% once their `resets_at` has passed.
- The ctx and model lines fall back to a narrower variant (dropping the extras) when the terminal is too narrow.

### Context history (`hooks/ctx-turn.sh`)

Stop hook that writes a turn-end marker so the status line records one context sample per turn. Per-session state lives in `${XDG_STATE_HOME:-~/.local/state}/claude-ctx-history/`: `turn.<session_id>` (marker, written by the hook) and `hist.<session_id>.json` (samples, written by `combined-status.sh`). The hook prunes files older than 7 days. It must be registered under `Stop` in `~/.claude/settings.json`, otherwise the sparkline does not advance.

## Key files to know

| File | Purpose |
|------|---------|
| `server/engine.ts` | Deterministic buddy generation from user ID hash |
| `server/state.ts` | Read/write `buddy-state/status.json` (pre-renders all animation frames) |
| `server/art.ts` | ASCII art frames per species, hat overlays, blink logic |
| `statusline/combined-status.sh` | Merges ctx/5h/7d/model bars into buddy art output |
| `statusline/buddy-status.sh` | Pure buddy art renderer — keep untouched for upstream PRs |
| `hooks/buddy-comment.sh` | Extracts `<!-- buddy: ... -->` from Stop hook, writes to status |
| `hooks/ctx-turn.sh` | Stop hook — writes the turn-end marker for the ctx sparkline |

## State directory

Lives at `$BUDDY_STATE_DIR` (default: `~/.claude/buddy-state/`).  
Key file: `status.json` — written by MCP server, read by statusline bash script.

## Tests

Co-located with source: `server/*.test.ts`. Run with `bun test`.  
Snapshot tests for statusline rendering: `scripts/snapshot-statusline.sh`.
