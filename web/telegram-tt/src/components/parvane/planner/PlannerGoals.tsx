import { memo, useState } from '../../../lib/teact/teact';

import type {
  PlannerGoalMetric, PlannerGoalRecord, PlannerGoalValues, PlannerState,
} from './plannerModel';

import buildClassName from '../../../util/buildClassName';
import { formatDay, formatNumber } from './plannerFormat';
import {
  freezePastGoals, getGoalRecordForDay, newId, PLANNER_GOAL_METRICS, validateGoalRecord,
} from './plannerModel';
import { updatePlanner } from './plannerStore';

import useLang from '../../../hooks/useLang';
import useLastCallback from '../../../hooks/useLastCallback';

import Button from '../../ui/Button';
import Select from '../../ui/Select';
import PlannerField from './PlannerField';
import { formatMetric, formatMetricUnit } from './PlannerNutrition';

import styles from './Planner.module.scss';

type OwnProps = {
  state: PlannerState;
  // День, для которого выделяется действующая запись
  picked: string;
};

type EndKind = 'open' | 'single' | 'until';
type Drafts = Record<string, string>;

// Запись «с самого начала» (цели этапов 1–2) правится как запись с пустой датой начала
const BASE_ID = '';

// Список записей целей по датам (spec 011, US2): бессрочно с даты, один день или промежуток
const PlannerGoals = ({ state, picked }: OwnProps) => {
  const lang = useLang();

  const [editedId, setEditedId] = useState<string>();
  const [startDay, setStartDay] = useState('');
  const [endKind, setEndKind] = useState<EndKind>('open');
  const [endDay, setEndDay] = useState('');
  const [drafts, setDrafts] = useState<Drafts>({});
  const [error, setError] = useState<string>();

  const active = getGoalRecordForDay(state, picked);
  const records: PlannerGoalRecord[] = [
    { id: BASE_ID, startDay: '', endDay: '', goals: state.goals },
    ...[...state.goalPeriods].sort((a, b) => b.startDay.localeCompare(a.startDay) || a.endDay.localeCompare(b.endDay)),
  ];

  const openForm = useLastCallback((record?: PlannerGoalRecord) => {
    const next: Drafts = {};
    PLANNER_GOAL_METRICS.forEach((metric) => {
      const goal = record?.goals[metric];
      next[`${metric}.target`] = goal ? String(goal.target) : '';
      next[`${metric}.tolerance`] = goal ? String(goal.tolerance) : '';
    });
    setDrafts(next);
    setStartDay(record ? record.startDay : picked);
    setEndKind(!record || !record.endDay ? 'open' : record.endDay === record.startDay ? 'single' : 'until');
    setEndDay(record?.endDay || '');
    setError(undefined);
    setEditedId(record ? record.id : 'new');
  });

  const closeForm = useLastCallback(() => {
    setEditedId(undefined);
  });

  const handleAdd = useLastCallback(() => openForm());

  const handleRecordClick = useLastCallback((e: React.MouseEvent<HTMLButtonElement>) => {
    const { recordId } = e.currentTarget.dataset;
    openForm(records.find((record) => record.id === recordId));
  });

  const handleEndKind = useLastCallback((e: React.ChangeEvent<HTMLSelectElement>) => {
    setEndKind(e.currentTarget.value as EndKind);
  });

  const setDraft = useLastCallback((key: string, value: string) => {
    setDrafts((previous) => ({ ...previous, [key]: value }));
  });

  const handleSubmit = useLastCallback((e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const goals: PlannerGoalValues = {};
    for (const metric of PLANNER_GOAL_METRICS) {
      const target = drafts[`${metric}.target`];
      const tolerance = drafts[`${metric}.tolerance`];
      if (target === '' && tolerance === '') continue;
      goals[metric] = { target: Number(target), tolerance: tolerance === '' ? 0 : Number(tolerance) };
    }
    const isBase = editedId === BASE_ID;
    const record = {
      startDay: isBase ? '' : startDay,
      endDay: isBase ? '' : endKind === 'open' ? '' : endKind === 'single' ? startDay : endDay,
      goals,
    };
    const problem = validateGoalRecord(record);
    if (problem) {
      setError(problem === 'startDay' || problem === 'endDay' ? lang('PlannerErrorGoalDates')
        : problem === 'empty' ? lang('PlannerErrorGoalEmpty')
          : lang('PlannerErrorGoal', { name: formatMetric(lang, problem) }));
      return;
    }
    setError(undefined);
    const id = editedId === 'new' ? newId() : editedId!;
    updatePlanner((draft) => {
      // Прошедшие дни оцениваются по целям, действовавшим до правки
      freezePastGoals(draft);
      if (isBase) {
        draft.goals = goals;
        return;
      }
      const index = draft.goalPeriods.findIndex((item) => item.id === id);
      const next = { id, ...record };
      if (index >= 0) draft.goalPeriods[index] = next;
      else draft.goalPeriods.push(next);
    }, lang('PlannerNoticeGoalsUpdated'));
    closeForm();
  });

  const handleDelete = useLastCallback(() => {
    const id = editedId!;
    updatePlanner((draft) => {
      freezePastGoals(draft);
      draft.goalPeriods = draft.goalPeriods.filter((item) => item.id !== id);
    }, lang('PlannerNoticeGoalDeleted'));
    closeForm();
  });

  return (
    <div className={styles.goals}>
      <h3 className={styles.group}>{lang('PlannerGoalsTitle')}</h3>
      {records.map((record) => (
        <button
          key={record.id || 'base'}
          type="button"
          className={buildClassName(styles.mealEntry, active?.id === record.id && styles.goalActive)}
          data-record-id={record.id}
          aria-current={active?.id === record.id ? 'true' : undefined}
          onClick={handleRecordClick}
        >
          <span className={styles.mealEntryTop}>
            <span className={styles.taskName}>{formatPeriod(record)}</span>
            {active?.id === record.id && <span className={styles.small}>{lang('PlannerGoalActive')}</span>}
          </span>
          <span className={styles.small}>{formatGoals(record.goals)}</span>
        </button>
      ))}
      {editedId === undefined ? (
        <Button isText size="smaller" className={styles.inlineAdd} onClick={handleAdd}>
          {lang('PlannerGoalAdd')}
        </Button>
      ) : (
        <form className={styles.form} onSubmit={handleSubmit}>
          <h3 className={styles.group}>
            {lang(editedId === 'new' ? 'PlannerGoalNewTitle' : 'PlannerGoalEditTitle')}
          </h3>
          {editedId === BASE_ID ? (
            <p className={styles.small}>{lang('PlannerGoalBaseHint')}</p>
          ) : (
            <div className={styles.fields}>
              <PlannerField label={lang('PlannerGoalFrom')} type="date" value={startDay} onInput={setStartDay} />
              <Select
                id="planner-goal-end"
                label={lang('PlannerGoalEndKind')}
                value={endKind}
                hasArrow
                onChange={handleEndKind}
              >
                <option value="open">{lang('PlannerGoalEndOpen')}</option>
                <option value="single">{lang('PlannerGoalEndSingle')}</option>
                <option value="until">{lang('PlannerGoalEndUntil')}</option>
              </Select>
              {endKind === 'until' && (
                <PlannerField label={lang('PlannerGoalTo')} type="date" value={endDay} onInput={setEndDay} />
              )}
            </div>
          )}
          <p className={styles.small}>{lang('PlannerGoalMetricsHint')}</p>
          <div className={styles.fields}>
            {PLANNER_GOAL_METRICS.map((metric) => (
              <div key={metric} className={styles.goalPair}>
                {renderField(metric, 'target', lang('PlannerGoalTarget', {
                  name: formatMetric(lang, metric), unit: formatMetricUnit(lang, metric),
                }))}
                {renderField(metric, 'tolerance', lang('PlannerGoalTolerance'))}
              </div>
            ))}
          </div>
          {error && <p className={styles.error} role="alert">{error}</p>}
          <div className={styles.actions}>
            <Button type="submit" size="smaller">{lang('Save')}</Button>
            <Button isText size="smaller" onClick={closeForm}>{lang('Cancel')}</Button>
            {editedId !== 'new' && editedId !== BASE_ID && (
              <Button isText size="smaller" color="danger" onClick={handleDelete}>{lang('Delete')}</Button>
            )}
          </div>
        </form>
      )}
    </div>
  );

  function renderField(metric: PlannerGoalMetric, part: 'target' | 'tolerance', label: string) {
    const key = `${metric}.${part}`;
    return (
      <PlannerField
        label={label}
        type="number"
        value={drafts[key] || ''}
        min={0}
        step={metric === 'kcal' || metric === 'water' ? 1 : 'any'}
        placeholder={part === 'target' ? lang('PlannerGoalNoGoal') : undefined}
        onInput={(value) => setDraft(key, value)}
      />
    );
  }

  function formatPeriod(record: PlannerGoalRecord) {
    if (!record.startDay) return lang('PlannerGoalFromStart');
    if (!record.endDay) return lang('PlannerGoalPeriodOpen', { from: formatDay(lang, record.startDay) });
    const from = formatDay(lang, record.startDay);
    if (record.endDay === record.startDay) return lang('PlannerGoalPeriodSingle', { date: from });
    return lang('PlannerGoalPeriodRange', { from, to: formatDay(lang, record.endDay) });
  }

  function formatGoals(goals: PlannerGoalValues) {
    const parts = PLANNER_GOAL_METRICS
      .filter((metric) => goals[metric])
      .map((metric) => `${formatMetric(lang, metric)} ${formatNumber(lang, goals[metric]!.target)} ± ${
        formatNumber(lang, goals[metric]!.tolerance)}`);
    return parts.length ? parts.join(' · ') : lang('PlannerGoalNoGoal');
  }
};

export default memo(PlannerGoals);
