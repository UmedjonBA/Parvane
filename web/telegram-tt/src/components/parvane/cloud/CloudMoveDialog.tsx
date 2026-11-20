import {
  memo, useEffect, useMemo, useRef, useState,
} from '../../../lib/teact/teact';

import type { CloudNode } from './cloudModel';
import type { CloudMoveRow, CloudMoveSource, CloudMoveSpot } from './cloudMove';

import buildClassName from '../../../util/buildClassName';
import { validateName } from './cloudModel';
import {
  buildMoveStep, buildMoveTree, canMoveToSpot, homeOf, moveCrumbs, moveRowKey,
} from './cloudMove';

import useLang from '../../../hooks/useLang';
import useLastCallback from '../../../hooks/useLastCallback';

import PvIcon from '../notes/PvIcon';
import PvSheet from '../notes/PvSheet';

import kit from '../notes/PvKit.module.scss';
import styles from './CloudSheets.module.scss';

export type CloudMovePlace = { id: string; name: string; isShared?: boolean; members?: number; nodes: CloudNode[] };

type OwnProps = {
  isOpen: boolean;
  // Телефон: папка за папкой (доска `XpFiles`); компьютер — дерево всех папок (`ZdFilesX`)
  isStepwise?: boolean;
  rootName: string;
  nodes: CloudNode[];
  movedIds: string[];
  startFolder?: string;
  // Несколько мест назначения (личный диск первым и совместные папки); `sourcePlace` — откуда переносят
  places?: CloudMovePlace[];
  sourcePlace?: string;
  confirmLabel?: string;
  title?: string;
  // «Новая папка» внутри окна: папка создаётся в выбранном месте и сразу выбирается; итог — её id
  onCreateFolder?: (place: string | undefined, parent: string | undefined, name: string) => Promise<string | undefined>;
  onSubmit: (target?: string, place?: string) => void;
  onClose: NoneToVoidFunction;
};

// Отступ строки дерева: поле строки и шаг на уровень вложенности
const TREE_PAD_REM = 1;
const TREE_STEP_REM = 1.25;
const FOCUS_DELAY_MS = 100;

// Выбор папки назначения переноса либо сохранения из чата. Компьютер — дерево всех папок с пометками «здесь сейчас»
// и «общая: увидят N участников»; телефон — шаги: путь сверху, папки уровня (нажатие выбирает, стрелка — внутрь),
// «Новая папка», кнопка «Переместить сюда · «папка»» внизу (без выбора — открытая папка)
const CloudMoveDialog = ({
  isOpen, isStepwise, rootName, nodes, movedIds, startFolder, places, sourcePlace, confirmLabel, title,
  onCreateFolder, onSubmit, onClose,
}: OwnProps) => {
  const lang = useLang();
  const [picked, setPicked] = useState<string>();
  // Открытая папка шага; не задана — место, с которого окно открылось (первый кадр открытия — уже с ним)
  const [chosenSpot, setChosenSpot] = useState<CloudMoveSpot>();
  const [newName, setNewName] = useState<string>();
  const [hasTriedName, setHasTriedName] = useState(false);
  const nameRef = useRef<HTMLInputElement>();

  const sources: CloudMoveSource[] = useMemo(() => (
    places && places.length > 1 ? places : [{ name: rootName, nodes }]
  ), [places, rootName, nodes]);
  const isMoving = movedIds.length > 0;
  const home = useMemo(() => homeOf(sources, movedIds, sourcePlace), [sources, movedIds, sourcePlace]);

  const start: CloudMoveSpot = useMemo(() => (isMoving ? home || { place: sources[0]?.id }
    : { place: sourcePlace ?? sources[0]?.id, folder: startFolder }), [
    isMoving, home, sources, sourcePlace, startFolder,
  ]);
  const spot = chosenSpot || start;

  useEffect(() => {
    setChosenSpot(undefined);
    if (!isOpen) return;
    setNewName(undefined);
    // Перенос: место выбирает человек. Сохранение: сразу стоит открытая папка (на телефоне — она же шаг)
    setPicked(isMoving || isStepwise ? undefined : moveRowKey(start.place, start.folder));
    // Окно открывается заново — состояние берётся с этого момента, дальнейшие правки дерева его не сбивают
    // eslint-disable-next-line react-hooks-static-deps/exhaustive-deps
  }, [isOpen]);

  const isNaming = newName !== undefined;
  useEffect(() => {
    if (!isNaming) return undefined;
    const timer = window.setTimeout(() => nameRef.current?.focus(), FOCUS_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [isNaming]);

  const rows = useMemo(() => (
    isStepwise ? buildMoveStep(sources, spot, movedIds, sourcePlace) : buildMoveTree(sources, movedIds, sourcePlace)
  ), [isStepwise, sources, spot, movedIds, sourcePlace]);
  const crumbs = useMemo(() => (isStepwise ? moveCrumbs(sources, spot) : []), [isStepwise, sources, spot]);

  const pickedRow = rows.find((row) => row.key === picked && !row.isDisabled);
  // Шаг без выбора — открытая папка шага
  const spotName = crumbs[crumbs.length - 1]?.name;
  const target: (CloudMoveSpot & { name: string }) | undefined = pickedRow
    || (isStepwise && spotName && canMoveToSpot(sources, spot, movedIds, sourcePlace)
      ? { ...spot, name: spotName } : undefined);
  const isSingle = sources.length === 1;

  const movedNames = movedIds.map((id) => sources.flatMap((s) => s.nodes).find((n) => n.id === id)?.name)
    .filter(Boolean);
  // «сейчас в «Мой диск / Сервер»»: путь от места, где лежит переносимое
  const homeCrumbs = home && !isStepwise ? moveCrumbs(sources, home) : undefined;
  const homeText = homeCrumbs && (home!.place === sources[0]?.id ? homeCrumbs : homeCrumbs.slice(1))
    .map((c) => c.name).join(' / ');
  const subtitle = isStepwise && movedNames.length
    ? movedNames.length > 1
      ? lang('ParvaneCloudMoveWhat', { name: movedNames[0], count: movedNames.length - 1 }, {
        pluralValue: movedNames.length - 1,
      })
      : movedNames[0]
    : homeText ? lang('ParvaneCloudMoveNow', { place: homeText }) : undefined;

  const handleSubmit = useLastCallback(() => {
    if (!target) return;
    onSubmit(target.folder, isSingle ? undefined : target.place);
  });

  const handlePick = useLastCallback((e: React.MouseEvent<HTMLButtonElement>) => {
    const { key } = e.currentTarget.dataset;
    setPicked(isStepwise && key === picked ? undefined : key);
  });

  const handleEnter = useLastCallback((e: React.MouseEvent<HTMLButtonElement>) => {
    const row = rows.find(({ key }) => key === e.currentTarget.dataset.key);
    if (!row) return;
    setChosenSpot({ place: row.place, folder: row.folder });
    setPicked(undefined);
  });

  const handleCrumb = useLastCallback((e: React.MouseEvent<HTMLButtonElement>) => {
    const crumb = crumbs.find(({ key }) => key === e.currentTarget.dataset.key);
    if (!crumb) return;
    setChosenSpot({ place: crumb.place, folder: crumb.folder });
    setPicked(undefined);
  });

  // Новая папка — в выбранной (дерево) либо в открытой (шаг); без выбора в дереве — в корне первого места
  const createSpot: CloudMoveSpot = isStepwise ? spot
    : pickedRow ? { place: pickedRow.place, folder: pickedRow.folder } : { place: sources[0]?.id };

  const handleNewFolder = useLastCallback(() => {
    setNewName('');
    setHasTriedName(false);
  });

  const handleNameChange = useLastCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    setNewName(e.target.value);
  });

  const handleNameCancel = useLastCallback(() => setNewName(undefined));

  const handleNameSubmit = useLastCallback(async (e?: React.FormEvent) => {
    e?.preventDefault();
    const value = (nameRef.current?.value ?? newName ?? '').trim();
    setHasTriedName(true);
    if (validateName(value) || !onCreateFolder) return;
    const at = createSpot;
    setNewName(undefined);
    const id = await onCreateFolder(isSingle ? undefined : at.place, at.folder, value);
    if (!id) return;
    // Папка появляется в списке, как только место перечитано: выбор ставится по её ключу
    setPicked(moveRowKey(at.place, id));
  });

  const nameProblem = isNaming && hasTriedName ? validateName(newName.trim()) : undefined;
  const actionLabel = confirmLabel || lang('ParvaneCloudMoveHere');

  function renderRowNote(row: CloudMoveRow) {
    if (row.isHere) return <span className={styles.treeHere}>{lang('KnowledgeFilesHere')}</span>;
    if (isStepwise && row.count !== undefined) {
      const items = lang('KnowledgeFilesItems', { count: row.count }, { pluralValue: row.count });
      return (
        <span className={styles.treeHere}>
          {row.isShared ? `${lang('ParvaneCloudMoveShared')} · ${items}` : items}
        </span>
      );
    }
    if (row.isShared && row.members) {
      return (
        <span className={styles.treeHere}>
          {lang('ParvaneCloudMoveSharedNote', { count: row.members }, { pluralValue: row.members })}
        </span>
      );
    }
    return undefined;
  }

  function renderNewFolder() {
    if (!onCreateFolder) return undefined;
    if (!isNaming) {
      return (
        <button
          type="button"
          className={buildClassName(isStepwise ? styles.moveNewRow : kit.btn, !isStepwise && styles.buttonsStart)}
          data-move-new-folder
          onClick={handleNewFolder}
        >
          {lang('ParvaneCloudNewFolder')}
        </button>
      );
    }
    return undefined;
  }

  function renderNameForm() {
    if (!isNaming) return undefined;
    return (
      <form className={styles.moveNameForm} onSubmit={handleNameSubmit} data-move-name-form>
        <input
          ref={nameRef}
          className={buildClassName(kit.input, styles.moveNameInput)}
          value={newName}
          placeholder={lang('ParvaneCloudFolderName')}
          aria-label={lang('ParvaneCloudFolderName')}
          aria-invalid={Boolean(nameProblem)}
          autoComplete="off"
          enterKeyHint="done"
          onChange={handleNameChange}
        />
        <button type="button" className={kit.btn} onClick={handleNameCancel}>{lang('Cancel')}</button>
        <button type="submit" className={buildClassName(kit.btn, kit.btnAcc)}>{lang('ParvaneCloudCreate')}</button>
        {nameProblem && (
          <div className={buildClassName(kit.fieldError, styles.moveNameError)} role="alert">
            {lang(nameProblem === 'empty' ? 'ParvaneCloudErrorNameEmpty'
              : nameProblem === 'too-long' ? 'ParvaneCloudErrorNameLong' : 'ParvaneCloudErrorNameChars')}
          </div>
        )}
      </form>
    );
  }

  function renderTreeRow(row: CloudMoveRow) {
    return (
      <button
        key={row.key}
        type="button"
        role="listitem"
        className={buildClassName(styles.treeRow, row.key === picked && styles.treeRowOn)}
        style={`padding-inline-start: ${TREE_PAD_REM + row.depth * TREE_STEP_REM}rem`}
        disabled={row.isDisabled}
        aria-current={row.key === picked ? 'true' : undefined}
        data-key={row.key}
        data-place-id={row.folder ? undefined : row.place}
        onClick={handlePick}
      >
        <PvIcon
          name="folder"
          isSmall
          className={buildClassName(styles.treeIcon, row.isShared && styles.treeIconShared)}
        />
        <span className={styles.treeName} dir="auto">{row.name}</span>
        {renderRowNote(row)}
      </button>
    );
  }

  function renderStepRow(row: CloudMoveRow) {
    return (
      <div key={row.key} role="listitem" className={styles.moveStepRow}>
        <button
          type="button"
          className={buildClassName(styles.treeRow, styles.moveStepPick, row.key === picked && styles.treeRowOn)}
          disabled={row.isDisabled}
          aria-current={row.key === picked ? 'true' : undefined}
          data-key={row.key}
          data-place-id={row.folder ? undefined : row.place}
          onClick={handlePick}
        >
          <PvIcon
            name="folder"
            isSmall
            className={buildClassName(styles.treeIcon, row.isShared && styles.treeIconShared)}
          />
          <span className={styles.moveStepText}>
            <span className={styles.treeName} dir="auto">{row.name}</span>
            {renderRowNote(row)}
          </span>
        </button>
        <button
          type="button"
          className={styles.moveStepOpen}
          aria-label={lang('ParvaneCloudMoveOpen', { name: row.name })}
          data-key={row.key}
          data-move-open={row.name}
          onClick={handleEnter}
        >
          <PvIcon name="right" isSmall />
        </button>
      </div>
    );
  }

  return (
    <PvSheet
      isOpen={isOpen}
      title={title || lang('ParvaneCloudMoveTitle')}
      className={buildClassName(styles.narrow, styles.full)}
      onClose={onClose}
    >
      {subtitle && <div className={styles.note} dir="auto" data-move-subtitle>{subtitle}</div>}
      {isStepwise && (
        <nav className={styles.pickPath} aria-label={lang('ParvaneCloudPath')} data-move-path>
          {crumbs.map((crumb, index) => (
            <span key={crumb.key}>
              {index > 0 && '/ '}
              <button
                type="button"
                className={buildClassName(styles.pickCrumb, index === crumbs.length - 1 && styles.pickCrumbLast)}
                data-key={crumb.key}
                onClick={handleCrumb}
              >
                {crumb.name}
              </button>
            </span>
          ))}
        </nav>
      )}
      <div className={buildClassName(styles.tree, 'custom-scroll')} role="list" data-move-list>
        {rows.map((row) => (isStepwise ? renderStepRow(row) : renderTreeRow(row)))}
        {isStepwise && !rows.length && <div className={styles.pickEmpty}>{lang('ParvaneCloudMoveNoFolders')}</div>}
        {isStepwise && renderNewFolder()}
      </div>
      {renderNameForm()}
      {!isStepwise && isMoving && <div className={styles.note}>{lang('ParvaneCloudMoveDragHint')}</div>}
      <div className={buildClassName(styles.buttons, styles.buttonsColumn)}>
        {!isStepwise && renderNewFolder()}
        {!isStepwise && <button type="button" className={kit.btn} onClick={onClose}>{lang('Cancel')}</button>}
        <button
          type="button"
          className={buildClassName(kit.btn, kit.btnAcc)}
          disabled={!target}
          aria-label={actionLabel}
          onClick={handleSubmit}
        >
          {target ? lang('ParvaneCloudMoveInto', { action: actionLabel, name: target.name }) : actionLabel}
        </button>
      </div>
    </PvSheet>
  );
};

export default memo(CloudMoveDialog);
