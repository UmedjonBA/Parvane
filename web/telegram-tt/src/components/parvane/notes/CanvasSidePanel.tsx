import { memo, useEffect, useState } from '../../../lib/teact/teact';

import type { RegularLangKey } from '../../../types/language';
import type { CanvasAlign } from './notesCanvasAlign';
import type { CanvasEdgeDirection, CanvasEdgeLine } from './notesCanvasEdges';
import type { PvIconName } from './PvIcon';

import buildClassName from '../../../util/buildClassName';
import { CANVAS_PRESET_COLORS } from './notesCanvas';
import { CANVAS_EDGE_DIRECTIONS, CANVAS_EDGE_LINES } from './notesCanvasEdges';
import { CANVAS_TONES, colorLabel } from './notesCanvasLook';

import useLang from '../../../hooks/useLang';
import useLastCallback from '../../../hooks/useLastCallback';

import PvIcon from './PvIcon';

import styles from './CanvasParts.module.scss';
import kit from './PvKit.module.scss';

export type CanvasPanelEdge = {
  label: string;
  direction: CanvasEdgeDirection;
  line: CanvasEdgeLine;
  fromName: string;
  toName: string;
};

export type CanvasPanelAction =
  | 'edit' | 'open' | 'connect' | 'wrap' | 'fit' | 'duplicate' | 'front' | 'back' | 'distribute' | 'remove' | 'swap';

type OwnProps = {
  count: number;
  color?: string;
  // Одна выбранная стрелка без карточек — панель стрелки (доска `ZdNotesX`)
  edge?: CanvasPanelEdge;
  editIcon: PvIconName;
  editLabel?: string;
  canEdit: boolean;
  canOpen: boolean;
  canConnect: boolean;
  canAlign: boolean;
  canDistribute: boolean;
  canFit: boolean;
  onColor: (color?: string) => void;
  onAction: (action: CanvasPanelAction) => void;
  onAlign: (align: CanvasAlign) => void;
  onEdgeLabel: (label: string) => void;
  onEdgeDirection: (direction: CanvasEdgeDirection) => void;
  onEdgeLine: (line: CanvasEdgeLine) => void;
};

const DIRECTION_MARKS: Record<CanvasEdgeDirection, string> = {
  forward: '→', back: '←', both: '↔', none: '—',
};
const DIRECTION_LABELS: Record<CanvasEdgeDirection, RegularLangKey> = {
  forward: 'KnowledgeCanvasDirForward',
  back: 'KnowledgeCanvasDirBack',
  both: 'KnowledgeCanvasDirBoth',
  none: 'KnowledgeCanvasDirNone',
};

// Панель выделенного на компьютере (доска `XdNotes`): «Выделено: N», цвета, действия двумя столбцами и «Убрать с
// холста»; у одной стрелки — её подпись, направление, линия, концы, «Поменять концы» и «Удалить стрелку»
const CanvasSidePanel = ({
  count, color, edge, editIcon, editLabel, canEdit, canOpen, canConnect, canAlign, canDistribute, canFit,
  onColor, onAction, onAlign, onEdgeLabel, onEdgeDirection, onEdgeLine,
}: OwnProps) => {
  const lang = useLang();
  const [label, setLabel] = useState(edge?.label || '');

  const edgeLabel = edge?.label;
  useEffect(() => {
    setLabel(edgeLabel || '');
  }, [edgeLabel]);

  const handleColor = useLastCallback((e: React.MouseEvent<HTMLButtonElement>) => {
    onColor(e.currentTarget.dataset.color || undefined);
  });

  const handleAction = useLastCallback((e: React.MouseEvent<HTMLButtonElement>) => {
    onAction(e.currentTarget.dataset.canvasAction as CanvasPanelAction);
  });

  const handleAlign = useLastCallback((e: React.MouseEvent<HTMLButtonElement>) => {
    onAlign(e.currentTarget.dataset.canvasAlign as CanvasAlign);
  });

  const handleLabel = useLastCallback((e: React.ChangeEvent<HTMLInputElement>) => setLabel(e.currentTarget.value));
  // Подпись берётся из самого поля: Enter приходит раньше перерисовки с набранным
  const commitLabel = (value: string) => {
    if (value.trim() !== (edgeLabel || '')) onEdgeLabel(value.trim());
  };
  const handleLabelBlur = useLastCallback((e: React.FocusEvent<HTMLInputElement>) => {
    commitLabel(e.currentTarget.value);
  });
  const handleLabelKey = useLastCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') commitLabel(e.currentTarget.value);
  });

  const handleDirection = useLastCallback((e: React.MouseEvent<HTMLButtonElement>) => {
    onEdgeDirection(e.currentTarget.dataset.direction as CanvasEdgeDirection);
  });

  const handleLine = useLastCallback((e: React.MouseEvent<HTMLButtonElement>) => {
    onEdgeLine(e.currentTarget.dataset.line as CanvasEdgeLine);
  });

  function renderAction(
    action: CanvasPanelAction, text: string, isDanger?: boolean, icon?: PvIconName, isDisabled?: boolean,
  ) {
    return (
      <button
        type="button"
        className={buildClassName(kit.chip, styles.panelAction, isDanger && styles.panelDanger)}
        title={text}
        disabled={isDisabled}
        data-canvas-action={action}
        onClick={handleAction}
      >
        {icon && <PvIcon name={icon} isSmall />}
        {text}
      </button>
    );
  }

  function renderColors() {
    return (
      <div className={styles.panelColors} role="radiogroup" aria-label={lang('KnowledgeCanvasColor')}>
        {CANVAS_PRESET_COLORS.map((item) => (
          <button
            key={item}
            type="button"
            role="radio"
            aria-checked={color === item}
            className={buildClassName(styles.swatch, color === item && styles.swatchOn)}
            style={`--c: ${CANVAS_TONES[item]}`}
            title={colorLabel(lang, item)}
            aria-label={colorLabel(lang, item)}
            data-color={item}
            data-canvas-color={item}
            onClick={handleColor}
          />
        ))}
        <button
          type="button"
          role="radio"
          aria-checked={!color}
          className={buildClassName(styles.swatch, styles.swatchNone, !color && styles.swatchOn)}
          title={colorLabel(lang)}
          aria-label={colorLabel(lang)}
          data-color=""
          data-canvas-color="none"
          onClick={handleColor}
        />
      </div>
    );
  }

  if (edge) {
    return (
      <aside
        className={styles.panel}
        aria-label={lang('KnowledgeCanvasEdgeTitle')}
        data-board-tools
        data-canvas-selection-bar
        data-canvas-edge-panel
      >
        <div className={kit.caps}>{lang('KnowledgeCanvasEdgeTitle')}</div>
        <input
          className={kit.input}
          value={label}
          placeholder={lang('KnowledgeCanvasLabel')}
          aria-label={lang('KnowledgeCanvasEdgeLabel')}
          data-canvas-edge-label
          onChange={handleLabel}
          onBlur={handleLabelBlur}
          onKeyDown={handleLabelKey}
        />
        <div className={kit.caps}>{lang('KnowledgeCanvasDirection')}</div>
        <div className={kit.seg} role="radiogroup" aria-label={lang('KnowledgeCanvasDirection')}>
          {CANVAS_EDGE_DIRECTIONS.map((direction) => (
            <button
              key={direction}
              type="button"
              role="radio"
              aria-checked={edge.direction === direction}
              className={buildClassName(kit.segItem, edge.direction === direction && kit.segItemOn)}
              title={lang(DIRECTION_LABELS[direction])}
              aria-label={lang(DIRECTION_LABELS[direction])}
              data-direction={direction}
              onClick={handleDirection}
            >
              {DIRECTION_MARKS[direction]}
            </button>
          ))}
        </div>
        <div className={kit.caps}>{lang('KnowledgeCanvasLine')}</div>
        <div className={kit.seg} role="radiogroup" aria-label={lang('KnowledgeCanvasLine')}>
          {CANVAS_EDGE_LINES.map((line) => (
            <button
              key={line}
              type="button"
              role="radio"
              aria-checked={edge.line === line}
              className={buildClassName(kit.segItem, edge.line === line && kit.segItemOn)}
              data-line={line}
              onClick={handleLine}
            >
              {lang(line === 'solid' ? 'KnowledgeCanvasLineSolid' : 'KnowledgeCanvasLineDashed')}
            </button>
          ))}
        </div>
        <div className={buildClassName(kit.card, styles.panelEnds)}>
          <div className={styles.panelEnd}>
            <span className={kit.grow}>{lang('KnowledgeCanvasEdgeFrom')}</span>
            <span className={kit.sub} data-canvas-edge-from>{edge.fromName}</span>
          </div>
          <div className={styles.panelEnd}>
            <span className={kit.grow}>{lang('KnowledgeCanvasEdgeTo')}</span>
            <span className={kit.sub} data-canvas-edge-to>{edge.toName}</span>
          </div>
        </div>
        {renderColors()}
        <div className={styles.panelRow}>
          {renderAction('swap', lang('KnowledgeCanvasSwapEnds'))}
          {renderAction('remove', lang('KnowledgeCanvasRemoveEdge'), true)}
        </div>
      </aside>
    );
  }

  return (
    <aside
      className={styles.panel}
      aria-label={lang('KnowledgeCanvasSelectionBar')}
      data-board-tools
      data-canvas-selection-bar
    >
      <div className={kit.caps}>{lang('KnowledgeCanvasSelected', { count })}</div>
      {renderColors()}
      {(canEdit || canOpen) && (
        <div className={styles.panelGrid}>
          {canEdit && renderAction('edit', editLabel || lang('KnowledgeCanvasEdit'), undefined, editIcon)}
          {canOpen && renderAction('open', lang('KnowledgeCanvasOpenNote'), undefined, 'open')}
        </div>
      )}
      <div className={styles.panelGrid}>
        {canConnect && renderAction('connect', lang('KnowledgeCanvasConnectArrow'))}
        {renderAction('wrap', lang('KnowledgeCanvasWrap'))}
        {canAlign && (
          <button
            type="button"
            className={buildClassName(kit.chip, styles.panelAction)}
            data-canvas-align="left"
            onClick={handleAlign}
          >
            {lang('KnowledgeCanvasAlignLeft')}
          </button>
        )}
        {canAlign && (
          <button
            type="button"
            className={buildClassName(kit.chip, styles.panelAction)}
            data-canvas-align="top"
            onClick={handleAlign}
          >
            {lang('KnowledgeCanvasAlignTop')}
          </button>
        )}
        {/* Распределить — от трёх карточек; при двух кнопка видна, но не действует (доска `XdNotes`) */}
        {canAlign && renderAction(
          'distribute', lang('KnowledgeCanvasDistribute'), undefined, undefined, !canDistribute,
        )}
        {renderAction('duplicate', lang('KnowledgeCanvasDuplicate'))}
        {canFit && renderAction('fit', lang('KnowledgeCanvasFitGroup'))}
        {renderAction('front', lang('KnowledgeCanvasToFront'))}
        {renderAction('back', lang('KnowledgeCanvasToBack'))}
      </div>
      {renderAction('remove', lang('KnowledgeCanvasRemoveFromCanvas'), true)}
    </aside>
  );
};

export default memo(CanvasSidePanel);
