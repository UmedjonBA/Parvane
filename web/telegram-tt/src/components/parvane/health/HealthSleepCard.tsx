import { memo } from '../../../lib/teact/teact';

import type { HealthSleepView } from './healthTypes';

import buildClassName from '../../../util/buildClassName';
import { formatClock } from './healthFormat';
import useHealthLabels from './useHealthLabels';

import ParvaneIcon from '../../main/ParvaneIcon';
import HealthRegimeChart from './HealthRegimeChart';
import HealthSleepButtons from './HealthSleepButtons';

import kit from '../notes/PvKit.module.scss';
import styles from './Health.module.scss';

type OwnProps = {
  sleep: HealthSleepView;
  today: string;
  // Телефон: компактная карточка с мини-столбиками, нажатие открывает «Сон» (доска `Health`)
  isPhone?: boolean;
  onOpen: NoneToVoidFunction;
  onBed: NoneToVoidFunction;
  onWake: NoneToVoidFunction;
};

const MINI_NIGHTS = 8;

// Parvane (spec 038, 041; доски `Health`, `DeskHealth`): карточка сна сводки — последняя ночь, отклонение от цели;
// на компьютере ещё режим за неделю и «Ложусь / Встал». Числа считает движок
const HealthSleepCard = ({
  sleep, today, isPhone, onOpen, onBed, onWake,
}: OwnProps) => {
  const { lang, duration, shortDuration } = useHealthLabels(today);
  const {
    last, lastTotalMinutes, lastDeltaMinutes, goalBedMin, goalWakeMin, week, month,
  } = sleep;
  const hasGoal = goalBedMin !== undefined && goalWakeMin !== undefined;
  const hasClock = last?.bedMin !== undefined && last.wakeMin !== undefined;

  function renderDelta() {
    if (lastDeltaMinutes === undefined) return undefined;
    if (!lastDeltaMinutes) return <span className={styles.good}>{lang('HealthSleepOnGoal')}</span>;
    const text = shortDuration(lastDeltaMinutes);
    return (
      <span className={lastDeltaMinutes < 0 ? styles.warn : styles.good} data-health-sleep-delta>
        {isPhone
          ? lang(lastDeltaMinutes < 0 ? 'HealthSleepBelowGoal' : 'HealthSleepAboveGoal', { duration: text })
          : lang('HealthSleepFromGoal', { value: `${lastDeltaMinutes < 0 ? '−' : '+'}${text}` })}
      </span>
    );
  }

  function renderNumber() {
    if (!last) return <div className={kit.muted}>{lang('HealthSleepEmpty')}</div>;
    return (
      <span className={buildClassName(kit.mono, styles.big)} data-health-sleep-total>
        {duration(lastTotalMinutes ?? last.minutes)}
      </span>
    );
  }

  if (isPhone) {
    const nights = month.slice(-MINI_NIGHTS);
    const top = Math.max(1, ...nights.map((night) => night.minutes || 0));
    return (
      <button
        type="button"
        className={buildClassName(kit.card, styles.card, styles.sleepPhone)}
        data-health-card="sleep"
        aria-label={lang('HealthOpenSleep')}
        onClick={onOpen}
      >
        <span className={styles.cardHead}>
          <ParvaneIcon name="moon" isSmall className={styles.sleepIcon} />
          <span className={buildClassName(kit.caps, kit.grow)}>{lang('HealthKindSleep')}</span>
          <ParvaneIcon name="right" isSmall />
        </span>
        <span className={styles.sleepPhoneBody}>
          <span className={styles.sleepPhoneText}>
            {renderNumber()}
            {hasClock && (
              <span className={kit.muted}>
                {lang('HealthSleepNight')}
                {' '}
                <span className={kit.mono}>{`${formatClock(last.bedMin!)} → ${formatClock(last.wakeMin!)}`}</span>
              </span>
            )}
            {renderDelta()}
          </span>
          <span className={styles.miniBars} aria-hidden>
            {nights.map((night, index) => (
              <span
                key={night.day}
                className={buildClassName(styles.miniBar, index === nights.length - 1 && styles.miniBarLast)}
                style={`height: ${((night.minutes || 0) / top) * 100}%`}
              />
            ))}
          </span>
        </span>
      </button>
    );
  }

  return (
    <section className={buildClassName(kit.card, styles.card)} data-health-card="sleep">
      <header className={styles.cardHead}>
        <ParvaneIcon name="moon" isSmall className={styles.sleepIcon} />
        <button
          type="button"
          className={buildClassName(kit.caps, kit.grow, styles.cardLink)}
          aria-label={lang('HealthOpenSleep')}
          onClick={onOpen}
        >
          {lang('HealthSleepWeek')}
        </button>
        {hasGoal && (
          <span className={buildClassName(kit.muted, kit.small)}>
            {lang('HealthGoalShort')}
            {' '}
            <span className={kit.mono}>{`${formatClock(goalBedMin)} → ${formatClock(goalWakeMin)}`}</span>
          </span>
        )}
      </header>
      <div className={styles.sleepLine}>
        {renderNumber()}
        {renderDelta()}
        {hasClock && (
          <span className={kit.muted}>
            {lang('HealthSleepBedAt')}
            {' '}
            <span className={kit.mono}>{formatClock(last.bedMin!)}</span>
            {` · ${lang('HealthSleepWakeAt')} `}
            <span className={kit.mono}>{formatClock(last.wakeMin!)}</span>
          </span>
        )}
      </div>
      <HealthRegimeChart days={week} goalBedMin={goalBedMin} goalWakeMin={goalWakeMin} />
      <HealthSleepButtons sleep={sleep} onBed={onBed} onWake={onWake} />
    </section>
  );
};

export default memo(HealthSleepCard);
