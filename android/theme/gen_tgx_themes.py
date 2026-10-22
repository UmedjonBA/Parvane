#!/usr/bin/env python3
"""Parvane (spec 031, T070): темы Telegram X из цветовых схем web (`web/telegram-tt/src/util/colorScheme.ts`).

Встроенные темы X (`app/src/main/other/themes/*.tgx-theme`) перекрашиваются палитрами схем — пять схем × светлая
и тёмная на десять мест (Gruvbox — темы по умолчанию X, «Classic» и «Night Blue»; Telegram — прежние «Blue» и
«Night Black» без изменений). Цвета, которых нет в палитре (аватары, медиа, служебные), остаются от базовой темы.
Пишет файлы в `android/tgx-overlay/app/src/main/other/themes/` и таблицу названий `theme-names.json`.
  python3 android/theme/gen_tgx_themes.py <клон X> [--check]
"""
import json, re, sys, pathlib

ROOT = pathlib.Path(__file__).resolve().parents[2]
WEB = ROOT / 'web/telegram-tt/src/util/colorScheme.ts'
OUT = ROOT / 'android/tgx-overlay/app/src/main/other/themes'

# место X → (схема, тёмная?, файл, id, название EN, название RU)
SLOTS = [
    ('gruvbox', False, 'Classic.tgx-theme', 11, 'Gruvbox', 'Gruvbox'),
    ('gruvbox', True, 'Night Blue.tgx-theme', 10, 'Gruvbox Dark', 'Gruvbox тёмная'),
    ('nord', False, 'Cyan.tgx-theme', 9, 'Nord', 'Nord'),
    ('nord', True, 'White Black.tgx-theme', 4, 'Nord Dark', 'Nord тёмная'),
    ('catppuccin', False, 'Green.tgx-theme', 7, 'Catppuccin', 'Catppuccin'),
    ('catppuccin', True, 'Black White.tgx-theme', 3, 'Catppuccin Dark', 'Catppuccin тёмная'),
    ('solarized', False, 'Orange.tgx-theme', 6, 'Solarized', 'Solarized'),
    ('solarized', True, 'Red.tgx-theme', 5, 'Solarized Dark', 'Solarized тёмная'),
]
NAME_KEYS = {11: 'ThemeClassic', 10: 'ThemeNightBlue', 9: 'ThemeCyan', 4: 'ThemeWhiteBlack', 7: 'ThemeGreen',
             3: 'ThemeBlackWhite', 6: 'ThemeOrange', 5: 'ThemeRed', 1: 'ThemeBlue', 2: 'ThemeNight'}
EXTRA_NAMES = {1: ('Telegram', 'Telegram'), 2: ('Telegram Dark', 'Telegram тёмная')}

# роль палитры → цвета X
ROLES = {
    'bg': 'background chatBackground chatKeyboard iv_chatLinkBackground fileAttach playerCoverPlaceholder seekEmpty',
    'panel': 'filling overlayFilling bubbleIn_background circleButtonChat circleButtonOverlay unread headerBackground '
             'headerLightBackground notification notificationPlayer passcode bubble_mediaReply_noWallpaper '
             'bubble_unread_noWallpaper attachContact attachFile attachInlineBot attachLocation attachPhoto',
    'hover': 'fillingPressed headerPlaceholder iv_preBlockBackground iv_textCodeBackground',
    'line': 'separator chatSeparator inputInactive bubbleIn_outline bubbleIn_separator iv_separator shareSeparator '
            'bubble_chatSeparator bubbleOut_outline',
    'text': 'text bubbleIn_text drawerText iv_text iv_header iv_pageTitle headerText headerIcon headerButtonIcon '
            'headerLightText headerLightIcon playerButton unreadText iv_textCode iv_textMarked iv_textReference',
    'muted': 'textLight icon iv_caption background_icon background_text background_textLight bubbleIn_time badgeMuted '
             'chatListIcon chatListMute iv_icon iv_pageAuthor iv_pageFooter iv_pageSubtitle playerCoverIcon '
             'headerBadgeMuted headerTabInactiveText',
    'faint': 'textPlaceholder togglerInactive controlInactive sliderInactive iconLight waveformInactive '
             'togglerInactiveBackground nameInactive lineInactive',
    'link': 'textLink bubbleIn_textLink iv_textLink iv_textMarkedLink messageAuthor notificationLink inlineIcon '
            'inlineOutline inlineText messageVerticalLine file',
    'accent': 'iconActive progress checkActive controlActive togglerActive inputActive sliderActive seekDone '
              'chatSendButton profileSectionActive textNeutral badge chatListAction chatListVerify ticks ticksRead '
              'circleButtonRegular circleButtonActive circleButtonTheme headerButton headerBadge headerTabActive '
              'headerTabActiveText bubbleIn_progress textSearchQueryHighlight togglerPositive promo '
              'playerButtonActive bubbleIn_fillingPositive fillingPositive',
    'own': 'bubbleOut_background messageSwipeBackground',
    'ownAccent': 'bubbleOut_textLink bubbleOut_messageAuthor bubbleOut_ticks bubbleOut_ticksRead bubbleOut_inlineText '
                 'bubbleOut_inlineIcon bubbleOut_inlineOutline bubbleOut_chatVerticalLine bubbleOut_file '
                 'bubbleOut_fillingPositive bubbleOut_waveformActive bubbleOut_chatCorrectFilling '
                 'bubbleOut_chatCorrectChosenFilling messageCorrectFilling messageCorrectChosenFilling',
    'ownText': 'bubbleOut_text',
    'ownMeta': 'bubbleOut_time bubbleOut_separator bubbleOut_progress bubbleOut_waveformInactive',
    'onAccent': 'circleButtonRegularIcon circleButtonActiveIcon checkContent controlContent fillingPositiveContent '
                'badgeText profileSectionActiveContent',
    'accentSoft': 'togglerActiveBackground togglerPositiveBackground seekReady',
    'selection': 'textSelectionHighlight',
    'accentTint': 'messageSelection',
}


def hex_rgb(h):
    h = h.lstrip('#')
    if len(h) == 3:
        h = ''.join(c * 2 for c in h)
    return tuple(int(h[i:i + 2], 16) for i in (0, 2, 4))


def rgb_hex(c):
    return '#%02X%02X%02X' % tuple(max(0, min(255, round(v))) for v in c)


def mix(a, b, t):
    ca, cb = hex_rgb(a), hex_rgb(b)
    return rgb_hex([ca[i] + (cb[i] - ca[i]) * t for i in range(3)])


def lum(h):
    def ch(v):
        v /= 255
        return v / 12.92 if v <= 0.03928 else ((v + 0.055) / 1.055) ** 2.4
    r, g, b = (ch(v) for v in hex_rgb(h))
    return 0.2126 * r + 0.7152 * g + 0.0722 * b


def contrast(a, b):
    la, lb = sorted((lum(a), lum(b)), reverse=True)
    return (la + 0.05) / (lb + 0.05)


def palettes():
    src = WEB.read_text()
    block = src[src.index('const PALETTES'):src.index('const TONES')]
    out = {}
    for m in re.finditer(r"(\w+): \[\{(.*?)\}, \{(.*?)\}\]", block, re.S):
        def parse(body):
            return {k: v for k, v in re.findall(r"(\w+): '(#[0-9a-fA-F]+)'", body)}
        out[m.group(1)] = (parse(m.group(2)), parse(m.group(3)))
    return out


def read_theme(path):
    """→ (заголовок до '@', свойства [(строка)], цвета {ключ: значение}). Файл берётся из git клона X (HEAD):
    setup-tgx.sh кладёт поверх него наши темы, а основа — исходные."""
    import subprocess
    repo = path.parents[5]
    rel = path.relative_to(repo).as_posix()
    try:
        text = subprocess.run(['git', '-C', str(repo), 'show', f'HEAD:{rel}'], check=True, capture_output=True, text=True).stdout
    except (subprocess.CalledProcessError, FileNotFoundError):
        text = path.read_text()
    head, rest = text.split('\n@\n', 1)
    props, _, colors_part = rest.partition('\n#\n')
    props = props.strip()
    colors = {}
    for line in (l for l in colors_part.strip().splitlines() if l.strip()):
        keys, value = line.rsplit(':', 1)
        for k in keys.split(','):
            colors[k.strip()] = value.strip()
    return head, props, colors


SWATCH = {11: 'themeClassic', 10: 'themeNightBlue', 9: 'themeCyan', 4: 'themeWhiteBlack', 7: 'themeGreen',
          3: 'themeBlackWhite', 6: 'themeOrange', 5: 'themeRed'}


def swatches(pal):
    """Образцы тем в выборе X (цвет кружка): светлая — акцент схемы, тёмная — её фон."""
    out = {}
    for scheme, dark, _, tid, _, _ in SLOTS:
        p = pal[scheme][1 if dark else 0]
        out[SWATCH[tid]] = p['bg'] if dark else p['accent']
    return out


def build(scheme, dark, base_colors, p, swatch):
    colors = dict(base_colors)
    colors.update(swatch)
    role = {
        'bg': p['bg'], 'panel': p['panel'], 'hover': p['hover'], 'line': p['line'], 'text': p['text'],
        'muted': p['muted'], 'faint': p['faint'], 'link': p['link'], 'accent': p['accent'], 'own': p['own'],
        'ownAccent': p['ownAccent'], 'ownText': p['text'], 'ownMeta': mix(p['own'], p['text'], 0.6),
        'onAccent': '#FFFFFF', 'accentSoft': mix(p['panel'], p['accent'], 0.45),
        'selection': p['accent'] + '40', 'accentTint': p['accent'] + '14',
    }
    for r, keys in ROLES.items():
        for k in keys.split():
            colors[k] = role[r]
    return colors


def write(path, head_lines, props, colors):
    groups = {}
    for k, v in colors.items():
        groups.setdefault(v, []).append(k)
    lines = [', '.join(sorted(ks)) + ': ' + v for v, ks in sorted(groups.items(), key=lambda kv: sorted(kv[1])[0].lower())]
    path.write_text('!\n' + '\n'.join(head_lines) + '\n@\n' + props + '\n#\n' + '\n'.join(lines) + '\n')


def main():
    tgx = pathlib.Path(sys.argv[1]) / 'app/src/main/other/themes'
    check = '--check' in sys.argv
    pal = palettes()
    _, _, blue = read_theme(tgx / 'Blue.tgx-theme')
    _, _, classic = read_theme(tgx / 'Classic.tgx-theme')
    _, dark_props, night = read_theme(tgx / 'Night Blue.tgx-theme')
    light_base = {**blue, **classic}
    dark_base = {**blue, **night}
    problems = []
    OUT.mkdir(parents=True, exist_ok=True)
    for scheme, dark, file, tid, en, ru in SLOTS:
        p = pal[scheme][1 if dark else 0]
        colors = build(scheme, dark, dark_base if dark else light_base, p, swatches(pal))
        # сторож: читаемость текста на фоне и на своём сообщении, белый на акценте
        for a, b, need, what in ((p['text'], p['panel'], 4.5, 'текст/панель'), (p['text'], p['own'], 4.0, 'текст/своё'),
                                 ('#FFFFFF', p['accent'], 2.5, 'белый/акцент'), (p['link'], p['panel'], 3.0, 'ссылка/панель')):
            if contrast(a, b) < need:
                problems.append(f'{scheme} {"dark" if dark else "light"}: {what} {contrast(a, b):.2f} < {need}')
        props = ('dark, parentTheme, shadowDepth, wallpaperUsageId: 1' if dark else 'parentTheme: 1')
        # name — из файла X: по нему сборка называет класс темы (ThemeNightBlue и т. п.); видимое название — строки
        orig = read_theme(tgx / file)[0]
        name = re.search(r'name: "([^"]+)"', orig).group(1)
        head = [f'id: {tid}', f'name: "{name}"', 'time: 1792656000']
        if not check:
            write(OUT / file, head, props, colors)
    # Telegram («Blue», «Night Black») — прежние цвета, только образцы тем
    for file in ('Blue.tgx-theme', 'Night Black.tgx-theme', 'Pink.tgx-theme'):
        head, props, colors = read_theme(tgx / file)
        colors.update(swatches(pal))
        if not check:
            write(OUT / file, head.strip().lstrip('!').strip().splitlines(), props, colors)
    names = {NAME_KEYS[tid]: [en, ru] for _, _, _, tid, en, ru in SLOTS}
    for tid, (en, ru) in EXTRA_NAMES.items():
        names[NAME_KEYS[tid]] = [en, ru]
    if not check:
        (OUT.parent / 'theme-names.json').write_text(json.dumps(names, ensure_ascii=False, indent=1))
    for pr in problems:
        print('КОНТРАСТ:', pr)
    print(f'тем: {len(SLOTS)}, проблем контраста: {len(problems)}')
    sys.exit(1 if problems else 0)


if __name__ == '__main__':
    main()
