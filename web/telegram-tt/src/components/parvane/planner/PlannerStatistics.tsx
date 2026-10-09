import type { TeactNode } from '../../../lib/teact/teact';
import { memo, useState } from '../../../lib/teact/teact';

import type { PlannerCalendarView, PlannerState } from './plannerModel';

import { formatHours, formatPeriod, formatProject } from './plannerFormat';
import {
  EVENTS_GROUP, fromDayKey, getMonthKeys, getTimeStatistics, getWeekKeys, getYearKeys, shiftPeriod,
} from './plannerModel';

import useLang from '../../../hooks/useLang';
import useLastCallback from '../../../hooks/useLastCallback';

import PlannerPeriodBar from './PlannerPeriodBar';

import styles from './Planner.module.scss';

type OwnProps = {
  state: PlannerState;
  picked: string;
  today: string;
  trailing?: TeactNode;
  onPickDay: (day: string) => void;
};

type Period = Exclude<PlannerCalendarView, 'agenda'>;

const PERIODS: Period[] = ['day', 'week', 'month', 'year'];
const PERIOD_LABELS = {
  day: 'PlannerPeriodDay',
  week: 'PlannerPeriodWeek',
  month: 'PlannerPeriodMonth',
  year: 'PlannerPeriodYear',
} as const satisfies Record<Period, string>;

// Статистика за день, неделю, месяц или год: время по спискам
const PlannerStatistics = ({
  state, picked, today, trailing, onPickDay,
}: OwnProps) => {
  const lang = useLang();

  const [period, setPeriod] = useState<Period>('month');
  const [hidden, setHidden] = useState<ReadonlySet<string>>(() => new Set());

  const isDayPeriod = period === 'day';
  const pickedDate = fromDayKey(picked);
  const days = isDayPeriod ? [picked]
    : period === 'week' ? getWeekKeys(picked)
      : period === 'year' ? getYearKeys(pickedDate.getFullYear())
        : getMonthKeys(new Date(pickedDate.getFullYear(), pickedDate.getMonth(), 1));

  const handleSwitchPeriod = useLastCallback((next: string) => setPeriod(next as Period));
  const handlePrev = useLastCallback(() => onPickDay(shiftPeriod(period, picked, -1)));
  const handleNext = useLastCallback(() => onPickDay(shiftPeriod(period, picked, 1)));
  const handleToday = useLastCallback(() => onPickDay(today));

  const handleGroupToggle = useLastCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const next = new Set(hidden);
    if (e.currentTarget.checked) next.delete(e.currentTarget.value);
    else next.add(e.currentTarget.value);
    setHidden(next);
  });

  const segments = PERIODS.map((item) => ({ value: item, label: lang(PERIOD_LABELS[item]) }));

  return (
    <div className={styles.statistics}>
      <PlannerPeriodBar
        title={formatPeriod(lang, period, picked)}
        prevLabel={lang('PlannerPrevPeriod')}
        nextLabel={lang('PlannerNextPeriod')}
        picked={picked}
        segments={segments}
        activeSegment={period}
        segmentsLabel={lang('PlannerStatPeriod')}
        trailing={trailing}
        onPrev={handlePrev}
        onNext={handleNext}
        onToday={handleToday}
        onPickDay={onPickDay}
        onSwitchSegment={handleSwitchPeriod}
      />
      {renderTime()}
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
};

export default memo(PlannerStatistics);
