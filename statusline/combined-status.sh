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
    if isinstance(cu, dict):
        ctx_tokens = sum(cu.get(k) or 0 for k in ('input_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens'))
    elif ctx_pct is not None and ctx_size:
        ctx_tokens = round(ctx_pct * ctx_size / 100)
    else:
        ctx_tokens = None
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
HAS_DATA=$(python3 -c "
import json, sys
d = json.loads('''$STATS_JSON''' or '{}')
print(d.get('has_data', False))
" 2>/dev/null)

if [ "$HAS_DATA" != "True" ]; then
    printf '%s\n' "$BUDDY_OUTPUT"
    exit 0
fi

# ── Merge stat lines into buddy output ──────────────────────────────────────
printf '%s\n' "$BUDDY_OUTPUT" | STATS_JSON="$STATS_JSON" python3 -c "
import sys, json, os

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
    a = abs(n)
    if a >= 999500:
        s = f'{a / 1e6:.1f}'.rstrip('0').rstrip('.') + 'M'
    elif a >= 10000:
        s = f'{round(a / 1000)}k'
    elif a >= 1000:
        s = f'{a / 1000:.1f}k'
    else:
        s = str(a)
    return s

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

rl5h_text, rl5h_width = make_bar_line('5h',  rl5h_pct, fmt_countdown(rl5h_reset))
rl7d_text, rl7d_width = make_bar_line('7d',  rl7d_pct, fmt_countdown(rl7d_reset))

effort_tag   = f' [{effort[:3]}]' if effort else ''
thinking_tag = ' ~' if thinking else ''
model_suffix = f'{DIM}{effort_tag}{thinking_tag}{NC}' if (effort_tag or thinking_tag) else ''
model_text   = f'{DIM}{model}{NC}{model_suffix}' if model else ''
model_width  = len(model) + len(effort_tag) + len(thinking_tag)

# Each item lists its renderings widest first; the first one that fits is used.
stat_items = [ctx_variants]
if rl5h_pct is not None: stat_items.append([(rl5h_text, rl5h_width)])
if rl7d_pct is not None: stat_items.append([(rl7d_text, rl7d_width)])
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
        cache_plain = 'cache' + (fmt_countdown(time.time() + cache_left) if cache_left >= 60 else ' <1m')
        cache_color = YELLOW if cache_left < 600 else DIM
    sep = '  ' if model else ''
    model_variants.insert(0, (
        f'{model_text}{sep}{cache_color}{cache_plain}{NC}',
        model_width + len(sep) + len(cache_plain),
    ))
stat_items.append(model_variants)

lines = sys.stdin.read().splitlines()
center = 1

for i, line in enumerate(lines):
    si = i - center
    if 0 <= si < len(stat_items) and line.startswith(BRAILLE):
        after_braille = line[1:]
        num_spaces = len(after_braille) - len(after_braille.lstrip(' '))
        stat_text, stat_width = next(
            (v for v in stat_items[si] if v[1] <= num_spaces), stat_items[si][-1])
        if num_spaces >= stat_width:
            remaining = ' ' * (num_spaces - stat_width)
            rest = after_braille.lstrip(' ')
            print(BRAILLE + stat_text + remaining + rest)
        else:
            print(line)
    else:
        print(line)
"
