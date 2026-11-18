import { memo, useMemo } from '../../../lib/teact/teact';

import type { NotesIndex } from './notesModel';
import type { PlannedItem } from './notesPlanned';
import type { NoteEntry } from './notesStore';

import buildClassName from '../../../util/buildClassName';
import { isProtocolLoaded } from '../../../api/parvane/v2/engine';
import { layoutNotesGraph, notesGraphEdgePath } from './notesGraphEngine';
import { NOTES_GRAPH_METRICS } from './notesGraphView';

import useLang from '../../../hooks/useLang';
import useLastCallback from '../../../hooks/useLastCallback';

import { nodeColor } from './NotesGraphLayers';

import styles from './NoteLinks.module.scss';

type OwnProps = {
  note: NoteEntry;
  index: NotesIndex;
  planned: PlannedItem[];
  onOpenTitle: (title: string) => void;
};

// Поле вокруг раскладки, в её единицах
const PAD = 16;
const MIN_WIDTH = 200;
const MIN_HEIGHT = 130;

// Малый граф «Связей»: заметка и её соседи на один шаг. Раскладка — та же, что у большого графа (движок,
// область «вокруг заметки»); здесь только рисунок. Нажатие на точку открывает заметку
const NoteLinksGraph = ({
  note, index, planned, onOpenTitle,
}: OwnProps) => {
  const lang = useLang();

  const layout = useMemo(() => {
    if (!isProtocolLoaded()) return undefined;
    return layoutNotesGraph({
      notes: index.notes.map((item) => ({
        id: item.id, title: item.title, folder: item.folder, links: item.parsed.links,
      })),
      records: planned.map((item) => ({
        id: item.key, title: item.name, links: [note.title], type: item.kind,
      })),
      scope: { kind: 'around', note: note.id, depth: 1 },
      withDays: true,
      withRecords: true,
      ...NOTES_GRAPH_METRICS,
    });
  }, [index, planned, note.id, note.title]);

  const handleOpen = useLastCallback((e: React.MouseEvent<SVGGElement>) => {
    const { title } = e.currentTarget.dataset;
    if (title) onOpenTitle(title);
  });

  if (!layout || layout.nodes.length < 2) return undefined;

  // Поле не меньше карточки макета: два узла не растягиваются на всю ширину
  const xs = layout.nodes.flatMap(({ x, r }) => [x - r, x + r]);
  const ys = layout.nodes.flatMap(({ y, r }) => [y - r, y + r]);
  const left = Math.min(...xs);
  const top = Math.min(...ys);
  const width = Math.max(MIN_WIDTH, Math.max(...xs) - left + PAD * 2);
  const height = Math.max(MIN_HEIGHT, Math.max(...ys) - top + PAD * 2);
  const x0 = left - (width - (Math.max(...xs) - left)) / 2;
  const y0 = top - (height - (Math.max(...ys) - top)) / 2;

  return (
    <svg
      className={styles.graph}
      viewBox={`${x0} ${y0} ${width} ${height}`}
      role="img"
      aria-label={lang('KnowledgeGraph')}
      data-note-graph={layout.nodes.length}
    >
      {layout.edges.map((edge) => (
        <path key={`${edge.from}>${edge.to}`} className={styles.graphEdge} d={notesGraphEdgePath(edge)} />
      ))}
      {layout.nodes.map((node) => {
        const isSelf = node.id === note.id;
        const canOpen = !isSelf && node.kind !== 'record';
        return (
          <g
            key={node.id}
            className={buildClassName(canOpen && styles.graphNode)}
            style={`--c: ${isSelf ? 'var(--pv-accent)' : nodeColor(node)}`}
            data-title={canOpen ? node.title : undefined}
            data-mini-node={node.kind}
            onClick={canOpen ? handleOpen : undefined}
          >
            <title>{node.title}</title>
            <circle
              className={buildClassName(styles.graphDot, node.kind === 'missing' && styles.graphDotMissing)}
              cx={node.x}
              cy={node.y}
              r={node.r}
            />
          </g>
        );
      })}
    </svg>
  );
};

export default memo(NoteLinksGraph);
