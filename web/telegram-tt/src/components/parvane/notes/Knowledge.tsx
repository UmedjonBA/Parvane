import {
  memo, useEffect, useMemo, useRef, useState,
} from '../../../lib/teact/teact';

import type { GlobalState } from '../../../global/types';
import type { GraphCanvasScope } from './notesCanvasGraph';
import type { FolderSubmitError, NoteGroup } from './notesFolders';
import type { GraphLinkOutcome, GraphPick } from './NotesGraph';
import type { PlannedItem } from './notesPlanned';
import type { NoteEntry } from './notesStore';
import type { NoteEditRequest } from './NoteView';

import buildClassName from '../../../util/buildClassName';
import {
  consumeNoteRequest, getKnowledgeView, getNoteRequest, setKnowledgeView,
} from '../../../util/parvaneSection';
import { SEARCH_FIELD_PROPS } from '../../../util/searchField';
import { openPalette } from '../palette/paletteOpen';
import { toDayKey } from '../planner/plannerModel';
import { getPlannerState, loadPlanner } from '../planner/plannerStore';
import { openOfferInPlan } from '../taskOffer/taskOfferOpen';
import { serializeCanvas } from './notesCanvas';
import { canvasFromGraph, freeCanvasTitle } from './notesCanvasGraph';
import {
  buildNoteGroups, folderCaption, isInFolder, ROOT_FOLDER,
} from './notesFolders';
import { buildGuide, findGuideOverview, getGuideLang } from './notesGuide';
import { addLinkToText, canLinkTitle, removeLinkFromText } from './notesLinkEdit';
import {
  avatarText, displayTitle, folderColor, formatDayShort, isDayTitle, previewOf,
} from './notesLook';
import { parseNote } from './notesModel';
import { buildPlannedIndex, nearestPlanned, plannedOf } from './notesPlanned';
import {
  isGuideSeen, markGuideSeen, readCollapsedFolders, writeCollapsedFolders,
} from './notesPrefs';
import {
  applyPlannerToNotes, consumeGuideOpen, createNote, createNoteFolder, deleteNote, deleteNoteFolder,
  findNoteByTitle, getCanvases, getGuideOpenId, getNoteFolders, getNotes, getNotesIndex, getNotesNotice,
  getNotesStatus, loadNotes, moveNote, openDailyNote, renameNote, renameNoteFolder, restoreGuide, retainNotes,
  saveCanvas, saveNote,
} from './notesStore';

import useSelector from '../../../hooks/data/useSelector';
import useDerivedState from '../../../hooks/useDerivedState';
import useFlag from '../../../hooks/useFlag';
import useLang from '../../../hooks/useLang';
import useLastCallback from '../../../hooks/useLastCallback';
import useWindowSize from '../../../hooks/window/useWindowSize';

import ConfirmDialog from '../../ui/ConfirmDialog';
import Loading from '../../ui/Loading';
import SearchForm from '../../ui/SearchForm';
import PlannerQuickHost from '../planner/PlannerQuickHost';
import GraphPanel from './GraphPanel';
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
// Сообщение о правке связи на графе; `undo` возвращает текст заметки
type GraphNotice = { text: string; at: number; undo?: NoneToVoidFunction };

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
  // Граф: точка, открытая в панели справа, заметка-источник режима «Связать», просьба о правке, сообщение
  const [graphPick, setGraphPick] = useState<GraphPick>();
  const [linkFromId, setLinkFromId] = useState<string>();
  const [editRequest, setEditRequest] = useState<NoteEditRequest>();
  const [graphNotice, setGraphNotice] = useState<GraphNotice>();
  // Холст, созданный с графа: вкладка «Холст» открывается на нём
  const [graphCanvasId, setGraphCanvasId] = useState<string>();
  const isMakingCanvasRef = useRef(false);

  const lang = useLang();
  const { width: windowWidth } = useWindowSize();
  const isNarrow = windowWidth <= NARROW_WIDTH;
  const hasSide = windowWidth >= SIDE_MIN_WIDTH;
  const vaultName = lang('KnowledgeVaultName');
  const [today] = useState(() => toDayKey(new Date()));

  const guideLang = getGuideLang(lang.code);

  // Пока раздел открыт, изменения облака применяются к заметкам сразу; закрыт — при следующем открытии
  useEffect(() => retainNotes(), []);

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

  useEffect(() => {
    if (!graphNotice) return undefined;
    const timer = window.setTimeout(() => setGraphNotice(undefined), NOTICE_HIDE_MS);
    return () => window.clearTimeout(timer);
  }, [graphNotice]);

  // Режим «Связать» и просьба о правке живут только на графе
  useEffect(() => {
    if (view === 'graph') return;
    setLinkFromId(undefined);
    setEditRequest(undefined);
  }, [view]);

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

  // Заметка с этим названием; нет такой — создаётся. Название-дата — заметка дня: по шаблону в своей папке
  const ensureNote = useLastCallback(async (title: string) => (
    findNoteByTitle(title)?.id || (isDayTitle(title)
      ? openDailyNote(title, vaultName, lang('KnowledgeDailyFolder'))
      : createNote(title, vaultName))
  ));

  // Ссылка на заметку, которой ещё нет, создаёт её
  const openTitle = useLastCallback(async (title: string) => {
    const id = await ensureNote(title);
    if (id) setOpenId(id);
  });

  // С холста заметка открывается на вкладке «Заметки»
  const openFromCanvas = useLastCallback(async (title: string) => {
    await openTitle(title);
    setKnowledgeView('notes');
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

  const handleSave = useLastCallback((noteId: string, text: string, base?: string) => (
    saveNote(noteId, text, vaultName, base)
  ));
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

  const handleRename = useLastCallback((noteId: string, title: string) => {
    void renameNote(noteId, title, vaultName);
  });

  const handleDelete = useLastCallback((noteId: string) => {
    setOpenId(undefined);
    void deleteNote(noteId);
  });

  // ── граф: панель выбранной точки и правка связей ──

  const plannedByKey = useMemo(() => {
    const map = new Map<string, PlannedItem>();
    [...plannedIndex.byTitle.values(), ...plannedIndex.byNote.values()].forEach((items) => {
      items.forEach((item) => map.set(item.key, item));
    });
    return map;
  }, [plannedIndex]);
  // Заметка выбранной точки; «заметка, которой ещё нет», могла тем временем появиться
  const pickNote = !graphPick || graphPick.kind === 'record' ? undefined
    : graphPick.kind === 'missing' ? findNoteByTitle(graphPick.title, notes)
      : notes.find(({ id }) => id === graphPick.id);
  const pickRecord = graphPick?.kind === 'record' ? plannedByKey.get(graphPick.id) : undefined;
  const pickPlanned = useMemo(() => (
    pickNote ? plannedOf(plannedIndex, pickNote) : []
  ), [plannedIndex, pickNote]);
  // Точка, чья заметка или запись исчезла, панель не держит
  const shownPick = view === 'graph' && status === 'ready' && graphPick
    && (graphPick.kind === 'missing' || pickNote || pickRecord) ? graphPick : undefined;

  const showGraphNotice = useLastCallback((text: string, undo?: NoneToVoidFunction) => {
    setGraphNotice({ text, undo, at: Date.now() });
  });

  const pickNoteInGraph = useLastCallback((noteId?: string) => {
    const note = noteId ? getNotes().find(({ id }) => id === noteId) : undefined;
    if (!note) return;
    setEditRequest(undefined);
    setGraphPick({
      id: note.id, kind: note.isDaily ? 'day' : 'note', title: note.title, group: note.folder,
    });
  });

  // Ссылка в панели графа выбирает точку на графе; заметки ещё нет — создаёт её
  const pickTitleInGraph = useLastCallback(async (title: string) => {
    pickNoteInGraph(await ensureNote(title));
  });

  const handleGraphPick = useLastCallback((node: GraphPick) => {
    setEditRequest(undefined);
    setGraphPick(node);
  });

  const handleGraphOpen = useLastCallback(async (node: GraphPick) => {
    if (node.kind === 'record') return;
    const id = node.kind === 'missing' ? await ensureNote(node.title) : node.id;
    if (!id) return;
    setOpenId(id);
    setKnowledgeView('notes');
  });

  const handleGraphClose = useLastCallback(() => {
    setGraphPick(undefined);
    setLinkFromId(undefined);
    setEditRequest(undefined);
  });

  const handleOpenInNotes = useLastCallback((noteId: string) => {
    setOpenId(noteId);
    setKnowledgeView('notes');
  });

  const handleLinkModeEnd = useLastCallback(() => {
    setLinkFromId(undefined);
  });

  const handleOpenInPlan = useLastCallback((record: PlannedItem) => {
    openOfferInPlan(record.kind, record.day || record.due);
  });

  const handleGraphDelete = useLastCallback((noteId: string) => {
    setGraphPick(undefined);
    if (openId === noteId) setOpenId(undefined);
    void deleteNote(noteId);
  });

  // «Создать холст» на графе: холст из заметок, которые сейчас на нём видны (тот же путь, что «Из графа» на
  // холсте), открывается на вкладке «Холст». Набор заметок записан в холст — «Обновить из графа» берёт новые
  // заметки только из него. Повторное нажатие, пока файл пишется, второго холста не создаёт
  const makeGraphCanvas = useLastCallback(async (scope: GraphCanvasScope) => {
    if (isMakingCanvasRef.current) return;
    const content = canvasFromGraph(notes.map((note) => ({
      id: note.id,
      title: note.title,
      folder: note.folder,
      links: parseNote(note.text).links,
      isDaily: note.isDaily,
    })), { scope });
    if (!content.nodes.length) {
      showGraphNotice(lang('KnowledgeGraphToCanvasEmpty'));
      return;
    }
    isMakingCanvasRef.current = true;
    const title = freeCanvasTitle(lang('KnowledgeCanvasGraphName'), canvases.map((item) => item.title));
    const id = await saveCanvas(title, serializeCanvas(content), vaultName).catch(() => undefined);
    isMakingCanvasRef.current = false;
    if (!id) return;
    setGraphCanvasId(id);
    setKnowledgeView('canvas');
  });

  // Отмена правки связи: текст заметки возвращается, а что в ней изменили после — остаётся (сведение от
  // текста, который дала правка)
  const revertNote = (noteId: string, before: string) => {
    const after = getNotes().find(({ id }) => id === noteId)?.text;
    return () => {
      setGraphNotice(undefined);
      void saveNote(noteId, before, vaultName, after);
    };
  };

  // Связь на графе — ссылка `[[…]]` в тексте заметки-источника: одно сохранение на жест
  const linkInGraph = useLastCallback(async (fromId: string, toTitle: string): Promise<GraphLinkOutcome> => {
    const from = getNotes().find(({ id }) => id === fromId);
    if (!from) return 'failed';
    const names = { from: from.title, to: toTitle.trim() };
    const result = addLinkToText(from.text, toTitle);
    if (result.status === 'refused') showGraphNotice(lang('KnowledgeGraphLinkRefused', { name: names.to }));
    if (result.status === 'exists') showGraphNotice(lang('KnowledgeGraphLinkExists', names));
    if (result.status !== 'added') return result.status;
    if (!(await saveNote(fromId, result.text, vaultName, from.text))) return 'failed';
    showGraphNotice(lang('KnowledgeGraphLinked', names), revertNote(fromId, from.text));
    // На телефоне лист заметки закрыт, пока выбирают цель: после связи остаётся граф
    if (isNarrow && linkFromId) setGraphPick(undefined);
    return 'added';
  });

  // Связь, брошенная на пустое место: заметка с таким названием (новая либо уже существующая) и ссылка на неё
  const linkNewInGraph = useLastCallback(async (fromId: string, title: string) => {
    if (!canLinkTitle(title)) {
      showGraphNotice(lang('KnowledgeGraphLinkRefused', { name: title.trim() }));
      return undefined;
    }
    const id = await ensureNote(title.trim());
    const created = id ? getNotes().find((note) => note.id === id) : undefined;
    if (!created || created.id === fromId) return undefined;
    await linkInGraph(fromId, created.title);
    return created.id;
  });

  // Убрать связь: ссылка отдельной строкой уходит из текста; ссылку внутри предложения граф не трогает —
  // заметка открывается в панели в правке, ссылка выделена
  const unlinkInGraph = useLastCallback(async (fromId: string, toTitle: string) => {
    const from = getNotes().find(({ id }) => id === fromId);
    if (!from) return;
    const names = { from: from.title, to: toTitle };
    const result = removeLinkFromText(from.text, toTitle);
    if (result.status === 'inline') {
      pickNoteInGraph(fromId);
      setEditRequest({
        noteId: fromId, from: result.from, to: result.to, at: Date.now(),
      });
      showGraphNotice(lang('KnowledgeGraphUnlinkInline', names));
      return;
    }
    if (result.status !== 'removed' || !(await saveNote(fromId, result.text, vaultName, from.text))) return;
    showGraphNotice(lang('KnowledgeGraphUnlinked', names), revertNote(fromId, from.text));
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
        <SearchForm>
          <label className={buildClassName(kit.search, styles.listSearch)}>
            <PvIcon name="search" isSmall className={kit.searchIcon} />
            <input
              {...SEARCH_FIELD_PROPS}
              id="knowledge-search"
              className={kit.searchInput}
              value={query}
              placeholder={lang('KnowledgeSearch')}
              aria-label={lang('KnowledgeSearch')}
              onChange={handleQuery}
            />
          </label>
        </SearchForm>
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
            <button
              type="button"
              className={buildClassName(kit.ib, kit.onlyM)}
              aria-label={lang('Search')}
              data-palette-open
              onClick={openPalette}
            >
              <PvIcon name="search" />
            </button>
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
            {view === 'graph' && (
              <span
                className={buildClassName(kit.muted, kit.small, kit.hideM, styles.graphHint)}
                title={lang('KnowledgeGraphHint')}
              >
                {lang('KnowledgeGraphHint')}
              </span>
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
            <NotesGraph
              notes={notes}
              planner={planner}
              pickedId={shownPick && (pickNote?.id || shownPick.id)}
              linkFromId={linkFromId}
              onPick={handleGraphPick}
              onOpen={handleGraphOpen}
              onLink={linkInGraph}
              onLinkNew={linkNewInGraph}
              onUnlink={unlinkInGraph}
              onLinkModeEnd={handleLinkModeEnd}
              onClose={handleGraphClose}
              onMakeCanvas={makeGraphCanvas}
            />
          ) : view === 'canvas' ? (
            <NotesCanvas
              canvases={canvases}
              notes={notes}
              isNarrow={isNarrow}
              openId={graphCanvasId}
              onOpenTitle={openFromCanvas}
            />
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
          {view === 'graph' && graphNotice && (
            <div className={styles.graphNotice} role="status" data-graph-notice>
              <span>{graphNotice.text}</span>
              {graphNotice.undo && (
                <button
                  type="button"
                  className={buildClassName(kit.plain, styles.graphNoticeUndo)}
                  data-graph-undo
                  onClick={graphNotice.undo}
                >
                  <PvIcon name="undo" isSmall />
                  {lang('KnowledgeGraphUndo')}
                </button>
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
      {(isNarrow ? view === 'graph' : Boolean(shownPick)) && (
        <GraphPanel
          // На телефоне лист уходит, пока в режиме «Связать» выбирают цель на графе
          pick={isNarrow && linkFromId ? undefined : shownPick}
          note={pickNote}
          record={pickRecord}
          index={index}
          planner={planner}
          planned={pickPlanned}
          isSheet={isNarrow}
          editRequest={editRequest}
          onClose={handleGraphClose}
          onOpenInNotes={handleOpenInNotes}
          onLinkStart={setLinkFromId}
          onCreate={pickTitleInGraph}
          onOpenInPlan={handleOpenInPlan}
          onOpenTitle={pickTitleInGraph}
          onSave={handleSave}
          onRename={handleRename}
          onDelete={handleGraphDelete}
          onPickFolder={handleAskMove}
        />
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
      {/* «Запланировать» в заметке: окно ввода текстом «Плана» поверх раздела */}
      <PlannerQuickHost />
    </div>
  );
};

export default memo(Knowledge);
