import {
  memo, useEffect, useLayoutEffect, useMemo, useRef, useState,
} from '../../../lib/teact/teact';

import type { PlannerState } from '../planner/plannerModel';
import type { BoardView } from './boardView';
import type { GraphCanvasScope } from './notesCanvasGraph';
import type {
  NotesGraphEdge, NotesGraphLayout, NotesGraphNode, NotesGraphRecord,
} from './notesGraphEngine';
import type {
  GraphFilter, GraphNoteSource, GraphPlaces, GraphPoint,
} from './notesGraphView';
import type { NoteEntry } from './notesStore';

import { requestMutation } from '../../../lib/fasterdom/fasterdom';
import buildClassName from '../../../util/buildClassName';
import captureEscKeyListener from '../../../util/captureEscKeyListener';
import { getIsParvaneScreenShown } from '../../../util/parvaneSection';
import { debounce } from '../../../util/schedulers';
import {
  BOARD_ZOOM_STEP, boardBackgroundStyle, createPinch, fitRects, zoomAround, zoomByWheel,
} from './boardView';
import { notesGraphEdgePath } from './notesGraphEngine';
import {
  applyGraphPlaces, buildGraphInput, canLinkTo, edgeHeads, edgePoint, graphRects, MISSING_NODE_PREFIX,
  moveGraphNode, neighboursOf, nodeAt, NOTES_GRAPH_ASPECT_TALL, NOTES_GRAPH_ASPECT_WIDE, resolveGraphScope,
  scopeKey, straightGraphEdge,
} from './notesGraphView';
import { displayTitle } from './notesLook';
import { normalizeNoteTitle, parseNoteCached } from './notesModel';
import {
  readGraphFilter, readGraphPlaces, writeGraphFilter, writeGraphPlaces,
} from './notesPrefs';
import useNotesGraphLayout from './useNotesGraphLayout';

import useFlag from '../../../hooks/useFlag';
import useLang from '../../../hooks/useLang';
import useLastCallback from '../../../hooks/useLastCallback';
import useResizeObserver from '../../../hooks/useResizeObserver';
import { useStateRef } from '../../../hooks/useStateRef';

import { edgeKey, edgePair, GraphEdges, GraphNodes } from './NotesGraphLayers';
import NotesGraphScope, { NotesGraphScopeChip } from './NotesGraphScope';
import PvIcon from './PvIcon';

import board from './Knowledge.module.scss';
import styles from './NotesGraph.module.scss';
import kit from './PvKit.module.scss';

// Выбранная точка графа — то, что показывает панель справа
export type GraphPick = Pick<NotesGraphNode, 'id' | 'kind' | 'title' | 'group'>;
export type GraphLinkOutcome = 'added' | 'exists' | 'refused' | 'failed';

type OwnProps = {
  notes: NoteEntry[];
  planner: PlannerState;
  pickedId?: string;
  // Режим «Связать»: следующая нажатая заметка получает ссылку из этой
  linkFromId?: string;
  // Поиск из шапки раздела: найденные точки подсвечены; рост `searchStep` (Enter в поле) выбирает следующую
  query: string;
  searchStep: number;
  // Телефон: инструменты — одной строкой сверху, масштаб — кнопками-значками
  isNarrow?: boolean;
  onPick: (node: GraphPick) => void;
  // Двойное нажатие: заметка открывается на вкладке «Заметки»
  onOpen: (node: GraphPick) => void;
  onLink: (fromId: string, toTitle: string) => Promise<GraphLinkOutcome>;
  // Связь, брошенная на пустое место: новая заметка с этим названием; возвращает её id
  onLinkNew: (fromId: string, title: string) => Promise<string | undefined>;
  onUnlink: (fromId: string, toTitle: string) => void;
  onLinkModeEnd: NoneToVoidFunction;
  // Escape без иных дел закрывает панель выбранной точки
  onClose: NoneToVoidFunction;
  // «Холст из графа»: холст из заметок, которые сейчас видны на графе
  onMakeCanvas: (scope: GraphCanvasScope) => void;
};

type Drag = {
  // Что тянут: поле, точку, связь из кольца точки; нажатая связь при движении тянет поле
  mode: 'pan' | 'node' | 'link' | 'edge';
  id?: string;
  edge?: string;
  startX: number;
  startY: number;
  // Положение точки либо сдвиг поля в начале движения
  originX: number;
  originY: number;
  hasMoved: boolean;
  // Точка, которую тянут: её элемент, связи с их элементами и место под указателем — пока тянут, двигается
  // только это, без перерисовки графа; место закрепляется состоянием при отпускании
  node?: NotesGraphNode;
  element?: SVGGElement;
  edges?: { edge: NotesGraphEdge; element: SVGGElement; other: NotesGraphNode }[];
  at?: GraphPoint;
};

// Связь, которую ведут: от точки `from` до места указателя на поле; `overId` — заметка под указателем
type Draft = GraphPoint & { from: string; overId?: string };

const LINK = /\[\[([^\]|\n]+)/g;
const RECORD_LINK = /\[\[[^\]\n]*\]\]/g;
// Мельче этого масштаба подписи остаются только у выбранной точки, её соседей и найденного поиском
const LABEL_MIN_SCALE = 0.55;
// Крупнее этого видны и подписи, которым движок не нашёл места без наложений
const LABEL_ALL_SCALE = 1.6;
// Запас попадания в точку при отпускании связи, в пикселях экрана
const DROP_SLOP = 10;
const FIT_TOP = 60;
const FIT_BOTTOM = 56;
// Выбранная точка ближе этого к краю поля считается скрытой — поле сдвигается к ней
const REVEAL_PAD = 32;
const DRAG_THRESHOLD = 5;
const DOUBLE_TAP_MS = 380;
const FLASH_MS = 1200;
const NEW_TITLE_MAX = 120;
// Где на выбранной связи стоит крестик: посередине, а у взаимной — по крестику ближе к заметке, чью ссылку он убирает
const REMOVE_AT_MIDDLE = 0.5;
const REMOVE_AT_SOURCE = 0.3;
// Редактор заметки в панели графа: пока он открыт, Escape панель не закрывает
const PANEL_EDITOR = '[data-graph-panel] #knowledge-note-editor';
const NO_RECORDS: NotesGraphRecord[] = [];
const EMPTY_LAYOUT: NotesGraphLayout = {
  nodes: [],
  edges: [],
  blocks: [],
  bounds: {
    x: 0, y: 0, w: 0, h: 0,
  },
  folders: [],
  tags: [],
};

// Граф связей: заметки, заметки, которых ещё нет (блёклые), по желанию дни и записи «Плана». Места точек,
// подписи и линии считает движок (`layoutNotesGraph`, правило NOTES-1) — экран рисует по готовым координатам.
// Поле двигается и масштабируется, точку можно переставить руками (место запоминается на устройстве). Нажатие
// выбирает точку — её показывает панель; двойное открывает заметку. Связь — это ссылка в тексте: её ведут от
// кольца вокруг заметки к другой заметке (или на пустое место — к новой), а убирают, выбрав линию
const NotesGraph = ({
  notes, planner, pickedId, linkFromId, query, searchStep, isNarrow, onPick, onOpen, onLink, onLinkNew, onUnlink,
  onLinkModeEnd, onClose, onMakeCanvas,
}: OwnProps) => {
  const boardRef = useRef<HTMLDivElement>();
  const worldRef = useRef<HTMLDivElement>();
  const newInputRef = useRef<HTMLInputElement>();
  const [withDays, setWithDays] = useState(false);
  const [withRecords, setWithRecords] = useState(false);
  // Область графа запоминается на устройстве
  const [savedFilter, setSavedFilter] = useState(readGraphFilter);
  const [isScopeOpen, openScope, closeScope] = useFlag();
  // Вид поля: закреплённый — состоянием (от него зависят подписи и кнопки над полем), живой — в ссылке.
  // Во время жеста меняется только живой и пишется прямо в DOM; состояние догоняет при отпускании
  const [view, setView] = useState<BoardView>({ scale: 1, x: 0, y: 0 });
  const viewRef = useRef<BoardView>(view);
  const [draft, setDraft] = useState<Draft>();
  // Связь брошена на пустое место: здесь спрашивают название новой заметки
  const [newAt, setNewAt] = useState<Draft>();
  const [pickedEdge, setPickedEdge] = useState<string>();
  const [flash, setFlash] = useState<string>();
  const searchStepRef = useRef(searchStep);
  const dragRef = useRef<Drag>();
  const draftRef = useRef<Draft>();
  const pinchRef = useRef(createPinch());
  const lastTapRef = useRef<{ id?: string; at: number }>({ at: 0 });
  const sizeRef = useRef<{ width: number; height: number }>();
  const fitKeyRef = useRef<string>();
  const shouldFitRef = useRef(false);
  // Вид поставлен вписыванием и с тех пор не менялся руками
  const isAutoFitRef = useRef(false);
  const shouldDropPickRef = useRef(false);

  const lang = useLang();

  const sources = useMemo((): GraphNoteSource[] => notes.map((note) => {
    const parsed = parseNoteCached(note);
    return {
      id: note.id,
      title: note.title,
      folder: note.folder,
      isDaily: note.isDaily,
      links: parsed.links,
      tags: parsed.tags,
    };
  }), [notes]);

  // Область, которой больше не из чего собраться (папку убрали, заметку удалили), читается как «все заметки»
  const filter = useMemo((): GraphFilter => {
    const scope = resolveGraphScope(savedFilter.scope, sources);
    return scope === savedFilter.scope ? savedFilter : { ...savedFilter, scope };
  }, [savedFilter, sources]);
  const placesKey = scopeKey(filter.scope);

  // Ручная расстановка — своя у каждой области; переживает перезагрузку
  const [placed, setPlaced] = useState<{ key: string; places: GraphPlaces }>(() => (
    { key: placesKey, places: readGraphPlaces(placesKey) }
  ));
  const places = useMemo(() => (
    placed.key === placesKey ? placed.places : readGraphPlaces(placesKey)
  ), [placed, placesKey]);
  const savePlaces = (next: GraphPlaces) => {
    setPlaced({ key: placesKey, places: next });
    writeGraphPlaces(placesKey, next);
  };

  // Записи «Плана» нужны графу только при включённых «Событиях и задачах»: без них изменения плана граф не трогают
  const plannerForGraph = withRecords ? planner : undefined;
  const records = useMemo(() => (plannerForGraph ? recordsOf(plannerForGraph) : NO_RECORDS), [plannerForGraph]);

  // Переставленные руками точки уходят в движок закреплёнными, когда раскладка и так пересчитывается (новая связь,
  // другая область): сама перестановка граф не перекладывает — точка просто стоит, где её отпустили. «Разложить
  // заново» снимает закрепление — раскладка считается без него
  const placesRef = useStateRef(places);
  const hasPins = Object.keys(places).length > 0;
  const [relayoutCount, setRelayoutCount] = useState(0);
  const input = useMemo(() => buildGraphInput(sources, records, filter, {
    withDays,
    withRecords,
    aspect: isNarrow ? NOTES_GRAPH_ASPECT_TALL : NOTES_GRAPH_ASPECT_WIDE,
    places: placesRef.current,
  // `relayoutCount` — пересчёт после «Разложить заново» (места уже сняты)
  // eslint-disable-next-line react-hooks-static-deps/exhaustive-deps
  }), [sources, records, filter, withDays, withRecords, isNarrow, placesRef, relayoutCount]);
  const { layout, isBusy } = useNotesGraphLayout(input);

  const graph = useMemo(() => applyGraphPlaces(layout || EMPTY_LAYOUT, places), [layout, places]);
  const { nodes, edges } = graph;
  const byId = useMemo(() => new Map(nodes.map((node) => [node.id, node])), [nodes]);
  const neighbours = useMemo(() => (pickedId ? neighboursOf(pickedId, edges) : undefined), [pickedId, edges]);
  const dailyById = useMemo(() => (
    new Map(notes.filter((note) => note.isDaily).map((note) => [note.id, note]))
  ), [notes]);
  const picked = pickedId && byId.has(pickedId) ? pickedId : undefined;
  const linkFrom = linkFromId ? byId.get(linkFromId) : undefined;
  const selectedEdge = pickedEdge ? edges.find((edge) => edgeKey(edge) === pickedEdge) : undefined;

  // Подписи точек: у заметки дня — дата словами, у записи «Плана» — название без разметки ссылок
  const labels = useMemo(() => {
    const result = new Map<string, string>();
    nodes.forEach((node) => {
      const daily = dailyById.get(node.id);
      if (daily) result.set(node.id, displayTitle(lang, daily));
      else if (node.kind === 'record') {
        result.set(node.id, node.title.replace(RECORD_LINK, '').replace(/\s+/g, ' ').trim() || node.title);
      } else result.set(node.id, node.title);
    });
    return result;
  }, [nodes, dailyById, lang]);

  const found = useMemo(() => {
    const wanted = normalizeQuery(query);
    if (!wanted) return undefined;
    return new Set(nodes.filter((node) => normalizeQuery(labels.get(node.id) || node.title).includes(wanted)
      || normalizeQuery(node.title).includes(wanted)).map(({ id }) => id));
  }, [query, nodes, labels]);

  // Ссылки выбранной связи: одна, при взаимной связи — две (у каждой заметки своя, убираются по отдельности)
  const removals = useMemo(() => {
    const from = selectedEdge && byId.get(selectedEdge.from);
    const to = selectedEdge && byId.get(selectedEdge.to);
    if (!selectedEdge || !from || !to) return [];
    if (!selectedEdge.mutual) return [{ from, to, spot: edgePoint(selectedEdge, REMOVE_AT_MIDDLE) }];
    return [
      { from, to, spot: edgePoint(selectedEdge, REMOVE_AT_SOURCE) },
      { from: to, to: from, spot: edgePoint(selectedEdge, 1 - REMOVE_AT_SOURCE) },
    ];
  }, [selectedEdge, byId]);

  // Новый вид: сразу в DOM (поле, фон, масштаб для сценариев) и в живую ссылку; `isFinal` закрепляет состоянием
  const applyView = (next: BoardView, isFinal: boolean) => {
    viewRef.current = next;
    isAutoFitRef.current = false;
    if (isFinal) {
      setView(next);
      return;
    }
    requestMutation(() => {
      if (viewRef.current !== next) return;
      const world = worldRef.current;
      const field = boardRef.current;
      if (world) world.style.transform = worldTransform(next);
      if (!field) return;
      field.style.cssText = boardBackgroundStyle(next);
      field.dataset.graphScale = String(next.scale);
      // Крестики выбранной связи стоят над полем в экранных координатах — едут вместе с ним
      field.querySelectorAll<HTMLElement>('[data-graph-edge-remove]').forEach((button) => {
        const removal = removals.find(({ from }) => from.id === button.dataset.graphEdgeRemove);
        if (!removal) return;
        button.style.left = `${next.x + removal.spot.x * next.scale}px`;
        button.style.top = `${next.y + removal.spot.y * next.scale}px`;
      });
    });
  };
  const commitView = useLastCallback(() => setView(viewRef.current));
  // Колесо: вид едет сразу, состояние закрепляется, когда колесо остановилось
  const commitViewSoon = useMemo(() => debounce(commitView, 120, false), [commitView]);

  // «Вписать»: всё показанное целиком на поле; расстановку не трогает
  const fit = useLastCallback(() => {
    const box = boardRef.current?.getBoundingClientRect();
    if (!box) return;
    applyView(fitRects(graphRects(nodes), box.width, box.height, FIT_TOP, isNarrow ? 0 : FIT_BOTTOM), true);
    isAutoFitRef.current = true;
  });

  // Граф вписывается в поле при открытии и при смене того, что на нём показано. Новая заметка или связь вид
  // не трогают: масштаб и место выбирает пользователь
  const hasNodes = nodes.length > 0;
  useEffect(() => {
    if (isBusy) return;
    const key = [hasNodes, withDays, withRecords, placesKey, filter.hideOrphans, filter.hideMissing, isNarrow].join();
    if (fitKeyRef.current === key) return;
    fitKeyRef.current = key;
    fit();
  }, [isBusy, hasNodes, withDays, withRecords, placesKey, filter.hideOrphans, filter.hideMissing, isNarrow]);

  // Вид, в котором точка видна: прежний, если она и так на поле, иначе поле сдвигается к ней без смены масштаба
  const revealIn = (current: BoardView, node: GraphPoint | undefined, width: number, height: number) => {
    if (!node || !width || !height) return current;
    const x = current.x + node.x * current.scale;
    const y = current.y + node.y * current.scale;
    const isShown = x >= REVEAL_PAD && x <= width - REVEAL_PAD && y >= FIT_TOP && y <= height - REVEAL_PAD;
    if (isShown) return current;
    return { ...current, x: width / 2 - node.x * current.scale, y: height / 2 - node.y * current.scale };
  };

  // Выбранная точка (нажатием, поиском или ссылкой в панели) не остаётся за краем поля
  useEffect(() => {
    const box = boardRef.current?.getBoundingClientRect();
    const node = picked ? byId.get(picked) : undefined;
    if (!box || !node) return;
    const current = viewRef.current;
    const next = revealIn(current, node, box.width, box.height);
    if (next !== current) applyView(next, true);
    // eslint-disable-next-line react-hooks-static-deps/exhaustive-deps
  }, [picked]);

  // Панель справа открылась или закрылась: поле стало уже или шире. Вписанный граф вписывается заново; вид,
  // который выбрали руками, остаётся посередине в прежнем масштабе и сдвигается к выбранной точке, только если
  // она оказалась за краем
  const handleResize = useLastCallback((entry: ResizeObserverEntry) => {
    const { width, height } = entry.contentRect;
    const previous = sizeRef.current;
    sizeRef.current = { width, height };
    if (!previous) return;
    // Вид после «Вписать» никто не трогал — граф вписывается в новое поле заново
    if (isAutoFitRef.current && (previous.width !== width || previous.height !== height)) {
      fit();
      return;
    }
    if (previous.width === width) return;
    const current = viewRef.current;
    const centred = { ...current, x: current.x + (width - previous.width) / 2 };
    applyView(revealIn(centred, picked ? byId.get(picked) : undefined, width, height), true);
  });
  useResizeObserver(boardRef, handleResize);

  useEffect(() => {
    if (!flash) return undefined;
    const timer = window.setTimeout(() => setFlash(undefined), FLASH_MS);
    return () => window.clearTimeout(timer);
  }, [flash]);

  // Режим «Связать» кончился — недоведённая связь исчезает
  useEffect(() => {
    if (!linkFromId) {
      draftRef.current = undefined;
      setDraft(undefined);
    }
  }, [linkFromId]);

  useEffect(() => {
    if (newAt) newInputRef.current?.focus();
  }, [newAt]);

  const pickOf = (node: NotesGraphNode): GraphPick => ({
    id: node.id, kind: node.kind, title: node.title, group: node.group,
  });

  const toWorld = (clientX: number, clientY: number, box: { left: number; top: number }): GraphPoint => {
    const current = viewRef.current;
    return {
      x: (clientX - box.left - current.x) / current.scale,
      y: (clientY - box.top - current.y) / current.scale,
    };
  };

  // Заметка под указателем, к которой можно привести связь из `fromId`
  const targetAt = (point: GraphPoint, fromId: string) => {
    const node = nodeAt(nodes, point.x, point.y, DROP_SLOP / viewRef.current.scale);
    return node && node.id !== fromId && canLinkTo(node) ? node : undefined;
  };

  // Связь, которую ведут: точка под указателем меняет подсветку — через состояние; сама линия тянется прямой
  // правкой DOM, без перерисовки графа на каждое движение
  const moveDraft = (next: Draft) => {
    const previous = draftRef.current;
    draftRef.current = next;
    if (!previous || previous.from !== next.from || previous.overId !== next.overId) {
      setDraft(next);
      return;
    }
    requestMutation(() => {
      if (draftRef.current !== next) return;
      const line = boardRef.current?.querySelector('[data-graph-draft]');
      if (!line) {
        setDraft(next);
        return;
      }
      line.setAttribute('x2', String(next.x));
      line.setAttribute('y2', String(next.y));
    });
  };
  const clearDraft = () => {
    draftRef.current = undefined;
    setDraft(undefined);
  };

  const connect = useLastCallback(async (fromId: string, to: NotesGraphNode) => {
    clearDraft();
    const outcome = await onLink(fromId, to.title);
    if (outcome === 'added' || outcome === 'exists') setFlash(edgePair(fromId, to.id));
  });

  const cancelNew = useLastCallback(() => {
    setNewAt(undefined);
    clearDraft();
  });

  const submitNew = useLastCallback(async (title: string) => {
    const at = newAt;
    cancelNew();
    if (!at || !title.trim()) return;
    const spot = { x: at.x, y: at.y };
    // Новая заметка встаёт туда, где бросили связь: место ждёт её под названием
    const waiting = { ...places, [MISSING_NODE_PREFIX + normalizeNoteTitle(title)]: spot };
    savePlaces(waiting);
    const id = await onLinkNew(at.from, title);
    if (!id) return;
    savePlaces({ ...waiting, [id]: spot });
    setFlash(edgePair(at.from, id));
  });

  const removeLink = useLastCallback((fromId?: string) => {
    const removal = removals.find(({ from }) => from.id === fromId) || removals[0];
    setPickedEdge(undefined);
    if (removal) onUnlink(removal.from.id, removal.to.title);
  });

  const handleRemoveClick = useLastCallback((e: React.MouseEvent<HTMLButtonElement>) => {
    removeLink(e.currentTarget.dataset.graphEdgeRemove);
  });

  const handlePointerDown = useLastCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const target = e.target as Element;
    if (target.closest('[data-board-tools]')) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    const current = viewRef.current;
    if (pinchRef.current.down(e.pointerId, e.clientX, e.clientY, current)) {
      dragRef.current = undefined;
      clearDraft();
      return;
    }
    const handleId = target.closest<SVGElement>('[data-graph-ring]')?.dataset.graphRing;
    const id = handleId || target.closest<SVGElement>('[data-node]')?.dataset.node;
    const edge = id ? undefined : target.closest<SVGElement>('[data-graph-edge]')?.dataset.graphEdge;
    const node = id ? byId.get(id) : undefined;
    const mode = handleId && !linkFromId ? 'link' : id ? 'node' : edge ? 'edge' : 'pan';
    dragRef.current = {
      mode,
      id,
      edge,
      startX: e.clientX,
      startY: e.clientY,
      originX: mode === 'node' && node ? node.x : current.x,
      originY: mode === 'node' && node ? node.y : current.y,
      hasMoved: false,
    };
  });

  // Точку начали тянуть: её элемент и связи берутся из DOM один раз, дальше правятся напрямую
  const prepareNodeDrag = (drag: Drag) => {
    const svg = boardRef.current?.querySelector('svg');
    const node = drag.id ? byId.get(drag.id) : undefined;
    if (!svg || !node) return;
    const nodeElements = elementsByKey<SVGGElement>(svg, 'data-node');
    const edgeElements = elementsByKey<SVGGElement>(svg, 'data-graph-edge');
    drag.node = node;
    drag.element = nodeElements.get(node.id);
    drag.edges = [];
    edges.forEach((edge) => {
      if (edge.from !== node.id && edge.to !== node.id) return;
      const element = edgeElements.get(edgeKey(edge));
      const other = byId.get(edge.from === node.id ? edge.to : edge.from);
      if (element && other) drag.edges!.push({ edge, element, other });
    });
  };

  const writeDraggedNode = (drag: Drag, at: GraphPoint) => {
    if (!drag.node) return;
    drag.element?.setAttribute('transform', `translate(${at.x} ${at.y})`);
    const movedNode = moveGraphNode(drag.node, at);
    drag.edges?.forEach(({ edge, element, other }) => {
      const isFrom = edge.from === drag.node!.id;
      writeEdge(element, straightGraphEdge(edge, isFrom ? movedNode : other, isFrom ? other : movedNode));
    });
  };

  const dragNodeTo = (drag: Drag, at: GraphPoint) => {
    drag.at = at;
    requestMutation(() => {
      if (dragRef.current === drag && drag.at === at) writeDraggedNode(drag, at);
    });
  };

  const handlePointerMove = useLastCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const box = e.currentTarget.getBoundingClientRect();
    const pinched = pinchRef.current.move(e.pointerId, e.clientX, e.clientY, box);
    if (pinched) {
      applyView(pinched, false);
      return;
    }
    const drag = dragRef.current;
    if (!drag) {
      // Режим «Связать» с мышью: линия тянется за указателем до нажатия
      if (linkFromId && e.pointerType === 'mouse' && !(e.target as Element).closest('[data-board-tools]')) {
        const point = toWorld(e.clientX, e.clientY, box);
        moveDraft({ ...point, from: linkFromId, overId: targetAt(point, linkFromId)?.id });
      }
      return;
    }
    const dx = e.clientX - drag.startX;
    const dy = e.clientY - drag.startY;
    if (!drag.hasMoved && Math.abs(dx) + Math.abs(dy) < DRAG_THRESHOLD) return;
    if (!drag.hasMoved && drag.mode === 'node') prepareNodeDrag(drag);
    drag.hasMoved = true;
    if (drag.mode === 'link') {
      const point = toWorld(e.clientX, e.clientY, box);
      moveDraft({ ...point, from: drag.id!, overId: targetAt(point, drag.id!)?.id });
    } else if (drag.mode === 'node') {
      const { scale } = viewRef.current;
      dragNodeTo(drag, { x: drag.originX + dx / scale, y: drag.originY + dy / scale });
    } else {
      applyView({ ...viewRef.current, x: drag.originX + dx, y: drag.originY + dy }, false);
    }
  });

  const handlePointerUp = useLastCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const wasPinch = pinchRef.current.isActive();
    pinchRef.current.up(e.pointerId);
    const drag = dragRef.current;
    dragRef.current = undefined;
    if (wasPinch) {
      commitView();
      return;
    }
    if (!drag) return;
    if (drag.hasMoved) {
      if (drag.mode === 'node') {
        // Место, куда точку поставили руками, она сохраняет; граф перерисовывается один раз — по отпусканию
        if (drag.at) savePlaces({ ...places, [drag.id!]: drag.at });
        return;
      }
      if (drag.mode !== 'link') {
        commitView();
        return;
      }
      // Связь отпущена: на заметке — ссылка, на пустом месте — вопрос о названии новой заметки
      const point = toWorld(e.clientX, e.clientY, e.currentTarget.getBoundingClientRect());
      const over = nodeAt(nodes, point.x, point.y, DROP_SLOP / viewRef.current.scale);
      const to = targetAt(point, drag.id!);
      if (to) void connect(drag.id!, to);
      else if (over) clearDraft();
      else {
        clearDraft();
        setNewAt({ ...point, from: drag.id! });
      }
      return;
    }
    const node = drag.id ? byId.get(drag.id) : undefined;
    if (linkFromId) {
      // Режим «Связать»: нажатая заметка получает ссылку, нажатие мимо точек выходит из режима
      if (!node) onLinkModeEnd();
      else if (node.id !== linkFromId && canLinkTo(node)) {
        void connect(linkFromId, node);
        onLinkModeEnd();
      }
      return;
    }
    if (drag.edge) {
      setPickedEdge(drag.edge);
      return;
    }
    setPickedEdge(undefined);
    // Нажатие мимо точек выбор не снимает: панель закрывает её крестик
    if (!node) return;
    // Нажатие без движения выбирает точку; второе подряд открывает заметку
    const now = Date.now();
    const isDouble = lastTapRef.current.id === node.id && now - lastTapRef.current.at < DOUBLE_TAP_MS;
    lastTapRef.current = { id: node.id, at: now };
    if (isDouble) onOpen(pickOf(node));
    else onPick(pickOf(node));
  });

  const handlePointerCancel = useLastCallback((e: React.PointerEvent<HTMLDivElement>) => {
    pinchRef.current.up(e.pointerId);
    const drag = dragRef.current;
    dragRef.current = undefined;
    // Прерванное перетаскивание точки: она возвращается на закреплённое место (в DOM — напрямую, состояние
    // не менялось)
    if (drag?.mode === 'node' && drag.hasMoved && drag.node) {
      const { node } = drag;
      requestMutation(() => writeDraggedNode(drag, { x: node.x, y: node.y }));
    }
    commitView();
    if (!linkFromId) clearDraft();
  });

  const handleWheel = useLastCallback((e: React.WheelEvent<HTMLDivElement>) => {
    if ((e.target as Element).closest('[data-board-tools]')) return;
    const box = e.currentTarget.getBoundingClientRect();
    applyView(zoomByWheel(viewRef.current, e.deltaY, e.clientX - box.left, e.clientY - box.top), false);
    commitViewSoon();
  });

  // Escape по очереди: название новой заметки, список областей, режим «Связать», выбранная линия, панель
  // выбранной точки. Панель не закрывается, пока в ней правят заметку или набирают текст в поле: там Escape —
  // дело поля. Общие слушатели приложения перехватывают Escape раньше — обработчик встаёт в их очередь
  const handleEscape = useLastCallback(() => {
    // Скрытый раздел (смонтирован, но не показан) клавишу не берёт
    if (!getIsParvaneScreenShown('notes')) return false;
    if (newAt) cancelNew();
    else if (isScopeOpen) closeScope();
    else if (linkFromId) onLinkModeEnd();
    else if (pickedEdge) setPickedEdge(undefined);
    else if (document.querySelector(PANEL_EDITOR) || isTyping(document.activeElement)) return false;
    else onClose();
    return undefined;
  });
  const hasEscapeTarget = Boolean(newAt || isScopeOpen || linkFromId || pickedEdge || pickedId);
  useLayoutEffect(() => (hasEscapeTarget ? captureEscKeyListener(handleEscape) : undefined), [hasEscapeTarget]);

  // Delete убирает выбранную связь
  const handleKey = useLastCallback((e: KeyboardEvent) => {
    if (!getIsParvaneScreenShown('notes')) return;
    if ((e.key === 'Delete' || e.key === 'Backspace') && pickedEdge && !isTyping(e.target)) {
      e.preventDefault();
      removeLink();
    }
  });
  useEffect(() => {
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [handleKey]);

  const zoomBy = (factor: number) => {
    const box = boardRef.current?.getBoundingClientRect();
    if (!box) return;
    const current = viewRef.current;
    applyView(zoomAround(current, current.scale * factor, box.width / 2, box.height / 2), true);
  };

  const handleZoomIn = useLastCallback(() => zoomBy(BOARD_ZOOM_STEP));
  const handleZoomOut = useLastCallback(() => zoomBy(1 / BOARD_ZOOM_STEP));
  // «Разложить заново»: точки, переставленные руками, возвращаются на места раскладки, граф вписывается
  const handleRelayout = useLastCallback(() => {
    shouldFitRef.current = true;
    savePlaces({});
    setRelayoutCount((count) => count + 1);
  });
  useEffect(() => {
    if (!shouldFitRef.current) return;
    shouldFitRef.current = false;
    fit();
  }, [places]);

  const handleToggleScope = useLastCallback(() => (isScopeOpen ? closeScope() : openScope()));
  const handleToggleDays = useLastCallback(() => setWithDays(!withDays));
  const handleToggleRecords = useLastCallback(() => setWithRecords(!withRecords));

  const handleFilter = useLastCallback((next: GraphFilter) => {
    setSavedFilter(next);
    writeGraphFilter(next);
    shouldDropPickRef.current = true;
  });

  // Точка, открытая в панели, ушла с графа вместе со своей областью — панель закрывается
  useEffect(() => {
    if (!shouldDropPickRef.current || isBusy || !layout) return;
    shouldDropPickRef.current = false;
    if (pickedId && !byId.has(pickedId)) onClose();
    // eslint-disable-next-line react-hooks-static-deps/exhaustive-deps
  }, [layout, isBusy]);

  // «Холст из графа»: заметки, что сейчас на графе, — та же область. Поиск набор не сужает
  const handleMakeCanvas = useLastCallback(() => {
    onMakeCanvas({ scope: filter.scope, hideOrphans: filter.hideOrphans, days: withDays });
  });

  // Enter в поиске шапки выбирает следующую найденную точку (после выбранной, по кругу)
  useEffect(() => {
    if (searchStep === searchStepRef.current) return;
    searchStepRef.current = searchStep;
    const hits = nodes.filter(({ id }) => found?.has(id));
    if (!hits.length) return;
    const at = hits.findIndex(({ id }) => id === pickedId);
    onPick(pickOf(hits[(at + 1) % hits.length]));
  }, [searchStep, nodes, found, pickedId, onPick]);

  const handleNewKey = useLastCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') void submitNew(e.currentTarget.value);
  });

  const noteCount = nodes.filter(({ kind }) => kind === 'note').length;
  const hasCanvasNotes = nodes.some(({ kind }) => kind === 'note' || kind === 'day');
  const pickedNode = picked ? byId.get(picked) : undefined;
  const pickedNote = pickedNode?.kind === 'note' ? { id: pickedNode.id, title: pickedNode.title } : undefined;
  const aroundTitle = filter.scope.kind === 'around'
    ? notes.find(({ id }) => id === (filter.scope as { note: string }).note)?.title : undefined;
  const line = newAt || draft;
  const lineFrom = line ? byId.get(line.from) : undefined;
  const linkSourceId = line?.from || linkFromId;
  // Поле и фон рисуются по живому виду: перерисовка посреди жеста не откатывает их к закреплённому
  const liveView = viewRef.current;
  const toScreen = (point: GraphPoint) => (
    `left: ${view.x + point.x * view.scale}px; top: ${view.y + point.y * view.scale}px`
  );
  // Поле названия новой заметки стоит там, где бросили связь, но за край поля графа не выходит
  const newInputStyle = newAt && `left: clamp(7.75rem, ${view.x + newAt.x * view.scale}px, calc(100% - 7.75rem)); `
    + `top: clamp(5rem, ${view.y + newAt.y * view.scale}px, calc(100% - 2rem))`;

  function renderChip(label: string, onClick: NoneToVoidFunction, attribute: string, isDisabled?: boolean) {
    return (
      <button
        type="button"
        className={buildClassName(kit.chip, styles.chip)}
        disabled={isDisabled}
        {...{ [attribute]: '' }}
        onClick={onClick}
      >
        {label}
      </button>
    );
  }

  const relayoutChip = renderChip(lang('KnowledgeGraphRelayout'), handleRelayout, 'data-graph-relayout', !hasPins);
  const canvasChip = renderChip(
    lang('KnowledgeGraphToCanvas'), handleMakeCanvas, 'data-graph-to-canvas', !hasCanvasNotes,
  );

  return (
    <div
      ref={boardRef}
      className={buildClassName(board.board, styles.root, Boolean(linkSourceId) && styles.linking)}
      style={boardBackgroundStyle(liveView)}
      data-notes-graph
      data-graph-scale={liveView.scale}
      data-graph-picked={picked}
      data-graph-busy={isBusy ? '' : undefined}
      data-graph-placed={Object.keys(places).length}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerCancel}
      onWheel={handleWheel}
    >
      <div ref={worldRef} className={board.world} style={`transform: ${worldTransform(liveView)}`}>
        <svg className={styles.svg} width="1" height="1">
          <GraphEdges
            edges={edges}
            byId={byId}
            picked={picked}
            found={found}
            linkSourceId={linkSourceId}
            pickedEdge={pickedEdge}
            flash={flash}
          />
          {line && lineFrom && (
            <line
              className={styles.draft}
              x1={lineFrom.x}
              y1={lineFrom.y}
              x2={line.x}
              y2={line.y}
              data-graph-draft
            />
          )}
          <GraphNodes
            nodes={nodes}
            labels={labels}
            picked={picked}
            neighbours={neighbours}
            found={found}
            overId={line?.overId}
            linkSourceId={linkSourceId}
            areLabelsHidden={view.scale < LABEL_MIN_SCALE}
            areAllLabelsShown={view.scale >= LABEL_ALL_SCALE}
          />
        </svg>
      </div>
      <div className={styles.tools} data-board-tools>
        {/* Одна строка: не помещается — листается вбок */}
        <div className={styles.toolRow} data-graph-tool-row>
          <span className={buildClassName(kit.chip, kit.chipOn, styles.chip)} data-graph-count={noteCount}>
            {lang('KnowledgeGraphNotes', { count: noteCount })}
          </span>
          <button
            type="button"
            className={buildClassName(kit.chip, styles.chip, withDays && kit.chipOn)}
            aria-pressed={withDays}
            onClick={handleToggleDays}
          >
            {lang('KnowledgeGraphDays')}
          </button>
          <button
            type="button"
            className={buildClassName(kit.chip, styles.chip, withRecords && kit.chipOn)}
            aria-pressed={withRecords}
            onClick={handleToggleRecords}
          >
            {lang('KnowledgeGraphRecords')}
          </button>
          <NotesGraphScopeChip
            filter={filter}
            aroundTitle={aroundTitle}
            isOpen={isScopeOpen}
            onToggle={handleToggleScope}
          />
          {isNarrow && relayoutChip}
          {isNarrow && canvasChip}
        </div>
        {isScopeOpen && (
          <NotesGraphScope
            filter={filter}
            folders={graph.folders}
            tags={graph.tags}
            pickedNote={pickedNote}
            aroundTitle={aroundTitle}
            onClose={closeScope}
            onChange={handleFilter}
          />
        )}
      </div>
      {linkFrom && (
        <div
          className={buildClassName(board.boardHint, styles.linkHint)}
          role="status"
          data-board-tools
          data-graph-link-mode={linkFrom.id}
        >
          <span>{lang('KnowledgeGraphConnectHint', { name: linkFrom.title })}</span>
          <button type="button" className={buildClassName(kit.plain, styles.linkCancel)} onClick={onLinkModeEnd}>
            {lang('Cancel')}
          </button>
        </div>
      )}
      {isBusy && (
        <div className={styles.busy} role="status" data-graph-busy-note>{lang('KnowledgeGraphBusy')}</div>
      )}
      {!nodes.length && !isBusy && <p className={board.boardEmpty}>{lang('KnowledgeGraphEmpty')}</p>}
      {removals.map(({ from, spot }) => {
        const label = removals.length > 1
          ? lang('KnowledgeGraphRemoveLinkFrom', { name: from.title }) : lang('KnowledgeGraphRemoveLink');
        return (
          <button
            key={from.id}
            type="button"
            className={styles.edgeRemove}
            style={toScreen(spot)}
            aria-label={label}
            title={label}
            data-board-tools
            data-graph-edge-remove={from.id}
            data-from-title={from.title}
            onClick={handleRemoveClick}
          >
            <PvIcon name="x" isSmall />
          </button>
        );
      })}
      {newAt && (
        <input
          ref={newInputRef}
          className={buildClassName(kit.input, styles.newInput)}
          style={newInputStyle}
          maxLength={NEW_TITLE_MAX}
          placeholder={lang('KnowledgeGraphNewLinked')}
          aria-label={lang('KnowledgeGraphNewLinked')}
          autoComplete="off"
          data-board-tools
          data-graph-new
          onKeyDown={handleNewKey}
          onBlur={cancelNew}
        />
      )}
      {isNarrow ? (
        <div className={styles.zoom} data-board-tools>
          <button type="button" className={styles.zoomTool} aria-label={lang('KnowledgeZoomIn')} onClick={handleZoomIn}>
            <PvIcon name="plus" />
          </button>
          <button
            type="button"
            className={styles.zoomTool}
            aria-label={lang('KnowledgeZoomOut')}
            onClick={handleZoomOut}
          >
            <PvIcon name="minus" />
          </button>
          <button type="button" className={styles.zoomTool} aria-label={lang('KnowledgeZoomFit')} onClick={fit}>
            <PvIcon name="fit" />
          </button>
        </div>
      ) : (
        <div className={styles.bottomRow} data-board-tools>
          {renderChip(lang('KnowledgeZoomIn'), handleZoomIn, 'data-graph-zoom-in')}
          {renderChip(lang('KnowledgeZoomOut'), handleZoomOut, 'data-graph-zoom-out')}
          {renderChip(lang('KnowledgeZoomFit'), fit, 'data-graph-fit')}
          {relayoutChip}
          {canvasChip}
        </div>
      )}
    </div>
  );
};

// Записи «Плана» для графа: события и задачи со ссылками в названии
function recordsOf(planner: PlannerState): NotesGraphRecord[] {
  return [
    ...planner.events.map((event) => ({
      id: `e${event.id}`, title: event.name, links: findLinks(event.name), type: 'event',
    })),
    ...planner.tasks.map((task) => ({
      id: `t${task.id}`, title: task.name, links: findLinks(task.name), type: 'task',
    })),
  ];
}

function findLinks(text: string) {
  return [...text.matchAll(LINK)].map((match) => match[1].trim());
}

// Элементы связей и точек графа по ключу — чтобы во время перетаскивания править их напрямую
function elementsByKey<T extends SVGElement>(root: ParentNode, attribute: string) {
  const result = new Map<string, T>();
  root.querySelectorAll<T>(`[${attribute}]`).forEach((element) => {
    result.set(element.getAttribute(attribute)!, element);
  });
  return result;
}

// Линия связи в DOM по новым концам: область нажатия, видимая линия и наконечники
function writeEdge(element: SVGGElement, edge: NotesGraphEdge) {
  const path = notesGraphEdgePath(edge);
  element.querySelectorAll('[data-edge-line]').forEach((line) => line.setAttribute('d', path));
  const heads = edgeHeads(edge);
  element.querySelectorAll('[data-edge-head]').forEach((head, i) => {
    if (heads[i]) head.setAttribute('d', heads[i]);
  });
}

function worldTransform(view: BoardView) {
  return `translate(${view.x}px, ${view.y}px) scale(${view.scale})`;
}

function normalizeQuery(value: string) {
  return value.trim().toLowerCase().replace(/ё/g, 'е');
}

function isTyping(target: EventTarget | null) {
  const element = target as HTMLElement | null;
  return Boolean(element?.closest?.('input, textarea, [contenteditable="true"]'));
}

export default memo(NotesGraph);
