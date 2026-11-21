import { memo } from '../../../lib/teact/teact';

import type { CanvasPresetColor } from './notesCanvas';
import type { PvIconName } from './PvIcon';

import buildClassName from '../../../util/buildClassName';
import { CANVAS_PRESET_COLORS, isCanvasPresetColor } from './notesCanvas';
import { colorLabel } from './notesCanvasLook';

import useFlag from '../../../hooks/useFlag';
import useLang from '../../../hooks/useLang';
import useLastCallback from '../../../hooks/useLastCallback';

import PvIcon from './PvIcon';

import parts from './CanvasParts.module.scss';
import styles from './Knowledge.module.scss';

type OwnProps = {
  // Место панели на поле (`left`, `top`); на телефоне панель прижата к низу поля
  place?: string;
  // Сколько выделено: «N шт.»
  count: number;
  tones: Record<CanvasPresetColor, string>;
  color?: string;
  // «Связать стрелкой»: от одной карточки к следующей нажатой либо между двумя выделенными
  canConnect?: boolean;
  // «Выровнять» — от двух карточек
  canAlign?: boolean;
  // Карточки в выделении: «На передний план» и «Дублировать»
  hasNodes?: boolean;
  // Только стрелки: вместо действий карточек — направление
  canTurn?: boolean;
  onColor: (color?: string) => void;
  onConnect: NoneToVoidFunction;
  onAlign: (e: React.MouseEvent<HTMLButtonElement>) => void;
  onFront: NoneToVoidFunction;
  onDuplicate: NoneToVoidFunction;
  onTurn: NoneToVoidFunction;
  onRemove: NoneToVoidFunction;
  onMore: (e: React.MouseEvent<HTMLButtonElement>) => void;
};

// Полоса выделенного на телефоне (доска `XpNotes`): «N шт.», «Цвет», «Связать стрелкой», «Выровнять» (от двух),
// «На передний план», «Дублировать», «Удалить с холста»; прочее (правка, группа, копирование) — в меню «⋯»
const CanvasSelectionBar = ({
  place, count, tones, color, canConnect, canAlign, hasNodes, canTurn,
  onColor, onConnect, onAlign, onFront, onDuplicate, onTurn, onRemove, onMore,
}: OwnProps) => {
  const lang = useLang();
  const [isPaletteOpen, openPalette, closePalette] = useFlag();

  const handlePalette = useLastCallback(() => (isPaletteOpen ? closePalette() : openPalette()));

  const handleColor = useLastCallback((e: React.MouseEvent<HTMLButtonElement>) => {
    closePalette();
    onColor(e.currentTarget.dataset.color || undefined);
  });

  const renderButton = (
    name: string, icon: PvIconName, label: string, onClick?: (e: React.MouseEvent<HTMLButtonElement>) => void,
    isDanger?: boolean,
  ) => (
    <button
      type="button"
      className={buildClassName(styles.canvasBarButton, isDanger && styles.canvasMenuDanger)}
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
            className={buildClassName(styles.canvasSwatch, styles.canvasSwatchNone, !color && styles.canvasSwatchOn)}
            title={colorLabel(lang)}
            aria-label={colorLabel(lang)}
            data-color=""
            data-canvas-color="none"
            onClick={handleColor}
          />
        </div>
      )}
      <div className={styles.canvasBarRow}>
        <span className={parts.barCount} data-canvas-selection-count={count}>
          {lang('KnowledgeCanvasCount', { count })}
        </span>
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
        {canConnect && renderButton('connect', 'arrow', lang('KnowledgeCanvasConnectArrow'), onConnect)}
        {canTurn && renderButton('direction', 'arrow', lang('KnowledgeCanvasDirection'), onTurn)}
        {canAlign && renderButton('align', 'alignLeft', lang('KnowledgeCanvasAlign'), onAlign)}
        {hasNodes && renderButton('front', 'front', lang('KnowledgeCanvasToFront'), onFront)}
        {hasNodes && renderButton('duplicate', 'copy', lang('KnowledgeCanvasDuplicate'), onDuplicate)}
        {renderButton('remove', 'trash', lang('KnowledgeCanvasDeleteFromCanvas'), onRemove, true)}
        {renderButton('more', 'dots', lang('KnowledgeCanvasMore'), onMore)}
      </div>
    </div>
  );
};

export default memo(CanvasSelectionBar);
