import { memo, useState } from '../../../lib/teact/teact';

import type { PlannerGoalMetric, PlannerState } from './plannerModel';

import buildClassName from '../../../util/buildClassName';
import {
  formatDay, formatDayLong, formatHours, formatMonth, formatNumber, formatProject,
} from './plannerFormat';
import {
  EVENTS_GROUP, fromDayKey, getMonthKeys, getNutrientGoal, getNutrientStatistics, getNutrientTotal,
  getTimeStatistics, isKnownNumber, PLANNER_GOAL_METRICS,
} from './plannerModel';

import useLang from '../../../hooks/useLang';
import useLastCallback from '../../../hooks/useLastCallback';

import Button from '../../ui/Button';
import Select from '../../ui/Select';
import TabList from '../../ui/TabList';
import PlannerField from './PlannerField';
import PlannerGoals from './PlannerGoals';
import { formatFoodStatus, formatMetric, formatMetricUnit } from './PlannerNutrition';

import styles from './Planner.module.scss';

type OwnProps = {
  state: PlannerState;
  month: Date;
  picked: string;
  today: string;
  onPickDay: (day: string) => void;
  onOpenFoodDay: (day: string) => void;
};

const CHART_LABEL_INDEXES = new Set([0, 7, 14, 21]);
const KCAL_AXIS_STEP = 500;
const MACRO_AXIS_STEP = 50;
const WATER_AXIS_STEP = 500;

// Статистика за месяц или день: время по спискам и питание по целям
const PlannerStatistics = ({
  state, month, picked, today, onPickDay, onOpenFoodDay,
}: OwnProps) => {
  const lang = useLang();

  const [content, setContent] = useState(0);
  const [isDayPeriod, setIsDayPeriod] = useState(false);
  const [hidden, setHidden] = useState<ReadonlySet<string>>(() => new Set());
  const [chartMetric, setChartMetric] = useState<PlannerGoalMetric>('kcal');

  const days = isDayPeriod ? [picked] : getMonthKeys(month);

  const handleMonthPeriod = useLastCallback(() => setIsDayPeriod(false));
  const handleDayPeriod = useLastCallback(() => setIsDayPeriod(true));

  const handleGroupToggle = useLastCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const next = new Set(hidden);
    if (e.currentTarget.checked) next.delete(e.currentTarget.value);
    else next.add(e.currentTarget.value);
    setHidden(next);
  });

  const handleChartMetric = useLastCallback((e: React.ChangeEvent<HTMLSelectElement>) => {
    setChartMetric(e.currentTarget.value as PlannerGoalMetric);
  });

  const handleHistoryClick = useLastCallback((e: React.MouseEvent<HTMLButtonElement>) => {
    onOpenFoodDay(e.currentTarget.dataset.day!);
  });

  const handleOpenPicked = useLastCallback(() => {
    onOpenFoodDay(picked);
  });

  const tabs = [{ title: lang('PlannerStatTime') }, { title: lang('PlannerStatNutrition') }];

  return (
    <div className={styles.statistics}>
      <div className={styles.statHead}>
        <TabList tabs={tabs} activeTab={content} onSwitchTab={setContent} />
        <div className={styles.actions}>
          <Button size="smaller" color={isDayPeriod ? 'translucent' : 'primary'} onClick={handleMonthPeriod}>
            {lang('PlannerPeriodMonth')}
          </Button>
          <Button size="smaller" color={isDayPeriod ? 'primary' : 'translucent'} onClick={handleDayPeriod}>
            {lang('PlannerPeriodDay')}
          </Button>
          {isDayPeriod && (
            <PlannerField label={lang('PlannerFieldDate')} type="date" value={picked} onCommit={onPickDay} />
          )}
        </div>
      </div>
      <p className={styles.summary}>{isDayPeriod ? formatDayLong(lang, picked) : formatMonth(lang, month)}</p>
      {content === 0 ? renderTime() : renderNutrition()}
    </div>
  );

  function renderTime() {
    const stat = getTimeStatistics(state, days, hidden);
    const stops: string[] = [];
    let angle = 0;
    stat.rows.forEach((row) => {
      if (hidden.has(row.name) || !stat.total) return;
      const share = (row.minutes / stat.total) * 100;
      stops.push(`var(--planner-series-${row.colorIndex + 1}) ${angle}% ${angle + share}%`);
      angle += share;
    });

    return (
      <div className={styles.timeStat}>
        <div
          className={styles.donut}
          style={stops.length ? `background: conic-gradient(${stops.join(',')})` : undefined}
          role="img"
          aria-label={lang('PlannerAriaTimeTotal', { hours: formatHours(lang, stat.total) })}
        >
          <span className={styles.donutTotal}>{formatHours(lang, stat.total)}</span>
        </div>
        <div className={styles.legend}>
          {stat.rows.map((row) => {
            const isShown = !hidden.has(row.name);
            const share = isShown && stat.total ? Math.round((row.minutes / stat.total) * 100) : 0;
            const title = row.name === EVENTS_GROUP ? lang('PlannerGroupEvents') : formatProject(lang, row.name);
            return (
              <label
                key={row.name}
                className={styles.legendRow}
                style={`--planner-series: var(--planner-series-${row.colorIndex + 1})`}
              >
                <input
                  type="checkbox"
                  value={row.name}
                  checked={isShown}
                  aria-label={lang('PlannerAriaShowGroup', { name: title })}
                  onChange={handleGroupToggle}
                />
                <span className={styles.legendDot} />
                <span className={styles.taskName}>{title}</span>
                <span>{formatHours(lang, row.minutes)}</span>
                <small className={styles.small}>{`${share}%`}</small>
              </label>
            );
          })}
          {!stat.rows.length && <p className={styles.small}>{lang('PlannerStatTimeEmpty')}</p>}
          <p className={styles.small}>
            {lang('PlannerStatTimeNote')}
            {stat.unrated ? ` ${lang('PlannerStatTimeUnrated', { count: stat.unrated })}` : ''}
          </p>
        </div>
      </div>
    );
  }

  function renderNutrition() {
    const kcal = getNutrientStatistics(state, days, 'kcal', today);
    // Линия цели на графике — по цели выбранного дня (или сегодняшнего для месяца)
    const goal = getNutrientGoal(state, isDayPeriod ? picked : today, chartMetric);
    const maximum = Math.max(
      goal ? goal.target + goal.tolerance : 0, ...days.map((day) => getNutrientTotal(state, day, chartMetric).value), 1,
    );
    const step = chartMetric === 'kcal' ? KCAL_AXIS_STEP : chartMetric === 'water' ? WATER_AXIS_STEP : MACRO_AXIS_STEP;
    const ceiling = Math.ceil(maximum / step) * step;
    const fiberDays = days.filter((day) => {
      const total = getNutrientTotal(state, day, 'fiber');
      return day <= today && state.nutrition[day]?.isComplete && total.count && !total.missing;
    });
    const waterDays = days
      .filter((day) => day <= today && state.nutrition[day]?.isComplete && isKnownNumber(state.nutrition[day].waterMl));

    return (
      <div className={styles.foodStat}>
        <div className={styles.foodTotal}>
          {formatNumber(lang, kcal.sum)}
          <small className={styles.small}>{` ${lang('PlannerStatKcalLogged')}`}</small>
        </div>
        <p className={styles.small}>
          {kcal.complete.length
            ? lang('PlannerStatDays', {
              complete: kcal.complete.length, open: kcal.recorded.length - kcal.complete.length,
            })
            : lang('PlannerStatNoCompleteDays')}
        </p>
        {!isDayPeriod && Boolean(kcal.complete.length) && (
          <p className={styles.small}>
            {lang('PlannerStatKcalGoal', {
              sum: formatNumber(lang, kcal.completeSum),
              low: formatNumber(lang, kcal.goalLow),
              high: formatNumber(lang, kcal.goalHigh),
            })}
          </p>
        )}
        <table className={styles.table}>
          <thead>
            <tr>
              <th>{lang('PlannerStatMetric')}</th>
              <th>{lang('PlannerStatAverage')}</th>
              <th>{lang('PlannerStatInGoal')}</th>
            </tr>
          </thead>
          <tbody>
            {PLANNER_GOAL_METRICS.map((metric) => {
              const stat = getNutrientStatistics(state, days, metric, today);
              return (
                <tr key={metric} data-metric={metric}>
                  <td>{formatMetric(lang, metric)}</td>
                  <td>
                    {stat.average === undefined
                      ? '—'
                      : `${formatNumber(lang, stat.average)} ${formatMetricUnit(lang, metric)}`}
                  </td>
                  <td>
                    {stat.withGoal.length
                      ? `${stat.inGoal} / ${stat.withGoal.length} · ${toPercent(stat.inGoal, stat.withGoal.length)}%`
                      : '—'}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <Select label={lang('PlannerStatChartMetric')} value={chartMetric} hasArrow onChange={handleChartMetric}>
          {PLANNER_GOAL_METRICS.map((metric) => (
            <option key={metric} value={metric}>{formatMetric(lang, metric)}</option>
          ))}
        </Select>
        <div
          className={styles.chart}
          role="img"
          aria-label={lang('PlannerAriaChart', { name: formatMetric(lang, chartMetric) })}
        >
          <div className={styles.chartAxis}>
            <span>{formatNumber(lang, ceiling)}</span>
            <span>0</span>
          </div>
          <div className={styles.chartBars} style={`--planner-goal: ${goal ? (goal.target / ceiling) * 100 : 0}%`}>
            {goal && <span className={styles.chartGoal} />}
            {days.map((day, index) => {
              const total = getNutrientTotal(state, day, chartMetric);
              const isEmpty = !total.count || total.missing === total.count;
              const isComplete = Boolean(state.nutrition[day]?.isComplete) && !total.missing;
              const title = `${formatDay(lang, day)}: ${total.count
                ? `${formatNumber(lang, total.value)} ${formatMetricUnit(lang, chartMetric)}`
                : lang('PlannerFoodStatusNone')}`;
              return (
                <span
                  key={day}
                  className={buildClassName(styles.bar, isEmpty && styles.barEmpty, !isComplete && styles.barOpen)}
                  style={`--planner-height: ${Math.min(100, (total.value / ceiling) * 100)}%`}
                  title={title}
                >
                  <span className={styles.barFill} />
                  {(days.length === 1 || CHART_LABEL_INDEXES.has(index) || index === days.length - 1) && (
                    <span className={styles.barLabel}>{fromDayKey(day).getDate()}</span>
                  )}
                </span>
              );
            })}
          </div>
        </div>
        <p className={styles.small}>{lang('PlannerStatChartNote')}</p>
        <PlannerGoals state={state} picked={isDayPeriod ? picked : today} />
        <p className={styles.small}>
          {fiberDays.length
            ? lang('PlannerStatFiber', {
              value: formatNumber(
                lang,
                fiberDays.reduce((sum, day) => sum + getNutrientTotal(state, day, 'fiber').value, 0) / fiberDays.length,
              ),
              days: fiberDays.length,
            })
            : lang('PlannerStatFiberNone')}
        </p>
        <p className={styles.small}>
          {waterDays.length
            ? lang('PlannerStatWater', {
              value: formatNumber(
                lang, waterDays.reduce((sum, day) => sum + state.nutrition[day].waterMl!, 0) / waterDays.length, 0,
              ),
              days: waterDays.length,
            })
            : lang('PlannerStatWaterNone')}
        </p>
        <h3 className={styles.group}>{lang('PlannerStatHistory')}</h3>
        {!kcal.recorded.length && <p className={styles.small}>{lang('PlannerStatHistoryEmpty')}</p>}
        {kcal.recorded.map((day) => (
          <button key={day} type="button" className={styles.mealEntry} data-day={day} onClick={handleHistoryClick}>
            <span className={styles.mealEntryTop}>
              <span className={styles.taskName}>{formatDay(lang, day)}</span>
              <span>
                {`${formatNumber(lang, getNutrientTotal(state, day, 'kcal').value)} ${lang('PlannerUnitKcal')}`}
              </span>
            </span>
            <span className={styles.small}>{formatFoodStatus(lang, state, day)}</span>
          </button>
        ))}
        <Button isText size="smaller" className={styles.inlineAdd} onClick={handleOpenPicked}>
          {lang('PlannerStatOpenDiary')}
        </Button>
      </div>
    );
  }
};

function toPercent(part: number, whole: number) {
  return Math.round((part / whole) * 100);
}

export default memo(PlannerStatistics);
