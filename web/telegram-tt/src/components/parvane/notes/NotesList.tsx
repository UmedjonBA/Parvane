import {
  memo, useLayoutEffect, useMemo, useRef, useState,
} from '../../../lib/teact/teact';

import type { NoteMenuAnchor } from './NoteMenu';
import type { NoteRowKeyAction } from './NoteRowMenu';
import type { NoteFolder, NoteGroup } from './notesFolders';
import type { NotesIndex } from './notesModel';
import type { PlannedIndex } from './notesPlanned';
import type { NoteEntry } from './notesStore';

import buildClassName from '../../../util/buildClassName';
import { getIsParvaneScreenShown } from '../../../util/parvaneSection';
import { fromDayKey } from '../planner/plannerModel';
import { buildNoteGroups, folderCaption, ROOT_FOLDER } from './notesFolders';
import {
  countNoteLinks, firstTagOf, formatNoteEdited, formatNoteTime, sortByRecent,
} from './notesList';
import {
  displayTitle, folderColor, formatDayShort, isDayTitle, previewOf,
} from './notesLook';
import { sortPinnedFirst } from './notesMeta';
import { nearestPlanned, plannedOf } from './notesPlanned';
import { getNotesMeta } from './notesStore';

import useDerivedState from '../../../hooks/useDerivedState';
import useFlag from '../../../hooks/useFlag';
import useLang from '../../../hooks/useLang';
import useLastCallback from '../../../hooks/useLastCallback';

import { NOTE_DRAG_TYPE } from './NotesColumn';
import NoteUnsentMark from './NoteUnsentMark';
import PvEmpty from './PvEmpty';
import PvIcon from './PvIcon';

import styles from './NotesList.module.scss';
import kit from './PvKit.module.scss';

// Столько недавних заметок видно в общем списке, пока не попросили все
const RECENT_SHOWN = 50;
// Названия папки заметок дня на обоих языках (как в `notesStore`)
const DAILY_FOLDERS = ['Ежедневные', 'Daily'];
const ROW_KEYS: Record<string, NoteRowKeyAction> = { F2: 'rename', Delete: 'delete' };

type Group = NoteGroup<NoteEntry>;

type OwnProps = {
  notes: NoteEntry[];
  folders: NoteFolder[];
  index: NotesIndex;
  plannedIndex: PlannedIndex;
  today: string;
  // Найденное поиском; без поиска — `undefined`
  found?: NoteEntry[];
  openId?: string;
  // Открытая папка (ключ группы); без неё — папки и недавние заметки
  openGroupKey?: string;
  vaultName: string;
  // Сообщение о появившейся справке и её папка
  guideNoticeFolder?: string;
  hasGuide: boolean;
  // Телефон: папки и недавние строками, кнопка «Новая папка» в шапке, строки не перетаскиваются
  isNarrow: boolean;
  // Компьютер (доска `ZdNotesX`): папки — в колонке слева, здесь — заметки выбранной папки (либо все) плоским
  // списком: `table` — таблицей во всю ширину «название · папка · #тег · дата», `column` — колонкой рядом с заметкой
  deskLayout?: 'table' | 'column';
  onPick: (noteId: string) => void;
  onOpenGroup: (key?: string) => void;
  onFolderMenu: (folderId: string) => void;
  onNewInFolder: (folderId?: string) => void;
  onMoveNote: (noteId: string, folderId?: string) => void;
  // Правая кнопка по строке заметки: меню у курсора (компьютер) либо шторка (телефон, долгое нажатие)
  onNoteMenu: (noteId: string, anchor?: NoteMenuAnchor) => void;
  // F2 / Del по выделенной либо наведённой строке (компьютер)
  onNoteKey: (noteId: string, action: NoteRowKeyAction) => void;
  onGuide: NoneToVoidFunction;
  onGuideDismiss: NoneToVoidFunction;
};

// Список заметок по макету (доски `Notes`, `PhNotesMore`, `DeskNotes`): папки строками со счётчиком и недавние
// заметки; открытая папка — её заметки; поиск — найденное одним списком
const NotesList = ({
  notes, folders, index, plannedIndex, today, found, openId, openGroupKey, vaultName, guideNoticeFolder, hasGuide,
  isNarrow, deskLayout = 'column', onPick, onOpenGroup, onFolderMenu, onNewInFolder, onMoveNote, onNoteMenu, onNoteKey,
  onGuide, onGuideDismiss,
}: OwnProps) => {
  // Папка под указателем при перетаскивании заметки
  const [dropKey, setDropKey] = useState<string>();
  const [areAllShown, showAll] = useFlag();
  const [now] = useState(() => Date.now());

  const lang = useLang();
  const dayFormat = useMemo(() => new Intl.DateTimeFormat(lang.code, { day: 'numeric', month: 'long' }), [lang.code]);

  const groups = useMemo(() => buildNoteGroups({ notes, folders, dailyFolders: DAILY_FOLDERS }), [notes, folders]);
  // Закреплённые заметки (меню заметки «Закрепить вверху») стоят первыми
  const { pinned } = useDerivedState(getNotesMeta);
  const recent = useMemo(() => sortPinnedFirst(sortByRecent(notes), pinned), [notes, pinned]);
  const openGroup = found ? undefined : groups.find(({ key }) => key === openGroupKey);
  const groupNotes = useMemo(() => (
    openGroup && !openGroup.isDaily ? sortPinnedFirst(sortByRecent(openGroup.items), pinned) : openGroup?.items
  ), [openGroup, pinned]);
  // Папки показываются, когда есть что выбирать: одна «Без папки» — это просто список
  const hasFolders = groups.some((group) => group.isDaily || group.folder !== ROOT_FOLDER);

  const captionOf = (group: Group) => (
    group.isDaily ? lang('KnowledgeDailyFolder')
      : group.folder === ROOT_FOLDER ? lang('KnowledgeRoot') : folderCaption(group.folder)
  );
  // В папку переносят и в ней создают, пока её узел известен; «Без папки» — корень хранилища
  const isTarget = (group: Group) => !group.isDaily && (group.folder === ROOT_FOLDER || Boolean(group.folderId));

  const handlePick = useLastCallback((e: React.MouseEvent<HTMLButtonElement>) => {
    onPick(e.currentTarget.dataset.id!);
  });

  const handleRowMenu = useLastCallback((e: React.MouseEvent<HTMLButtonElement>) => {
    e.preventDefault();
    if (isNarrow) {
      onNoteMenu(e.currentTarget.dataset.id!);
      return;
    }
    // Меню с клавиатуры (Shift+F10) приходит без точки курсора — меню встаёт под строкой
    const isFromKeyboard = !e.clientX && !e.clientY;
    const box = isFromKeyboard ? e.currentTarget.getBoundingClientRect() : undefined;
    onNoteMenu(e.currentTarget.dataset.id!, box ? { x: box.left, y: box.bottom } : { x: e.clientX, y: e.clientY });
  });

  // Строка под указателем — цель F2 / Del, если фокус не на строке
  const hoveredIdRef = useRef<string>();
  const handleRowEnter = useLastCallback((e: React.MouseEvent<HTMLButtonElement>) => {
    hoveredIdRef.current = e.currentTarget.dataset.id;
  });
  const handleRowLeave = useLastCallback((e: React.MouseEvent<HTMLButtonElement>) => {
    if (hoveredIdRef.current === e.currentTarget.dataset.id) hoveredIdRef.current = undefined;
  });

  // F2 — переименовать, Del — в корзину (доска `ZdNotesX`): строка в фокусе, под указателем либо открытая.
  // Слушатель ставится до первого кадра списка (правило экрана)
  const handleListKey = useLastCallback((e: KeyboardEvent) => {
    const action = ROW_KEYS[e.key];
    if (!action || e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return;
    if (!getIsParvaneScreenShown('notes') || document.body.classList.contains('has-open-dialog')) return;
    const target = e.target as HTMLElement | undefined;
    if (target?.closest?.('input, textarea, [contenteditable="true"]')) return;
    const focusedId = target?.closest?.<HTMLElement>('[data-note-row]')?.dataset.id;
    const noteId = focusedId || hoveredIdRef.current || openId;
    if (!noteId || !notes.some(({ id }) => id === noteId)) return;
    e.preventDefault();
    onNoteKey(noteId, action);
  });
  useLayoutEffect(() => {
    if (isNarrow) return undefined;
    document.addEventListener('keydown', handleListKey);
    return () => document.removeEventListener('keydown', handleListKey);
  }, [isNarrow, handleListKey]);

  const handleOpenGroup = useLastCallback((e: React.MouseEvent<HTMLButtonElement>) => {
    onOpenGroup(e.currentTarget.dataset.groupKey);
  });

  const handleCloseGroup = useLastCallback(() => {
    onOpenGroup(undefined);
  });

  const handleFolderMenu = useLastCallback((e: React.MouseEvent<HTMLButtonElement>) => {
    onFolderMenu(e.currentTarget.dataset.folderId!);
  });

  const handleNewNote = useLastCallback(() => onNewInFolder());

  const handleNewInFolder = useLastCallback((e: React.MouseEvent<HTMLButtonElement>) => {
    onNewInFolder(e.currentTarget.dataset.folderId || undefined);
  });

  const handleDragStart = useLastCallback((e: React.DragEvent<HTMLButtonElement>) => {
    e.dataTransfer.setData(NOTE_DRAG_TYPE, e.currentTarget.dataset.id!);
    e.dataTransfer.effectAllowed = 'move';
  });

  const handleDragOver = useLastCallback((e: React.DragEvent<HTMLElement>) => {
    if (!e.dataTransfer.types.includes(NOTE_DRAG_TYPE)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    const key = e.currentTarget.dataset.groupKey;
    if (key !== dropKey) setDropKey(key);
  });

  const handleDragLeave = useLastCallback((e: React.DragEvent<HTMLElement>) => {
    if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDropKey(undefined);
  });

  const handleDrop = useLastCallback((e: React.DragEvent<HTMLElement>) => {
    const noteId = e.dataTransfer.getData(NOTE_DRAG_TYPE);
    setDropKey(undefined);
    if (!noteId) return;
    e.preventDefault();
    onMoveNote(noteId, e.currentTarget.dataset.folderId || undefined);
  });

  function folderOf(note: NoteEntry) {
    if (note.isDaily && isDayTitle(note.title)) return lang('KnowledgeDailyFolder');
    return note.folder ? folderCaption(note.folder) : lang('KnowledgeRoot');
  }

  // Общие признаки строки заметки: выбор, меню по правой кнопке, перетаскивание в папку, цель F2 / Del
  function rowProps(note: NoteEntry) {
    const isDaily = note.isDaily && isDayTitle(note.title);
    return {
      type: 'button' as const,
      draggable: !isNarrow && !isDaily,
      'data-id': note.id,
      'data-note-row': note.title,
      'data-row-folder': note.folder,
      'data-pinned': pinned.includes(note.id) || undefined,
      onClick: handlePick,
      onDragStart: handleDragStart,
      onContextMenu: handleRowMenu,
      onMouseEnter: isNarrow ? undefined : handleRowEnter,
      onMouseLeave: isNarrow ? undefined : handleRowLeave,
    };
  }

  // Строка заметки (доски `Notes`, `DeskNotes`): название и время, начало текста, синим — тег и связи;
  // `hasFolder` — в мете и папка (поиск по всем заметкам)
  function renderRow(note: NoteEntry, hasFolder?: boolean) {
    const next = nearestPlanned(plannedOf(plannedIndex, note), today);
    const tag = firstTagOf(note);
    const linkCount = countNoteLinks(index, note.id);
    const meta = [
      pinned.includes(note.id) ? lang('KnowledgePinned') : undefined,
      hasFolder ? folderOf(note) : undefined,
      tag && `#${tag}`,
      linkCount ? lang('KnowledgeLinksCount', { count: linkCount }, { pluralValue: linkCount }) : undefined,
      next?.day && `${lang('KnowledgeNearest')} ${formatDayShort(lang, next.day)}`,
    ].filter(Boolean).join(' · ');
    return (
      <button
        key={note.id}
        className={buildClassName(styles.row, note.id === openId && styles.rowOn)}
        {...rowProps(note)}
      >
        <span className={styles.rowTop}>
          <span className={styles.rowTitle}>{displayTitle(lang, note)}</span>
          <span className={styles.rowTime}>{formatNoteTime(lang, note.updatedAt, now)}</span>
        </span>
        <span className={styles.rowPreview}>{previewOf(note) || lang('KnowledgeNoteEmpty')}</span>
        {meta && <span className={styles.rowMeta}>{meta}</span>}
        <NoteUnsentMark noteId={note.id} />
      </button>
    );
  }

  // Строка «Недавних» телефона (доска `PhNotesMore`): название и одной серой строкой «папка · когда»; заметка дня —
  // «15 ноября» и «Ежедневные · заметка дня»
  function renderRecentRow(note: NoteEntry) {
    const isDaily = note.isDaily && isDayTitle(note.title);
    const sub = isDaily ? `${lang('KnowledgeDailyFolder')} · ${lang('KnowledgeDaily').toLowerCase()}`
      : `${folderOf(note)} · ${formatNoteEdited(lang, note.updatedAt, now)}`;
    return (
      <button
        key={note.id}
        className={buildClassName(styles.row, note.id === openId && styles.rowOn)}
        {...rowProps(note)}
      >
        <span className={styles.rowTitle}>{isDaily ? dayFormat.format(fromDayKey(note.title)) : note.title}</span>
        <span className={styles.rowPreview} data-row-sub>
          {pinned.includes(note.id) ? `${lang('KnowledgePinned')} · ${sub}` : sub}
        </span>
        <NoteUnsentMark noteId={note.id} />
      </button>
    );
  }

  // Строка таблицы компьютера (доска `ZdNotesX`): значок, название, папка, тег, дата
  function renderTableRow(note: NoteEntry) {
    const tag = firstTagOf(note);
    return (
      <button
        key={note.id}
        className={buildClassName(styles.tableRow, note.id === openId && styles.rowOn)}
        {...rowProps(note)}
      >
        <PvIcon name="note" className={styles.tableIcon} />
        <span className={styles.tableTitle}>
          {displayTitle(lang, note)}
          <NoteUnsentMark noteId={note.id} />
        </span>
        <span className={styles.tableCell}>{folderOf(note)}</span>
        <span className={buildClassName(styles.tableCell, styles.tableTag)}>{tag ? `#${tag}` : ''}</span>
        <span className={styles.tableDate}>{formatNoteTime(lang, note.updatedAt, now)}</span>
      </button>
    );
  }

  function renderFolderRow(group: Group) {
    const caption = captionOf(group);
    const canDrop = isTarget(group);
    return (
      <button
        key={group.key}
        type="button"
        className={buildClassName(styles.folderRow, dropKey === group.key && styles.folderRowDrop)}
        style={`--c: ${group.folder === ROOT_FOLDER ? 'var(--pv-muted)' : folderColor(group.folder, group.isDaily)}`}
        data-folder={group.folder}
        data-folder-id={group.folderId}
        data-group-key={group.key}
        onClick={handleOpenGroup}
        onDragOver={canDrop ? handleDragOver : undefined}
        onDragLeave={canDrop ? handleDragLeave : undefined}
        onDrop={canDrop ? handleDrop : undefined}
      >
        <PvIcon name="folder" className={styles.folderIcon} />
        <span className={styles.folderName}>{caption}</span>
        <span className={styles.folderCount} data-folder-count>{group.items.length}</span>
      </button>
    );
  }

  function renderGroupEmpty(group: Group) {
    return (
      <button
        type="button"
        className={styles.groupEmpty}
        disabled={!isTarget(group)}
        data-folder-empty
        data-folder-id={group.folderId}
        onClick={handleNewInFolder}
      >
        {lang('KnowledgeFolderEmpty')}
      </button>
    );
  }

  function renderOpenGroup(group: Group) {
    const caption = captionOf(group);
    const canAdd = isTarget(group);
    return (
      <section className={styles.group} data-folder-open={group.folder} data-folder-id={group.folderId}>
        <div className={styles.groupHead}>
          <button
            type="button"
            className={kit.ib}
            aria-label={lang('KnowledgeAllNotes')}
            title={lang('KnowledgeAllNotes')}
            data-folder-back
            onClick={handleCloseGroup}
          >
            <PvIcon name="left" />
          </button>
          <h2 className={styles.groupTitle}>{caption}</h2>
          <span className={styles.folderCount}>{group.items.length}</span>
          {canAdd && group.folderId && (
            <button
              type="button"
              className={kit.ib}
              aria-label={lang('KnowledgeFolderActions', { name: caption })}
              title={lang('KnowledgeFolderActions', { name: caption })}
              data-folder-menu
              data-folder-id={group.folderId}
              onClick={handleFolderMenu}
            >
              <PvIcon name="dots" />
            </button>
          )}
        </div>
        {groupNotes!.map((note) => renderRow(note))}
        {!group.items.length && renderGroupEmpty(group)}
      </section>
    );
  }

  function renderGuideNotice() {
    if (!guideNoticeFolder) return undefined;
    return (
      <div className={styles.guideNotice} role="status" data-notes-guide-notice>
        <span className={styles.guideNoticeText}>{lang('KnowledgeGuideAdded', { name: guideNoticeFolder })}</span>
        <button
          type="button"
          className={buildClassName(kit.btn, kit.btnAcc, styles.guideNoticeButton)}
          data-notes-guide-open
          onClick={onGuide}
        >
          {lang('KnowledgeGuideOpen')}
        </button>
        <button
          type="button"
          className={kit.ib}
          aria-label={lang('KnowledgeGuideDismiss')}
          title={lang('KnowledgeGuideDismiss')}
          data-notes-guide-dismiss
          onClick={onGuideDismiss}
        >
          <PvIcon name="x" isSmall />
        </button>
      </div>
    );
  }

  function renderTail() {
    return (
      <>
        {!notes.length && (
          <PvEmpty
            title={lang('KnowledgeEmptyTitle')}
            text={lang('KnowledgeEmptyText')}
            actionText={lang('KnowledgeNewNote')}
            linkText={lang('KnowledgeEmptyGuide')}
            data-notes-empty
            onAction={handleNewNote}
            onLink={onGuide}
          />
        )}
        {/* Справка есть у всех с первого открытия; кнопка нужна, только чтобы вернуть удалённую */}
        {!hasGuide && Boolean(notes.length) && (
          <button
            type="button"
            className={buildClassName(kit.btn, kit.btnGhost, styles.wideButton)}
            data-notes-guide
            onClick={onGuide}
          >
            {lang('KnowledgeGuideReturn')}
          </button>
        )}
        <p className={styles.hint}>{lang('KnowledgeStorageHint', { name: vaultName })}</p>
      </>
    );
  }

  function renderShowAll(total: number, shownCount: number) {
    if (total <= shownCount) return undefined;
    return (
      <button type="button" className={buildClassName(kit.btn, kit.btnGhost, styles.wideButton)} onClick={showAll}>
        {lang('KnowledgeShowAll', { count: total })}
      </button>
    );
  }

  // Телефон: папки строками со счётчиком и недавние заметки
  function renderRoot() {
    const shown = areAllShown ? recent : recent.slice(0, RECENT_SHOWN);
    return (
      <>
        {renderGuideNotice()}
        {hasFolders && (
          <>
            <h2 className={buildClassName(styles.cap, styles.capTitle)}>{lang('KnowledgeFolders')}</h2>
            <div className={styles.block} data-notes-folders>{groups.map(renderFolderRow)}</div>
          </>
        )}
        {Boolean(notes.length) && (
          <>
            <h2 className={buildClassName(styles.cap, styles.capTitle)}>{lang('KnowledgeRecent')}</h2>
            <div className={styles.block} data-notes-recent>{shown.map(renderRecentRow)}</div>
          </>
        )}
        {renderShowAll(recent.length, shown.length)}
        {renderTail()}
      </>
    );
  }

  // Компьютер: заметки выбранной папки либо все, без строк папок (папки — в колонке слева)
  function renderDesk() {
    const isTable = deskLayout === 'table';
    const list = found || (openGroup ? groupNotes! : recent);
    const shown = found || openGroup || areAllShown ? list : list.slice(0, RECENT_SHOWN);
    const renderOne = isTable ? renderTableRow : (note: NoteEntry) => renderRow(note, !openGroup);
    return (
      <>
        {!found && renderGuideNotice()}
        <div
          className={buildClassName(styles.block, isTable && styles.table)}
          data-notes-recent={!found && !openGroup ? true : undefined}
          data-notes-found={found ? true : undefined}
        >
          {shown.map(renderOne)}
        </div>
        {!found && openGroup && !openGroup.items.length && renderGroupEmpty(openGroup)}
        {found && !found.length && <PvEmpty title={lang('KnowledgeNothingFound')} data-notes-nothing />}
        {!found && renderShowAll(list.length, shown.length)}
        {!found && isTable && renderTail()}
      </>
    );
  }

  return (
    <div
      className={buildClassName(styles.root, 'custom-scroll')}
      data-notes-list
      data-notes-layout={isNarrow ? 'phone' : deskLayout}
      // Компьютер: выбранная в колонке папка (на телефоне — у раздела открытой папки)
      data-folder-open={!isNarrow && !found ? openGroup?.folder : undefined}
      data-folder-id={!isNarrow && !found ? openGroup?.folderId : undefined}
    >
      {!isNarrow ? renderDesk() : found ? (
        <div className={styles.block} data-notes-found>
          {found.map((note) => renderRow(note, true))}
          {!found.length && <PvEmpty title={lang('KnowledgeNothingFound')} data-notes-nothing />}
        </div>
      ) : openGroup ? renderOpenGroup(openGroup) : renderRoot()}
    </div>
  );
};

export default memo(NotesList);
