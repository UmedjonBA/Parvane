import {
  memo, useEffect, useLayoutEffect, useState,
} from '../../../lib/teact/teact';
import { getActions } from '../../../global';

import type { HealthBlockId } from '../../../util/parvaneModules';
import type { HealthParsedEntry } from './healthTypes';
import { SettingsScreens } from '../../../types';

import { readBedtimeReminder, saveBedtimeReminder } from '../../../util/bedtimeReminder';
import buildClassName from '../../../util/buildClassName';
import { formatClock, parseClock, parseNumber } from './healthFormat';
import {
  getHealthDays, parseHealthInput, refreshHealthDays, setHealthGoal, watchHealthDays,
} from './healthStore';

import useDerivedState from '../../../hooks/useDerivedState';
import useLang from '../../../hooks/useLang';
import useLastCallback from '../../../hooks/useLastCallback';
import useParvaneModules from '../../../hooks/useParvaneModules';

import PvSwitch from '../notes/PvSwitch';

import styles from '../planner/PlannerSettings.module.scss';

// Цели строкой: вид записи разбора → имя цели в домене «Здоровья» (сон — длительность, отбой и подъём считаются)
const GOAL_OF_KIND: Record<string, string> = {
  sleep: 'sleep', weight: 'weight', steps: 'steps', pulse: 'pulse', pressure: 'pressure', water: 'water',
};
const GOAL_LABELS = {
  sleep: 'HealthGoalsSleep',
  sleep_bed: 'HealthGoalsBed',
  sleep_wake: 'HealthGoalsWake',
  weight: 'HealthGoalsWeight',
  steps: 'HealthGoalsSteps',
  pulse: 'HealthGoalsPulse',
  pressure: 'HealthGoalsPressure',
  water: 'HealthGoalsWater',
  kcal: 'HealthGoalsKcal',
  protein: 'HealthGoalsProtein',
  fat: 'HealthGoalsFat',
  carbs: 'HealthGoalsCarbs',
} as const satisfies Record<string, string>;
// Отметки сна из разбора («отбой 23:30», «подъём 7») — цели времени отбоя и подъёма
const CLOCK_GOAL_OF_KIND: Record<string, string> = { sleep_start: 'sleep_bed', sleep_end: 'sleep_wake' };
const MACRO_GOALS = ['protein', 'fat', 'carbs'];
const FOOD_KIND = 'food';
const GOAL_ORDER = Object.keys(GOAL_LABELS);
const MINUTES_IN_DAY = 1440;
// Без цели отбоя и подъёма длительность сна ставится от отбоя в 23:00
const DEFAULT_BED_MIN = 23 * 60;
const PARSE_DELAY_MS = 250;
// Цели блоков, выключенных по умолчанию: питание, вода, тренировки
const NUTRITION_GOALS = [
  ['kcal', 'HealthGoalsKcal'], ['protein', 'HealthGoalsProtein'], ['fat', 'HealthGoalsFat'],
  ['carbs', 'HealthGoalsCarbs'],
] as const;
const OPTIONAL_BLOCKS: HealthBlockId[] = ['food', 'water', 'workouts'];

type Understood = { goal: string; value: number };

// Parvane (spec 041, доски `RdPlanSet`, `PhModSettings`): «Профиль → Модули / Здоровье — Цели здоровья» одним
// экраном: цели строкой (разбор — движок «Здоровья»), режим сна с длительностью и «Напоминать об отбое», показатели
// тела; цели выключенных блоков сохраняются и возвращаются вместе с блоками
const HealthGoalsScreen = () => {
  const { openSettingsScreen } = getActions();
  const lang = useLang();
  const days = useDerivedState(getHealthDays);
  const { prefs } = useParvaneModules();
  const goals = days?.goals || {};
  const [text, setText] = useState('');
  const [understood, setUnderstood] = useState<Understood[]>([]);
  const [bedtime, setBedtime] = useState(readBedtimeReminder);

  useEffect(() => {
    watchHealthDays();
  }, []);

  const bedMin = goals.sleep_bed;
  const wakeMin = goals.sleep_wake;
  const sleepMinutes = bedMin !== undefined && wakeMin !== undefined
    ? (((wakeMin - bedMin) % MINUTES_IN_DAY) + MINUTES_IN_DAY) % MINUTES_IN_DAY : undefined;

  // Напоминание об отбое следует за целью отбоя, правленной где угодно
  useEffect(() => {
    if (!bedtime || bedMin === undefined || bedtime.bedMin === bedMin) return;
    const next = { bedMin, title: lang('HealthGoalsBedtimeTitle') };
    saveBedtimeReminder(next);
    setBedtime(next);
  }, [bedtime, bedMin, lang]);

  useEffect(() => {
    if (!text.trim()) {
      setUnderstood([]);
      return undefined;
    }
    const timer = window.setTimeout(async () => {
      const parsed = await parseHealthInput(text);
      setUnderstood(toGoals(parsed?.entries || []));
    }, PARSE_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [text]);

  const handleText = useLastCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    setText(e.currentTarget.value);
  });

  const applyUnderstood = useLastCallback(async () => {
    const parsed = await parseHealthInput(text);
    const list = toGoals(parsed?.entries || []);
    if (!list.length) return;
    // Цели пишутся по одной: каждая — своя правка домена
    await list.reduce((previous, { goal, value }) => previous.then(async () => {
      if (goal !== 'sleep') {
        await setHealthGoal(goal, value);
        return;
      }
      const bed = bedMin ?? (wakeMin !== undefined ? wakeMin - value : DEFAULT_BED_MIN);
      const fromBed = ((bed % MINUTES_IN_DAY) + MINUTES_IN_DAY) % MINUTES_IN_DAY;
      if (bedMin === undefined) await setHealthGoal('sleep_bed', fromBed);
      await setHealthGoal('sleep_wake', (fromBed + value) % MINUTES_IN_DAY);
    }), Promise.resolve());
    setText('');
    void refreshHealthDays();
  });

  // Enter строки целей. Общая очередь клавиш (`captureKeyboardListeners`) ловит Enter на документе в фазе перехвата
  // раньше поля, если в ней есть обработчики других модулей, — клавиша поля берётся ещё раньше, на `window`
  const handleWindowKey = useLastCallback((e: KeyboardEvent) => {
    if (e.key !== 'Enter' || e.isComposing || !(e.target instanceof HTMLInputElement)
      || !e.target.matches('[data-health-goals-line]')) {
      return;
    }
    e.stopPropagation();
    e.preventDefault();
    void applyUnderstood();
  });

  useLayoutEffect(() => {
    window.addEventListener('keydown', handleWindowKey, true);
    return () => window.removeEventListener('keydown', handleWindowKey, true);
  }, [handleWindowKey]);

  const handleClock = useLastCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const { goal } = e.currentTarget.dataset;
    const value = e.currentTarget.value ? parseClock(e.currentTarget.value) : undefined;
    void setHealthGoal(goal!, value);
  });

  const handleNumber = useLastCallback((e: React.FocusEvent<HTMLInputElement>) => {
    const input = e.currentTarget;
    const goal = input.dataset.goal!;
    const typed = input.value.trim();
    const value = typed ? parseNumber(typed) : undefined;
    if (typed && (value === undefined || value <= 0)) {
      input.value = goals[goal] === undefined ? '' : String(goals[goal]);
      return;
    }
    if (value !== goals[goal]) void setHealthGoal(goal, value);
  });

  const handleEnterBlur = useLastCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') e.currentTarget.blur();
  });

  const handleBedtime = useLastCallback((isOn: boolean) => {
    const next = isOn && bedMin !== undefined ? { bedMin, title: lang('HealthGoalsBedtimeTitle') } : undefined;
    saveBedtimeReminder(next);
    setBedtime(next);
  });

  const handleOpenBlocks = useLastCallback(() => {
    openSettingsScreen({ screen: SettingsScreens.ParvaneModules });
  });

  const isOn = (block: HealthBlockId) => prefs.healthBlocks.includes(block);
  const offBlocks = OPTIONAL_BLOCKS.filter((block) => !isOn(block));

  function renderNumber(goal: string, label: string, unit?: string) {
    return (
      <label key={goal} className={styles.row}>
        <span className={styles.label}>{label}</span>
        <span className={styles.value}>
          <input
            className={buildClassName(styles.input, styles.number)}
            type="text"
            inputMode="decimal"
            value={goals[goal] === undefined ? '' : String(goals[goal])}
            placeholder={lang('HealthGoalsNone')}
            aria-label={label}
            data-health-goal={goal}
            data-goal={goal}
            onBlur={handleNumber}
            onKeyDown={handleEnterBlur}
          />
          {unit && <span className={styles.unit}>{unit}</span>}
        </span>
      </label>
    );
  }

  function renderClock(goal: 'sleep_bed' | 'sleep_wake', label: string, value?: number) {
    return (
      <label className={styles.row}>
        <span className={styles.label}>{label}</span>
        <input
          className={styles.input}
          type="time"
          value={value === undefined ? '' : formatClock(value)}
          aria-label={label}
          data-health-goal={goal}
          data-goal={goal}
          onChange={handleClock}
        />
      </label>
    );
  }

  return (
    <div className={styles.root} data-health-goals>
      <div className={styles.card}>
        <label className={styles.row}>
          <input
            className={buildClassName(styles.input, styles.grow)}
            type="text"
            value={text}
            placeholder={lang('HealthGoalsLinePlaceholder')}
            aria-label={lang('HealthGoalsLine')}
            data-health-goals-line
            onChange={handleText}
          />
          {understood.length > 0 && (
            <span className={styles.sub} data-health-goals-understood>
              {lang('HealthGoalsUnderstood', {
                list: understood.map(({ goal }) => lang(GOAL_LABELS[goal as keyof typeof GOAL_LABELS]).toLowerCase())
                  .join(' · '),
              })}
            </span>
          )}
        </label>
      </div>

      {isOn('sleep') && (
        <>
          <h3 className={styles.caps}>{lang('HealthGoalsSleep')}</h3>
          <div className={styles.card}>
            {renderClock('sleep_bed', lang('HealthGoalsBed'), bedMin)}
            {renderClock('sleep_wake', lang('HealthGoalsWake'), wakeMin)}
            <div className={styles.row}>
              <span className={styles.label}>{lang('HealthGoalsDuration')}</span>
              <span className={styles.unit} data-health-goals-duration>
                {sleepMinutes === undefined ? lang('HealthGoalsNone') : lang('HealthGoalsDurationValue', {
                  hours: Math.floor(sleepMinutes / 60), minutes: sleepMinutes % 60,
                })}
              </span>
            </div>
            <PvSwitch
              isOn={Boolean(bedtime)}
              isDisabled={bedMin === undefined}
              className={styles.switchRow}
              data-health-bedtime
              onChange={handleBedtime}
            >
              <span className={styles.label}>{lang('HealthGoalsBedtime')}</span>
            </PvSwitch>
          </div>
        </>
      )}

      {isOn('body') && (
        <>
          <h3 className={styles.caps}>{lang('HealthGoalsBody')}</h3>
          <div className={styles.card}>
            {renderNumber('weight', lang('HealthGoalsWeight'), lang('HealthUnitKg'))}
            {renderNumber('steps', lang('HealthGoalsSteps'))}
            {renderNumber('pressure', lang('HealthGoalsPressure'), lang('HealthUnitMmhg'))}
            {renderNumber('pulse', lang('HealthGoalsPulse'), lang('HealthUnitBpm'))}
          </div>
        </>
      )}

      {isOn('food') && (
        <>
          <h3 className={styles.caps}>{lang('HealthGoalsFood')}</h3>
          <div className={styles.card}>
            {NUTRITION_GOALS.map(([goal, key]) => renderNumber(
              goal, lang(key), lang(goal === 'kcal' ? 'HealthUnitKcal' : 'HealthUnitGram'),
            ))}
          </div>
        </>
      )}
      {(isOn('water') || isOn('workouts')) && (
        <div className={styles.card}>
          {isOn('water') && renderNumber('water', lang('HealthGoalsWater'), lang('HealthUnitMl'))}
          {isOn('workouts') && renderNumber('active_min', lang('HealthGoalsActive'), lang('HealthUnitMin'))}
        </div>
      )}

      {offBlocks.length > 0 && (
        <div className={buildClassName(styles.card, styles.row)} data-health-goals-off>
          <span className={styles.sub}>
            {lang(offBlocks.length === OPTIONAL_BLOCKS.length ? 'HealthGoalsBlocksOff' : 'HealthGoalsSomeBlocksOff')}
          </span>
          <button type="button" className={styles.link} data-health-goals-blocks onClick={handleOpenBlocks}>
            {lang('HealthGoalsEnableBlocks')}
          </button>
        </div>
      )}
    </div>
  );
};

function toGoals(entries: HealthParsedEntry[]): Understood[] {
  const out: Understood[] = [];
  const add = (goal: string, value: number) => {
    if (!out.some((item) => item.goal === goal)) out.push({ goal, value });
  };
  entries.forEach(({
    kind, value, time, endTime, atMs, endMs, parts, computed,
  }) => {
    // «отбой 23:15 подъём 6:45» движок понимает одной ночью: её начало и конец — цели отбоя и подъёма
    if (kind === 'sleep' && endMs > atMs && endTime) {
      const bed = parseClock(time);
      const wake = parseClock(endTime);
      if (bed !== undefined && wake !== undefined) {
        add('sleep_bed', bed);
        add('sleep_wake', wake);
        return;
      }
    }
    const clockGoal = CLOCK_GOAL_OF_KIND[kind];
    if (clockGoal) {
      // Время суток: полночь — ноль минут, это тоже цель
      const minutes = parseClock(time);
      if (minutes !== undefined) add(clockGoal, minutes);
      return;
    }
    if (kind === FOOD_KIND) {
      // «ккал 2200 белки 140»: калории и БЖУ — цели питания
      // Калории, посчитанные движком из БЖУ, целью не становятся
      if (value > 0 && !computed) add('kcal', value);
      MACRO_GOALS.forEach((macro) => {
        if (parts?.[macro]) add(macro, parts[macro]);
      });
      return;
    }
    const goal = GOAL_OF_KIND[kind];
    if (goal && value > 0) add(goal, value);
  });
  // Порядок — как строки экрана: сон, вес, шаги… (доска `RdPlanSet` «Понято: сон · вес · шаги»)
  return out.sort((a, b) => GOAL_ORDER.indexOf(a.goal) - GOAL_ORDER.indexOf(b.goal));
}

export default memo(HealthGoalsScreen);
