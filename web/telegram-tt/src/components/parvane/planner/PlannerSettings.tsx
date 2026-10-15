import { memo, useMemo, useState } from '../../../lib/teact/teact';

import type { PlannerSettings as Settings, PlannerSettingsError, PlannerState } from './plannerModel';

import buildClassName from '../../../util/buildClassName';
import { formatDate } from './plannerFormat';
import {
  createEmptyPlannerState, DEFAULT_PLANNER_SETTINGS, fromDayKey, MIN_BUDGET_MINUTES, MINUTES_IN_DAY,
  toDayKey, toMinutes, toTime, validateBudget, validateSettings,
} from './plannerModel';
import { resetLearned } from './plannerQuickLearn';
import { resetHistory } from './plannerQuickSuggest';
import { buildScheduleEvents, parseSchedule } from './plannerSchedule';
import {
  canSyncLearned, canSyncQuickHistory, showPlannerNotice, updatePlanner,
} from './plannerStore';

import useFlag from '../../../hooks/useFlag';
import useLang from '../../../hooks/useLang';
import useLastCallback from '../../../hooks/useLastCallback';

import ConfirmDialog from '../../ui/ConfirmDialog';
import PlannerField from './PlannerField';

import styles from './Planner.module.scss';

type OwnProps = {
  state: PlannerState;
  // Аккаунт: запись словаря правок ввода текстом на устройстве (пока «План» недоступен) — у каждого своя
  userId?: string;
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
const PlannerSettings = ({ state, userId }: OwnProps) => {
  const lang = useLang();

  const { settings, budget } = state;

  const [scheduleText, setScheduleText] = useState('');
  // Дата конца, выбранная полем; нет — из текста («до 15.12.2026»)
  const [scheduleUntil, setScheduleUntil] = useState<string>();
  const [isClearOpen, openClear, closeClear] = useFlag();
  const schedule = useMemo(() => parseSchedule(scheduleText), [scheduleText]);
  const until = scheduleUntil || schedule.endDay;

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

  const handleScheduleText = useLastCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setScheduleText(e.currentTarget.value);
  });

  // Каждая строка — еженедельный ряд с сегодняшнего дня до даты конца включительно
  const handleScheduleAdd = useLastCallback(() => {
    const today = toDayKey(new Date());
    if (!schedule.items.length) {
      showPlannerNotice(lang('PlannerErrorScheduleEmpty'));
      return;
    }
    if (!until || until < today) {
      showPlannerNotice(lang('PlannerErrorScheduleUntil'));
      return;
    }
    const events = buildScheduleEvents(schedule.items, today, until);
    updatePlanner((draft) => {
      draft.events.push(...events);
    }, lang('PlannerNoticeScheduleAdded', { count: events.length }));
    setScheduleText('');
    setScheduleUntil(undefined);
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
      <p className={styles.sheetHint}>{lang('PlannerScheduleHint')}</p>
      <textarea
        className={buildClassName(styles.dailyEditor, styles.scheduleInput)}
        data-schedule-input
        value={scheduleText}
        aria-label={lang('PlannerScheduleTitle')}
        placeholder={lang('PlannerSchedulePlaceholder')}
        onChange={handleScheduleText}
      />
      <div className={styles.fields}>
        <PlannerField
          label={lang('PlannerScheduleUntil')}
          type="date"
          value={until}
          onCommit={setScheduleUntil}
        />
      </div>
      {Boolean(schedule.items.length) && (
        <p className={styles.sheetHint} data-schedule-preview>
          {lang('PlannerSchedulePreview', {
            count: schedule.items.length,
            date: until
              ? formatDate(lang.code, fromDayKey(until), { day: 'numeric', month: 'long', year: 'numeric' })
              : '—',
          })}
        </p>
      )}
      {Boolean(schedule.skipped.length) && (
        <p className={styles.sheetHint}>{lang('PlannerScheduleSkipped', { count: schedule.skipped.length })}</p>
      )}
      <button
        type="button"
        className={buildClassName(styles.btn, styles.btnAccent)}
        data-schedule-add
        disabled={!schedule.items.length}
        onClick={handleScheduleAdd}
      >
        {lang('PlannerScheduleAdd')}
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
