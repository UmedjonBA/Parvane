import {
  memo, useEffect, useMemo, useRef, useState,
} from '../../../lib/teact/teact';
import { getActions, getGlobal } from '../../../global';

import type { GlobalState } from '../../../global/types';
import type { LangFn } from '../../../util/localization';
import type { ParvaneIconName } from '../../main/ParvaneIcon';
import type { PaletteGroup, PaletteItem, PaletteRange } from './paletteSearch';
import { LeftColumnContent } from '../../../types';

import { getPeerFullTitle } from '../../../global/helpers/peers';
import { selectPeer } from '../../../global/selectors';
import buildClassName from '../../../util/buildClassName';
import captureKeyboardListeners from '../../../util/captureKeyboardListeners';
import {
  openKnowledgeView, openNote, openPlannerView, requestPlannerAdd, requestPlannerAddText, requestPlannerSettings,
  setParvaneSection,
} from '../../../util/parvaneSection';
import { getCloudStatus } from '../cloud/cloudStore';
import { folderColor } from '../notes/notesLook';
import {
  getNotes, getNotesStatus, loadNotes, retainNotes,
} from '../notes/notesStore';
import { formatDayShort } from '../planner/plannerFormat';
import { toDayKey } from '../planner/plannerModel';
import {
  getIsPlannerLoaded, getPlannerState, getPlannerStatus, loadPlanner,
} from '../planner/plannerStore';
import {
  closePalette, getIsPaletteOpen, openRecordInPlan,
} from './paletteOpen';
import { collectPlannerRecords } from './paletteRecords';
import {
  movePaletteIndex, searchPalette, splitByRanges, withNormalized,
} from './paletteSearch';

import useSelector from '../../../hooks/data/useSelector';
import useDerivedState from '../../../hooks/useDerivedState';
import useLang from '../../../hooks/useLang';
import useLastCallback from '../../../hooks/useLastCallback';

import ParvaneIcon from '../../main/ParvaneIcon';
import Modal from '../../ui/Modal';
import PvIcon from '../notes/PvIcon';

import kit from '../notes/PvKit.module.scss';
import styles from './ParvanePalette.module.scss';

// Строка палитры: что показать и что сделать по Enter
type PaletteEntry = PaletteItem & {
  icon: ParvaneIconName;
  // Цвет плитки значка — переменная `--pv-*`
  tone: string;
  meta?: string;
  run: NoneToVoidFunction;
};

const INPUT_ID = 'parvane-palette-search';
const FOCUS_DELAY_MS = 100;
// Задержка поиска после последнего нажатия: ввод не ждёт перебора заметок и записей
const SEARCH_DELAY_MS = 120;
const ACCENT = 'var(--pv-accent)';
const RECORD_LOOK = {
  event: { icon: 'calendar', tone: 'var(--pv-event)' },
  task: { icon: 'check', tone: 'var(--pv-task)' },
  workout: { icon: 'heart', tone: 'var(--pv-workout)' },
} as const;
const GROUP_KEYS = {
  command: 'ParvanePaletteCommands',
  chat: 'ParvaneSectionMessenger',
  note: 'KnowledgeNotes',
  record: 'ParvanePaletteRecords',
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
      title,
      icon: 'chat',
      tone: 'var(--pv-muted)',
      run: () => onOpen(id),
    }));
  });
  return entries;
}

function renderMarked(text: string, ranges: PaletteRange[]) {
  if (!ranges.length) return text;
  return splitByRanges(text, ranges).map((part, i) => (
    part.isMatch ? <span key={i} className={styles.mark}>{part.text}</span> : part.text
  ));
}

// Parvane: общий поиск по Ctrl+K — заметки, записи «Плана», чаты и команды-переходы (прототип дизайна).
// Смонтирован всегда: сочетание клавиш слушает сам. Окно — шторка разделов (`PvKit`): сверху по центру
// на компьютере, лист снизу на телефоне
const ParvanePalette = () => {
  const { openChat, openLeftColumnContent } = getActions();

  const lang = useLang();
  const isOpen = useDerivedState(getIsPaletteOpen);
  const notes = useDerivedState(getNotes);
  const notesStatus = useDerivedState(getNotesStatus);
  const cloudStatus = useDerivedState(getCloudStatus);
  // Состояние плана нужно только открытой палитре: закрытая на его изменения не перерисовывается
  const planner = useDerivedState(
    () => (getIsPaletteOpen() ? getPlannerState() : undefined),
    // Сигналы — зависимости: по ним производное пересчитывается
    // eslint-disable-next-line react-hooks-static-deps/exhaustive-deps
    [getIsPaletteOpen, getPlannerState],
  );
  const isPlannerLoaded = useDerivedState(getIsPlannerLoaded);
  const plannerStatus = useDerivedState(getPlannerStatus);
  const currentUserId = useSelector(selectCurrentUserId);

  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState(0);
  const inputRef = useRef<HTMLInputElement>();
  const listRef = useRef<HTMLDivElement>();

  // Ctrl+K слушает обёртка `ParvanePalette.async` (B2): код палитры грузится при первом открытии

  // Заметки и «План» читаются при открытии своих разделов. Палитра догружает их при первом открытии
  // и ввод не задерживает: найденное появляется в списке само. Хранилище заметок без названия папки
  // и языка справки ничего не создаёт — это остаётся разделу «Знания»
  useEffect(() => {
    if (!isOpen) return undefined;
    // Запрос здесь не трогаем (он стёрт при закрытии): эффект приходит позже первых нажатий клавиш
    // и стёр бы уже набранное
    // Пока палитра открыта, хранилище заметок следит за облаком; закрытая палитра его не держит
    const releaseNotes = retainNotes();
    void loadNotes(currentUserId);
    void loadPlanner(currentUserId);
    // Поле появляется вместе с окном: фокус — после его показа
    const timeout = window.setTimeout(() => inputRef.current?.focus(), FOCUS_DELAY_MS);
    return () => {
      releaseNotes();
      window.clearTimeout(timeout);
      // Запрос стирается при закрытии: следующее открытие не показывает прежний текст даже на первом кадре
      setQuery('');
      setSelected(0);
    };
  }, [isOpen, currentUserId]);

  const handleOpenChat = useLastCallback((chatId: string) => {
    setParvaneSection('messenger');
    openChat({ id: chatId, shouldReplaceHistory: true });
  });

  const commands = useMemo((): PaletteEntry[] => {
    const command = (key: string, title: string, icon: ParvaneIconName, run: NoneToVoidFunction): PaletteEntry => (
      withNormalized({
        key, group: 'command', title, icon, tone: ACCENT, run,
      })
    );
    return [
      command('nav:chats', lang('ParvaneSectionMessenger'), 'chat', () => {
        setParvaneSection('messenger');
        openLeftColumnContent({ contentKey: LeftColumnContent.ChatList });
      }),
      command('nav:today', lang('PlannerToday'), 'sun', () => openPlannerView('today')),
      command('nav:calendar', lang('PlannerViewCalendar'), 'calendar', () => openPlannerView('calendar')),
      command('nav:knowledge', lang('ParvaneSectionKnowledge'), 'book', () => openKnowledgeView('notes')),
      command('nav:health', lang('PlannerHealth'), 'heart', () => openPlannerView('health')),
      command('nav:cloud', lang('ParvaneSectionCloud'), 'cloud', () => openKnowledgeView('files')),
      command('quick', lang('PlannerQuickTitle'), 'plus', () => requestPlannerAdd()),
      command('quick:sleep', lang('ParvanePaletteLogSleep'), 'plus', () => (
        requestPlannerAddText(`${lang('ParvanePaletteSleepText')} `)
      )),
      command('quick:food', lang('ParvanePaletteLogFood'), 'plus', () => (
        requestPlannerAddText(`${lang('ParvanePaletteFoodText')} `)
      )),
      // Заметка с таким названием уже есть — откроется она, иначе раздел создаст новую
      command('newnote', lang('KnowledgeNewNote'), 'note', () => openNote(lang('KnowledgeNewNote'))),
      command('settings', lang('PlannerSettings'), 'sliders', () => requestPlannerSettings()),
    ];
  }, [lang]);

  // Список чатов берётся на момент открытия: пока палитра открыта, он почти не меняется
  const chats = useMemo(
    () => (isOpen ? collectChats(getGlobal(), lang, handleOpenChat) : []),
    [isOpen, lang, handleOpenChat],
  );

  // Строки для сравнения приводятся здесь, один раз на список (E2): раньше `matchItem` нормализовал полный
  // текст каждой заметки на каждое нажатие клавиши
  const noteEntries = useMemo((): PaletteEntry[] => (!isOpen ? [] : notes.map((note) => withNormalized({
    key: `note:${note.id}`,
    group: 'note',
    title: note.title,
    text: note.text,
    icon: 'note',
    tone: folderColor(note.folder, note.isDaily),
    meta: note.folder.split('/')[0],
    run: () => openNote(note.title),
  }))), [isOpen, notes]);

  const recordEntries = useMemo((): PaletteEntry[] => {
    if (!isOpen || !isPlannerLoaded || !planner) return [];
    return collectPlannerRecords(planner, toDayKey(new Date())).map((record) => withNormalized({
      ...record,
      ...RECORD_LOOK[record.kind],
      meta: record.day ? formatDayShort(lang, record.day) : lang('PlannerUndatedShort'),
      run: () => openRecordInPlan({ kind: record.kind, id: record.id, day: record.day }),
    }));
  }, [isOpen, isPlannerLoaded, planner, lang]);

  const items = useMemo(
    () => [...commands, ...chats, ...noteEntries, ...recordEntries],
    [commands, chats, noteEntries, recordEntries],
  );

  // Поиск идёт с задержкой после последнего нажатия (E2): ввод не ждёт перебора списка. Пока задержка не
  // вышла, показан прежний результат; Enter в это время ищет по набранному сам (`runAt`)
  const [searchQuery, setSearchQuery] = useState('');
  const searchTimeoutRef = useRef<number>();
  useEffect(() => {
    if (query === searchQuery) return undefined;
    searchTimeoutRef.current = window.setTimeout(() => {
      searchTimeoutRef.current = undefined;
      setSearchQuery(query);
    }, SEARCH_DELAY_MS);
    return () => {
      window.clearTimeout(searchTimeoutRef.current);
      searchTimeoutRef.current = undefined;
    };
  }, [query, searchQuery]);

  const sections = useMemo(() => searchPalette(items, searchQuery), [items, searchQuery]);
  const flat = useMemo(() => sections.flatMap(({ results }) => results), [sections]);
  const selectedIndex = Math.min(selected, Math.max(0, flat.length - 1));
  const selectedKey = flat[selectedIndex]?.item.key;

  // Идёт первое чтение: заметок (облако ещё отвечает либо тексты читаются) или «Плана»
  const isNotesLoading = notesStatus === 'loading' && (cloudStatus === 'loading' || cloudStatus === 'ready');
  const isLoading = isOpen && (isNotesLoading || (!isPlannerLoaded && plannerStatus === 'loading'));

  useEffect(() => {
    if (!isOpen || !selectedKey) return;
    listRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [isOpen, selectedKey]);

  const runAt = useLastCallback((index: number) => {
    // Enter приходит дважды — клавишей окна и отправкой формы: второй раз палитра уже закрыта
    if (!getIsPaletteOpen()) return;
    // Набранное ещё не искалось — результат по нему считается сейчас, иначе выбор пошёл бы по прежнему списку
    const list = searchTimeoutRef.current !== undefined
      ? searchPalette(items, query).flatMap(({ results }) => results)
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

  // Стрелки — общим перехватчиком клавиш: иначе их забирают слушатели под окном (список чатов)
  const moveSelection = useLastCallback((e: KeyboardEvent, delta: number) => {
    e.preventDefault();
    // Удержанная стрелка шлёт нажатия чаще перерисовки — шаг считается от текущего значения, а не от показанного
    setSelected((current) => movePaletteIndex(Math.min(current, Math.max(0, flat.length - 1)), delta, flat.length));
  });

  useEffect(() => (isOpen ? captureKeyboardListeners({
    onUp: (e) => moveSelection(e, -1),
    onDown: (e) => moveSelection(e, 1),
  }) : undefined), [isOpen, moveSelection]);

  const handleRowClick = useLastCallback((e: React.MouseEvent<HTMLButtonElement>) => {
    runAt(Number(e.currentTarget.dataset.index));
  });

  let rowIndex = 0;

  return (
    <Modal
      isOpen={isOpen}
      className={buildClassName(kit.sheet, kit.sheetTight, styles.root)}
      header={<div className={kit.sheetGrab} />}
      onClose={closePalette}
      onEnter={handleEnter}
    >
      <form className={styles.form} role="search" autoComplete="off" onSubmit={handleSubmit}>
        <label className={kit.search}>
          <PvIcon name="search" isSmall className={kit.searchIcon} />
          <input
            ref={inputRef}
            id={INPUT_ID}
            name="parvane-palette-search"
            className={kit.searchInput}
            type="search"
            value={query}
            placeholder={lang('ParvanePalettePlaceholder')}
            aria-label={lang('Search')}
            aria-controls="parvane-palette-list"
            autoComplete="off"
            autoCorrect="off"
            spellCheck={false}
            enterKeyHint="go"
            onChange={handleChange}
          />
        </label>
      </form>
      <div ref={listRef} id="parvane-palette-list" className={styles.list} role="listbox" data-palette-list>
        {sections.map(({ group, results }) => (
          <div key={group} className={styles.group} role="group" data-palette-group={group}>
            <h3 className={kit.grp}>{lang(GROUP_KEYS[group])}</h3>
            {results.map(({ item, ranges, snippet }) => {
              const index = rowIndex++;
              const isSelected = index === selectedIndex;
              return (
                <button
                  key={item.key}
                  type="button"
                  role="option"
                  aria-selected={isSelected}
                  className={buildClassName(kit.row, isSelected && kit.rowSel)}
                  data-palette-item={item.key}
                  data-index={index}
                  onClick={handleRowClick}
                >
                  <span className={buildClassName(kit.ava, styles.ava)} style={`--c: ${item.tone}`}>
                    <ParvaneIcon name={item.icon} isSmall />
                  </span>
                  <span className={kit.rowText}>
                    <span className={kit.ttl} dir="auto">{renderMarked(item.title, ranges)}</span>
                    {snippet && (
                      <span className={kit.sub} dir="auto">{renderMarked(snippet.text, snippet.ranges)}</span>
                    )}
                  </span>
                  {item.meta && <span className={kit.meta}>{item.meta}</span>}
                </button>
              );
            })}
          </div>
        ))}
        {!flat.length && !isLoading && (
          <div className={buildClassName(kit.muted, styles.note)} data-palette-empty>{lang('NothingFound')}</div>
        )}
        {isLoading && (
          <div className={buildClassName(kit.muted, kit.small, styles.note)} role="status" data-palette-loading>
            {lang('ParvanePaletteLoading')}
          </div>
        )}
      </div>
    </Modal>
  );
};

export default memo(ParvanePalette);
