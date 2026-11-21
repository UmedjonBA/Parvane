import { memo } from '../../../lib/teact/teact';

import type { HealthMetricView } from './healthTypes';

import buildClassName from '../../../util/buildClassName';
import {
  buildSparkline, formatDelta, formatNumber, formatValue, KIND_COLORS,
} from './healthFormat';
import useHealthLabels from './useHealthLabels';

import useLastCallback from '../../../hooks/useLastCallback';

import kit from '../notes/PvKit.module.scss';
import styles from './Health.module.scss';

type OwnProps = {
  metric: HealthMetricView;
  today: string;
  // Компьютер: плитка без графика, единица в подписи (доска `DeskHealth`)
  isCompact?: boolean;
  onOpen: (kind: string) => void;
};

const SPARK_WIDTH = 120;
const SPARK_HEIGHT = 24;

// Parvane (spec 038, 041; доски `Health`, `DeskHealth`): плитка показателя — последнее значение (у шагов и воды —
// итог дня), на телефоне ещё график за месяц цветом показателя и одна строка смысла: изменение за неделю, цель
// либо когда записано
const HealthMetricCard = ({
  metric, today, isCompact, onOpen,
}: OwnProps) => {
  const {
    lang, kindTitle, unitTitle, entryWhen, dayTitle,
  } = useHealthLabels(today);
  const { last, isSum, goal } = metric;
  const unit = unitTitle(metric.unit);
  const isPressure = metric.kind === 'pressure';

  const handleClick = useLastCallback(() => onOpen(metric.kind));

  function renderValue() {
    if (isSum) return formatNumber(metric.today ?? 0, lang.code);
    return last ? formatValue(last, lang.code) : '—';
  }

  function renderHint() {
    if (isSum && goal !== undefined) return lang('HealthGoalValue', { value: formatNumber(goal, lang.code) });
    if (!last) return lang('HealthNoEntries');
    if (isPressure) return entryWhen(last);
    if (isCompact) return [unit, dayTitle(last.day)].filter(Boolean).join(' · ');
    if (metric.weekDelta !== undefined && Math.abs(metric.weekDelta) >= 0.05) {
      return lang('HealthWeekDelta', { delta: `${formatDelta(metric.weekDelta, lang.code)} ${unit}`.trim() });
    }
    return entryWhen(last);
  }

  const values = metric.series.map((point) => point.value);
  const lower = isPressure ? metric.series.map((point) => point.value2) : [];
  // Обе линии давления — на общей шкале
  const scale = (list: number[]) => buildSparkline(list, SPARK_WIDTH, SPARK_HEIGHT, 2, [...values, ...lower]);

  return (
    <button
      type="button"
      className={buildClassName(kit.card, styles.metric, isCompact && styles.metricCompact)}
      style={`--health-color: var(--pv-${KIND_COLORS[metric.kind] || 'accent'})`}
      data-health-card={metric.kind}
      onClick={handleClick}
    >
      <span className={kit.muted}>{kindTitle(metric.kind)}</span>
      <span>
        <span className={buildClassName(kit.mono, styles.metricValue)} data-health-value>{renderValue()}</span>
        {!isCompact && Boolean(unit) && !isPressure && <span className={kit.muted}>{` ${unit}`}</span>}
      </span>
      {!isCompact && (
        <svg className={styles.spark} viewBox={`0 0 ${SPARK_WIDTH} ${SPARK_HEIGHT}`} aria-hidden>
          {values.length > 1 && <polyline className={styles.sparkLine} points={scale(values)} />}
          {lower.length > 1 && <polyline className={styles.sparkLine} points={scale(lower)} />}
        </svg>
      )}
      <span className={buildClassName(kit.muted, kit.small)}>{renderHint()}</span>
    </button>
  );
};

export default memo(HealthMetricCard);
