#!/usr/bin/env python3
# Таблица тонов `--pv-*` для desktop (parvane/parvane_space_table.h) из space-tokens.json.
# Запуск: python3 desktop/theme/gen_space_table.py [--check]
import json, os, sys

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, '../tdesktop/Telegram/SourceFiles/parvane/parvane_space_table.h')
TONES = [('Accent', '--pv-accent'), ('AccentInk', '--pv-accent-ink'), ('Blue', '--pv-blue'),
         ('Purple', '--pv-purple'), ('Orange', '--pv-orange'), ('Aqua', '--pv-aqua'), ('Green', '--pv-green'),
         ('Red', '--pv-red'), ('Yellow', '--pv-yellow'), ('Bg', '--pv-bg'), ('Panel', '--pv-panel'),
         ('Raised', '--pv-raised'), ('Hover', '--pv-hover'), ('Line', '--pv-line'), ('Line2', '--pv-line2'),
         ('Fg', '--pv-fg'), ('Muted', '--pv-muted'), ('Faint', '--pv-faint')]

def color(value):
    # var(...) — тон берётся из палитры мессенджера (схема «Telegram»): 0
    if not value.startswith('#'):
        return '0x00000000'
    v = value[1:]
    if len(v) == 6:
        v = v + 'ff'
    r, g, b, a = v[0:2], v[2:4], v[4:6], v[6:8]
    return '0x' + (a + r + g + b).lower()

data = json.load(open(os.path.join(HERE, 'space-tokens.json')))
lines = [
    '// Создано desktop/theme/gen_space_table.py из desktop/theme/space-tokens.json (web colorScheme.ts) —',
    '// руками не править. Тона `--pv-*`: ARGB; 0 — взять из палитры мессенджера (схема «Telegram»).',
    '#pragma once',
    '',
    '#include <array>',
    '#include <cstdint>',
    '',
    'namespace Parvane::SpaceTable {',
    '',
    'inline constexpr const char *kSchemes[] = { ' + ', '.join('"%s"' % s for s in data['schemes']) + ' };',
    'inline constexpr int kSchemeCount = %d;' % len(data['schemes']),
    'inline constexpr const char *kDefaultScheme = "%s";' % data['defaultScheme'],
    'inline constexpr int kToneCount = %d;' % len(TONES),
    '',
    '// [схема][0 — светлая, 1 — тёмная][тон в порядке Parvane::Tone]',
    'inline constexpr std::uint32_t kTones[kSchemeCount][2][kToneCount] = {',
]
for scheme in data['schemes']:
    lines.append('\t{ // %s' % scheme)
    for mode in ('light', 'dark'):
        tokens = data['byScheme'][scheme][mode]['tokens']
        lines.append('\t\t{ ' + ', '.join(color(tokens[k]) for _, k in TONES) + ' },')
    lines.append('\t},')
lines += ['};', '', '// Образцы схемы для выбора в настройках: [схема][режим][фон, панель, акцент, текст]',
          'inline constexpr std::uint32_t kSwatches[kSchemeCount][2][4] = {']
for scheme in data['schemes']:
    lines.append('\t{ // %s' % scheme)
    for mode in ('light', 'dark'):
        sw = data['byScheme'][scheme][mode]['swatches']
        lines.append('\t\t{ ' + ', '.join(color(c) for c in sw) + ' },')
    lines.append('\t},')
lines += ['};', '', '} // namespace Parvane::SpaceTable', '']
text = '\n'.join(lines)
if '--check' in sys.argv:
    ok = os.path.exists(OUT) and open(OUT).read() == text
    print('ok' if ok else 'устарел: перегенерируйте')
    sys.exit(0 if ok else 1)
open(OUT, 'w').write(text)
print('записан', os.path.relpath(OUT, HERE))
