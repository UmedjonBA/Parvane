import {
  memo, useEffect, useLayoutEffect, useMemo, useRef, useState,
} from '../../../lib/teact/teact';
import { getActions, getGlobal } from '../../../global';

import type { MusicTrack } from '../../../api/parvane/musicApi';
import type { GlobalState } from '../../../global/types';
import type { LangFn } from '../../../util/localization';
import type { ParvaneModuleId } from '../../../util/parvaneModules';
import type { ParvaneIconName } from '../../main/ParvaneIcon';
import type {
  PaletteFilter, PaletteGroup, PaletteItem, PaletteRange,
} from './paletteSearch';
import { LeftColumnContent } from '../../../types';

import { getPeerFullTitle } from '../../../global/helpers/peers';
import { selectLeftColumnContentKey, selectPeer } from '../../../global/selectors';
import { IS_MAC_OS } from '../../../util/browser/windowEnvironment';
import buildClassName from '../../../util/buildClassName';
import captureKeyboardListeners from '../../../util/captureKeyboardListeners';
import {
  getParvaneSection, openFiles, openHealth, openNote, openNotes, openPlannerView, requestHealthAdd,
  requestPlannerAdd, setParvaneSection,
} from '../../../util/parvaneSection';
import { formatFileSize } from '../../../util/textFormat';
import { getActiveModule, MODULE_TITLE_KEYS } from '../../main/parvaneModuleNav';
import { requestCloudOpen } from '../cloud/cloudOpenRequest';
import { getCloudData, getCloudStatus, loadCloud } from '../cloud/cloudStore';
import { formatTrackTime } from '../music/musicFormat';
import { getMusicInfo, playTracks } from '../music/musicPlayer';
import { requestMusicAdd, setMusicQuery } from '../music/musicView';
import { formatNoteEdited } from '../notes/notesList';
import { folderColor } from '../notes/notesLook';
import {
  getNotes, getNotesStatus, loadNotes, retainNotes,
} from '../notes/notesStore';
import { formatDayShort, formatKind, formatWeekdayShort } from '../planner/plannerFormat';
import { toDayKey } from '../planner/plannerModel';
import { openPlannerSettingsPage } from '../planner/plannerSettingsOpen';
import {
  getIsPlannerLoaded, getPlannerState, getPlannerStatus, loadPlanner,
} from '../planner/plannerStore';
import { collectCloudFiles } from './paletteFiles';
import {
  closePalette, getIsPaletteOpen, getPaletteFilter, openRecordInPlan, setPaletteFilter,
} from './paletteOpen';
import { collectPlannerRecords } from './paletteRecords';
import {
  filterPaletteItems, getFilterModule, getModuleFilter, listPaletteFilters, movePaletteIndex, searchPalette,
  splitByRanges, withNormalized,
} from './paletteSearch';
import usePaletteMusic from './usePaletteMusic';

import useSelector from '../../../hooks/data/useSelector';
import useAppLayout from '../../../hooks/useAppLayout';
import useDerivedState from '../../../hooks/useDerivedState';
import useLang from '../../../hooks/useLang';
import useLastCallback from '../../../hooks/useLastCallback';
import useParvaneModules from '../../../hooks/useParvaneModules';

import ParvaneIcon from '../../main/ParvaneIcon';
import Modal from '../../ui/Modal';
import PvIcon from '../notes/PvIcon';

import kit from '../notes/PvKit.module.scss';
import styles from './ParvanePalette.module.scss';

// Строка палитры: что показать и что сделать по Enter
type PaletteEntry = PaletteItem & {
  icon: ParvaneIconName;
  // Цвет значка — переменная `--pv-*`
  tone: string;
  // Вторая строка: «Сеть · изменена сегодня», «Мой диск / Сервер · 412 Б», «Задача · вт, 14:00»
  sub?: string;
  // Подпись справа («Музыка» у команды «Найти и скачать») и сочетание клавиш строки
  meta?: string;
  kbd?: string;
  run: NoneToVoidFunction;
};

const INPUT_ID = 'parvane-palette-search';
const FOCUS_DELAY_MS = 100;
// Задержка поиска после последнего нажатия: ввод не ждёт перебора заметок и записей
const SEARCH_DELAY_MS = 120;
// Ближе этого числа дней запись «Плана» подписана днём недели («вт, 14:00»), дальше — датой
const WEEKDAY_RANGE_DAYS = 6;
const MS_IN_DAY = 86400000;
const ACCENT = 'var(--pv-accent)';
const MOD_KEY = IS_MAC_OS ? '⌘' : 'Ctrl';
const KBD_ENTER = 'Enter';
const KBD_ESC = 'Esc';
const KBD_TAB = 'Tab';
const KBD_ARROWS = '↑↓';
const KBD_NEW_NOTE = `${MOD_KEY}+Enter`;
const RECORD_LOOK = {
  event: { icon: 'calendar', tone: 'var(--pv-event)' },
  task: { icon: 'check', tone: 'var(--pv-task)' },
} as const;
// Подписи групп — названия модулей, как в ленте и боковой панели (доска: «Заметки», «Файлы», «Чаты», «План»)
const GROUP_KEYS = {
  note: MODULE_TITLE_KEYS.notes,
  file: MODULE_TITLE_KEYS.files,
  chat: MODULE_TITLE_KEYS.chats,
  record: MODULE_TITLE_KEYS.plan,
  music: MODULE_TITLE_KEYS.music,
  command: 'ParvanePaletteCommands',
} as const satisfies Record<PaletteGroup, string>;

function selectCurrentUserId(global: GlobalState) {
  return global.currentUserId;
}

// Чаты и контакты, известные устройству: названия уже в памяти, запросов к серверу нет
function collectChats(global: GlobalState, lang: LangFn, onOpen: (chatId: string) => void): PaletteEntry[] {
  const { active = [], archived = [] } = global.chats.listIds;
  // «Избранное» есть всегда, даже пока в нём пусто и в списке чатов его нет
  const ids = new Set([...active, ...archived, ...(global.contactList?.userIds || [])]);
  if (global.currentUserId) ids.add(global.currentUserId);
  const entries: PaletteEntry[] = [];
  ids.forEach((id) => {
    const peer = selectPeer(global, id);
    const title = id === global.currentUserId ? lang('SavedMessages') : peer && getPeerFullTitle(lang, peer);
    if (!title) return;
    entries.push(withNormalized({
      key: `chat:${id}`,
      group: 'chat',
      module: 'chats',
      title,
      icon: 'chat',
      tone: 'var(--pv-blue)',
      run: () => onOpen(id),
    }));
  });
  return entries;
}

// «Задача · вт, 14:00»: ближние дни — днём недели, дальние — датой
function formatRecordSub(lang: LangFn, kind: 'task' | 'event', today: string, day?: string, start?: string) {
  if (!day) return `${formatKind(lang, kind)} · ${lang('PlannerUndatedShort')}`;
  const distance = Math.abs(Date.parse(`${day}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / MS_IN_DAY;
  const date = distance <= WEEKDAY_RANGE_DAYS ? formatWeekdayShort(lang, day) : formatDayShort(lang, day);
  return `${formatKind(lang, kind)} · ${start ? `${date}, ${start}` : date}`;
}

function lowerFirst(text: string) {
  return text.charAt(0).toLowerCase() + text.slice(1);
}

function renderMarked(text: string, ranges: PaletteRange[]) {
  if (!ranges.length) return text;
  return splitByRanges(text, ranges).map((part, i) => (
    part.isMatch ? <span key={i} className={styles.mark}>{part.text}</span> : part.text
  ));
}

// Модуль, открытый под палитрой: Tab сужает выдачу до него
function readActiveModule(): ParvaneModuleId {
  const isSettingsOpen = selectLeftColumnContentKey(getGlobal()) === LeftColumnContent.Settings;
  return getActiveModule(getParvaneSection(), isSettingsOpen);
}

// Parvane: общий поиск (доски `XpStart`, `DeskOverlays`) — заметки, файлы, чаты, записи «Плана», треки «Музыки»
// и команды. Смонтирован всегда: сочетание клавиш слушает обёртка. Компьютер — окно сверху по центру с подвалом
// клавиш и Tab «только в этом модуле»; телефон — экран во весь рост: «Назад», поле, «Очистить», чипы модулей
const ParvanePalette = () => {
  const {
    openChat, openLeftColumnContent, setGlobalSearchQuery,
  } = getActions();

  const lang = useLang();
  const { isMobile } = useAppLayout();
  const isOpen = useDerivedState(getIsPaletteOpen);
  const rawFilter = useDerivedState(getPaletteFilter);
  const notes = useDerivedState(getNotes);
  const notesStatus = useDerivedState(getNotesStatus);
  const cloudStatus = useDerivedState(getCloudStatus);
  // Состояние плана и дерево «Файлов» нужны только открытой палитре: закрытая на их изменения не перерисовывается
  const planner = useDerivedState(
    () => (getIsPaletteOpen() ? getPlannerState() : undefined),
    // Сигналы — зависимости: по ним производное пересчитывается
    // eslint-disable-next-line react-hooks-static-deps/exhaustive-deps
    [getIsPaletteOpen, getPlannerState],
  );
  const cloud = useDerivedState(
    () => (getIsPaletteOpen() ? getCloudData() : undefined),
    // eslint-disable-next-line react-hooks-static-deps/exhaustive-deps
    [getIsPaletteOpen, getCloudData],
  );
  const isPlannerLoaded = useDerivedState(getIsPlannerLoaded);
  const plannerStatus = useDerivedState(getPlannerStatus);
  const musicInfo = useDerivedState(getMusicInfo);
  const currentUserId = useSelector(selectCurrentUserId);

  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState(0);
  const inputRef = useRef<HTMLInputElement>();
  const listRef = useRef<HTMLDivElement>();

  const { enabled: enabledModules } = useParvaneModules();
  const filters = useMemo(() => listPaletteFilters(enabledModules), [enabledModules]);
  // Чип выключенного модуля не показывается — выдача тогда по всему
  const filter: PaletteFilter = filters.includes(rawFilter) ? rawFilter : 'all';
  const isNotesOn = enabledModules.includes('notes');
  const isPlanOn = enabledModules.includes('plan');
  const isFilesOn = enabledModules.includes('files');
  const isMusicOn = enabledModules.includes('music');

  // Заметки, «План» и «Файлы» читаются при открытии своих разделов. Палитра догружает их при первом открытии
  // и ввод не задерживает: найденное появляется в списке само. Хранилище заметок без названия папки
  // и языка справки ничего не создаёт — это остаётся разделу «Заметки»
  useEffect(() => {
    if (!isOpen) return undefined;
    // Запрос здесь не трогаем (он стёрт при закрытии): эффект приходит позже первых нажатий клавиш
    // и стёр бы уже набранное
    // Пока палитра открыта, хранилище заметок следит за облаком; закрытая палитра его не держит
    const releaseNotes = retainNotes();
    void loadNotes(currentUserId);
    void loadPlanner(currentUserId);
    if (isFilesOn) loadCloud(currentUserId);
    // Поле появляется вместе с окном: фокус — после его показа
    const timeout = window.setTimeout(() => inputRef.current?.focus(), FOCUS_DELAY_MS);
    return () => {
      releaseNotes();
      window.clearTimeout(timeout);
      // Запрос стирается при закрытии: следующее открытие не показывает прежний текст даже на первом кадре
      setQuery('');
      setSelected(0);
    };
  }, [isOpen, currentUserId, isFilesOn]);

  const handleOpenChat = useLastCallback((chatId: string) => {
    setParvaneSection('messenger');
    openChat({ id: chatId, shouldReplaceHistory: true });
  });

  // «Искать в сообщениях»: прежний поиск по чатам и сообщениям Telegram с этим запросом
  const handleSearchMessages = useLastCallback((text: string) => {
    setParvaneSection('messenger');
    openLeftColumnContent({ contentKey: LeftColumnContent.GlobalSearch });
    setGlobalSearchQuery({ query: text });
  });

  const commands = useMemo((): PaletteEntry[] => {
    // Команда выключенного модуля в поиске не показывается (экран «Модули»)
    const command = (
      module: ParvaneModuleId, key: string, title: string, icon: ParvaneIconName, run: NoneToVoidFunction,
    ): PaletteEntry | undefined => (!enabledModules.includes(module) ? undefined : withNormalized({
      key, group: 'command', module, title, icon, tone: ACCENT, run,
    }));
    return [
      command('chats', 'nav:chats', lang('ParvaneSectionMessenger'), 'chat', () => {
        setParvaneSection('messenger');
        openLeftColumnContent({ contentKey: LeftColumnContent.ChatList });
      }),
      command('plan', 'nav:today', lang('PlannerToday'), 'sun', () => openPlannerView('today')),
      command('plan', 'nav:calendar', lang('PlannerViewCalendar'), 'calendar', () => openPlannerView('calendar')),
      command('notes', 'nav:knowledge', lang('ParvaneModuleNotes'), 'note', () => openNotes()),
      command('health', 'nav:health', lang('PlannerHealth'), 'heart', () => openHealth()),
      command('files', 'nav:cloud', lang('ParvaneModuleFiles'), 'folder', () => openFiles()),
      command('plan', 'quick', lang('PlannerQuickTitle'), 'plus', () => requestPlannerAdd()),
      command('health', 'quick:sleep', lang('ParvanePaletteLogSleep'), 'plus', () => (
        requestHealthAdd(`${lang('ParvanePaletteSleepText')} `)
      )),
      command('health', 'quick:food', lang('ParvanePaletteLogFood'), 'plus', () => (
        requestHealthAdd(`${lang('ParvanePaletteFoodText')} `)
      )),
      // Заметка с таким названием уже есть — откроется она, иначе раздел создаст новую
      command('notes', 'newnote', lang('KnowledgeNewNote'), 'note', () => openNote(lang('KnowledgeNewNote'))),
      command('plan', 'settings', lang('PlannerSettings'), 'sliders', () => openPlannerSettingsPage()),
    ].filter(Boolean);
  }, [lang, enabledModules]);

  // Список чатов берётся на момент открытия: пока палитра открыта, он почти не меняется
  const chats = useMemo(
    () => (isOpen ? collectChats(getGlobal(), lang, handleOpenChat) : []),
    [isOpen, lang, handleOpenChat],
  );

  // Строки для сравнения приводятся здесь, один раз на список (E2): раньше `matchItem` нормализовал полный
  // текст каждой заметки на каждое нажатие клавиши
  const noteEntries = useMemo((): PaletteEntry[] => {
    if (!isOpen || !isNotesOn) return [];
    const now = Date.now();
    return notes.map((note) => {
      const folder = note.folder.split('/')[0];
      const edited = note.updatedAt
        ? lang('ParvanePaletteEdited', { when: lowerFirst(formatNoteEdited(lang, note.updatedAt, now)) })
        : undefined;
      return withNormalized({
        key: `note:${note.id}`,
        group: 'note',
        module: 'notes',
        title: note.title,
        text: note.text,
        icon: 'note',
        tone: folderColor(note.folder, note.isDaily),
        sub: edited ? `${folder} · ${edited}` : folder,
        run: () => openNote(note.title),
      });
    });
  }, [isOpen, isNotesOn, notes, lang]);

  const fileEntries = useMemo((): PaletteEntry[] => {
    if (!isOpen || !isFilesOn) return [];
    return collectCloudFiles(cloud, lang('ParvaneCloudTabDrive')).map((file) => withNormalized({
      ...file,
      icon: file.isFolder ? 'folder' : 'note',
      tone: 'var(--pv-muted)',
      sub: file.isFolder ? file.place : `${file.place} · ${formatFileSize(lang, file.size)}`,
      run: () => requestCloudOpen({ container: file.container, node: file.node }),
    }));
  }, [isOpen, isFilesOn, cloud, lang]);

  const recordEntries = useMemo((): PaletteEntry[] => {
    if (!isOpen || !isPlanOn || !isPlannerLoaded || !planner) return [];
    const today = toDayKey(new Date());
    return collectPlannerRecords(planner, today).map((record) => withNormalized({
      ...record,
      ...RECORD_LOOK[record.kind],
      sub: formatRecordSub(lang, record.kind, today, record.day, record.start),
      run: () => openRecordInPlan({ kind: record.kind, id: record.id, day: record.day }),
    }));
  }, [isOpen, isPlanOn, isPlannerLoaded, planner, lang]);

  // Поиск идёт с задержкой после последнего нажатия (E2): ввод не ждёт перебора списка. Пока задержка не
  // вышла, показан прежний результат; Enter в это время ищет по набранному сам (`runAt`)
  const [searchQuery, setSearchQuery] = useState('');
  useEffect(() => {
    if (query === searchQuery) return undefined;
    const timeout = window.setTimeout(() => setSearchQuery(query), SEARCH_DELAY_MS);
    return () => window.clearTimeout(timeout);
  }, [query, searchQuery]);

  const { tracks, isMusicReady } = usePaletteMusic(isOpen ? searchQuery : '', isMusicOn);

  const handleNewNote = useLastCallback((title: string) => openNote(title));
  const handleFetchTrack = useLastCallback((text: string) => {
    setMusicQuery(text);
    requestMusicAdd('fetch');
  });
  const handlePlayTrack = useLastCallback((track: MusicTrack) => {
    playTracks([track], 0, { source: { kind: 'search' } });
  });

  // Треки уже подобраны сервером: показываются как есть, без сверки названия с запросом
  const musicEntries = useMemo((): PaletteEntry[] => tracks.map((track) => ({
    key: `music:${track.id}`,
    group: 'music',
    module: 'music',
    title: track.title,
    isAlways: true,
    icon: 'music',
    tone: 'var(--pv-accent)',
    sub: `${track.artist} · ${formatTrackTime(track.durationSecs)}`,
    run: () => handlePlayTrack(track),
  })), [tracks, handlePlayTrack]);

  // Строки с запросом (доска `DeskOverlays`): «Новая заметка «…»» (Ctrl+Enter), «Найти и скачать трек «…»»,
  // «Искать «…» в чатах и сообщениях» — при любом непустом запросе, в конце команд
  const queryEntries = useMemo((): PaletteEntry[] => {
    const text = searchQuery.trim();
    if (!isOpen || !text) return [];
    const entries: PaletteEntry[] = [{
      key: 'chat-search',
      group: 'command',
      module: 'chats',
      title: lang('ParvanePaletteSearchMessages', { query: text }),
      isAlways: true,
      icon: 'search',
      tone: 'var(--pv-muted)',
      run: () => handleSearchMessages(text),
    }];
    if (isNotesOn) {
      entries.push({
        key: 'newnote:query',
        group: 'command',
        module: 'notes',
        title: lang('ParvanePaletteNewNoteNamed', { title: text }),
        isAlways: true,
        icon: 'plus',
        tone: 'var(--pv-muted)',
        kbd: KBD_NEW_NOTE,
        run: () => handleNewNote(text),
      });
    }
    if (isMusicOn && isMusicReady && musicInfo?.isFetchEnabled) {
      entries.push({
        key: 'fetch:query',
        group: 'command',
        module: 'music',
        title: lang('ParvanePaletteFetchTrack', { title: text }),
        isAlways: true,
        icon: 'music',
        tone: 'var(--pv-muted)',
        meta: lang(MODULE_TITLE_KEYS.music),
        run: () => handleFetchTrack(text),
      });
    }
    return entries;
  }, [isOpen, searchQuery, lang, isNotesOn, isMusicOn, isMusicReady, musicInfo, handleSearchMessages,
    handleNewNote, handleFetchTrack]);

  const items = useMemo(() => filterPaletteItems([
    ...noteEntries, ...fileEntries, ...chats, ...recordEntries, ...musicEntries, ...commands, ...queryEntries,
  ], filter), [noteEntries, fileEntries, chats, recordEntries, musicEntries, commands, queryEntries, filter]);

  const sections = useMemo(() => searchPalette(items, searchQuery), [items, searchQuery]);
  const flat = useMemo(() => sections.flatMap(({ results }) => results), [sections]);
  const selectedIndex = Math.min(selected, Math.max(0, flat.length - 1));
  const selectedKey = flat[selectedIndex]?.item.key;
  // Найдено что-то, кроме строк с запросом («Новая заметка «…»», «Искать в сообщениях»)
  const hasFound = flat.some(({ item }) => !item.isAlways || item.group === 'music');

  // Идёт первое чтение: заметок (облако ещё отвечает либо тексты читаются) или «Плана»
  const isNotesLoading = notesStatus === 'loading' && (cloudStatus === 'loading' || cloudStatus === 'ready');
  const isLoading = isOpen && (
    (isNotesOn && (filter === 'all' || filter === 'notes') && isNotesLoading)
    || (isPlanOn && (filter === 'all' || filter === 'plan') && !isPlannerLoaded && plannerStatus === 'loading')
  );

  useEffect(() => {
    if (!isOpen || !selectedKey) return;
    listRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [isOpen, selectedKey]);

  const runAt = useLastCallback((index: number) => {
    // Enter приходит дважды — клавишей окна и отправкой формы: второй раз палитра уже закрыта
    if (!getIsPaletteOpen()) return;
    // Набранное ещё не искалось — результат по нему считается сейчас, иначе выбор пошёл бы по прежнему списку.
    // Набранное берётся из поля: клавиша может прийти раньше кадра, в котором обновится `query`
    const typed = inputRef.current!.value;
    const list = typed !== searchQuery
      ? searchPalette(items, typed).flatMap(({ results }) => results)
      : flat;
    const entry = list[Math.min(index, Math.max(0, list.length - 1))]?.item;
    if (!entry) return;
    closePalette();
    entry.run();
  });

  const handleEnter = useLastCallback(() => {
    runAt(selectedIndex);
  });

  const handleSubmit = useLastCallback((e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    runAt(selectedIndex);
  });

  const handleChange = useLastCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    setQuery(e.currentTarget.value);
    setSelected(0);
  });

  const handleClear = useLastCallback(() => {
    setQuery('');
    setSelected(0);
    inputRef.current?.focus();
  });

  const handleFilterClick = useLastCallback((e: React.MouseEvent<HTMLButtonElement>) => {
    setPaletteFilter(e.currentTarget.dataset.paletteFilter as PaletteFilter);
    setSelected(0);
    inputRef.current?.focus();
  });

  // Стрелки — общим перехватчиком клавиш: иначе их забирают слушатели под окном (список чатов)
  const moveSelection = useLastCallback((e: KeyboardEvent, delta: number) => {
    e.preventDefault();
    // Удержанная стрелка шлёт нажатия чаще перерисовки — шаг считается от текущего значения, а не от показанного
    setSelected((current) => movePaletteIndex(Math.min(current, Math.max(0, flat.length - 1)), delta, flat.length));
  });

  // Ctrl+Enter — новая заметка с набранным названием, без выбора строки (доска `DeskOverlays`); обычный Enter
  // остаётся окну. Слушатель — на `window` при погружении: раньше перехвата клавиш окна, который Enter забирает
  const handleModEnter = useLastCallback((e: KeyboardEvent) => {
    if (e.key !== 'Enter' || !(e.ctrlKey || e.metaKey) || !isNotesOn) return;
    // Из поля, а не из `query`: клавиша может прийти раньше кадра с набранным
    const text = inputRef.current!.value.trim();
    if (!text) return;
    e.preventDefault();
    e.stopPropagation();
    closePalette();
    handleNewNote(text);
  });

  useLayoutEffect(() => {
    if (!isOpen) return undefined;
    window.addEventListener('keydown', handleModEnter, true);
    return () => window.removeEventListener('keydown', handleModEnter, true);
  }, [isOpen, handleModEnter]);

  // Tab — «только в этом модуле», повторный Tab — снова везде. В модуле без своих записей Tab ничего не сужает
  const handleTab = useLastCallback((e: KeyboardEvent) => {
    if (e.shiftKey || e.ctrlKey || e.altKey || e.metaKey) return false;
    e.preventDefault();
    const own = getModuleFilter(readActiveModule());
    setPaletteFilter(filter === 'all' && filters.includes(own) ? own : 'all');
    setSelected(0);
    return true;
  });

  useLayoutEffect(() => (isOpen ? captureKeyboardListeners({
    onUp: (e) => moveSelection(e, -1),
    onDown: (e) => moveSelection(e, 1),
    onTab: handleTab,
  }) : undefined), [isOpen, moveSelection, handleTab]);

  // Нажатие выполняет показанную строку: пока задержка поиска не вышла, список по набранному другой, и номер
  // строки в нём указал бы на чужую запись
  const handleRowClick = useLastCallback((e: React.MouseEvent<HTMLButtonElement>) => {
    const entry = flat.find(({ item }) => item.key === e.currentTarget.dataset.paletteItem)?.item;
    if (!entry || !getIsPaletteOpen()) return;
    closePalette();
    entry.run();
  });

  const filterModule = getFilterModule(filter);
  const placeholder = isMobile ? lang('ParvanePalettePlaceholderPhone')
    : filterModule ? lang('ParvanePaletteIn', { module: lang(MODULE_TITLE_KEYS[filterModule]) })
      : lang('ParvanePalettePlaceholder');

  let rowIndex = 0;

  return (
    <Modal
      isOpen={isOpen}
      className={buildClassName(kit.sheet, kit.sheetTight, styles.root, isMobile && styles.rootPhone)}
      header={isMobile ? undefined : <div className={kit.sheetGrab} />}
      onClose={closePalette}
      onEnter={handleEnter}
    >
      <div className={styles.dialog} role="region" aria-label={lang('ParvanePaletteTitle')} data-palette>
        <form
          className={buildClassName(styles.form, isMobile && styles.formPhone)}
          role="search"
          autoComplete="off"
          onSubmit={handleSubmit}
        >
          {isMobile && (
            <button
              type="button"
              className={kit.ib}
              aria-label={lang('ParvanePaletteBack')}
              data-palette-back
              onClick={closePalette}
            >
              <ParvaneIcon name="left" />
            </button>
          )}
          {!isMobile && <PvIcon name="search" isSmall className={styles.searchIcon} />}
          <input
            ref={inputRef}
            id={INPUT_ID}
            name="parvane-palette-search"
            className={styles.input}
            type="search"
            value={query}
            placeholder={placeholder}
            aria-label={placeholder}
            aria-controls="parvane-palette-list"
            autoComplete="off"
            autoCorrect="off"
            spellCheck={false}
            enterKeyHint="go"
            onChange={handleChange}
          />
          {isMobile ? (
            <button
              type="button"
              className={kit.ib}
              aria-label={lang('ParvanePaletteClear')}
              data-palette-clear
              onClick={handleClear}
            >
              <ParvaneIcon name="close" />
            </button>
          ) : (
            <kbd className={styles.kbd}>{KBD_ESC}</kbd>
          )}
        </form>
        {isMobile && filters.length > 2 && (
          <div className={styles.filters} role="group" aria-label={lang('ParvanePaletteFilters')} data-palette-filters>
            {filters.map((id) => (
              <button
                key={id}
                type="button"
                className={buildClassName(kit.chip, id === filter && kit.chipOn)}
                aria-pressed={id === filter}
                data-palette-filter={id}
                onClick={handleFilterClick}
              >
                {id === 'all' ? lang('ParvanePaletteAll') : lang(MODULE_TITLE_KEYS[id])}
              </button>
            ))}
          </div>
        )}
        <div
          ref={listRef}
          id="parvane-palette-list"
          className={styles.list}
          role="listbox"
          data-palette-list
          data-palette-scope={filter}
        >
          {/* Пустой запрос — не «ничего не найдено»; строки с запросом при этом остаются ниже */}
          {!hasFound && !isLoading && Boolean(searchQuery.trim()) && (
            <div className={buildClassName(kit.muted, styles.note)} data-palette-empty>{lang('NothingFound')}</div>
          )}
          {sections.map(({ group, results }) => (
            <div key={group} className={styles.group} role="group" data-palette-group={group}>
              <h3 className={styles.caption}>{lang(GROUP_KEYS[group])}</h3>
              {results.map(({ item, ranges, snippet }) => {
                const index = rowIndex++;
                const isSelected = index === selectedIndex;
                const sub = snippet ? renderMarked(snippet.text, snippet.ranges) : item.sub;
                const kbd = item.kbd || (isSelected && !isMobile ? KBD_ENTER : undefined);
                return (
                  <button
                    key={item.key}
                    type="button"
                    role="option"
                    aria-selected={isSelected}
                    className={buildClassName(styles.row, isSelected && styles.rowSel)}
                    data-palette-item={item.key}
                    data-index={index}
                    onClick={handleRowClick}
                  >
                    <span className={styles.icon} style={`--c: ${item.tone}`}>
                      <ParvaneIcon name={item.icon} isSmall />
                    </span>
                    <span className={styles.text}>
                      <span className={styles.title} dir="auto">{renderMarked(item.title, ranges)}</span>
                      {sub && <span className={styles.sub} dir="auto">{sub}</span>}
                    </span>
                    {item.meta && <span className={styles.meta}>{item.meta}</span>}
                    {kbd && <kbd className={styles.kbd}>{kbd}</kbd>}
                  </button>
                );
              })}
            </div>
          ))}
          {isLoading && (
            <div className={buildClassName(kit.muted, kit.small, styles.note)} role="status" data-palette-loading>
              {lang('ParvanePaletteLoading')}
            </div>
          )}
          {isMobile && <div className={styles.hint} data-palette-hint>{lang('ParvanePaletteHint')}</div>}
        </div>
        {!isMobile && (
          <div className={styles.footer} data-palette-footer>
            <span>
              <kbd className={styles.kbdBare}>{KBD_ARROWS}</kbd>
              {' '}
              {lang('ParvanePaletteFooterMove')}
            </span>
            <span>
              <kbd className={styles.kbdBare}>{KBD_ENTER}</kbd>
              {' '}
              {lang('ParvanePaletteFooterOpen')}
            </span>
            <span className={styles.footerGrow}>
              <kbd className={styles.kbdBare}>{KBD_TAB}</kbd>
              {' '}
              {lang(filter === 'all' ? 'ParvanePaletteFooterTab' : 'ParvanePaletteFooterTabAll')}
            </span>
            <span>{lang('ParvanePaletteFooterScope')}</span>
          </div>
        )}
      </div>
    </Modal>
  );
};

export default memo(ParvanePalette);
