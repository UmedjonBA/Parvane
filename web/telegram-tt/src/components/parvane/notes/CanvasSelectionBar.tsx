import { memo } from '../../../lib/teact/teact';

import type { CanvasPresetColor } from './notesCanvas';

import buildClassName from '../../../util/buildClassName';
import { CANVAS_PRESET_COLORS, isCanvasPresetColor } from './notesCanvas';

import useFlag from '../../../hooks/useFlag';
import useLang from '../../../hooks/useLang';
import useLastCallback from '../../../hooks/useLastCallback';

import PvIcon from './PvIcon';

import styles from './Knowledge.module.scss';

type OwnProps = {
  // Место панели на поле (`left`, `top`); на телефоне панель прижата к низу поля
  place?: string;
  tones: Record<CanvasPresetColor, string>;
  color?: string;
  canEdit?: boolean;
  canDuplicate?: boolean;
  canWrap?: boolean;
  canFit?: boolean;
  canTurn?: boolean;
  onColor: (color?: string) => void;
  onEdit: NoneToVoidFunction;
  onDuplicate: NoneToVoidFunction;
  onWrap: NoneToVoidFunction;
  onFit: NoneToVoidFunction;
  onTurn: NoneToVoidFunction;
  onRemove: NoneToVoidFunction;
  onMore: (e: React.MouseEvent<HTMLButtonElement>) => void;
};

// Панель у выделенного: цвет, правка, копия, группа, удаление; остальное — в меню «⋯»
const CanvasSelectionBar = ({
  place, tones, color, canEdit, canDuplicate, canWrap, canFit, canTurn,
  onColor, onEdit, onDuplicate, onWrap, onFit, onTurn, onRemove, onMore,
}: OwnProps) => {
  const lang = useLang();
  const [isPaletteOpen, openPalette, closePalette] = useFlag();

  const handlePalette = useLastCallback(() => (isPaletteOpen ? closePalette() : openPalette()));

  const handleColor = useLastCallback((e: React.MouseEvent<HTMLButtonElement>) => {
    closePalette();
    onColor(e.currentTarget.dataset.color || undefined);
  });

  const renderButton = (
    name: string, icon: Parameters<typeof PvIcon>[0]['name'], label: string, onClick: NoneToVoidFunction,
  ) => (
    <button
      type="button"
      className={styles.canvasBarButton}
      title={label}
      aria-label={label}
      data-canvas-action={name}
      onClick={onClick}
    >
      <PvIcon name={icon} isSmall />
    </button>
  );

  return (
    <div
      className={buildClassName(styles.canvasBar, !place && styles.canvasBarDocked)}
      style={place}
      role="toolbar"
      aria-label={lang('KnowledgeCanvasSelectionBar')}
      data-board-tools
      data-canvas-selection-bar
    >
      {isPaletteOpen && (
        <div className={styles.canvasBarColors} role="radiogroup" aria-label={lang('KnowledgeCanvasColor')}>
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
              data-canvas-color={item}
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
            data-canvas-color="none"
            onClick={handleColor}
          />
        </div>
      )}
      <div className={styles.canvasBarRow}>
        <button
          type="button"
          className={styles.canvasBarButton}
          title={lang('KnowledgeCanvasColor')}
          aria-label={lang('KnowledgeCanvasColor')}
          aria-expanded={isPaletteOpen}
          data-canvas-action="color"
          onClick={handlePalette}
        >
          <i
            className={buildClassName(styles.canvasSwatch, !color && styles.canvasSwatchNone)}
            style={isCanvasPresetColor(color) ? `--c: ${tones[color]}` : undefined}
          />
        </button>
        {canEdit && renderButton('edit', 'edit', lang('KnowledgeCanvasEdit'), onEdit)}
        {canTurn && renderButton('direction', 'arrow', lang('KnowledgeCanvasDirection'), onTurn)}
        {canDuplicate && renderButton('duplicate', 'copy', lang('KnowledgeCanvasDuplicate'), onDuplicate)}
        {canWrap && renderButton('wrap', 'group', lang('KnowledgeCanvasWrap'), onWrap)}
        {canFit && renderButton('fit', 'fit', lang('KnowledgeCanvasFitGroup'), onFit)}
        {renderButton('remove', 'trash', lang('KnowledgeCanvasRemove'), onRemove)}
        <button
          type="button"
          className={styles.canvasBarButton}
          title={lang('KnowledgeCanvasMore')}
          aria-label={lang('KnowledgeCanvasMore')}
          data-canvas-action="more"
          onClick={onMore}
        >
          <PvIcon name="dots" isSmall />
        </button>
      </div>
    </div>
  );
};

export default memo(CanvasSelectionBar);
