import { memo, useMemo } from '../../../lib/teact/teact';

import type { PlannerState } from './plannerModel';

import buildClassName from '../../../util/buildClassName';
import { formatDay, formatMonthName, formatWeekday } from './plannerFormat';
import {
  buildDayIndex, fromDayKey, getMonthGridKeys, getYearMonths, toDayKey,
} from './plannerModel';

import useLang from '../../../hooks/useLang';
import useLastCallback from '../../../hooks/useLastCallback';

import styles from './Planner.module.scss';

type OwnProps = {
  state: PlannerState;
  year: number;
  picked: string;
  today: string;
  onOpenMonth: (day: string) => void;
};

const WEEKDAY_INDEXES = [0, 1, 2, 3, 4, 5, 6];
// Самый насыщенный цвет клетки — день, занятый на весь бюджет, %
const MAX_LOAD_TINT = 85;

// Вид «Год»: двенадцать месяцев; насыщенность клетки — загрузка дня, красное число — праздник, точка —
// срок задачи. Нажатие открывает месяц
const PlannerYear = ({
  state, year, picked, today, onOpenMonth,
}: OwnProps) => {
  const lang = useLang();

  const index = useMemo(() => buildDayIndex(state, `${year}-01-01`, `${year}-12-31`), [state, year]);

  const handleDayClick = useLastCallback((e: React.MouseEvent<HTMLButtonElement>) => {
    onOpenMonth(e.currentTarget.dataset.day!);
  });

  const todayMonth = today.slice(0, 7);

  return (
    <div data-planner-view="year">
      <div className={styles.year}>
        {getYearMonths(year).map((month) => {
          const prefix = toDayKey(month).slice(0, 7);
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
                {WEEKDAY_INDEXES.map((weekday) => (
                  <span key={`w${weekday}`} className={styles.yearWeekday}>
                    {formatWeekday(lang, weekday).charAt(0)}
                  </span>
                ))}
                {getMonthGridKeys(month).map((day) => {
                  if (!day.startsWith(prefix)) return <span key={day} />;
                  const entry = index.get(day);
                  const count = entry ? entry.tasks.length + entry.events.length + entry.deadlines.length : 0;
                  const tint = entry && state.budget
                    ? Math.min(MAX_LOAD_TINT, Math.round((entry.minutes / state.budget) * MAX_LOAD_TINT)) : 0;
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
                      style={tint ? `--planner-load: ${tint}%` : undefined}
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
    </div>
  );
};

export default memo(PlannerYear);
