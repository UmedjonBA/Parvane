import { memo } from '../../../lib/teact/teact';

import type { HealthPeriod } from './healthPeriods';
import type { HealthMetricView, HealthSleepView } from './healthTypes';

import buildClassName from '../../../util/buildClassName';
import { formatDate } from '../planner/plannerFormat';
import { formatNumber, KIND_COLORS, WEEKDAY_KEYS } from './healthFormat';
import { chartSlots, PERIOD_KEYS } from './healthPeriods';

import useLang from '../../../hooks/useLang';

import styles from './Health.module.scss';

type OwnProps = {
  // Показатель либо сон (у сна здесь только год: неделю и месяц рисует режим)
  metric?: HealthMetricView;
  sleep?: HealthSleepView;
  period: HealthPeriod;
  today: string;
};

const WIDTH = 480;
const HEIGHT = 140;
const PAD_LEFT = 30;
const PAD_RIGHT = 8;
const PAD_Y = 10;
const RANGE_KINDS = ['pressure'];
// Пульс за неделю — столбиками по дням (доска `RpHealth`), за месяц — линией
const WEEK_BAR_KINDS = ['pulse'];
const DATE_SHORT = { day: 'numeric', month: 'short' } as const;
const MONTH_SHORT = { month: 'short' } as const;

// Parvane (spec 041; доски `HealthWeight`, `RpHealth`, `XpHealth`, `DeskHealthDetail`, `RdHealth`): график
// подробного экрана за выбранный период. Линия — с осью значений, пунктиром цели и точкой последнего значения;
// суммы — столбиками с целью (сегодня выделен, дни с целью — зелёным); давление — столбиками «нижнее–верхнее».
// Значения и выполнение цели — из движка; здесь только раскладка
const HealthPeriodChart = ({
  metric, sleep, period, today,
}: OwnProps) => {
  const lang = useLang();
  const kind = metric?.kind || 'sleep';
  const slots = chartSlots({ metric, sleep }, period, today);
  const known = slots.filter((slot) => slot.value !== undefined);
  const goal = metric?.goal;
  const isRange = RANGE_KINDS.includes(kind);
  const isBars = !isRange && (Boolean(sleep) || Boolean(metric?.isSum) || period === 'year'
    || (period === 'week' && WEEK_BAR_KINDS.includes(kind)));
  const color = `--health-color: var(--pv-${KIND_COLORS[kind] || 'accent'})`;

  function slotLabel(index: number) {
    const slot = slots[index];
    if (period === 'year') {
      const isEdge = index === 0 || index === slots.length - 1;
      return isEdge ? formatDate(lang.code, new Date(`${slot.key}-15T12:00:00`), MONTH_SHORT) : '';
    }
    if (period === 'week') return lang(WEEKDAY_KEYS[slot.weekday]);
    const isShown = index === 0 || index === slots.length - 1 || index === Math.floor(slots.length / 2);
    return isShown ? formatDate(lang.code, new Date(`${slot.key}T12:00:00`), DATE_SHORT) : '';
  }

  function renderBars() {
    const top = Math.max(goal || 0, ...known.map((slot) => slot.value!)) || 1;
    return (
      <div className={styles.chartBars}>
        <div className={styles.bars}>
          {goal !== undefined && <span className={styles.goalLine} style={`--goal-share: ${goal / top}`} />}
          {slots.map((slot, index) => (
            <span key={slot.key} className={styles.barColumn} data-day={slot.key}>
              <span className={styles.barTrack}>
                {slot.value !== undefined && (
                  <span
                    className={buildClassName(
                      styles.bar,
                      styles.barFull,
                      slot.key === today && styles.barToday,
                      slot.goalMet && styles.barMet,
                    )}
                    style={`height: ${(slot.value / top) * 100}%`}
                  />
                )}
              </span>
              <span className={styles.barLabel}>{slotLabel(index)}</span>
            </span>
          ))}
        </div>
      </div>
    );
  }

  function renderRange() {
    const values = known.flatMap((slot) => [slot.value!, slot.value2 || slot.value!]);
    const low = Math.floor(Math.min(...values, goal ?? Infinity) / 20) * 20 - 20;
    const high = Math.ceil(Math.max(...values, goal ?? -Infinity) / 20) * 20 + 20;
    const share = (value: number) => (value - low) / (high - low);
    return (
      <div className={styles.chartRange}>
        <div className={styles.axisY}>
          {[high, (high + low) / 2, low].map((tick) => <span key={tick}>{formatNumber(tick, lang.code)}</span>)}
        </div>
        <div className={styles.bars}>
          {goal !== undefined && <span className={styles.goalLine} style={`--goal-share: ${share(goal)}`} />}
          {slots.map((slot, index) => (
            <span key={slot.key} className={styles.barColumn} data-day={slot.key}>
              <span className={styles.barTrack}>
                {slot.value !== undefined && (
                  <span
                    className={buildClassName(styles.rangeBar, slot.goalMet === false && styles.barOver)}
                    style={`bottom: ${share(slot.value2 || slot.value) * 100}%; `
                      + `height: ${Math.max(1, (share(slot.value) - share(slot.value2 || slot.value)) * 100)}%`}
                  />
                )}
              </span>
              <span className={styles.barLabel}>{slotLabel(index)}</span>
            </span>
          ))}
        </div>
      </div>
    );
  }

  function renderLine() {
    const values = known.map((slot) => slot.value!);
    const low = Math.min(...values, goal ?? Infinity);
    const high = Math.max(...values, goal ?? -Infinity);
    const spread = high - low || 1;
    const x = (index: number) => PAD_LEFT + ((WIDTH - PAD_LEFT - PAD_RIGHT) * index) / Math.max(1, slots.length - 1);
    const y = (value: number) => PAD_Y + (HEIGHT - PAD_Y * 2) * (1 - (value - low) / spread);
    const points = slots
      .map((slot, index) => (
        slot.value === undefined ? undefined : `${x(index).toFixed(1)},${y(slot.value).toFixed(1)}`
      ))
      .filter(Boolean)
      .join(' ');
    const lastIndex = slots.map((slot) => slot.value !== undefined).lastIndexOf(true);
    const ticks = [high, (high + low) / 2, low];
    return (
      <>
        <svg
          className={styles.chart}
          viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
          role="img"
          aria-label={lang(PERIOD_KEYS[period])}
        >
          {ticks.map((tick) => (
            <g key={tick}>
              <line className={styles.chartGrid} x1={PAD_LEFT} x2={WIDTH - PAD_RIGHT} y1={y(tick)} y2={y(tick)} />
              <text className={styles.chartTick} x={0} y={y(tick) + 4}>{formatNumber(tick, lang.code)}</text>
            </g>
          ))}
          {goal !== undefined && (
            <g data-health-chart-goal>
              <line className={styles.chartGoal} x1={PAD_LEFT} x2={WIDTH - PAD_RIGHT} y1={y(goal)} y2={y(goal)} />
              <text className={styles.chartTick} x={PAD_LEFT + 4} y={y(goal) - 4}>{lang('HealthGoalShort')}</text>
            </g>
          )}
          {known.length > 1 && <polyline className={styles.sparkLine} points={points} />}
          {lastIndex >= 0 && (
            <circle className={styles.chartDot} cx={x(lastIndex)} cy={y(slots[lastIndex].value!)} r={4} />
          )}
        </svg>
        <div className={styles.chartDates}>
          <span>{slotLabel(0)}</span>
          <span>{slotLabel(slots.length - 1)}</span>
        </div>
      </>
    );
  }

  return (
    <div
      className={styles.periodChart}
      style={color}
      data-health-chart={period}
      data-health-chart-points={known.length}
    >
      {!known.length ? <div className={styles.chartEmpty}>{lang('HealthNoEntries')}</div>
        : isRange ? renderRange() : isBars ? renderBars() : renderLine()}
      {isRange && <div className={styles.chartCaption}>{lang('HealthPressureChartHint')}</div>}
    </div>
  );
};

export default memo(HealthPeriodChart);
