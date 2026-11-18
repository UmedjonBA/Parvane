import { memo } from '../../../lib/teact/teact';

import type { NotesGraphEdge, NotesGraphNode } from './notesGraphEngine';

import buildClassName from '../../../util/buildClassName';
import { notesGraphEdgePath } from './notesGraphEngine';
import {
  canLinkFrom, canLinkTo, clipGraphLabel, edgeHeads, labelAnchor,
} from './notesGraphView';
import { folderColor } from './notesLook';

import styles from './NotesGraph.module.scss';

// Кольцо, за которое тянут связь: настолько шире кружка
const HANDLE_GAP = 5;
// Нажатие ловится и на столько дальше кольца
const HANDLE_REACH = 3;
// Наконечники связи: у конца и, у взаимной, у начала
const HEAD_KEYS = ['to', 'from'];

type EdgesProps = {
  edges: NotesGraphEdge[];
  byId: Map<string, NotesGraphNode>;
  picked?: string;
  found?: Set<string>;
  linkSourceId?: string;
  pickedEdge?: string;
  flash?: string;
};

// Слой связей: линии — как их дал движок, наконечники рисует экран. Сдвиг и масштаб поля слой не перерисовывают
export const GraphEdges = memo(({
  edges, byId, picked, found, linkSourceId, pickedEdge, flash,
}: EdgesProps) => (
  <g data-graph-edges>
    {edges.map((edge) => {
      const from = byId.get(edge.from);
      const to = byId.get(edge.to);
      if (!from || !to) return undefined;
      const key = edgeKey(edge);
      const path = notesGraphEdgePath(edge);
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
            styles.edge,
            isEditable && styles.edgeEditable,
            isOn && !isDim && styles.edgeOn,
            isDim && key !== pickedEdge && styles.dim,
            key === pickedEdge && styles.edgePicked,
            flash === edgePair(edge.from, edge.to) && styles.edgeFlash,
          )}
          data-graph-edge={key}
          data-from={edge.from}
          data-to={edge.to}
          data-from-title={from.title}
          data-to-title={to.title}
          data-editable={isEditable ? 'true' : undefined}
          data-mutual={edge.mutual ? 'true' : undefined}
        >
          <path className={styles.edgeHit} d={path} data-edge-line />
          <path className={styles.edgeLine} d={path} data-edge-line />
          {edgeHeads(edge).map((head, i) => (
            <path key={HEAD_KEYS[i]} className={styles.edgeHead} d={head} data-edge-head />
          ))}
        </g>
      );
    })}
  </g>
));

type NodesProps = {
  nodes: NotesGraphNode[];
  labels: Map<string, string>;
  picked?: string;
  neighbours?: Set<string>;
  found?: Set<string>;
  overId?: string;
  linkSourceId?: string;
  // Мелкий масштаб: подписи только у выбранной точки, её соседей и найденного поиском
  areLabelsHidden: boolean;
  // Крупный масштаб: видны и подписи, которым движок места без наложений не нашёл
  areAllLabelsShown: boolean;
};

// Слой точек: кружок и подпись стоят там, где их поставил движок; группа точки сдвинута в её центр, чтобы
// перетаскивание меняло один атрибут
export const GraphNodes = memo(({
  nodes, labels, picked, neighbours, found, overId, linkSourceId, areLabelsHidden, areAllLabelsShown,
}: NodesProps) => (
  <g data-graph-nodes>
    {nodes.map((node) => {
      const isNear = picked === node.id || Boolean(picked && neighbours?.has(node.id));
      const isFound = Boolean(found?.has(node.id));
      const isTarget = overId === node.id;
      const isSource = linkSourceId === node.id;
      const isDim = linkSourceId ? !isSource && !canLinkTo(node)
        : found ? !isFound : Boolean(picked) && !isNear;
      const isLabelForced = isNear || isFound || isTarget || isSource;
      const isLabelShown = isLabelForced || (!areLabelsHidden && (node.label.show || areAllLabelsShown));
      const anchor = labelAnchor(node.label);
      return (
        <g
          key={node.id}
          className={buildClassName(
            styles.node,
            node.kind === 'missing' && styles.nodeMissing,
            picked === node.id && styles.nodePicked,
            isFound && styles.nodeFound,
            isTarget && styles.nodeTarget,
            isSource && styles.nodeSource,
            isDim && styles.dim,
          )}
          style={`--c: ${nodeColor(node)}`}
          transform={`translate(${node.x} ${node.y})`}
          data-node={node.id}
          data-kind={node.kind}
          data-title={node.title}
          data-found={isFound ? '' : undefined}
        >
          {/* Под кольцом — сплошной круг чуть шире: нажатие ловит он, пунктир кольца не оставляет «дыр» */}
          {canLinkFrom(node) && (
            <circle
              className={styles.nodeRing}
              cx={0}
              cy={0}
              r={node.r + HANDLE_GAP + HANDLE_REACH}
              data-graph-ring={node.id}
            />
          )}
          {canLinkFrom(node) && (
            <circle className={styles.nodeHandle} cx={0} cy={0} r={node.r + HANDLE_GAP} data-graph-handle={node.id} />
          )}
          <circle className={styles.nodeDot} cx={0} cy={0} r={node.r} data-graph-dot />
          <text
            className={buildClassName(
              styles.nodeLabel,
              anchor.anchor === 'start' && styles.nodeLabelStart,
              anchor.anchor === 'end' && styles.nodeLabelEnd,
              !isLabelShown && styles.nodeLabelHover,
            )}
            x={anchor.x - node.x}
            y={anchor.y - node.y}
            data-graph-label={isLabelShown ? 'shown' : 'hover'}
          >
            {clipGraphLabel(labels.get(node.id) || node.title, node.label.w)}
          </text>
        </g>
      );
    })}
  </g>
));

export function edgeKey(edge: Pick<NotesGraphEdge, 'from' | 'to'>) {
  return `${edge.from}>${edge.to}`;
}

export function edgePair(a: string, b: string) {
  return a < b ? `${a}>${b}` : `${b}>${a}`;
}

export function nodeColor(node: Pick<NotesGraphNode, 'kind' | 'group'>) {
  if (node.kind === 'missing') return 'var(--pv-faint)';
  if (node.kind === 'day') return 'var(--pv-note)';
  if (node.kind === 'record') return node.group === 'task' ? 'var(--pv-task)' : 'var(--pv-event)';
  return folderColor(node.group || '');
}
