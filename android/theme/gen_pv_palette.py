#!/usr/bin/env python3
"""Parvane (spec 032): тона разделов `--pv-*` web для экранов оверлея Android.

Читает `PALETTES` и `TONES` из `web/telegram-tt/src/util/colorScheme.ts` и пишет `PvPalette.kt` — таблицу по
встроенным темам X (те же места, что `gen_tgx_themes.py`). Экраны разделов красятся только этими тонами, как web.
  python3 android/theme/gen_pv_palette.py [--check]
"""
import re, sys, pathlib

ROOT = pathlib.Path(__file__).resolve().parents[2]
WEB = ROOT / 'web/telegram-tt/src/util/colorScheme.ts'
OUT = ROOT / 'android/tgx-overlay/app/src/main/java/org/thunderdog/challegram/parvane/sections/PvPalette.kt'

# id темы X → (схема, тёмная?)
SLOTS = {11: ('gruvbox', False), 10: ('gruvbox', True), 9: ('nord', False), 4: ('nord', True),
         7: ('catppuccin', False), 3: ('catppuccin', True), 6: ('solarized', False), 5: ('solarized', True),
         1: ('telegram', False), 2: ('telegram', True)}
# Нейтральные тона «Telegram» в web — переменные мессенджера (styles/themes.json)
TELEGRAM_NEUTRAL = [
    dict(bg='#f4f4f5', panel='#ffffff', raised='#f4f4f5', hover='#f4f4f5', line='#dadce0', lineStrong='#dadce0',
         text='#000000', muted='#707579', faint='#c4c9cc'),
    dict(bg='#0f0f0f', panel='#212121', raised='#181818', hover='#2c2c2c', line='#0f0f0f', lineStrong='#5b5b5a',
         text='#ffffff', muted='#aaaaaa', faint='#717579'),
]
NEUTRAL = ['bg', 'panel', 'raised', 'hover', 'line', 'lineStrong', 'text', 'muted', 'faint']
TONE = ['accent', 'accentInk', 'blue', 'purple', 'orange', 'aqua', 'green', 'red', 'yellow']


def block(src, name):
    start = src.index(f'const {name}')
    depth, i = 0, src.index('{', start)
    for j in range(i, len(src)):
        depth += {'{': 1, '}': -1}.get(src[j], 0)
        if depth == 0:
            return src[i:j + 1]
    raise SystemExit(f'{name}: не разобран')


def schemes(text):
    out = {}
    for m in re.finditer(r'(\w+): \[\{(.*?)\}, \{(.*?)\}\]', text, re.S):
        out[m.group(1)] = [dict(re.findall(r"(\w+): '(#[0-9a-fA-F]{6})'", part)) for part in (m.group(2), m.group(3))]
    return out


def argb(hex_):
    return '0xff' + hex_[1:].lower()


def main():
    src = WEB.read_text()
    palettes = schemes(block(src, 'PALETTES'))
    tones = schemes(block(src, 'TONES'))
    rows = []
    for theme_id, (scheme, dark) in sorted(SLOTS.items()):
        neutral = TELEGRAM_NEUTRAL[int(dark)] if scheme == 'telegram' else palettes[scheme][int(dark)]
        tone = tones[scheme][int(dark)]
        values = [argb(neutral[k]) for k in NEUTRAL] + [argb(tone[k]) for k in TONE]
        rows.append(f'        {theme_id} to Pv.Set({", ".join(v + ".toInt()" for v in values)}),')
    body = '\n'.join(rows)
    kt = f'''package org.thunderdog.challegram.parvane.sections

// Сгенерировано android/theme/gen_pv_palette.py из web/telegram-tt/src/util/colorScheme.ts — не править руками.

internal object PvPalette {{
    val byTheme: Map<Int, Pv.Set> = mapOf(
{body}
    )
}}
'''
    if '--check' in sys.argv:
        if OUT.read_text() != kt:
            raise SystemExit('PvPalette.kt устарел: python3 android/theme/gen_pv_palette.py')
        print('PvPalette.kt совпадает со схемами web')
        return
    OUT.write_text(kt)
    print(f'записан {OUT.relative_to(ROOT)}')


main()
