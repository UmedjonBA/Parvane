import { memo } from '../../../lib/teact/teact';

import type { LangFn } from '../../../util/localization';
import type { CanvasPresetColor } from './notesCanvas';
import type { CanvasAlign } from './notesCanvasAlign';
import type { PvIconName } from './PvIcon';

import buildClassName from '../../../util/buildClassName';
import { CANVAS_PRESET_COLORS } from './notesCanvas';
import { CANVAS_ALIGNS } from './notesCanvasAlign';

import useLang from '../../../hooks/useLang';
import useLastCallback from '../../../hooks/useLastCallback';

import PvIcon from './PvIcon';

import styles from './Knowledge.module.scss';

export type CanvasCommand =
  'edit' | 'open' | 'direction' | 'duplicate' | 'copy' | 'cut' | 'paste' | 'wrap' | 'fit' | 'front' | 'back' | 'props'
  | 'remove' | 'selectAll' | 'textHere' | 'groupHere' | 'note' | 'newNote' | 'link' | 'file' | 'fitView'
  | 'refreshGraph' | 'dropText' | 'dropNewNote' | 'dropNote';
export type CanvasMenuItem = { command: CanvasCommand; icon: PvIconName; label: string; isDanger?: boolean };

type OwnProps = {
  // Точка поля, у которой открыто меню
  x: number;
  y: number;
  items: CanvasMenuItem[];
  tones: Record<CanvasPresetColor, string>;
  // Строка цветов — когда меню открыто для выделенного
  hasColors?: boolean;
  color?: string;
  // Выравнивание — от двух выделенных узлов, распределение — от трёх
  canAlign?: boolean;
  canDistribute?: boolean;
  onCommand: (command: CanvasCommand) => void;
  onColor: (color?: string) => void;
  onAlign: (align: CanvasAlign) => void;
  onDistribute: (axis: 'x' | 'y') => void;
};

const ALIGN_ICONS: Record<CanvasAlign, PvIconName> = {
  left: 'alignLeft',
  center: 'alignCenter',
  right: 'alignRight',
  top: 'alignTop',
  middle: 'alignMiddle',
  bottom: 'alignBottom',
};

function alignLabel(lang: LangFn, align: CanvasAlign) {
  switch (align) {
    case 'left': return lang('KnowledgeCanvasAlignLeft');
    case 'center': return lang('KnowledgeCanvasAlignCenter');
    case 'right': return lang('KnowledgeCanvasAlignRight');
    case 'top': return lang('KnowledgeCanvasAlignTop');
    case 'middle': return lang('KnowledgeCanvasAlignMiddle');
    default: return lang('KnowledgeCanvasAlignBottom');
  }
}

// Меню по правой кнопке (долгому нажатию) и по «⋯» панели выделенного: действия для того, на чём открыто
const CanvasContextMenu = ({
  x, y, items, tones, hasColors, color, canAlign, canDistribute, onCommand, onColor, onAlign, onDistribute,
}: OwnProps) => {
  const lang = useLang();

  const handleCommand = useLastCallback((e: React.MouseEvent<HTMLButtonElement>) => {
    onCommand(e.currentTarget.dataset.command as CanvasCommand);
  });

  const handleColor = useLastCallback((e: React.MouseEvent<HTMLButtonElement>) => {
    onColor(e.currentTarget.dataset.color || undefined);
  });

  const handleAlign = useLastCallback((e: React.MouseEvent<HTMLButtonElement>) => {
    onAlign(e.currentTarget.dataset.align as CanvasAlign);
  });

  const handleDistribute = useLastCallback((e: React.MouseEvent<HTMLButtonElement>) => {
    onDistribute(e.currentTarget.dataset.axis === 'y' ? 'y' : 'x');
  });

  return (
    <div
      className={styles.canvasMenu}
      style={`--mx: ${Math.round(x)}px; --my: ${Math.round(y)}px`}
      role="menu"
      data-board-tools
      data-canvas-context
    >
      {hasColors && (
        <div className={styles.canvasMenuStrip} role="radiogroup" aria-label={lang('KnowledgeCanvasColor')}>
          {CANVAS_PRESET_COLORS.map((item) => (
            <button
              key={item}
              type="button"
              role="radio"
              aria-checked={color === item}
              className={buildClassName(styles.canvasSwatch, color === item && styles.canvasSwatchOn)}
              style={`--c: ${tones[item]}`}
              aria-label={`${lang('KnowledgeCanvasColor')} ${item}`}
              data-color={item}
              onClick={handleColor}
            />
          ))}
          <button
            type="button"
            role="radio"
            aria-checked={!color}
            className={buildClassName(styles.canvasSwatch, styles.canvasSwatchNone, !color && styles.canvasSwatchOn)}
            title={lang('KnowledgeCanvasNoColor')}
            aria-label={lang('KnowledgeCanvasNoColor')}
            data-color=""
            onClick={handleColor}
          />
        </div>
      )}
      {canAlign && (
        <div className={styles.canvasMenuStrip} role="group" aria-label={lang('KnowledgeCanvasAlign')}>
          {CANVAS_ALIGNS.map((align) => (
            <button
              key={align}
              type="button"
              className={styles.canvasBarButton}
              title={alignLabel(lang, align)}
              aria-label={alignLabel(lang, align)}
              data-align={align}
              data-canvas-align={align}
              onClick={handleAlign}
            >
              <PvIcon name={ALIGN_ICONS[align]} isSmall />
            </button>
          ))}
          {canDistribute && (
            <>
              <button
                type="button"
                className={styles.canvasBarButton}
                title={lang('KnowledgeCanvasDistributeX')}
                aria-label={lang('KnowledgeCanvasDistributeX')}
                data-axis="x"
                data-canvas-distribute="x"
                onClick={handleDistribute}
              >
                <PvIcon name="spreadX" isSmall />
              </button>
              <button
                type="button"
                className={styles.canvasBarButton}
                title={lang('KnowledgeCanvasDistributeY')}
                aria-label={lang('KnowledgeCanvasDistributeY')}
                data-axis="y"
                data-canvas-distribute="y"
                onClick={handleDistribute}
              >
                <PvIcon name="spreadY" isSmall />
              </button>
            </>
          )}
        </div>
      )}
      {items.map((item) => (
        <button
          key={item.command}
          type="button"
          role="menuitem"
          className={buildClassName(styles.canvasMenuItem, item.isDanger && styles.canvasMenuDanger)}
          data-command={item.command}
          data-canvas-command={item.command}
          onClick={handleCommand}
        >
          <PvIcon name={item.icon} isSmall />
          {item.label}
        </button>
      ))}
    </div>
  );
};

export default memo(CanvasContextMenu);
