import { memo, useMemo, useState } from '../../../lib/teact/teact';

import type { NoteFolder, NoteGroup } from './notesFolders';
import type { NotesIndex } from './notesModel';
import type { PlannedIndex } from './notesPlanned';
import type { NoteEntry } from './notesStore';

import buildClassName from '../../../util/buildClassName';
import { buildNoteGroups, folderCaption, ROOT_FOLDER } from './notesFolders';
import {
  countNoteLinks, firstTagOf, formatNoteTime, sortByRecent,
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

import NoteUnsentMark from './NoteUnsentMark';
import PvEmpty from './PvEmpty';
import PvIcon from './PvIcon';

import styles from './NotesList.module.scss';
import kit from './PvKit.module.scss';

// Столько недавних заметок видно в общем списке, пока не попросили все
const RECENT_SHOWN = 50;
const NOTE_DRAG_TYPE = 'application/x-parvane-note';
// Названия папки заметок дня на обоих языках (как в `notesStore`)
const DAILY_FOLDERS = ['Ежедневные', 'Daily'];

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
  // Телефон: кнопка «Новая папка» стоит в шапке, строки не перетаскиваются
  isNarrow: boolean;
  onPick: (noteId: string) => void;
  onOpenGroup: (key?: string) => void;
  onNewFolder: NoneToVoidFunction;
  onFolderMenu: (folderId: string) => void;
  onNewInFolder: (folderId?: string) => void;
  onMoveNote: (noteId: string, folderId?: string) => void;
  // Правая кнопка по строке заметки (компьютер): меню строки
  onNoteMenu: (noteId: string) => void;
  onGuide: NoneToVoidFunction;
  onGuideDismiss: NoneToVoidFunction;
};

// Список заметок по макету (доски `Notes`, `PhNotesMore`, `DeskNotes`): папки строками со счётчиком и недавние
// заметки; открытая папка — её заметки; поиск — найденное одним списком
const NotesList = ({
  notes, folders, index, plannedIndex, today, found, openId, openGroupKey, vaultName, guideNoticeFolder, hasGuide,
  isNarrow, onPick, onOpenGroup, onNewFolder, onFolderMenu, onNewInFolder, onMoveNote, onNoteMenu, onGuide,
  onGuideDismiss,
}: OwnProps) => {
  // Папка под указателем при перетаскивании заметки
  const [dropKey, setDropKey] = useState<string>();
  const [areAllShown, showAll] = useFlag();
  const [now] = useState(() => Date.now());

  const lang = useLang();

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
    onNoteMenu(e.currentTarget.dataset.id!);
  });

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

  function renderRow(note: NoteEntry, hasFolder?: boolean) {
    const isDaily = note.isDaily && isDayTitle(note.title);
    const next = nearestPlanned(plannedOf(plannedIndex, note), today);
    const tag = firstTagOf(note);
    const linkCount = countNoteLinks(index, note.id);
    const folder = !hasFolder ? undefined
      : isDaily ? lang('KnowledgeDailyFolder') : note.folder ? folderCaption(note.folder) : undefined;
    const meta = [
      pinned.includes(note.id) ? lang('KnowledgePinned') : undefined,
      folder,
      tag && `#${tag}`,
      linkCount ? lang('KnowledgeLinksCount', { count: linkCount }, { pluralValue: linkCount }) : undefined,
      next?.day && `${lang('KnowledgeNearest')} ${formatDayShort(lang, next.day)}`,
    ].filter(Boolean).join(' · ');
    return (
      <button
        key={note.id}
        type="button"
        className={buildClassName(styles.row, note.id === openId && styles.rowOn)}
        draggable={!isNarrow && !isDaily}
        data-id={note.id}
        data-note-row={note.title}
        data-row-folder={note.folder}
        data-pinned={pinned.includes(note.id) || undefined}
        onClick={handlePick}
        onDragStart={handleDragStart}
        onContextMenu={isNarrow ? undefined : handleRowMenu}
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
        {!group.items.length && (
          <button
            type="button"
            className={styles.groupEmpty}
            disabled={!canAdd}
            data-folder-empty
            data-folder-id={group.folderId}
            onClick={handleNewInFolder}
          >
            {lang('KnowledgeFolderEmpty')}
          </button>
        )}
      </section>
    );
  }

  function renderRoot() {
    const shown = areAllShown ? recent : recent.slice(0, RECENT_SHOWN);
    return (
      <>
        {guideNoticeFolder && (
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
        )}
        {(hasFolders || !isNarrow) && (
          <div className={styles.cap}>
            <h2 className={styles.capTitle}>{lang('KnowledgeFolders')}</h2>
            {!isNarrow && (
              <button
                type="button"
                className={buildClassName(kit.ib, styles.capButton)}
                aria-label={lang('KnowledgeNewFolder')}
                title={lang('KnowledgeNewFolder')}
                data-notes-new-folder
                onClick={onNewFolder}
              >
                <PvIcon name="plus" isSmall />
              </button>
            )}
          </div>
        )}
        {hasFolders && <div className={styles.block} data-notes-folders>{groups.map(renderFolderRow)}</div>}
        {Boolean(notes.length) && (
          <>
            <h2 className={buildClassName(styles.cap, styles.capTitle)}>{lang('KnowledgeRecent')}</h2>
            <div className={styles.block} data-notes-recent>
              {shown.map((note) => renderRow(note, true))}
            </div>
          </>
        )}
        {recent.length > shown.length && (
          <button type="button" className={buildClassName(kit.btn, kit.btnGhost, styles.wideButton)} onClick={showAll}>
            {lang('KnowledgeShowAll', { count: recent.length })}
          </button>
        )}
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

  return (
    <div className={buildClassName(styles.root, 'custom-scroll')} data-notes-list>
      {found ? (
        <div className={styles.block} data-notes-found>
          {found.map((note) => renderRow(note, true))}
          {!found.length && <PvEmpty title={lang('KnowledgeNothingFound')} data-notes-nothing />}
        </div>
      ) : openGroup ? renderOpenGroup(openGroup) : renderRoot()}
    </div>
  );
};

export default memo(NotesList);
