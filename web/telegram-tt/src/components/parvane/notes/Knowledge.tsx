import {
  memo, useEffect, useLayoutEffect, useMemo, useRef, useState,
} from '../../../lib/teact/teact';

import type { GlobalState } from '../../../global/types';
import type { KnowledgeView } from '../../../util/parvaneSection';
import type { FolderRemoval } from './NoteFolderRemoval';
import type { NoteMenuAnchor } from './NoteMenu';
import type { NoteRowKeyAction } from './NoteRowMenu';
import type { GraphCanvasScope } from './notesCanvasGraph';
import type { NotesPlace } from './NotesColumn';
import type { FolderSubmitError } from './notesFolders';
import type { GraphLinkOutcome, GraphPick } from './NotesGraph';
import type { PlannedItem } from './notesPlanned';
import type { NoteEntry } from './notesStore';
import type { NoteEditRequest } from './NoteView';
import type { PvSegmentItem } from './PvSegment';

import buildClassName from '../../../util/buildClassName';
import {
  consumeModuleAddRequest, consumeNoteRequest, getIsParvaneScreenShown, getKnowledgeView, getModuleAddRequest,
  getNoteRequest, getParvaneSection, setKnowledgeView, setParvaneNavCovered, setParvaneSection,
} from '../../../util/parvaneSection';
import { getCloudData, retryCloud, setCloudActive } from '../cloud/cloudStore';
import useCloudOffline from '../cloud/useCloudOffline';
import { toDayKey } from '../planner/plannerModel';
import { getPlannerState, loadPlanner } from '../planner/plannerStore';
import { openOfferInPlan } from '../taskOffer/taskOfferOpen';
import { serializeCanvas } from './notesCanvas';
import { canvasFromGraph, freeCanvasTitle } from './notesCanvasGraph';
import {
  buildNoteGroups, countOutsideRefs, DAILY_GROUP_KEY, folderCaption, isInFolder, ROOT_FOLDER,
} from './notesFolders';
import { buildGuide, findGuideOverview, getGuideLang } from './notesGuide';
import { addLinkToText, canLinkTitle, removeLinkFromText } from './notesLinkEdit';
import { formatNoteEdited } from './notesList';
import { isDayTitle } from './notesLook';
import { parseNote } from './notesModel';
import { buildPlannedIndex, plannedOf } from './notesPlanned';
import { isGuideSeen, markGuideSeen } from './notesPrefs';
import {
  applyPlannerToNotes, consumeGuideOpen, createNote, createNoteFolder, deleteNote, deleteNoteFolder,
  findNoteByTitle, getCanvases, getGuideOpenId, getNoteFolders, getNotes, getNotesIndex, getNotesNotice,
  getNotesStatus, getVaultFolderName, loadNotes, moveNote, openDailyNote, renameNote, renameNoteFolder, restoreGuide,
  retainNotes, saveCanvas, saveNote,
} from './notesStore';

import useSelector from '../../../hooks/data/useSelector';
import useDebouncedCallback from '../../../hooks/useDebouncedCallback';
import useDerivedState from '../../../hooks/useDerivedState';
import useFlag from '../../../hooks/useFlag';
import useLang from '../../../hooks/useLang';
import useLastCallback from '../../../hooks/useLastCallback';
import useWindowSize from '../../../hooks/window/useWindowSize';

import ConfirmDialog from '../../ui/ConfirmDialog';
import SectionHistoryBack from '../SectionHistoryBack';
import GraphPanel from './GraphPanel';
import KnowledgeTabs from './KnowledgeTabs';
import NoteFolderPicker from './NoteFolderPicker';
import NoteFolderRemoval from './NoteFolderRemoval';
import NoteFolderSheet from './NoteFolderSheet';
import NoteLinks from './NoteLinks';
import NoteMissingSheet from './NoteMissingSheet';
import NoteRowMenu from './NoteRowMenu';
import NotesCanvas from './NotesCanvas';
import NotesColumn from './NotesColumn';
import NotesGraph from './NotesGraph';
import NotesList from './NotesList';
import NotesMarkdownHelp from './NotesMarkdownHelp';
import NotesTrash from './NotesTrash';
import NoteView from './NoteView';
import PvHeaderSearch from './PvHeaderSearch';
import PvIcon from './PvIcon';
import PvLoading from './PvLoading';
import PvOfflineBar from './PvOfflineBar';
import PvResizer from './PvResizer';
import PvSegment from './PvSegment';
import PvSkeleton from './PvSkeleton';

import styles from './Knowledge.module.scss';
import kit from './PvKit.module.scss';

// Узкий экран (телефон): виден либо список, либо заметка
const NARROW_WIDTH = 760;
// Пределы ширины панелей, которые меняет пользователь (px)
const NOTES_LIST_MIN = 220;
const NOTES_LIST_MAX = 560;
const NOTES_LINKS_MIN = 200;
const NOTES_LINKS_MAX = 640;
// Широкий экран: «Связи» открытой заметки — отдельная колонка справа (слева от списка — колонка папок)
const SIDE_MIN_WIDTH = 1360;
const NOTICE_HIDE_MS = 6000;
// Пауза между набором в поиске и самим поиском
const SEARCH_DELAY_MS = 150;
const SEARCH_LABELS = {
  notes: 'KnowledgeSearch',
  graph: 'KnowledgeGraphSearch',
  canvas: 'KnowledgeCanvasSearch',
} as const;
// Ctrl+N — новая заметка (доска `ZdNav`, раздел «Заметки»)
const NEW_NOTE_CODE = 'KeyN';
// Виды на компьютере: список и граф кнопками в шапке, холсты — в колонке (доска `ZdNotesX`)
const DESK_VIEWS: KnowledgeView[] = ['notes', 'graph'];
const DAILY_FOLDERS = ['Ежедневные', 'Daily'];
const NOTICE_KEYS = {
  conflict: 'KnowledgeNoticeConflict',
  merged: 'KnowledgeNoticeMerged',
  failed: 'KnowledgeNoticeFailed',
  'folder-files': 'KnowledgeNoticeFolderFiles',
} as const;

// Сообщение о правке связи на графе; `undo` возвращает текст заметки
type GraphNotice = { text: string; at: number; undo?: NoneToVoidFunction };

function selectCurrentUserId(global: GlobalState) {
  return global.currentUserId;
}

// Parvane: модуль «Заметки» — заметки `.md` в зашифрованной папке облака, граф связей и холсты.
// Раскладка — по доскам `Notes`, `PhNotesMore`, `DeskNotes` макета (spec 041 D1)
const Knowledge = () => {
  const notes = useDerivedState(getNotes);
  const folders = useDerivedState(getNoteFolders);
  const canvases = useDerivedState(getCanvases);
  const status = useDerivedState(getNotesStatus);
  const isOffline = useCloudOffline();
  const notice = useDerivedState(getNotesNotice);
  const view = useDerivedState(getKnowledgeView);
  const planner = useDerivedState(getPlannerState);
  const noteRequest = useDerivedState(getNoteRequest);
  const addRequest = useDerivedState(getModuleAddRequest);
  const guideOpenId = useDerivedState(getGuideOpenId);
  const currentUserId = useSelector(selectCurrentUserId);

  const [openId, setOpenId] = useState<string>();
  const [query, setQuery] = useState('');
  // Поиск идёт с задержкой после набора: список не перебирается на каждую букву
  const [searchQuery, setSearchQuery] = useState('');
  // Поиск в шапке ищет по текущей вкладке: у графа и холста свои строки. Enter в поле — следующая находка
  const [graphQuery, setGraphQuery] = useState('');
  const [canvasQuery, setCanvasQuery] = useState('');
  const [searchStep, setSearchStep] = useState(0);
  const [isSearchOpen, openSearch, closeSearch] = useFlag();
  const [isNoticeShown, setIsNoticeShown] = useState(false);
  // Папка, открытая в списке (ключ группы); без неё список показывает папки и недавние заметки
  const [openGroupKey, setOpenGroupKey] = useState<string>();
  const [hasSeenGuide, setHasSeenGuide] = useState(() => isGuideSeen(currentUserId));
  // Шторка папки: правится папка `sheetFolderId`, без неё — создаётся новая
  const [sheetFolderId, setSheetFolderId] = useState<string>();
  const [isFolderSheetOpen, openFolderSheet, closeFolderSheet] = useFlag();
  const [removal, setRemoval] = useState<FolderRemoval>();
  const [movedNoteId, setMovedNoteId] = useState<string>();
  const [isPickerOpen, openPicker, closePicker] = useFlag();
  const [isRestoreOpen, openRestore, closeRestore] = useFlag();
  // Граф: точка, открытая в панели справа, заметка-источник режима «Связать», просьба о правке, сообщение
  const [graphPick, setGraphPick] = useState<GraphPick>();
  // Вкладка, на которой заметку выбрали: панель графа не переезжает на холст и обратно
  const [pickView, setPickView] = useState<KnowledgeView>();
  const [linkFromId, setLinkFromId] = useState<string>();
  const [editRequest, setEditRequest] = useState<NoteEditRequest>();
  const [graphNotice, setGraphNotice] = useState<GraphNotice>();
  // Холст, созданный с графа: вкладка «Холст» открывается на нём
  const [graphCanvasId, setGraphCanvasId] = useState<string>();
  // Ссылка из заметки на заметку, которой ещё нет: шторка с вопросом (доска `RpNotes`)
  const [missingTitle, setMissingTitle] = useState<string>();
  // Компьютер: справка по разметке либо корзина вместо заметок (пункты «Ещё» колонки)
  const [deskScreen, setDeskScreen] = useState<'help' | 'trash'>();
  // «+» на открытом холсте: карточка новой заметки в середине поля
  const [addNoteCard, setAddNoteCard] = useState<{ title: string; at: number }>();
  const isMakingCanvasRef = useRef(false);
  // Человек уже открыл либо создал заметку: «Обзор» справки, дописанной позже, его не перебивает. Окно гонки
  // закономерно: в новом хранилище `createNote` → `ensureFolder` ждёт `guideRun` (папку хранилища создаёт
  // справка), а `createIn` ставит `openId` лишь после ответа `createNote` — справка всегда успевает раньше,
  // и без отметки эффект ниже видел пустой `openId` и открывал «Обзор» поверх создаваемой заметки
  const hasPickedNoteRef = useRef(false);

  const lang = useLang();
  const { width: windowWidth } = useWindowSize();
  const isNarrow = windowWidth <= NARROW_WIDTH;
  const hasSide = windowWidth >= SIDE_MIN_WIDTH;
  const vaultName = lang('KnowledgeVaultName');
  // Подпись хранилища — папка на диске, как она называется у этого аккаунта («Знания» у хранилищ до 21 ноя)
  // Зависимость — сигнал облака: по нему значение пересчитывается
  // eslint-disable-next-line react-hooks-static-deps/exhaustive-deps
  const vaultFolder = useDerivedState(() => getVaultFolderName(), [getCloudData]) || vaultName;
  const [today] = useState(() => toDayKey(new Date()));

  const guideLang = getGuideLang(lang.code);

  // Пока раздел открыт, изменения облака применяются к заметкам сразу; закрыт — при следующем открытии
  // Зависимости — сигналы раздела: по ним значение пересчитывается
  // eslint-disable-next-line react-hooks-static-deps/exhaustive-deps
  const isShown = useDerivedState(() => getIsParvaneScreenShown('notes'), [getParvaneSection]);
  useEffect(() => (isShown ? retainNotes() : undefined), [isShown]);
  // Заметки лежат в облаке: пока раздел на экране, облако опрашивается часто — заметка с другого устройства
  // появляется за секунды, а не через минуту фонового опроса
  useEffect(() => {
    if (!isShown) return undefined;
    setCloudActive(true);
    return () => setCloudActive(false);
  }, [isShown]);

  useEffect(() => {
    void loadNotes(currentUserId, {
      guideLang, vaultName, untitledName: lang('KnowledgeUntitled'), conflictWord: lang('KnowledgeConflictWord'),
    });
    void loadPlanner(currentUserId);
    setHasSeenGuide(isGuideSeen(currentUserId));
  }, [currentUserId, guideLang, vaultName, lang]);

  const markGuide = useLastCallback(() => {
    markGuideSeen(currentUserId);
    setHasSeenGuide(true);
  });

  // «Обзор» справки нового хранилища открывается сам (на узком экране остаётся список с сообщением о ней)
  useEffect(() => {
    if (!guideOpenId || !notes.some(({ id }) => id === guideOpenId)) return;
    consumeGuideOpen();
    if (openId || isNarrow || hasPickedNoteRef.current) return;
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

  // Ссылка в тексте заметки: существующая (и заметка дня) открывается, несуществующая — сначала вопрос
  const askTitle = useLastCallback((title: string) => {
    if (findNoteByTitle(title) || isDayTitle(title)) void openTitle(title);
    else setMissingTitle(title);
  });

  const closeMissing = useLastCallback(() => setMissingTitle(undefined));

  const handleCreateMissing = useLastCallback(async (title: string, folderId?: string) => {
    setMissingTitle(undefined);
    hasPickedNoteRef.current = true;
    const id = await createNote(title, vaultName, { folderId });
    if (id) setOpenId(id);
  });

  // Заметку положили на холст из её меню: вид «Холст» с этим холстом
  const openCanvasFromNote = useLastCallback((canvasId: string) => {
    setGraphCanvasId(canvasId);
    setKnowledgeView('canvas');
  });

  useEffect(() => {
    if (!noteRequest || status !== 'ready') return;
    consumeNoteRequest();
    void openTitle(noteRequest);
  }, [noteRequest, status]);

  const createIn = useLastCallback(async (folderId?: string) => {
    hasPickedNoteRef.current = true;
    const id = await createNote(lang('KnowledgeNewNote'), vaultName, { folderId });
    if (id) setOpenId(id);
  });

  // Новая заметка ложится в папку, открытую в списке, иначе — в папку открытой заметки; из справки и заметок
  // дня — в «Без папки»
  const handleNew = useLastCallback(() => {
    if (openGroupKey !== undefined && openGroupKey !== DAILY_GROUP_KEY && !searchQuery.trim()) {
      void createIn(folders.find(({ path }) => path === openGroupKey)?.id);
      return;
    }
    const isOwnFolder = openNote && !(openNote.isDaily && isDayTitle(openNote.title))
      && openNote.folder !== guideOverview?.folder;
    void createIn(isOwnFolder ? folders.find(({ path }) => path === openNote.folder)?.id : undefined);
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

  // Набранное последним: отложенный поиск по устаревшей строке (поле успели очистить) не применяется
  const queryRef = useRef('');
  const searchSoon = useDebouncedCallback((value: string) => {
    if (value === queryRef.current) setSearchQuery(value);
  }, [], SEARCH_DELAY_MS, true);
  const handleQuery = useLastCallback((value: string) => {
    if (view === 'graph') {
      setGraphQuery(value);
      return;
    }
    if (view === 'canvas') {
      setCanvasQuery(value);
      return;
    }
    setQuery(value);
    queryRef.current = value;
    // Очищенное поле показывает весь список сразу
    if (!value.trim()) setSearchQuery('');
    else searchSoon(value);
  });

  const viewQuery = view === 'graph' ? graphQuery : view === 'canvas' ? canvasQuery : query;
  // Телефон: поле раскрыто лупой либо в нём осталась строка этой вкладки
  const isSearchShown = isSearchOpen || Boolean(viewQuery);

  const handleSearchClose = useLastCallback(() => {
    handleQuery('');
    closeSearch();
  });

  // Щелчок по `#тегу` в заметке — поиск по нему в списке (доска `ZdNotesX`: «тег, ищется по щелчку»)
  const handleTag = useLastCallback((tag: string) => {
    setDeskScreen(undefined);
    if (getKnowledgeView() !== 'notes') setKnowledgeView('notes');
    if (isNarrow) setOpenId(undefined);
    openSearch();
    handleQuery(`#${tag}`);
  });

  const handleSearchEnter = useLastCallback(() => {
    setSearchStep((step) => step + 1);
  });

  // Другая вкладка — поле на телефоне сворачивается (строка вкладки остаётся при ней)
  useEffect(() => {
    closeSearch();
  }, [view, closeSearch]);

  const handlePick = useLastCallback((noteId: string) => {
    hasPickedNoteRef.current = true;
    setOpenId(noteId);
  });

  const handleBack = useLastCallback(() => {
    setOpenId(undefined);
  });

  // Меню строки списка (правая кнопка на компьютере): действия заметки без её открытия (доска `ZdNotesX`)
  const [rowMenu, setRowMenu] = useState<{ id: string; anchor?: NoteMenuAnchor; keyAction?: NoteRowKeyAction }>();
  const closeRowMenu = useLastCallback(() => setRowMenu(undefined));
  const openRowMenu = useLastCallback((id: string, anchor?: NoteMenuAnchor) => setRowMenu({ id, anchor }));
  const handleRowKey = useLastCallback((id: string, keyAction: NoteRowKeyAction) => setRowMenu({ id, keyAction }));

  const handleSave = useLastCallback((noteId: string, text: string, base?: string) => (
    saveNote(noteId, text, vaultName, base)
  ));
  const handleNewFolder = useLastCallback(() => {
    setSheetFolderId(undefined);
    openFolderSheet();
  });

  const handleFolderMenu = useLastCallback((folderId: string) => {
    setSheetFolderId(folderId);
    openFolderSheet();
  });

  // Переименованная папка остаётся открытой в списке: ключ группы — её путь
  const handleFolderSubmit = useLastCallback(async (name: string): Promise<FolderSubmitError | undefined> => {
    if (!sheetFolder) return (await createNoteFolder(name, vaultName)).error;
    const failure = await renameNoteFolder(sheetFolder.id, name, vaultName);
    if (!failure && openGroupKey === sheetFolder.path) {
      setOpenGroupKey([...sheetFolder.path.split('/').slice(0, -1), name].join('/'));
    }
    return failure;
  });

  // Пустая папка удаляется сразу; с заметками — после вопроса: заметки в «Без папки» либо вместе с папкой в корзину
  const handleFolderDelete = useLastCallback(() => {
    closeFolderSheet();
    if (!sheetFolder) return;
    const count = notes.filter((note) => isInFolder(note.folder, sheetFolder.path)).length;
    if (!count) {
      void deleteNoteFolder(sheetFolder.id);
      return;
    }
    setRemoval({
      id: sheetFolder.id,
      name: folderCaption(sheetFolder.path),
      count,
      refs: countOutsideRefs(notes, sheetFolder.path, index.backlinks),
    });
  });

  const closeRemoval = useLastCallback(() => {
    setRemoval(undefined);
  });

  const handleRemovalMove = useLastCallback(() => {
    closeRemoval();
    if (removal) void deleteNoteFolder(removal.id, 'move');
  });

  // Папка уходит в корзину «Файлов» вместе с заметками — их можно вернуть оттуда
  const handleRemovalWithNotes = useLastCallback(() => {
    closeRemoval();
    if (removal) void deleteNoteFolder(removal.id, 'with-notes');
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

  const handleMoveNote = useLastCallback((noteId: string, folderId?: string) => {
    void moveNote(noteId, folderId);
  });

  const handleRename = useLastCallback((noteId: string, title: string) => {
    void renameNote(noteId, title, vaultName);
  });

  // Из меню строки удаляют и не открытую заметку: открытая остаётся
  const handleDelete = useLastCallback((noteId: string) => {
    setOpenId((current) => (current === noteId ? undefined : current));
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
  // Панель заметки стоит рядом с графом и рядом с холстом (там её открывает кнопка карточки)
  const isPanelView = view === 'graph' || view === 'canvas';
  const shownPick = isPanelView && pickView === view && status === 'ready' && graphPick
    && (graphPick.kind === 'missing' || pickNote || pickRecord) ? graphPick : undefined;

  const showGraphNotice = useLastCallback((text: string, undo?: NoneToVoidFunction) => {
    setGraphNotice({ text, undo, at: Date.now() });
  });

  const pickNoteInGraph = useLastCallback((noteId?: string) => {
    const note = noteId ? getNotes().find(({ id }) => id === noteId) : undefined;
    if (!note) return;
    setEditRequest(undefined);
    setPickView(getKnowledgeView());
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
    setPickView(getKnowledgeView());
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
    // С холста заметку увели на вкладку «Заметки» — панель рядом с холстом больше не нужна
    if (getKnowledgeView() === 'canvas') setGraphPick(undefined);
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
    const content = canvasFromGraph(notes.map((note) => {
      const parsed = parseNote(note.text);
      return {
        id: note.id,
        title: note.title,
        folder: note.folder,
        links: parsed.links,
        tags: parsed.tags,
        isDaily: note.isDaily,
      };
    }), { scope });
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

  const noteById = useMemo(() => new Map(notes.map((note) => [note.id, note])), [notes]);
  const found = useMemo(() => (
    searchQuery.trim()
      ? index.search(searchQuery).map((item) => noteById.get(item.id)!).filter(Boolean)
      : undefined
  ), [index, noteById, searchQuery]);

  const isList = view === 'notes';
  const isNoteShown = isList && Boolean(openNote);
  const isNoteAlone = isNarrow && isNoteShown;
  // Открытый холст на телефоне: инструменты внизу вместо ленты модулей (доска `XpNotes`), шапки модуля нет — холст
  // во весь экран; поиск по холсту открывается из меню холста и на это время занимает строку сверху
  const isCanvasOpen = view === 'canvas' && Boolean(graphCanvasId) && canvases.some(({ id }) => id === graphCanvasId);
  const isCanvasAlone = isNarrow && isCanvasOpen;

  // «+» навигации и Ctrl+N: новая заметка там, где стоит человек (README макета): в графе — точка, выбранная в
  // панели, на открытом холсте — карточка в середине поля, иначе — в списке
  const handleAdd = useLastCallback(async () => {
    const current = getKnowledgeView();
    setDeskScreen(undefined);
    if (current === 'graph') {
      hasPickedNoteRef.current = true;
      pickNoteInGraph(await createNote(lang('KnowledgeNewNote'), vaultName));
      return;
    }
    if (current === 'canvas' && isCanvasOpen) {
      const id = await createNote(lang('KnowledgeNewNote'), vaultName);
      const created = id ? getNotes().find((note) => note.id === id) : undefined;
      if (created) setAddNoteCard({ title: created.title, at: Date.now() });
      return;
    }
    if (current !== 'notes') setKnowledgeView('notes');
    handleNew();
  });

  useEffect(() => {
    if (addRequest !== 'note' || status !== 'ready') return;
    consumeModuleAddRequest();
    void handleAdd();
  }, [addRequest, status]);

  // Ctrl+N на показанном модуле — то же, что «+»; при открытом окне не перехватывается.
  // Слушатель ставится до первого кадра (правило экрана)
  const handleNewKey = useLastCallback((e: KeyboardEvent) => {
    if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey || e.code !== NEW_NOTE_CODE) return;
    if (!getIsParvaneScreenShown('notes') || status !== 'ready') return;
    if (document.body.classList.contains('has-open-dialog')) return;
    e.preventDefault();
    void handleAdd();
  });
  useLayoutEffect(() => {
    document.addEventListener('keydown', handleNewKey);
    return () => document.removeEventListener('keydown', handleNewKey);
  }, [handleNewKey]);

  const handleAddClick = useLastCallback(() => {
    void handleAdd();
  });

  // ── компьютер: колонка папок ──

  const groups = useMemo(() => buildNoteGroups({ notes, folders, dailyFolders: DAILY_FOLDERS }), [notes, folders]);
  const deskGroup = groups.find(({ key }) => key === openGroupKey);
  const deskGroupCaption = !deskGroup ? '' : deskGroup.isDaily ? lang('KnowledgeDailyFolder')
    : deskGroup.folder === ROOT_FOLDER ? lang('KnowledgeRoot') : folderCaption(deskGroup.folder);
  const deskPlace: NotesPlace = deskScreen || (view === 'canvas' ? 'canvas' : 'notes');
  const deskViewItems = useMemo((): PvSegmentItem<KnowledgeView>[] => DESK_VIEWS.map((value) => ({
    value, label: lang(value === 'notes' ? 'KnowledgeList' : 'KnowledgeGraph'),
  })), [lang]);

  // Папка либо «Все заметки» в колонке: список этой папки (с холстов, справки и корзины — обратно к заметкам)
  const handleDeskGroup = useLastCallback((key?: string) => {
    setDeskScreen(undefined);
    setOpenGroupKey(key);
    if (getKnowledgeView() === 'canvas') setKnowledgeView('notes');
  });

  const handleDeskPlace = useLastCallback((next: NotesPlace) => {
    if (next === 'help' || next === 'trash') {
      setDeskScreen(next);
      return;
    }
    // «Холсты» на открытом холсте — к списку холстов; из других мест — к холсту, открытому там раньше
    if (next === 'canvas' && getKnowledgeView() === 'canvas' && !deskScreen) setGraphCanvasId(undefined);
    setDeskScreen(undefined);
    setKnowledgeView(next === 'canvas' ? 'canvas' : 'notes');
  });

  const handleDeskFolderMenu = useLastCallback((e: React.MouseEvent<HTMLButtonElement>) => {
    handleFolderMenu(e.currentTarget.dataset.folderId!);
  });
  // Правка заметки: колонка «Связи» убрана, место — редактору и просмотру
  const [isNoteEditing, setIsNoteEditing] = useState(false);
  const isGuideNew = Boolean(guideOverview) && !hasSeenGuide && !found;

  // Заметка на весь экран телефона: ленты модулей и «+» под ней нет
  const isNavCovered = isShown && (isNoteAlone || isCanvasAlone);
  useEffect(() => {
    setParvaneNavCovered(isNavCovered);
    return () => setParvaneNavCovered(false);
  }, [isNavCovered]);
  const [now] = useState(() => Date.now());

  // Системное «назад»: открытая на телефоне заметка — к списку, открытый холст — к списку холстов, открытая
  // папка — к папкам, панель рядом с графом (на компьютере; на телефоне это шторка со своей записью) — закрыть,
  // иначе — к чатам
  const isPanelLevel = !isNarrow && Boolean(shownPick);
  const isGroupLevel = isList && openGroupKey !== undefined && !found;
  const handleHistoryBack = useLastCallback(() => {
    if (isSearchShown && !isNoteAlone) {
      handleSearchClose();
    } else if (isNoteAlone) {
      handleBack();
    } else if (isCanvasOpen) {
      setGraphCanvasId(undefined);
    } else if (isGroupLevel && isNarrow) {
      setOpenGroupKey(undefined);
    } else if (isPanelLevel) {
      handleGraphClose();
    } else if (deskScreen && !isNarrow) {
      setDeskScreen(undefined);
    } else {
      setParvaneSection('messenger');
      return false;
    }
    return true;
  });

  function renderSearch() {
    return (
      <PvHeaderSearch
        value={viewQuery}
        label={lang(view === 'canvas' && !isCanvasOpen ? 'KnowledgeCanvasListSearch' : SEARCH_LABELS[view])}
        id={view === 'notes' ? 'knowledge-search' : undefined}
        isOpen={isSearchShown}
        onOpen={openSearch}
        onClose={handleSearchClose}
        onChange={handleQuery}
        onEnter={handleSearchEnter}
      />
    );
  }

  function renderList(deskLayout?: 'table' | 'column') {
    return (
      <NotesList
        notes={notes}
        folders={folders}
        index={index}
        plannedIndex={plannedIndex}
        today={today}
        found={found}
        openId={isNarrow ? undefined : openId}
        openGroupKey={openGroupKey}
        vaultName={vaultFolder}
        guideNoticeFolder={isGuideNew ? guideFolderName : undefined}
        hasGuide={Boolean(guideOverview)}
        isNarrow={isNarrow}
        deskLayout={deskLayout}
        onPick={handlePick}
        onOpenGroup={setOpenGroupKey}
        onFolderMenu={handleFolderMenu}
        onNewInFolder={createIn}
        onMoveNote={handleMoveNote}
        onNoteMenu={openRowMenu}
        onNoteKey={handleRowKey}
        onGuide={handleGuide}
        onGuideDismiss={markGuide}
      />
    );
  }

  function renderNote(note: NoteEntry) {
    return (
      <NoteView
        note={note}
        index={index}
        planner={planner}
        planned={openPlanned}
        layout={isNarrow ? 'screen' : 'pane'}
        hasLinks={isNarrow || !hasSide}
        onBack={isNarrow ? handleBack : undefined}
        onOpenTitle={askTitle}
        onSave={handleSave}
        onRename={handleRename}
        onDelete={handleDelete}
        onPickFolder={handleAskMove}
        onEditingChange={setIsNoteEditing}
        onOpenCanvas={openCanvasFromNote}
        onTag={handleTag}
      />
    );
  }

  // Телефон: шапка с названием модуля, под ней — виды; открытая заметка занимает весь экран со своей шапкой
  function renderPhone() {
    return (
      <div className={styles.page}>
        {isCanvasAlone && isSearchShown && (
          <header className={styles.head} data-canvas-search-row>
            <div className={styles.headRow}>{renderSearch()}</div>
          </header>
        )}
        {!isNoteAlone && !isCanvasAlone && (
          <header className={styles.head}>
            <div className={styles.headRow}>
              {!isSearchShown && <h1 className={styles.headTitle}>{lang('ParvaneModuleNotes')}</h1>}
              {renderSearch()}
              {isList && !isSearchShown && (
                <button
                  type="button"
                  className={kit.ib}
                  aria-label={lang('KnowledgeNewFolder')}
                  title={lang('KnowledgeNewFolder')}
                  data-notes-new-folder
                  onClick={handleNewFolder}
                >
                  <PvIcon name="folderNew" />
                </button>
              )}
            </div>
            <div className={styles.viewRow}>
              <KnowledgeTabs className={styles.viewTabs} />
            </div>
          </header>
        )}
        {renderNotice()}
        <div className={styles.content}>
          {status !== 'ready'
            ? (isList ? <PvSkeleton onRetry={retryCloud} /> : <PvLoading onRetry={retryCloud} />)
            : isList ? (openNote ? renderNote(openNote) : renderList()) : renderBoard()}
          {renderGraphNotice()}
        </div>
      </div>
    );
  }

  // Компьютер (доска `ZdNotesX`): колонка «Папки / Ещё» слева; справа — заметки папки таблицей, открытая заметка
  // рядом с колонкой списка и «Связями», граф либо холсты, справка по разметке, корзина
  function renderDesktop() {
    return (
      <>
        <NotesColumn
          groups={groups}
          total={notes.length}
          canvasCount={canvases.length}
          place={deskPlace}
          openGroupKey={openGroupKey}
          onOpenGroup={handleDeskGroup}
          onPlace={handleDeskPlace}
          onNewFolder={handleNewFolder}
          onFolderMenu={handleFolderMenu}
          onMoveNote={handleMoveNote}
        />
        <div className={styles.page}>
          {deskScreen === 'help' ? <NotesMarkdownHelp isScreen />
            : deskScreen === 'trash' ? <NotesTrash />
              : view === 'canvas' ? renderDesktopCanvas() : renderDesktopNotes()}
        </div>
      </>
    );
  }

  // Шапка списка и графа: папка и число заметок, поиск, «Список / Граф», «Новая заметка»
  function renderDeskHead() {
    const caption = deskGroup ? deskGroupCaption : lang('KnowledgeAllNotes');
    const count = deskGroup ? deskGroup.items.length : notes.length;
    return (
      <header className={buildClassName(styles.head, styles.headBoard)} data-notes-desk-head>
        <div className={styles.deskTitle}>
          <h1 className={styles.headTitle}>{caption}</h1>
          <span className={styles.deskCount}>
            {lang('KnowledgeNotesCount', { count }, { pluralValue: count })}
          </span>
        </div>
        {deskGroup?.folderId && (
          <button
            type="button"
            className={kit.ib}
            aria-label={lang('KnowledgeFolderActions', { name: deskGroupCaption })}
            title={lang('KnowledgeFolderActions', { name: deskGroupCaption })}
            data-folder-menu
            data-folder-id={deskGroup.folderId}
            onClick={handleDeskFolderMenu}
          >
            <PvIcon name="dots" />
          </button>
        )}
        {view === 'graph' && (
          <span className={styles.headHint} title={lang('KnowledgeGraphHint')}>{lang('KnowledgeGraphHint')}</span>
        )}
        <div className={styles.searchRow}>{renderSearch()}</div>
        <PvSegment
          className={styles.deskViews}
          items={deskViewItems}
          value={view}
          label={lang('KnowledgeViewLabel')}
          isTabs
          onChange={setKnowledgeView}
        />
        <button
          type="button"
          className={buildClassName(kit.btn, kit.btnAcc, styles.deskNew)}
          data-notes-new
          onClick={handleAddClick}
        >
          {lang('KnowledgeNewNote')}
        </button>
      </header>
    );
  }

  function renderDesktopNotes() {
    const isNoteOpen = view === 'notes' && status === 'ready' && Boolean(openNote);
    return (
      <>
        {renderDeskHead()}
        {renderNotice()}
        <div className={styles.deskBody}>
          {status !== 'ready' ? (
            view === 'notes' ? <PvSkeleton onRetry={retryCloud} /> : <PvLoading onRetry={retryCloud} />
          ) : view === 'graph' ? (
            <div className={styles.content}>
              {renderBoard()}
              {renderGraphNotice()}
            </div>
          ) : !isNoteOpen ? renderList('table') : (
            <>
              <aside className={styles.listPane}>{renderList('column')}</aside>
              <PvResizer
                panel="notes-list"
                edge="end"
                target="previous"
                min={NOTES_LIST_MIN}
                max={NOTES_LIST_MAX}
                className={styles.listResizer}
              />
              <div className={styles.page}>
                <div className={styles.content}>{renderNote(openNote)}</div>
              </div>
              {hasSide && !isNoteEditing && (
                <aside className={styles.side} aria-label={lang('KnowledgeLinks')}>
                  <PvResizer panel="notes-links" edge="start" min={NOTES_LINKS_MIN} max={NOTES_LINKS_MAX} />
                  <div className={buildClassName(styles.sideContent, 'custom-scroll')}>
                    <NoteLinks note={openNote} index={index} planned={openPlanned} onOpenTitle={openTitle} />
                  </div>
                  <div className={styles.sideFoot}>
                    {lang('KnowledgeEdited', { when: formatNoteEdited(lang, openNote.updatedAt, now) })}
                  </div>
                </aside>
              )}
            </>
          )}
        </div>
      </>
    );
  }

  // Холсты: список холстов со своей шапкой либо открытый холст со своей (доски `XdNotes`, `ZdNotesX`). Над ними —
  // только поле поиска (решение пользователя: полоса с поиском над графом и холстом остаётся), без подсказки
  function renderDesktopCanvas() {
    return (
      <>
        <header className={buildClassName(styles.head, styles.headBoard)} data-notes-canvas-head>
          <div className={styles.searchRow}>{renderSearch()}</div>
        </header>
        {renderNotice()}
        <div className={styles.content}>
          {status !== 'ready' ? <PvLoading onRetry={retryCloud} /> : renderBoard()}
        </div>
      </>
    );
  }

  function renderBoard() {
    return view === 'graph' ? (
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
        query={graphQuery}
        searchStep={searchStep}
        isNarrow={isNarrow}
      />
    ) : (
      <NotesCanvas
        canvases={canvases}
        notes={notes}
        isNarrow={isNarrow}
        openId={graphCanvasId}
        onOpenTitle={pickTitleInGraph}
        onOpenCanvas={setGraphCanvasId}
        addNoteCard={addNoteCard}
        query={canvasQuery}
        searchStep={searchStep}
        onSearch={openSearch}
      />
    );
  }

  function renderNotice() {
    return (
      <>
        {isOffline && <PvOfflineBar text={lang('PvOfflineNotes')} onRetry={retryCloud} />}
        {isNoticeShown && notice && (
          <div className={styles.notice} role="status">
            {notice.code === 'guide-failed' ? lang('KnowledgeNoticeGuideFailed')
              : lang(NOTICE_KEYS[notice.code], { name: notice.title })}
          </div>
        )}
      </>
    );
  }

  function renderGraphNotice() {
    if (view !== 'graph' || !graphNotice) return undefined;
    return (
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
    );
  }

  return (
    <div id="ParvaneKnowledge" className={styles.root} data-knowledge-view={view} data-status={status}>
      {isShown && (
        <SectionHistoryBack onBack={handleHistoryBack} />
      )}
      {isNarrow ? renderPhone() : renderDesktop()}
      {(isNarrow ? isPanelView : Boolean(shownPick)) && (
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
          onLinkStart={view === 'graph' ? setLinkFromId : undefined}
          onLinkTitle={view === 'graph' ? linkNewInGraph : undefined}
          onUnlink={view === 'graph' ? unlinkInGraph : undefined}
          onCreate={pickTitleInGraph}
          onOpenInPlan={handleOpenInPlan}
          onOpenTitle={pickTitleInGraph}
          onSave={handleSave}
          onRename={handleRename}
          onDelete={handleGraphDelete}
          onPickFolder={handleAskMove}
        />
      )}
      <NoteRowMenu
        note={rowMenu ? notes.find(({ id }) => id === rowMenu.id) : undefined}
        anchor={rowMenu?.anchor}
        keyAction={rowMenu?.keyAction}
        onOpen={handlePick}
        onOpenCanvas={openCanvasFromNote}
        onRename={handleRename}
        onPickFolder={handleAskMove}
        onDelete={handleDelete}
        onClose={closeRowMenu}
      />
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
        isNarrow={isNarrow}
        notes={notes}
        currentPath={movedNote?.folder || ROOT_FOLDER}
        folders={folders}
        onPick={handleMove}
        onCreate={handleMoveToNew}
        onClose={closePicker}
      />
      <NoteMissingSheet
        title={missingTitle}
        index={index}
        folders={folders}
        folderId={openNote && folders.find(({ path }) => path === openNote.folder)?.id}
        onCreate={handleCreateMissing}
        onClose={closeMissing}
      />
      <NoteFolderRemoval
        removal={removal}
        folder={removal && folders.find(({ id }) => id === removal.id)}
        onRename={handleFolderSubmit}
        onMove={handleRemovalMove}
        onDeleteAll={handleRemovalWithNotes}
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
