import {
  memo, useEffect, useMemo, useRef, useState,
} from '../../../lib/teact/teact';

import type { CanvasDoc, CanvasNode, CanvasView } from './notesCanvas';
import type { CanvasEntry, NoteEntry } from './notesStore';

import buildClassName from '../../../util/buildClassName';
import {
  addEdge, addNode, boundsOf, CANVAS_DEFAULT_NODE_HEIGHT, CANVAS_DEFAULT_NODE_WIDTH, CANVAS_PRESET_COLORS,
  clampCanvasScale, createEmptyCanvas, edgeAnchors, findNode, firstGroupView, fitView, moveNode, newCanvasId,
  parseCanvas, removeEdge, removeNode, serializeCanvas, updateEdge, updateNode,
} from './notesCanvas';
import { parseNote } from './notesModel';
import { saveCanvas } from './notesStore';

import useLang from '../../../hooks/useLang';
import useLastCallback from '../../../hooks/useLastCallback';

import Button from '../../ui/Button';
import Modal from '../../ui/Modal';

import styles from './Knowledge.module.scss';

type OwnProps = {
  canvases: CanvasEntry[];
  notes: NoteEntry[];
  isNarrow: boolean;
  onOpenTitle: (title: string) => void;
};

type Selection = { kind: 'node' | 'edge'; id: string };
type Drag = { id?: string; x: number; y: number; hasMoved: boolean };
type Editing = { text: string; color: string };

const SAVE_DELAY_MS = 1200;
const ZOOM_STEP = 1.25;
const GROUP_WIDTH = 420;
const GROUP_HEIGHT = 280;
const NOTE_HEIGHT = 140;
const NEW_OFFSET = 24;
const PREVIEW_LINES = 6;
const FILE_SUFFIX = '.md';
const DRAG_THRESHOLD = 3;

function titleOfFile(file?: string) {
  const name = (file || '').split('/').pop() || '';
  return name.endsWith(FILE_SUFFIX) ? name.slice(0, -FILE_SUFFIX.length) : name;
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
  const [view, setView] = useState<CanvasView>({ scale: 1, x: 0, y: 0 });
  const [selection, setSelection] = useState<Selection>();
  const [linkFrom, setLinkFrom] = useState<string | false>();
  const [editing, setEditing] = useState<Editing>();
  const [isPickingNote, setIsPickingNote] = useState(false);
  const dragRef = useRef<Drag>();
  const saveTimerRef = useRef<number>();
  const loadedRef = useRef<string>();

  const lang = useLang();
  const vaultName = lang('KnowledgeVaultName');
  const entry = canvases.find(({ id }) => id === canvasId) || canvases[0];

  const viewport = () => {
    const box = boardRef.current?.getBoundingClientRect();
    return { width: box?.width || 800, height: box?.height || 600 };
  };

  // Открытие холста: разбор файла и начальный вид (на телефоне — крупно на первой группе)
  useEffect(() => {
    if (!entry || loadedRef.current === entry.id) return;
    loadedRef.current = entry.id;
    const parsed = parseCanvas(entry.text);
    setDoc(parsed.doc);
    setIsDamaged(Boolean(parsed.error));
    setSelection(undefined);
    setLinkFrom(undefined);
    setView(isNarrow ? firstGroupView(parsed.doc, viewport()) : fitView(boundsOf(parsed.doc), viewport()));
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

  const toCanvas = (e: { clientX: number; clientY: number }) => {
    const box = boardRef.current!.getBoundingClientRect();
    return { x: (e.clientX - box.left - view.x) / view.scale, y: (e.clientY - box.top - view.y) / view.scale };
  };

  const centerPoint = () => {
    const size = viewport();
    return {
      x: Math.round((size.width / 2 - view.x) / view.scale) + doc.nodes.length * NEW_OFFSET,
      y: Math.round((size.height / 2 - view.y) / view.scale) + doc.nodes.length * NEW_OFFSET,
    };
  };

  const handleNewCanvas = useLastCallback(async () => {
    const title = lang('KnowledgeCanvasName', { count: canvases.length + 1 });
    const id = await saveCanvas(title, serializeCanvas(createEmptyCanvas()), vaultName);
    if (id) setCanvasId(id);
  });

  const handlePickCanvas = useLastCallback((e: React.ChangeEvent<HTMLSelectElement>) => {
    setCanvasId(e.currentTarget.value);
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

  const handleLinkMode = useLastCallback(() => {
    setLinkFrom(linkFrom === undefined ? false : undefined);
    setSelection(undefined);
  });

  const handleRemove = useLastCallback(() => {
    if (!selection) return;
    change(selection.kind === 'node' ? removeNode(doc, selection.id) : removeEdge(doc, selection.id));
    setSelection(undefined);
  });

  const handleEdit = useLastCallback(() => {
    if (!selection) return;
    if (selection.kind === 'edge') {
      const edge = doc.edges.find(({ id }) => id === selection.id);
      setEditing({ text: edge?.label || '', color: '' });
      return;
    }
    const node = findNode(doc, selection.id);
    if (!node) return;
    setEditing({ text: (node.type === 'group' ? node.label : node.text) || '', color: node.color || '' });
  });

  const handleEditText = useLastCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setEditing({ ...editing!, text: e.currentTarget.value });
  });

  const handleEditColor = useLastCallback((e: React.MouseEvent<HTMLButtonElement>) => {
    setEditing({ ...editing!, color: e.currentTarget.dataset.color || '' });
  });

  const handleEditClose = useLastCallback(() => setEditing(undefined));

  const handleEditSave = useLastCallback(() => {
    if (!selection || !editing) return;
    if (selection.kind === 'edge') {
      change(updateEdge(doc, selection.id, { label: editing.text.trim() }));
    } else {
      const node = findNode(doc, selection.id)!;
      const text = editing.text.trim();
      change(updateNode(doc, selection.id, {
        color: editing.color || undefined,
        label: node.type === 'group' ? text || undefined : node.label,
        text: node.type === 'text' ? text : node.text,
      }));
    }
    setEditing(undefined);
  });

  const handlePointerDown = useLastCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const target = e.target as Element;
    const nodeId = target.closest<HTMLElement>('[data-canvas-node]')?.dataset.canvasNode;
    const edgeId = target.closest<SVGElement>('[data-canvas-edge]')?.dataset.canvasEdge;
    const point = toCanvas(e);
    if (linkFrom !== undefined && nodeId) {
      if (linkFrom === false) {
        setLinkFrom(nodeId);
      } else {
        change(addEdge(doc, linkFrom, nodeId));
        setLinkFrom(undefined);
      }
      return;
    }
    setSelection(nodeId ? { kind: 'node', id: nodeId } : edgeId ? { kind: 'edge', id: edgeId } : undefined);
    dragRef.current = {
      id: nodeId, x: nodeId ? point.x : e.clientX, y: nodeId ? point.y : e.clientY, hasMoved: false,
    };
    e.currentTarget.setPointerCapture(e.pointerId);
  });

  const handlePointerMove = useLastCallback((e: React.PointerEvent<HTMLDivElement>) => {
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

  const handlePointerUp = useLastCallback(() => {
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
    const scale = clampCanvasScale(view.scale * factor);
    const k = scale / view.scale;
    setView({
      scale,
      x: size.width / 2 - (size.width / 2 - view.x) * k,
      y: size.height / 2 - (size.height / 2 - view.y) * k,
    });
  };

  const handleZoomIn = useLastCallback(() => zoomBy(ZOOM_STEP));
  const handleZoomOut = useLastCallback(() => zoomBy(1 / ZOOM_STEP));
  const handleFit = useLastCallback(() => setView(fitView(boundsOf(doc), viewport())));
  const handleWheel = useLastCallback((e: React.WheelEvent<HTMLDivElement>) => {
    zoomBy(e.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP);
  });

  const renderNode = (node: CanvasNode) => {
    const isSelected = selection?.kind === 'node' && selection.id === node.id;
    const note = node.type === 'file' ? noteByTitle.get(titleOfFile(node.file).toLowerCase()) : undefined;
    const preview = note
      ? parseNote(note.text).body.split('\n').filter((line) => line.trim()).slice(0, PREVIEW_LINES).join('\n')
      : undefined;
    return (
      <div
        key={node.id}
        className={buildClassName(
          styles.canvasNode,
          styles[`canvas_${node.type}`],
          node.color && styles[`canvasColor${node.color}`],
          isSelected && styles.canvasSelected,
          linkFrom === node.id && styles.canvasSelected,
        )}
        style={`left: ${node.x}px; top: ${node.y}px; width: ${node.width}px; height: ${node.height}px`}
        data-canvas-node={node.id}
        data-canvas-type={node.type}
      >
        {node.type === 'group' && <span className={styles.canvasGroupLabel}>{node.label}</span>}
        {node.type === 'text' && <span className={styles.canvasText}>{node.text}</span>}
        {node.type === 'link' && <span className={styles.canvasText}>{node.url}</span>}
        {node.type === 'file' && (
          <>
            <span className={styles.rowTitle}>{titleOfFile(node.file)}</span>
            <span className={styles.canvasPreview}>{preview ?? lang('KnowledgeMissingNote')}</span>
          </>
        )}
      </div>
    );
  };

  if (!entry) {
    return (
      <div className={styles.canvasEmpty} data-notes-canvas="empty">
        <p className={styles.muted}>{lang('KnowledgeCanvasEmpty')}</p>
        <Button size="smaller" onClick={handleNewCanvas}>{lang('KnowledgeCanvasNew')}</Button>
      </div>
    );
  }

  const groups = doc.nodes.filter(({ type }) => type === 'group');
  const cards = doc.nodes.filter(({ type }) => type !== 'group');

  return (
    <div className={styles.canvas} data-notes-canvas={entry.id}>
      <div className={styles.graphBar}>
        <select
          className={styles.canvasSelect}
          value={entry.id}
          aria-label={lang('KnowledgeCanvasPick')}
          onChange={handlePickCanvas}
        >
          {canvases.map((item) => <option key={item.id} value={item.id}>{item.title}</option>)}
        </select>
        <Button size="tiny" color="translucent" onClick={handleNewCanvas}>{lang('KnowledgeCanvasNew')}</Button>
        <span className={styles.grow} />
        <Button size="tiny" color="translucent" onClick={handleAddText}>{lang('KnowledgeCanvasText')}</Button>
        <Button size="tiny" color="translucent" onClick={handleAddNote}>{lang('KnowledgeCanvasNote')}</Button>
        <Button size="tiny" color="translucent" onClick={handleAddGroup}>{lang('KnowledgeCanvasGroup')}</Button>
        <Button size="tiny" color={linkFrom !== undefined ? 'primary' : 'translucent'} onClick={handleLinkMode}>
          {lang('KnowledgeCanvasLink')}
        </Button>
        <Button size="tiny" color="translucent" disabled={!selection} onClick={handleEdit}>
          {lang('KnowledgeCanvasEdit')}
        </Button>
        <Button size="tiny" color="translucent" disabled={!selection} onClick={handleRemove}>
          {lang('KnowledgeCanvasRemove')}
        </Button>
        <Button
          round
          size="tiny"
          color="translucent"
          iconName="zoom-out"
          ariaLabel={lang('KnowledgeZoomOut')}
          onClick={handleZoomOut}
        />
        <Button
          round
          size="tiny"
          color="translucent"
          iconName="zoom-in"
          ariaLabel={lang('KnowledgeZoomIn')}
          onClick={handleZoomIn}
        />
        <Button size="tiny" color="translucent" onClick={handleFit}>{lang('KnowledgeZoomFit')}</Button>
      </div>
      {linkFrom !== undefined && <p className={styles.muted}>{lang('KnowledgeCanvasLinkHint')}</p>}
      {isDamaged && <p className={styles.muted} role="alert">{lang('KnowledgeCanvasDamaged')}</p>}
      <div
        ref={boardRef}
        className={styles.board}
        data-canvas-board
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onDoubleClick={handleDoubleClick}
        onWheel={handleWheel}
      >
        <div
          className={styles.boardLayer}
          style={`transform: translate(${view.x}px, ${view.y}px) scale(${view.scale})`}
        >
          {groups.map(renderNode)}
          <svg className={styles.boardEdges}>
            {doc.edges.map((edge) => {
              const from = findNode(doc, edge.fromNode);
              const to = findNode(doc, edge.toNode);
              if (!from || !to) return undefined;
              const anchors = edgeAnchors(from, to, edge);
              const isSelected = selection?.kind === 'edge' && selection.id === edge.id;
              return (
                <g key={edge.id} data-canvas-edge={edge.id} className={isSelected ? styles.canvasEdgeOn : undefined}>
                  <line
                    className={styles.canvasEdge}
                    x1={anchors.from.x}
                    y1={anchors.from.y}
                    x2={anchors.to.x}
                    y2={anchors.to.y}
                    markerEnd="url(#canvas-arrow)"
                  />
                  {edge.label && (
                    <text
                      className={styles.canvasEdgeLabel}
                      x={(anchors.from.x + anchors.to.x) / 2}
                      y={(anchors.from.y + anchors.to.y) / 2 - 4}
                      textAnchor="middle"
                    >
                      {edge.label}
                    </text>
                  )}
                </g>
              );
            })}
            <defs>
              <marker
                id="canvas-arrow"
                viewBox="0 0 10 10"
                refX="9"
                refY="5"
                markerWidth="7"
                markerHeight="7"
                orient="auto"
              >
                <path d="M 0 0 L 10 5 L 0 10 z" className={styles.canvasArrow} />
              </marker>
            </defs>
          </svg>
          {cards.map(renderNode)}
        </div>
      </div>
      <Modal
        isOpen={Boolean(editing)}
        title={lang('KnowledgeCanvasEdit')}
        hasCloseButton
        onClose={handleEditClose}
      >
        <div className={styles.canvasForm}>
          <textarea
            id="knowledge-canvas-text"
            className={buildClassName('form-control', styles.canvasFormText)}
            value={editing?.text || ''}
            aria-label={lang('KnowledgeCanvasLabel')}
            onChange={handleEditText}
          />
          {selection?.kind === 'node' && (
            <div className={styles.chips} role="radiogroup" aria-label={lang('KnowledgeCanvasColor')}>
              <button type="button" className={styles.chip} data-color="" onClick={handleEditColor}>
                {lang('KnowledgeCanvasNoColor')}
              </button>
              {CANVAS_PRESET_COLORS.map((color) => (
                <button
                  key={color}
                  type="button"
                  className={buildClassName(
                    styles.canvasSwatch,
                    styles[`canvasColor${color}`],
                    editing?.color === color && styles.canvasSelected,
                  )}
                  data-color={color}
                  aria-label={`${lang('KnowledgeCanvasColor')} ${color}`}
                  onClick={handleEditColor}
                />
              ))}
            </div>
          )}
          <Button size="smaller" onClick={handleEditSave}>{lang('KnowledgeSave')}</Button>
        </div>
      </Modal>
      <Modal
        isOpen={isPickingNote}
        title={lang('KnowledgeCanvasChooseNote')}
        hasCloseButton
        onClose={handleCloseNotePicker}
      >
        <div className={styles.canvasForm}>
          {notes.map((note) => (
            <button key={note.id} type="button" className={styles.row} data-title={note.title} onClick={handlePickNote}>
              <span className={styles.rowTitle}>{note.title}</span>
            </button>
          ))}
        </div>
      </Modal>
    </div>
  );
};

export default memo(NotesCanvas);
