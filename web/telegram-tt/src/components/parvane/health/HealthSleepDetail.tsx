import { memo } from '../../../lib/teact/teact';

import type { HealthGoalTarget } from './HealthGoalSheet';
import type { HealthPeriod } from './healthPeriods';
import type { HealthEntry, HealthView } from './healthTypes';

import buildClassName from '../../../util/buildClassName';
import { formatClock } from './healthFormat';
import { sleepDays } from './healthPeriods';
import useHealthLabels from './useHealthLabels';

import useLastCallback from '../../../hooks/useLastCallback';

import ParvaneIcon from '../../main/ParvaneIcon';
import HealthEntries from './HealthEntries';
import HealthPeriodChart from './HealthPeriodChart';
import HealthQuickInput from './HealthQuickInput';
import HealthRegimeChart from './HealthRegimeChart';
import HealthSleepButtons from './HealthSleepButtons';

import kit from '../notes/PvKit.module.scss';
import styles from './Health.module.scss';

type OwnProps = {
  view: HealthView;
  period: HealthPeriod;
  isWide?: boolean;
  entries: HealthEntry[];
  onEdit: (entry: HealthEntry) => void;
  onGoal: (target: HealthGoalTarget) => void;
  onBed: NoneToVoidFunction;
  onWake: NoneToVoidFunction;
  onNap: NoneToVoidFunction;
};

// Parvane (spec 041; доски `HealthSleep`, `DeskHealthDetail`): подробный экран сна — прошлая ночь и отклонение от
// цели, средние отбой и подъём за период, режим «лёг → встал» по дням с целью и шкалой, вывод о режиме, цель,
// «Ложусь / Встал / Другое», записи ночей с отклонением. Все расчёты — движок (`sleep.stats`)
const HealthSleepDetail = ({
  view, period, isWide, entries, onEdit, onGoal, onBed, onWake, onNap,
}: OwnProps) => {
  const { lang, duration, shortDuration } = useHealthLabels(view.today);
  const { sleep } = view;
  const {
    last, lastTotalMinutes, lastDeltaMinutes, goalBedMin, goalWakeMin, goalMinutes, stats,
  } = sleep;
  const periodStats = stats.periods[period];
  const hasGoal = goalBedMin !== undefined && goalWakeMin !== undefined;

  const handleGoal = useLastCallback(() => {
    onGoal({
      kind: 'sleep', title: lang('HealthSleepGoal'), bedMin: goalBedMin, wakeMin: goalWakeMin,
    });
  });

  function signedMinutes(minutes: number) {
    return `${minutes < 0 ? '−' : minutes > 0 ? '+' : ''}${shortDuration(minutes)}`;
  }

  function renderDelta() {
    if (lastDeltaMinutes === undefined) return undefined;
    if (!lastDeltaMinutes) return <span className={styles.good}>{lang('HealthSleepOnGoal')}</span>;
    return (
      <span className={lastDeltaMinutes < 0 ? styles.warn : styles.good} data-health-sleep-delta>
        {lang('HealthSleepFromGoal', { value: signedMinutes(lastDeltaMinutes) })}
      </span>
    );
  }

  function renderInsight() {
    const bed = periodStats.avgBedMin;
    if (bed === undefined) return undefined;
    const time = formatClock(bed);
    const bedDelta = periodStats.bedDeltaMin;
    const bedText = bedDelta === undefined ? lang('HealthSleepInsightNoGoal', { time })
      : !bedDelta ? lang('HealthSleepInsightOnGoal', { time })
        : lang(bedDelta > 0 ? 'HealthSleepInsightLater' : 'HealthSleepInsightEarlier', {
          time, duration: shortDuration(bedDelta),
        });
    const wakeText = stats.regime.isWakeStable ? lang('HealthSleepWakeStable') : '';
    return (
      <div className={buildClassName(kit.muted, kit.small)} data-health-sleep-insight>
        {`${bedText} ${wakeText}`.trim()}
      </div>
    );
  }

  function renderGoalText() {
    if (!hasGoal) return lang('HealthGoalNone');
    const range = `${formatClock(goalBedMin)} → ${formatClock(goalWakeMin)}`;
    if (isWide) {
      return lang('HealthSleepGoalText', {
        bed: formatClock(goalBedMin), wake: formatClock(goalWakeMin), duration: shortDuration(goalMinutes ?? 0),
      });
    }
    return `${range} · ${duration(goalMinutes ?? 0)}`;
  }

  function renderChart() {
    if (period === 'year') return <HealthPeriodChart sleep={sleep} period={period} today={view.today} />;
    return (
      <HealthRegimeChart
        days={sleepDays(sleep, period)}
        goalBedMin={goalBedMin}
        goalWakeMin={goalWakeMin}
        withClock={isWide}
        isMonth={period === 'month'}
      />
    );
  }

  function renderRegimeCard() {
    return (
      <section className={buildClassName(kit.card, styles.card)} data-health-chart={period}>
        <div className={styles.cardHead}>
          <span className={buildClassName(kit.caps, kit.grow)}>
            {lang(isWide ? 'HealthSleepRegimeTitle'
              : period === 'month' ? 'HealthSleepRegimeMonth' : 'HealthSleepRegimeWeek')}
          </span>
          {hasGoal && period !== 'year' && (
            <span className={buildClassName(kit.muted, kit.small, styles.legend)}>
              <span className={styles.legendGoal} />
              {isWide ? `${lang('HealthGoalShort')} ${formatClock(goalBedMin)} → ${formatClock(goalWakeMin)}`
                : lang('HealthGoalShort')}
            </span>
          )}
        </div>
        {renderChart()}
        {!isWide && renderInsight()}
      </section>
    );
  }

  const records = <HealthEntries entries={entries} today={view.today} isWide={isWide} onEdit={onEdit} />;

  if (isWide) {
    const tiles = [
      {
        id: 'last', title: lang('HealthSleepLastNight'), value: last ? duration(lastTotalMinutes ?? last.minutes) : '—',
      },
      {
        id: 'delta',
        title: lang('HealthSleepDeviation'),
        value: lastDeltaMinutes !== undefined ? signedMinutes(lastDeltaMinutes) : '—',
        tone: lastDeltaMinutes !== undefined && lastDeltaMinutes < 0 ? styles.warn : undefined,
      },
      {
        id: 'bed',
        title: lang('HealthSleepAvgBed'),
        value: periodStats.avgBedMin !== undefined ? formatClock(periodStats.avgBedMin) : '—',
      },
      {
        id: 'wake',
        title: lang('HealthSleepAvgWake'),
        value: periodStats.avgWakeMin !== undefined ? formatClock(periodStats.avgWakeMin) : '—',
      },
    ];
    return (
      <div className={styles.detailWide} data-health-card="sleep">
        <div className={styles.tiles}>
          {tiles.map((tile) => (
            <div key={tile.id} className={buildClassName(kit.card, styles.tile)} data-health-tile={tile.id}>
              <span className={buildClassName(kit.muted, kit.small)}>{tile.title}</span>
              <span
                className={buildClassName(kit.mono, styles.metricValue, tile.tone)}
                data-health-sleep-total={tile.id === 'last' ? '' : undefined}
              >
                {tile.value}
              </span>
            </div>
          ))}
        </div>
        {renderRegimeCard()}
        <div className={styles.detailPair}>
          <section className={buildClassName(kit.card, styles.card)}>
            <div className={kit.caps}>{lang('HealthEntriesTitle')}</div>
            {records}
          </section>
          <section className={buildClassName(kit.card, styles.card)} data-health-goal-card="sleep">
            <div className={kit.caps}>{lang('HealthGoalLabel')}</div>
            <div data-health-goal-text>{renderGoalText()}</div>
            <button
              type="button"
              className={buildClassName(kit.btn, kit.btnWide)}
              data-health-goal-edit="sleep"
              onClick={handleGoal}
            >
              {lang('HealthGoalChange')}
            </button>
            <HealthSleepButtons sleep={sleep} onBed={onBed} onWake={onWake} onOther={onNap} />
            <span className={kit.grow} />
            <div className={buildClassName(kit.muted, kit.small)}>{lang('HealthQuickLine')}</div>
            <HealthQuickInput isCompact placeholder={lang('HealthLineSleep')} />
          </section>
        </div>
      </div>
    );
  }

  return (
    <div className={styles.detail} data-health-card="sleep">
      <div className={styles.detailHead}>
        <span className={styles.detailMain}>
          <span className={buildClassName(kit.muted, kit.small)}>{lang('HealthSleepLastNight')}</span>
          <span className={buildClassName(kit.mono, styles.big)} data-health-sleep-total>
            {last ? duration(lastTotalMinutes ?? last.minutes) : '—'}
          </span>
        </span>
        <span className={styles.detailSide}>
          {renderDelta()}
          {stats.lastBedDeltaMin !== undefined && Boolean(stats.lastBedDeltaMin) && (
            <span className={kit.muted} data-health-bed-delta>
              {lang(stats.lastBedDeltaMin > 0 ? 'HealthSleepBedLater' : 'HealthSleepBedEarlier', {
                duration: shortDuration(stats.lastBedDeltaMin),
              })}
            </span>
          )}
        </span>
      </div>
      {renderRegimeCard()}
      <section className={buildClassName(kit.card, styles.card)} data-health-goal-card="sleep">
        <div className={styles.cardHead}>
          <span className={buildClassName(kit.muted, kit.grow)}>{lang('HealthGoalLabel')}</span>
          <button
            type="button"
            className={kit.ib}
            aria-label={lang('HealthGoalChange')}
            data-health-goal-edit="sleep"
            onClick={handleGoal}
          >
            <ParvaneIcon name="pen" isSmall />
          </button>
        </div>
        <div className={kit.mono} data-health-goal-text>{renderGoalText()}</div>
      </section>
      <HealthSleepButtons sleep={sleep} onBed={onBed} onWake={onWake} onOther={onNap} />
      <div className={kit.caps}>{lang('HealthEntriesTitle')}</div>
      {records}
    </div>
  );
};

export default memo(HealthSleepDetail);
