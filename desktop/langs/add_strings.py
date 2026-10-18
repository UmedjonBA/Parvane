#!/usr/bin/env python3
"""Parvane: добавить строки клиента в EN (tdesktop lang.strings) и RU (parvane_ru_RU.strings).

Манифест — файл с блоками
    lng_key
    EN текст
    RU текст
    (пустая строка)
Ключ уже есть — строка обновляется. Новые ключи встают после маркера `lng_parvane_upgrade_required`.
"""
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
EN = ROOT / 'tdesktop/Telegram/Resources/langs/lang.strings'
RU = ROOT / 'langs/parvane_ru_RU.strings'
MARKER = 'lng_parvane_upgrade_required'


def parse_manifest(path):
    blocks = [b for b in Path(path).read_text().split('\n\n') if b.strip()]
    out = []
    for b in blocks:
        lines = [l for l in b.strip('\n').split('\n')]
        if len(lines) != 3 or not re.match(r'^lng_[a-z0-9_#]+$', lines[0]):
            sys.exit(f'bad block: {b!r}')
        out.append((lines[0], lines[1], lines[2]))
    return out


def esc(text):
    return text.replace('\\', '\\\\').replace('"', '\\"')


def apply(path, pairs):
    src = path.read_text().split('\n')
    index = {}
    for i, line in enumerate(src):
        m = re.match(r'^"([^"]+)"\s*=', line)
        if m:
            index[m.group(1)] = i
    if MARKER not in index:
        sys.exit(f'{path}: marker {MARKER} not found')
    insert_at = index[MARKER] + 1
    new_lines = []
    for key, text in pairs:
        line = f'"{key}" = "{esc(text)}";'
        if key in index:
            src[index[key]] = line
        else:
            new_lines.append(line)
    src[insert_at:insert_at] = new_lines
    path.write_text('\n'.join(src))
    return len(new_lines)


def main():
    pairs = parse_manifest(sys.argv[1])
    for key, en, ru in pairs:
        for text in (en, ru):
            if ';' in text:
                sys.exit(f'{key}: «;» в строке выбрасывает ключ при генерации')
        tags_en = sorted(re.findall(r'\{([a-z_]+)\}', en))
        tags_ru = sorted(re.findall(r'\{([a-z_]+)\}', ru))
        if tags_en != tags_ru:
            sys.exit(f'{key}: разные переменные EN {tags_en} / RU {tags_ru}')
    added_en = apply(EN, [(k, e) for k, e, _ in pairs])
    added_ru = apply(RU, [(k, r) for k, _, r in pairs])
    print(f'EN +{added_en}, RU +{added_ru}, всего {len(pairs)}')


if __name__ == '__main__':
    main()
