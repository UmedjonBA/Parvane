import { memo, useMemo } from '../../../lib/teact/teact';

import type { PlannerState } from './plannerModel';

import buildClassName from '../../../util/buildClassName';
import { formatDay, formatMonthName, getLoadLevel } from './plannerFormat';
import { getDayBudget } from './plannerHealth';
import {
  fromDayKey, getDayIndex, getMonthGridKeys, getYearMonths, toDayKey,
} from './plannerModel';

import useLang from '../../../hooks/useLang';
import useLastCallback from '../../../hooks/useLastCallback';

import styles from './Planner.module.scss';
import pv from './PlannerPv.module.scss';

type OwnProps = {
  state: PlannerState;
  year: number;
  picked: string;
  today: string;
  onOpenMonth: (day: string) => void;
};

const LEGEND_LEVELS = [0, 1, 2, 3];
const LEGEND_CLASSES = [undefined, pv.legendCell1, pv.legendCell2, pv.legendCell3];

// Вид «Год»: двенадцать месяцев клетками без чисел; насыщенность клетки — загрузка дня (четыре ступени),
// красная рамка — праздник, точка — срок задачи. Нажатие открывает месяц
const PlannerYear = ({
  state, year, picked, today, onOpenMonth,
}: OwnProps) => {
  const lang = useLang();

  const index = getDayIndex(state, `${year}-01-01`, `${year}-12-31`);
  const months = useMemo(() => getYearMonths(year).map((month) => ({
    month, prefix: toDayKey(month).slice(0, 7), days: getMonthGridKeys(month),
  })), [year]);

  const handleDayClick = useLastCallback((e: React.MouseEvent<HTMLButtonElement>) => {
    onOpenMonth(e.currentTarget.dataset.day!);
  });

  const todayMonth = today.slice(0, 7);

  return (
    <div data-planner-view="year">
      <div className={styles.year}>
        {months.map(({ month, prefix, days }) => {
          return (
            <section key={prefix} data-month={prefix}>
              <button
                type="button"
                className={buildClassName(styles.yearMonthTitle, prefix === todayMonth && styles.yearMonthCurrent)}
                data-day={prefix === picked.slice(0, 7) ? picked : toDayKey(month)}
                onClick={handleDayClick}
              >
                {formatMonthName(lang, month)}
              </button>
              <div className={styles.yearGrid}>
                {days.map((day) => {
                  if (!day.startsWith(prefix)) return <span key={day} />;
                  const entry = index.get(day);
                  const count = entry ? entry.tasks.length + entry.events.length + entry.deadlines.length : 0;
                  return (
                    <button
                      key={day}
                      type="button"
                      className={buildClassName(
                        styles.yearDay,
                        entry?.isHoliday && styles.yearDayHoliday,
                        Boolean(entry?.deadlines.length) && styles.yearDayDue,
                        day === today && styles.yearDayToday,
                        day === picked && styles.yearDayPicked,
                      )}
                      data-level={entry ? getLoadLevel(entry.minutes, getDayBudget(state, day)) : 0}
                      data-day={day}
                      aria-label={lang('PlannerAriaYearDay', { date: formatDay(lang, day), count })}
                      onClick={handleDayClick}
                    >
                      {fromDayKey(day).getDate()}
                    </button>
                  );
                })}
              </div>
            </section>
          );
        })}
      </div>
      <p className={styles.yearLegend}>{lang('PlannerYearLegend')}</p>
      <div className={pv.legend} aria-hidden>
        {lang('PlannerYearLess')}
        {LEGEND_LEVELS.map((level) => (
          <span key={level} className={buildClassName(pv.legendCell, LEGEND_CLASSES[level])} />
        ))}
        {lang('PlannerYearMore')}
      </div>
    </div>
  );
};

export default memo(PlannerYear);
