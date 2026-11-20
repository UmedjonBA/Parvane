import { memo } from '../../../lib/teact/teact';

import type { PlannerLayer, PlannerLayers } from './plannerLayers';
import type { PlannerSettings as Settings, PlannerSettingsError, PlannerState } from './plannerModel';

import buildClassName from '../../../util/buildClassName';
import {
  createEmptyPlannerState, DEFAULT_PLANNER_SETTINGS, MIN_BUDGET_MINUTES, MINUTES_IN_DAY,
  toMinutes, toTime, validateBudget, validateSettings,
} from './plannerModel';
import { resetLearned } from './plannerQuickLearn';
import { resetHistory } from './plannerQuickSuggest';
import {
  canSyncLearned, canSyncQuickHistory, showPlannerNotice, updatePlanner,
} from './plannerStore';

import useFlag from '../../../hooks/useFlag';
import useLang from '../../../hooks/useLang';
import useLastCallback from '../../../hooks/useLastCallback';

import ConfirmDialog from '../../ui/ConfirmDialog';
import PlannerField from './PlannerField';
import PlannerLayerList from './PlannerLayerList';
import PlannerReminderSample from './PlannerReminderSample';

import styles from './Planner.module.scss';

type OwnProps = {
  state: PlannerState;
  // Аккаунт: запись словаря правок ввода текстом на устройстве (пока «План» недоступен) — у каждого своя
  userId?: string;
  // Слои календаря — настройка устройства
  layers: PlannerLayers;
  onToggleLayer: (layer: PlannerLayer) => void;
  // Экран «Расписание на неделю»
  onOpenImport: NoneToVoidFunction;
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
const PlannerSettings = ({
  state, userId, layers, onToggleLayer, onOpenImport,
}: OwnProps) => {
  const lang = useLang();

  const { settings, budget } = state;

  const [isClearOpen, openClear, closeClear] = useFlag();

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

  // Словарь правок стирается в данных «Плана» (на всех устройствах) и в записи этого устройства; вместе с
  // ним — история строк окна ввода и список забытых подсказок, там же
  const handleLearnedReset = useLastCallback(() => {
    resetLearned(userId);
    resetHistory(userId);
    const hasWords = canSyncLearned() && state.learned.length > 0;
    const hasLines = canSyncQuickHistory() && state.quickLines.length > 0;
    if (hasWords || hasLines) {
      updatePlanner((draft) => {
        if (hasWords) draft.learned = [];
        if (hasLines) draft.quickLines = [];
      }, lang('PlannerNoticeLearnedReset'));
    } else {
      showPlannerNotice(lang('PlannerNoticeLearnedReset'));
    }
  });

  const handleClear = useLastCallback(() => {
    closeClear();
    updatePlanner((draft) => {
      draft.tasks = [];
      draft.events = [];
    }, lang('PlannerNoticeCleared'));
  });

  return (
    <div className={styles.editor}>
      <h3 className={buildClassName(styles.groupTitle, styles.groupTitleFirst)}>{lang('PlannerLayers')}</h3>
      <PlannerLayerList layers={layers} onToggle={onToggleLayer} />
      <p className={styles.sheetHint}>{lang('PlannerLayersHint')}</p>
      <h3 className={styles.groupTitle}>{lang('PlannerReminderSampleTitle')}</h3>
      <PlannerReminderSample state={state} />
      <h3 className={styles.groupTitle}>{lang('PlannerSettingsDay')}</h3>
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
      <button type="button" className={buildClassName(styles.btn, styles.btnDanger)} onClick={handleReset}>
        {lang('PlannerSettingsReset')}
      </button>
      <p className={styles.sheetHint}>{lang('PlannerSettingsLearnedHint')}</p>
      <button
        type="button"
        className={buildClassName(styles.btn, styles.btnGhost)}
        data-quick-learned-reset
        onClick={handleLearnedReset}
      >
        {lang('PlannerSettingsLearnedReset')}
      </button>

      <h3 className={styles.groupTitle}>{lang('PlannerScheduleTitle')}</h3>
      <p className={styles.sheetHint}>{lang('PlannerImportIntro')}</p>
      <button
        type="button"
        className={buildClassName(styles.btn, styles.btnAccent)}
        data-schedule-open
        onClick={onOpenImport}
      >
        {lang('PlannerScheduleTitle')}
      </button>

      <h3 className={styles.groupTitle}>{lang('PlannerClearTitle')}</h3>
      <p className={styles.sheetHint}>{lang('PlannerClearHint')}</p>
      <button
        type="button"
        className={buildClassName(styles.btn, styles.btnDanger)}
        data-planner-clear
        onClick={openClear}
      >
        {lang('PlannerClearTitle')}
      </button>
      <ConfirmDialog
        isOpen={isClearOpen}
        onClose={closeClear}
        text={lang('PlannerClearConfirm')}
        confirmLabel={lang('PlannerClearTitle')}
        confirmHandler={handleClear}
        confirmIsDestructive
      />
    </div>
  );
};

export default memo(PlannerSettings);
