#!/usr/bin/env python3
"""Parvane (spec 032): линейные значки web для экранов оверлея Android.

Источники — `components/main/ParvaneIcon.tsx` (оболочка: нижняя панель, профиль, папки) и
`components/parvane/notes/PvIcon.tsx` (разделы). Круги и прямоугольники переводятся в контуры SVG; поле 24×24,
обводка 1,8, концы круглые. Имя из обоих наборов с разным рисунком — у оболочки префикс `shell_` не нужен: при
совпадении имени берётся PvIcon (рисунки совпадают). Пишет `PvIcons.kt`.
  python3 android/theme/gen_pv_icons.py [--check]
"""
import re, sys, pathlib

ROOT = pathlib.Path(__file__).resolve().parents[2]
SRC = ROOT / 'web/telegram-tt/src/components'
OUT = ROOT / 'android/tgx-overlay/app/src/main/java/org/thunderdog/challegram/parvane/sections/PvIcons.kt'


def body(text, start):
    depth, i = 0, text.index('{', text.index(start))
    for j in range(i, len(text)):
        depth += {'{': 1, '}': -1}.get(text[j], 0)
        if depth == 0:
            return text[i + 1:j]
    raise SystemExit(f'{start}: не разобран')


def entries(text):
    """name: [ ... ] на верхнем уровне объекта."""
    out, i = {}, 0
    while True:
        m = re.compile(r'(\w+): \[').search(text, i)
        if not m:
            return out
        depth, j = 0, m.end() - 1
        for k in range(j, len(text)):
            depth += {'[': 1, ']': -1}.get(text[k], 0)
            if depth == 0:
                break
        out[m.group(1)] = text[j + 1:k]
        i = k + 1


def num(v):
    return f'{float(v):g}'


def circle(cx, cy, r):
    cx, cy, r = float(cx), float(cy), float(r)
    return f'M{num(cx - r)} {num(cy)}a{num(r)} {num(r)} 0 1 0 {num(2 * r)} 0a{num(r)} {num(r)} 0 1 0 {num(-2 * r)} 0z'


def rect(x, y, w, h, rx):
    x, y, w, h, rx = map(float, (x, y, w, h, rx))
    if rx <= 0:
        return f'M{num(x)} {num(y)}h{num(w)}v{num(h)}h{num(-w)}z'
    return (f'M{num(x + rx)} {num(y)}h{num(w - 2 * rx)}a{num(rx)} {num(rx)} 0 0 1 {num(rx)} {num(rx)}'
            f'v{num(h - 2 * rx)}a{num(rx)} {num(rx)} 0 0 1 {num(-rx)} {num(rx)}h{num(-(w - 2 * rx))}'
            f'a{num(rx)} {num(rx)} 0 0 1 {num(-rx)} {num(-rx)}v{num(-(h - 2 * rx))}'
            f'a{num(rx)} {num(rx)} 0 0 1 {num(rx)} {num(-rx)}z')


def main():
    shell = entries(body((SRC / 'main/ParvaneIcon.tsx').read_text(), 'const PATHS'))
    kit = entries(body((SRC / 'parvane/notes/PvIcon.tsx').read_text(), 'const ICONS'))
    icons = {}
    for name, raw in shell.items():
        icons[name] = [(d, False, False) for d in re.findall(r"'([^']+)'", raw)]
    for name, raw in kit.items():
        shapes = []
        for item in re.findall(r'\{([^{}]*)\}', raw):
            if m := re.search(r"d: '([^']+)'", item):
                shapes.append((m.group(1), False, False))
            elif m := re.search(r'c: \[([^\]]+)\]', item):
                shapes.append((circle(*[p.strip() for p in m.group(1).split(',')]), 'isFilled' in item, False))
            elif m := re.search(r'r: \[([^\]]+)\]', item):
                shapes.append((rect(*[p.strip() for p in m.group(1).split(',')]), False, 'isDashed' in item))
        icons[name] = shapes
    rows = []
    for name in sorted(icons):
        shapes = ', '.join(f'S("{d}"{", filled = true" if f else ""}{", dashed = true" if dsh else ""})'
                           for d, f, dsh in icons[name])
        rows.append(f'        "{name}" to listOf({shapes}),')
    kt = '''package org.thunderdog.challegram.parvane.sections

// Сгенерировано android/theme/gen_pv_icons.py из ParvaneIcon.tsx и PvIcon.tsx web — не править руками.

object PvIcons {
    class S(val d: String, val filled: Boolean = false, val dashed: Boolean = false)

    val all: Map<String, List<S>> = mapOf(
''' + '\n'.join(rows) + '''
    )
}
'''
    if '--check' in sys.argv:
        if OUT.read_text() != kt:
            raise SystemExit('PvIcons.kt устарел: python3 android/theme/gen_pv_icons.py')
        print('PvIcons.kt совпадает со значками web')
        return
    OUT.write_text(kt)
    print(f'записан {OUT.relative_to(ROOT)}: {len(icons)} значков')


main()
