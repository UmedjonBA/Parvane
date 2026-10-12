import { memo } from '../../../lib/teact/teact';

import type { PlannerSettings as Settings, PlannerSettingsError, PlannerState } from './plannerModel';

import buildClassName from '../../../util/buildClassName';
import {
  createEmptyPlannerState, DEFAULT_PLANNER_SETTINGS, MIN_BUDGET_MINUTES, MINUTES_IN_DAY,
  toMinutes, toTime, validateBudget, validateSettings,
} from './plannerModel';
import { showPlannerNotice, updatePlanner } from './plannerStore';

import useLang from '../../../hooks/useLang';
import useLastCallback from '../../../hooks/useLastCallback';

import PlannerField from './PlannerField';

import styles from './Planner.module.scss';

type OwnProps = {
  state: PlannerState;
};

const ERROR_KEYS = {
  window: 'PlannerErrorSettingsWindow',
  lunch: 'PlannerErrorSettingsLunch',
  margin: 'PlannerErrorSettingsMargin',
} as const satisfies Record<PlannerSettingsError, string>;
const BUDGET_STEP = 30;

// Parvane (spec 009, T014): настройки дня — бюджет и окна дня.
// Каждое поле сохраняется само по завершении ввода; негодное значение не
// применяется и объясняется уведомлением
const PlannerSettings = ({ state }: OwnProps) => {
  const lang = useLang();

  const { settings, budget } = state;

  const applySettings = useLastCallback((changes: Partial<Settings>) => {
    const next = { ...settings, ...changes };
    const error = validateSettings(next);
    if (error) {
      showPlannerNotice(lang(ERROR_KEYS[error]));
      return false;
    }
    updatePlanner((draft) => {
      draft.settings = next;
    }, lang('PlannerNoticeSettingsSaved'));
    return true;
  });

  const handleBudget = useLastCallback((value: string) => {
    const next = Number(value);
    if (!value || !validateBudget(next)) {
      showPlannerNotice(lang('PlannerErrorSettingsBudget'));
      return false;
    }
    updatePlanner((draft) => {
      draft.budget = next;
    }, lang('PlannerNoticeSettingsSaved'));
    return true;
  });

  const handleDayStart = useLastCallback((value: string) => (
    value ? applySettings({ dayStart: toMinutes(value) }) : false
  ));

  const handleDayEnd = useLastCallback((value: string) => (
    value ? applySettings({ dayEnd: toMinutes(value) }) : false
  ));

  const handleReset = useLastCallback(() => {
    updatePlanner((draft) => {
      draft.settings = { ...DEFAULT_PLANNER_SETTINGS };
      draft.budget = createEmptyPlannerState().budget;
    }, lang('PlannerNoticeSettingsSaved'));
  });

  return (
    <div className={styles.editor}>
      <h3 className={buildClassName(styles.groupTitle, styles.groupTitleFirst)}>{lang('ParvaneSectionPlanner')}</h3>
      <div className={styles.fields}>
        <PlannerField
          label={lang('PlannerSettingsDayStart')}
          type="time"
          value={toTime(settings.dayStart)}
          onCommit={handleDayStart}
        />
        <PlannerField
          label={lang('PlannerSettingsDayEnd')}
          type="time"
          value={toTime(settings.dayEnd)}
          onCommit={handleDayEnd}
        />
        <PlannerField
          label={lang('PlannerSettingsBudget')}
          type="number"
          value={String(budget)}
          min={MIN_BUDGET_MINUTES}
          max={MINUTES_IN_DAY}
          step={BUDGET_STEP}
          onCommit={handleBudget}
        />
      </div>
      <p className={styles.sheetHint}>{lang('PlannerSettingsHint')}</p>
      <p className={styles.sheetHint}>{lang('PlannerSettingsGoalsHint')}</p>
      <button type="button" className={buildClassName(styles.btn, styles.btnDanger)} onClick={handleReset}>
        {lang('PlannerSettingsReset')}
      </button>
    </div>
  );
};

export default memo(PlannerSettings);
