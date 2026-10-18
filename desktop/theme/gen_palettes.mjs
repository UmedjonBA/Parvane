// Parvane (spec 029, T051/T053): палитры оформления «Пространство» для tdesktop из цветовых схем web.
//
// Источник правды — web/telegram-tt/src/util/colorScheme.ts: скрипт его ИМПОРТИРУЕТ (цвета руками не копируются)
// и пишет:
//   desktop/theme/space-tokens.json                       — переменные web по схемам и режимам (для C++-таблицы);
//   desktop/theme/space-<схема>-<light|dark>.tdesktop-palette — палитры tdesktop (4 схемы × 2 режима);
//   desktop/theme/space-<схема>-<light|dark>.tdesktop-theme   — то же в архиве темы с фоном чата 1×1 (плоский фон).
// Схема «telegram» = штатные темы tdesktop: палитр для неё нет, токены --pv-* в JSON есть.
//
// Запуск (из корня репозитория; tsx лежит в зависимостях web, он и разбирает TypeScript):
//   web/telegram-tt/node_modules/.bin/tsx desktop/theme/gen_palettes.mjs          — перегенерировать;
//   web/telegram-tt/node_modules/.bin/tsx desktop/theme/gen_palettes.mjs --check  — проверить, ничего не пишет.
//
// Как tdesktop читает палитру (window_theme.cpp LoadTheme → palette::finalize, codegen palette compute):
// ключ из файла становится «загруженным»; ключ без записи, у которого в colors.palette есть исходный ключ
// (`key: other;` или `#hex | other`), берёт значение исходного, если тот загружен; иначе — своё значение из
// colors.palette, т. е. ДНЕВНОЕ. Поэтому:
//   - светлый режим: штатные ключи просто не пишутся (база — дневная палитра);
//   - тёмный режим: у штатных ключей пишется значение ночной темы tdesktop (night.tdesktop-theme), иначе
//     звонки, просмотрщик и т. п. получили бы дневные цвета. Ключи, которые и так следуют за сопоставленным
//     ключом, не пишутся ни в каком режиме.

import { createRequire } from 'node:module';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { crc32, deflateSync, inflateRawSync } from 'node:zlib';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const WEB = join(ROOT, 'web', 'telegram-tt');
const COLOR_SCHEME_TS = join(WEB, 'src', 'util', 'colorScheme.ts');
const PALETTE_FILE = join(ROOT, 'desktop', 'tdesktop', 'Telegram', 'lib_ui', 'ui', 'colors.palette');
const NIGHT_THEME_FILE = join(ROOT, 'desktop', 'tdesktop', 'Telegram', 'Resources', 'night.tdesktop-theme');
const TOKENS_FILE = join(HERE, 'space-tokens.json');

const MODES = ['light', 'dark'];
const WHITE = '#ffffff';
const BLACK = '#000000';
// Неизменная дата записей архива — перегенерация даёт те же байты
const ZIP_DOS_DATE = ((2026 - 1980) << 9) | (1 << 5) | 1;
const COLOR_RE = /^#[0-9a-f]{6}([0-9a-f]{2})?$/;

const isCheck = process.argv.includes('--check');

const scheme = await import(pathToFileURL(COLOR_SCHEME_TS).href);
// Та же библиотека и тот же mix, что в colorScheme.ts (там функция не экспортируется)
const webRequire = createRequire(join(WEB, 'package.json'));
const { default: Color } = await import(
  pathToFileURL(webRequire.resolve('colorjs.io').replace(/color\.cjs$/, 'color.js')).href
);

function normalizeHex(value) {
  let hex = value.trim().toLowerCase();
  if (/^#[0-9a-f]{3,4}$/.test(hex)) {
    hex = `#${hex.slice(1).split('').map((ch) => ch + ch).join('')}`;
  }
  if (!COLOR_RE.test(hex)) throw new Error(`Не цвет: ${value}`);
  return hex;
}

function mix(from, to, ratio) {
  return normalizeHex(new Color(from).mix(new Color(to), ratio, { space: 'srgb' }).toString({ format: 'hex' }));
}

// Цвет с прозрачностью `aa` (две шестнадцатеричные цифры), как `${p.accent}1E` в web
function alpha(hex, aa) {
  return `${normalizeHex(hex).slice(0, 7)}${aa.toLowerCase()}`;
}

// ---------------------------------------------------------------------------------------------------------------
// Таблица соответствия: ключ палитры tdesktop → значение из схемы web.
// `c.p` — палитра схемы (13 тонов PALETTES), `c.t` — тона TONES (--pv-*), `c.m` — переменные buildMode (--color-*),
// `c.dark` — тёмный режим; производные — `mix`/`alpha` и готовые `c.ripple`, `c.shade`, `c.accentOver` и т. п.
// Принципы: фон вокруг колонок = bg; колонки, список чатов, шапки, меню, окна = panel; наведение = hover;
// активный чат = accent с белым текстом; входящие = panel, исходящие = own; акцентный текст = link;
// разделители = line / lineStrong; второстепенный текст = muted / faint; кнопки = accent; ошибки и «хорошо» —
// красный и зелёный тона схемы.
// ---------------------------------------------------------------------------------------------------------------
const MAP = [
  {
    group: 'окно и базовые цвета',
    keys: {
      windowBg: (c) => c.p.panel,
      windowFg: (c) => c.p.text,
      windowBgOver: (c) => c.p.hover,
      windowBgRipple: (c) => c.ripple,
      windowSubTextFg: (c) => c.p.muted,
      windowSubTextFgOver: (c) => c.mutedOver,
      windowBoldFg: (c) => c.p.text,
      windowBoldFgOver: (c) => c.p.text,
      windowBgActive: (c) => c.p.accent,
      windowFgActive: () => WHITE,
      windowActiveTextFg: (c) => c.p.link,
      // Серый «тени без прозрачности» — разделитель
      windowShadowFgFallback: (c) => c.p.line,
    },
  },
  {
    group: 'кнопки',
    keys: {
      activeButtonBgOver: (c) => c.accentOver,
      activeButtonBgRipple: (c) => c.shade,
      activeButtonSecondaryFg: (c) => mix(WHITE, c.p.accent, 0.25),
      activeLineFg: (c) => c.p.accent,
      activeLineFgError: (c) => c.t.red,
      lightButtonBgOver: (c) => c.accentTint,
      lightButtonBgRipple: (c) => mix(c.p.panel, c.p.accent, 0.22),
      attentionButtonFg: (c) => c.t.red,
      attentionButtonFgOver: (c) => c.t.red,
      attentionButtonBgOver: (c) => mix(c.p.panel, c.t.red, 0.12),
      attentionButtonBgRipple: (c) => mix(c.p.panel, c.t.red, 0.22),
    },
  },
  {
    group: 'меню, полосы прокрутки, мелкие значки',
    keys: {
      menuIconFg: (c) => c.p.muted,
      menuIconFgOver: (c) => mix(c.p.muted, c.p.text, 0.2),
      menuSubmenuArrowFg: (c) => c.p.text,
      menuFgDisabled: (c) => c.p.faint,
      menuSeparatorFg: (c) => c.p.line,
      // Полосы прокрутки — текст с прозрачностью (чёрная прозрачность пропала бы на тёмном фоне)
      scrollBarBg: (c) => alpha(c.p.text, '53'),
      scrollBarBgOver: (c) => alpha(c.p.text, '7a'),
      scrollBg: (c) => alpha(c.p.text, '1a'),
      scrollBgOver: (c) => alpha(c.p.text, '2c'),
      smallCloseIconFg: (c) => c.p.faint,
      smallCloseIconFgOver: (c) => c.p.muted,
    },
  },
  {
    group: 'поля ввода, флажки, ползунки, подсказки',
    keys: {
      placeholderFgActive: (c) => c.p.faint,
      inputBorderFg: (c) => c.p.lineStrong,
      filterInputBorderFg: (c) => c.p.accent,
      checkboxFg: (c) => c.p.faint,
      sliderBgInactive: (c) => c.p.lineStrong,
      tooltipBg: (c) => c.p.raised,
      tooltipFg: (c) => c.p.text,
      tooltipBorderFg: (c) => c.p.lineStrong,
    },
  },
  {
    group: 'заголовок окна (свой, Windows/macOS): фон вокруг колонок',
    keys: {
      // Копия windowBgOver в colors.palette — переопределена: заголовок сливается с фоном вокруг колонок
      titleBg: (c) => c.p.bg,
      titleButtonFg: (c) => c.p.faint,
      titleButtonBgOver: (c) => c.p.hover,
      titleButtonFgOver: (c) => c.p.muted,
      titleFg: (c) => c.p.faint,
      titleFgActive: (c) => c.p.text,
    },
  },
  {
    group: 'окна (боксы) и экран входа',
    keys: {
      boxTextFgGood: (c) => c.t.green,
      boxTextFgError: (c) => c.t.red,
      boxTitleFg: (c) => c.p.text,
      boxTitleAdditionalFg: (c) => c.p.muted,
      introCoverTopBg: (c) => c.shade,
      introCoverBottomBg: (c) => c.p.accent,
      introCoverIconsFg: (c) => mix(c.p.accent, WHITE, 0.25),
      introCoverPlaneTrace: (c) => alpha(mix(c.p.accent, WHITE, 0.25), '69'),
    },
  },
  {
    group: 'список чатов',
    keys: {
      dialogsDraftFg: (c) => c.t.red,
      dialogsSendingIconFg: (c) => c.p.faint,
      dialogsSentIconFg: (c) => c.p.link,
      dialogsSentIconFgOver: (c) => c.p.link,
      dialogsUnreadBgMuted: (c) => c.p.faint,
      // `#hex | dialogsUnreadBg`: без записи стал бы цветом акцента — «в сети» остаётся зелёным
      dialogsOnlineBadgeFg: (c) => c.t.green,
      // Выбранный (активный) чат — заливка акцентом, текст белый
      dialogsBgActive: (c) => c.p.accent,
      dialogsDraftFgActive: (c) => mix(WHITE, c.p.accent, 0.25),
    },
  },
  {
    group: 'панель эмодзи и стикеров',
    keys: {
      // `#hex | emojiPanBg` с прозрачностью — без записи потерялась бы прозрачность
      emojiPanHeaderBg: (c) => alpha(c.p.panel, 'f2'),
      emojiIconFg: (c) => c.p.faint,
      stickerPreviewBg: (c) => alpha(c.p.panel, 'b0'),
    },
  },
  {
    group: 'сообщения: значки отправки, звонки в ленте, полоса непрочитанного',
    keys: {
      historyOutIconFg: (c) => c.p.ownAccent,
      historyOutIconFgSelected: (c) => c.p.ownAccent,
      historySendingOutIconFg: (c) => mix(c.p.own, c.p.text, 0.45),
      historySendingInIconFg: (c) => c.p.faint,
      historyCallArrowInFg: (c) => c.t.green,
      historyCallArrowInFgSelected: (c) => c.t.green,
      historyUnreadBarBg: (c) => c.p.raised,
      historyUnreadBarFg: (c) => c.p.link,
    },
  },
  {
    group: 'фон чата (плоский): полоса прокрутки и служебные сообщения',
    keys: {
      historyScrollBarBg: (c) => alpha(c.p.muted, '7a'),
      historyScrollBarBgOver: (c) => alpha(c.p.muted, 'bc'),
      historyScrollBg: (c) => alpha(c.p.muted, '4c'),
      historyScrollBgOver: (c) => alpha(c.p.muted, '6b'),
      // Служебные сообщения и даты на фоне bg: светлый режим — приглушённая плашка с белым текстом,
      // тёмный — приподнятая плашка с текстом схемы
      msgServiceBg: (c) => (c.dark ? alpha(c.p.raised, 'e6') : alpha(c.p.muted, 'cc')),
      msgServiceBgSelected: (c) => (c.dark
        ? alpha(mix(c.p.raised, c.p.accent, 0.3), 'e6')
        : alpha(mix(c.p.muted, c.p.accent, 0.3), 'd9')),
      // Копия windowFgActive — переопределена под плашку тёмного режима
      msgServiceFg: (c) => (c.dark ? c.p.text : WHITE),
    },
  },
  {
    group: 'сообщения: входящие (panel) и исходящие (own)',
    keys: {
      msgInBgSelected: (c) => mix(c.p.panel, c.p.accent, 0.18),
      msgOutBg: (c) => c.p.own,
      msgOutBgSelected: (c) => c.m['--color-background-own-selected'],
      msgSelectOverlay: (c) => alpha(c.p.accent, '4c'),
      msgStickerOverlay: (c) => alpha(c.p.accent, '7f'),
      msgOutServiceFg: (c) => c.p.ownAccent,
      msgOutServiceFgSelected: (c) => c.p.ownAccent,
      // Тени под пузырями с прежней прозрачностью; в тёмном режиме основа чёрная
      msgInShadow: (c) => alpha(c.shadowBase, '29'),
      msgInShadowSelected: (c) => alpha(c.p.accent, '29'),
      msgOutShadow: (c) => alpha(c.dark ? BLACK : mix(c.p.own, c.p.text, 0.5), '29'),
      msgOutShadowSelected: (c) => alpha(c.p.accent, '29'),
      msgInDateFg: (c) => c.p.muted,
      msgInDateFgSelected: (c) => c.p.muted,
      msgOutDateFg: (c) => c.m['--color-message-meta-own'],
      msgOutDateFgSelected: (c) => c.m['--color-message-meta-own'],
      msgOutReplyBarColor: (c) => c.p.ownAccent,
      // Моноширинный текст, как --color-code / --color-code-own
      msgInMonoFg: (c) => c.m['--color-code'],
      msgOutMonoFg: (c) => c.m['--color-code-own'],
      msgDateImgBgSelected: (c) => alpha(c.shade, '87'),
    },
  },
  {
    group: 'сообщения: файлы и голосовые',
    keys: {
      msgFileThumbLinkOutFg: (c) => c.p.ownAccent,
      msgFileThumbLinkOutFgSelected: (c) => c.p.ownAccent,
      msgFileInBgOver: (c) => c.accentOver,
      msgFileInBgSelected: (c) => c.shade,
      msgFileOutBg: (c) => c.p.ownAccent,
      msgFileOutBgSelected: (c) => mix(c.p.ownAccent, BLACK, 0.14),
      msgWaveformInActiveSelected: (c) => c.shade,
      msgWaveformInInactive: (c) => c.p.lineStrong,
      msgWaveformInInactiveSelected: (c) => mix(c.p.lineStrong, c.p.accent, 0.3),
      msgWaveformOutActive: (c) => c.p.ownAccent,
      msgWaveformOutActiveSelected: (c) => c.p.ownAccent,
      msgWaveformOutInactive: (c) => mix(c.p.own, c.p.ownAccent, 0.35),
      msgWaveformOutInactiveSelected: (c) => mix(c.p.own, c.p.ownAccent, 0.35),
    },
  },
  {
    group: 'общие медиа, профиль, медиаплеер',
    keys: {
      overviewPhotoSelectOverlay: (c) => alpha(c.p.accent, '33'),
      profileStatusFgOver: (c) => c.mutedOver,
      mediaPlayerDisabledFg: (c) => mix(c.p.panel, c.p.accent, 0.4),
    },
  },
  {
    group: 'боковая панель папок (рейка разделов): фон вокруг колонок',
    keys: {
      sideBarBg: (c) => c.p.bg,
      sideBarBgActive: (c) => c.p.raised,
      sideBarBgRipple: (c) => c.p.hover,
      sideBarTextFg: (c) => c.p.muted,
      sideBarTextFgActive: (c) => c.p.link,
      sideBarIconFg: (c) => c.p.muted,
      sideBarIconFgActive: (c) => c.p.link,
      sideBarBadgeBg: (c) => c.p.accent,
      sideBarBadgeBgMuted: (c) => c.p.faint,
      sideBarBadgeFg: () => WHITE,
    },
  },
  {
    group: 'прочее: орфография, плашки ролей',
    keys: {
      // `#hex | attentionButtonFg` с прозрачностью
      spellUnderline: (c) => alpha(c.t.red, '88'),
      rankAdminFg: (c) => c.t.green,
      rankOwnerFg: (c) => c.t.purple,
    },
  },
];

// Ключи со своим цветом, оставленные штатными tdesktop (в web смысла нет либо цвет не зависит от схемы)
const STOCK = [
  {
    group: 'тени, затемнения, фон картинок',
    reason: 'прозрачный чёрный работает на любой схеме',
    keys: ['windowShadowFg', 'shadowFg', 'slideFadeOutBg', 'imageBg', 'imageBgTransparent', 'radialBg',
      'titleShadow', 'layerBg', 'photoCropPointFg', 'historyForwardChooseBg', 'historyToDownShadow',
      'historySendingInvertedIconFg', 'msgDateImgBg', 'msgDateImgBgOver', 'overviewCheckBg', 'songCoverOverlayFg',
      'dialogsSendingIconFgActive', 'dialogsOnlineBadgeFgActive', 'stickerPanDeleteBg'],
  },
  {
    group: 'кнопки ботов',
    reason: 'боты вне задачи (решение пользователя)',
    keys: ['botKbPrimaryBg', 'botKbDangerBg', 'botKbSuccessBg', 'botKbInlinePrimaryBg', 'botKbInlineDangerBg',
      'botKbInlineSuccessBg', 'msgBotKbOverBgAdd', 'msgBotKbRippleBg'],
  },
  {
    group: 'системное: кнопка закрытия Windows, значок в трее, устаревшая ОС',
    reason: 'цвета системы, не оформления',
    keys: ['titleButtonCloseBgOver', 'trayCounterBg', 'trayCounterBgMute', 'trayCounterFg', 'trayCounterBgMacInvert',
      'trayCounterFgMacInvert', 'outdatedFg', 'outdateSoonBg', 'outdatedBg'],
  },
  {
    group: 'экран входа: самолёт',
    reason: 'рисунок Telegram, в web аналога нет',
    keys: ['introCoverPlaneInner', 'introCoverPlaneOuter', 'introCoverPlaneTop'],
  },
  {
    group: 'цвета собеседников и значков настроек',
    reason: 'в web `--color-peer-*` и плитки значков от схемы не зависят',
    keys: ['historyPeer1NameFg', 'historyPeer1UserpicBg', 'historyPeer2NameFg', 'historyPeer2UserpicBg',
      'historyPeer3NameFg', 'historyPeer3UserpicBg', 'historyPeer4UserpicBg', 'historyPeer5NameFg',
      'historyPeer5UserpicBg', 'historyPeer6NameFg', 'historyPeer6UserpicBg', 'historyPeer7NameFg',
      'historyPeer7UserpicBg', 'historyPeer8NameFg', 'historyPeer8UserpicBg', 'settingsIconBg1', 'settingsIconBg2',
      'settingsIconBg3', 'settingsIconBg4', 'settingsIconBg5', 'settingsIconBg6', 'settingsIconBg8',
      'settingsIconBgArchive', 'settingsIconFg'],
  },
  {
    group: 'значки типов файлов, карта, ролики, всплывающие уведомления',
    reason: 'цвет обозначает тип файла / чужой сервис; тосты тёмные в обеих темах',
    keys: ['msgFile1Bg', 'msgFile1BgDark', 'msgFile1BgOver', 'msgFile1BgSelected', 'msgFile2Bg', 'msgFile2BgDark',
      'msgFile2BgOver', 'msgFile2BgSelected', 'msgFile3Bg', 'msgFile3BgDark', 'msgFile3BgOver', 'msgFile3BgSelected',
      'msgFile4Bg', 'msgFile4BgDark', 'msgFile4BgOver', 'msgFile4BgSelected', 'mapPointDrop', 'mapPointDot',
      'youtubePlayIconBg', 'videoPlayIconBg', 'videoPlayIconFg', 'toastBg', 'toastFg', 'photoEditorItemBaseHandleFg'],
  },
  {
    group: 'просмотрщик медиа',
    reason: 'тёмный оверлей поверх всего, в web тоже не зависит от схемы',
    keys: ['mediaviewFileRedCornerFg', 'mediaviewFileYellowCornerFg', 'mediaviewFileGreenCornerFg',
      'mediaviewFileBlueCornerFg', 'mediaviewMenuBg', 'mediaviewMenuBgOver', 'mediaviewMenuBgRipple', 'mediaviewBg',
      'mediaviewControlBg', 'mediaviewControlFg', 'mediaviewCaptionBg', 'mediaviewTextLinkFg',
      'mediaviewPlaybackActive', 'mediaviewPlaybackInactive', 'mediaviewPlaybackActiveOver',
      'mediaviewPlaybackInactiveOver', 'mediaviewPlaybackProgressFg', 'mediaviewPlaybackIconRipple',
      'mediaviewPipControlsFg', 'mediaviewPipControlsFgOver', 'mediaviewPipPlaybackActive',
      'mediaviewPipPlaybackInactive', 'mediaviewTransparentBg', 'mediaviewTransparentFg'],
  },
  {
    group: 'звонки',
    reason: 'окна звонков тёмные в обеих темах (в web оверлей звонка тоже свой)',
    keys: ['callBg', 'callBgOpaque', 'callBgButton', 'callNameFg', 'callStatusFg', 'callIconBg', 'callIconFg',
      'callIconBgActive', 'callIconFgActive', 'callIconActiveRipple', 'callAnswerBg', 'callAnswerRipple',
      'callAnswerBgOuter', 'callHangupBg', 'callHangupRipple', 'callMuteRipple', 'groupCallBg', 'groupCallActiveFg',
      'groupCallMembersBg', 'groupCallMembersBgOver', 'groupCallMembersBgRipple', 'groupCallMembersFg',
      'groupCallMemberActiveIcon', 'groupCallMemberActiveStatus', 'groupCallMemberInactiveIcon',
      'groupCallMemberInactiveStatus', 'groupCallMemberMutedIcon', 'groupCallMemberNotJoinedStatus',
      'groupCallIconFg', 'groupCallLive1', 'groupCallLive2', 'groupCallMuted1', 'groupCallMuted2',
      'groupCallForceMutedBar1', 'groupCallForceMutedBar2', 'groupCallForceMutedBar3', 'groupCallForceMuted1',
      'groupCallForceMuted2', 'groupCallForceMuted3', 'groupCallMenuBg', 'groupCallMenuBgOver',
      'groupCallMenuBgRipple', 'groupCallLeaveBg', 'groupCallLeaveBgRipple', 'groupCallVideoTextFg',
      'groupCallVideoSubTextFg'],
  },
  {
    group: 'Premium, Stars, платежи, статистика, кошелёк',
    reason: 'функции вне задачи (решение пользователя)',
    keys: ['paymentsTipActive', 'stickerPanPremium1', 'stickerPanPremium2', 'premiumButtonBg1', 'premiumButtonBg2',
      'premiumButtonBg3', 'premiumButtonFg', 'premiumIconBg1', 'premiumIconBg2', 'premiumIconBg3',
      'statisticsChartInactive', 'statisticsChartActive', 'statisticsChartLineBlue', 'statisticsChartLineGreen',
      'statisticsChartLineRed', 'statisticsChartLineGolden', 'statisticsChartLineLightblue',
      'statisticsChartLineLightgreen', 'statisticsChartLineOrange', 'statisticsChartLineIndigo',
      'statisticsChartLinePurple', 'statisticsChartLineCyan', 'creditsBg1', 'creditsBg2', 'creditsBg3', 'creditsFg',
      'creditsStroke', 'currencyFg', 'walletTitleBg', 'walletTitleButtonFg', 'walletTitleButtonBgOver',
      'walletTitleButtonFgOver', 'walletTopBg', 'walletBalanceFg', 'walletSubBalanceFg', 'walletTopLabelFg',
      'walletTopIconRipple'],
  },
];

// ---------------------------------------------------------------------------------------------------------------

const palette = parsePalette(readFileSync(PALETTE_FILE, 'utf8'));
const night = parseThemeValues(readZipEntry(readFileSync(NIGHT_THEME_FILE), 'colors.tdesktop-theme').toString('utf8'));
const mapping = buildMappingIndex();
const coverageErrors = checkCoverage();

const outputs = new Map();
const tokens = {
  _comment: 'Создано desktop/theme/gen_palettes.mjs из web/telegram-tt/src/util/colorScheme.ts — руками не править',
  source: 'web/telegram-tt/src/util/colorScheme.ts',
  schemes: scheme.COLOR_SCHEMES,
  defaultScheme: scheme.DEFAULT_COLOR_SCHEME,
  byScheme: {},
};
const stats = {};

for (const name of scheme.COLOR_SCHEMES) {
  const colors = scheme.buildSchemeColors(name);
  tokens.byScheme[name] = {};
  MODES.forEach((mode, index) => {
    const theme = mode;
    const modeColors = name === 'telegram'
      ? undefined
      : Object.fromEntries(Object.entries(colors).map(([key, pair]) => [key, pair[index]]));
    const schemeTokens = scheme.buildSchemeTokens(name, theme);
    const entry = {
      palette: modeColors ? recoverPalette(modeColors, schemeTokens) : undefined,
      colors: modeColors,
      tokens: schemeTokens,
      chatColors: scheme.getSchemeChatColors(name, theme),
      swatches: scheme.getSchemeSwatches(name, theme),
    };
    tokens.byScheme[name][mode] = entry;
    if (!modeColors) return;

    const base = `space-${name}-${mode}`;
    const { text, counts } = buildPaletteFile(name, mode, entry);
    stats[base] = counts;
    outputs.set(join(HERE, `${base}.tdesktop-palette`), Buffer.from(text, 'utf8'));
    outputs.set(join(HERE, `${base}.tdesktop-theme`), buildThemeZip(text, entry.palette.bg));
  });
}
outputs.set(TOKENS_FILE, Buffer.from(`${JSON.stringify(tokens, undefined, 2)}\n`, 'utf8'));

if (isCheck) {
  runCheck();
} else {
  if (coverageErrors.length) fail(coverageErrors);
  for (const [path, data] of outputs) writeFileSync(path, data);
  printStats();
  console.log(`Записано файлов: ${outputs.size}`);
}

// ---------------------------------------------------------------------------------------------------------------

// Значения ключей одной схемы и режима: сопоставленные + (в тёмном) штатные ночные
function buildPaletteFile(name, mode, entry) {
  const dark = mode === 'dark';
  const c = buildContext(entry, dark);
  const written = new Map();
  const lines = [
    `// Parvane «Пространство»: схема ${name}, ${dark ? 'тёмный' : 'светлый'} режим.`,
    '// Создано desktop/theme/gen_palettes.mjs из web/telegram-tt/src/util/colorScheme.ts — руками не править.',
    '// Ключей без записи здесь нет: они берут значение исходного ключа либо штатное значение tdesktop.',
    '',
  ];
  const counts = { mapped: 0, stockNight: 0 };

  for (const { group, keys } of MAP) {
    lines.push(`// ${group}`);
    for (const [key, fn] of Object.entries(keys)) {
      const value = normalizeHex(fn(c));
      written.set(key, value);
      lines.push(`${key}: ${value};`);
      counts.mapped++;
    }
    lines.push('');
  }

  if (dark) {
    // Повторяем расчёт tdesktop по порядку объявлений: что получит ключ без записи, и пишем ночное значение,
    // только если оно другое
    const status = new Map();
    const value = new Map();
    const nightLines = [];
    for (const item of palette.list) {
      if (written.has(item.name)) {
        status.set(item.name, 'loaded');
        value.set(item.name, written.get(item.name));
        continue;
      }
      let computed;
      let computedStatus;
      if (item.fallback && status.get(item.fallback) === 'loaded') {
        computed = value.get(item.fallback);
        computedStatus = 'loaded';
      } else {
        computed = item.hex;
        computedStatus = 'created';
      }
      const wanted = followsMapped(item.name) ? computed : resolveNight(item.name);
      if (wanted !== computed) {
        nightLines.push(`${item.name}: ${wanted};`);
        counts.stockNight++;
        status.set(item.name, 'loaded');
        value.set(item.name, wanted);
      } else {
        status.set(item.name, computedStatus);
        value.set(item.name, computed);
      }
    }
    lines.push('// Штатные значения ночной темы tdesktop (night.tdesktop-theme): без записи ключ взял бы дневное');
    lines.push(...nightLines);
    lines.push('');
  }
  return { text: lines.join('\n'), counts };
}

function buildContext(entry, dark) {
  const p = entry.palette;
  const m = Object.fromEntries(Object.entries(entry.colors).map(([key, val]) => [key, val]));
  const t = {
    accent: entry.tokens['--pv-accent'],
    green: entry.tokens['--pv-green'],
    red: entry.tokens['--pv-red'],
    purple: entry.tokens['--pv-purple'],
  };
  return {
    p,
    t,
    m,
    dark,
    shade: normalizeHex(m['--color-primary-shade']),
    accentOver: mix(p.accent, BLACK, 0.07),
    accentTint: normalizeHex(m['--color-message-reaction']),
    ripple: mix(p.hover, p.text, 0.1),
    mutedOver: mix(p.muted, p.text, 0.15),
    shadowBase: dark ? BLACK : p.text,
  };
}

// 13 тонов палитры схемы: в colorScheme.ts `PALETTES` не экспортируется, но каждый тон выходит наружу ровно одной
// переменной — восстанавливаем из них
function recoverPalette(colors, tokensOfMode) {
  const pick = (value) => normalizeHex(value);
  return {
    bg: pick(tokensOfMode['--pv-bg']),
    panel: pick(tokensOfMode['--pv-panel']),
    raised: pick(tokensOfMode['--pv-raised']),
    hover: pick(tokensOfMode['--pv-hover']),
    line: pick(tokensOfMode['--pv-line']),
    lineStrong: pick(tokensOfMode['--pv-line2']),
    text: pick(tokensOfMode['--pv-fg']),
    muted: pick(tokensOfMode['--pv-muted']),
    faint: pick(tokensOfMode['--pv-faint']),
    accent: pick(colors['--color-primary']),
    link: pick(colors['--color-links']),
    own: pick(colors['--color-background-own']),
    ownAccent: pick(colors['--color-accent-own']),
  };
}

function parsePalette(text) {
  const list = [];
  const byName = new Map();
  const re = /^([A-Za-z0-9_]+):\s*([^;]+);/;
  for (const line of text.split('\n')) {
    const match = line.match(re);
    if (!match) continue;
    const [, name, raw] = match;
    const parts = raw.split('|').map((part) => part.trim());
    const item = { name };
    if (parts[0].startsWith('#')) {
      item.hex = normalizeHex(parts[0]);
      item.kind = parts[1] ? 'hexFallback' : 'hex';
      item.fallback = parts[1];
    } else {
      item.kind = 'copy';
      item.fallback = parts[0];
    }
    list.push(item);
    byName.set(name, item);
  }
  // Значение копии по умолчанию — значение исходного ключа (так считает codegen)
  for (const item of list) {
    if (item.kind === 'copy') item.hex = byName.get(item.fallback).hex;
  }
  return { list, byName };
}

function parseThemeValues(text) {
  const values = new Map();
  const stripped = text.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
  for (const match of stripped.matchAll(/([A-Za-z0-9_]+)\s*:\s*([#A-Za-z0-9_]+)\s*;/g)) {
    values.set(match[1], match[2].startsWith('#') ? normalizeHex(match[2]) : match[2]);
  }
  return values;
}

// Значение ключа в ночной теме tdesktop так, как его посчитает загрузчик
function resolveNight(name, depth = 0) {
  if (depth > 20) throw new Error(`Цикл ссылок в ночной теме: ${name}`);
  const own = night.get(name);
  if (own) return own.startsWith('#') ? own : resolveNight(own, depth + 1);
  const item = palette.byName.get(name);
  return item.fallback ? resolveNight(item.fallback, depth + 1) : item.hex;
}

// Ключ без своей записи следует за сопоставленным ключом (через цепочку копий / запасных ключей)
function followsMapped(name) {
  const item = palette.byName.get(name);
  if (!item.fallback) return false;
  if (mapping.has(item.fallback)) return true;
  return followsMapped(item.fallback);
}

function buildMappingIndex() {
  const index = new Map();
  for (const { keys } of MAP) {
    for (const key of Object.keys(keys)) {
      if (index.has(key)) throw new Error(`Ключ дважды в таблице: ${key}`);
      index.set(key, true);
    }
  }
  return index;
}

// Каждый ключ со своим hex решён: сопоставлен, штатный или следует за другим ключом
function checkCoverage() {
  const errors = [];
  const stock = new Set();
  for (const { keys } of STOCK) {
    for (const key of keys) {
      if (stock.has(key)) errors.push(`Штатный ключ дважды: ${key}`);
      stock.add(key);
    }
  }
  for (const key of [...mapping.keys(), ...stock]) {
    if (!palette.byName.has(key)) errors.push(`Ключа нет в colors.palette: ${key}`);
    if (mapping.has(key) && stock.has(key)) errors.push(`Ключ и сопоставлен, и штатный: ${key}`);
  }
  for (const item of palette.list) {
    if (item.kind === 'hex' && !mapping.has(item.name) && !stock.has(item.name)) {
      errors.push(`Не решён ключ со своим цветом: ${item.name}`);
    }
  }
  return errors;
}

function classifyAll() {
  const stock = new Set(STOCK.flatMap(({ keys }) => keys));
  const result = { mapped: 0, stock: 0, follow: 0, stockFallback: 0, copyFollow: 0, copyStock: 0 };
  for (const item of palette.list) {
    if (mapping.has(item.name)) result.mapped++;
    else if (item.kind === 'hex') result.stock += stock.has(item.name) ? 1 : 0;
    else if (item.kind === 'hexFallback') result[followsMapped(item.name) ? 'follow' : 'stockFallback']++;
    else result[followsMapped(item.name) ? 'copyFollow' : 'copyStock']++;
  }
  return result;
}

function printStats() {
  const all = classifyAll();
  console.log(`colors.palette: ${palette.list.length} ключей; сопоставлено ${all.mapped}, штатных со своим hex `
    + `${all.stock}, «#hex | ключ» следуют за сопоставленным ${all.follow} / штатные ${all.stockFallback}, `
    + `копии следуют за сопоставленным ${all.copyFollow} / за штатным ${all.copyStock}`);
  for (const [file, counts] of Object.entries(stats)) {
    console.log(`  ${file}: записано ${counts.mapped + counts.stockNight} (по схеме ${counts.mapped}, `
      + `ночных штатных ${counts.stockNight})`);
  }
}

function runCheck() {
  const errors = [...coverageErrors];
  for (const [path, data] of outputs) {
    const rel = relative(ROOT, path);
    if (!existsSync(path)) {
      errors.push(`Нет файла: ${rel} (запустите генератор)`);
      continue;
    }
    // Формат и ключи проверяются у файла на диске — именно его прочитает tdesktop
    const onDisk = readFileSync(path);
    if (path.endsWith('.tdesktop-palette')) errors.push(...checkPaletteText(rel, onDisk.toString('utf8')));
    if (path.endsWith('.tdesktop-theme')) {
      errors.push(...checkPaletteText(`${rel}:colors`,
        readZipEntry(onDisk, 'colors.tdesktop-theme').toString('utf8')));
    }
    if (!onDisk.equals(data)) errors.push(`Файл устарел: ${rel} (перегенерируйте)`);
  }
  if (errors.length) fail(errors);
  printStats();
  console.log(`Проверка пройдена: ${outputs.size} файлов актуальны, ключи и формат цветов верны`);
}

function checkPaletteText(rel, text) {
  const errors = [];
  const seen = new Set();
  const body = text.replace(/\/\/[^\n]*/g, '');
  for (const raw of body.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    const match = line.match(/^([A-Za-z0-9_]+): (#[0-9a-f]+);$/);
    if (!match) {
      errors.push(`${rel}: строка не вида «key: #rrggbb;»: ${line}`);
      continue;
    }
    const [, key, value] = match;
    if (!palette.byName.has(key)) errors.push(`${rel}: ключа нет в colors.palette: ${key}`);
    if (!COLOR_RE.test(value)) errors.push(`${rel}: неверный цвет ${key}: ${value}`);
    if (seen.has(key)) errors.push(`${rel}: ключ дважды: ${key}`);
    seen.add(key);
  }
  return errors;
}

function fail(errors) {
  console.error(errors.join('\n'));
  process.exit(1);
}

// --- Архив темы: colors.tdesktop-theme + background.png 1×1 (плоский фон чата цвета bg) -------------------------

function buildThemeZip(colorsText, bg) {
  return writeZip([
    { name: 'colors.tdesktop-theme', data: Buffer.from(colorsText, 'utf8') },
    { name: 'background.png', data: buildSolidPng(bg) },
  ]);
}

function buildSolidPng(hex) {
  const rgb = normalizeHex(hex);
  const pixel = Buffer.from([0, parseInt(rgb.slice(1, 3), 16), parseInt(rgb.slice(3, 5), 16),
    parseInt(rgb.slice(5, 7), 16)]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(1, 0);
  ihdr.writeUInt32BE(1, 4);
  ihdr[8] = 8; // Бит на канал
  ihdr[9] = 2; // RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(pixel)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

function pngChunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])) >>> 0);
  return Buffer.concat([head, data, crc]);
}

// Zip без сжатия (STORE), неизменные дата и время
function writeZip(files) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const { name, data } of files) {
    const nameBuf = Buffer.from(name, 'utf8');
    const crc = crc32(data) >>> 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(ZIP_DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(ZIP_DOS_DATE, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBuf, data);
    centrals.push(central, nameBuf);
    offset += local.length + nameBuf.length + data.length;
  }
  const centralBuf = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralBuf, end]);
}

// Чтение одного файла из zip по центральному каталогу (STORE или deflate)
function readZipEntry(zip, wanted) {
  const endAt = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (endAt < 0) throw new Error('Не zip');
  const count = zip.readUInt16LE(endAt + 10);
  let at = zip.readUInt32LE(endAt + 16);
  for (let i = 0; i < count; i++) {
    const method = zip.readUInt16LE(at + 10);
    const size = zip.readUInt32LE(at + 20);
    const nameLen = zip.readUInt16LE(at + 28);
    const extraLen = zip.readUInt16LE(at + 30);
    const commentLen = zip.readUInt16LE(at + 32);
    const localAt = zip.readUInt32LE(at + 42);
    const name = zip.subarray(at + 46, at + 46 + nameLen).toString('utf8');
    if (name.toLowerCase() === wanted) {
      const dataAt = localAt + 30 + zip.readUInt16LE(localAt + 26) + zip.readUInt16LE(localAt + 28);
      const raw = zip.subarray(dataAt, dataAt + size);
      return method === 0 ? Buffer.from(raw) : inflateRawSync(raw);
    }
    at += 46 + nameLen + extraLen + commentLen;
  }
  throw new Error(`В архиве нет ${wanted}`);
}
