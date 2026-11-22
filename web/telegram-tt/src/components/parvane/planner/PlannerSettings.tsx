import { memo } from '../../../lib/teact/teact';

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
import PvSwitch from '../notes/PvSwitch';
import PlannerLayerList from './PlannerLayerList';
import PlannerReminderSample from './PlannerReminderSample';
import PlannerRemindSelect from './PlannerRemindSelect';

import styles from './PlannerSettings.module.scss';

type OwnProps = {
  state: PlannerState;
  // Аккаунт: запись словаря правок ввода текстом на устройстве (пока «План» недоступен) — у каждого своя
  userId?: string;
  // Телефон: сверху слои календаря и образец напоминания (доска `RpPlan`)
  isNarrow?: boolean;
  // Телефон: «Расписание на неделю» — строкой (на компьютере вход в колонке разделов «Плана»)
  onOpenImport?: NoneToVoidFunction;
};

const ERROR_KEYS = {
  window: 'PlannerErrorSettingsWindow',
  lunch: 'PlannerErrorSettingsLunch',
  margin: 'PlannerErrorSettingsMargin',
} as const satisfies Record<PlannerSettingsError, string>;
const MINUTES_IN_HOUR = 60;
const BUDGET_MINUTE_STEP = 5;
const MAX_MARGIN = 120;
const EVENT_REMIND_ID = 'planner-settings-event-remind';

// Parvane (spec 041, доски `RdPlanSet`, `PhModSettings`): «Профиль → Модули / План». Строки «подпись слева —
// значение справа»; каждое поле сохраняется само по завершении ввода, негодное значение не применяется и
// объясняется уведомлением
const PlannerSettings = ({
  state, userId, isNarrow, onOpenImport,
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

  const applyBudget = useLastCallback((next: number) => {
    if (!validateBudget(next)) {
      showPlannerNotice(lang('PlannerErrorSettingsBudget'));
      return;
    }
    if (next === budget) return;
    updatePlanner((draft) => {
      draft.budget = next;
    }, lang('PlannerNoticeSettingsSaved'));
  });

  // Поле возвращает прежнее значение, если новое не применено (перерисовки тогда нет)
  const handleTime = useLastCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const input = e.currentTarget;
    const field = input.dataset.field as 'dayStart' | 'dayEnd';
    const value = input.value ? toMinutes(input.value) : undefined;
    const changes = field === 'dayStart' ? { dayStart: value } : { dayEnd: value };
    if (value === undefined || !applySettings(changes)) input.value = toTime(settings[field]);
  });

  const handleLunch = useLastCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const input = e.currentTarget;
    const isStart = input.dataset.field === 'lunchStart';
    const hasLunch = settings.lunchEnd > settings.lunchStart;
    if (!input.value) {
      // Пустое поле — без перерыва
      applySettings({ lunchStart: 0, lunchEnd: 0 });
      return;
    }
    const value = toMinutes(input.value);
    const start = isStart ? value : hasLunch ? settings.lunchStart : value - MINUTES_IN_HOUR;
    const end = isStart ? (hasLunch ? settings.lunchEnd : value + MINUTES_IN_HOUR) : value;
    if (!applySettings({ lunchStart: start, lunchEnd: end })) {
      input.value = hasLunch ? toTime(isStart ? settings.lunchStart : settings.lunchEnd) : '';
    }
  });

  const handleBudget = useLastCallback((e: React.FocusEvent<HTMLInputElement>) => {
    const input = e.currentTarget;
    const value = Number(input.value);
    const isHours = input.dataset.field === 'hours';
    const hours = isHours ? value : Math.floor(budget / MINUTES_IN_HOUR);
    const minutes = isHours ? budget % MINUTES_IN_HOUR : value;
    const next = hours * MINUTES_IN_HOUR + minutes;
    if (!input.value || !Number.isInteger(value) || value < 0 || !validateBudget(next)) {
      input.value = String(isHours ? Math.floor(budget / MINUTES_IN_HOUR) : budget % MINUTES_IN_HOUR);
      showPlannerNotice(lang('PlannerErrorSettingsBudget'));
      return;
    }
    applyBudget(next);
  });

  const handleMargin = useLastCallback((e: React.FocusEvent<HTMLInputElement>) => {
    const input = e.currentTarget;
    const value = Number(input.value);
    if (!input.value || !Number.isInteger(value) || value < 0 || value > MAX_MARGIN) {
      input.value = String(settings.margin);
      showPlannerNotice(lang('PlannerErrorSettingsMargin'));
      return;
    }
    if (value !== settings.margin) applySettings({ margin: value });
  });

  const handleEnterCommit = useLastCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') e.currentTarget.blur();
  });

  const handleEventRemind = useLastCallback((value: number | undefined) => {
    applySettings({ eventRemind: value });
  });

  const handleDeadlines = useLastCallback((isOn: boolean) => {
    applySettings({ shouldRemindDeadlines: isOn || undefined });
  });

  const handleLearn = useLastCallback((isOn: boolean) => {
    applySettings({ isLearnOff: isOn ? undefined : true });
  });

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

  const hasLunch = settings.lunchEnd > settings.lunchStart;
  const learnedCount = state.learned.length;
  const budgetHours = Math.floor(budget / MINUTES_IN_HOUR);
  const budgetMinutes = budget % MINUTES_IN_HOUR;

  function renderTime(field: 'dayStart' | 'dayEnd', label: string) {
    return (
      <label className={styles.row}>
        <span className={styles.label}>{label}</span>
        <input
          className={styles.input}
          type="time"
          value={toTime(settings[field])}
          aria-label={label}
          data-field={field}
          onChange={handleTime}
        />
      </label>
    );
  }

  return (
    <div className={styles.root} data-planner-settings>
      {isNarrow && (
        <>
          <h3 className={styles.caps}>{lang('PlannerLayers')}</h3>
          <PlannerLayerList isNarrow />
          <p className={styles.hint}>{lang('PlannerLayersHint')}</p>
          <h3 className={styles.caps}>{lang('PlannerReminderSampleTitle')}</h3>
          <PlannerReminderSample state={state} />
        </>
      )}

      <div className={styles.cols}>
        <div className={styles.col}>
          <h3 className={styles.caps}>{lang('PlannerSettingsDay')}</h3>
          <div className={styles.card}>
            {renderTime('dayStart', lang('PlannerSettingsDayStart'))}
            {renderTime('dayEnd', lang('PlannerSettingsDayEnd'))}
            <div className={styles.row}>
              <span className={styles.label}>{lang('PlannerSettingsBudget')}</span>
              <span className={styles.value} data-settings-budget>
                <input
                  className={buildClassName(styles.input, styles.number)}
                  type="number"
                  min={Math.floor(MIN_BUDGET_MINUTES / MINUTES_IN_HOUR)}
                  max={MINUTES_IN_DAY / MINUTES_IN_HOUR}
                  value={String(budgetHours)}
                  aria-label={lang('PlannerSettingsBudgetHours')}
                  data-field="hours"
                  onBlur={handleBudget}
                  onKeyDown={handleEnterCommit}
                />
                <span className={styles.unit}>{lang('PlannerUnitHours')}</span>
                <input
                  className={buildClassName(styles.input, styles.number)}
                  type="number"
                  min={0}
                  max={MINUTES_IN_HOUR - BUDGET_MINUTE_STEP}
                  step={BUDGET_MINUTE_STEP}
                  value={String(budgetMinutes).padStart(2, '0')}
                  aria-label={lang('PlannerSettingsBudgetMinutes')}
                  data-field="minutes"
                  onBlur={handleBudget}
                  onKeyDown={handleEnterCommit}
                />
                <span className={styles.unit}>{lang('PlannerUnitMinutes')}</span>
              </span>
            </div>
            <div className={styles.row}>
              <span className={styles.label}>{lang('PlannerSettingsLunch')}</span>
              <span className={styles.value} data-settings-lunch>
                <input
                  className={styles.input}
                  type="time"
                  value={hasLunch ? toTime(settings.lunchStart) : ''}
                  aria-label={lang('PlannerSettingsLunchStart')}
                  data-field="lunchStart"
                  onChange={handleLunch}
                />
                <span className={styles.unit}>–</span>
                <input
                  className={styles.input}
                  type="time"
                  value={hasLunch ? toTime(settings.lunchEnd) : ''}
                  aria-label={lang('PlannerSettingsLunchEnd')}
                  data-field="lunchEnd"
                  onChange={handleLunch}
                />
              </span>
            </div>
            <label className={styles.row}>
              <span className={styles.label}>{lang('PlannerSettingsMargin')}</span>
              <span className={styles.value}>
                <input
                  className={buildClassName(styles.input, styles.number)}
                  type="number"
                  min={0}
                  max={MAX_MARGIN}
                  step={5}
                  value={String(settings.margin)}
                  aria-label={lang('PlannerSettingsMargin')}
                  data-settings-margin
                  onBlur={handleMargin}
                  onKeyDown={handleEnterCommit}
                />
                <span className={styles.unit}>{lang('PlannerUnitMinutes')}</span>
              </span>
            </label>
          </div>
          {isNarrow && <p className={styles.hint}>{lang('PlannerSettingsBudgetHint')}</p>}
        </div>
        <div className={styles.col}>
          <h3 className={styles.caps}>{lang('PlannerSettingsReminders')}</h3>
          <div className={styles.card}>
            <label className={styles.row} data-settings-event-remind>
              <span className={styles.label}>{lang('PlannerSettingsEventRemind')}</span>
              <PlannerRemindSelect
                id={EVENT_REMIND_ID}
                label={lang('PlannerSettingsEventRemind')}
                value={settings.eventRemind}
                plainClassName={buildClassName(styles.input, styles.select)}
                onChange={handleEventRemind}
              />
            </label>
            <PvSwitch
              isOn={Boolean(settings.shouldRemindDeadlines)}
              className={styles.switchRow}
              data-settings-deadlines
              onChange={handleDeadlines}
            >
              <span className={styles.label}>{lang('PlannerSettingsRemindDeadlines')}</span>
            </PvSwitch>
          </div>

          <h3 className={styles.caps}>{lang('PlannerSettingsQuickInput')}</h3>
          <div className={styles.card}>
            <PvSwitch
              isOn={!settings.isLearnOff}
              className={styles.switchRow}
              data-settings-learn
              onChange={handleLearn}
            >
              <span className={styles.text}>
                <span className={styles.label}>{lang('PlannerSettingsLearn')}</span>
                <span className={styles.sub}>{lang('PlannerSettingsLearnHint')}</span>
              </span>
            </PvSwitch>
            <div className={styles.row}>
              <span className={styles.label} data-settings-learned-count>
                {lang('PlannerSettingsLearnedCount', { count: learnedCount }, { pluralValue: learnedCount })}
              </span>
              <button
                type="button"
                className={styles.link}
                data-quick-learned-reset
                onClick={handleLearnedReset}
              >
                {lang('PlannerSettingsLearnedReset')}
              </button>
            </div>
          </div>
        </div>
      </div>
      {!isNarrow && <p className={styles.hint}>{lang('PlannerSettingsSleepHint')}</p>}

      {onOpenImport && (
        <button
          type="button"
          className={buildClassName(styles.card, styles.linkRow)}
          data-schedule-open
          onClick={onOpenImport}
        >
          <span className={styles.label}>{lang('PlannerScheduleTitle')}</span>
          <span className={styles.arrow} aria-hidden>›</span>
        </button>
      )}

      <div className={styles.actions}>
        <button type="button" className={styles.button} data-settings-reset onClick={handleReset}>
          {lang('PlannerSettingsReset')}
        </button>
        <button
          type="button"
          className={buildClassName(styles.button, styles.danger)}
          data-planner-clear
          onClick={openClear}
        >
          {lang('PlannerClearTitle')}
        </button>
      </div>
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
