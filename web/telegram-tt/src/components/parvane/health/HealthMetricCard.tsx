import { memo } from '../../../lib/teact/teact';

import type { HealthMetricView } from './healthTypes';

import buildClassName from '../../../util/buildClassName';
import {
  buildSparkline, formatDelta, formatNumber, formatValue,
} from './healthFormat';
import useHealthLabels from './useHealthLabels';

import useLastCallback from '../../../hooks/useLastCallback';

import kit from '../notes/PvKit.module.scss';
import styles from './Health.module.scss';

type OwnProps = {
  metric: HealthMetricView;
  today: string;
  onOpen: (kind: string) => void;
};

const SPARK_WIDTH = 120;
const SPARK_HEIGHT = 24;

// Parvane (spec 038): плитка показателя — последнее значение (у шагов и воды — итог дня), график за месяц
// и одна строка смысла: изменение за неделю, остаток до цели либо когда записано
const HealthMetricCard = ({ metric, today, onOpen }: OwnProps) => {
  const {
    lang, kindTitle, unitTitle, entryWhen,
  } = useHealthLabels(today);
  const { last, isSum, goal } = metric;
  const unit = unitTitle(metric.unit);

  const handleClick = useLastCallback(() => onOpen(metric.kind));

  function renderValue() {
    if (isSum) return formatNumber(metric.today ?? 0, lang.code);
    return last ? formatValue(last, lang.code) : '—';
  }

  function renderHint() {
    if (isSum && goal !== undefined) return lang('HealthGoalValue', { value: formatNumber(goal, lang.code) });
    if (metric.weekDelta !== undefined && Math.abs(metric.weekDelta) >= 0.05) {
      return lang('HealthWeekDelta', { delta: `${formatDelta(metric.weekDelta, lang.code)} ${unit}`.trim() });
    }
    return last ? entryWhen(last) : lang('HealthNoEntries');
  }

  const points = buildSparkline(metric.series.map((point) => point.value), SPARK_WIDTH, SPARK_HEIGHT);

  return (
    <button
      type="button"
      className={buildClassName(kit.card, styles.metric)}
      data-health-card={metric.kind}
      onClick={handleClick}
    >
      <span className={kit.muted}>{kindTitle(metric.kind)}</span>
      <span>
        <span className={buildClassName(kit.mono, styles.metricValue)} data-health-value>{renderValue()}</span>
        {Boolean(unit) && metric.kind !== 'pressure' && <span className={kit.muted}>{` ${unit}`}</span>}
      </span>
      <svg className={styles.spark} viewBox={`0 0 ${SPARK_WIDTH} ${SPARK_HEIGHT}`} aria-hidden>
        {metric.series.length > 1 && <polyline className={styles.sparkLine} points={points} />}
      </svg>
      <span className={buildClassName(kit.muted, kit.small)}>{renderHint()}</span>
    </button>
  );
};

export default memo(HealthMetricCard);
