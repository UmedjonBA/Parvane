import { memo, useEffect, useRef } from '../../../lib/teact/teact';

import type { NotesGraphFolder, NotesGraphScope as Scope, NotesGraphTag } from './notesGraphEngine';
import type { GraphFilter } from './notesGraphView';

import buildClassName from '../../../util/buildClassName';
import { folderCaption, ROOT_FOLDER } from './notesFolders';
import { folderColor } from './notesLook';

import useLang from '../../../hooks/useLang';
import useLastCallback from '../../../hooks/useLastCallback';

import PvIcon from './PvIcon';

import styles from './NotesGraph.module.scss';
import kit from './PvKit.module.scss';

type OwnProps = {
  filter: GraphFilter;
  // Папки с заметками и метки — списки движка (`layout.folders`, `layout.tags`)
  folders: NotesGraphFolder[];
  tags: NotesGraphTag[];
  // Заметка, выбранная на графе: вокруг неё можно собрать область
  pickedNote?: { id: string; title: string };
  // Название заметки, вокруг которой область собрана сейчас
  aroundTitle?: string;
  onClose: NoneToVoidFunction;
  onChange: (filter: GraphFilter) => void;
};

type ChipProps = {
  filter: GraphFilter;
  aroundTitle?: string;
  isOpen: boolean;
  onToggle: NoneToVoidFunction;
};

const DEPTHS = [1, 2, 3] as const;
const PATH_SEPARATOR = '/';
const INDENT_REM = 0.875;

// Чип области графа в строке инструментов. В макете — «Все папки»; остальные области — сверх макета
export const NotesGraphScopeChip = memo(({
  filter, aroundTitle, isOpen, onToggle,
}: ChipProps) => {
  const lang = useLang();
  const { scope } = filter;
  const isNarrowed = scope.kind !== 'all' || filter.hideOrphans || filter.hideMissing;
  const label = scope.kind === 'folder' ? captionOf(lang('KnowledgeRoot'), scope.folder)
    : scope.kind === 'tag' ? `#${scope.tag}`
      : scope.kind === 'around' ? lang('KnowledgeGraphScopeAroundShort', { name: aroundTitle || '' })
        : lang('KnowledgeGraphFoldersAll');

  return (
    <button
      type="button"
      className={buildClassName(kit.chip, styles.chip, isNarrowed && kit.chipOn)}
      aria-haspopup="menu"
      aria-expanded={isOpen}
      title={lang('KnowledgeGraphScope')}
      data-graph-scope={scope.kind}
      onClick={onToggle}
    >
      <span className={styles.scopeLabel}>{label}</span>
      <PvIcon name={isOpen ? 'up' : 'down'} isSmall />
    </button>
  );
});

// Список областей графа: все заметки, заметка с соседями (глубина 1–3), папка с подпапками, метка; скрытие
// одиночных и заметок, которых ещё нет
const NotesGraphScope = ({
  filter, folders, tags, pickedNote, aroundTitle, onClose, onChange,
}: OwnProps) => {
  const menuRef = useRef<HTMLDivElement>();

  const lang = useLang();
  const { scope } = filter;

  // Нажатие мимо списка закрывает его (нажатие на чип — его собственное дело)
  useEffect(() => {
    const handleOutside = (e: PointerEvent) => {
      const target = e.target as Element;
      if (menuRef.current?.contains(target) || target.closest?.('[data-graph-scope]')) return;
      onClose();
    };
    document.addEventListener('pointerdown', handleOutside, true);
    return () => document.removeEventListener('pointerdown', handleOutside, true);
  }, [onClose]);

  const pickScope = (next: Scope, shouldClose: boolean) => {
    onChange({ ...filter, scope: next });
    if (shouldClose) onClose();
  };

  const handleAll = useLastCallback(() => pickScope({ kind: 'all' }, true));

  const handleFolder = useLastCallback((e: React.MouseEvent<HTMLButtonElement>) => {
    pickScope({ kind: 'folder', folder: e.currentTarget.dataset.graphScopeFolder! }, true);
  });

  const handleTag = useLastCallback((e: React.MouseEvent<HTMLButtonElement>) => {
    pickScope({ kind: 'tag', tag: e.currentTarget.dataset.graphScopeTag! }, true);
  });

  // Заметка для области «вокруг»: выбранная на графе, иначе та, вокруг которой область уже собрана
  const around = pickedNote || (scope.kind === 'around' ? { id: scope.note, title: aroundTitle || '' } : undefined);
  const isAround = scope.kind === 'around' && scope.note === around?.id;
  const aroundDepth = scope.kind === 'around' ? scope.depth : 1;

  const handleAround = useLastCallback(() => {
    pickScope({ kind: 'around', note: around!.id, depth: aroundDepth }, false);
  });

  const handleDepth = useLastCallback((e: React.MouseEvent<HTMLButtonElement>) => {
    const depth = Number(e.currentTarget.dataset.graphScopeDepth) as 1 | 2 | 3;
    pickScope({ kind: 'around', note: around!.id, depth }, false);
  });

  const handleOrphans = useLastCallback(() => {
    onChange({ ...filter, hideOrphans: !filter.hideOrphans });
  });

  const handleMissing = useLastCallback(() => {
    onChange({ ...filter, hideMissing: !filter.hideMissing });
  });

  const root = lang('KnowledgeRoot');

  function renderCheck(isOn: boolean) {
    return <PvIcon name="check" isSmall className={buildClassName(!isOn && styles.scopeOff)} />;
  }

  return (
    <div
      ref={menuRef}
      className={buildClassName(styles.scopeMenu, 'custom-scroll')}
      role="menu"
      aria-label={lang('KnowledgeGraphScope')}
      data-graph-scope-menu
    >
      <button
        type="button"
        className={styles.scopeItem}
        role="menuitemradio"
        aria-checked={scope.kind === 'all'}
        data-graph-scope-all
        onClick={handleAll}
      >
        {renderCheck(scope.kind === 'all')}
        <span className={styles.scopeName}>{lang('KnowledgeGraphScopeAll')}</span>
      </button>
      {around && (
        <div className={styles.scopeAround}>
          <button
            type="button"
            className={buildClassName(styles.scopeItem, styles.scopeGrow)}
            role="menuitemradio"
            aria-checked={isAround}
            data-graph-scope-around
            onClick={handleAround}
          >
            {renderCheck(isAround)}
            <span className={styles.scopeName}>{lang('KnowledgeGraphScopeAround', { name: around.title })}</span>
          </button>
          <span className={styles.scopeDepths} role="group" aria-label={lang('KnowledgeGraphScopeDepth')}>
            {DEPTHS.map((depth) => (
              <button
                key={depth}
                type="button"
                className={buildClassName(
                  styles.scopeDepth, isAround && aroundDepth === depth && styles.scopeDepthOn,
                )}
                aria-pressed={isAround && aroundDepth === depth}
                title={lang('KnowledgeGraphScopeDepth')}
                data-graph-scope-depth={depth}
                onClick={handleDepth}
              >
                {depth}
              </button>
            ))}
          </span>
        </div>
      )}
      {folders.length > 0 && (
        <div className={buildClassName(kit.caps, styles.scopeCaption)}>{lang('KnowledgeGraphScopeFolders')}</div>
      )}
      {folders.map(({ path, count }) => {
        const isOn = scope.kind === 'folder' && scope.folder === path;
        const depth = path === ROOT_FOLDER ? 0 : path.split(PATH_SEPARATOR).length - 1;
        return (
          <button
            key={path}
            type="button"
            className={styles.scopeItem}
            role="menuitemradio"
            aria-checked={isOn}
            data-graph-scope-folder={path}
            onClick={handleFolder}
          >
            {renderCheck(isOn)}
            <span
              className={styles.scopeName}
              style={`--c: ${folderColor(path)}; padding-inline-start: ${depth * INDENT_REM}rem`}
            >
              {captionOf(root, path)}
            </span>
            <span className={styles.scopeCount}>{count}</span>
          </button>
        );
      })}
      {tags.length > 0 && (
        <div className={buildClassName(kit.caps, styles.scopeCaption)}>{lang('KnowledgeGraphScopeTags')}</div>
      )}
      {tags.map(({ tag, count }) => {
        const isOn = scope.kind === 'tag' && scope.tag.toLowerCase() === tag.toLowerCase();
        return (
          <button
            key={tag}
            type="button"
            className={styles.scopeItem}
            role="menuitemradio"
            aria-checked={isOn}
            data-graph-scope-tag={tag}
            onClick={handleTag}
          >
            {renderCheck(isOn)}
            <span className={styles.scopeName}>{`#${tag}`}</span>
            <span className={styles.scopeCount}>{count}</span>
          </button>
        );
      })}
      <div className={styles.scopeLine} />
      <button
        type="button"
        className={styles.scopeItem}
        role="menuitemcheckbox"
        aria-checked={filter.hideOrphans}
        data-graph-hide-orphans
        onClick={handleOrphans}
      >
        {renderCheck(filter.hideOrphans)}
        <span className={styles.scopeName}>{lang('KnowledgeGraphHideOrphans')}</span>
      </button>
      <button
        type="button"
        className={styles.scopeItem}
        role="menuitemcheckbox"
        aria-checked={filter.hideMissing}
        data-graph-hide-missing
        onClick={handleMissing}
      >
        {renderCheck(filter.hideMissing)}
        <span className={styles.scopeName}>{lang('KnowledgeGraphHideMissing')}</span>
      </button>
    </div>
  );
};

function captionOf(root: string, path: string) {
  return path === ROOT_FOLDER ? root : folderCaption(path);
}

export default memo(NotesGraphScope);
