import { memo, useEffect, useState } from '../../../lib/teact/teact';

import type { HealthView } from './healthTypes';

import buildClassName from '../../../util/buildClassName';
import {
  buildSparkline, formatClock, formatDelta, formatNumber, formatValue,
} from './healthFormat';
import { setHealthGoal } from './healthStore';

import useLastCallback from '../../../hooks/useLastCallback';
import useHealthLabels from './useHealthLabels';

import HealthEntries from './HealthEntries';
import HealthSleepCard from './HealthSleepCard';

import kit from '../notes/PvKit.module.scss';
import styles from './Health.module.scss';

type OwnProps = {
  view: HealthView;
  // `sleep` либо вид показателя
  kind: string;
  onBed: NoneToVoidFunction;
  onWake: NoneToVoidFunction;
};

const CHART_WIDTH = 480;
const CHART_HEIGHT = 120;
const MINUTES_IN_HOUR = 60;
const SLEEP_KINDS = ['sleep', 'sleep_start', 'sleep_end'];

function clockToMinutes(value: string) {
  const [hours, minutes] = value.split(':').map(Number);
  return Number.isFinite(hours) && Number.isFinite(minutes) ? hours * MINUTES_IN_HOUR + minutes : undefined;
}

// Parvane (spec 038): подробный экран показателя либо сна — крупное значение, график за месяц, цель и записи.
// Цель правится на месте и сохраняется по выходу из поля
const HealthDetail = ({
  view, kind, onBed, onWake,
}: OwnProps) => {
  const {
    lang, kindTitle, unitTitle,
  } = useHealthLabels(view.today);
  const isSleep = kind === 'sleep';
  const metric = view.metrics.find((item) => item.kind === kind);
  const unit = metric ? unitTitle(metric.unit) : '';
  const entries = view.recent.filter((entry) => (isSleep ? SLEEP_KINDS.includes(entry.kind) : entry.kind === kind));

  const [goalText, setGoalText] = useState('');
  const [bedText, setBedText] = useState('');
  const [wakeText, setWakeText] = useState('');
  const savedGoal = metric?.goal;
  const { goalBedMin, goalWakeMin } = view.sleep;
  useEffect(() => {
    setGoalText(savedGoal === undefined ? '' : String(savedGoal));
  }, [savedGoal, kind]);
  useEffect(() => {
    setBedText(goalBedMin === undefined ? '' : formatClock(goalBedMin));
    setWakeText(goalWakeMin === undefined ? '' : formatClock(goalWakeMin));
  }, [goalBedMin, goalWakeMin]);

  const handleGoalChange = useLastCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    setGoalText(e.currentTarget.value);
  });
  const handleBedChange = useLastCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    setBedText(e.currentTarget.value);
  });
  const handleWakeChange = useLastCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    setWakeText(e.currentTarget.value);
  });

  // Значение берётся из самого поля: выход из поля может прийти раньше перерисовки после ввода
  const handleGoalCommit = useLastCallback((e: React.FocusEvent<HTMLInputElement>) => {
    const text = e.currentTarget.value.trim().replace(',', '.');
    const target = text ? Number(text) : undefined;
    if (target !== undefined && (!Number.isFinite(target) || target <= 0)) {
      setGoalText(savedGoal === undefined ? '' : String(savedGoal));
      return;
    }
    if (target !== savedGoal) void setHealthGoal(kind, target);
  });

  const handleBedCommit = useLastCallback((e: React.FocusEvent<HTMLInputElement>) => {
    const { value } = e.currentTarget;
    const target = value ? clockToMinutes(value) : undefined;
    if (target !== goalBedMin) void setHealthGoal('sleep_bed', target);
  });

  const handleWakeCommit = useLastCallback((e: React.FocusEvent<HTMLInputElement>) => {
    const { value } = e.currentTarget;
    const target = value ? clockToMinutes(value) : undefined;
    if (target !== goalWakeMin) void setHealthGoal('sleep_wake', target);
  });

  function renderMetric() {
    if (!metric) return <div className={kit.muted}>{lang('HealthNoEntries')}</div>;
    const { last, isSum } = metric;
    const value = isSum ? formatNumber(metric.today ?? 0, lang.code) : last ? formatValue(last, lang.code) : '—';
    const points = buildSparkline(metric.series.map((point) => point.value), CHART_WIDTH, CHART_HEIGHT, 6);
    return (
      <section className={buildClassName(kit.card, styles.card)} data-health-card={kind}>
        <div className={styles.sleepLine}>
          <span className={buildClassName(kit.mono, styles.big)} data-health-value>{value}</span>
          {Boolean(unit) && kind !== 'pressure' && <span className={kit.muted}>{unit}</span>}
          {metric.toGoal !== undefined && (
            <span className={kit.muted} data-health-to-goal>
              {lang(isSum ? 'HealthLeftToGoal' : 'HealthToGoal', {
                delta: isSum
                  ? formatNumber(Math.max(0, metric.toGoal), lang.code) : formatDelta(metric.toGoal, lang.code),
              })}
            </span>
          )}
        </div>
        {!isSum && (metric.weekDelta !== undefined || metric.monthDelta !== undefined) && (
          <div className={buildClassName(kit.muted, kit.small)}>
            {metric.weekDelta !== undefined
              && lang('HealthWeekDelta', { delta: formatDelta(metric.weekDelta, lang.code) })}
            {metric.weekDelta !== undefined && metric.monthDelta !== undefined && ' · '}
            {metric.monthDelta !== undefined
              && lang('HealthMonthDelta', { delta: formatDelta(metric.monthDelta, lang.code) })}
          </div>
        )}
        <svg
          className={styles.chart}
          viewBox={`0 0 ${CHART_WIDTH} ${CHART_HEIGHT}`}
          role="img"
          aria-label={lang('HealthChartMonth')}
        >
          {metric.series.length > 1 && <polyline className={styles.sparkLine} points={points} />}
        </svg>
        <label className={styles.goal}>
          <span className={kit.muted}>{lang('HealthGoalLabel')}</span>
          <input
            className={buildClassName(kit.input, styles.goalInput)}
            type="text"
            inputMode="decimal"
            value={goalText}
            placeholder={lang('HealthGoalNone')}
            data-health-goal={kind}
            onChange={handleGoalChange}
            onBlur={handleGoalCommit}
          />
          {Boolean(unit) && <span className={kit.muted}>{unit}</span>}
        </label>
      </section>
    );
  }

  return (
    <div className={styles.detail} data-health-detail={kind}>
      <h2 className={styles.detailTitle}>{kindTitle(kind)}</h2>
      {isSleep ? (
        <>
          <HealthSleepCard sleep={view.sleep} today={view.today} isDetail onBed={onBed} onWake={onWake} />
          <section className={buildClassName(kit.card, styles.card)}>
            <div className={kit.caps}>{lang('HealthSleepGoal')}</div>
            <div className={styles.goalRow}>
              <label className={styles.goal}>
                <span className={kit.muted}>{lang('HealthSleepGoalBed')}</span>
                <input
                  className={buildClassName(kit.input, styles.goalInput)}
                  type="time"
                  value={bedText}
                  data-health-goal="sleep_bed"
                  onChange={handleBedChange}
                  onBlur={handleBedCommit}
                />
              </label>
              <label className={styles.goal}>
                <span className={kit.muted}>{lang('HealthSleepGoalWake')}</span>
                <input
                  className={buildClassName(kit.input, styles.goalInput)}
                  type="time"
                  value={wakeText}
                  data-health-goal="sleep_wake"
                  onChange={handleWakeChange}
                  onBlur={handleWakeCommit}
                />
              </label>
            </div>
          </section>
        </>
      ) : renderMetric()}
      <div className={kit.caps}>{lang('HealthEntriesTitle')}</div>
      <HealthEntries entries={entries} today={view.today} />
    </div>
  );
};

export default memo(HealthDetail);
