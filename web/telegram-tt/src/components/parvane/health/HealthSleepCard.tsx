import { memo } from '../../../lib/teact/teact';

import type { HealthSleepView } from './healthTypes';

import buildClassName from '../../../util/buildClassName';
import { formatClock, formatDurationShort, sleepBar } from './healthFormat';

import useHealthLabels from './useHealthLabels';

import ParvaneIcon from '../../main/ParvaneIcon';

import kit from '../notes/PvKit.module.scss';
import styles from './Health.module.scss';

type OwnProps = {
  sleep: HealthSleepView;
  today: string;
  isDetail?: boolean;
  onOpen?: NoneToVoidFunction;
  onBed: NoneToVoidFunction;
  onWake: NoneToVoidFunction;
};

const WEEKDAY_KEYS = [
  'HealthWeekdayMon', 'HealthWeekdayTue', 'HealthWeekdayWed', 'HealthWeekdayThu', 'HealthWeekdayFri',
  'HealthWeekdaySat', 'HealthWeekdaySun',
] as const;

// Parvane (spec 038): карточка сна — последняя ночь, отклонение от цели и режим за неделю: когда лёг и
// встал по дням на общей шкале с целью. Числа считает движок
const HealthSleepCard = ({
  sleep, today, isDetail, onOpen, onBed, onWake,
}: OwnProps) => {
  const { lang, duration } = useHealthLabels(today);
  const {
    last, lastTotalMinutes, lastDeltaMinutes, goalBedMin, goalWakeMin, week, openStartMs,
  } = sleep;
  const hasGoal = goalBedMin !== undefined && goalWakeMin !== undefined;
  const goalBar = hasGoal ? sleepBar(goalBedMin, goalWakeMin) : undefined;

  function renderDelta() {
    if (lastDeltaMinutes === undefined) return undefined;
    if (!lastDeltaMinutes) return <span className={styles.good}>{lang('HealthSleepOnGoal')}</span>;
    const text = duration(Math.abs(lastDeltaMinutes));
    return (
      <span className={lastDeltaMinutes < 0 ? styles.warn : styles.good}>
        {lang(lastDeltaMinutes < 0 ? 'HealthSleepBelowGoal' : 'HealthSleepAboveGoal', { duration: text })}
      </span>
    );
  }

  return (
    <section className={buildClassName(kit.card, styles.card)} data-health-card="sleep">
      <header className={styles.cardHead}>
        <ParvaneIcon name="sun" isSmall className={styles.sleepIcon} />
        <span className={buildClassName(kit.caps, kit.grow)}>{lang('HealthSleepWeek')}</span>
        {hasGoal && (
          <span className={buildClassName(kit.muted, kit.small)}>
            {lang('HealthGoalShort')}
            {' '}
            <span className={kit.mono}>{`${formatClock(goalBedMin)} → ${formatClock(goalWakeMin)}`}</span>
          </span>
        )}
        {!isDetail && onOpen && (
          <button type="button" className={kit.ib} aria-label={lang('HealthOpenSleep')} onClick={onOpen}>
            <ParvaneIcon name="right" isSmall />
          </button>
        )}
      </header>
      {last ? (
        <div className={styles.sleepLine}>
          <span className={buildClassName(kit.mono, styles.big)} data-health-sleep-total>
            {duration(lastTotalMinutes ?? last.minutes)}
          </span>
          {renderDelta()}
          {last.bedMin !== undefined && last.wakeMin !== undefined && (
            <span className={kit.muted}>
              <span className={kit.mono}>{`${formatClock(last.bedMin)} → ${formatClock(last.wakeMin)}`}</span>
            </span>
          )}
        </div>
      ) : (
        <div className={kit.muted}>{lang('HealthSleepEmpty')}</div>
      )}
      <div className={styles.week} role="img" aria-label={lang('HealthSleepWeekChart')}>
        {week.map((day) => {
          const bar = day.bedMin !== undefined && day.wakeMin !== undefined
            ? sleepBar(day.bedMin, day.wakeMin) : undefined;
          return (
            <div key={day.day} className={styles.weekRow} data-day={day.day}>
              <span className={buildClassName(kit.mono, styles.weekDay)}>{lang(WEEKDAY_KEYS[day.weekday])}</span>
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
              <span className={buildClassName(kit.mono, styles.weekValue)}>
                {day.minutes !== undefined ? formatDurationShort(day.minutes) : '—'}
              </span>
            </div>
          );
        })}
      </div>
      <div className={styles.cardButtons}>
        <button
          type="button"
          className={buildClassName(kit.btn, openStartMs === undefined && kit.btnAcc)}
          disabled={openStartMs !== undefined}
          data-health-action="bed"
          onClick={onBed}
        >
          {lang('HealthSleepBed')}
        </button>
        <button
          type="button"
          className={buildClassName(kit.btn, openStartMs !== undefined && kit.btnAcc)}
          data-health-action="wake"
          onClick={onWake}
        >
          {lang('HealthSleepWake')}
        </button>
      </div>
    </section>
  );
};

export default memo(HealthSleepCard);
