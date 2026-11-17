import { memo, useEffect, useState } from '../../../lib/teact/teact';

import type { HealthEntriesPage } from './healthStore';
import type { HealthEntry, HealthView } from './healthTypes';

import buildClassName from '../../../util/buildClassName';
import {
  buildSparkline, formatClock, formatDelta, formatNumber, formatValue, MOOD_KIND, parseClock,
} from './healthFormat';
import { loadHealthEntries, setHealthGoal } from './healthStore';
import useHealthLabels from './useHealthLabels';

import useLastCallback from '../../../hooks/useLastCallback';

import HealthEntries from './HealthEntries';
import HealthMoodScale from './HealthMoodScale';
import HealthSleepCard from './HealthSleepCard';

import kit from '../notes/PvKit.module.scss';
import styles from './Health.module.scss';

type OwnProps = {
  view: HealthView;
  // `sleep` либо вид показателя
  kind: string;
  onBed: NoneToVoidFunction;
  onWake: NoneToVoidFunction;
  onEdit: (entry: HealthEntry) => void;
  onNap: NoneToVoidFunction;
};

const CHART_WIDTH = 480;
const CHART_HEIGHT = 120;
const SLEEP_KINDS = ['sleep', 'sleep_start', 'sleep_end'];
const PAGE_SIZE = 30;

// Parvane (spec 038): подробный экран показателя либо сна — крупное значение, график за месяц, цель и записи.
// Цель правится на месте и сохраняется по выходу из поля; записи приходят из движка страницами
const HealthDetail = ({
  view, kind, onBed, onWake, onEdit, onNap,
}: OwnProps) => {
  const {
    lang, kindTitle, unitTitle,
  } = useHealthLabels(view.today);
  const isSleep = kind === 'sleep';
  const metric = view.metrics.find((item) => item.kind === kind);
  const unit = metric ? unitTitle(metric.unit) : '';

  // До ответа движка — записи вида из сводки; сводка сменилась — страница перечитывается
  const [limit, setLimit] = useState(PAGE_SIZE);
  const [page, setPage] = useState<HealthEntriesPage & { kind: string }>();
  useEffect(() => {
    setLimit(PAGE_SIZE);
  }, [kind]);
  useEffect(() => {
    let isStale = false;
    void loadHealthEntries(kind, limit).then((loaded) => {
      if (loaded && !isStale) setPage({ ...loaded, kind });
    });
    return () => {
      isStale = true;
    };
  }, [kind, limit, view]);
  const entries = page?.kind === kind
    ? page.entries
    : view.recent.filter((entry) => (isSleep ? SLEEP_KINDS.includes(entry.kind) : entry.kind === kind));
  const hasMore = page?.kind === kind && page.hasMore;

  const handleMore = useLastCallback(() => setLimit(limit + PAGE_SIZE));

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
    const target = value ? parseClock(value) : undefined;
    if (target !== goalBedMin) void setHealthGoal('sleep_bed', target);
  });

  const handleWakeCommit = useLastCallback((e: React.FocusEvent<HTMLInputElement>) => {
    const { value } = e.currentTarget;
    const target = value ? parseClock(value) : undefined;
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
          <button
            type="button"
            className={buildClassName(kit.btn, styles.more)}
            data-health-action="nap"
            onClick={onNap}
          >
            {lang('HealthNapTitle')}
          </button>
        </>
      ) : (
        <>
          {kind === MOOD_KIND && <HealthMoodScale />}
          {(metric || kind !== MOOD_KIND) && renderMetric()}
        </>
      )}
      <div className={kit.caps}>{lang('HealthEntriesTitle')}</div>
      <HealthEntries entries={entries} today={view.today} onEdit={onEdit} />
      {hasMore && (
        <button type="button" className={buildClassName(kit.btn, styles.more)} data-health-more onClick={handleMore}>
          {lang('HealthEntriesMore')}
        </button>
      )}
    </div>
  );
};

export default memo(HealthDetail);
