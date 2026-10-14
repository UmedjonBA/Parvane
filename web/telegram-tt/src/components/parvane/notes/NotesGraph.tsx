import {
  memo, useEffect, useMemo, useRef, useState,
} from '../../../lib/teact/teact';

import type { PlannerState } from '../planner/plannerModel';
import type { BoardView } from './boardView';
import type { GraphCanvasScope } from './notesCanvasGraph';
import type {
  GraphEdge, GraphLayoutRun, GraphNode, GraphPoint, GraphRecordInput,
} from './notesGraph';
import type { NoteEntry } from './notesStore';

import { requestMutation } from '../../../lib/fasterdom/fasterdom';
import buildClassName from '../../../util/buildClassName';
import captureEscKeyListener from '../../../util/captureEscKeyListener';
import { getIsParvaneScreenShown } from '../../../util/parvaneSection';
import { debounce } from '../../../util/schedulers';
import { SEARCH_FIELD_PROPS } from '../../../util/searchField';
import {
  BOARD_ZOOM_STEP, boardBackgroundStyle, createPinch, fitRects, zoomAround, zoomByWheel,
} from './boardView';
import { folderCaption, ROOT_FOLDER } from './notesFolders';
import {
  buildGraph, canLinkFrom, canLinkTo, edgeShape, GRAPH_FRAME_WORK, GRAPH_SYNC_WORK, isNoteInGraph, listGraphFolders,
  MISSING_NODE_PREFIX, neighboursOf, nodeAt, nodeRadius, resolveGraphFolders, startGraphLayout,
} from './notesGraph';
import { displayTitle, folderColor } from './notesLook';
import { normalizeNoteTitle, parseNoteCached } from './notesModel';
import { readGraphFolders, writeGraphFolders } from './notesPrefs';

import useLang from '../../../hooks/useLang';
import useLastCallback from '../../../hooks/useLastCallback';
import useResizeObserver from '../../../hooks/useResizeObserver';

import SearchForm from '../../ui/SearchForm';
import PvIcon from './PvIcon';

import styles from './Knowledge.module.scss';
import kit from './PvKit.module.scss';

// Выбранная точка графа — то, что показывает панель справа
export type GraphPick = Pick<GraphNode, 'id' | 'kind' | 'title' | 'group'>;
export type GraphLinkOutcome = 'added' | 'exists' | 'refused' | 'failed';

type OwnProps = {
  notes: NoteEntry[];
  planner: PlannerState;
  pickedId?: string;
  // Режим «Связать»: следующая нажатая заметка получает ссылку из этой
  linkFromId?: string;
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
  // «Создать холст»: холст из заметок, которые сейчас видны на графе
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
  node?: GraphNode;
  element?: SVGGElement;
  edges?: { edge: GraphEdge; element: SVGGElement; other: GraphNode }[];
  at?: GraphPoint;
};

// Связь, которую ведут: от точки `from` до места указателя на поле; `overId` — заметка под указателем
type Draft = GraphPoint & { from: string; overId?: string };

// Раскладка свободная (не сжата в область): область задаёт только центр
const LAYOUT = { width: 900, height: 620, isLoose: true };
const LINK = /\[\[([^\]|\n]+)/g;
const RECORD_LINK = /\[\[[^\]\n]*\]\]/g;
const LABEL_MAX = 22;
const LABEL_GAP = 17;
// Мельче этого масштаба подписи остаются только у выбранной точки, её соседей и найденного поиском
const LABEL_MIN_SCALE = 0.55;
// Кольцо, за которое тянут связь: настолько шире кружка
const HANDLE_GAP = 5;
// Запас попадания в точку при отпускании связи, в пикселях экрана
const DROP_SLOP = 10;
// Место под подпись точки при вписывании графа в поле
const FIT_BOX_WIDTH = 120;
const FIT_BOX_HEIGHT = 60;
const FIT_TOP = 60;
const FIT_BOTTOM = 20;
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

// Места точек переживают уход с вкладки: граф не перетряхивается, пока его не попросят разложить заново
const placedById = new Map<string, GraphPoint>();
const NO_RECORDS: GraphRecordInput[] = [];

// Записи «Плана» для графа: события и задачи со ссылками в названии
function recordsOf(planner: PlannerState): GraphRecordInput[] {
  return [
    ...planner.events.map((event) => ({
      id: `e${event.id}`, title: event.name, links: linksIn(event.name), type: 'event',
    })),
    ...planner.tasks.map((task) => ({
      id: `t${task.id}`, title: task.name, links: linksIn(task.name), type: 'task',
    })),
  ];
}

// Элементы связей и точек графа по ключу — чтобы во время перетаскивания править их напрямую
function elementsByKey<T extends SVGElement>(root: ParentNode, attribute: string) {
  const result = new Map<string, T>();
  root.querySelectorAll<T>(`[${attribute}]`).forEach((element) => {
    result.set(element.getAttribute(attribute)!, element);
  });
  return result;
}

// Линия связи в DOM по новым концам: две линии (область нажатия и видимая) и наконечники
function writeEdge(element: SVGGElement, from: GraphNode, to: GraphNode, isMutual?: true) {
  const shape = edgeShape(from, to, nodeRadius(from.degree), nodeRadius(to.degree), isMutual);
  element.querySelectorAll('line').forEach((line) => {
    line.setAttribute('x1', String(shape.x1));
    line.setAttribute('y1', String(shape.y1));
    line.setAttribute('x2', String(shape.x2));
    line.setAttribute('y2', String(shape.y2));
  });
  element.querySelectorAll('path').forEach((path, i) => {
    if (shape.heads[i]) path.setAttribute('d', shape.heads[i]);
  });
}

// Точка в DOM на новом месте: кружок, кольцо и подпись
function writeNode(element: SVGGElement, node: GraphNode, at: GraphPoint) {
  element.querySelectorAll('circle').forEach((circle) => {
    circle.setAttribute('cx', String(at.x));
    circle.setAttribute('cy', String(at.y));
  });
  const text = element.querySelector('text');
  if (text) {
    text.setAttribute('x', String(at.x));
    text.setAttribute('y', String(at.y + nodeRadius(node.degree) + LABEL_GAP));
  }
}

function worldTransform(view: BoardView) {
  return `translate(${view.x}px, ${view.y}px) scale(${view.scale})`;
}

type EdgesProps = {
  edges: GraphEdge[];
  byId: Map<string, GraphNode>;
  picked?: string;
  found?: Set<string>;
  linkSourceId?: string;
  pickedEdge?: string;
  flash?: string;
};

// Слой связей. Не зависит от вида поля: сдвиг и масштаб его не перерисовывают
const GraphEdges = memo(({
  edges, byId, picked, found, linkSourceId, pickedEdge, flash,
}: EdgesProps) => (
  <g data-graph-edges>
    {edges.map((edge) => {
      const from = byId.get(edge.from);
      const to = byId.get(edge.to);
      if (!from || !to) return undefined;
      const key = keyOf(edge);
      const shape = edgeShape(from, to, nodeRadius(from.degree), nodeRadius(to.degree), edge.isMutual);
      // Править можно связь между заметками: у дней и записей «Плана» ссылки стоят не в тексте заметки
      const isEditable = canLinkFrom(from) && canLinkTo(to);
      const isOn = picked === edge.from || picked === edge.to;
      // Пока ведут связь, граф виден целиком: любая заметка — цель
      const isDim = !linkSourceId
        && (found ? !(found.has(edge.from) && found.has(edge.to)) : Boolean(picked) && !isOn);
      return (
        <g
          key={key}
          className={buildClassName(
            styles.graphEdge,
            isEditable && styles.graphEdgeEditable,
            isOn && !isDim && styles.graphEdgeOn,
            isDim && key !== pickedEdge && styles.graphDim,
            key === pickedEdge && styles.graphEdgePicked,
            flash === pairOf(edge.from, edge.to) && styles.graphEdgeFlash,
          )}
          data-graph-edge={key}
          data-from={edge.from}
          data-to={edge.to}
          data-from-title={from.title}
          data-to-title={to.title}
          data-editable={isEditable ? 'true' : undefined}
          data-mutual={edge.isMutual ? 'true' : undefined}
        >
          <line className={styles.graphEdgeHit} x1={shape.x1} y1={shape.y1} x2={shape.x2} y2={shape.y2} />
          <line className={styles.graphEdgeLine} x1={shape.x1} y1={shape.y1} x2={shape.x2} y2={shape.y2} />
          {shape.heads.map((head) => <path key={head} d={head} />)}
        </g>
      );
    })}
  </g>
));

type NodesProps = {
  nodes: GraphNode[];
  labels: Map<string, string>;
  picked?: string;
  neighbours?: Set<string>;
  found?: Set<string>;
  overId?: string;
  linkSourceId?: string;
  areLabelsShown: boolean;
};

// Слой точек. Из вида поля ему нужен только порог подписей — он меняется при закреплении масштаба
const GraphNodes = memo(({
  nodes, labels, picked, neighbours, found, overId, linkSourceId, areLabelsShown,
}: NodesProps) => (
  <g data-graph-nodes>
    {nodes.map((node) => {
      const radius = nodeRadius(node.degree);
      const label = labels.get(node.id) || node.title;
      const isNear = picked === node.id || Boolean(picked && neighbours?.has(node.id));
      const isFound = Boolean(found?.has(node.id));
      const isTarget = overId === node.id;
      const isSource = linkSourceId === node.id;
      const isDim = linkSourceId ? !isSource && !canLinkTo(node)
        : found ? !isFound : Boolean(picked) && !isNear;
      const hasLabel = areLabelsShown || isNear || isFound || isTarget || isSource;
      return (
        <g
          key={node.id}
          className={buildClassName(
            styles.graphNode,
            node.kind === 'missing' && styles.graphMissing,
            picked === node.id && styles.graphPicked,
            isFound && styles.graphFound,
            isTarget && styles.graphTarget,
            isSource && styles.graphSource,
            isDim && styles.graphDim,
          )}
          style={`--c: ${colorOf(node)}`}
          data-node={node.id}
          data-kind={node.kind}
          data-title={node.title}
        >
          <circle cx={node.x} cy={node.y} r={radius} />
          {canLinkFrom(node) && (
            <circle
              className={styles.graphHandle}
              cx={node.x}
              cy={node.y}
              r={radius + HANDLE_GAP}
              data-graph-handle={node.id}
            />
          )}
          {hasLabel && (
            <text x={node.x} y={node.y + radius + LABEL_GAP}>
              {label.length > LABEL_MAX ? `${label.slice(0, LABEL_MAX - 1)}…` : label}
            </text>
          )}
        </g>
      );
    })}
  </g>
));

// Остаток долгой раскладки идёт порциями в свободное время: `tick` зовётся после каждой порции, пока не кончится
// работа или её не отменят
function continueLayout(run: GraphLayoutRun, tick: (isDone: boolean) => void) {
  const hasIdle = 'requestIdleCallback' in self;
  let isCancelled = false;
  let handle: number | undefined;
  const chunk = () => {
    handle = undefined;
    if (isCancelled) return;
    const isDone = run.step(GRAPH_FRAME_WORK);
    tick(isDone);
    if (!isDone) schedule();
  };
  const schedule = () => {
    handle = hasIdle ? self.requestIdleCallback(chunk, { timeout: 200 }) : self.setTimeout(chunk, 16);
  };
  schedule();
  return () => {
    isCancelled = true;
    if (handle === undefined) return;
    if (hasIdle) self.cancelIdleCallback(handle);
    else self.clearTimeout(handle);
  };
}

function linksIn(text: string) {
  return [...text.matchAll(LINK)].map((match) => match[1].trim());
}

function colorOf(node: GraphNode) {
  if (node.kind === 'missing') return 'var(--pv-faint)';
  if (node.kind === 'day') return 'var(--pv-note)';
  if (node.kind === 'record') return node.group === 'task' ? 'var(--pv-task)' : 'var(--pv-event)';
  return folderColor(node.group || '');
}

function keyOf(edge: GraphEdge) {
  return `${edge.from}>${edge.to}`;
}

function pairOf(a: string, b: string) {
  return a < b ? `${a}>${b}` : `${b}>${a}`;
}

function normalizeQuery(value: string) {
  return value.trim().toLowerCase().replace(/ё/g, 'е');
}

function isTyping(target: EventTarget | null) {
  const element = target as HTMLElement | null;
  return Boolean(element?.closest?.('input, textarea, [contenteditable="true"]'));
}

// Граф связей: заметки, заметки, которых ещё нет (блёклые), по желанию дни и записи «Плана».
// Поле двигается и масштабируется (колесо, щипок, кнопки), точки перетаскиваются. Нажатие выбирает точку —
// её показывает панель справа; двойное открывает заметку на вкладке «Заметки». Связь — это ссылка в тексте:
// её ведут от кольца вокруг заметки к другой заметке (или на пустое место — к новой), а убирают, выбрав линию
const NotesGraph = ({
  notes, planner, pickedId, linkFromId, onPick, onOpen, onLink, onLinkNew, onUnlink, onLinkModeEnd, onClose,
  onMakeCanvas,
}: OwnProps) => {
  const boardRef = useRef<HTMLDivElement>();
  const worldRef = useRef<HTMLDivElement>();
  const newInputRef = useRef<HTMLInputElement>();
  const foldersRef = useRef<HTMLSpanElement>();
  const folderMenuRef = useRef<HTMLDivElement>();
  const [withDays, setWithDays] = useState(false);
  const [withRecords, setWithRecords] = useState(false);
  // Выбор папок запоминается на устройстве; `undefined` — все папки
  const [savedFolders, setSavedFolders] = useState(readGraphFolders);
  const [isFolderMenuOpen, setIsFolderMenuOpen] = useState(false);
  // Вид поля: закреплённый — состоянием (от него зависят подписи и кнопки над полем), живой — в ссылке.
  // Во время жеста меняется только живой и пишется прямо в DOM; состояние догоняет при отпускании
  const [view, setView] = useState<BoardView>({ scale: 1, x: 0, y: 0 });
  const viewRef = useRef<BoardView>(view);
  const [moved, setMoved] = useState<Record<string, GraphPoint>>({});
  // Растёт, когда граф просят разложить заново
  const [layoutRound, setLayoutRound] = useState(0);
  const [draft, setDraft] = useState<Draft>();
  // Связь брошена на пустое место: здесь спрашивают название новой заметки
  const [newAt, setNewAt] = useState<Draft>();
  const [pickedEdge, setPickedEdge] = useState<string>();
  const [flash, setFlash] = useState<string>();
  const [query, setQuery] = useState('');
  const dragRef = useRef<Drag>();
  const draftRef = useRef<Draft>();
  const pinchRef = useRef(createPinch());
  const lastTapRef = useRef<{ id?: string; at: number }>({ at: 0 });
  const sizeRef = useRef<{ width: number; height: number }>();
  const fitKeyRef = useRef<string>();
  const fitRef = useRef<NoneToVoidFunction>();

  const lang = useLang();

  // Папки с заметками; выбор приводится к ним — удалённая папка из него выпадает
  const folderOptions = useMemo(() => listGraphFolders(notes), [notes]);
  const folders = useMemo(() => resolveGraphFolders(savedFolders, folderOptions), [savedFolders, folderOptions]);
  const foldersKey = folders ? folders.join('\n') : undefined;

  // Записи «Плана» нужны графу только при включённых «Записях»: без них изменения плана граф не трогают
  const plannerForGraph = withRecords ? planner : undefined;
  const records = useMemo(() => (plannerForGraph ? recordsOf(plannerForGraph) : NO_RECORDS), [plannerForGraph]);

  // Сборка графа и начало раскладки. Точки, у которых уже есть место, стоят на нём: новая связь, заметка или
  // смена папок граф не перетряхивают. Первая порция работы — сразу, остаток — порциями в свободное время
  const built = useMemo(() => {
    const graph = buildGraph({
      notes: notes.map((note) => ({
        id: note.id,
        title: note.title,
        folder: note.folder,
        links: parseNoteCached(note).links,
        isDaily: note.isDaily,
      })),
      records,
    }, { withDays, withRecords, folders });
    const run = startGraphLayout(graph.nodes, graph.edges, placedById, LAYOUT);
    run.step(GRAPH_SYNC_WORK);
    return { run, edges: graph.edges };
    // eslint-disable-next-line react-hooks-static-deps/exhaustive-deps
  }, [notes, records, withDays, withRecords, foldersKey, layoutRound]);
  const [layoutTick, setLayoutTick] = useState(0);
  // `layoutTick` растёт после каждой порции раскладки — места точек перечитываются
  // eslint-disable-next-line react-hooks-static-deps/exhaustive-deps
  const graph = useMemo(() => ({ nodes: built.run.nodes(), edges: built.edges }), [built, layoutTick]);
  // Законченная раскладка запоминает места точек; если граф вписывали, он вписывается снова по готовым местам
  const refitRef = useRef(false);
  const rememberPlaces = (run: GraphLayoutRun) => {
    run.nodes().forEach((node) => placedById.set(node.id, { x: node.x, y: node.y }));
  };
  useEffect(() => {
    const { run } = built;
    if (run.isDone) {
      rememberPlaces(run);
      return undefined;
    }
    return continueLayout(run, (isDone) => {
      setLayoutTick((tick) => tick + 1);
      if (!isDone) return;
      rememberPlaces(run);
      if (refitRef.current) {
        refitRef.current = false;
        fitRef.current?.();
      }
    });
  }, [built]);

  const nodes = useMemo(() => graph.nodes.map((node) => ({ ...node, ...moved[node.id] })), [graph, moved]);
  const byId = useMemo(() => new Map(nodes.map((node) => [node.id, node])), [nodes]);
  const neighbours = useMemo(() => (
    pickedId ? neighboursOf(pickedId, graph.edges) : undefined
  ), [pickedId, graph]);
  const dailyById = useMemo(() => (
    new Map(notes.filter((note) => note.isDaily).map((note) => [note.id, note]))
  ), [notes]);
  const picked = pickedId && byId.has(pickedId) ? pickedId : undefined;
  const linkFrom = linkFromId ? byId.get(linkFromId) : undefined;
  const selectedEdge = pickedEdge ? graph.edges.find((edge) => keyOf(edge) === pickedEdge) : undefined;

  // Подписи точек: у заметки дня — дата словами, у записи «Плана» — название без разметки ссылок. Считаются
  // по графу и языку, не на каждую перерисовку
  const labels = useMemo(() => {
    const result = new Map<string, string>();
    graph.nodes.forEach((node) => {
      const daily = dailyById.get(node.id);
      if (daily) result.set(node.id, displayTitle(lang, daily));
      else if (node.kind === 'record') {
        result.set(node.id, node.title.replace(RECORD_LINK, '').replace(/\s+/g, ' ').trim() || node.title);
      } else result.set(node.id, node.title);
    });
    return result;
  }, [graph, dailyById, lang]);

  const found = useMemo(() => {
    const wanted = normalizeQuery(query);
    if (!wanted) return undefined;
    return new Set(graph.nodes.filter((node) => normalizeQuery(labels.get(node.id) || node.title).includes(wanted)
      || normalizeQuery(node.title).includes(wanted)).map(({ id }) => id));
  }, [query, graph, labels]);

  // Ссылки выбранной связи: одна, при взаимной связи — две (у каждой заметки своя, убираются по отдельности)
  const removals = useMemo(() => {
    const from = selectedEdge && byId.get(selectedEdge.from);
    const to = selectedEdge && byId.get(selectedEdge.to);
    if (!selectedEdge || !from || !to) return [];
    const at = (share: number) => ({ x: from.x + (to.x - from.x) * share, y: from.y + (to.y - from.y) * share });
    if (!selectedEdge.isMutual) return [{ from, to, spot: at(REMOVE_AT_MIDDLE) }];
    return [{ from, to, spot: at(REMOVE_AT_SOURCE) }, { from: to, to: from, spot: at(1 - REMOVE_AT_SOURCE) }];
  }, [selectedEdge, byId]);

  // Новый вид: сразу в DOM (поле, фон, масштаб для сценариев) и в живую ссылку; `isFinal` закрепляет состоянием
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
      if (world) world.style.transform = worldTransform(next);
      if (!board) return;
      board.style.cssText = boardBackgroundStyle(next);
      board.dataset.graphScale = String(next.scale);
      // Крестики выбранной связи стоят над полем в экранных координатах — едут вместе с ним
      board.querySelectorAll<HTMLElement>('[data-graph-edge-remove]').forEach((button) => {
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

  const fit = useLastCallback(() => {
    const box = boardRef.current?.getBoundingClientRect();
    if (!box) return;
    // Пока раскладка не закончена, вписывается промежуточный граф — по готовому вписывание повторится
    refitRef.current = !built.run.isDone;
    applyView(fitRects(
      nodes.map((node) => ({
        x: node.x - FIT_BOX_WIDTH / 2, y: node.y - FIT_BOX_HEIGHT / 2, width: FIT_BOX_WIDTH, height: FIT_BOX_HEIGHT,
      })),
      box.width,
      box.height,
      FIT_TOP,
      FIT_BOTTOM,
    ), true);
  });
  fitRef.current = fit;

  // Граф вписывается в поле при открытии, при смене фильтра и когда его раскладывают заново. Новая заметка
  // или связь вид не трогают: масштаб и место выбирает пользователь
  const hasNodes = graph.nodes.length > 0;
  useEffect(() => {
    const key = `${hasNodes}${withDays}${withRecords}${layoutRound}${foldersKey}`;
    if (fitKeyRef.current === key) return;
    fitKeyRef.current = key;
    fit();
  }, [hasNodes, withDays, withRecords, layoutRound, foldersKey]);

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

  // Панель справа открылась или закрылась: поле стало уже или шире. Граф остаётся посередине в прежнем
  // масштабе; сдвигается к выбранной точке, только если она оказалась за краем
  const handleResize = useLastCallback((entry: ResizeObserverEntry) => {
    const { width, height } = entry.contentRect;
    const previous = sizeRef.current;
    sizeRef.current = { width, height };
    if (!previous || previous.width === width) return;
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

  const pickOf = (node: GraphNode): GraphPick => ({
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

  const connect = useLastCallback(async (fromId: string, to: GraphNode) => {
    clearDraft();
    const outcome = await onLink(fromId, to.title);
    if (outcome === 'added' || outcome === 'exists') setFlash(pairOf(fromId, to.id));
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
    placedById.set(MISSING_NODE_PREFIX + normalizeNoteTitle(title), spot);
    const id = await onLinkNew(at.from, title);
    if (!id) return;
    placedById.set(id, spot);
    setMoved((current) => ({ ...current, [id]: spot }));
    setFlash(pairOf(at.from, id));
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
    const handleId = target.closest<SVGElement>('[data-graph-handle]')?.dataset.graphHandle;
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
    graph.edges.forEach((edge) => {
      if (edge.from !== node.id && edge.to !== node.id) return;
      const element = edgeElements.get(keyOf(edge));
      const other = byId.get(edge.from === node.id ? edge.to : edge.from);
      if (element && other) drag.edges!.push({ edge, element, other });
    });
  };

  const writeDraggedNode = (drag: Drag, at: GraphPoint) => {
    if (!drag.node) return;
    if (drag.element) writeNode(drag.element, drag.node, at);
    const movedNode = { ...drag.node, x: at.x, y: at.y };
    drag.edges?.forEach(({ edge, element, other }) => {
      if (edge.from === drag.node!.id) writeEdge(element, movedNode, other, edge.isMutual);
      else writeEdge(element, other, movedNode, edge.isMutual);
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
        const at = drag.at;
        if (at) {
          placedById.set(drag.id!, at);
          setMoved({ ...moved, [drag.id!]: at });
        }
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

  // Escape по очереди: название новой заметки, список папок, режим «Связать», выбранная линия, панель выбранной
  // точки. Панель не закрывается, пока в ней правят заметку или набирают текст в поле: там Escape — дело поля.
  // Общие слушатели приложения перехватывают Escape раньше — обработчик встаёт в их очередь
  const handleEscape = useLastCallback(() => {
    // Скрытый раздел (смонтирован, но не показан) клавишу не берёт
    if (!getIsParvaneScreenShown('knowledge')) return false;
    if (newAt) cancelNew();
    else if (isFolderMenuOpen) setIsFolderMenuOpen(false);
    else if (linkFromId) onLinkModeEnd();
    else if (pickedEdge) setPickedEdge(undefined);
    else if (document.querySelector(PANEL_EDITOR) || isTyping(document.activeElement)) return false;
    else onClose();
    return undefined;
  });
  const hasEscapeTarget = Boolean(newAt || isFolderMenuOpen || linkFromId || pickedEdge || pickedId);
  useEffect(() => (hasEscapeTarget ? captureEscKeyListener(handleEscape) : undefined), [hasEscapeTarget]);

  // Delete убирает выбранную связь
  const handleKey = useLastCallback((e: KeyboardEvent) => {
    if (!getIsParvaneScreenShown('knowledge')) return;
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
  // «Вписать» раскладывает граф заново (сдвинутые руками точки возвращаются) и показывает его целиком
  const handleFit = useLastCallback(() => {
    placedById.clear();
    setMoved({});
    setLayoutRound(layoutRound + 1);
  });

  const handleToggleDays = useLastCallback(() => setWithDays(!withDays));
  const handleToggleRecords = useLastCallback(() => setWithRecords(!withRecords));

  // ── выбор папок ──
  const handleToggleFolderMenu = useLastCallback(() => setIsFolderMenuOpen(!isFolderMenuOpen));

  // Нажатие мимо списка папок закрывает его
  useEffect(() => {
    if (!isFolderMenuOpen) return undefined;
    const handleOutside = (e: PointerEvent) => {
      const target = e.target as Node;
      if (foldersRef.current?.contains(target) || folderMenuRef.current?.contains(target)) return;
      setIsFolderMenuOpen(false);
    };
    document.addEventListener('pointerdown', handleOutside, true);
    return () => document.removeEventListener('pointerdown', handleOutside, true);
  }, [isFolderMenuOpen]);

  const pickFolders = (next?: string[]) => {
    const resolved = resolveGraphFolders(next, folderOptions);
    setSavedFolders(resolved);
    writeGraphFolders(resolved);
    // Заметка в панели ушла с графа вместе со своей папкой — панель закрывается
    const pickedNote = pickedId ? notes.find(({ id }) => id === pickedId) : undefined;
    if (pickedNote && !isNoteInGraph(pickedNote, { withDays, folders: resolved })) onClose();
  };

  const handleAllFolders = useLastCallback(() => {
    pickFolders(undefined);
    setIsFolderMenuOpen(false);
  });

  // Папка в списке — галочка: из «всех папок» нажатие оставляет одну, дальше папки добавляются и убираются;
  // сняли последнюю либо отметили все — снова «все папки»
  const handleFolder = useLastCallback((e: React.MouseEvent<HTMLButtonElement>) => {
    const path = e.currentTarget.dataset.graphFolder!;
    if (!folders) pickFolders([path]);
    else pickFolders(folders.includes(path) ? folders.filter((item) => item !== path) : [...folders, path]);
  });

  const captionOf = (path: string) => (path === ROOT_FOLDER ? lang('KnowledgeRoot') : folderCaption(path));

  // «Создать холст»: заметки, что сейчас на графе, — выбранные папки и, если включены, дни. Поиск набор не сужает
  const handleMakeCanvas = useLastCallback(() => {
    onMakeCanvas({ folders, days: withDays });
  });
  const handleQuery = useLastCallback((e: React.ChangeEvent<HTMLInputElement>) => setQuery(e.currentTarget.value));

  // Enter в поиске выбирает первую найденную точку
  const handleQueryKey = useLastCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== 'Enter') return;
    const first = nodes.find(({ id }) => found?.has(id));
    if (first) onPick(pickOf(first));
  });

  const handleNewKey = useLastCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') void submitNew(e.currentTarget.value);
  });

  const noteCount = nodes.filter(({ kind }) => kind === 'note').length;
  const hasCanvasNotes = nodes.some(({ kind }) => kind === 'note' || kind === 'day');
  // Выбирать есть из чего, когда заметки лежат больше чем в одном месте
  const hasFolderChoice = folderOptions.length > 1;
  const foldersLabel = !folders ? lang('KnowledgeGraphFoldersAll')
    : folders.length === 1 ? captionOf(folders[0]) : lang('KnowledgeGraphFoldersCount', { count: folders.length });
  const line = newAt || draft;
  const lineFrom = line ? byId.get(line.from) : undefined;
  const linkSourceId = line?.from || linkFromId;
  const areLabelsShown = view.scale >= LABEL_MIN_SCALE;
  // Поле и фон рисуются по живому виду: перерисовка посреди жеста не откатывает их к закреплённому
  const liveView = viewRef.current;
  const toScreen = (point: GraphPoint) => (
    `left: ${view.x + point.x * view.scale}px; top: ${view.y + point.y * view.scale}px`
  );
  // Поле названия новой заметки стоит там, где бросили связь, но за край поля графа не выходит
  const newInputStyle = newAt && `left: clamp(7.75rem, ${view.x + newAt.x * view.scale}px, calc(100% - 7.75rem)); `
    + `top: clamp(5rem, ${view.y + newAt.y * view.scale}px, calc(100% - 2rem))`;

  return (
    <div
      ref={boardRef}
      className={buildClassName(styles.board, Boolean(linkSourceId) && styles.boardLinking)}
      style={boardBackgroundStyle(liveView)}
      data-notes-graph
      data-graph-scale={liveView.scale}
      data-graph-picked={picked}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerCancel}
      onWheel={handleWheel}
    >
      <div ref={worldRef} className={styles.world} style={`transform: ${worldTransform(liveView)}`}>
        <svg className={styles.graphSvg} width="1" height="1">
          <GraphEdges
            edges={graph.edges}
            byId={byId}
            picked={picked}
            found={found}
            linkSourceId={linkSourceId}
            pickedEdge={pickedEdge}
            flash={flash}
          />
          {line && lineFrom && (
            <line
              className={styles.graphDraft}
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
            areLabelsShown={areLabelsShown}
          />
        </svg>
      </div>
      <div className={styles.boardTools} data-board-tools>
        {/* Одна строка, как на холсте: не помещается — листается вбок */}
        <div className={buildClassName(styles.boardScroll, styles.graphToolRow)}>
          <span
            className={buildClassName(kit.chip, kit.chipOn, styles.boardChip, styles.boardChipOn)}
            style="--c: var(--pv-note)"
          >
            {lang('KnowledgeGraphNotes', { count: noteCount })}
          </span>
          <button
            type="button"
            className={buildClassName(
              kit.chip, styles.boardChip, withDays && kit.chipOn, withDays && styles.boardChipOn,
            )}
            style="--c: var(--pv-note)"
            aria-pressed={withDays}
            onClick={handleToggleDays}
          >
            {lang('KnowledgeGraphDays')}
          </button>
          <button
            type="button"
            className={buildClassName(
              kit.chip, styles.boardChip, withRecords && kit.chipOn, withRecords && styles.boardChipOn,
            )}
            style="--c: var(--pv-event)"
            aria-pressed={withRecords}
            onClick={handleToggleRecords}
          >
            {lang('KnowledgeGraphRecords')}
          </button>
          {hasFolderChoice && (
            <span ref={foldersRef} className={styles.graphFolders}>
              <button
                type="button"
                className={buildClassName(
                  kit.chip, styles.boardChip, folders && kit.chipOn, folders && styles.boardChipOn,
                )}
                aria-haspopup="menu"
                aria-expanded={isFolderMenuOpen}
                title={lang('KnowledgeGraphFolders')}
                data-graph-folders={folders ? folders.length : 'all'}
                onClick={handleToggleFolderMenu}
              >
                <PvIcon name="folder" isSmall />
                <span className={styles.graphFoldersLabel}>{foldersLabel}</span>
                <PvIcon name={isFolderMenuOpen ? 'up' : 'down'} isSmall />
              </button>
            </span>
          )}
          <button
            type="button"
            className={buildClassName(kit.chip, styles.boardChip)}
            title={lang('KnowledgeGraphToCanvasTitle')}
            disabled={!hasCanvasNotes}
            data-graph-to-canvas
            onClick={handleMakeCanvas}
          >
            <PvIcon name="board" isSmall />
            {lang('KnowledgeGraphToCanvas')}
          </button>
          <SearchForm>
            <label className={styles.graphSearch}>
              <PvIcon name="search" isSmall className={styles.graphSearchIcon} />
              <input
                {...SEARCH_FIELD_PROPS}
                className={styles.graphSearchInput}
                value={query}
                placeholder={lang('KnowledgeGraphSearch')}
                aria-label={lang('KnowledgeGraphSearch')}
                data-graph-search
                onChange={handleQuery}
                onKeyDown={handleQueryKey}
              />
            </label>
          </SearchForm>
        </div>
        {isFolderMenuOpen && (
          <div
            ref={folderMenuRef}
            className={buildClassName(styles.graphFoldersMenu, 'custom-scroll')}
            role="menu"
            aria-label={lang('KnowledgeGraphFolders')}
            data-graph-folders-menu
          >
            <button
              type="button"
              className={styles.canvasMenuItem}
              role="menuitemradio"
              aria-checked={!folders}
              data-graph-folder-all
              onClick={handleAllFolders}
            >
              <PvIcon name="check" isSmall className={buildClassName(folders && styles.graphFolderOff)} />
              <span className={styles.graphFolderName}>{lang('KnowledgeGraphFoldersAll')}</span>
            </button>
            {folderOptions.map(({ path, count }) => {
              const isOn = Boolean(folders?.includes(path));
              return (
                <button
                  key={path}
                  type="button"
                  className={styles.canvasMenuItem}
                  role="menuitemcheckbox"
                  aria-checked={isOn}
                  data-graph-folder={path}
                  onClick={handleFolder}
                >
                  <PvIcon name="check" isSmall className={buildClassName(!isOn && styles.graphFolderOff)} />
                  <span className={styles.graphFolderName} style={`--c: ${folderColor(path)}`}>
                    {captionOf(path)}
                  </span>
                  <span className={styles.graphFolderCount}>{count}</span>
                </button>
              );
            })}
          </div>
        )}
      </div>
      {linkFrom && (
        <div
          className={buildClassName(styles.boardHint, styles.graphLinkHint)}
          role="status"
          data-board-tools
          data-graph-link-mode={linkFrom.id}
        >
          <span>{lang('KnowledgeGraphConnectHint', { name: linkFrom.title })}</span>
          <button type="button" className={buildClassName(kit.plain, styles.graphLinkCancel)} onClick={onLinkModeEnd}>
            {lang('Cancel')}
          </button>
        </div>
      )}
      {!nodes.length && <p className={styles.boardEmpty}>{lang('KnowledgeGraphEmpty')}</p>}
      {removals.map(({ from, spot }) => {
        const label = removals.length > 1
          ? lang('KnowledgeGraphRemoveLinkFrom', { name: from.title }) : lang('KnowledgeGraphRemoveLink');
        return (
          <button
            key={from.id}
            type="button"
            className={styles.graphEdgeRemove}
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
          className={buildClassName(kit.input, styles.graphNewInput)}
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
      <div className={styles.boardZoom} data-board-tools>
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
  );
};

export default memo(NotesGraph);
