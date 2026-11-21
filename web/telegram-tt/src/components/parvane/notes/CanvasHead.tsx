import { memo } from '../../../lib/teact/teact';

import type { RegularLangKey } from '../../../types/language';
import type { PvIconName } from './PvIcon';

import buildClassName from '../../../util/buildClassName';

import useLang from '../../../hooks/useLang';

import PvIcon from './PvIcon';

import styles from './CanvasParts.module.scss';
import kit from './PvKit.module.scss';

export type CanvasTool = 'text' | 'note' | 'new-note' | 'link' | 'file' | 'group';
// Панель выделенного на компьютере: карточка либо её стрелка (переключатель «Карточка · Стрелка», доска `ZdNotesX`)
export type CanvasPanelKind = 'card' | 'edge';

type OwnProps = {
  title: string;
  // Под названием: «холст · выбрана стрелка», «холст · выделено: N»
  subtitle?: string;
  isNarrow: boolean;
  isFromGraph: boolean;
  canUndo: boolean;
  canRedo: boolean;
  canConnect: boolean;
  isConnecting: boolean;
  isSelectMode: boolean;
  hasSelection: boolean;
  // Выделено что угодно (и стрелки): «Готово» в шапке
  hasAnySelection: boolean;
  // Есть что выбрать по переключателю: открытая сейчас панель — `panelKind`
  panelKind?: CanvasPanelKind;
  onBack: NoneToVoidFunction;
  onUndo: NoneToVoidFunction;
  onRedo: NoneToVoidFunction;
  onRefresh: NoneToVoidFunction;
  onMenu: NoneToVoidFunction;
  onTool: (tool: CanvasTool) => void;
  onConnect: NoneToVoidFunction;
  onSelectMode: NoneToVoidFunction;
  onPanel: (kind: CanvasPanelKind) => void;
  // «Готово»: выделение снимается
  onDone: NoneToVoidFunction;
};

const TOOLS: { tool: CanvasTool; icon: PvIconName; label: RegularLangKey; title: RegularLangKey }[] = [
  {
    tool: 'text', icon: 'text', label: 'KnowledgeCanvasText', title: 'KnowledgeCanvasTextCard',
  },
  {
    tool: 'note', icon: 'note', label: 'KnowledgeCanvasNote', title: 'KnowledgeCanvasChooseNote',
  },
  {
    tool: 'new-note', icon: 'noteNew', label: 'KnowledgeCanvasNewNoteShort', title: 'KnowledgeCanvasNewNote',
  },
  {
    tool: 'link', icon: 'open', label: 'KnowledgeCanvasLinkCard', title: 'KnowledgeCanvasLinkTitle',
  },
  {
    tool: 'file', icon: 'file', label: 'KnowledgeCanvasFileCard', title: 'KnowledgeCanvasFileChoose',
  },
  {
    tool: 'group', icon: 'group', label: 'KnowledgeCanvasGroup', title: 'KnowledgeCanvasGroup',
  },
];

// Шапка открытого холста (доски `XdNotes`, `XpNotes`): «назад» к списку холстов и название; на компьютере в той же
// строке инструменты с подписями, «Отменить / Вернуть», «Обновить из графа» (только у холста из графа) и действия
// с холстом. На телефоне инструменты — нижней панелью с подписями под значками, в шапке — отмена и возврат
const CanvasHead = ({
  title, subtitle, isNarrow, isFromGraph, canUndo, canRedo, canConnect, isConnecting, isSelectMode, hasSelection,
  hasAnySelection, panelKind, onBack, onUndo, onRedo, onRefresh, onMenu, onTool, onConnect, onSelectMode, onPanel,
  onDone,
}: OwnProps) => {
  const lang = useLang();

  function handlePanel(e: React.MouseEvent<HTMLButtonElement>) {
    onPanel(e.currentTarget.dataset.canvasPanel as CanvasPanelKind);
  }

  function handleTool(e: React.MouseEvent<HTMLButtonElement>) {
    onTool(e.currentTarget.dataset.canvasTool as CanvasTool);
  }

  const tools = TOOLS.map(({
    tool, icon, label, title: hint,
  }) => (
    <button
      key={tool}
      type="button"
      className={styles.tool}
      title={lang(tool === 'group' && hasSelection ? 'KnowledgeCanvasWrap' : hint)}
      aria-label={lang(label)}
      data-canvas-tool={tool}
      onClick={handleTool}
    >
      <PvIcon name={icon} isSmall />
      <span className={styles.toolLabel}>{lang(label)}</span>
    </button>
  ));

  const modes = (
    <>
      <button
        type="button"
        className={buildClassName(styles.tool, isConnecting && styles.toolOn)}
        title={lang('KnowledgeCanvasLink')}
        aria-label={lang('KnowledgeCanvasLink')}
        aria-pressed={isConnecting}
        disabled={!canConnect}
        data-canvas-tool="connect"
        onClick={onConnect}
      >
        <PvIcon name="link" isSmall />
        {isNarrow && <span className={styles.toolLabel}>{lang('KnowledgeCanvasLink')}</span>}
      </button>
      <button
        type="button"
        className={buildClassName(styles.tool, isSelectMode && styles.toolOn)}
        title={lang('KnowledgeCanvasSelectMode')}
        aria-label={lang('KnowledgeCanvasSelectMode')}
        aria-pressed={isSelectMode}
        data-canvas-select-mode
        onClick={onSelectMode}
      >
        <PvIcon name="select" isSmall />
        {isNarrow && <span className={styles.toolLabel}>{lang('KnowledgeCanvasSelectShort')}</span>}
      </button>
    </>
  );

  return (
    <>
      <div className={styles.head} data-board-tools data-canvas-head>
        <button
          type="button"
          className={kit.ib}
          aria-label={lang('KnowledgeCanvasBack')}
          title={lang('KnowledgeCanvasBack')}
          data-canvas-back
          onClick={onBack}
        >
          <PvIcon name="left" />
        </button>
        <div className={styles.headTitleBox}>
          <h2 className={styles.headTitle} aria-pressed data-canvas-chip={title}>{title}</h2>
          {subtitle && !isNarrow && <span className={styles.headSub} data-canvas-head-sub>{subtitle}</span>}
        </div>
        {!isNarrow && (
          <div className={styles.headTools}>
            {tools}
            {modes}
          </div>
        )}
        <div className={styles.headEnd}>
          {/* Пока что-то выделено (компьютер): «Карточка · Стрелка» переключают панель, «Готово» снимает выделение */}
          {!isNarrow && panelKind && (
            <div className={kit.seg} role="radiogroup" data-canvas-panel-switch>
              {(['card', 'edge'] as const).map((kind) => (
                <button
                  key={kind}
                  type="button"
                  role="radio"
                  aria-checked={panelKind === kind}
                  className={buildClassName(kit.segItem, panelKind === kind && kit.segItemOn)}
                  data-canvas-panel={kind}
                  onClick={handlePanel}
                >
                  {lang(kind === 'card' ? 'KnowledgeCanvasPanelCard' : 'KnowledgeCanvasPanelArrow')}
                </button>
              ))}
            </div>
          )}
          {!isNarrow && hasAnySelection && (
            <button type="button" className={buildClassName(kit.chip, kit.chipOn)} data-canvas-done onClick={onDone}>
              {lang('Done')}
            </button>
          )}
          <button
            type="button"
            className={buildClassName(isNarrow ? kit.ib : kit.chip)}
            title={lang('KnowledgeCanvasUndo')}
            aria-label={lang('KnowledgeCanvasUndo')}
            disabled={!canUndo}
            data-canvas-undo
            onClick={onUndo}
          >
            {isNarrow ? <PvIcon name="undo" /> : lang('KnowledgeCanvasUndo')}
          </button>
          <button
            type="button"
            className={buildClassName(isNarrow ? kit.ib : kit.chip)}
            title={lang('KnowledgeCanvasRedo')}
            aria-label={lang('KnowledgeCanvasRedo')}
            disabled={!canRedo}
            data-canvas-redo
            onClick={onRedo}
          >
            {isNarrow ? <PvIcon name="redo" /> : lang('KnowledgeCanvasRedo')}
          </button>
          {isFromGraph && !isNarrow && (
            <button
              type="button"
              className={kit.chip}
              title={lang('KnowledgeCanvasRefreshTitle')}
              data-canvas-refresh
              onClick={onRefresh}
            >
              {lang('KnowledgeCanvasRefresh')}
            </button>
          )}
          <button
            type="button"
            className={kit.ib}
            title={lang('KnowledgeCanvasActions')}
            aria-label={lang('KnowledgeCanvasActions')}
            data-canvas-menu
            onClick={onMenu}
          >
            <PvIcon name="dots" />
          </button>
        </div>
      </div>
      {isNarrow && (
        <div className={styles.bottomTools} data-board-tools data-canvas-bottom-tools>
          {tools}
          {modes}
        </div>
      )}
    </>
  );
};

export default memo(CanvasHead);
