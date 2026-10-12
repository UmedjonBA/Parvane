import {
  memo, useEffect, useMemo, useRef, useState,
} from '../../../lib/teact/teact';

import type { PlannerState } from '../planner/plannerModel';
import type { BoardView } from './boardView';
import type { GraphNode } from './notesGraph';
import type { NoteEntry } from './notesStore';

import buildClassName from '../../../util/buildClassName';
import {
  BOARD_ZOOM_STEP, boardBackgroundStyle, createPinch, fitRects, zoomAround, zoomByWheel,
} from './boardView';
import { buildGraph, layoutGraph, neighboursOf, nodeRadius } from './notesGraph';
import { displayTitle, folderColor } from './notesLook';
import { parseNote } from './notesModel';

import useLang from '../../../hooks/useLang';
import useLastCallback from '../../../hooks/useLastCallback';

import PvIcon from './PvIcon';

import styles from './Knowledge.module.scss';
import kit from './PvKit.module.scss';

type OwnProps = {
  notes: NoteEntry[];
  planner: PlannerState;
  onOpenNote: (noteId: string) => void;
  onOpenTitle: (title: string) => void;
};

type Drag = {
  id?: string;
  startX: number;
  startY: number;
  // Положение точки либо сдвиг поля в начале движения
  originX: number;
  originY: number;
  hasMoved: boolean;
};

const WIDTH = 900;
const HEIGHT = 620;
const LINK = /\[\[([^\]|\n]+)/g;
const RECORD_LINK = /\[\[[^\]\n]*\]\]/g;
const LABEL_MAX = 22;
const LABEL_GAP = 15;
// Место под подпись точки при вписывании графа в поле
const FIT_BOX_WIDTH = 120;
const FIT_BOX_HEIGHT = 60;
const FIT_TOP = 60;
const FIT_BOTTOM = 20;
const DRAG_THRESHOLD = 5;
const DOUBLE_TAP_MS = 380;
const KIND_KEYS = {
  note: 'KnowledgeGraphKindNote',
  day: 'KnowledgeGraphKindDay',
  missing: 'KnowledgeGraphKindMissing',
  task: 'KnowledgeGraphKindTask',
  event: 'KnowledgeGraphKindEvent',
} as const;

function linksIn(text: string) {
  return [...text.matchAll(LINK)].map((match) => match[1].trim());
}

function colorOf(node: GraphNode) {
  if (node.kind === 'missing') return 'var(--pv-faint)';
  if (node.kind === 'day') return 'var(--pv-note)';
  if (node.kind === 'record') return node.group === 'task' ? 'var(--pv-task)' : 'var(--pv-event)';
  return folderColor(node.group || '');
}

// Граф связей: заметки, заметки, которых ещё нет (блёклые), по желанию дни и записи «Плана».
// Поле двигается и масштабируется (колесо, щипок, кнопки), точки перетаскиваются; нажатие выделяет
// точку с соседями и показывает карточку, двойное нажатие открывает заметку
const NotesGraph = ({
  notes, planner, onOpenNote, onOpenTitle,
}: OwnProps) => {
  const boardRef = useRef<HTMLDivElement>();
  const [withDays, setWithDays] = useState(false);
  const [withRecords, setWithRecords] = useState(false);
  const [picked, setPicked] = useState<string>();
  const [view, setView] = useState<BoardView>({ scale: 1, x: 0, y: 0 });
  const [moved, setMoved] = useState<Record<string, { x: number; y: number }>>({});
  const dragRef = useRef<Drag>();
  const pinchRef = useRef(createPinch());
  const lastTapRef = useRef<{ id?: string; at: number }>({ at: 0 });

  const lang = useLang();

  const graph = useMemo(() => {
    const built = buildGraph({
      notes: notes.map((note) => ({
        id: note.id,
        title: note.title,
        folder: note.folder,
        links: parseNote(note.text).links,
        isDaily: note.isDaily,
      })),
      records: [
        ...planner.events.map((event) => ({
          id: `e${event.id}`, title: event.name, links: linksIn(event.name), type: 'event',
        })),
        ...planner.tasks.map((task) => ({
          id: `t${task.id}`, title: task.name, links: linksIn(task.name), type: 'task',
        })),
      ],
    }, { withDays, withRecords });
    return { nodes: layoutGraph(built.nodes, built.edges, { width: WIDTH, height: HEIGHT }), edges: built.edges };
  }, [notes, planner, withDays, withRecords]);

  const nodes = useMemo(() => graph.nodes.map((node) => ({ ...node, ...moved[node.id] })), [graph, moved]);
  const byId = useMemo(() => new Map(nodes.map((node) => [node.id, node])), [nodes]);
  const neighbours = useMemo(() => (picked ? neighboursOf(picked, graph.edges) : undefined), [picked, graph]);
  const pickedNode = picked ? byId.get(picked) : undefined;
  const dailyById = useMemo(() => (
    new Map(notes.filter((note) => note.isDaily).map((note) => [note.id, note]))
  ), [notes]);

  // Подпись точки: у заметки дня — дата словами, у записи «Плана» — название без разметки ссылок
  const labelOf = (node: GraphNode) => {
    const daily = dailyById.get(node.id);
    if (daily) return displayTitle(lang, daily);
    if (node.kind !== 'record') return node.title;
    return node.title.replace(RECORD_LINK, '').replace(/\s+/g, ' ').trim() || node.title;
  };

  const fit = useLastCallback(() => {
    const box = boardRef.current?.getBoundingClientRect();
    if (!box) return;
    setView(fitRects(
      nodes.map((node) => ({
        x: node.x - FIT_BOX_WIDTH / 2, y: node.y - FIT_BOX_HEIGHT / 2, width: FIT_BOX_WIDTH, height: FIT_BOX_HEIGHT,
      })),
      box.width,
      box.height,
      FIT_TOP,
      FIT_BOTTOM,
    ));
  });

  // Граф вписывается в поле при открытии и когда фильтр меняет набор точек
  const nodeCount = graph.nodes.length;
  useEffect(() => {
    fit();
  }, [nodeCount, withDays, withRecords]);

  const openNode = (node?: GraphNode) => {
    if (!node) return;
    if (node.kind === 'missing') onOpenTitle(node.title);
    else if (node.kind !== 'record') onOpenNote(node.id);
  };

  const handlePointerDown = useLastCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const target = e.target as Element;
    if (target.closest('[data-board-tools]')) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    if (pinchRef.current.down(e.pointerId, e.clientX, e.clientY, view)) {
      dragRef.current = undefined;
      return;
    }
    const id = target.closest<SVGGElement>('[data-node]')?.dataset.node;
    const node = id ? byId.get(id) : undefined;
    dragRef.current = {
      id,
      startX: e.clientX,
      startY: e.clientY,
      originX: node ? node.x : view.x,
      originY: node ? node.y : view.y,
      hasMoved: false,
    };
  });

  const handlePointerMove = useLastCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const pinched = pinchRef.current.move(
      e.pointerId, e.clientX, e.clientY, e.currentTarget.getBoundingClientRect(),
    );
    if (pinched) {
      setView(pinched);
      return;
    }
    const drag = dragRef.current;
    if (!drag) return;
    const dx = e.clientX - drag.startX;
    const dy = e.clientY - drag.startY;
    if (!drag.hasMoved && Math.abs(dx) + Math.abs(dy) < DRAG_THRESHOLD) return;
    drag.hasMoved = true;
    if (drag.id) {
      setMoved({ ...moved, [drag.id]: { x: drag.originX + dx / view.scale, y: drag.originY + dy / view.scale } });
    } else {
      setView({ ...view, x: drag.originX + dx, y: drag.originY + dy });
    }
  });

  const handlePointerUp = useLastCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const wasPinch = pinchRef.current.isActive();
    pinchRef.current.up(e.pointerId);
    const drag = dragRef.current;
    dragRef.current = undefined;
    if (!drag || drag.hasMoved || wasPinch) return;
    // Нажатие без движения: выделить точку (мимо точек — снять выделение); второе подряд — открыть
    const now = Date.now();
    const isDouble = Boolean(drag.id) && lastTapRef.current.id === drag.id
      && now - lastTapRef.current.at < DOUBLE_TAP_MS;
    lastTapRef.current = { id: drag.id, at: now };
    if (isDouble) {
      openNode(byId.get(drag.id!));
      return;
    }
    setPicked(drag.id);
  });

  const handleWheel = useLastCallback((e: React.WheelEvent<HTMLDivElement>) => {
    const box = e.currentTarget.getBoundingClientRect();
    setView(zoomByWheel(view, e.deltaY, e.clientX - box.left, e.clientY - box.top));
  });

  const zoomBy = (factor: number) => {
    const box = boardRef.current?.getBoundingClientRect();
    if (!box) return;
    setView(zoomAround(view, view.scale * factor, box.width / 2, box.height / 2));
  };

  const handleZoomIn = useLastCallback(() => zoomBy(BOARD_ZOOM_STEP));
  const handleZoomOut = useLastCallback(() => zoomBy(1 / BOARD_ZOOM_STEP));
  const handleFit = useLastCallback(() => {
    setMoved({});
    fit();
  });

  const handleToggleDays = useLastCallback(() => setWithDays(!withDays));
  const handleToggleRecords = useLastCallback(() => setWithRecords(!withRecords));
  const handleDeselect = useLastCallback(() => setPicked(undefined));
  const handleOpenPicked = useLastCallback(() => openNode(pickedNode));

  const noteCount = nodes.filter(({ kind }) => kind === 'note').length;
  const pickedKind = !pickedNode ? undefined
    : pickedNode.kind === 'record' ? (pickedNode.group === 'task' ? 'task' : 'event') : pickedNode.kind;

  return (
    <div
      ref={boardRef}
      className={styles.board}
      style={boardBackgroundStyle(view)}
      data-notes-graph
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerUp}
      onWheel={handleWheel}
    >
      <div className={styles.world} style={`transform: translate(${view.x}px, ${view.y}px) scale(${view.scale})`}>
        <svg className={styles.graphSvg} width="1" height="1">
          {graph.edges.map((edge) => {
            const from = byId.get(edge.from);
            const to = byId.get(edge.to);
            if (!from || !to) return undefined;
            const isOn = picked === edge.from || picked === edge.to;
            return (
              <line
                key={`${edge.from}>${edge.to}`}
                className={buildClassName(
                  styles.graphEdge, picked && (isOn ? styles.graphEdgeOn : styles.graphDim),
                )}
                x1={from.x}
                y1={from.y}
                x2={to.x}
                y2={to.y}
              />
            );
          })}
          {nodes.map((node) => {
            const radius = nodeRadius(node.degree);
            const label = labelOf(node);
            const isDim = Boolean(picked) && picked !== node.id && !neighbours?.has(node.id);
            return (
              <g
                key={node.id}
                className={buildClassName(
                  styles.graphNode,
                  node.kind === 'missing' && styles.graphMissing,
                  picked === node.id && styles.graphPicked,
                  isDim && styles.graphDim,
                )}
                style={`--c: ${colorOf(node)}`}
                data-node={node.id}
                data-kind={node.kind}
              >
                <circle cx={node.x} cy={node.y} r={radius} />
                <text x={node.x} y={node.y + radius + LABEL_GAP}>
                  {label.length > LABEL_MAX ? `${label.slice(0, LABEL_MAX - 1)}…` : label}
                </text>
              </g>
            );
          })}
        </svg>
      </div>
      <div className={styles.boardTools} data-board-tools>
        <span
          className={buildClassName(kit.chip, kit.chipOn, styles.boardChip, styles.boardChipOn)}
          style="--c: var(--pv-note)"
        >
          {lang('KnowledgeGraphNotes', { count: noteCount })}
        </span>
        <button
          type="button"
          className={buildClassName(kit.chip, styles.boardChip, withDays && kit.chipOn, withDays && styles.boardChipOn)}
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
      </div>
      {!nodes.length && <p className={styles.boardEmpty}>{lang('KnowledgeGraphEmpty')}</p>}
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
      {pickedNode && pickedKind && (
        <div className={styles.boardInfo} data-graph-card data-board-tools>
          <div className={styles.boardInfoHead}>
            <span className={styles.boardInfoDot} style={`--c: ${colorOf(pickedNode)}`} />
            <b className={buildClassName(kit.ttl, kit.grow)}>{labelOf(pickedNode)}</b>
            <button
              type="button"
              className={kit.ib}
              aria-label={lang('KnowledgeGraphDeselect')}
              onClick={handleDeselect}
            >
              <PvIcon name="x" isSmall />
            </button>
          </div>
          <div className={styles.boardInfoSub}>
            {`${lang(KIND_KEYS[pickedKind])} · ${lang('KnowledgeGraphLinks', { count: pickedNode.degree })}`}
          </div>
          {pickedNode.kind !== 'record' && (
            <button type="button" className={buildClassName(kit.btn, kit.btnAcc)} onClick={handleOpenPicked}>
              {lang(pickedNode.kind === 'missing' ? 'KnowledgeGraphCreate' : 'KnowledgeGraphOpen')}
            </button>
          )}
        </div>
      )}
    </div>
  );
};

export default memo(NotesGraph);
