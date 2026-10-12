import {
  memo, useEffect, useMemo, useRef, useState,
} from '../../../lib/teact/teact';

import type { PvIconName } from '../notes/PvIcon';
import type { CloudNode } from './cloudModel';

import buildClassName from '../../../util/buildClassName';
import { canMoveInto, childrenOf, sortNodes, validateName } from './cloudModel';

import useLang from '../../../hooks/useLang';
import useLastCallback from '../../../hooks/useLastCallback';

import PvIcon from '../notes/PvIcon';
import PvSheet from '../notes/PvSheet';

import kit from '../notes/PvKit.module.scss';
import styles from './Cloud.module.scss';

type NameProps = {
  isOpen: boolean;
  title: string;
  label: string;
  confirmLabel: string;
  initialName?: string;
  onSubmit: (name: string) => void;
  onClose: NoneToVoidFunction;
};

const NAME_SORT = { key: 'name', isDescending: false } as const;
const NO_IDS: string[] = [];
const FOCUS_DELAY_MS = 150;
// Отступ строки дерева: поле строки и шаг на уровень вложенности
const TREE_PAD_REM = 0.625;
const TREE_STEP_REM = 1.125;

// Название новой папки либо новое имя файла/папки: проверка — как в движке
const CloudNameDialogBase = ({
  isOpen, title, label, confirmLabel, initialName, onSubmit, onClose,
}: NameProps) => {
  const lang = useLang();
  const [name, setName] = useState('');
  const [hasTried, setHasTried] = useState(false);
  const inputRef = useRef<HTMLInputElement>();

  useEffect(() => {
    if (!isOpen) return;
    setName(initialName || '');
    setHasTried(false);
  }, [isOpen, initialName]);

  // Поле получает фокус, когда шторка уже на экране
  useEffect(() => {
    if (!isOpen) return undefined;
    const timer = window.setTimeout(() => inputRef.current?.focus(), FOCUS_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [isOpen]);

  const problem = validateName(name.trim());
  const errorText = !hasTried || !problem ? undefined
    : problem === 'empty' ? lang('ParvaneCloudErrorNameEmpty')
      : problem === 'too-long' ? lang('ParvaneCloudErrorNameLong') : lang('ParvaneCloudErrorNameChars');

  const handleChange = useLastCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    setName(e.target.value);
  });

  const handleSubmit = useLastCallback((e?: React.FormEvent) => {
    e?.preventDefault();
    // Значение берём из самого поля: набранное сразу после открытия могло не успеть попасть в состояние
    const value = (inputRef.current?.value ?? name).trim();
    setName(value);
    setHasTried(true);
    if (validateName(value)) return;
    onSubmit(value);
  });

  return (
    <PvSheet isOpen={isOpen} title={title} onClose={onClose} onEnter={handleSubmit}>
      <form className={styles.nameForm} onSubmit={handleSubmit}>
        <input
          ref={inputRef}
          id="parvane-cloud-name"
          className={kit.input}
          value={name}
          placeholder={label}
          aria-label={label}
          aria-invalid={Boolean(errorText)}
          autoComplete="off"
          enterKeyHint="done"
          onChange={handleChange}
        />
        <button type="submit" className={buildClassName(kit.btn, kit.btnAcc)}>{confirmLabel}</button>
      </form>
      {errorText && <div className={kit.fieldError} role="alert">{errorText}</div>}
    </PvSheet>
  );
};

export type CloudMovePlace = { id: string; name: string; isShared?: boolean; nodes: CloudNode[] };

type MoveProps = {
  isOpen: boolean;
  rootName: string;
  nodes: CloudNode[];
  movedIds: string[];
  startFolder?: string;
  // Несколько мест назначения (личный диск и совместные папки); `sourcePlace` — откуда переносят
  places?: CloudMovePlace[];
  sourcePlace?: string;
  confirmLabel?: string;
  title?: string;
  onSubmit: (target?: string, place?: string) => void;
  onClose: NoneToVoidFunction;
};

type TreeRow = {
  key: string;
  place?: string;
  folder?: string;
  name: string;
  depth: number;
  icon: PvIconName;
  color: string;
  // Здесь переносимое лежит сейчас
  isCurrent: boolean;
  isDisabled: boolean;
};

function rowKey(place?: string, folder?: string) {
  return `${place || ''}/${folder || ''}`;
}

// Выбор папки назначения: дерево всех папок (личный диск и совместные папки с правом записи).
// Папка не может попасть в себя и во вложенную; место, где переносимое уже лежит, помечено
const CloudFolderDialogBase = ({
  isOpen, rootName, nodes: ownNodes, movedIds: ownMovedIds, startFolder, places, sourcePlace, confirmLabel, title,
  onSubmit, onClose,
}: MoveProps) => {
  const lang = useLang();
  const [picked, setPicked] = useState<string>();

  const hasPlaces = Boolean(places && places.length > 1);
  const isMoving = ownMovedIds.length > 0;

  useEffect(() => {
    if (!isOpen) return;
    // Перенос: место выбирает человек. Сохранение: сразу стоит открытая папка
    setPicked(isMoving ? undefined : rowKey(hasPlaces ? sourcePlace : undefined, startFolder));
  }, [isOpen, isMoving, hasPlaces, sourcePlace, startFolder]);

  const rows = useMemo(() => {
    const sources: { id?: string; name: string; isShared?: boolean; nodes: CloudNode[] }[] = hasPlaces
      ? places!.map((place) => ({ ...place }))
      : [{ name: rootName, nodes: ownNodes }];
    const result: TreeRow[] = [];
    sources.forEach((source) => {
      // В чужом для переносимого дереве запретных папок нет
      const movedIds = !hasPlaces || source.id === sourcePlace ? ownMovedIds : NO_IDS;
      const first = movedIds.length ? source.nodes.find(({ id }) => id === movedIds[0]) : undefined;
      const current = first ? first.parent || undefined : undefined;
      const isHome = Boolean(first);
      result.push({
        key: rowKey(source.id),
        place: source.id,
        name: source.name,
        depth: 0,
        icon: source.isShared ? 'users' : 'cloud',
        color: source.isShared ? 'var(--pv-purple)' : 'var(--pv-fg)',
        isCurrent: isHome && current === undefined,
        isDisabled: isHome && current === undefined,
      });
      const walk = (parent: string | undefined, depth: number) => {
        sortNodes(childrenOf(source.nodes, parent).filter((n) => n.kind === 'folder'), NAME_SORT).forEach((node) => {
          const isMoved = movedIds.includes(node.id);
          const isCurrent = isHome && node.id === current;
          result.push({
            key: rowKey(source.id, node.id),
            place: source.id,
            folder: node.id,
            name: node.name,
            depth,
            icon: 'folder',
            color: 'var(--pv-blue)',
            isCurrent,
            isDisabled: isMoved || isCurrent || !canMoveInto(source.nodes, movedIds, node.id),
          });
          // Содержимое переносимой папки целью быть не может — его и не показываем
          if (!isMoved) walk(node.id, depth + 1);
        });
      };
      walk(undefined, 1);
    });
    return result;
  }, [hasPlaces, places, rootName, ownNodes, ownMovedIds, sourcePlace]);

  const target = rows.find((row) => row.key === picked && !row.isDisabled);

  const handleSubmit = useLastCallback(() => {
    if (target) onSubmit(target.folder, hasPlaces ? target.place : undefined);
  });

  const handlePick = useLastCallback((e: React.MouseEvent<HTMLButtonElement>) => {
    setPicked(e.currentTarget.dataset.key);
  });

  return (
    <PvSheet isOpen={isOpen} title={title || lang('ParvaneCloudMoveTitle')} onClose={onClose}>
      <div className={buildClassName(styles.tree, 'custom-scroll')} role="list">
        {rows.map((row) => (
          <button
            key={row.key}
            type="button"
            role="listitem"
            className={buildClassName(kit.row, row.key === picked && kit.rowSel)}
            style={`padding-inline-start: ${TREE_PAD_REM + row.depth * TREE_STEP_REM}rem`}
            disabled={row.isDisabled}
            aria-current={row.key === picked ? 'true' : undefined}
            data-key={row.key}
            data-place-id={row.folder ? undefined : row.place}
            onClick={handlePick}
          >
            <span className={buildClassName(kit.ava, kit.avaS)} style={`--c: ${row.color}`}>
              <PvIcon name={row.icon} isSmall />
            </span>
            <span className={buildClassName(kit.rowText, kit.ttl)} dir="auto">{row.name}</span>
            {row.isCurrent && (
              <span className={buildClassName(kit.muted, kit.small)}>{lang('KnowledgeFilesHere')}</span>
            )}
            {row.key === picked && !row.isDisabled && <PvIcon name="check" isSmall className={styles.treeCheck} />}
          </button>
        ))}
      </div>
      <div className={kit.sheetButtons}>
        <button
          type="button"
          className={buildClassName(kit.btn, kit.btnAcc)}
          disabled={!target}
          onClick={handleSubmit}
        >
          {confirmLabel || lang('ParvaneCloudMoveHere')}
        </button>
        <button type="button" className={buildClassName(kit.btn, kit.btnGhost)} onClick={onClose}>
          {lang('Cancel')}
        </button>
      </div>
    </PvSheet>
  );
};

export const CloudNameDialog = memo(CloudNameDialogBase);
export const CloudFolderDialog = memo(CloudFolderDialogBase);
