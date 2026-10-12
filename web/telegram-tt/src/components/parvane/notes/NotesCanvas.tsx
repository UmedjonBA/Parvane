import {
  memo, useEffect, useMemo, useRef, useState,
} from '../../../lib/teact/teact';

import type { BoardView } from './boardView';
import type {
  CanvasDoc, CanvasEdge, CanvasNode, CanvasPresetColor, CanvasSide,
} from './notesCanvas';
import type { CanvasEntry, NoteEntry } from './notesStore';

import buildClassName from '../../../util/buildClassName';
import {
  BOARD_FAR_SCALE, BOARD_ZOOM_STEP, boardBackgroundStyle, createPinch, fitRects, zoomAround, zoomByWheel,
} from './boardView';
import {
  addEdge, addNode, CANVAS_DEFAULT_NODE_HEIGHT, CANVAS_DEFAULT_NODE_WIDTH, CANVAS_PRESET_COLORS,
  createEmptyCanvas, edgeAnchors, findNode, isCanvasPresetColor, moveNode, newCanvasId, nodesInGroup,
  parseCanvas, removeEdge, removeNode, serializeCanvas, updateEdge, updateNode,
} from './notesCanvas';
import { canvasFromGraph, freeCanvasTitle } from './notesCanvasGraph';
import { folderColor } from './notesLook';
import { parseNote } from './notesModel';
import { saveCanvas } from './notesStore';

import useLang from '../../../hooks/useLang';
import useLastCallback from '../../../hooks/useLastCallback';

import PvIcon from './PvIcon';
import PvSheet from './PvSheet';

import styles from './Knowledge.module.scss';
import kit from './PvKit.module.scss';

type OwnProps = {
  canvases: CanvasEntry[];
  notes: NoteEntry[];
  isNarrow: boolean;
  onOpenTitle: (title: string) => void;
};

type Selection = { kind: 'node' | 'edge'; id: string };
type Drag = { id?: string; x: number; y: number; hasMoved: boolean };
// Правка в шторке: текст карточки (название группы, подпись связи), цвет, подписи связей карточки
type Editing = { text: string; color: string; labels: Record<string, string>; removed: string[] };

const SAVE_DELAY_MS = 1200;
const GROUP_WIDTH = 420;
const GROUP_HEIGHT = 280;
const NOTE_HEIGHT = 140;
// Новая карточка встаёт правее и ниже прежних, а не поверх них
const NEW_OFFSET_X = 280;
const NEW_OFFSET_Y = 40;
const NEW_COLUMNS = 3;
const PREVIEW_LINES = 7;
const FILE_SUFFIX = '.md';
const DRAG_THRESHOLD = 3;
// Место под панель инструментов сверху (на телефоне она в два ряда) и под название группы над рамкой
const FIT_TOP = 64;
const FIT_TOP_NARROW = 112;
const FIT_BOTTOM = 20;
const GROUP_LABEL_ROOM = 40;
const EDGE_MIN_BEND = 40;
const EDGE_LABEL_SHIFT = 4;
const NODE_NAME_MAX = 24;
const CARD_INLINE = /(\[\[[^\]\n]+\]\]|`[^`\n]+`|\*\*[^*\n]+\*\*)/g;
// Цвета JSON Canvas 1…6: красный, оранжевый, жёлтый, зелёный, синий, фиолетовый
const CANVAS_TONES: Record<CanvasPresetColor, string> = {
  1: 'var(--pv-red)',
  2: 'var(--pv-orange)',
  3: 'var(--pv-yellow)',
  4: 'var(--pv-green)',
  5: 'var(--pv-blue)',
  6: 'var(--pv-purple)',
};
const SIDE_NORMALS: Record<CanvasSide, { x: number; y: number }> = {
  top: { x: 0, y: -1 }, bottom: { x: 0, y: 1 }, left: { x: -1, y: 0 }, right: { x: 1, y: 0 },
};

function titleOfFile(file?: string) {
  const name = (file || '').split('/').pop() || '';
  return name.endsWith(FILE_SUFFIX) ? name.slice(0, -FILE_SUFFIX.length) : name;
}

function renderCardInline(text: string) {
  return text.split(CARD_INLINE).map((part, i) => {
    const key = `${i}${part}`;
    if (part.startsWith('[[')) {
      const [target, alias] = part.slice(2, -2).split('|');
      return <span key={key} className={styles.cardLink}>{(alias || target).trim()}</span>;
    }
    if (part.startsWith('`')) return <code key={key} className={styles.code}>{part.slice(1, -1)}</code>;
    if (part.startsWith('**')) return <b key={key}>{part.slice(2, -2)}</b>;
    return part;
  });
}

// Холст (JSON Canvas): карточки заметок, текстовые карточки, группы и стрелки с подписями.
// Файл `.canvas` лежит в папке «Знания»; правки сохраняются сами через паузу
const NotesCanvas = ({
  canvases, notes, isNarrow, onOpenTitle,
}: OwnProps) => {
  const boardRef = useRef<HTMLDivElement>();
  const [canvasId, setCanvasId] = useState<string | undefined>(canvases[0]?.id);
  const [doc, setDoc] = useState<CanvasDoc>(createEmptyCanvas);
  const [isDamaged, setIsDamaged] = useState(false);
  const [view, setView] = useState<BoardView>({ scale: 1, x: 0, y: 0 });
  const [selection, setSelection] = useState<Selection>();
  const [linkFrom, setLinkFrom] = useState<string>();
  const [editing, setEditing] = useState<Editing>();
  const [isPickingNote, setIsPickingNote] = useState(false);
  const dragRef = useRef<Drag>();
  const pinchRef = useRef(createPinch());
  const saveTimerRef = useRef<number>();
  const loadedRef = useRef<string>();
  const isCreatingRef = useRef(false);

  const lang = useLang();
  const vaultName = lang('KnowledgeVaultName');
  const entry = canvases.find(({ id }) => id === canvasId) || canvases[0];

  const viewport = () => {
    const box = boardRef.current?.getBoundingClientRect();
    return { width: box?.width || 800, height: box?.height || 600 };
  };

  // Вид, в котором видно всё (на телефоне — крупно первая группа со своим содержимым)
  const fitTo = useLastCallback((target: CanvasDoc) => {
    const group = isNarrow ? target.nodes.find(({ type }) => type === 'group') : undefined;
    const shown = group ? [group, ...nodesInGroup(target, group.id)] : target.nodes;
    const size = viewport();
    return fitRects(
      shown.map((node) => (node.type === 'group' ? {
        x: node.x, y: node.y - GROUP_LABEL_ROOM, width: node.width, height: node.height + GROUP_LABEL_ROOM,
      } : node)),
      size.width,
      size.height,
      isNarrow ? FIT_TOP_NARROW : FIT_TOP,
      FIT_BOTTOM,
    );
  });

  // Открытие холста: разбор файла и начальный вид
  useEffect(() => {
    if (!entry || loadedRef.current === entry.id) return;
    loadedRef.current = entry.id;
    const parsed = parseCanvas(entry.text);
    setDoc(parsed.doc);
    setIsDamaged(Boolean(parsed.error));
    setSelection(undefined);
    setLinkFrom(undefined);
    setView(fitTo(parsed.doc));
  }, [entry, isNarrow]);

  const change = useLastCallback((next: CanvasDoc) => {
    if (next === doc) return;
    setDoc(next);
    if (!entry) return;
    window.clearTimeout(saveTimerRef.current);
    saveTimerRef.current = window.setTimeout(() => {
      void saveCanvas(entry.title, serializeCanvas(next), vaultName, entry.id);
    }, SAVE_DELAY_MS);
  });

  const noteByTitle = useMemo(() => new Map(notes.map((note) => [note.title.toLowerCase(), note])), [notes]);
  const filesOnCanvas = useMemo(() => new Set(
    doc.nodes.filter(({ type }) => type === 'file').map((node) => titleOfFile(node.file).toLowerCase()),
  ), [doc]);

  const selectedNode = selection?.kind === 'node' ? findNode(doc, selection.id) : undefined;
  const selectedEdge = selection?.kind === 'edge' ? doc.edges.find(({ id }) => id === selection.id) : undefined;
  const nodeEdges = useMemo(() => (
    selectedNode ? doc.edges.filter((edge) => edge.fromNode === selectedNode.id || edge.toNode === selectedNode.id)
      : []
  ), [doc, selectedNode]);

  const toCanvas = (e: { clientX: number; clientY: number }) => {
    const box = boardRef.current!.getBoundingClientRect();
    return { x: (e.clientX - box.left - view.x) / view.scale, y: (e.clientY - box.top - view.y) / view.scale };
  };

  const centerPoint = () => {
    const size = viewport();
    return {
      x: Math.round((size.width / 2 - view.x) / view.scale) + (doc.nodes.length % NEW_COLUMNS) * NEW_OFFSET_X,
      y: Math.round((size.height / 2 - view.y) / view.scale)
        + Math.floor(doc.nodes.length / NEW_COLUMNS) * (NOTE_HEIGHT + NEW_OFFSET_Y),
    };
  };

  const nameOfNode = (id: string) => {
    const node = findNode(doc, id);
    if (!node) return '?';
    return titleOfFile(node.file) || node.label || (node.text || '').replace(/\*/g, '').slice(0, NODE_NAME_MAX)
      || lang(node.type === 'group' ? 'KnowledgeCanvasGroup' : 'KnowledgeCanvasText');
  };

  // Новый файл холста; повторное нажатие, пока он пишется, второго не создаёт
  const createCanvas = async (title: string, content: CanvasDoc) => {
    if (isCreatingRef.current) return;
    isCreatingRef.current = true;
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

  // «Холст из графа»: карточка на каждую заметку, стрелка на каждую ссылку; дальше это обычный холст
  const handleGraphCanvas = useLastCallback(() => {
    const content = canvasFromGraph(notes.map((note) => ({
      id: note.id,
      title: note.title,
      folder: note.folder,
      links: parseNote(note.text).links,
      isDaily: note.isDaily,
    })), { cardHeight: NOTE_HEIGHT });
    void createCanvas(
      freeCanvasTitle(lang('KnowledgeCanvasGraphName'), canvases.map((item) => item.title)), content,
    );
  });

  const handlePickCanvas = useLastCallback((e: React.MouseEvent<HTMLButtonElement>) => {
    setCanvasId(e.currentTarget.dataset.id);
  });

  const add = (node: Pick<CanvasNode, 'type' | 'width' | 'height'> & Partial<CanvasNode>) => {
    const point = centerPoint();
    const id = newCanvasId();
    change(addNode(doc, {
      ...node,
      id,
      x: point.x - node.width / 2,
      y: point.y - node.height / 2,
    }));
    setSelection({ kind: 'node', id });
  };

  const handleAddText = useLastCallback(() => {
    add({
      type: 'text',
      width: CANVAS_DEFAULT_NODE_WIDTH,
      height: CANVAS_DEFAULT_NODE_HEIGHT,
      text: lang('KnowledgeCanvasText'),
    });
  });

  const handleAddGroup = useLastCallback(() => {
    add({
      type: 'group', width: GROUP_WIDTH, height: GROUP_HEIGHT, label: lang('KnowledgeCanvasGroup'),
    });
  });

  const handleAddNote = useLastCallback(() => setIsPickingNote(true));
  const handleCloseNotePicker = useLastCallback(() => setIsPickingNote(false));

  const handlePickNote = useLastCallback((e: React.MouseEvent<HTMLButtonElement>) => {
    setIsPickingNote(false);
    add({
      type: 'file',
      width: CANVAS_DEFAULT_NODE_WIDTH,
      height: NOTE_HEIGHT,
      file: `${e.currentTarget.dataset.title}${FILE_SUFFIX}`,
    });
  });

  // «Связать»: от выделенной карточки к той, которую нажмут следующей
  const handleLinkMode = useLastCallback(() => {
    setLinkFrom(linkFrom || !selectedNode || selectedNode.type === 'group' ? undefined : selectedNode.id);
  });

  const handleRemove = useLastCallback(() => {
    if (!selection) return;
    change(selection.kind === 'node' ? removeNode(doc, selection.id) : removeEdge(doc, selection.id));
    setSelection(undefined);
  });

  const handleEdit = useLastCallback(() => {
    if (selectedEdge) {
      setEditing({
        text: selectedEdge.label || '', color: '', labels: {}, removed: [],
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
    if (!selection || !editing) return;
    if (selection.kind === 'edge') {
      change(updateEdge(doc, selection.id, { label: editing.text.trim() }));
    } else {
      const node = findNode(doc, selection.id)!;
      const text = editing.text.trim();
      let next = updateNode(doc, selection.id, {
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

  const handleEditOpenNote = useLastCallback(() => {
    setEditing(undefined);
    if (selectedNode?.type === 'file') onOpenTitle(titleOfFile(selectedNode.file));
  });

  const handlePointerDown = useLastCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const target = e.target as Element;
    if (target.closest('[data-board-tools]')) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    if (pinchRef.current.down(e.pointerId, e.clientX, e.clientY, view)) {
      dragRef.current = undefined;
      return;
    }
    const nodeId = target.closest<HTMLElement>('[data-canvas-node]')?.dataset.canvasNode;
    const edgeId = target.closest<SVGElement>('[data-canvas-edge]')?.dataset.canvasEdge;
    const point = toCanvas(e);
    if (linkFrom) {
      const node = nodeId ? findNode(doc, nodeId) : undefined;
      if (node && node.id !== linkFrom && node.type !== 'group') change(addEdge(doc, linkFrom, node.id));
      setLinkFrom(undefined);
      return;
    }
    setSelection(nodeId ? { kind: 'node', id: nodeId } : edgeId ? { kind: 'edge', id: edgeId } : undefined);
    dragRef.current = {
      id: nodeId, x: nodeId ? point.x : e.clientX, y: nodeId ? point.y : e.clientY, hasMoved: false,
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
    if (drag.id) {
      const point = toCanvas(e);
      const dx = point.x - drag.x;
      const dy = point.y - drag.y;
      if (!drag.hasMoved && Math.abs(dx) + Math.abs(dy) < DRAG_THRESHOLD) return;
      dragRef.current = {
        ...drag, x: point.x, y: point.y, hasMoved: true,
      };
      change(moveNode(doc, drag.id, dx, dy));
      return;
    }
    setView({ ...view, x: view.x + e.clientX - drag.x, y: view.y + e.clientY - drag.y });
    dragRef.current = {
      ...drag, x: e.clientX, y: e.clientY, hasMoved: true,
    };
  });

  const handlePointerUp = useLastCallback((e: React.PointerEvent<HTMLDivElement>) => {
    pinchRef.current.up(e.pointerId);
    dragRef.current = undefined;
  });

  const handleDoubleClick = useLastCallback((e: React.MouseEvent<HTMLDivElement>) => {
    const nodeId = (e.target as Element).closest<HTMLElement>('[data-canvas-node]')?.dataset.canvasNode;
    const node = nodeId ? findNode(doc, nodeId) : undefined;
    if (node?.type === 'file') onOpenTitle(titleOfFile(node.file));
    else if (node) handleEdit();
  });

  const zoomBy = (factor: number) => {
    const size = viewport();
    setView(zoomAround(view, view.scale * factor, size.width / 2, size.height / 2));
  };

  const handleZoomIn = useLastCallback(() => zoomBy(BOARD_ZOOM_STEP));
  const handleZoomOut = useLastCallback(() => zoomBy(1 / BOARD_ZOOM_STEP));
  const handleFit = useLastCallback(() => setView(fitTo(doc)));
  const handleWheel = useLastCallback((e: React.WheelEvent<HTMLDivElement>) => {
    const box = e.currentTarget.getBoundingClientRect();
    setView(zoomByWheel(view, e.deltaY, e.clientX - box.left, e.clientY - box.top));
  });

  const colorStyle = (color?: string) => (isCanvasPresetColor(color) ? `--gc: ${CANVAS_TONES[color]}; ` : '');

  const renderNode = (node: CanvasNode) => {
    const isSelected = (selection?.kind === 'node' && selection.id === node.id) || linkFrom === node.id;
    const place = `left: ${node.x}px; top: ${node.y}px; width: ${node.width}px; height: ${node.height}px`;
    if (node.type === 'group') {
      return (
        <div
          key={node.id}
          data-canvas-node={node.id}
          data-canvas-type={node.type}
          className={buildClassName(styles.canvasGroup, isSelected && styles.canvasSelected)}
          style={`${colorStyle(node.color)}${place}`}
        >
          <span className={styles.canvasGroupLabel}>{node.label || lang('KnowledgeCanvasGroup')}</span>
        </div>
      );
    }
    const cardClass = buildClassName(
      styles.canvasCard,
      isSelected && styles.canvasSelected,
      linkFrom && linkFrom !== node.id && styles.canvasLinkable,
    );
    if (node.type !== 'file') {
      return (
        <div
          key={node.id}
          data-canvas-node={node.id}
          data-canvas-type={node.type}
          className={buildClassName(cardClass, styles.canvasCardText)}
          style={`${colorStyle(node.color)}${place}`}
        >
          <div className={buildClassName(styles.canvasCardBody, styles.canvasCardBodyText)}>
            {((node.type === 'link' ? node.url : node.text) || '').split('\n').map((line, i) => (
              <div key={i}>{renderCardInline(line)}</div>
            ))}
          </div>
        </div>
      );
    }
    const title = titleOfFile(node.file);
    const note = noteByTitle.get(title.toLowerCase());
    // Начало текста без разметки: заголовок с названием и метки пунктов не показываются
    const lines = note
      ? parseNote(note.text).body.split('\n')
        .map((line) => line.replace(/^#+\s*/, '').replace(/ \^t[a-z0-9]{4,12}\s*$/, '')
          .replace(/^\s*[-*+] (\[[ xX]\] )?/, '• '))
        .filter((line) => line.trim() && line.trim().toLowerCase() !== note.title.toLowerCase())
        .slice(0, PREVIEW_LINES)
      : undefined;
    return (
      <div
        key={node.id}
        data-canvas-node={node.id}
        data-canvas-type={node.type}
        className={cardClass}
        style={`--gc: ${note ? folderColor(note.folder, note.isDaily) : 'var(--pv-faint)'}; ${place}`}
      >
        <div className={styles.canvasCardHead}>
          <i className={styles.canvasCardDot} />
          <span className={kit.ttl}>{title}</span>
        </div>
        <div className={styles.canvasCardBody}>
          {lines ? lines.map((line, i) => (
            <div key={i}>{renderCardInline(line)}</div>
          )) : <div className={kit.faint}>{lang('KnowledgeMissingNote')}</div>}
        </div>
      </div>
    );
  };

  const renderEdge = (edge: CanvasEdge) => {
    const from = findNode(doc, edge.fromNode);
    const to = findNode(doc, edge.toNode);
    if (!from || !to) return undefined;
    const { from: p, to: q } = edgeAnchors(from, to, edge);
    const bend = Math.max(EDGE_MIN_BEND, Math.hypot(q.x - p.x, q.y - p.y) / 3);
    const c1 = { x: p.x + SIDE_NORMALS[p.side].x * bend, y: p.y + SIDE_NORMALS[p.side].y * bend };
    const c2 = { x: q.x + SIDE_NORMALS[q.side].x * bend, y: q.y + SIDE_NORMALS[q.side].y * bend };
    const isSelected = selection?.kind === 'edge' && selection.id === edge.id;
    return (
      <g key={edge.id} data-canvas-edge={edge.id} className={isSelected ? styles.canvasEdgeOn : undefined}>
        <path
          className={styles.canvasEdge}
          style="marker-end: url(#knowledge-canvas-arrow)"
          d={`M${p.x} ${p.y}C${c1.x} ${c1.y} ${c2.x} ${c2.y} ${q.x} ${q.y}`}
        />
        {edge.label && (
          <text
            className={styles.canvasEdgeLabel}
            x={(p.x + 3 * c1.x + 3 * c2.x + q.x) / 8}
            y={(p.y + 3 * c1.y + 3 * c2.y + q.y) / 8 + EDGE_LABEL_SHIFT}
          >
            {edge.label}
          </text>
        )}
      </g>
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

  const groups = doc.nodes.filter(({ type }) => type === 'group');
  const cards = doc.nodes.filter(({ type }) => type !== 'group');
  const editNode = editing && selectedNode;
  const shownEdges = editing ? nodeEdges.filter((edge) => !editing.removed.includes(edge.id)) : [];
  const editTitle = !editNode ? lang('KnowledgeCanvasEdgeTitle')
    : editNode.type === 'group' ? lang('KnowledgeCanvasGroup')
      : editNode.type === 'file' ? titleOfFile(editNode.file) : lang('KnowledgeCanvasTextCard');

  return (
    <div className={styles.canvas} data-notes-canvas={entry.id}>
      <div
        ref={boardRef}
        className={buildClassName(styles.board, view.scale < BOARD_FAR_SCALE && styles.boardFar)}
        style={boardBackgroundStyle(view)}
        data-canvas-board
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
        onDoubleClick={handleDoubleClick}
        onWheel={handleWheel}
      >
        <div className={styles.world} style={`transform: translate(${view.x}px, ${view.y}px) scale(${view.scale})`}>
          <svg className={styles.canvasEdges} width="1" height="1">
            <defs>
              <marker
                id="knowledge-canvas-arrow"
                viewBox="0 0 10 10"
                refX="8"
                refY="5"
                markerWidth="7"
                markerHeight="7"
                orient="auto-start-reverse"
              >
                <path d="M0 0L10 5L0 10z" className={styles.canvasArrow} />
              </marker>
            </defs>
            {doc.edges.map(renderEdge)}
          </svg>
          {groups.map(renderNode)}
          {cards.map(renderNode)}
        </div>
        <div className={styles.boardTools} data-board-tools>
          <div className={styles.boardScroll}>
            {canvases.map((item) => (
              <button
                key={item.id}
                type="button"
                className={buildClassName(
                  kit.chip,
                  styles.boardChip,
                  item.id === entry.id && kit.chipOn,
                  item.id === entry.id && styles.boardChipOn,
                )}
                aria-pressed={item.id === entry.id}
                data-id={item.id}
                data-canvas-chip={item.title}
                onClick={handlePickCanvas}
              >
                <PvIcon name="board" isSmall />
                {item.title}
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
          </div>
          <div className={styles.boardToolRow}>
            <button
              type="button"
              className={styles.boardTool}
              title={lang('KnowledgeCanvasTextCard')}
              aria-label={lang('KnowledgeCanvasText')}
              onClick={handleAddText}
            >
              <PvIcon name="text" isSmall />
            </button>
            <button
              type="button"
              className={styles.boardTool}
              title={lang('KnowledgeCanvasChooseNote')}
              aria-label={lang('KnowledgeCanvasNote')}
              onClick={handleAddNote}
            >
              <PvIcon name="note" isSmall />
            </button>
            <button
              type="button"
              className={styles.boardTool}
              title={lang('KnowledgeCanvasGroup')}
              aria-label={lang('KnowledgeCanvasGroup')}
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
              onClick={handleLinkMode}
            >
              <PvIcon name="link" isSmall />
            </button>
            <button
              type="button"
              className={styles.boardTool}
              title={lang('KnowledgeCanvasEdit')}
              aria-label={lang('KnowledgeCanvasEdit')}
              disabled={!selection}
              onClick={handleEdit}
            >
              <PvIcon name="edit" isSmall />
            </button>
            <button
              type="button"
              className={styles.boardTool}
              title={lang('KnowledgeCanvasRemove')}
              aria-label={lang('KnowledgeCanvasRemove')}
              disabled={!selection}
              onClick={handleRemove}
            >
              <PvIcon name="trash" isSmall />
            </button>
          </div>
        </div>
        {linkFrom && <div className={styles.boardHint} role="status">{lang('KnowledgeCanvasLinkHint')}</div>}
        {isDamaged && <div className={styles.boardHint} role="alert">{lang('KnowledgeCanvasDamaged')}</div>}
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
      <PvSheet isOpen={Boolean(editing)} title={editTitle} onClose={handleEditClose}>
        {editNode?.type === 'file' ? (
          <button type="button" className={kit.btn} onClick={handleEditOpenNote}>
            {lang('KnowledgeCanvasOpenNote')}
          </button>
        ) : editNode?.type === 'text' ? (
          <textarea
            id="knowledge-canvas-text"
            className={kit.textarea}
            value={editing?.text || ''}
            aria-label={lang('KnowledgeCanvasText')}
            onChange={handleEditText}
          />
        ) : (
          <input
            id="knowledge-canvas-text"
            className={kit.input}
            value={editing?.text || ''}
            placeholder={lang(editNode ? 'KnowledgeCanvasGroupName' : 'KnowledgeCanvasLabel')}
            aria-label={lang(editNode ? 'KnowledgeCanvasGroupName' : 'KnowledgeCanvasLabel')}
            onChange={handleEditText}
          />
        )}
        {editNode && (
          <>
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
          </>
        )}
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
        isOpen={isPickingNote}
        title={lang('KnowledgeCanvasChooseNote')}
        isTight
        onClose={handleCloseNotePicker}
      >
        {!notes.length && <p className={styles.mutedLine}>{lang('KnowledgeEmpty')}</p>}
        {notes.map((note) => {
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
    </div>
  );
};

export default memo(NotesCanvas);
