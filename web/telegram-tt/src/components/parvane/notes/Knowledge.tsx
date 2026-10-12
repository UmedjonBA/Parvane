import {
  memo, useEffect, useMemo, useState,
} from '../../../lib/teact/teact';

import type { GlobalState } from '../../../global/types';
import type { FolderSubmitError, NoteGroup } from './notesFolders';
import type { NoteEntry } from './notesStore';

import buildClassName from '../../../util/buildClassName';
import { consumeNoteRequest, getKnowledgeView, getNoteRequest } from '../../../util/parvaneSection';
import { toDayKey } from '../planner/plannerModel';
import { getPlannerState, loadPlanner } from '../planner/plannerStore';
import {
  buildNoteGroups, folderCaption, isInFolder, ROOT_FOLDER,
} from './notesFolders';
import { buildGuide, findGuideOverview, getGuideLang } from './notesGuide';
import {
  avatarText, displayTitle, folderColor, formatDayShort, isDayTitle, previewOf,
} from './notesLook';
import { buildPlannedIndex, nearestPlanned, plannedOf } from './notesPlanned';
import {
  isGuideSeen, markGuideSeen, readCollapsedFolders, writeCollapsedFolders,
} from './notesPrefs';
import {
  applyPlannerToNotes, consumeGuideOpen, createNote, createNoteFolder, deleteNote, deleteNoteFolder,
  findNoteByTitle, getCanvases, getGuideOpenId, getNoteFolders, getNotes, getNotesIndex, getNotesNotice,
  getNotesStatus, loadNotes, moveNote, openDailyNote, renameNote, renameNoteFolder, restoreGuide, saveNote,
} from './notesStore';

import useSelector from '../../../hooks/data/useSelector';
import useDerivedState from '../../../hooks/useDerivedState';
import useFlag from '../../../hooks/useFlag';
import useLang from '../../../hooks/useLang';
import useLastCallback from '../../../hooks/useLastCallback';
import useWindowSize from '../../../hooks/window/useWindowSize';

import ConfirmDialog from '../../ui/ConfirmDialog';
import Loading from '../../ui/Loading';
import KnowledgeTabs from './KnowledgeTabs';
import NoteFolderPicker from './NoteFolderPicker';
import NoteFolderSheet from './NoteFolderSheet';
import NoteLinks from './NoteLinks';
import NotesCanvas from './NotesCanvas';
import NotesGraph from './NotesGraph';
import NoteView from './NoteView';
import PvIcon from './PvIcon';

import styles from './Knowledge.module.scss';
import kit from './PvKit.module.scss';

// Узкий экран: виден либо список, либо заметка; вкладки раздела — подчёркнутой строкой
const NARROW_WIDTH = 760;
// Широкий экран: «Связи» открытой заметки — отдельный остров справа
const SIDE_MIN_WIDTH = 1241;
const NOTICE_HIDE_MS = 6000;
// Столько последних заметок дня видно в списке, пока не попросили все
const DAILY_SHOWN = 5;
const NOTE_LINK = /(\[\[[^\]\n]+\]\])/;
const NOTE_DRAG_TYPE = 'application/x-parvane-note';
// Названия папки заметок дня на обоих языках (как в `notesStore`)
const DAILY_FOLDERS = ['Ежедневные', 'Daily'];
const NOTICE_KEYS = {
  conflict: 'KnowledgeNoticeConflict',
  merged: 'KnowledgeNoticeMerged',
  failed: 'KnowledgeNoticeFailed',
  'folder-files': 'KnowledgeNoticeFolderFiles',
} as const;

type Group = NoteGroup<NoteEntry>;
type FolderRemoval = { id: string; name: string; count: number };

function selectCurrentUserId(global: GlobalState) {
  return global.currentUserId;
}

// Parvane: раздел «Знания» — заметки `.md` в зашифрованной папке облака, граф связей и холсты.
// Вкладка «Файлы» — прежнее «Облако» (его рисует `Cloud`, шапка у них общая — `KnowledgeTabs`)
const Knowledge = () => {
  const notes = useDerivedState(getNotes);
  const folders = useDerivedState(getNoteFolders);
  const canvases = useDerivedState(getCanvases);
  const status = useDerivedState(getNotesStatus);
  const notice = useDerivedState(getNotesNotice);
  const view = useDerivedState(getKnowledgeView);
  const planner = useDerivedState(getPlannerState);
  const noteRequest = useDerivedState(getNoteRequest);
  const guideOpenId = useDerivedState(getGuideOpenId);
  const currentUserId = useSelector(selectCurrentUserId);

  const [openId, setOpenId] = useState<string>();
  const [query, setQuery] = useState('');
  const [isNoticeShown, setIsNoticeShown] = useState(false);
  const [areAllDailyShown, setAreAllDailyShown] = useState(false);
  const [collapsed, setCollapsed] = useState(readCollapsedFolders);
  const [hasSeenGuide, setHasSeenGuide] = useState(() => isGuideSeen(currentUserId));
  // Папка под указателем при перетаскивании заметки
  const [dropKey, setDropKey] = useState<string>();
  // Шторка папки: правится папка `sheetFolderId`, без неё — создаётся новая
  const [sheetFolderId, setSheetFolderId] = useState<string>();
  const [isFolderSheetOpen, openFolderSheet, closeFolderSheet] = useFlag();
  const [removal, setRemoval] = useState<FolderRemoval>();
  const [isRemovalOpen, openRemoval, closeRemoval] = useFlag();
  const [movedNoteId, setMovedNoteId] = useState<string>();
  const [isPickerOpen, openPicker, closePicker] = useFlag();
  const [isRestoreOpen, openRestore, closeRestore] = useFlag();

  const lang = useLang();
  const { width: windowWidth } = useWindowSize();
  const isNarrow = windowWidth <= NARROW_WIDTH;
  const hasSide = windowWidth >= SIDE_MIN_WIDTH;
  const vaultName = lang('KnowledgeVaultName');
  const [today] = useState(() => toDayKey(new Date()));

  const guideLang = getGuideLang(lang.code);

  useEffect(() => {
    void loadNotes(currentUserId, { guideLang, vaultName });
    void loadPlanner(currentUserId);
    setHasSeenGuide(isGuideSeen(currentUserId));
  }, [currentUserId, guideLang, vaultName]);

  const markGuide = useLastCallback(() => {
    markGuideSeen(currentUserId);
    setHasSeenGuide(true);
  });

  // «Обзор» справки нового хранилища открывается сам (на узком экране остаётся список с сообщением о ней)
  useEffect(() => {
    if (!guideOpenId || !notes.some(({ id }) => id === guideOpenId)) return;
    consumeGuideOpen();
    if (openId || isNarrow) return;
    setOpenId(guideOpenId);
    markGuide();
  }, [guideOpenId, notes, openId, isNarrow]);

  // Галочки и удаления из «Плана» доезжают до пунктов заметок
  useEffect(() => {
    if (status === 'ready') void applyPlannerToNotes(vaultName);
  }, [planner, status, vaultName]);

  useEffect(() => {
    if (!notice) return undefined;
    setIsNoticeShown(true);
    const timer = window.setTimeout(() => setIsNoticeShown(false), NOTICE_HIDE_MS);
    return () => window.clearTimeout(timer);
  }, [notice]);

  const index = useMemo(() => getNotesIndex(notes), [notes]);
  const plannedIndex = useMemo(() => buildPlannedIndex(planner, today), [planner, today]);
  const openNote = notes.find(({ id }) => id === openId);
  const openPlanned = useMemo(() => (
    openNote ? plannedOf(plannedIndex, openNote) : []
  ), [plannedIndex, openNote]);
  const guideOverview = useMemo(() => findGuideOverview(notes), [notes]);
  const guideFolderName = guideOverview?.folder
    ? folderCaption(guideOverview.folder) : buildGuide(guideLang).folderName;
  const sheetFolder = folders.find(({ id }) => id === sheetFolderId);
  const movedNote = notes.find(({ id }) => id === movedNoteId);

  // Ссылка на заметку, которой ещё нет, создаёт её
  const openTitle = useLastCallback(async (title: string) => {
    const existing = findNoteByTitle(title);
    // Название-дата — заметка дня: создаётся по шаблону в своей папке
    const id = existing?.id || (isDayTitle(title)
      ? await openDailyNote(title, vaultName, lang('KnowledgeDailyFolder'))
      : await createNote(title, vaultName));
    if (id) setOpenId(id);
  });

  useEffect(() => {
    if (!noteRequest || status !== 'ready') return;
    consumeNoteRequest();
    void openTitle(noteRequest);
  }, [noteRequest, status]);

  const expandGroup = useLastCallback((key: string) => {
    if (!collapsed.includes(key)) return;
    const next = collapsed.filter((item) => item !== key);
    setCollapsed(next);
    writeCollapsedFolders(next);
  });

  const createIn = useLastCallback(async (folderId?: string) => {
    const id = await createNote(lang('KnowledgeNewNote'), vaultName, { folderId });
    if (id) setOpenId(id);
  });

  // Новая заметка ложится в папку открытой заметки; из справки и заметок дня — в «Без папки»
  const handleNew = useLastCallback(() => {
    const isOwnFolder = openNote && !(openNote.isDaily && isDayTitle(openNote.title))
      && openNote.folder !== guideOverview?.folder;
    const folder = isOwnFolder ? folders.find(({ path }) => path === openNote.folder) : undefined;
    expandGroup(folder?.path || ROOT_FOLDER);
    void createIn(folder?.id);
  });

  const handleNewInFolder = useLastCallback((e: React.MouseEvent<HTMLButtonElement>) => {
    expandGroup(e.currentTarget.dataset.groupKey!);
    void createIn(e.currentTarget.dataset.folderId || undefined);
  });

  // «Справка Parvane»: открыть «Обзор»; справки нет (удалена либо ещё не создана) — предложить создать
  const handleGuide = useLastCallback(() => {
    if (!guideOverview) {
      openRestore();
      return;
    }
    setOpenId(guideOverview.id);
    markGuide();
  });

  const handleRestoreGuide = useLastCallback(async () => {
    closeRestore();
    const id = await restoreGuide();
    if (!id) return;
    setOpenId(id);
    markGuide();
  });

  const handleQuery = useLastCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    setQuery(e.currentTarget.value);
  });

  const handlePick = useLastCallback((e: React.MouseEvent<HTMLButtonElement>) => {
    setOpenId(e.currentTarget.dataset.id);
  });

  const handleBack = useLastCallback(() => {
    setOpenId(undefined);
  });

  const handleShowAllDaily = useLastCallback(() => {
    setAreAllDailyShown(true);
  });

  const handleToggleGroup = useLastCallback((e: React.MouseEvent<HTMLButtonElement>) => {
    const key = e.currentTarget.dataset.groupKey!;
    const next = collapsed.includes(key) ? collapsed.filter((item) => item !== key) : [...collapsed, key];
    setCollapsed(next);
    writeCollapsedFolders(next);
  });

  const handleNewFolder = useLastCallback(() => {
    setSheetFolderId(undefined);
    openFolderSheet();
  });

  const handleFolderMenu = useLastCallback((e: React.MouseEvent<HTMLButtonElement>) => {
    setSheetFolderId(e.currentTarget.dataset.folderId);
    openFolderSheet();
  });

  const handleFolderSubmit = useLastCallback(async (name: string): Promise<FolderSubmitError | undefined> => {
    if (sheetFolder) return renameNoteFolder(sheetFolder.id, name);
    return (await createNoteFolder(name, vaultName)).error;
  });

  // Пустая папка удаляется сразу; с заметками — после вопроса, заметки переезжают в «Без папки»
  const handleFolderDelete = useLastCallback(() => {
    closeFolderSheet();
    if (!sheetFolder) return;
    const count = notes.filter((note) => isInFolder(note.folder, sheetFolder.path)).length;
    if (!count) {
      void deleteNoteFolder(sheetFolder.id);
      return;
    }
    setRemoval({ id: sheetFolder.id, name: folderCaption(sheetFolder.path), count });
    openRemoval();
  });

  const handleRemovalConfirm = useLastCallback(() => {
    closeRemoval();
    if (removal) void deleteNoteFolder(removal.id, true);
  });

  const handleAskMove = useLastCallback((noteId: string) => {
    setMovedNoteId(noteId);
    openPicker();
  });

  const handleMove = useLastCallback((folderId?: string) => {
    closePicker();
    if (movedNoteId) void moveNote(movedNoteId, folderId);
  });

  const handleMoveToNew = useLastCallback(async (name: string): Promise<FolderSubmitError | undefined> => {
    const created = await createNoteFolder(name, vaultName);
    if (!created.id) return created.error || 'failed';
    handleMove(created.id);
    return undefined;
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
    void moveNote(noteId, e.currentTarget.dataset.folderId || undefined);
  });

  const handleSave = useLastCallback((noteId: string, text: string) => saveNote(noteId, text, vaultName));

  const handleRename = useLastCallback((noteId: string, title: string) => {
    void renameNote(noteId, title, vaultName);
  });

  const handleDelete = useLastCallback((noteId: string) => {
    setOpenId(undefined);
    void deleteNote(noteId);
  });

  const handleOpenFromGraph = useLastCallback((noteId: string) => {
    setOpenId(noteId);
  });

  const found = useMemo(() => (query.trim() ? index.search(query) : undefined), [index, query]);
  const groups = useMemo(() => buildNoteGroups({
    notes: found ? found.map((item) => notes.find(({ id }) => id === item.id)!).filter(Boolean) : notes,
    folders,
    dailyFolders: DAILY_FOLDERS,
    isSearch: Boolean(found),
    dailyShown: areAllDailyShown ? undefined : DAILY_SHOWN,
  }), [notes, folders, found, areAllDailyShown]);

  const isList = view === 'notes';
  const isNoteShown = isList && Boolean(openNote);
  const isNoteAlone = isNarrow && isNoteShown;
  const openFolder = openNote && (openNote.isDaily ? lang('KnowledgeDailyFolder') : folderCaption(openNote.folder));
  const isGuideNew = Boolean(guideOverview) && !hasSeenGuide && !found;

  function renderRow(note: NoteEntry) {
    const next = nearestPlanned(plannedOf(plannedIndex, note), today);
    const isDaily = note.isDaily && isDayTitle(note.title);
    return (
      <button
        key={note.id}
        type="button"
        className={buildClassName(kit.row, styles.listRow, note.id === openId && kit.rowSel)}
        draggable={!isNarrow && !isDaily}
        data-id={note.id}
        data-note-row={note.title}
        onClick={handlePick}
        onDragStart={handleDragStart}
      >
        <span className={kit.ava} style={`--c: ${folderColor(note.folder, note.isDaily)}`} aria-hidden="true">
          {avatarText(note)}
        </span>
        <span className={kit.rowText}>
          <span className={kit.ttl}>{displayTitle(lang, note)}</span>
          <span className={kit.sub}>{previewOf(note) || lang('KnowledgeNoteEmpty')}</span>
        </span>
        {next?.day && (
          <span className={kit.meta} title={lang('KnowledgeNearest')}>{formatDayShort(lang, next.day)}</span>
        )}
      </button>
    );
  }

  function renderGroup(group: Group) {
    const isRoot = !group.isDaily && group.folder === ROOT_FOLDER;
    const caption = group.isDaily ? lang('KnowledgeDailyFolder')
      : isRoot ? lang('KnowledgeRoot') : folderCaption(group.folder);
    // При поиске свёрнутые папки раскрыты: иначе найденное было бы не видно
    const isCollapsed = !found && collapsed.includes(group.key);
    // В папку переносят и в ней создают, пока её узел известен; «Без папки» — корень хранилища
    const isTarget = !found && !group.isDaily && (isRoot || Boolean(group.folderId));
    return (
      <section
        key={group.key}
        className={buildClassName(styles.folder, dropKey === group.key && styles.folderDrop)}
        data-folder={group.folder}
        data-folder-id={group.folderId}
        data-group-key={group.key}
        data-collapsed={isCollapsed ? 'true' : undefined}
        onDragOver={isTarget ? handleDragOver : undefined}
        onDragLeave={isTarget ? handleDragLeave : undefined}
        onDrop={isTarget ? handleDrop : undefined}
      >
        <div className={styles.folderHead}>
          <h3 className={buildClassName(kit.grp, styles.folderTitle)}>
            <button
              type="button"
              className={buildClassName(kit.plain, styles.folderToggle)}
              aria-expanded={!isCollapsed}
              data-folder-toggle
              data-group-key={group.key}
              onClick={handleToggleGroup}
            >
              <PvIcon name={isCollapsed ? 'right' : 'down'} isSmall />
              <span className={styles.folderCaption}>{caption}</span>
              {isCollapsed && <span className={styles.folderCount}>{group.items.length + group.hidden}</span>}
            </button>
          </h3>
          {isTarget && (
            <button
              type="button"
              className={buildClassName(kit.ib, styles.folderButton)}
              aria-label={lang('KnowledgeFolderAddNote', { name: caption })}
              title={lang('KnowledgeFolderAddNote', { name: caption })}
              data-folder-add
              data-folder-id={group.folderId}
              data-group-key={group.key}
              onClick={handleNewInFolder}
            >
              <PvIcon name="plus" isSmall />
            </button>
          )}
          {isTarget && group.folderId && (
            <button
              type="button"
              className={buildClassName(kit.ib, styles.folderButton)}
              aria-label={lang('KnowledgeFolderActions', { name: caption })}
              title={lang('KnowledgeFolderActions', { name: caption })}
              data-folder-menu
              data-folder-id={group.folderId}
              onClick={handleFolderMenu}
            >
              <PvIcon name="dots" isSmall />
            </button>
          )}
        </div>
        {!isCollapsed && group.items.map(renderRow)}
        {!isCollapsed && !group.items.length && (
          <button
            type="button"
            className={buildClassName(kit.plain, styles.folderEmpty)}
            data-folder-empty
            data-folder-id={group.folderId}
            data-group-key={group.key}
            onClick={handleNewInFolder}
          >
            {lang('KnowledgeFolderEmpty')}
          </button>
        )}
        {!isCollapsed && group.hidden > 0 && (
          <button
            type="button"
            className={buildClassName(kit.btn, kit.btnGhost, kit.btnWide)}
            onClick={handleShowAllDaily}
          >
            {lang('KnowledgeShowAll', { count: group.hidden + group.items.length })}
          </button>
        )}
      </section>
    );
  }

  function renderList() {
    return (
      <aside className={buildClassName(styles.list, 'custom-scroll')} data-notes-list>
        <label className={buildClassName(kit.search, styles.listSearch)}>
          <PvIcon name="search" isSmall className={kit.searchIcon} />
          <input
            id="knowledge-search"
            className={kit.searchInput}
            type="search"
            value={query}
            placeholder={lang('KnowledgeSearch')}
            aria-label={lang('KnowledgeSearch')}
            autoComplete="off"
            onChange={handleQuery}
          />
        </label>
        {isGuideNew && (
          <div className={styles.guideNotice} role="status" data-notes-guide-notice>
            <span className={styles.guideNoticeText}>{lang('KnowledgeGuideAdded', { name: guideFolderName })}</span>
            <button
              type="button"
              className={buildClassName(kit.btn, kit.btnAcc)}
              data-notes-guide-open
              onClick={handleGuide}
            >
              {lang('KnowledgeGuideOpen')}
            </button>
            <button
              type="button"
              className={kit.ib}
              aria-label={lang('KnowledgeGuideDismiss')}
              title={lang('KnowledgeGuideDismiss')}
              data-notes-guide-dismiss
              onClick={markGuide}
            >
              <PvIcon name="x" isSmall />
            </button>
          </div>
        )}
        {!notes.length && <p className={styles.mutedLine}>{lang('KnowledgeEmpty')}</p>}
        {Boolean(notes.length) && !groups.length && (
          <p className={styles.mutedLine}>{lang('KnowledgeNothingFound')}</p>
        )}
        {groups.map(renderGroup)}
        <div className={styles.listButtons}>
          <button
            type="button"
            className={buildClassName(kit.btn, styles.listButton)}
            data-notes-new
            onClick={handleNew}
          >
            <PvIcon name="plus" isSmall />
            {lang('KnowledgeNewNote')}
          </button>
          <button
            type="button"
            className={buildClassName(kit.btn, styles.listButton)}
            data-notes-new-folder
            onClick={handleNewFolder}
          >
            <PvIcon name="folder" isSmall />
            {lang('KnowledgeNewFolder')}
          </button>
        </div>
        <button
          type="button"
          className={buildClassName(kit.btn, kit.btnGhost, kit.btnWide)}
          data-notes-guide
          onClick={handleGuide}
        >
          {lang('KnowledgeGuide')}
        </button>
      </aside>
    );
  }

  return (
    <div id="ParvaneKnowledge" className={styles.root} data-knowledge-view={view} data-status={status}>
      <div className={buildClassName(kit.island, styles.page)}>
        {!isNoteAlone && (
          <header className={buildClassName(kit.hdr, kit.hdrTabs)}>
            <h1 className={buildClassName(kit.hdrTitle, kit.hideM)}>{lang('ParvaneSectionKnowledge')}</h1>
            <KnowledgeTabs />
            {isNoteShown && (
              <span className={buildClassName(kit.muted, kit.hideM, styles.crumb)}>
                {`/ ${openFolder || lang('KnowledgeRoot')}`}
              </span>
            )}
            <span className={buildClassName(kit.grow, kit.hideM)} />
            {isList && (
              <button
                type="button"
                className={buildClassName(kit.pill, kit.pillAcc, kit.hideM)}
                onClick={handleNew}
              >
                <PvIcon name="plus" isSmall />
                {lang('KnowledgeNoteShort')}
              </button>
            )}
            {view === 'canvas' && (
              <span className={buildClassName(kit.muted, kit.small, kit.hideM)}>{lang('KnowledgeCanvasHint')}</span>
            )}
          </header>
        )}
        {isNoticeShown && notice && (
          <div className={styles.notice} role="status">
            {notice.code === 'guide-failed' ? lang('KnowledgeNoticeGuideFailed')
              : lang(NOTICE_KEYS[notice.code], { name: notice.title })}
          </div>
        )}
        <div className={styles.content}>
          {status !== 'ready' ? <Loading /> : view === 'graph' ? (
            <NotesGraph notes={notes} planner={planner} onOpenNote={handleOpenFromGraph} onOpenTitle={openTitle} />
          ) : view === 'canvas' ? (
            <NotesCanvas canvases={canvases} notes={notes} isNarrow={isNarrow} onOpenTitle={openTitle} />
          ) : (
            <div className={styles.layout}>
              {!isNoteAlone && renderList()}
              {(!isNarrow || isNoteShown) && (
                <div className={buildClassName(styles.pane, 'custom-scroll')}>
                  {openNote ? (
                    <NoteView
                      note={openNote}
                      index={index}
                      planner={planner}
                      planned={openPlanned}
                      hasLinks={!hasSide}
                      onBack={isNarrow ? handleBack : undefined}
                      onOpenTitle={openTitle}
                      onSave={handleSave}
                      onRename={handleRename}
                      onDelete={handleDelete}
                      onPickFolder={handleAskMove}
                    />
                  ) : (
                    <p className={styles.pickNote}>
                      {lang('KnowledgePickNote').split(NOTE_LINK).map((part, i) => (
                        part.startsWith('[[')
                          ? <span key={i} className={styles.linkSample}>{part}</span>
                          : part
                      ))}
                    </p>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
      {hasSide && isNoteShown && openNote && (
        <aside className={buildClassName(kit.island, styles.side)} aria-label={lang('KnowledgeLinks')}>
          <header className={kit.hdr}>
            <h1 className={kit.hdrSmall}>{lang('KnowledgeLinks')}</h1>
          </header>
          <div className={buildClassName(styles.sideContent, 'custom-scroll')}>
            <NoteLinks note={openNote} index={index} planned={openPlanned} onOpenTitle={openTitle} />
          </div>
        </aside>
      )}
      <NoteFolderSheet
        isOpen={isFolderSheetOpen}
        folder={sheetFolder}
        onSubmit={handleFolderSubmit}
        onDelete={handleFolderDelete}
        onClose={closeFolderSheet}
      />
      <NoteFolderPicker
        isOpen={isPickerOpen}
        noteTitle={movedNote?.title || ''}
        currentPath={movedNote?.folder || ROOT_FOLDER}
        folders={folders}
        onPick={handleMove}
        onCreate={handleMoveToNew}
        onClose={closePicker}
      />
      <ConfirmDialog
        isOpen={isRemovalOpen}
        text={lang('KnowledgeFolderDeleteConfirm', { name: removal?.name || '', count: removal?.count || 0 })}
        confirmLabel={lang('KnowledgeFolderDeleteAction')}
        confirmIsDestructive
        confirmHandler={handleRemovalConfirm}
        onClose={closeRemoval}
      />
      <ConfirmDialog
        isOpen={isRestoreOpen}
        text={lang('KnowledgeGuideRestoreText', { name: buildGuide(guideLang).folderName })}
        confirmLabel={lang('KnowledgeGuideRestore')}
        confirmHandler={handleRestoreGuide}
        onClose={closeRestore}
      />
    </div>
  );
};

export default memo(Knowledge);
