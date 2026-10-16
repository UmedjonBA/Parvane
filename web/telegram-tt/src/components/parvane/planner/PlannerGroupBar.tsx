import { memo, useState } from '../../../lib/teact/teact';

import type { GroupError } from './plannerGroups';
import type { PlannerState } from './plannerModel';

import buildClassName from '../../../util/buildClassName';
import { formatHours, listColorStyle } from './plannerFormat';
import {
  createGroup, deleteGroup, normalizeGroupName, renameGroup, setGroupColor,
} from './plannerGroups';
import { showPlannerNotice, updatePlanner } from './plannerStore';

import useFlag from '../../../hooks/useFlag';
import useLang from '../../../hooks/useLang';
import useLastCallback from '../../../hooks/useLastCallback';

import Icon from '../../common/icons/Icon';
import ConfirmDialog from '../../ui/ConfirmDialog';
import PlannerField from './PlannerField';
import { PlannerColorSwatches } from './PlannerListPicker';

import styles from './Planner.module.scss';

// Сколько записей и времени у группы в показанных днях ('' — без группы)
export type GroupStats = Record<string, { count: number; minutes: number }>;

type OwnProps = {
  state: PlannerState;
  stats: GroupStats;
  isPicking: boolean;
  onStartPick: NoneToVoidFunction;
};

const ERROR_KEYS = {
  name: 'PlannerErrorListName',
  duplicate: 'PlannerErrorGroupDuplicate',
} as const satisfies Record<GroupError, string>;

// Редактор группы: новой (`name` пусто) либо существующей
type Editing = { from?: string; name: string; color: number };

// Панель групп вида «Список»: группы цветом с числом записей и часов за показанные дни, правка группы на месте,
// «+ Группа», «Добавить в группу»
const PlannerGroupBar = ({
  state, stats, isPicking, onStartPick,
}: OwnProps) => {
  const lang = useLang();

  const [editing, setEditing] = useState<Editing>();
  const [isDeleteOpen, openDelete, closeDelete] = useFlag();

  const handleOpenGroup = useLastCallback((e: React.MouseEvent<HTMLButtonElement>) => {
    const name = e.currentTarget.dataset.group!;
    const list = state.lists.find((item) => item.name === name);
    setEditing(editing?.from === name ? undefined : { from: name, name, color: list?.color || 0 });
  });

  const handleNew = useLastCallback(() => {
    setEditing(editing && !editing.from ? undefined : { name: '', color: 0 });
  });

  const handleName = useLastCallback((name: string) => {
    setEditing((current) => current && { ...current, name });
  });

  const handleColor = useLastCallback((color: number) => {
    setEditing((current) => current && { ...current, color });
  });

  const handleSave = useLastCallback(() => {
    if (!editing) return;
    const { from, name, color } = editing;
    // Проверка на копии: `updatePlanner` применяет изменение безусловно
    const check = structuredClone(state);
    const error = from ? renameGroup(check, from, name) : createGroup(check, name, color);
    if (error) {
      showPlannerNotice(lang(ERROR_KEYS[error]));
      return;
    }
    updatePlanner((draft) => {
      if (!from) {
        createGroup(draft, name, color);
        return;
      }
      renameGroup(draft, from, name);
      setGroupColor(draft, normalizeGroupName(name), color);
    }, from ? lang('PlannerNoticeGroupSaved') : lang('PlannerNoticeListCreated', { name: normalizeGroupName(name) }));
    setEditing(undefined);
  });

  const handleDelete = useLastCallback(() => {
    closeDelete();
    const name = editing?.from;
    if (!name) return;
    updatePlanner((draft) => {
      deleteGroup(draft, name);
    }, lang('PlannerNoticeGroupDeleted'));
    setEditing(undefined);
  });

  const handleCancel = useLastCallback(() => {
    setEditing(undefined);
  });

  const renderStats = (name: string) => {
    const item = stats[name];
    return (
      <span className={styles.groupStats}>
        {item ? `${item.count} · ${formatHours(lang, item.minutes)}` : '—'}
      </span>
    );
  };

  return (
    <div className={styles.groupBar} data-group-bar>
      <div className={styles.groupHead}>
        <div className={styles.groupHeadText}>
          <h3 className={styles.groupPanelTitle}>{lang('PlannerGroups')}</h3>
          <span className={styles.groupPeriod}>{lang('PlannerGroupsPeriod')}</span>
        </div>
        {!isPicking && (
          <button
            type="button"
            className={buildClassName(styles.btn, styles.btnAccent, styles.groupPickButton)}
            data-group-pick
            onClick={onStartPick}
          >
            {lang('PlannerGroupPick')}
          </button>
        )}
      </div>
      <div className={styles.groupChips}>
        {state.lists.map((list) => (
          <button
            key={list.id}
            type="button"
            className={buildClassName(styles.groupChip, editing?.from === list.name && styles.groupChipActive)}
            style={listColorStyle(list.color || 0)}
            data-group={list.name}
            onClick={handleOpenGroup}
          >
            <span className={styles.groupDot} />
            <span className={styles.groupName}>{list.name}</span>
            {renderStats(list.name)}
          </button>
        ))}
        {Boolean(stats['']) && (
          <div className={buildClassName(styles.groupChip, styles.groupChipStatic)} data-group-none>
            <span className={styles.groupDot} />
            <span className={styles.groupName}>{lang('PlannerNoList')}</span>
            {renderStats('')}
          </div>
        )}
        <button
          type="button"
          className={buildClassName(styles.groupChip, styles.groupChipAdd)}
          data-group-new
          onClick={handleNew}
        >
          <Icon name="add" />
          {lang('PlannerGroupAdd')}
        </button>
      </div>
      {editing && (
        <div className={styles.groupEditor} data-group-editor>
          <PlannerField
            label={editing.from ? lang('PlannerGroupName') : lang('PlannerNewList')}
            type="text"
            value={editing.name}
            maxLength={60}
            onInput={handleName}
          />
          <PlannerColorSwatches value={editing.color} onChange={handleColor} />
          <div className={styles.actions}>
            <button type="button" className={buildClassName(styles.btn, styles.btnAccent)} onClick={handleSave}>
              {editing.from ? lang('Save') : lang('PlannerCreateList')}
            </button>
            <button type="button" className={buildClassName(styles.btn, styles.btnGhost)} onClick={handleCancel}>
              {lang('Cancel')}
            </button>
            {editing.from && (
              <button type="button" className={buildClassName(styles.btn, styles.btnDanger)} onClick={openDelete}>
                {lang('PlannerGroupDelete')}
              </button>
            )}
          </div>
        </div>
      )}
      <ConfirmDialog
        isOpen={isDeleteOpen}
        onClose={closeDelete}
        text={lang('PlannerGroupDeleteConfirm', { name: editing?.from || '' })}
        confirmLabel={lang('PlannerGroupDelete')}
        confirmHandler={handleDelete}
        confirmIsDestructive
      />
    </div>
  );
};

export default memo(PlannerGroupBar);
