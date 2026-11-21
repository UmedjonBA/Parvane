import { memo } from '../../../lib/teact/teact';

import type { HealthSleepDay } from './healthTypes';

import buildClassName from '../../../util/buildClassName';
import { formatDate } from '../planner/plannerFormat';
import {
  formatClock, formatDurationShort, sleepAxis, sleepAxisLabels, sleepBar, WEEKDAY_KEYS,
} from './healthFormat';

import useLang from '../../../hooks/useLang';

import kit from '../notes/PvKit.module.scss';
import styles from './Health.module.scss';

type OwnProps = {
  days: HealthSleepDay[];
  goalBedMin?: number;
  goalWakeMin?: number;
  // Строка дня с «лёг → встал» (подробный экран компьютера)
  withClock?: boolean;
  // Месяц: подпись дня — число
  isMonth?: boolean;
};

const DAY_NUMBER = { day: 'numeric' } as const;

// Parvane (spec 041; доски `HealthSleep`, `DeskHealth`, `DeskHealthDetail`): режим сна — полоса «лёг → встал» на
// шкале суток по дням с полосой цели, подписи шкалы через два часа, последняя ночь выделена. Числа — из движка
const HealthRegimeChart = ({
  days, goalBedMin, goalWakeMin, withClock, isMonth,
}: OwnProps) => {
  const lang = useLang();
  const hasGoal = goalBedMin !== undefined && goalWakeMin !== undefined;
  const axis = sleepAxis(hasGoal ? [...days, { bedMin: goalBedMin, wakeMin: goalWakeMin }] : days);
  const goalBar = hasGoal ? sleepBar(goalBedMin, goalWakeMin, axis) : undefined;
  const lastIndex = days.length - 1;

  return (
    <div
      className={buildClassName(styles.week, withClock && styles.weekWithClock, isMonth && styles.weekMonth)}
      role="img"
      aria-label={lang('HealthSleepWeekChart')}
      data-health-regime={days.length}
    >
      {days.map((day, index) => {
        const bar = day.bedMin !== undefined && day.wakeMin !== undefined
          ? sleepBar(day.bedMin, day.wakeMin, axis) : undefined;
        return (
          <div
            key={day.day}
            className={buildClassName(styles.weekRow, index === lastIndex && styles.weekRowLast)}
            data-day={day.day}
          >
            <span className={buildClassName(kit.mono, styles.weekDay)}>
              {isMonth
                ? formatDate(lang.code, new Date(`${day.day}T12:00:00`), DAY_NUMBER)
                : lang(WEEKDAY_KEYS[day.weekday])}
            </span>
            <span className={styles.weekTrack}>
              {goalBar && (
                <span
                  className={styles.weekGoal}
                  style={`left: ${goalBar.left * 100}%; width: ${goalBar.width * 100}%`}
                />
              )}
              {bar && (
                <span className={styles.weekBar} style={`left: ${bar.left * 100}%; width: ${bar.width * 100}%`} />
              )}
            </span>
            {withClock && (
              <span className={buildClassName(kit.mono, kit.muted, styles.weekClock)}>
                {day.bedMin !== undefined && day.wakeMin !== undefined
                  ? `${formatClock(day.bedMin)} → ${formatClock(day.wakeMin)}` : ''}
              </span>
            )}
            <span className={buildClassName(kit.mono, styles.weekValue)}>
              {day.minutes !== undefined ? formatDurationShort(day.minutes) : '—'}
            </span>
          </div>
        );
      })}
      <div className={buildClassName(styles.weekRow, styles.weekAxis)} aria-hidden>
        <span className={styles.weekDay} />
        <span className={styles.weekAxisLabels}>
          {sleepAxisLabels(axis).map((label, index) => <span key={`${label}${index}`}>{label}</span>)}
        </span>
        {withClock && <span className={styles.weekClock} />}
        <span className={styles.weekValue} />
      </div>
    </div>
  );
};

export default memo(HealthRegimeChart);
