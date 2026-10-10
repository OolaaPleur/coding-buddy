#!/usr/bin/env bash
# hooks/ctx-turn.sh
# Stop hook: marks the end of a main-loop turn so statusline/combined-status.sh
# can record one context-window sample per turn (sparkline + last-turn delta).
set +e
DIR="${XDG_STATE_HOME:-$HOME/.local/state}/claude-ctx-history"
SID=$(jq -r '.session_id // empty' 2>/dev/null | tr -cd 'A-Za-z0-9_-')
[ -n "$SID" ] || exit 0
mkdir -p "$DIR" 2>/dev/null || exit 0
date +%s.%N > "$DIR/turn.$SID"
# Drop state of sessions untouched for a week.
find "$DIR" -type f -mtime +7 -delete 2>/dev/null
exit 0
