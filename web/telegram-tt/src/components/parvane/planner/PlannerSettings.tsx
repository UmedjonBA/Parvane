import { memo } from '../../../lib/teact/teact';

import type { PlannerSettings as Settings, PlannerSettingsError, PlannerState } from './plannerModel';

import buildClassName from '../../../util/buildClassName';
import {
  createEmptyPlannerState, DEFAULT_PLANNER_SETTINGS, MAX_SLOT_MARGIN, MIN_BUDGET_MINUTES, MINUTES_IN_DAY,
  toMinutes, toTime, validateBudget, validateSettings,
} from './plannerModel';
import { showPlannerNotice, updatePlanner } from './plannerStore';

import useLang from '../../../hooks/useLang';
import useLastCallback from '../../../hooks/useLastCallback';

import Button from '../../ui/Button';
import Select from '../../ui/Select';
import PlannerField from './PlannerField';

import styles from './Planner.module.scss';

type OwnProps = {
  state: PlannerState;
  // Узкий экран: выбор вида календаря живёт здесь, а не над календарём
  viewOptions?: { value: string; label: string }[];
  activeView?: string;
  onSwitchView?: (value: string) => void;
  onBack: NoneToVoidFunction;
};

const ERROR_KEYS = {
  window: 'PlannerErrorSettingsWindow',
  lunch: 'PlannerErrorSettingsLunch',
  margin: 'PlannerErrorSettingsMargin',
} as const satisfies Record<PlannerSettingsError, string>;
const BUDGET_STEP = 30;
const MARGIN_STEP = 5;

// Parvane (spec 009, T014): настройки дня — бюджет, окна дня, перерыв, запас.
// Каждое поле сохраняется само по завершении ввода; негодное значение не
// применяется и объясняется уведомлением
const PlannerSettings = ({
  state, viewOptions, activeView, onSwitchView, onBack,
}: OwnProps) => {
  const lang = useLang();

  const handleViewChange = useLastCallback((e: React.ChangeEvent<HTMLSelectElement>) => {
    onSwitchView?.(e.currentTarget.value);
  });

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

  // Пустое поле перерыва — перерыва нет
  const handleLunchStart = useLastCallback((value: string) => (
    applySettings(value ? { lunchStart: toMinutes(value) } : { lunchStart: 0, lunchEnd: 0 })
  ));

  const handleLunchEnd = useLastCallback((value: string) => (
    applySettings(value ? { lunchEnd: toMinutes(value) } : { lunchStart: 0, lunchEnd: 0 })
  ));

  const handleMargin = useLastCallback((value: string) => {
    if (value === '') {
      showPlannerNotice(lang('PlannerErrorSettingsMargin'));
      return false;
    }
    return applySettings({ margin: Number(value) });
  });

  const handleReset = useLastCallback(() => {
    updatePlanner((draft) => {
      draft.settings = { ...DEFAULT_PLANNER_SETTINGS };
      draft.budget = createEmptyPlannerState().budget;
    }, lang('PlannerNoticeSettingsSaved'));
  });

  const clockOrEmpty = (minutes: number) => (minutes > 0 ? toTime(minutes) : '');

  return (
    <div className={buildClassName(styles.editor, styles.settings)}>
      <Button isText size="smaller" className={styles.settingsBack} iconName="arrow-left" onClick={onBack}>
        {lang('Back')}
      </Button>
      {viewOptions && (
        <Select
          id="planner-settings-view"
          label={lang('PlannerCalView')}
          value={activeView}
          hasArrow
          onChange={handleViewChange}
        >
          {viewOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
        </Select>
      )}
      <p className={styles.small}>{lang('PlannerSettingsHint')}</p>
      <div className={styles.fields}>
        <PlannerField
          label={lang('PlannerSettingsBudget')}
          type="number"
          value={String(budget)}
          min={MIN_BUDGET_MINUTES}
          max={MINUTES_IN_DAY}
          step={BUDGET_STEP}
          onCommit={handleBudget}
        />
        <PlannerField
          label={lang('PlannerSettingsMargin')}
          type="number"
          value={String(settings.margin)}
          min={0}
          max={MAX_SLOT_MARGIN}
          step={MARGIN_STEP}
          onCommit={handleMargin}
        />
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
          label={lang('PlannerSettingsLunchStart')}
          type="time"
          value={clockOrEmpty(settings.lunchStart)}
          onCommit={handleLunchStart}
        />
        <PlannerField
          label={lang('PlannerSettingsLunchEnd')}
          type="time"
          value={clockOrEmpty(settings.lunchEnd)}
          onCommit={handleLunchEnd}
        />
      </div>
      <p className={styles.small}>{lang('PlannerSettingsLunchHint')}</p>
      <Button size="smaller" color="translucent" className={styles.settingsReset} onClick={handleReset}>
        {lang('PlannerSettingsReset')}
      </Button>
    </div>
  );
};

export default memo(PlannerSettings);
