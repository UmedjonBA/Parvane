import {
  memo, useMemo, useRef, useState,
} from '../../../lib/teact/teact';

import type { PlannerState } from '../planner/plannerModel';
import type { NoteEntry } from './notesStore';

import buildClassName from '../../../util/buildClassName';
import { buildGraph, layoutGraph, neighboursOf, nodeRadius } from './notesGraph';
import { parseNote } from './notesModel';

import useLang from '../../../hooks/useLang';
import useLastCallback from '../../../hooks/useLastCallback';

import Button from '../../ui/Button';
import Checkbox from '../../ui/Checkbox';

import styles from './Knowledge.module.scss';

type OwnProps = {
  notes: NoteEntry[];
  planner: PlannerState;
  onOpenNote: (noteId: string) => void;
  onOpenTitle: (title: string) => void;
};

type Drag = { id?: string; x: number; y: number };

const WIDTH = 900;
const HEIGHT = 620;
const ZOOM_STEP = 1.25;
const MIN_ZOOM = 0.4;
const MAX_ZOOM = 4;
const LINK = /\[\[([^\]|\n]+)/g;
const LABEL_MAX = 22;

function linksIn(text: string) {
  return [...text.matchAll(LINK)].map((match) => match[1].trim());
}

// Граф связей: заметки, заметки, которых ещё нет (блёклые), по желанию дни и записи «Плана»
const NotesGraph = ({
  notes, planner, onOpenNote, onOpenTitle,
}: OwnProps) => {
  const svgRef = useRef<SVGSVGElement>();
  const [withDays, setWithDays] = useState(false);
  const [withRecords, setWithRecords] = useState(false);
  const [picked, setPicked] = useState<string>();
  const [view, setView] = useState({ zoom: 1, x: 0, y: 0 });
  const [moved, setMoved] = useState<Record<string, { x: number; y: number }>>({});
  const dragRef = useRef<Drag>();

  const lang = useLang();

  const graph = useMemo(() => {
    const built = buildGraph({
      notes: notes.map((note) => ({
        id: note.id, title: note.title, folder: note.folder, links: parseNote(note.text).links, isDaily: note.isDaily,
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

  const toGraph = (e: { clientX: number; clientY: number }) => {
    const box = svgRef.current!.getBoundingClientRect();
    const scale = WIDTH / box.width;
    return { x: (e.clientX - box.left) * scale, y: (e.clientY - box.top) * scale };
  };

  const handlePointerDown = useLastCallback((e: React.PointerEvent<SVGSVGElement>) => {
    const id = (e.target as Element).closest<SVGGElement>('[data-node]')?.dataset.node;
    const point = toGraph(e);
    dragRef.current = { id, x: point.x, y: point.y };
    e.currentTarget.setPointerCapture(e.pointerId);
    setPicked(id);
  });

  const handlePointerMove = useLastCallback((e: React.PointerEvent<SVGSVGElement>) => {
    const drag = dragRef.current;
    if (!drag) return;
    const point = toGraph(e);
    const dx = point.x - drag.x;
    const dy = point.y - drag.y;
    dragRef.current = { ...drag, x: point.x, y: point.y };
    if (drag.id) {
      const node = byId.get(drag.id)!;
      setMoved({ ...moved, [drag.id]: { x: node.x + dx / view.zoom, y: node.y + dy / view.zoom } });
    } else {
      setView({ ...view, x: view.x + dx, y: view.y + dy });
    }
  });

  const handlePointerUp = useLastCallback(() => {
    dragRef.current = undefined;
  });

  const handleDoubleClick = useLastCallback((e: React.MouseEvent<SVGSVGElement>) => {
    const id = (e.target as Element).closest<SVGGElement>('[data-node]')?.dataset.node;
    const node = id ? byId.get(id) : undefined;
    if (node?.kind === 'note' || node?.kind === 'day') onOpenNote(node.id);
    else if (node?.kind === 'missing') onOpenTitle(node.title);
  });

  const zoomBy = (factor: number) => {
    const zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, view.zoom * factor));
    // Масштаб — вокруг центра поля
    const k = zoom / view.zoom;
    setView({ zoom, x: WIDTH / 2 - (WIDTH / 2 - view.x) * k, y: HEIGHT / 2 - (HEIGHT / 2 - view.y) * k });
  };

  const handleZoomIn = useLastCallback(() => zoomBy(ZOOM_STEP));
  const handleZoomOut = useLastCallback(() => zoomBy(1 / ZOOM_STEP));
  const handleFit = useLastCallback(() => {
    setView({ zoom: 1, x: 0, y: 0 });
    setMoved({});
  });

  const handleWheel = useLastCallback((e: React.WheelEvent<SVGSVGElement>) => {
    zoomBy(e.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP);
  });

  const handleOpenPicked = useLastCallback(() => {
    if (!pickedNode) return;
    if (pickedNode.kind === 'missing') onOpenTitle(pickedNode.title);
    else if (pickedNode.kind !== 'record') onOpenNote(pickedNode.id);
  });

  const noteCount = nodes.filter(({ kind }) => kind === 'note').length;

  return (
    <div className={styles.graph} data-notes-graph>
      <div className={styles.graphBar}>
        <span className={styles.chip}>{lang('KnowledgeGraphNotes', { count: noteCount })}</span>
        <Checkbox label={lang('KnowledgeGraphDays')} checked={withDays} onCheck={setWithDays} />
        <Checkbox label={lang('KnowledgeGraphRecords')} checked={withRecords} onCheck={setWithRecords} />
        <span className={styles.grow} />
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
      {!nodes.length && <p className={styles.muted}>{lang('KnowledgeGraphEmpty')}</p>}
      <svg
        ref={svgRef}
        className={styles.graphField}
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onDoubleClick={handleDoubleClick}
        onWheel={handleWheel}
      >
        <g transform={`translate(${view.x} ${view.y}) scale(${view.zoom})`}>
          {graph.edges.map((edge) => {
            const from = byId.get(edge.from);
            const to = byId.get(edge.to);
            if (!from || !to) return undefined;
            const isOn = picked === edge.from || picked === edge.to;
            return (
              <line
                key={`${edge.from}>${edge.to}`}
                className={buildClassName(styles.graphEdge, isOn && styles.graphEdgeOn)}
                x1={from.x}
                y1={from.y}
                x2={to.x}
                y2={to.y}
              />
            );
          })}
          {nodes.map((node) => {
            const radius = nodeRadius(node.degree);
            const isDim = Boolean(picked) && picked !== node.id && !neighbours?.has(node.id);
            return (
              <g
                key={node.id}
                className={buildClassName(styles.graphNode, styles[`graph_${node.kind}`], isDim && styles.graphDim)}
                data-node={node.id}
                data-kind={node.kind}
                transform={`translate(${node.x} ${node.y})`}
              >
                <circle r={radius} />
                <text y={radius + 12} textAnchor="middle">
                  {node.title.length > LABEL_MAX ? `${node.title.slice(0, LABEL_MAX)}…` : node.title}
                </text>
              </g>
            );
          })}
        </g>
      </svg>
      {pickedNode && (
        <div className={styles.graphCard} data-graph-card>
          <span className={styles.rowTitle}>{pickedNode.title}</span>
          {pickedNode.kind === 'missing' && <span className={styles.muted}>{lang('KnowledgeMissingNote')}</span>}
          {pickedNode.kind !== 'record' && (
            <Button size="tiny" onClick={handleOpenPicked}>{lang('KnowledgeGraphOpen')}</Button>
          )}
        </div>
      )}
    </div>
  );
};

export default memo(NotesGraph);
