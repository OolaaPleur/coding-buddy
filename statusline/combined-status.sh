#!/usr/bin/env bash
# statusline/combined-status.sh
# Two-panel status line: context % + model left, buddy art right.
# buddy-status.sh renders the buddy panel and shared cached sub-status below it.

[ "$BUDDY_SHELL" = "1" ] && exit 0

# ── Compact mode for restricted terminals (e.g. Termux over SSH) ────────────
if [ "$BUDDY_DISABLE" = "1" ]; then
    STDIN_DATA=$(cat)
    printf '%s\n' "$STDIN_DATA" | python3 -c "
import json, sys

GREEN  = '\033[32m'
YELLOW = '\033[33m'
RED    = '\033[31m'
DIM    = '\033[2m'
NC     = '\033[0m'

def color_for(pct):
    if pct is None: return DIM
    if pct < 30:   return GREEN
    if pct < 70:   return YELLOW
    return RED

def build_bar(pct, width=8):
    if pct is None:
        return DIM + '░' * width + NC
    c = color_for(pct)
    filled = max(0, min(width, round(pct / 100 * width)))
    return c + '█' * filled + NC + DIM + '░' * (width - filled) + NC

try:
    data = json.load(sys.stdin)
except Exception:
    data = {}

cw       = data.get('context_window', {})
ctx_pct  = cw.get('used_percentage')
model    = data.get('model', {}).get('display_name') or data.get('model', {}).get('id') or ''
rl       = data.get('rate_limits') if isinstance(data.get('rate_limits'), dict) else {}
rl5h_pct = rl.get('five_hour', {}).get('used_percentage') if rl else None
rl7d_pct = rl.get('seven_day', {}).get('used_percentage') if rl else None
effort   = data.get('effort', {}).get('level')
thinking = data.get('thinking', {}).get('enabled', False)

def stat_str(label, pct):
    c = color_for(pct)
    pct_s = f'{round(pct):3d}%' if pct is not None else '  -%'
    return f'{DIM}{label}{NC} {c}{pct_s}{NC} {build_bar(pct)}'

line1 = [stat_str('ctx', ctx_pct)]
if rl5h_pct is not None:
    line1.append(stat_str('5h', rl5h_pct))

line2 = []
if rl7d_pct is not None:
    line2.append(stat_str('7d', rl7d_pct))

if model:
    effort_tag   = f' [{effort[:3]}]' if effort else ''
    thinking_tag = ' ~' if thinking else ''
    line2.append(f'{DIM}{model}{effort_tag}{thinking_tag}{NC}')

print('  '.join(line1))
if line2:
    print('  '.join(line2))
" 2>/dev/null
    exit 0
fi

SCRIPT_DIR="$(dirname "${BASH_SOURCE[0]}")"
BUDDY_SCRIPT="$SCRIPT_DIR/buddy-status.sh"

if ! command -v python3 >/dev/null 2>&1; then
    exec "$BUDDY_SCRIPT"
fi

# ── Capture stdin from Claude Code ──────────────────────────────────────────
STDIN_DATA=$(cat)

# ── Parse context % and model ────────────────────────────────────────────────
STATS_JSON=$(printf '%s\n' "$STDIN_DATA" | python3 -c "
import json, sys
try:
    data = json.load(sys.stdin)
    cw = data.get('context_window', {})
    ctx_pct = cw.get('used_percentage')
    ctx_size = cw.get('context_window_size')
    cu = cw.get('current_usage')
    ctx_tokens = None
    if isinstance(cu, dict):
        ctx_tokens = sum(cu.get(k) or 0 for k in ('input_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens')) or None
    if ctx_tokens is None and ctx_pct is not None and ctx_size:
        ctx_tokens = round(ctx_pct * ctx_size / 100)
    model = data.get('model', {}).get('display_name') or data.get('model', {}).get('id')
    rl = data.get('rate_limits', {})
    rl5h_pct    = rl.get('five_hour', {}).get('used_percentage') if isinstance(rl, dict) else None
    rl5h_reset  = rl.get('five_hour', {}).get('resets_at')       if isinstance(rl, dict) else None
    rl7d_pct    = rl.get('seven_day', {}).get('used_percentage') if isinstance(rl, dict) else None
    rl7d_reset  = rl.get('seven_day', {}).get('resets_at')       if isinstance(rl, dict) else None
    effort      = data.get('effort', {}).get('level')
    thinking    = data.get('thinking', {}).get('enabled', False)
    print(json.dumps({
        'ctx_pct':   ctx_pct,
        'ctx_tokens': ctx_tokens or None,
        'ctx_size':  ctx_size,
        'session_id': data.get('session_id') or '',
        'cache_expires': (data.get('prompt_cache') or {}).get('expires_at') if isinstance(data.get('prompt_cache'), dict) else None,
        'rl5h_pct':  rl5h_pct,
        'rl5h_reset': rl5h_reset,
        'rl7d_pct':  rl7d_pct,
        'rl7d_reset': rl7d_reset,
        'model':     model or '',
        'effort':    effort,
        'thinking':  thinking,
        'has_data':  ctx_pct is not None or bool(model),
    }))
except Exception:
    print('{}')
" 2>/dev/null)

# ── Capture buddy art (buddy reads state files, not stdin) ───────────────────
BUDDY_OUTPUT=$(printf '%s' "$STDIN_DATA" | "$BUDDY_SCRIPT" 2>/dev/null)

# No buddy output → exit silently (muted, no state, etc.)
[ -z "$BUDDY_OUTPUT" ] && exit 0

# No context data → pass buddy output through unchanged
HAS_DATA=$(STATS_JSON="$STATS_JSON" python3 -c "
import json, os
d = json.loads(os.environ.get('STATS_JSON') or '{}')
print(d.get('has_data', False))
" 2>/dev/null)

if [ "$HAS_DATA" != "True" ]; then
    printf '%s\n' "$BUDDY_OUTPUT"
    exit 0
fi

# ── Merge stat lines into buddy output ──────────────────────────────────────
# merge_stats <buddy output> <mode>: 'merge' places each stat line left of the
# buddy panel and exits 3 when one does not fit; 'stats' prints the stat lines
# alone, sized to the panel's width.
merge_stats() {
printf '%s\n' "$1" | STATS_JSON="$STATS_JSON" MERGE_MODE="$2" python3 -c "
import sys, json, os, re

BRAILLE = '⠀'
GREEN   = '\033[32m'
YELLOW  = '\033[33m'
RED     = '\033[31m'
DIM     = '\033[2m'
NC      = '\033[0m'

def color_for(pct):
    if pct is None: return DIM
    if pct < 30:   return GREEN
    if pct < 70:   return YELLOW
    return RED

def build_bar(pct, width=10):
    if pct is None:
        return DIM + '░' * width + NC
    c = color_for(pct)
    filled = max(0, min(width, round(pct / 100 * width)))
    return c + '█' * filled + NC + DIM + '░' * (width - filled) + NC

try:
    stats = json.loads(os.environ.get('STATS_JSON', '{}'))
except Exception:
    stats = {}

import time

ctx_pct    = stats.get('ctx_pct')
rl5h_pct   = stats.get('rl5h_pct')
rl5h_reset = stats.get('rl5h_reset')
rl7d_pct   = stats.get('rl7d_pct')
rl7d_reset = stats.get('rl7d_reset')
model      = stats.get('model', '')
effort     = stats.get('effort')
thinking   = stats.get('thinking', False)

# Rate-limit numbers only arrive with a response, so an idle session keeps
# showing the last ones. Once a window's reset time has passed, its usage is 0.
def reset_if_passed(pct, resets_at):
    try:
        if pct is not None and resets_at is not None and time.time() >= float(resets_at):
            return 0, None
    except Exception:
        pass
    return pct, resets_at

rl5h_pct, rl5h_reset = reset_if_passed(rl5h_pct, rl5h_reset)
rl7d_pct, rl7d_reset = reset_if_passed(rl7d_pct, rl7d_reset)

def fmt_countdown(resets_at):
    if resets_at is None:
        return ''
    secs = int(resets_at) - int(time.time())
    if secs <= 0:
        return ''
    d, rem = divmod(secs, 86400)
    h, rem = divmod(rem, 3600)
    m = rem // 60
    if d:    return f' {d}d{h}h'
    if h:    return f' {h}h{m:02d}m'
    if secs < 60: return ' <1m'
    return f' {m}m'

def make_bar_line(label, pct, countdown=''):
    c = color_for(pct)
    pct_str = f'{round(pct):3d}%' if pct is not None else '  -%'
    bar = build_bar(pct)
    cd  = f'{DIM}{countdown}{NC}' if countdown else ''
    text  = f'{DIM}{label}{NC} {c}{pct_str}{NC} {bar}{cd}'
    width = len(label) + 1 + 4 + 1 + 10 + len(countdown)
    return text, width

ctx_text,  ctx_width  = make_bar_line('ctx', ctx_pct)

# ── Context extras: tokens used / window, per-turn sparkline, last-turn delta ──
# Turn boundaries come from hooks/ctx-turn.sh (Stop hook), which rewrites
# turn.<sid>; the last sample tracks the turn in progress until it closes.
SPARK = '▁▂▃▄▅▆▇█'
MAX_TURNS = 12

def fmt_tokens(n):
    # Half-up rounding throughout; one decimal below 10k and from 1M, never '.0'.
    a = abs(n)
    if a < 1000:
        return str(a)
    if a < 9950:
        return f'{int(a / 100 + 0.5) / 10:.1f}'.rstrip('0').rstrip('.') + 'k'
    if a < 999500:
        return f'{int(a / 1000 + 0.5)}k'
    return f'{int(a / 1e5 + 0.5) / 10:.1f}'.rstrip('0').rstrip('.') + 'M'

def turn_samples(sid, tokens):
    sid = ''.join(ch for ch in sid if ch.isalnum() or ch in '_-')
    if not sid:
        return [tokens]
    base = os.environ.get('XDG_STATE_HOME') or os.path.join(os.path.expanduser('~'), '.local', 'state')
    d = os.path.join(base, 'claude-ctx-history')
    hist_path = os.path.join(d, 'hist.' + sid + '.json')
    try:
        with open(os.path.join(d, 'turn.' + sid)) as f:
            marker = f.read().strip()
    except Exception:
        marker = ''
    try:
        with open(hist_path) as f:
            st = json.load(f)
        samples = [int(x) for x in st['samples']]
        prev = (samples, st.get('marker', ''), bool(st.get('open')))
        samples = list(samples)
        seen, is_open = prev[1], prev[2]
    except Exception:
        prev, samples, seen, is_open = None, [], marker, False
    if not samples:
        samples = [tokens]
    elif marker != seen:
        # Turn just ended: its final reading closes the open sample.
        if is_open:
            samples[-1] = tokens
        elif tokens != samples[-1]:
            samples.append(tokens)
        seen, is_open = marker, False
    elif is_open:
        samples[-1] = tokens
    elif tokens != samples[-1]:
        try:
            just_closed = marker and time.time() - float(marker) < 3
        except Exception:
            just_closed = False
        if just_closed:
            samples[-1] = tokens          # late final reading of the closed turn
        else:
            samples.append(tokens)        # first reading of a new turn
            is_open = True
    samples = samples[-(MAX_TURNS + 1):]
    if prev != (samples, seen, is_open):
        try:
            os.makedirs(d, exist_ok=True)
            tmp = hist_path + '.' + str(os.getpid())
            with open(tmp, 'w') as f:
                json.dump({'samples': samples, 'marker': seen, 'open': is_open}, f)
            os.replace(tmp, hist_path)
        except Exception:
            pass
    return samples

ctx_variants = [(ctx_text, ctx_width)]
ctx_tokens = stats.get('ctx_tokens')
ctx_size   = stats.get('ctx_size')
if ctx_tokens:
    used = fmt_tokens(ctx_tokens) + ('/' + fmt_tokens(ctx_size) if ctx_size else '')
    with_tokens = (f'{ctx_text} {DIM}{used}{NC}', ctx_width + 1 + len(used))
    ctx_variants.insert(0, with_tokens)
    samples = turn_samples(stats.get('session_id', ''), ctx_tokens)
    if len(samples) > 1:
        shown = samples[-MAX_TURNS:]
        top = max(shown) or 1
        spark = ''.join(SPARK[min(7, max(0, int(v / top * 8)))] for v in shown)
        diff = samples[-1] - samples[-2]
        delta = ('+' if diff >= 0 else '-') + fmt_tokens(diff)
        c = color_for(ctx_pct)
        ctx_variants.insert(0, (
            f'{with_tokens[0]} {c}{spark}{NC} {DIM}{delta}{NC}',
            with_tokens[1] + 1 + len(spark) + 1 + len(delta),
        ))

def limit_variants(label, pct, resets_at):
    variants = [make_bar_line(label, pct)]
    countdown = fmt_countdown(resets_at)
    if countdown:
        variants.insert(0, make_bar_line(label, pct, countdown))
    return variants

effort_tag   = f' [{effort[:3]}]' if effort else ''
thinking_tag = ' ~' if thinking else ''
model_suffix = f'{DIM}{effort_tag}{thinking_tag}{NC}' if (effort_tag or thinking_tag) else ''
model_text   = f'{DIM}{model}{NC}{model_suffix}' if model else ''
model_width  = len(model) + len(effort_tag) + len(thinking_tag)

# Each item lists its renderings widest first; the first one that fits is used.
stat_items = [ctx_variants]
if rl5h_pct is not None: stat_items.append(limit_variants('5h', rl5h_pct, rl5h_reset))
if rl7d_pct is not None: stat_items.append(limit_variants('7d', rl7d_pct, rl7d_reset))
# Prompt-cache countdown after the model: time left before the next message
# re-writes the whole context instead of reading it from cache.
model_variants = [(model_text, model_width)]
try:
    cache_left = float(stats.get('cache_expires')) - time.time()
except Exception:
    cache_left = None
if cache_left is not None:
    if cache_left <= 0:
        cache_plain, cache_color = 'cache COLD', RED
    else:
        cache_plain = 'cache' + (fmt_countdown(time.time() + cache_left) or ' <1m')
        cache_color = YELLOW if cache_left < 600 else DIM
    sep = '  ' if model else ''
    model_variants.insert(0, (
        f'{model_text}{sep}{cache_color}{cache_plain}{NC}',
        model_width + len(sep) + len(cache_plain),
    ))
stat_items.append(model_variants)

lines = sys.stdin.read().splitlines()
ANSI = re.compile(chr(27) + chr(92) + chr(91) + '[0-9;]*m')
budget = max((len(ANSI.sub('', l)) for l in lines), default=0) - 1

def alone(variants):
    return BRAILLE + next((v for v in variants if v[1] <= budget), variants[-1])[0]

if os.environ.get('MERGE_MODE') == 'stats':
    print('\n'.join(alone(v) for v in stat_items if v[-1][0]))
    sys.exit(0)

# The panel is the leading run of spacer-prefixed lines. Stats start on its
# second line when it is tall enough, otherwise on the first; stats that run
# past its last line get lines of their own below it.
panel = next((i for i, l in enumerate(lines) if not l.startswith(BRAILLE)), len(lines))
center = 1 if panel > len(stat_items) else 0

# A stat needs its own width plus one column of air before the panel.
out, placed = [], 0
for i, line in enumerate(lines):
    si = i - center
    fit = None
    if 0 <= si < len(stat_items) and i < panel:
        after_braille = line[1:]
        num_spaces = len(after_braille) - len(after_braille.lstrip(' '))
        fit = next((v for v in stat_items[si] if v[1] < num_spaces), None)
    if fit:
        placed += 1
        out.append(BRAILLE + fit[0] + ' ' * (num_spaces - fit[1]) + after_braille.lstrip(' '))
    else:
        out.append(line)
    if i == panel - 1 and placed == panel - center:
        overflow = stat_items[panel - center:]
        out.extend(alone(v) for v in overflow)
        placed += len(overflow)
if placed < len(stat_items):
    sys.exit(3)
print('\n'.join(out))
"
}

# Stats outrank the buddy: when a stat line does not fit beside the full panel,
# retry beside the compact one (no speech bubble), then show the stats alone.
MERGED=$(merge_stats "$BUDDY_OUTPUT" merge)
if [ $? -eq 3 ]; then
    COMPACT_OUTPUT=$(printf '%s' "$STDIN_DATA" | BUDDY_STATUSLINE_DENSITY=compact "$BUDDY_SCRIPT" 2>/dev/null)
    MERGED=$(merge_stats "$COMPACT_OUTPUT" merge)
    [ $? -eq 3 ] && MERGED=$(merge_stats "$BUDDY_OUTPUT" stats)
fi
[ -z "$MERGED" ] && MERGED="$BUDDY_OUTPUT"
printf '%s\n' "$MERGED"
