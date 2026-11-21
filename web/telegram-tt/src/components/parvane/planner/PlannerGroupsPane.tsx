import { memo, useMemo, useState } from '../../../lib/teact/teact';

import type { GroupError } from './plannerGroups';
import type { PlannerState } from './plannerModel';

import buildClassName from '../../../util/buildClassName';
import { formatHoursNumber, listColorStyle } from './plannerFormat';
import {
  createGroup, deleteGroup, normalizeGroupName, renameGroup, setGroupColor,
} from './plannerGroups';
import { showPlannerNotice, updatePlanner } from './plannerStore';
import { getGroupStats } from './plannerTasksView';

import useFlag from '../../../hooks/useFlag';
import useLang from '../../../hooks/useLang';
import useLastCallback from '../../../hooks/useLastCallback';

import ConfirmDialog from '../../ui/ConfirmDialog';
import { PlannerColorSwatches } from './PlannerListPicker';

import kit from '../notes/PvKit.module.scss';
import styles from './PlannerMore.module.scss';

type OwnProps = {
  state: PlannerState;
  today: string;
  // Компьютер: форма новой группы видна всегда (доска `DkPlanMore`); телефон — по строке «Новая группа»
  isWide?: boolean;
};

const ERROR_KEYS = {
  name: 'PlannerErrorListName',
  duplicate: 'PlannerErrorGroupDuplicate',
} as const satisfies Record<GroupError, string>;
const GROUP_NAME_MAX_LENGTH = 60;

// Правка группы: новой (`from` нет) либо существующей
type Editing = { from?: string; name: string; color: number };

// Группы экрана «Задачи»: строка с цветом, числом записей и часов за 30 дней; правка и удаление на месте, новая
// группа — названием и цветом
const PlannerGroupsPane = ({ state, today, isWide }: OwnProps) => {
  const lang = useLang();
  const [editing, setEditing] = useState<Editing | undefined>(() => (isWide ? { name: '', color: 0 } : undefined));
  const [isDeleteOpen, openDelete, closeDelete] = useFlag();
  const stats = useMemo(() => getGroupStats(state, today), [state, today]);

  const handleOpen = useLastCallback((e: React.MouseEvent<HTMLButtonElement>) => {
    const name = e.currentTarget.dataset.group!;
    const list = state.lists.find((item) => item.name === name);
    setEditing(editing?.from === name ? undefined : { from: name, name, color: list?.color || 0 });
  });

  const handleNew = useLastCallback(() => {
    setEditing({ name: '', color: 0 });
  });

  const handleName = useLastCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const { value } = e.currentTarget;
    setEditing((current) => current && { ...current, name: value });
  });

  const handleColor = useLastCallback((color: number) => {
    setEditing((current) => current && { ...current, color });
  });

  const handleSave = useLastCallback((e: React.FormEvent) => {
    e.preventDefault();
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
    setEditing(isWide ? { name: '', color: 0 } : undefined);
  });

  const handleDelete = useLastCallback(() => {
    closeDelete();
    const name = editing?.from;
    if (!name) return;
    updatePlanner((draft) => {
      deleteGroup(draft, name);
    }, lang('PlannerNoticeGroupDeleted'));
    setEditing(isWide ? { name: '', color: 0 } : undefined);
  });

  function renderEditor() {
    return (
      <form className={styles.groupForm} data-group-editor onSubmit={handleSave}>
        <label className={styles.fieldLabel}>
          {editing!.from ? lang('PlannerGroupName') : lang('PlannerTasksGroupName')}
          <input
            className={kit.input}
            value={editing!.name}
            maxLength={GROUP_NAME_MAX_LENGTH}
            placeholder={lang('PlannerTasksNewGroup')}
            onChange={handleName}
          />
        </label>
        <PlannerColorSwatches value={editing!.color} onChange={handleColor} />
        <div className={styles.formButtons}>
          <button type="submit" className={buildClassName(kit.btn, kit.btnAcc)}>
            {editing!.from ? lang('Save') : lang('PlannerTasksCreate')}
          </button>
          {editing!.from && (
            <button type="button" className={buildClassName(kit.btn, kit.btnDanger)} onClick={openDelete}>
              {lang('PlannerGroupDelete')}
            </button>
          )}
        </div>
      </form>
    );
  }

  return (
    <div className={styles.groups} data-planner-groups>
      <h3 className={kit.grp}>{lang('PlannerGroups')}</h3>
      <div className={styles.list}>
        {state.lists.map((list) => {
          const item = stats[list.name];
          return (
            <div key={list.id}>
              <button
                type="button"
                className={buildClassName(kit.row, styles.groupRow)}
                style={listColorStyle(list.color || 0)}
                aria-expanded={editing?.from === list.name}
                data-group={list.name}
                onClick={handleOpen}
              >
                <span className={styles.groupDot} />
                <span className={buildClassName(kit.rowText, kit.ttl)}>{list.name}</span>
                <span className={buildClassName(kit.sub, kit.mono)}>
                  {item ? lang('PlannerTasksGroupStatsLine', {
                    count: item.count, hours: formatHoursNumber(lang, item.minutes),
                  }, { pluralValue: item.count }) : '—'}
                </span>
              </button>
              {editing?.from === list.name && renderEditor()}
            </div>
          );
        })}
        {!isWide && !editing && (
          <button type="button" className={buildClassName(kit.row, styles.groupNew)} data-group-new onClick={handleNew}>
            {lang('PlannerTasksNewGroup')}
          </button>
        )}
      </div>
      {editing && !editing.from && renderEditor()}
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

export default memo(PlannerGroupsPane);
