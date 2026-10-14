import {
  memo, useEffect, useMemo, useRef, useState,
} from '../../../lib/teact/teact';
import { getActions } from '../../../global';

import type { CloudNode } from '../cloud/cloudModel';
import type { BoardRect, BoardView } from './boardView';
import type { CanvasCommand, CanvasMenuItem } from './CanvasContextMenu';
import type {
  CanvasDoc, CanvasEdge, CanvasNode, CanvasPoint, CanvasRect, CanvasSide,
} from './notesCanvas';
import type { CanvasAlign, CanvasGuide } from './notesCanvasAlign';
import type { CanvasCurve, CanvasHandle, CanvasSelection } from './notesCanvasEdit';
import type { CanvasImageQuality } from './notesCanvasImages';
import type { CanvasInlineKind, NoteCardPart, NoteCardState } from './notesCanvasNote';
import type { CanvasEntry, NoteEntry } from './notesStore';

import { requestMeasure, requestMutation } from '../../../lib/fasterdom/fasterdom';
import buildClassName from '../../../util/buildClassName';
import captureEscKeyListener from '../../../util/captureEscKeyListener';
import { getIsParvaneScreenShown } from '../../../util/parvaneSection';
import { debounce } from '../../../util/schedulers';
import { downloadCloudNode, getCloudData, getNodes } from '../cloud/cloudStore';
import {
  BOARD_ZOOM_STEP, boardBackgroundStyle, clampBoardScale, createPinch, fitRects, revealRects, zoomAround,
  zoomByWheel,
} from './boardView';
import {
  addEdge, addNode, CANVAS_DEFAULT_NODE_HEIGHT, CANVAS_DEFAULT_NODE_WIDTH, CANVAS_PRESET_COLORS, CANVAS_SIDES,
  createEmptyCanvas, findNode, newCanvasId, nodesInGroup, parseCanvas, removeEdge,
  removeNode, serializeCanvas, sidePoint, updateEdge, updateNode,
} from './notesCanvas';
import {
  alignNodes, CANVAS_SNAP_DISTANCE, distributeNodes, snapResize, snapToNeighbours,
} from './notesCanvasAlign';
import {
  CANVAS_COPY_SHIFT, CANVAS_EMPTY_SELECTION, CANVAS_GRID,
  CANVAS_NUDGE_BIG, canvasShortcut, clipBounds, colorOfSelection, connectNodes, copyNodes,
  curveBetween, curvePoint, edgeAt, edgeCurve, fitGroupToContent, growGroups, isSelectionEmpty, minSizeOf,
  moveNodes, nearestSide, nextEdgeEnds, nodeAtPoint, nodesInRect, normalizeCanvasUrl, oppositeSide, parsePasted,
  pasteClip, placeNode, pruneSelection, recolorSelection, rectOfPoints, removeSelection, reorderNodes,
  resizeRect, selectAll, selectionBounds, serializeClip, snapDelta, snapTo, toggleSelected, wrapInGroup,
} from './notesCanvasEdit';
import { noteTitleOfPath, resolveDrivePath } from './notesCanvasFiles';
import {
  canvasFromGraph, findFreeSpot, freeCanvasTitle, GRAPH_NOTE_FIELD, refreshCanvasFromGraph, renameCanvasNote,
} from './notesCanvasGraph';
import {
  createHistory, dropStep, mapHistory, recordStep, redoStep, undoStep,
} from './notesCanvasHistory';
import { CANVAS_FULL_IMAGE_MIN_PX, isCanvasImage } from './notesCanvasImages';
import { arrowPath, CANVAS_TONES, curvePath } from './notesCanvasLook';
import {
  droppedCardPlace, inlineKeyAction, nextNoteTitle, NOTE_TITLE_MAX, noteCardAction, relinkNoteCards,
} from './notesCanvasNote';
import { pressAction } from './notesCanvasPress';
import { folderColor, isDayTitle } from './notesLook';
import { parseNote } from './notesModel';
import { readCanvasImageQuality, writeCanvasImageQuality } from './notesPrefs';
import {
  createNote, deleteCanvas, freeNoteTitle, getNotes, getNotesStatus, renameCanvas, renameNote, saveCanvas,
  saveNoteOrRestore,
} from './notesStore';

import useDerivedState from '../../../hooks/useDerivedState';
import useFlag from '../../../hooks/useFlag';
import useLang from '../../../hooks/useLang';
import useLastCallback from '../../../hooks/useLastCallback';

import ConfirmDialog from '../../ui/ConfirmDialog';
import CloudPreview from '../cloud/CloudPreview';
import CanvasCard from './CanvasCard';
import CanvasContextMenu from './CanvasContextMenu';
import CanvasEdgeView from './CanvasEdgeView';
import CanvasFilePicker from './CanvasFilePicker';
import CanvasSelectionBar from './CanvasSelectionBar';
import PvIcon from './PvIcon';
import PvSheet from './PvSheet';

import styles from './Knowledge.module.scss';
import kit from './PvKit.module.scss';

type OwnProps = {
  canvases: CanvasEntry[];
  notes: NoteEntry[];
  isNarrow: boolean;
  // Холст, на котором открыть вкладку (созданный с графа); нет такого — первый
  openId?: string;
  // Поиск из шапки раздела: найденные карточки подсвечены, к первой холст едет сам; рост `searchStep`
  // (Enter в поле) — к следующей
  query: string;
  searchStep: number;
  onOpenTitle: (title: string) => void;
};

// Жест на поле от нажатия до отпускания. Сдвиг и размер до отпускания живут в `live` — документ, история и
// запись в облако меняются один раз, когда жест закончен
type Gesture =
  | { kind: 'pan'; x: number; y: number; hasMoved: boolean; tapKey?: string }
  | {
    kind: 'move'; lead: string; ids: string[]; origin: CanvasPoint; base: CanvasDoc; others: CanvasRect[];
    bounds: CanvasRect; hasMoved: boolean; collapseTo?: string; tapKey?: string;
  }
  | {
    kind: 'resize'; id: string; handle: CanvasHandle; origin: CanvasPoint; base: CanvasDoc; others: CanvasRect[];
    hasMoved: boolean;
  }
  | { kind: 'marquee'; origin: CanvasPoint; base: CanvasSelection; hasMoved: boolean }
  | { kind: 'edge'; from: string; side: CanvasSide; hasMoved: boolean };
type Live = { doc: CanvasDoc; guides: CanvasGuide[] };
// Правка в шторке: текст карточки (название группы, подпись связи), цвет, подписи связей карточки
type Editing = { text: string; color: string; labels: Record<string, string>; removed: string[] };
// Правка на месте: текст карточки, название группы либо подпись стрелки прямо на холсте. `isNew` — узел
// только что добавлен: оставленный пустым (или отменённый) текст убирает карточку. `isAuto` — высота
// текстовой карточки шла по тексту и после правки снова пойдёт по нему. У карточки заметки правятся текст
// (`note`) и название (`title`) самой заметки: `noteId` — заметка, `base` — то, с чего правка начата
type Inline = {
  id: string; kind: CanvasInlineKind; isNew: boolean; isAuto: boolean; noteId?: string; base?: string;
  // Название заметки на начало правки текста: под ним она создаётся заново, если её за это время удалили
  noteTitle?: string;
};
// Начало стрелки, брошенной на пустом месте: карточка, которую там создадут, будет связана с этой
type EdgeStart = { id: string; side: CanvasSide };
type Pending = { id: string; title: string; doc: CanvasDoc; since: number };
type InlineField = HTMLTextAreaElement | HTMLInputElement;
// `drop` — меню стрелки, брошенной на пустом месте: что создать на её конце
type Menu = { x: number; y: number; point: CanvasPoint; kind: 'selection' | 'board' | 'drop'; from?: EdgeStart };
// Название новой заметки: карточка встанет в точку `at`, а со стрелкой `from` — у её конца
type NoteDraft = { title: string; at?: CanvasPoint; from?: EdgeStart };
type LinkDraft = { id?: string; url: string; at?: CanvasPoint };
type Tap = { key: string; at: number; x: number; y: number };

// Запись холста в облако: через паузу после последней правки, но не позже потолка от первой несохранённой
const SAVE_DELAY_MS = 4000;
const SAVE_MAX_WAIT_MS = 15000;
const GROUP_WIDTH = 420;
const GROUP_HEIGHT = 280;
const NOTE_HEIGHT = 140;
// Пока правится текст заметки, карточка растёт за ним до этой высоты поля; дальше текст листается
const LINK_WIDTH = 300;
const LINK_HEIGHT = 160;
const FILE_HEIGHT = 200;
// Новая карточка встаёт правее и ниже прежних, а не поверх них
const NEW_OFFSET_X = 280;
const NEW_OFFSET_Y = 40;
const NEW_COLUMNS = 3;
const DRAG_THRESHOLD = 3;
// Место под панель инструментов сверху (на телефоне она в два ряда) и под название группы над рамкой
const FIT_TOP = 64;
const FIT_TOP_NARROW = 112;
const FIT_BOTTOM = 20;
const GROUP_LABEL_ROOM = 40;
// Стрелка выбирается нажатием не дальше этого от линии (в точках экрана): пальцем — шире, чем мышью
const EDGE_HIT = 8;
const EDGE_HIT_TOUCH = 18;
const NODE_NAME_MAX = 24;
const CANVAS_TITLE_MAX = 80;
const DOUBLE_TAP_MS = 350;
const DOUBLE_TAP_DISTANCE = 30;
const LONG_PRESS_MS = 550;
// `dblclick`, который браузер присылает следом за уже обработанным двойным тапом, — то же действие
const TAP_ECHO_MS = 500;
// Высота карточки идёт по тексту, пока под текстом нет свободного места больше этого
const AUTO_SLACK = 4;
const BAR_GAP = 12;
const BAR_HEIGHT = 44;
const PREVIEW_MAX_BYTES = 256 * 1024 * 1024;
const PREVIEW_MAX_BYTES_NARROW = 64 * 1024 * 1024;
const INLINE_SELECTOR = '[data-canvas-inline]';
const PASSIVE_SELECTOR = `[data-board-tools], ${INLINE_SELECTOR}, [data-canvas-open], [data-canvas-open-note]`;
const NOTE_HEAD_SELECTOR = '[data-canvas-note-head]';
const TAP_BOARD = 'board';
// Найденная карточка показывается не мельче этого масштаба; холст едет к ней после паузы в наборе
const FOUND_MIN_SCALE = 0.8;
const FOUND_DELAY_MS = 400;
const IMAGE_QUALITIES: CanvasImageQuality[] = ['full', 'thumb'];
// Последнее скопированное на холсте — запасной путь для «Вставить» из меню, когда буфер обмена браузера
// прочитать нельзя
let lastClipText = '';

// Сдвиг и масштаб поля; `--inv` — обратный масштаб для ручек и точек стрелок, которые не мельчают при отдалении
function worldStyle(view: BoardView) {
  return `transform: translate(${view.x}px, ${view.y}px) scale(${view.scale}); --inv: ${1 / view.scale}`;
}

function isTypingElement(element: Element | undefined) {
  if (!(element instanceof HTMLElement)) return false;
  return element.tagName === 'INPUT' || element.tagName === 'TEXTAREA' || element.tagName === 'SELECT'
    || element.isContentEditable;
}

// Холст (JSON Canvas): карточки заметок, файлов и ссылок, текстовые карточки, группы и стрелки с подписями.
// Файл `.canvas` лежит в папке «Знания»; правки сохраняются сами через паузу
const NotesCanvas = ({
  canvases: allCanvases, notes, isNarrow, openId, query, searchStep, onOpenTitle,
}: OwnProps) => {
  const { showNotification } = getActions();
  const boardRef = useRef<HTMLDivElement>();
  // Холст, отправленный в корзину, пропадает с экрана сразу, не дожидаясь ответа облака
  const [removedIds, setRemovedIds] = useState<string[]>([]);
  const canvases = useMemo(() => (
    removedIds.length ? allCanvases.filter(({ id }) => !removedIds.includes(id)) : allCanvases
  ), [allCanvases, removedIds]);
  const [canvasId, setCanvasId] = useState<string | undefined>(openId || canvases[0]?.id);
  const [doc, setDoc] = useState<CanvasDoc>(createEmptyCanvas);
  const [live, setLive] = useState<Live>();
  const [isDamaged, setIsDamaged] = useState(false);
  // Вид поля: закреплённый — состоянием (от него зависят панель выделенного и порог картинок), живой — в
  // ссылке. Во время жеста меняется только живой и пишется прямо в DOM; состояние догоняет при отпускании
  const [view, setView] = useState<BoardView>({ scale: 1, x: 0, y: 0 });
  const viewRef = useRef<BoardView>(view);
  const worldRef = useRef<HTMLDivElement>();
  const [selection, setSelection] = useState<CanvasSelection>(CANVAS_EMPTY_SELECTION);
  const [marquee, setMarquee] = useState<CanvasRect>();
  const [draft, setDraft] = useState<CanvasCurve>();
  const [linkFrom, setLinkFrom] = useState<string>();
  const [isSelectMode, setIsSelectMode] = useState(false);
  const [editing, setEditing] = useState<Editing>();
  const [menu, setMenu] = useState<Menu>();
  const [linkDraft, setLinkDraft] = useState<LinkDraft>();
  const [filePreview, setFilePreview] = useState<{ container: string; node: CloudNode }>();
  const [isPickingNote, setIsPickingNote] = useState(false);
  const [noteDraft, setNoteDraft] = useState<NoteDraft>();
  const [imageQuality, setImageQuality] = useState<CanvasImageQuality>(readCanvasImageQuality);
  const [isPickingFile, openFilePicker, closeFilePicker] = useFlag();
  const [inline, setInline] = useState<Inline>();
  const [inlineText, setInlineText] = useState('');
  const [isMenuOpen, openMenu, closeMenu] = useFlag();
  const [isDeleteOpen, openDelete, closeDelete] = useFlag();
  const [canvasName, setCanvasName] = useState('');
  const [canUndo, setCanUndo] = useState(false);
  const [canRedo, setCanRedo] = useState(false);
  // Текст заметки, отправленный на запись: карточка показывает его, не дожидаясь ответа облака
  const [savingNote, setSavingNote] = useState<{ noteId: string; text: string }>();
  // Переименование заметки с холста: карточки уже несут новое название, заметка — пока прежнее
  const [renaming, setRenaming] = useState<{ from: string; to: string }>();
  // Группа под указателем: её возьмёт перетаскивание
  const [hoverGroup, setHoverGroup] = useState<string>();
  const gestureRef = useRef<Gesture>();
  const liveRef = useRef<Live>();
  const pinchRef = useRef(createPinch());
  const saveTimerRef = useRef<number>();
  const pressTimerRef = useRef<number>();
  const loadedRef = useRef<string>();
  // Текст файла, который холст уже знает: прочитанный при открытии либо отправленный на запись. Иной текст
  // того же файла пришёл снаружи (правка с другого устройства)
  const knownTextRef = useRef<string>();
  const isCreatingRef = useRef(false);
  // Последний документ: две правки подряд в одном событии (сохранить текст, затем добавить карточку)
  // обе идут от него, а не от снимка прошлой отрисовки
  const docRef = useRef(doc);
  const selectionRef = useRef(selection);
  const historyRef = useRef(createHistory());
  const pendingRef = useRef<Pending>();
  const inlineRef = useRef<Inline>();
  const tapRef = useRef<Tap>();
  const tapActivatedAtRef = useRef(0);
  const pointerRef = useRef<{ x: number; y: number }>();
  const isSpaceDownRef = useRef(false);
  // Точка, выбранная в меню пустого места: туда встанет заметка, файл либо ссылка после выбора в шторке
  const insertAtRef = useRef<CanvasPoint>();
  // Стрелка, от конца которой выбирают заметку в шторке
  const insertFromRef = useRef<EdgeStart>();
  const isCreatingNoteRef = useRef(false);

  const lang = useLang();
  const cloud = useDerivedState(getCloudData);
  const notesStatus = useDerivedState(getNotesStatus);
  const driveId = cloud?.rootId;
  const driveNodes = useMemo(() => (driveId ? getNodes(driveId, cloud) : []), [cloud, driveId]);
  const vaultName = lang('KnowledgeVaultName');
  const entry = canvases.find(({ id }) => id === canvasId) || canvases[0];
  const entryId = entry?.id;
  const entryText = entry?.text;
  const shown = live?.doc || doc;
  const shownById = useMemo(() => new Map(shown.nodes.map((node) => [node.id, node])), [shown]);

  const viewport = () => {
    const box = boardRef.current?.getBoundingClientRect();
    return { width: box?.width || 800, height: box?.height || 600 };
  };

  // Новый вид: в живую ссылку и сразу в DOM (поле и фон); `isFinal` закрепляет его состоянием
  const applyView = (next: BoardView, isFinal: boolean) => {
    viewRef.current = next;
    if (isFinal) {
      setView(next);
      return;
    }
    requestMutation(() => {
      if (viewRef.current !== next) return;
      const world = worldRef.current;
      const board = boardRef.current;
      if (world) world.style.cssText = worldStyle(next);
      if (board) board.style.cssText = boardBackgroundStyle(next);
    });
  };
  const commitView = useLastCallback(() => setView(viewRef.current));
  // Колесо: вид едет сразу, состояние закрепляется, когда колесо остановилось
  const commitViewSoon = useMemo(() => debounce(commitView, 120, false), [commitView]);

  // Вид, в котором видно всё (на телефоне — крупно первая группа со своим содержимым)
  const fitTo = useLastCallback((target: CanvasDoc) => {
    const group = isNarrow ? target.nodes.find(({ type }) => type === 'group') : undefined;
    const fitted = group ? [group, ...nodesInGroup(target, group.id)] : target.nodes;
    const size = viewport();
    return fitRects(
      fitted.map((node) => (node.type === 'group' ? {
        x: node.x, y: node.y - GROUP_LABEL_ROOM, width: node.width, height: node.height + GROUP_LABEL_ROOM,
      } : node)),
      size.width,
      size.height,
      isNarrow ? FIT_TOP_NARROW : FIT_TOP,
      FIT_BOTTOM,
    );
  });

  const select = (next: CanvasSelection) => {
    selectionRef.current = next;
    setSelection(next);
  };

  const selectNodes = (ids: string[]) => select({ nodes: ids, edges: [] });

  const syncHistory = () => {
    setCanUndo(Boolean(historyRef.current.past.length));
    setCanRedo(Boolean(historyRef.current.future.length));
  };

  const dropGesture = () => {
    window.clearTimeout(pressTimerRef.current);
    gestureRef.current = undefined;
    liveRef.current = undefined;
    setLive(undefined);
    setMarquee(undefined);
    setDraft(undefined);
  };

  // Документ с диска (или пришедший снаружи) заменяет открытый: история правок начинается заново
  const loadDoc = (text: string) => {
    const parsed = parseCanvas(text);
    knownTextRef.current = text;
    // Несохранённый текст заметки к файлу холста не относится: он сохраняется, а не пропадает с документом
    if (inlineRef.current?.kind === 'note') finishInline();
    docRef.current = parsed.doc;
    inlineRef.current = undefined;
    historyRef.current = createHistory();
    dropGesture();
    setDoc(parsed.doc);
    setInline(undefined);
    setIsDamaged(Boolean(parsed.error));
    setLinkFrom(undefined);
    setMenu(undefined);
    syncHistory();
    return parsed.doc;
  };

  // Открытие холста и замена его содержимого снаружи
  useEffect(() => {
    if (!entryId || entryText === undefined) return;
    if (loadedRef.current !== entryId) {
      loadedRef.current = entryId;
      select(CANVAS_EMPTY_SELECTION);
      applyView(fitTo(loadDoc(entryText)), true);
      return;
    }
    if (entryText === knownTextRef.current) return;
    knownTextRef.current = entryText;
    // Своя несохранённая правка новее пришедшего текста; текст, равный открытому документу, — эхо своей записи
    if (pendingRef.current || entryText === serializeCanvas(docRef.current)) return;
    select(pruneSelection(loadDoc(entryText), selectionRef.current));
    // eslint-disable-next-line react-hooks-static-deps/exhaustive-deps
  }, [entryId, entryText]);

  // Записать отложенную правку сейчас (смена холста, уход с вкладки); `shouldDrop` — забыть её (холст удалён)
  const flushSave = useLastCallback((shouldDrop?: boolean) => {
    window.clearTimeout(saveTimerRef.current);
    const pending = pendingRef.current;
    pendingRef.current = undefined;
    if (!pending || shouldDrop) return undefined;
    const text = serializeCanvas(pending.doc);
    if (pending.id === loadedRef.current) knownTextRef.current = text;
    return saveCanvas(pending.title, text, vaultName, pending.id).catch(() => undefined);
  });

  // Документ на экран и в отложенную запись; истории правок не касается
  const applyDoc = (next: CanvasDoc) => {
    docRef.current = next;
    setDoc(next);
    if (!entry) return;
    const since = pendingRef.current?.since ?? Date.now();
    pendingRef.current = {
      id: entry.id, title: entry.title, doc: next, since,
    };
    window.clearTimeout(saveTimerRef.current);
    saveTimerRef.current = window.setTimeout(() => {
      void flushSave();
    }, Math.max(0, Math.min(SAVE_DELAY_MS, since + SAVE_MAX_WAIT_MS - Date.now())));
  };

  // Правка документа — один шаг истории. `isAmend` — продолжение предыдущего шага (текст только что
  // добавленной карточки): нового шага не будет
  const change = useLastCallback((next: CanvasDoc, isAmend?: boolean) => {
    if (next === docRef.current) return;
    if (!isAmend) {
      historyRef.current = recordStep(historyRef.current, docRef.current);
      syncHistory();
    }
    applyDoc(next);
  });

  useEffect(() => () => {
    void flushSave();
  }, [flushSave]);

  const nodeElement = (id: string) => Array.from(
    boardRef.current?.querySelectorAll<HTMLElement>('[data-canvas-node]') || [],
  ).find((element) => element.dataset.canvasNode === id);

  // Высота текстовой карточки идёт по тексту: карточка растёт вместе с ним (рамка — `min-height`), а узел
  // документа догоняет её здесь. Это не правка пользователя: шага истории и записи в облако нет
  useEffect(() => {
    if (live || inline) return;
    requestMeasure(() => {
      const current = docRef.current;
      let next = current;
      boardRef.current?.querySelectorAll<HTMLElement>('[data-canvas-type="text"]').forEach((element) => {
        const node = findNode(next, element.dataset.canvasNode!);
        const height = element.offsetHeight;
        if (node && height > 0 && height !== node.height) next = updateNode(next, node.id, { height });
      });
      if (next === current || gestureRef.current || inlineRef.current) return;
      next = growGroups(current, next);
      docRef.current = next;
      setDoc(next);
      if (pendingRef.current) pendingRef.current = { ...pendingRef.current, doc: next };
    });
  }, [doc, live, inline]);

  const inlineField = () => boardRef.current?.querySelector<InlineField>(INLINE_SELECTOR) || undefined;

  // Шла ли высота карточки по тексту: под последней строкой нет свободного места
  const isAutoHeight = (id: string) => {
    const body = nodeElement(id)?.querySelector<HTMLElement>('[data-canvas-body]');
    const last = body?.lastElementChild;
    if (!body || !(last instanceof HTMLElement)) return true;
    const slack = body.offsetTop + body.offsetHeight - last.offsetTop - last.offsetHeight
      - (parseFloat(getComputedStyle(body).paddingBottom) || 0);
    return slack < AUTO_SLACK || body.offsetHeight <= CANVAS_DEFAULT_NODE_HEIGHT;
  };

  const startInline = (node: CanvasNode, isNew = false) => {
    const next: Inline = {
      id: node.id, kind: 'node', isNew, isAuto: node.type === 'text' && (isNew || isAutoHeight(node.id)),
    };
    inlineRef.current = next;
    setInline(next);
    setInlineText((node.type === 'group' ? node.label : node.text) || '');
    setMenu(undefined);
    selectNodes([node.id]);
  };

  const startEdgeInline = (edge: CanvasEdge) => {
    const next: Inline = {
      id: edge.id, kind: 'edge', isNew: false, isAuto: false,
    };
    inlineRef.current = next;
    setInline(next);
    setInlineText(edge.label || '');
    setMenu(undefined);
    select({ nodes: [], edges: [edge.id] });
  };

  // Правка заметки прямо на карточке: текст целиком (исходник `.md`) либо название
  const startNoteInline = (node: CanvasNode, note: NoteEntry, kind: 'note' | 'title') => {
    // Текст, который ещё пишется в облако, уже считается текстом заметки: повторная правка идёт от него
    const base = kind === 'title' ? note.title : savingNote?.noteId === note.id ? savingNote.text : note.text;
    const next: Inline = {
      id: node.id, kind, isNew: false, isAuto: false, noteId: note.id, base, noteTitle: note.title,
    };
    inlineRef.current = next;
    setInline(next);
    setInlineText(base);
    setMenu(undefined);
    selectNodes([node.id]);
  };

  // Заметку удалили, пока её текст правили на карточке: набранное легло в новую заметку. Карточки прежней
  // заметки (в открытом документе и в шагах истории) указывают на новую; шагом истории это не становится
  const relinkCards = (fromId: string, fromTitle: string, toId: string, toTitle: string) => {
    const relink = (step: CanvasDoc) => relinkNoteCards(step, fromId, fromTitle, toId, toTitle);
    historyRef.current = mapHistory(historyRef.current, relink);
    const next = relink(docRef.current);
    if (next !== docRef.current) applyDoc(next);
  };

  // Текст заметки пишется тем же путём, что с экрана заметки. Изменения, пришедшие в заметку за время
  // правки, сводятся с ней при записи. Заметку за это время удалили — она создаётся заново с набранным
  // текстом. Не записалось — поле открывается снова с набранным текстом
  const commitNoteText = (current: Inline, text: string) => {
    const noteId = current.noteId!;
    const title = current.noteTitle!;
    const canvas = loadedRef.current;
    setSavingNote({ noteId, text });
    void saveNoteOrRestore(noteId, title, text, vaultName, current.base).catch(() => undefined).then((result) => {
      setSavingNote((saving) => (saving?.noteId === noteId && saving.text === text ? undefined : saving));
      if (result?.status === 'saved') return;
      if (result?.status === 'restored') {
        if (canvas === loadedRef.current) relinkCards(noteId, title, result.id, result.title);
        showNotification({ message: lang('KnowledgeCanvasNoteRestored', { name: result.title }) });
        return;
      }
      if (inlineRef.current || canvas !== loadedRef.current || !findNode(docRef.current, current.id)) return;
      inlineRef.current = current;
      setInline(current);
      setInlineText(text);
    });
  };

  // Переименованная заметка — новый путь в её карточках: в открытом документе и во всех шагах истории
  // (отмена не вернёт прежний путь). Шагом истории это не становится
  const retitleCards = (from: string, to: string) => {
    historyRef.current = mapHistory(historyRef.current, (step) => renameCanvasNote(step, from, to));
    const next = renameCanvasNote(docRef.current, from, to);
    if (next !== docRef.current) applyDoc(next);
  };

  // Название заметки: карточки холста получают его сразу, файл холста пишется до переименования — тогда
  // хранилищу в этом холсте править нечего, и он не перечитывается с диска. Ссылки в других заметках и
  // карточки других холстов правит `renameNote`
  const commitNoteTitle = async (noteId: string, from: string, title: string) => {
    const to = freeNoteTitle(noteId, title);
    if (to === from) return;
    const canvas = loadedRef.current;
    setRenaming({ from, to });
    retitleCards(from, to);
    await flushSave();
    const isDone = await renameNote(noteId, to, vaultName).catch(() => false);
    setRenaming(undefined);
    if (isDone) return;
    if (canvas === loadedRef.current) retitleCards(to, from);
    showNotification({ message: lang('KnowledgeNoticeFailed', { name: from }) });
  };

  // Конец правки на месте. Значение читается из самого поля: уход фокуса и Enter приходят раньше
  // перерисовки с набранным текстом. Вызывается и с ухода фокуса, и явно — второй вызов ничего не делает
  const finishInline = useLastCallback((isCanceled?: boolean) => {
    const current = inlineRef.current;
    if (!current) return;
    const raw = inlineField()?.value ?? inlineText;
    const value = raw.trim();
    inlineRef.current = undefined;
    setInline(undefined);
    // Текст и название заметки — другой файл: ни шага истории холста, ни записи холста
    if (current.kind === 'note') {
      if (!isCanceled && raw !== current.base) commitNoteText(current, raw);
      return;
    }
    if (current.kind === 'title') {
      const title = isCanceled ? undefined : nextNoteTitle(raw, current.base!);
      if (title) void commitNoteTitle(current.noteId!, current.base!, title);
      return;
    }
    if (current.kind === 'edge') {
      if (!isCanceled) change(updateEdge(docRef.current, current.id, { label: value }));
      return;
    }
    const node = findNode(docRef.current, current.id);
    if (!node) return;
    const isGroup = node.type === 'group';
    if (current.isNew && !isGroup && (isCanceled || !value)) {
      // Новая текстовая карточка без текста не остаётся: шаг, которым она добавлена, забывается
      const dropped = dropStep(historyRef.current);
      if (dropped) {
        historyRef.current = dropped.history;
        syncHistory();
        applyDoc(dropped.doc);
      } else {
        change(removeNode(docRef.current, node.id));
      }
      select(CANVAS_EMPTY_SELECTION);
      return;
    }
    if (isCanceled || value === ((isGroup ? node.label : node.text) || '')) return;
    change(updateNode(docRef.current, node.id, isGroup ? { label: value || undefined } : {
      text: value,
      // Дальше высоту подгонит замер: карточка не ниже своего текста
      height: current.isAuto ? Math.min(node.height, CANVAS_DEFAULT_NODE_HEIGHT) : node.height,
    }), current.isNew);
  });

  // Курсор — в поле, как только оно появилось: у названия выделено всё, у текста курсор в конце
  useEffect(() => {
    const field = inline && inlineField();
    // Поле, в которое уже начали вводить, не трогаем: перестановка курсора испортила бы набираемое
    if (!field || document.activeElement === field) return;
    field.focus();
    if (field instanceof HTMLInputElement) field.select();
    else field.setSelectionRange(field.value.length, field.value.length);
  }, [inline]);

  // Уход с вкладки посреди правки заметки: набранное сохраняется (поля на странице уже может не быть)
  const saveNoteOnLeave = useLastCallback(() => {
    const current = inlineRef.current;
    if (current?.kind !== 'note') return;
    inlineRef.current = undefined;
    const text = inlineField()?.value ?? inlineText;
    if (text !== current.base) {
      void saveNoteOrRestore(current.noteId!, current.noteTitle!, text, vaultName, current.base);
    }
  });

  useEffect(() => saveNoteOnLeave, [saveNoteOnLeave]);

  // Escape перехватывают общие слушатели приложения раньше поля — отмена правки встаёт в их очередь
  useEffect(() => (inline ? captureEscKeyListener(() => {
    if (!getIsParvaneScreenShown('knowledge')) return false;
    finishInline(true);
    return undefined;
  }) : undefined), [inline]);

  // Стрелка, оставленная на экране меню её конца, уходит вместе с меню
  useEffect(() => {
    if (!menu) setDraft(undefined);
  }, [menu]);

  const hasSelection = !isSelectionEmpty(selection);

  // Escape по очереди: меню, режим связи, выделение, режим выбора. Слушатель стоит всё время, пока холст открыт
  // (нечего снимать — клавиша уходит дальше): поставленный эффектом лишь при появлении цели, он пропускал
  // нажатие, пришедшее в том же кадре, что и меню либо выделение
  const handleEscape = useLastCallback(() => {
    // Скрытый раздел (смонтирован, но не показан) клавишу не берёт
    if (!getIsParvaneScreenShown('knowledge')) return false;
    // Правка началась в этом же кадре — её слушатель ещё не встал в очередь
    if (inlineRef.current) finishInline(true);
    else if (menu) setMenu(undefined);
    else if (linkFrom) setLinkFrom(undefined);
    else if (!isSelectionEmpty(selectionRef.current)) select(CANVAS_EMPTY_SELECTION);
    else if (isSelectMode) setIsSelectMode(false);
    else return false;
    return undefined;
  });

  useEffect(() => captureEscKeyListener(handleEscape), [handleEscape]);

  const handleInlineChange = useLastCallback((e: React.ChangeEvent<InlineField>) => {
    setInlineText(e.currentTarget.value);
  });

  const handleInlineBlur = useLastCallback(() => finishInline());

  // Enter сохраняет (в тексте карточки Shift+Enter — новая строка; в тексте заметки Enter — новая строка,
  // сохраняет Ctrl/Cmd+Enter), Escape отменяет
  const handleInlineKey = useLastCallback((e: React.KeyboardEvent<InlineField>) => {
    const action = inlineKeyAction(inlineRef.current?.kind || 'node', e);
    if (!action) return;
    e.preventDefault();
    if (action === 'cancel') e.stopPropagation();
    finishInline(action === 'cancel');
  });

  const noteByTitle = useMemo(() => new Map(notes.map((note) => [note.title.toLowerCase(), note])), [notes]);
  const filesOnCanvas = useMemo(() => new Set(
    doc.nodes.filter(({ type }) => type === 'file').map((node) => (noteTitleOfPath(node.file) || '').toLowerCase()),
  ), [doc]);
  // Файлы личного диска по путям карточек; ищутся при правке документа и облака, а не на каждый кадр жеста
  const driveFiles = useMemo(() => new Map(
    doc.nodes.filter((node) => node.type === 'file' && node.file)
      .map((node) => [node.file!, resolveDrivePath(driveNodes, node.file!)]),
  ), [doc, driveNodes]);

  // Заметка карточки по названию из пути. Пока идёт переименование с холста, карточка несёт новое название,
  // а заметка ещё прежнее
  const noteOf = (title: string) => {
    const key = title.toLowerCase();
    return noteByTitle.get(key)
      || (renaming && key === renaming.to.toLowerCase() ? noteByTitle.get(renaming.from.toLowerCase()) : undefined);
  };

  // Заметки нет в прочитанном хранилище — «не найдена»; хранилище ещё читается — судить рано
  const noteStateOf = (note?: NoteEntry): NoteCardState => (
    note ? 'found' : notesStatus === 'ready' ? 'missing' : 'loading'
  );

  // Карточка файла — заметка: путь кончается на `.md` и такая заметка есть (либо файла с таким путём нет)
  const noteTitleOf = (node: CanvasNode) => {
    const title = noteTitleOfPath(node.file);
    if (title === undefined) return undefined;
    return noteByTitle.has(title.toLowerCase()) || !driveFiles.get(node.file!) ? title : undefined;
  };

  const selectedNodes = selection.nodes.map((id) => shownById.get(id)).filter((node): node is CanvasNode => (
    Boolean(node)
  ));
  const selectedNode = selectedNodes.length === 1 && !selection.edges.length ? selectedNodes[0] : undefined;
  const selectedEdge = selection.edges.length === 1 && !selection.nodes.length
    ? doc.edges.find(({ id }) => id === selection.edges[0]) : undefined;
  const nodeEdges = useMemo(() => (
    selectedNode ? doc.edges.filter((edge) => edge.fromNode === selectedNode.id || edge.toNode === selectedNode.id)
      : []
  ), [doc, selectedNode]);

  const toCanvas = (e: { clientX: number; clientY: number }) => {
    const box = boardRef.current!.getBoundingClientRect();
    const current = viewRef.current;
    return {
      x: (e.clientX - box.left - current.x) / current.scale, y: (e.clientY - box.top - current.y) / current.scale,
    };
  };

  const centerPoint = () => {
    const size = viewport();
    const current = viewRef.current;
    return {
      x: Math.round((size.width / 2 - current.x) / current.scale) + (doc.nodes.length % NEW_COLUMNS) * NEW_OFFSET_X,
      y: Math.round((size.height / 2 - current.y) / current.scale)
        + Math.floor(doc.nodes.length / NEW_COLUMNS) * (NOTE_HEIGHT + NEW_OFFSET_Y),
    };
  };

  // Точка холста под указателем, если он над полем
  const pointerPoint = () => {
    const pointer = pointerRef.current;
    const box = boardRef.current?.getBoundingClientRect();
    if (!pointer || !box) return undefined;
    const isOver = pointer.x >= box.left && pointer.x <= box.right && pointer.y >= box.top && pointer.y <= box.bottom;
    return isOver ? toCanvas({ clientX: pointer.x, clientY: pointer.y }) : undefined;
  };

  const nameOfNode = (id: string) => {
    const node = findNode(doc, id);
    if (!node) return '?';
    return noteTitleOfPath(node.file) || node.label || (node.text || '').replace(/\*/g, '').slice(0, NODE_NAME_MAX)
      || lang(node.type === 'group' ? 'KnowledgeCanvasGroup' : 'KnowledgeCanvasText');
  };

  // Новый файл холста; повторное нажатие, пока он пишется, второго не создаёт
  const createCanvas = async (title: string, content: CanvasDoc) => {
    if (isCreatingRef.current) return;
    isCreatingRef.current = true;
    finishInline();
    flushSave();
    const id = await saveCanvas(title, serializeCanvas(content), vaultName).catch(() => undefined);
    isCreatingRef.current = false;
    if (id) setCanvasId(id);
  };

  const handleNewCanvas = useLastCallback(() => {
    const taken = canvases.map((item) => item.title.toLowerCase());
    let count = canvases.length + 1;
    while (taken.includes(lang('KnowledgeCanvasName', { count }).toLowerCase())) count++;
    void createCanvas(lang('KnowledgeCanvasName', { count }), createEmptyCanvas());
  });

  // Заметки и ссылки между ними — вход холста из графа и его обновления
  const graphNotes = () => notes.map((note) => ({
    id: note.id,
    title: note.title,
    folder: note.folder,
    links: parseNote(note.text).links,
    isDaily: note.isDaily,
  }));

  // «Холст из графа»: карточка на каждую заметку, стрелка на каждую ссылку; дальше это обычный холст
  const handleGraphCanvas = useLastCallback(() => {
    const content = canvasFromGraph(graphNotes(), { cardHeight: NOTE_HEIGHT });
    void createCanvas(
      freeCanvasTitle(lang('KnowledgeCanvasGraphName'), canvases.map((item) => item.title)), content,
    );
  });

  // «Обновить из графа»: открытый холст получает карточки новых заметок и стрелки новых ссылок, свои стрелки
  // исчезнувших ссылок уходят; сделанное руками не трогается. Один шаг истории. Новые карточки выделены, вид
  // сдвигается к ним, только если они за краем поля
  const handleRefreshGraph = useLastCallback(() => {
    if (!entry) return;
    finishInline();
    dropGesture();
    setMenu(undefined);
    setLinkFrom(undefined);
    const result = refreshCanvasFromGraph(docRef.current, graphNotes(), { cardHeight: NOTE_HEIGHT });
    if (result.doc === docRef.current) {
      showNotification({ message: lang('KnowledgeCanvasRefreshNothing') });
      return;
    }
    change(result.doc);
    const added = result.added.cards.map((id) => findNode(result.doc, id)!);
    if (added.length) {
      selectNodes(result.added.cards);
      const size = viewport();
      applyView(
        revealRects(viewRef.current, added, size.width, size.height, isNarrow ? FIT_TOP_NARROW : FIT_TOP, FIT_BOTTOM),
        true,
      );
    } else {
      select(pruneSelection(result.doc, selectionRef.current));
    }
    const counts = lang('KnowledgeCanvasRefreshDone', {
      cards: result.added.cards.length, edges: result.added.edges.length, removed: result.removed.edges.length,
    });
    const renamed = result.renamed.cards.length;
    showNotification({
      message: renamed ? `${counts}. ${lang('KnowledgeCanvasRefreshRenamed', { count: renamed })}` : counts,
    });
  });

  const handlePickCanvas = useLastCallback((e: React.MouseEvent<HTMLButtonElement>) => {
    finishInline();
    flushSave();
    setCanvasId(e.currentTarget.dataset.id);
  });

  // ── действия с холстом: название и корзина ──
  const handleOpenMenu = useLastCallback(() => {
    finishInline();
    setCanvasName(entry?.title || '');
    openMenu();
  });

  const handleCanvasName = useLastCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    setCanvasName(e.currentTarget.value);
  });

  // Название берётся из самого поля (Enter приходит раньше перерисовки с набранным)
  const handleRenameCanvas = useLastCallback(() => {
    const field = document.querySelector<HTMLInputElement>('#knowledge-canvas-name');
    const title = (field?.value ?? canvasName).trim();
    closeMenu();
    if (!entry || !title || title === entry.title) return;
    flushSave();
    void renameCanvas(entry.id, title);
  });

  const handleCanvasNameKey = useLastCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      handleRenameCanvas();
    }
  });

  // Настройка устройства: на телефоне миниатюры берегут трафик
  const handleImageQuality = useLastCallback((e: React.MouseEvent<HTMLButtonElement>) => {
    const quality: CanvasImageQuality = e.currentTarget.dataset.quality === 'thumb' ? 'thumb' : 'full';
    writeCanvasImageQuality(quality);
    setImageQuality(quality);
  });

  const handleAskDelete = useLastCallback(() => {
    closeMenu();
    openDelete();
  });

  // В корзину облака; после этого открыт другой холст, а если их не осталось — пустое состояние
  const handleDeleteCanvas = useLastCallback(() => {
    closeDelete();
    if (!entry) return;
    const { id } = entry;
    flushSave(true);
    setCanvasId(undefined);
    setRemovedIds((ids) => [...ids, id]);
    void deleteCanvas(id).then((isDone) => {
      // Не удалось — холст возвращается в список
      if (!isDone) setRemovedIds((ids) => ids.filter((item) => item !== id));
    });
  });

  // ── новые узлы ──
  // Новый узел: серединой в точке `at` (на сетке) либо на свободном месте в середине экрана
  const add = (node: Pick<CanvasNode, 'type' | 'width' | 'height'> & Partial<CanvasNode>, at?: CanvasPoint) => {
    finishInline();
    const point = at || centerPoint();
    // Без точки (кнопка панели) карточка встаёт на свободное место рядом с серединой экрана
    const spot = at || node.type === 'group' ? undefined
      : findFreeSpot(docRef.current, point, node.width, node.height);
    const created = {
      ...node,
      id: newCanvasId(),
      x: spot ? spot.x : snapTo(point.x - node.width / 2, at ? CANVAS_GRID : 1),
      y: spot ? spot.y : snapTo(point.y - node.height / 2, at ? CANVAS_GRID : 1),
    };
    change(addNode(docRef.current, created));
    selectNodes([created.id]);
    return created;
  };

  // Новая текстовая карточка и новая группа сразу открыты для ввода — слов-заглушек в файл не попадает
  const addText = (at?: CanvasPoint) => {
    startInline(add({
      type: 'text', width: CANVAS_DEFAULT_NODE_WIDTH, height: CANVAS_DEFAULT_NODE_HEIGHT, text: '',
    }, at), true);
  };

  const handleAddText = useLastCallback(() => addText());

  // Новая группа: вокруг выделенных узлов, а без выделения — пустая обычного размера
  const addGroup = (at?: CanvasPoint) => {
    finishInline();
    const ids = at ? [] : selectionRef.current.nodes;
    const wrapped = wrapInGroup(docRef.current, ids);
    if (!wrapped.id) {
      startInline(add({ type: 'group', width: GROUP_WIDTH, height: GROUP_HEIGHT }, at), true);
      return;
    }
    change(wrapped.doc);
    startInline(findNode(wrapped.doc, wrapped.id)!, true);
  };

  const handleAddGroup = useLastCallback(() => addGroup());

  // Карточка у конца стрелки, брошенной на пустом месте, и сама стрелка — одним шагом истории
  const addLinked = (
    node: Pick<CanvasNode, 'type' | 'width' | 'height'> & Partial<CanvasNode>, from: EdgeStart, point: CanvasPoint,
  ) => {
    const created: CanvasNode = {
      ...node, id: newCanvasId(), ...droppedCardPlace(point, from.side, node.width, node.height, CANVAS_GRID),
    };
    change(connectNodes(addNode(docRef.current, created), from.id, created.id, {
      fromSide: from.side, toSide: oppositeSide(from.side),
    }));
    selectNodes([created.id]);
    return created;
  };

  // Карточка заметки: в точке `at`, у конца стрелки `from` (если её начало ещё на холсте) либо на свободном
  // месте. Идентификатор заметки: по нему карточка найдёт её после переименования («Обновить из графа»)
  const addNoteCard = (title: string, noteId: string | undefined, at?: CanvasPoint, from?: EdgeStart) => {
    const card = {
      type: 'file',
      width: CANVAS_DEFAULT_NODE_WIDTH,
      height: NOTE_HEIGHT,
      file: `${title}.md`,
      [GRAPH_NOTE_FIELD]: noteId,
    };
    if (from && at && findNode(docRef.current, from.id)) {
      finishInline();
      return addLinked(card, from, at);
    }
    return add(card, at);
  };

  const pickNote = (at?: CanvasPoint, from?: EdgeStart) => {
    finishInline();
    insertAtRef.current = at;
    insertFromRef.current = from;
    setIsPickingNote(true);
  };

  const handleAddNote = useLastCallback(() => pickNote());
  const handleCloseNotePicker = useLastCallback(() => setIsPickingNote(false));

  const handlePickNote = useLastCallback((e: React.MouseEvent<HTMLButtonElement>) => {
    setIsPickingNote(false);
    const title = e.currentTarget.dataset.title || '';
    addNoteCard(title, noteByTitle.get(title.toLowerCase())?.id, insertAtRef.current, insertFromRef.current);
  });

  // ── новая заметка прямо с холста ──
  // Название спрашивается шторкой; заметка — настоящий файл `.md` в хранилище, как созданная на вкладке
  // «Заметки»
  const askNewNote = (at?: CanvasPoint, from?: EdgeStart) => {
    finishInline();
    setIsPickingNote(false);
    setNoteDraft({ title: '', at, from });
  };

  const handleNewNote = useLastCallback(() => askNewNote());
  // Из шторки выбора заметки: место и стрелка остаются теми же
  const handleNewNoteFromPicker = useLastCallback(() => askNewNote(insertAtRef.current, insertFromRef.current));

  const handleNewNoteTitle = useLastCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    setNoteDraft({ ...noteDraft!, title: e.currentTarget.value });
  });

  const handleNewNoteClose = useLastCallback(() => setNoteDraft(undefined));

  // Название берётся из самого поля (Enter приходит раньше перерисовки с набранным). Карточка встаёт, когда
  // заметка записана: занятое название получает номер, и карточка несёт уже его. О неудаче сообщает хранилище
  const handleNewNoteSave = useLastCallback(async () => {
    if (!noteDraft || isCreatingNoteRef.current) return;
    const field = document.querySelector<HTMLInputElement>('#knowledge-canvas-note-name');
    const title = (field?.value ?? noteDraft.title).trim();
    if (!title) return;
    const { at, from } = noteDraft;
    const canvas = loadedRef.current;
    setNoteDraft(undefined);
    isCreatingNoteRef.current = true;
    const id = await createNote(title, vaultName).catch(() => undefined);
    isCreatingNoteRef.current = false;
    // Холст за это время сменили — заметка создана, карточку ставить некуда
    if (!id || canvas !== loadedRef.current) return;
    addNoteCard(getNotes().find((note) => note.id === id)?.title || title, id, at, from);
  });

  const pickFile = (at?: CanvasPoint) => {
    finishInline();
    insertAtRef.current = at;
    openFilePicker();
  };

  const handleAddFile = useLastCallback(() => pickFile());

  const handlePickFile = useLastCallback((path: string) => {
    closeFilePicker();
    const file = resolveDrivePath(driveNodes, path);
    add({
      type: 'file',
      width: CANVAS_DEFAULT_NODE_WIDTH,
      height: (file?.thumb || isCanvasImage(file)) && noteTitleOfPath(path) === undefined ? FILE_HEIGHT : NOTE_HEIGHT,
      file: path,
    }, insertAtRef.current);
  });

  // ── карточка-ссылка ──
  const askLink = (at?: CanvasPoint) => {
    finishInline();
    setLinkDraft({ url: '', at });
  };

  const handleAddLink = useLastCallback(() => askLink());

  const handleLinkUrl = useLastCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    setLinkDraft({ ...linkDraft!, url: e.currentTarget.value });
  });

  const handleLinkClose = useLastCallback(() => setLinkDraft(undefined));

  const addLink = (url: string, at?: CanvasPoint) => add({
    type: 'link', width: LINK_WIDTH, height: LINK_HEIGHT, url,
  }, at);

  // Адрес берётся из самого поля (Enter приходит раньше перерисовки с набранным)
  const handleLinkSave = useLastCallback(() => {
    if (!linkDraft) return;
    const field = document.querySelector<HTMLInputElement>('#knowledge-canvas-url');
    const url = normalizeCanvasUrl(field?.value ?? linkDraft.url);
    if (!url) {
      showNotification({ message: lang('KnowledgeCanvasLinkBad') });
      return;
    }
    setLinkDraft(undefined);
    if (linkDraft.id) change(updateNode(docRef.current, linkDraft.id, { url }));
    else addLink(url, linkDraft.at);
  });

  // ── действия с выделенным ──
  // «Связать»: от выделенной карточки к той, которую нажмут следующей
  const handleLinkMode = useLastCallback(() => {
    setLinkFrom(linkFrom || !selectedNode || selectedNode.type === 'group' ? undefined : selectedNode.id);
  });

  const handleSelectMode = useLastCallback(() => setIsSelectMode(!isSelectMode));

  const handleRemove = useLastCallback(() => {
    if (isSelectionEmpty(selectionRef.current)) return;
    inlineRef.current = undefined;
    setInline(undefined);
    change(removeSelection(docRef.current, selectionRef.current));
    select(CANVAS_EMPTY_SELECTION);
  });

  const handleUndo = useLastCallback(() => {
    finishInline();
    dropGesture();
    const move = undoStep(historyRef.current, docRef.current);
    if (!move) return;
    historyRef.current = move.history;
    syncHistory();
    applyDoc(move.doc);
    select(pruneSelection(move.doc, selectionRef.current));
  });

  const handleRedo = useLastCallback(() => {
    finishInline();
    dropGesture();
    const move = redoStep(historyRef.current, docRef.current);
    if (!move) return;
    historyRef.current = move.history;
    syncHistory();
    applyDoc(move.doc);
    select(pruneSelection(move.doc, selectionRef.current));
  });

  // Вставка снимка узлов: серединой в точку `at`, а без неё — со сдвигом от места, откуда скопировано
  const pasteNodes = (clip: ReturnType<typeof copyNodes>, at?: CanvasPoint) => {
    const bounds = clipBounds(clip);
    if (!bounds) return;
    const dx = at ? snapTo(at.x - bounds.x - bounds.width / 2) : CANVAS_COPY_SHIFT;
    const dy = at ? snapTo(at.y - bounds.y - bounds.height / 2) : CANVAS_COPY_SHIFT;
    const pasted = pasteClip(docRef.current, clip, dx, dy);
    change(pasted.doc);
    selectNodes(pasted.ids);
  };

  const handleDuplicate = useLastCallback(() => {
    finishInline();
    pasteNodes(copyNodes(docRef.current, selectionRef.current.nodes));
  });

  const copySelection = () => {
    const { nodes } = selectionRef.current;
    if (!nodes.length) return undefined;
    lastClipText = serializeClip(copyNodes(docRef.current, nodes));
    return lastClipText;
  };

  // Текст из буфера обмена: узлы холста — узлами, адрес страницы — карточкой-ссылкой, прочее — текстовой
  const pasteText = (text: string, at?: CanvasPoint) => {
    const pasted = parsePasted(text);
    if (!pasted) return;
    finishInline();
    if (pasted.kind === 'nodes') {
      pasteNodes(pasted.clip, at);
    } else if (pasted.kind === 'link') {
      addLink(pasted.url, at);
    } else {
      add({
        type: 'text', width: CANVAS_DEFAULT_NODE_WIDTH, height: CANVAS_DEFAULT_NODE_HEIGHT, text: pasted.text,
      }, at);
    }
  };

  const handleColor = useLastCallback((color?: string) => {
    setMenu(undefined);
    change(recolorSelection(docRef.current, selectionRef.current, color));
  });

  const handleFitGroups = useLastCallback(() => {
    change(selectionRef.current.nodes.reduce((next, id) => fitGroupToContent(next, id), docRef.current));
  });

  const handleTurnEdges = useLastCallback(() => {
    change(selectionRef.current.edges.reduce((next, id) => {
      const edge = next.edges.find((item) => item.id === id);
      return edge ? updateEdge(next, id, nextEdgeEnds(edge)) : next;
    }, docRef.current));
  });

  const handleAlign = useLastCallback((align: CanvasAlign) => {
    setMenu(undefined);
    change(alignNodes(docRef.current, selectionRef.current.nodes, align));
  });

  const handleDistribute = useLastCallback((axis: 'x' | 'y') => {
    setMenu(undefined);
    change(distributeNodes(docRef.current, selectionRef.current.nodes, axis));
  });

  const handleEdit = useLastCallback(() => {
    finishInline();
    setMenu(undefined);
    if (selectedEdge) {
      setEditing({
        text: selectedEdge.label || '', color: selectedEdge.color || '', labels: {}, removed: [],
      });
      return;
    }
    if (!selectedNode) return;
    setEditing({
      text: (selectedNode.type === 'group' ? selectedNode.label : selectedNode.text) || '',
      color: selectedNode.color || '',
      labels: Object.fromEntries(nodeEdges.map((edge) => [edge.id, edge.label || ''])),
      removed: [],
    });
  });

  const handleEditText = useLastCallback((e: React.ChangeEvent<HTMLTextAreaElement | HTMLInputElement>) => {
    setEditing({ ...editing!, text: e.currentTarget.value });
  });

  const handleEditColor = useLastCallback((e: React.MouseEvent<HTMLButtonElement>) => {
    setEditing({ ...editing!, color: e.currentTarget.dataset.color || '' });
  });

  const handleEditLabel = useLastCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const id = e.currentTarget.dataset.edge!;
    setEditing({ ...editing!, labels: { ...editing!.labels, [id]: e.currentTarget.value } });
  });

  const handleEditRemoveEdge = useLastCallback((e: React.MouseEvent<HTMLButtonElement>) => {
    setEditing({ ...editing!, removed: [...editing!.removed, e.currentTarget.dataset.edge!] });
  });

  const handleEditClose = useLastCallback(() => setEditing(undefined));

  const handleEditSave = useLastCallback(() => {
    if (!editing) return;
    const current = docRef.current;
    if (selectedEdge) {
      change(updateEdge(current, selectedEdge.id, { label: editing.text.trim(), color: editing.color || undefined }));
    } else if (selectedNode) {
      const node = findNode(current, selectedNode.id);
      if (!node) {
        setEditing(undefined);
        return;
      }
      const text = editing.text.trim();
      let next = updateNode(current, node.id, {
        color: editing.color || undefined,
        label: node.type === 'group' ? text || undefined : node.label,
        text: node.type === 'text' ? text : node.text,
      });
      Object.entries(editing.labels).forEach(([id, label]) => {
        if (editing.removed.includes(id)) return;
        const edge = next.edges.find((item) => item.id === id);
        if (edge && (edge.label || '') !== label.trim()) next = updateEdge(next, id, { label: label.trim() });
      });
      editing.removed.forEach((id) => {
        next = removeEdge(next, id);
      });
      change(next);
    }
    setEditing(undefined);
  });

  // Карточка заметки открывает заметку, карточка файла облака — просмотр файла
  const openFileNode = (node: CanvasNode) => {
    const title = noteTitleOf(node);
    if (title !== undefined) {
      // Заметка, которую прямо сейчас переименовывают с холста, открывается под прежним названием
      onOpenTitle(noteOf(title)?.title || title);
      return;
    }
    const file = node.file ? driveFiles.get(node.file) : undefined;
    if (file && driveId) setFilePreview({ container: driveId, node: file });
  };

  const handleEditOpenNote = useLastCallback(() => {
    setEditing(undefined);
    if (selectedNode?.type === 'file') openFileNode(selectedNode);
  });

  const handleClosePreview = useLastCallback(() => setFilePreview(undefined));

  const handleDownload = useLastCallback((container: string, node: CloudNode) => {
    void downloadCloudNode(container, node, isNarrow ? PREVIEW_MAX_BYTES_NARROW : PREVIEW_MAX_BYTES);
  });

  const handleOpenNote = useLastCallback((e: React.MouseEvent<HTMLButtonElement>) => {
    const node = findNode(docRef.current, e.currentTarget.dataset.node!);
    finishInline();
    if (node) openFileNode(node);
  });

  const handleOpenSelected = useLastCallback(() => {
    setMenu(undefined);
    finishInline();
    const [id] = selectionRef.current.nodes;
    const node = id ? findNode(docRef.current, id) : undefined;
    if (node?.type === 'file') openFileNode(node);
  });

  // Двойной клик (двойной тап), Enter и «Изменить»: текстовая карточка — правка текста на месте, группа —
  // правка названия, ссылка — правка адреса, карточка файла открывает просмотр. Карточка заметки правит
  // саму заметку: по тексту (`part`) — её текст, по шапке — название; заметку, которой нет, команда создаёт
  const activate = (nodeId: string, part: NoteCardPart = 'command') => {
    const node = findNode(docRef.current, nodeId);
    if (!node) return;
    const noteTitle = node.type === 'file' ? noteTitleOf(node) : undefined;
    if (noteTitle !== undefined) {
      const note = noteOf(noteTitle);
      const action = noteCardAction(noteStateOf(note), part, note?.isDaily && isDayTitle(note.title));
      if (action === 'create') onOpenTitle(noteTitle);
      else if (note && action !== 'none') startNoteInline(node, note, action === 'editTitle' ? 'title' : 'note');
      else selectNodes([node.id]);
    } else if (node.type === 'file') {
      openFileNode(node);
    } else if (node.type === 'text' || node.type === 'group') {
      startInline(node);
    } else if (node.type === 'link') {
      selectNodes([node.id]);
      setLinkDraft({ id: node.id, url: node.url || '' });
    } else {
      selectNodes([node.id]);
      handleEdit();
    }
  };

  // Единственное выделенное: `part` — откуда пришло действие (клавиша правит текст заметки, но не создаёт её)
  const activateSelected = (part: NoteCardPart) => {
    setMenu(undefined);
    const current = selectionRef.current;
    const edge = current.edges.length === 1 && !current.nodes.length
      ? docRef.current.edges.find(({ id }) => id === current.edges[0]) : undefined;
    if (edge) startEdgeInline(edge);
    else if (current.nodes.length === 1 && !current.edges.length) activate(current.nodes[0], part);
  };

  const handleActivate = useLastCallback(() => activateSelected('command'));

  // ── меню по правой кнопке и долгому нажатию ──
  // Меню в точке экрана: для того, что под ней (оно становится выделенным), либо для пустого места
  // Узел под указателем. Полоса захвата вдоль рамки группы широкая и накрывает стрелки у края группы:
  // на самой линии стрелки нажатие достаётся стрелке, а не группе
  const nodeUnder = (hit: Element, point: CanvasPoint, edgeHit: number) => {
    const nodeId = hit.closest<HTMLElement>('[data-canvas-node]')?.dataset.canvasNode;
    if (!nodeId || !hit.closest('[data-canvas-group-band]')) return nodeId;
    return edgeAt(docRef.current, point, edgeHit) ? undefined : nodeId;
  };

  const openMenuAt = (clientX: number, clientY: number) => {
    finishInline();
    dropGesture();
    const box = boardRef.current!.getBoundingClientRect();
    const point = toCanvas({ clientX, clientY });
    const hit = document.elementFromPoint(clientX, clientY);
    const nodeId = hit ? nodeUnder(hit, point, EDGE_HIT_TOUCH / viewRef.current.scale) : undefined;
    const edgeId = nodeId ? undefined : edgeAt(docRef.current, point, EDGE_HIT_TOUCH / viewRef.current.scale);
    const current = selectionRef.current;
    if (nodeId && !current.nodes.includes(nodeId)) selectNodes([nodeId]);
    else if (edgeId && !current.edges.includes(edgeId)) select({ nodes: [], edges: [edgeId] });
    else if (!nodeId && !edgeId) select(CANVAS_EMPTY_SELECTION);
    setLinkFrom(undefined);
    setMenu({
      x: clientX - box.left, y: clientY - box.top, point, kind: nodeId || edgeId ? 'selection' : 'board',
    });
  };

  const handleContextMenu = useLastCallback((e: React.MouseEvent<HTMLDivElement>) => {
    if ((e.target as Element).closest(PASSIVE_SELECTOR)) return;
    e.preventDefault();
    openMenuAt(e.clientX, e.clientY);
  });

  // «⋯» панели выделенного: то же меню рядом с кнопкой
  const handleMore = useLastCallback((e: React.MouseEvent<HTMLButtonElement>) => {
    if (menu) {
      setMenu(undefined);
      return;
    }
    const box = boardRef.current!.getBoundingClientRect();
    const button = e.currentTarget.getBoundingClientRect();
    setMenu({
      x: button.left - box.left, y: button.bottom - box.top + BAR_GAP / 2, point: centerPoint(), kind: 'selection',
    });
  });

  const handleCommand = useLastCallback((command: CanvasCommand) => {
    const at = menu?.kind === 'board' ? menu.point : undefined;
    const drop = menu?.kind === 'drop' && menu.from ? { point: menu.point, from: menu.from } : undefined;
    setMenu(undefined);
    switch (command) {
      case 'edit':
        handleActivate();
        break;
      case 'open':
        handleOpenSelected();
        break;
      case 'direction':
        handleTurnEdges();
        break;
      case 'duplicate':
        handleDuplicate();
        break;
      case 'copy': {
        const text = copySelection();
        if (text) void navigator.clipboard?.writeText(text).catch(() => undefined);
        break;
      }
      case 'cut': {
        const text = copySelection();
        if (text) void navigator.clipboard?.writeText(text).catch(() => undefined);
        handleRemove();
        break;
      }
      case 'paste': {
        const read = navigator.clipboard?.readText ? navigator.clipboard.readText() : Promise.reject(new Error('none'));
        void read.catch(() => '').then((text) => pasteText(text || lastClipText, at));
        break;
      }
      case 'wrap':
        addGroup();
        break;
      case 'fit':
        handleFitGroups();
        break;
      case 'front':
        change(reorderNodes(docRef.current, selectionRef.current.nodes, 'front'));
        break;
      case 'back':
        change(reorderNodes(docRef.current, selectionRef.current.nodes, 'back'));
        break;
      case 'props':
        handleEdit();
        break;
      case 'remove':
        handleRemove();
        break;
      case 'selectAll':
        select(selectAll(docRef.current));
        break;
      case 'textHere':
        addText(at);
        break;
      case 'groupHere':
        addGroup(at);
        break;
      case 'note':
        pickNote(at);
        break;
      case 'newNote':
        askNewNote(at);
        break;
      // Конец стрелки, брошенной на пустом месте: текстовая карточка, новая заметка либо заметка из списка
      case 'dropText':
        if (drop && findNode(docRef.current, drop.from.id)) {
          startInline(addLinked({
            type: 'text', width: CANVAS_DEFAULT_NODE_WIDTH, height: CANVAS_DEFAULT_NODE_HEIGHT, text: '',
          }, drop.from, drop.point), true);
        }
        break;
      case 'dropNewNote':
        if (drop) askNewNote(drop.point, drop.from);
        break;
      case 'dropNote':
        if (drop) pickNote(drop.point, drop.from);
        break;
      case 'link':
        askLink(at);
        break;
      case 'file':
        pickFile(at);
        break;
      case 'refreshGraph':
        handleRefreshGraph();
        break;
      default:
        applyView(fitTo(docRef.current), true);
    }
  });

  // ── указатель ──
  const startMove = (
    nodeId: string, ids: string[], origin: CanvasPoint, collapseTo?: string, tapKey?: string,
  ) => {
    const base = docRef.current;
    const moving = new Set(ids);
    ids.forEach((id) => nodesInGroup(base, id).forEach((node) => moving.add(node.id)));
    gestureRef.current = {
      kind: 'move',
      lead: nodeId,
      ids,
      origin,
      base,
      others: base.nodes.filter((node) => !moving.has(node.id)),
      bounds: selectionBounds(base, Array.from(moving))!,
      hasMoved: false,
      collapseTo,
      tapKey,
    };
  };

  const handlePointerDown = useLastCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const target = e.target as Element;
    if (target.closest(PASSIVE_SELECTOR)) return;
    // Нажатие мимо поля правки сохраняет набранное (уход фокуса приходит не во всех браузерах)
    finishInline();
    setMenu(undefined);
    // Правая кнопка — меню (событие `contextmenu`)
    if (e.button === 2) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    if (pinchRef.current.down(e.pointerId, e.clientX, e.clientY, viewRef.current)) {
      dropGesture();
      return;
    }
    if (e.pointerType === 'touch') {
      const { clientX, clientY } = e;
      window.clearTimeout(pressTimerRef.current);
      pressTimerRef.current = window.setTimeout(() => {
        const gesture = gestureRef.current;
        if (gesture && !gesture.hasMoved) openMenuAt(clientX, clientY);
      }, LONG_PRESS_MS);
    }
    const point = toCanvas(e);
    const pan = (tapKey?: string): Gesture => ({
      kind: 'pan', x: e.clientX, y: e.clientY, hasMoved: false, tapKey,
    });
    const edgeHit = (e.pointerType === 'touch' ? EDGE_HIT_TOUCH : EDGE_HIT) / viewRef.current.scale;
    const nodeId = nodeUnder(target, point, edgeHit);
    const port = target.closest<HTMLElement>('[data-canvas-port]')?.dataset.canvasPort as CanvasSide | undefined;
    const handle = target.closest<HTMLElement>('[data-canvas-handle]')?.dataset.canvasHandle as
      CanvasHandle | undefined;
    const isAdditive = e.shiftKey || e.ctrlKey || e.metaKey || isSelectMode;
    const current = selectionRef.current;
    const action = pressAction({
      isPanForced: e.button === 1 || isSpaceDownRef.current,
      isAdditive,
      isLinking: Boolean(linkFrom),
      nodeId,
      port: port && CANVAS_SIDES.includes(port) ? port : undefined,
      handle,
      edgeId: nodeId ? undefined : edgeAt(docRef.current, point, edgeHit),
    });
    switch (action.kind) {
      // Средняя кнопка и пробел двигают поле, что бы ни было под указателем
      case 'pan':
        e.preventDefault();
        gestureRef.current = pan();
        break;
      case 'arrow':
        setLinkFrom(undefined);
        selectNodes([action.id]);
        gestureRef.current = {
          kind: 'edge', from: action.id, side: action.side, hasMoved: false,
        };
        break;
      case 'resize': {
        const base = docRef.current;
        gestureRef.current = {
          kind: 'resize',
          id: action.id,
          handle: action.handle,
          origin: point,
          base,
          others: base.nodes.filter((node) => node.id !== action.id),
          hasMoved: false,
        };
        break;
      }
      case 'link': {
        const node = action.id ? findNode(docRef.current, action.id) : undefined;
        if (node && node.id !== linkFrom && node.type !== 'group') {
          change(addEdge(docRef.current, linkFrom!, node.id));
        }
        setLinkFrom(undefined);
        break;
      }
      case 'node': {
        const isIn = current.nodes.includes(action.id);
        const next = isAdditive ? toggleSelected(current, 'nodes', action.id)
          : isIn ? current : { nodes: [action.id], edges: [] };
        select(next);
        // Нажатие без сдвига на одном из нескольких выделенных оставляет выделенным только его
        if (next.nodes.includes(action.id)) {
          startMove(
            action.id, next.nodes, point, !isAdditive && isIn && next.nodes.length > 1 ? action.id : undefined,
          );
        } else {
          gestureRef.current = undefined;
        }
        break;
      }
      case 'edge':
        select(isAdditive ? toggleSelected(current, 'edges', action.id) : { nodes: [], edges: [action.id] });
        gestureRef.current = pan(`edge:${action.id}`);
        break;
      // Пустое место с Shift (или в режиме выбора) рисует рамку — и вне групп, и внутри группы
      case 'marquee':
        gestureRef.current = {
          kind: 'marquee', origin: point, base: current, hasMoved: false,
        };
        break;
      // Пустое место двигает поле — и вне групп, и внутри группы (группу берут за шапку и границу)
      default:
        select(CANVAS_EMPTY_SELECTION);
        gestureRef.current = pan(TAP_BOARD);
    }
  });

  const showLive = (next: CanvasDoc, guides: CanvasGuide[]) => {
    liveRef.current = { doc: next, guides };
    setLive(liveRef.current);
  };

  // Группа, которую возьмёт перетаскивание из-под указателя: её шапка и граница
  const hoverGroupAt = (e: React.PointerEvent<HTMLDivElement>) => {
    const target = e.target as Element;
    if (target.closest(PASSIVE_SELECTOR)) return undefined;
    const element = target.closest<HTMLElement>('[data-canvas-node]');
    return element?.dataset.canvasType === 'group' ? element.dataset.canvasNode : undefined;
  };

  const handlePointerLeave = useLastCallback(() => setHoverGroup(undefined));

  const handlePointerMove = useLastCallback((e: React.PointerEvent<HTMLDivElement>) => {
    pointerRef.current = { x: e.clientX, y: e.clientY };
    const pinched = pinchRef.current.move(
      e.pointerId, e.clientX, e.clientY, e.currentTarget.getBoundingClientRect(),
    );
    if (pinched) {
      applyView(pinched, false);
      return;
    }
    const gesture = gestureRef.current;
    if (!gesture) {
      if (e.pointerType !== 'touch') setHoverGroup(hoverGroupAt(e));
      return;
    }
    if (gesture.kind === 'pan') {
      const dx = e.clientX - gesture.x;
      const dy = e.clientY - gesture.y;
      if (!gesture.hasMoved && Math.abs(dx) + Math.abs(dy) < DRAG_THRESHOLD) return;
      window.clearTimeout(pressTimerRef.current);
      const current = viewRef.current;
      applyView({ ...current, x: current.x + dx, y: current.y + dy }, false);
      gestureRef.current = {
        ...gesture, x: e.clientX, y: e.clientY, hasMoved: true,
      };
      return;
    }
    const point = toCanvas(e);
    if (gesture.kind === 'edge') {
      const source = findNode(docRef.current, gesture.from);
      if (!source) return;
      window.clearTimeout(pressTimerRef.current);
      gesture.hasMoved = true;
      const target = nodeAtPoint(docRef.current, point, gesture.from);
      const side = target ? nearestSide(target, point) : oppositeSide(gesture.side);
      setDraft(curveBetween(
        { ...sidePoint(source, gesture.side), side: gesture.side },
        { ...(target ? sidePoint(target, side) : point), side },
      ));
      return;
    }
    const dx = point.x - gesture.origin.x;
    const dy = point.y - gesture.origin.y;
    if (!gesture.hasMoved && (Math.abs(dx) + Math.abs(dy)) * viewRef.current.scale < DRAG_THRESHOLD) return;
    window.clearTimeout(pressTimerRef.current);
    gesture.hasMoved = true;
    if (gesture.kind === 'marquee') {
      const rect = rectOfPoints(gesture.origin, point);
      const hit = nodesInRect(docRef.current, rect);
      setMarquee(rect);
      select({
        nodes: [...gesture.base.nodes, ...hit.filter((id) => !gesture.base.nodes.includes(id))],
        edges: gesture.base.edges,
      });
      return;
    }
    // Alt отключает и сетку, и прилипание к соседям
    const isFree = e.altKey;
    const tolerance = CANVAS_SNAP_DISTANCE / viewRef.current.scale;
    if (gesture.kind === 'move') {
      const lead = findNode(gesture.base, gesture.lead)!;
      const delta = isFree ? { dx: Math.round(dx), dy: Math.round(dy) } : snapDelta(lead, dx, dy);
      const raw = { ...gesture.bounds, x: gesture.bounds.x + dx, y: gesture.bounds.y + dy };
      const snap = isFree ? undefined : snapToNeighbours(raw, gesture.others, tolerance);
      // Сосед ближе допуска сильнее сетки — по каждой оси отдельно
      if (snap?.guides.some(({ axis }) => axis === 'x')) delta.dx = Math.round(dx + snap.dx);
      if (snap?.guides.some(({ axis }) => axis === 'y')) delta.dy = Math.round(dy + snap.dy);
      const placed = { ...gesture.bounds, x: gesture.bounds.x + delta.dx, y: gesture.bounds.y + delta.dy };
      showLive(
        growGroups(gesture.base, moveNodes(gesture.base, gesture.ids, delta.dx, delta.dy)),
        snap?.guides.length ? snapToNeighbours(placed, gesture.others, 0).guides : [],
      );
      return;
    }
    const node = findNode(gesture.base, gesture.id)!;
    const min = minSizeOf(node);
    let rect = resizeRect(node, gesture.handle, dx, dy, min, isFree ? 1 : CANVAS_GRID);
    let guides: CanvasGuide[] = [];
    if (!isFree) {
      const snapped = snapResize(
        resizeRect(node, gesture.handle, dx, dy, min, 1), gesture.handle, gesture.others, tolerance, min,
      );
      guides = snapped.guides;
      if (guides.some(({ axis }) => axis === 'x')) rect = { ...rect, x: snapped.rect.x, width: snapped.rect.width };
      if (guides.some(({ axis }) => axis === 'y')) rect = { ...rect, y: snapped.rect.y, height: snapped.rect.height };
    }
    showLive(growGroups(gesture.base, placeNode(gesture.base, node.id, rect)), guides);
  });

  // Двойное нажатие на пустом месте — новая текстовая карточка, на стрелке — правка подписи, на узле — он сам
  const activateKey = (key: string, at: CanvasPoint, part?: NoteCardPart) => {
    if (key === TAP_BOARD) {
      addText(at);
      return;
    }
    const edge = key.startsWith('edge:') ? docRef.current.edges.find(({ id }) => `edge:${id}` === key) : undefined;
    if (edge) startEdgeInline(edge);
    else activate(key, part);
  };

  // Часть карточки заметки под точкой экрана: шапка с названием либо текст
  const notePartAt = (hit: Element | null | undefined): NoteCardPart => (
    hit?.closest(NOTE_HEAD_SELECTOR) ? 'title' : 'body'
  );

  const handlePointerUp = useLastCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const wasPinch = pinchRef.current.isActive();
    pinchRef.current.up(e.pointerId);
    window.clearTimeout(pressTimerRef.current);
    const gesture = gestureRef.current;
    const result = liveRef.current;
    gestureRef.current = undefined;
    liveRef.current = undefined;
    setLive(undefined);
    setMarquee(undefined);
    setDraft(undefined);
    if (wasPinch) commitView();
    if (!gesture) return;
    const point = toCanvas(e);
    if (gesture.hasMoved) {
      tapRef.current = undefined;
      if (gesture.kind === 'pan') commitView();
      if ((gesture.kind === 'move' || gesture.kind === 'resize') && result) change(result.doc);
      if (gesture.kind === 'edge') {
        const target = nodeAtPoint(docRef.current, point, gesture.from);
        if (target) {
          change(connectNodes(docRef.current, gesture.from, target.id, {
            fromSide: gesture.side, toSide: nearestSide(target, point),
          }));
          return;
        }
        // Стрелка, брошенная на пустом месте, спрашивает, что поставить на её конце: новую заметку, заметку
        // из списка либо текстовую карточку. Пока меню открыто, стрелка остаётся на экране
        const box = boardRef.current!.getBoundingClientRect();
        setDraft(draft);
        setMenu({
          x: e.clientX - box.left,
          y: e.clientY - box.top,
          point,
          kind: 'drop',
          from: { id: gesture.from, side: gesture.side },
        });
      }
      return;
    }
    if (gesture.kind === 'move' && gesture.collapseTo) selectNodes([gesture.collapseTo]);
    // Двойной тап: браузеры на сенсорных экранах `dblclick` присылают не всегда
    const key = gesture.kind === 'move' ? gesture.tapKey || gesture.lead
      : gesture.kind === 'pan' ? gesture.tapKey : undefined;
    if (e.pointerType !== 'touch' || !key || isSelectMode) return;
    const last = tapRef.current;
    const now = Date.now();
    const isNear = last && Math.hypot(last.x - e.clientX, last.y - e.clientY) < DOUBLE_TAP_DISTANCE;
    if (last && last.key === key && isNear && now - last.at < DOUBLE_TAP_MS) {
      tapRef.current = undefined;
      tapActivatedAtRef.current = now;
      activateKey(key, point, notePartAt(document.elementFromPoint(e.clientX, e.clientY)));
    } else {
      tapRef.current = {
        key, at: now, x: e.clientX, y: e.clientY,
      };
    }
  });

  // Прерванный жест (звонок, жест системы) ничего не меняет
  const handlePointerCancel = useLastCallback((e: React.PointerEvent<HTMLDivElement>) => {
    pinchRef.current.up(e.pointerId);
    dropGesture();
    commitView();
  });

  const handleDoubleClick = useLastCallback((e: React.MouseEvent<HTMLDivElement>) => {
    const target = e.target as Element;
    if (target.closest(PASSIVE_SELECTOR)) return;
    if (Date.now() - tapActivatedAtRef.current < TAP_ECHO_MS) return;
    // Указатель захвачен полем холста: целью события бывает само поле, а не карточка под курсором
    const hit = document.elementFromPoint(e.clientX, e.clientY) || target;
    if (hit.closest(`${PASSIVE_SELECTOR}, [data-canvas-handle], [data-canvas-port]`)) return;
    const point = toCanvas(e);
    const nodeId = nodeUnder(hit, point, EDGE_HIT / viewRef.current.scale);
    if (nodeId) {
      activate(nodeId, notePartAt(hit));
      return;
    }
    const edgeId = edgeAt(docRef.current, point, EDGE_HIT / viewRef.current.scale);
    activateKey(edgeId ? `edge:${edgeId}` : TAP_BOARD, point);
  });

  // ── клавиши и буфер обмена ──
  // Клавиши холста молчат, пока раздел скрыт, открыта шторка или окно, идёт правка на месте либо фокус в чужом поле
  const isKeyboardBusy = () => Boolean(!getIsParvaneScreenShown('knowledge')
    || inlineRef.current || editing || linkDraft || noteDraft || filePreview
    || isPickingNote
    || isPickingFile || isMenuOpen || isDeleteOpen || document.body.classList.contains('has-open-dialog')
    || isTypingElement(document.activeElement || undefined));

  const handleKeyDown = useLastCallback((e: KeyboardEvent) => {
    if (isKeyboardBusy()) return;
    const isOnButton = document.activeElement instanceof HTMLButtonElement;
    if (e.code === 'Space' && !isOnButton) {
      // Пробел с перетаскиванием двигает поле
      isSpaceDownRef.current = true;
      e.preventDefault();
      return;
    }
    const action = canvasShortcut(e);
    const current = selectionRef.current;
    // Enter на кнопке нажимает её; без выделения клавиши удаления, правки и стрелки остаются приложению
    if (!action || (action === 'edit' && isOnButton)) return;
    const needsSelection = action !== 'undo' && action !== 'redo' && action !== 'selectAll';
    if (needsSelection && isSelectionEmpty(current)) return;
    e.preventDefault();
    e.stopPropagation();
    const step = e.shiftKey ? CANVAS_NUDGE_BIG : CANVAS_GRID;
    const nudge = (dx: number, dy: number) => {
      const base = docRef.current;
      change(growGroups(base, moveNodes(base, current.nodes, dx, dy)));
    };
    switch (action) {
      case 'undo':
        handleUndo();
        break;
      case 'redo':
        handleRedo();
        break;
      case 'selectAll':
        select(selectAll(docRef.current));
        break;
      case 'duplicate':
        handleDuplicate();
        break;
      case 'remove':
        handleRemove();
        break;
      case 'edit':
        activateSelected('body');
        break;
      case 'left':
        nudge(-step, 0);
        break;
      case 'right':
        nudge(step, 0);
        break;
      case 'up':
        nudge(0, -step);
        break;
      default:
        nudge(0, step);
    }
  });

  // Отпущенный пробел и уход из окна (отпускание тогда не придёт) возвращают обычное перетаскивание
  const handleKeyUp = useLastCallback((e: KeyboardEvent | FocusEvent) => {
    if (!('code' in e) || e.code === 'Space') isSpaceDownRef.current = false;
  });

  // Копирование кладёт в буфер обмена текст JSON Canvas — его примет другой холст и другое приложение
  const handleCopy = useLastCallback((e: ClipboardEvent) => {
    if (isKeyboardBusy() || window.getSelection()?.toString()) return;
    const text = copySelection();
    if (!text) return;
    e.clipboardData?.setData('text/plain', text);
    e.preventDefault();
    if (e.type === 'cut') handleRemove();
  });

  const handlePaste = useLastCallback((e: ClipboardEvent) => {
    if (isKeyboardBusy()) return;
    const text = e.clipboardData?.getData('text/plain');
    if (!text) return;
    e.preventDefault();
    pasteText(text, pointerPoint());
  });

  // Раздел рисует холст, только пока открыта его вкладка, — слушатели живут ровно столько же
  useEffect(() => {
    document.addEventListener('keydown', handleKeyDown, true);
    document.addEventListener('keyup', handleKeyUp, true);
    window.addEventListener('blur', handleKeyUp);
    document.addEventListener('copy', handleCopy);
    document.addEventListener('cut', handleCopy);
    document.addEventListener('paste', handlePaste);
    return () => {
      document.removeEventListener('keydown', handleKeyDown, true);
      document.removeEventListener('keyup', handleKeyUp, true);
      window.removeEventListener('blur', handleKeyUp);
      document.removeEventListener('copy', handleCopy);
      document.removeEventListener('cut', handleCopy);
      document.removeEventListener('paste', handlePaste);
      window.clearTimeout(pressTimerRef.current);
    };
  }, [handleKeyDown, handleKeyUp, handleCopy, handlePaste]);

  const zoomBy = (factor: number) => {
    const size = viewport();
    const current = viewRef.current;
    applyView(zoomAround(current, current.scale * factor, size.width / 2, size.height / 2), true);
  };

  const handleZoomIn = useLastCallback(() => zoomBy(BOARD_ZOOM_STEP));
  const handleZoomOut = useLastCallback(() => zoomBy(1 / BOARD_ZOOM_STEP));
  const handleFit = useLastCallback(() => applyView(fitTo(doc), true));
  const handleWheel = useLastCallback((e: React.WheelEvent<HTMLDivElement>) => {
    // В меню и в поле текста заметки колесо листает их, а не меняет масштаб
    if ((e.target as Element).closest('[data-canvas-context], [data-canvas-note-editor]')) return;
    const box = e.currentTarget.getBoundingClientRect();
    applyView(zoomByWheel(viewRef.current, e.deltaY, e.clientX - box.left, e.clientY - box.top), false);
    commitViewSoon();
  });

  // Ручки размера и точки для стрелок — у единственного выделенного узла, когда нет ни правки, ни режима связи
  const hasGrips = (node: CanvasNode) => selectedNode?.id === node.id && !linkFrom && inline?.id !== node.id;
  // Картинка в полном качестве — когда карточка на экране шире порога; порог сравнивается по закреплённому
  // масштабу, так что сам по себе жест карточки не перерисовывает
  const isLargeImage = (node: CanvasNode) => node.width * view.scale >= CANVAS_FULL_IMAGE_MIN_PX;

  // Поиск: текст карточки, подпись группы, название и текст заметки, адрес ссылки, путь файла
  const found = useMemo(() => {
    const wanted = normalizeSearch(query);
    if (!wanted) return undefined;
    return new Set(doc.nodes.filter((node) => {
      const title = noteTitleOfPath(node.file);
      const noteText = title !== undefined ? noteByTitle.get(title.toLowerCase())?.text : undefined;
      return [node.text, node.label, node.url, node.file, noteText]
        .some((text) => text && normalizeSearch(text).includes(wanted));
    }).map(({ id }) => id));
  }, [query, doc, noteByTitle]);

  // Выбрана одна карточка (не группа) — её стрелки и связанные карточки подсвечены, остальное приглушено, как на
  // графе. Поиск важнее: пока он идёт, подсветки связей нет
  const linkFocus = useMemo(() => {
    if (found || !selectedNode || selectedNode.type === 'group') return undefined;
    const edges = new Set(nodeEdges.map(({ id }) => id));
    const nodes = new Set(nodeEdges.map((edge) => (edge.fromNode === selectedNode.id ? edge.toNode : edge.fromNode)));
    return { id: selectedNode.id, edges, nodes };
  }, [found, selectedNode, nodeEdges]);
  const foundAtRef = useRef(-1);
  const searchStepRef = useRef(searchStep);

  const showNextFound = useLastCallback(() => {
    const hits = doc.nodes.filter(({ id }) => found?.has(id));
    if (!hits.length) return;
    foundAtRef.current = (foundAtRef.current + 1) % hits.length;
    const size = viewport();
    applyView(centerOn(viewRef.current, hits[foundAtRef.current], size.width, size.height), true);
  });

  useEffect(() => {
    foundAtRef.current = -1;
    if (!query.trim()) return undefined;
    const timer = setTimeout(showNextFound, FOUND_DELAY_MS);
    return () => clearTimeout(timer);
  }, [query, showNextFound]);

  useEffect(() => {
    if (searchStep === searchStepRef.current) return;
    searchStepRef.current = searchStep;
    showNextFound();
  }, [searchStep, showNextFound]);

  // Карточка холста — memo-компонент: перерисовывается только при смене своих данных
  const renderNode = (node: CanvasNode) => {
    const title = node.type === 'file' ? noteTitleOf(node) : undefined;
    const note = title !== undefined ? noteOf(title) : undefined;
    const isEdited = inline?.id === node.id;
    return (
      <CanvasCard
        key={node.id}
        node={node}
        isSelected={selection.nodes.includes(node.id) || linkFrom === node.id}
        searchMark={!found ? undefined : found.has(node.id) ? 'found' : 'dim'}
        linkMark={!linkFocus || node.id === linkFocus.id || node.type === 'group' ? undefined
          : linkFocus.nodes.has(node.id) ? 'linked' : 'dim'}
        isLinkable={Boolean(linkFrom) && linkFrom !== node.id}
        isHover={hoverGroup === node.id}
        hasGrips={hasGrips(node)}
        arePortsShown={!linkFrom && !isEdited}
        inline={isEdited && inline ? { kind: inline.kind, text: inlineText } : undefined}
        noteTitle={title}
        note={note}
        noteState={title !== undefined ? noteStateOf(note) : undefined}
        savingText={note && savingNote?.noteId === note.id ? savingNote.text : undefined}
        driveId={driveId}
        driveNode={node.type === 'file' && node.file ? driveFiles.get(node.file) : undefined}
        imageQuality={imageQuality}
        isLargeImage={isLargeImage(node)}
        onInlineChange={handleInlineChange}
        onInlineBlur={handleInlineBlur}
        onInlineKey={handleInlineKey}
        onOpenNote={handleOpenNote}
      />
    );
  };

  const renderEdge = (edge: CanvasEdge) => {
    const from = shownById.get(edge.fromNode);
    const to = shownById.get(edge.toNode);
    if (!from || !to) return undefined;
    return (
      <CanvasEdgeView
        key={edge.id}
        edge={edge}
        from={from}
        to={to}
        isOn={selection.edges.includes(edge.id)}
        linkMark={!linkFocus ? undefined : linkFocus.edges.has(edge.id) ? 'linked' : 'dim'}
        isLabelHidden={inline?.id === edge.id}
      />
    );
  };

  if (!entry) {
    return (
      <div className={styles.board} data-notes-canvas="empty">
        <div className={styles.boardStart}>
          <p className={styles.mutedLine}>
            {lang(notes.length ? 'KnowledgeCanvasEmptyGraph' : 'KnowledgeCanvasEmpty')}
          </p>
          {Boolean(notes.length) && (
            <button
              type="button"
              className={buildClassName(kit.btn, kit.btnAcc)}
              data-canvas-from-graph
              onClick={handleGraphCanvas}
            >
              <PvIcon name="graph" isSmall />
              {lang('KnowledgeCanvasFromGraph')}
            </button>
          )}
          <button
            type="button"
            className={buildClassName(kit.btn, !notes.length && kit.btnAcc)}
            onClick={handleNewCanvas}
          >
            <PvIcon name="plus" isSmall />
            {lang('KnowledgeCanvasNew')}
          </button>
        </div>
      </div>
    );
  }

  const groups = shown.nodes.filter(({ type }) => type === 'group');
  const cards = shown.nodes.filter(({ type }) => type !== 'group');
  const editNode = editing && selectedNode;
  const shownEdges = editing ? nodeEdges.filter((edge) => !editing.removed.includes(edge.id)) : [];
  const editTitle = !editNode ? lang('KnowledgeCanvasEdgeTitle')
    : editNode.type === 'group' ? lang('KnowledgeCanvasGroup')
      : editNode.type === 'file' ? nameOfNode(editNode.id)
        : editNode.type === 'link' ? lang('KnowledgeCanvasLinkCard') : lang('KnowledgeCanvasTextCard');
  const inlineEdge = inline?.kind === 'edge' ? doc.edges.find(({ id }) => id === inline.id) : undefined;
  const inlineEdgeCurve = inlineEdge && edgeCurve(shown, inlineEdge, shownById);
  const inlineEdgePoint = inlineEdgeCurve && curvePoint(inlineEdgeCurve, 0.5);

  // «Изменить» у выделенного: карточка заметки правит её текст (нет заметки — создаёт её, хранилище ещё
  // читается — ничего), карточка файла открывает просмотр
  const selectedNoteTitle = selectedNode?.type === 'file' ? noteTitleOf(selectedNode) : undefined;
  const selectedNoteState = selectedNoteTitle === undefined ? undefined : noteStateOf(noteOf(selectedNoteTitle));
  const isPlainFile = selectedNode?.type === 'file' && !selectedNoteState;
  const canEditSelected = Boolean(selectedEdge || (selectedNode && selectedNoteState !== 'loading'));
  const editIcon = selectedNoteState === 'missing' ? 'plus' : isPlainFile ? 'open' : 'edit';
  const editLabel = selectedEdge ? lang('KnowledgeCanvasEdgeLabel')
    : selectedNoteState === 'found' ? lang('KnowledgeCanvasEditNote')
      : selectedNoteState === 'missing' ? lang('KnowledgeCanvasCreateNote')
        : isPlainFile ? lang('KnowledgeCanvasOpenFile') : lang('KnowledgeCanvasEdit');

  // Панель у выделенного: над ним, а если сверху нет места — под ним; на телефоне прижата к низу поля
  const isBarShown = hasSelection && !live && !inline && !linkFrom && !marquee && !draft;
  const hasGroupSelected = selectedNodes.some(({ type }) => type === 'group');
  let barPlace: string | undefined;
  if (isBarShown && !isNarrow) {
    const nodeBounds = selectionBounds(shown, selection.nodes);
    const firstEdge = !nodeBounds ? doc.edges.find(({ id }) => id === selection.edges[0]) : undefined;
    const edgeMiddle = firstEdge && edgeCurve(shown, firstEdge, shownById);
    const edgePoint = edgeMiddle && curvePoint(edgeMiddle, 0.5);
    const bounds = nodeBounds || (edgePoint ? { ...edgePoint, width: 0, height: 0 } : undefined);
    if (bounds) {
      const top = (bounds.y - (hasGroupSelected ? GROUP_LABEL_ROOM : 0)) * view.scale + view.y;
      const bottom = (bounds.y + bounds.height) * view.scale + view.y;
      const y = top - BAR_GAP >= FIT_TOP + BAR_HEIGHT ? top - BAR_GAP : bottom + BAR_GAP + BAR_HEIGHT;
      barPlace = `--bx: ${Math.round((bounds.x + bounds.width / 2) * view.scale + view.x)}px; --by: ${Math.round(y)}px`;
    }
  }

  const item = (command: CanvasCommand, icon: CanvasMenuItem['icon'], label: string, isDanger?: boolean) => ({
    command, icon, label, isDanger,
  });
  let menuItems: CanvasMenuItem[] = [];
  if (menu?.kind === 'board') {
    menuItems = [
      item('textHere', 'text', lang('KnowledgeCanvasTextHere')),
      item('groupHere', 'group', lang('KnowledgeCanvasGroupHere')),
      item('newNote', 'noteNew', lang('KnowledgeCanvasNewNoteHere')),
      item('note', 'note', lang('KnowledgeCanvasChooseNote')),
      item('link', 'link', lang('KnowledgeCanvasLinkTitle')),
      item('file', 'file', lang('KnowledgeCanvasFileChoose')),
      item('paste', 'paste', lang('KnowledgeCanvasPaste')),
      item('selectAll', 'select', lang('KnowledgeCanvasSelectAll')),
      item('refreshGraph', 'refresh', lang('KnowledgeCanvasRefresh')),
      item('fitView', 'fit', lang('KnowledgeZoomFit')),
    ];
  } else if (menu?.kind === 'drop') {
    menuItems = [
      item('dropNewNote', 'noteNew', lang('KnowledgeCanvasNewNote')),
      item('dropNote', 'note', lang('KnowledgeCanvasDropNote')),
      item('dropText', 'text', lang('KnowledgeCanvasTextCard')),
    ];
  } else if (menu && !selection.nodes.length) {
    menuItems = [
      ...(selectedEdge ? [item('edit', 'edit', lang('KnowledgeCanvasEdgeLabel'))] : []),
      item('direction', 'arrow', lang('KnowledgeCanvasDirection')),
      item('remove', 'trash', lang('KnowledgeCanvasRemove'), true),
    ];
  } else if (menu) {
    menuItems = [
      ...(selectedNode && canEditSelected ? [item('edit', editIcon, editLabel)] : []),
      ...(selectedNoteState === 'found' ? [item('open', 'open', lang('KnowledgeCanvasOpenNote'))] : []),
      item('duplicate', 'copy', lang('KnowledgeCanvasDuplicate')),
      item('copy', 'copy', lang('KnowledgeCanvasCopy')),
      item('cut', 'x', lang('KnowledgeCanvasCut')),
      item('wrap', 'group', lang('KnowledgeCanvasWrap')),
      ...(hasGroupSelected ? [item('fit', 'fit', lang('KnowledgeCanvasFitGroup'))] : []),
      item('front', 'front', lang('KnowledgeCanvasToFront')),
      item('back', 'back', lang('KnowledgeCanvasToBack')),
      ...(selectedNode ? [item('props', 'dots', lang('KnowledgeCanvasProps'))] : []),
      item('remove', 'trash', lang('KnowledgeCanvasRemove'), true),
    ];
  }

  // Поле и фон рисуются по живому виду: перерисовка посреди жеста не откатывает их к закреплённому
  const liveView = viewRef.current;

  return (
    <div className={styles.canvas} data-notes-canvas={entry.id}>
      <div
        ref={boardRef}
        className={buildClassName(
          styles.board, isSelectMode && styles.boardSelecting,
        )}
        style={boardBackgroundStyle(liveView)}
        data-canvas-board
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerCancel}
        onMouseLeave={handlePointerLeave}
        onDoubleClick={handleDoubleClick}
        onContextMenu={handleContextMenu}
        onWheel={handleWheel}
      >
        <div ref={worldRef} className={styles.world} style={worldStyle(liveView)} data-canvas-world>
          <svg className={styles.canvasEdges} width="1" height="1">
            {shown.edges.map(renderEdge)}
            {draft && <path className={styles.canvasEdgeDraft} d={curvePath(draft, false, true)} data-canvas-draft />}
            {draft && <path className={styles.canvasArrow} d={arrowPath(draft.q)} />}
            {live?.guides.map((guide) => (
              <line
                key={`${guide.axis}${guide.at}`}
                className={styles.canvasGuide}
                x1={guide.axis === 'x' ? guide.at : guide.from}
                y1={guide.axis === 'x' ? guide.from : guide.at}
                x2={guide.axis === 'x' ? guide.at : guide.to}
                y2={guide.axis === 'x' ? guide.to : guide.at}
                data-canvas-guide={guide.axis}
              />
            ))}
          </svg>
          {groups.map(renderNode)}
          {cards.map(renderNode)}
          {inlineEdgePoint && (
            <input
              className={styles.canvasEdgeInput}
              style={`left: ${inlineEdgePoint.x}px; top: ${inlineEdgePoint.y}px`}
              value={inlineText}
              placeholder={lang('KnowledgeCanvasLabel')}
              aria-label={lang('KnowledgeCanvasEdgeLabel')}
              data-canvas-inline
              onChange={handleInlineChange}
              onBlur={handleInlineBlur}
              onKeyDown={handleInlineKey}
            />
          )}
          {marquee && (
            <div
              className={styles.canvasMarquee}
              style={`left: ${marquee.x}px; top: ${marquee.y}px; width: ${marquee.width}px; height: ${
                marquee.height}px`}
              data-canvas-marquee
            />
          )}
        </div>
        <div className={styles.boardTools} data-board-tools>
          <div className={styles.boardScroll}>
            {canvases.map((canvas) => (
              <button
                key={canvas.id}
                type="button"
                className={buildClassName(
                  kit.chip,
                  styles.boardChip,
                  canvas.id === entry.id && kit.chipOn,
                  canvas.id === entry.id && styles.boardChipOn,
                )}
                aria-pressed={canvas.id === entry.id}
                data-id={canvas.id}
                data-canvas-chip={canvas.title}
                onClick={handlePickCanvas}
              >
                <PvIcon name="board" isSmall />
                {canvas.title}
              </button>
            ))}
            <button
              type="button"
              className={buildClassName(kit.chip, styles.boardChip)}
              aria-label={lang('KnowledgeCanvasNew')}
              onClick={handleNewCanvas}
            >
              <PvIcon name="plus" isSmall />
              {lang('KnowledgeCanvas')}
            </button>
            <button
              type="button"
              className={buildClassName(kit.chip, styles.boardChip)}
              title={lang('KnowledgeCanvasFromGraph')}
              aria-label={lang('KnowledgeCanvasFromGraph')}
              disabled={!notes.length}
              data-canvas-from-graph
              onClick={handleGraphCanvas}
            >
              <PvIcon name="graph" isSmall />
              {lang('KnowledgeCanvasFromGraphShort')}
            </button>
            <button
              type="button"
              className={buildClassName(kit.chip, styles.boardChip)}
              title={lang('KnowledgeCanvasRefresh')}
              aria-label={lang('KnowledgeCanvasRefresh')}
              data-canvas-refresh
              onClick={handleRefreshGraph}
            >
              <PvIcon name="refresh" isSmall />
            </button>
            <button
              type="button"
              className={buildClassName(kit.chip, styles.boardChip)}
              title={lang('KnowledgeCanvasActions')}
              aria-label={lang('KnowledgeCanvasActions')}
              data-canvas-menu
              onClick={handleOpenMenu}
            >
              <PvIcon name="dots" isSmall />
            </button>
          </div>
          <div className={styles.boardToolRow}>
            <button
              type="button"
              className={styles.boardTool}
              title={lang('KnowledgeCanvasTextCard')}
              aria-label={lang('KnowledgeCanvasText')}
              data-canvas-tool="text"
              onClick={handleAddText}
            >
              <PvIcon name="text" isSmall />
            </button>
            <button
              type="button"
              className={styles.boardTool}
              title={lang('KnowledgeCanvasChooseNote')}
              aria-label={lang('KnowledgeCanvasNote')}
              data-canvas-tool="note"
              onClick={handleAddNote}
            >
              <PvIcon name="note" isSmall />
            </button>
            <button
              type="button"
              className={styles.boardTool}
              title={lang('KnowledgeCanvasNewNote')}
              aria-label={lang('KnowledgeCanvasNewNote')}
              data-canvas-tool="new-note"
              onClick={handleNewNote}
            >
              <PvIcon name="noteNew" isSmall />
            </button>
            <button
              type="button"
              className={styles.boardTool}
              title={lang('KnowledgeCanvasLinkTitle')}
              aria-label={lang('KnowledgeCanvasLinkCard')}
              data-canvas-tool="link"
              onClick={handleAddLink}
            >
              <PvIcon name="open" isSmall />
            </button>
            <button
              type="button"
              className={styles.boardTool}
              title={lang('KnowledgeCanvasFileChoose')}
              aria-label={lang('KnowledgeCanvasFileCard')}
              data-canvas-tool="file"
              onClick={handleAddFile}
            >
              <PvIcon name="file" isSmall />
            </button>
            <button
              type="button"
              className={styles.boardTool}
              title={lang(selection.nodes.length ? 'KnowledgeCanvasWrap' : 'KnowledgeCanvasGroup')}
              aria-label={lang('KnowledgeCanvasGroup')}
              data-canvas-tool="group"
              onClick={handleAddGroup}
            >
              <PvIcon name="group" isSmall />
            </button>
            <button
              type="button"
              className={buildClassName(styles.boardTool, linkFrom && styles.boardToolOn)}
              title={lang('KnowledgeCanvasLink')}
              aria-label={lang('KnowledgeCanvasLink')}
              aria-pressed={Boolean(linkFrom)}
              disabled={!selectedNode || selectedNode.type === 'group'}
              data-canvas-tool="connect"
              onClick={handleLinkMode}
            >
              <PvIcon name="link" isSmall />
            </button>
            <button
              type="button"
              className={buildClassName(styles.boardTool, isSelectMode && styles.boardToolOn)}
              title={lang('KnowledgeCanvasSelectMode')}
              aria-label={lang('KnowledgeCanvasSelectMode')}
              aria-pressed={isSelectMode}
              data-canvas-select-mode
              onClick={handleSelectMode}
            >
              <PvIcon name="select" isSmall />
            </button>
          </div>
        </div>
        {linkFrom && <div className={styles.boardHint} role="status">{lang('KnowledgeCanvasLinkHint')}</div>}
        {isDamaged && <div className={styles.boardHint} role="alert">{lang('KnowledgeCanvasDamaged')}</div>}
        {isBarShown && !menu && (
          <CanvasSelectionBar
            place={barPlace}
            tones={CANVAS_TONES}
            color={colorOfSelection(doc, selection)}
            canEdit={canEditSelected}
            editIcon={editIcon}
            editLabel={editLabel}
            canOpen={selectedNoteState === 'found'}
            canDuplicate={Boolean(selection.nodes.length)}
            canWrap={Boolean(selection.nodes.length)}
            canFit={hasGroupSelected}
            canTurn={Boolean(selection.edges.length) && !selection.nodes.length}
            onColor={handleColor}
            onEdit={handleActivate}
            onOpen={handleOpenSelected}
            onDuplicate={handleDuplicate}
            onWrap={handleAddGroup}
            onFit={handleFitGroups}
            onTurn={handleTurnEdges}
            onRemove={handleRemove}
            onMore={handleMore}
          />
        )}
        {menu && (
          <CanvasContextMenu
            x={menu.x}
            y={menu.y}
            items={menuItems}
            tones={CANVAS_TONES}
            hasColors={menu.kind === 'selection'}
            color={colorOfSelection(doc, selection)}
            canAlign={menu.kind === 'selection' && selection.nodes.length > 1}
            canDistribute={selection.nodes.length > 2}
            onCommand={handleCommand}
            onColor={handleColor}
            onAlign={handleAlign}
            onDistribute={handleDistribute}
          />
        )}
        <div className={styles.boardZoom} data-board-tools>
          <button
            type="button"
            className={styles.boardTool}
            title={lang('KnowledgeCanvasUndo')}
            aria-label={lang('KnowledgeCanvasUndo')}
            disabled={!canUndo}
            data-canvas-undo
            onClick={handleUndo}
          >
            <PvIcon name="undo" isSmall />
          </button>
          <button
            type="button"
            className={styles.boardTool}
            title={lang('KnowledgeCanvasRedo')}
            aria-label={lang('KnowledgeCanvasRedo')}
            disabled={!canRedo}
            data-canvas-redo
            onClick={handleRedo}
          >
            <PvIcon name="redo" isSmall />
          </button>
          <button
            type="button"
            className={styles.boardTool}
            aria-label={lang('KnowledgeZoomIn')}
            onClick={handleZoomIn}
          >
            <PvIcon name="plus" isSmall />
          </button>
          <button
            type="button"
            className={styles.boardTool}
            aria-label={lang('KnowledgeZoomOut')}
            onClick={handleZoomOut}
          >
            <PvIcon name="minus" isSmall />
          </button>
          <button type="button" className={styles.boardTool} aria-label={lang('KnowledgeZoomFit')} onClick={handleFit}>
            <PvIcon name="fit" isSmall />
          </button>
        </div>
      </div>
      <PvSheet isOpen={Boolean(editing)} title={editTitle} onClose={handleEditClose}>
        {editNode?.type === 'file' ? (
          <button type="button" className={kit.btn} onClick={handleEditOpenNote}>
            {lang(noteTitleOf(editNode) === undefined ? 'KnowledgeCanvasOpenFile' : 'KnowledgeCanvasOpenNote')}
          </button>
        ) : editNode?.type === 'text' ? (
          <textarea
            id="knowledge-canvas-text"
            className={kit.textarea}
            value={editing?.text || ''}
            aria-label={lang('KnowledgeCanvasText')}
            onChange={handleEditText}
          />
        ) : (!editNode || editNode.type === 'group') && (
          <input
            id="knowledge-canvas-text"
            className={kit.input}
            value={editing?.text || ''}
            placeholder={lang(editNode ? 'KnowledgeCanvasGroupName' : 'KnowledgeCanvasLabel')}
            aria-label={lang(editNode ? 'KnowledgeCanvasGroupName' : 'KnowledgeCanvasLabel')}
            onChange={handleEditText}
          />
        )}
        <div className={buildClassName(kit.muted, kit.small)}>{lang('KnowledgeCanvasColor')}</div>
        <div className={kit.chips} role="radiogroup" aria-label={lang('KnowledgeCanvasColor')}>
          {CANVAS_PRESET_COLORS.map((color) => (
            <button
              key={color}
              type="button"
              role="radio"
              aria-checked={editing?.color === color}
              className={buildClassName(kit.chip, editing?.color === color && kit.chipOn)}
              style={`--c: ${CANVAS_TONES[color]}`}
              data-color={color}
              aria-label={`${lang('KnowledgeCanvasColor')} ${color}`}
              onClick={handleEditColor}
            >
              <span className={kit.dot} />
            </button>
          ))}
          <button
            type="button"
            role="radio"
            aria-checked={!editing?.color}
            className={buildClassName(kit.chip, !editing?.color && kit.chipOn)}
            data-color=""
            onClick={handleEditColor}
          >
            {lang('KnowledgeCanvasNoColor')}
          </button>
        </div>
        {Boolean(shownEdges.length) && (
          <>
            <div className={buildClassName(kit.muted, kit.small)}>{lang('KnowledgeCanvasEdgesHint')}</div>
            {shownEdges.map((edge) => (
              <div key={edge.id} className={styles.edgeRow}>
                <span className={buildClassName(kit.ttl, kit.small, styles.edgeName)}>
                  {`${nameOfNode(edge.fromNode)} → ${nameOfNode(edge.toNode)}`}
                </span>
                <input
                  className={buildClassName(kit.input, styles.edgeInput)}
                  value={editing?.labels[edge.id] || ''}
                  placeholder={lang('KnowledgeCanvasLabel')}
                  aria-label={lang('KnowledgeCanvasLabel')}
                  data-edge={edge.id}
                  onChange={handleEditLabel}
                />
                <button
                  type="button"
                  className={kit.ib}
                  aria-label={lang('KnowledgeCanvasRemoveEdge')}
                  data-edge={edge.id}
                  onClick={handleEditRemoveEdge}
                >
                  <PvIcon name="x" isSmall />
                </button>
              </div>
            ))}
          </>
        )}
        <button type="button" className={buildClassName(kit.btn, kit.btnAcc)} onClick={handleEditSave}>
          {lang('Done')}
        </button>
      </PvSheet>
      <PvSheet
        isOpen={Boolean(linkDraft)}
        title={lang('KnowledgeCanvasLinkTitle')}
        onClose={handleLinkClose}
        onEnter={handleLinkSave}
      >
        <input
          id="knowledge-canvas-url"
          className={kit.input}
          type="url"
          inputMode="url"
          value={linkDraft?.url || ''}
          placeholder="https://"
          aria-label={lang('KnowledgeCanvasLinkUrl')}
          onChange={handleLinkUrl}
        />
        <button
          type="button"
          className={buildClassName(kit.btn, kit.btnAcc)}
          data-canvas-link-save
          onClick={handleLinkSave}
        >
          {lang(linkDraft?.id ? 'Done' : 'KnowledgeCanvasLinkAdd')}
        </button>
      </PvSheet>
      <PvSheet isOpen={isMenuOpen} title={entry.title} onClose={closeMenu}>
        <input
          id="knowledge-canvas-name"
          className={kit.input}
          value={canvasName}
          maxLength={CANVAS_TITLE_MAX}
          placeholder={lang('KnowledgeCanvasTitle')}
          aria-label={lang('KnowledgeCanvasTitle')}
          onChange={handleCanvasName}
          onKeyDown={handleCanvasNameKey}
        />
        <button
          type="button"
          className={buildClassName(kit.btn, kit.btnAcc)}
          data-canvas-rename
          onClick={handleRenameCanvas}
        >
          <PvIcon name="edit" isSmall />
          {lang('KnowledgeCanvasRename')}
        </button>
        <div className={buildClassName(kit.muted, kit.small)}>{lang('KnowledgeCanvasImages')}</div>
        <div className={kit.chips} role="radiogroup" aria-label={lang('KnowledgeCanvasImages')}>
          {IMAGE_QUALITIES.map((quality) => (
            <button
              key={quality}
              type="button"
              role="radio"
              aria-checked={imageQuality === quality}
              className={buildClassName(kit.chip, imageQuality === quality && kit.chipOn)}
              data-quality={quality}
              data-canvas-images={quality}
              onClick={handleImageQuality}
            >
              {lang(quality === 'full' ? 'KnowledgeCanvasImagesFull' : 'KnowledgeCanvasImagesThumb')}
            </button>
          ))}
        </div>
        <div className={buildClassName(kit.faint, kit.small)}>{lang('KnowledgeCanvasImagesHint')}</div>
        <button
          type="button"
          className={buildClassName(kit.btn, kit.btnDanger)}
          data-canvas-delete
          onClick={handleAskDelete}
        >
          <PvIcon name="trash" isSmall />
          {lang('KnowledgeDelete')}
        </button>
      </PvSheet>
      <ConfirmDialog
        isOpen={isDeleteOpen}
        text={lang('KnowledgeCanvasDeleteConfirm', { name: entry.title })}
        confirmLabel={lang('KnowledgeDelete')}
        confirmIsDestructive
        confirmHandler={handleDeleteCanvas}
        onClose={closeDelete}
      />
      <PvSheet
        isOpen={isPickingNote}
        title={lang('KnowledgeCanvasChooseNote')}
        isTight
        onClose={handleCloseNotePicker}
      >
        <button type="button" className={kit.row} data-canvas-pick-new onClick={handleNewNoteFromPicker}>
          <span className={buildClassName(kit.ava, kit.avaM)} style="--c: var(--pv-accent)">
            <PvIcon name="noteNew" isSmall />
          </span>
          <span className={kit.rowText}>
            <span className={kit.ttl}>{lang('KnowledgeCanvasNewNote')}</span>
            <span className={kit.sub}>{lang('KnowledgeCanvasNewNoteHint')}</span>
          </span>
        </button>
        {isPickingNote && notes.map((note) => {
          const isOnCanvas = filesOnCanvas.has(note.title.toLowerCase());
          return (
            <button
              key={note.id}
              type="button"
              className={buildClassName(kit.row, isOnCanvas && styles.rowDim)}
              data-title={note.title}
              onClick={handlePickNote}
            >
              <span
                className={buildClassName(kit.ava, kit.avaM)}
                style={`--c: ${folderColor(note.folder, note.isDaily)}`}
              >
                <PvIcon name="note" isSmall />
              </span>
              <span className={kit.rowText}>
                <span className={kit.ttl}>{note.title}</span>
                <span className={kit.sub}>
                  {isOnCanvas ? lang('KnowledgeCanvasAlreadyOn') : note.folder || lang('KnowledgeRoot')}
                </span>
              </span>
            </button>
          );
        })}
      </PvSheet>
      <PvSheet
        isOpen={Boolean(noteDraft)}
        title={lang('KnowledgeCanvasNewNote')}
        onClose={handleNewNoteClose}
        onEnter={handleNewNoteSave}
      >
        <input
          id="knowledge-canvas-note-name"
          className={kit.input}
          value={noteDraft?.title || ''}
          maxLength={NOTE_TITLE_MAX}
          placeholder={lang('KnowledgeNoteTitle')}
          aria-label={lang('KnowledgeNoteTitle')}
          onChange={handleNewNoteTitle}
        />
        <div className={buildClassName(kit.faint, kit.small)}>
          {lang(noteDraft?.from ? 'KnowledgeCanvasNewNoteLinkedHint' : 'KnowledgeCanvasNewNoteHint')}
        </div>
        <button
          type="button"
          className={buildClassName(kit.btn, kit.btnAcc)}
          data-canvas-note-create
          onClick={handleNewNoteSave}
        >
          {lang('KnowledgeCanvasNewNoteCreate')}
        </button>
      </PvSheet>
      <CanvasFilePicker isOpen={isPickingFile} nodes={driveNodes} onPick={handlePickFile} onClose={closeFilePicker} />
      <CloudPreview
        container={filePreview?.container}
        node={filePreview?.node}
        maxBytes={isNarrow ? PREVIEW_MAX_BYTES_NARROW : PREVIEW_MAX_BYTES}
        onDownload={handleDownload}
        onClose={handleClosePreview}
      />
    </div>
  );
};

export default memo(NotesCanvas);

function normalizeSearch(value: string) {
  return value.trim().toLowerCase().replace(/ё/g, 'е');
}

// Вид с прямоугольником посередине экрана; мелкий масштаб подрастает, чтобы находку было видно
function centerOn(view: BoardView, rect: BoardRect, width: number, height: number): BoardView {
  const scale = clampBoardScale(Math.max(view.scale, FOUND_MIN_SCALE));
  return {
    scale,
    x: width / 2 - (rect.x + rect.width / 2) * scale,
    y: height / 2 - (rect.y + rect.height / 2) * scale,
  };
}
