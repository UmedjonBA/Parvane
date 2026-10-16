import {
  memo, useLayoutEffect, useMemo, useRef,
} from '../../../lib/teact/teact';

import type { PlannerState } from './plannerModel';

import buildClassName from '../../../util/buildClassName';
import { formatDayLong, formatWeekday } from './plannerFormat';
import { getDayBudget } from './plannerHealth';
import { addDays, fromDayKey, getDayRange } from './plannerModel';

import useLang from '../../../hooks/useLang';
import useLastCallback from '../../../hooks/useLastCallback';

import styles from './Planner.module.scss';

type OwnProps = {
  state: PlannerState;
  // Понедельник недели выбранного дня
  weekStart: string;
  picked: string;
  today: string;
  onPickDay: (day: string) => void;
};

const PERCENT = 100;
// Лента — столько недель до и после недели выбранного дня
const WEEKS_BEFORE = 8;
const WEEKS_AFTER = 12;
const DAYS_IN_WEEK = 7;

// Телефон, вид «День»: лента дней над сеткой выбранного дня (16 окт 2026 — листается пальцем по горизонтали,
// выбранный день меняется только нажатием). У дня — день недели, число и полоска загрузки (занято от бюджета дня)
const PlannerDayStrip = ({
  state, weekStart, picked, today, onPickDay,
}: OwnProps) => {
  const lang = useLang();
  const stripRef = useRef<HTMLDivElement>();

  const first = addDays(weekStart, -WEEKS_BEFORE * DAYS_IN_WEEK);
  const days = useMemo(() => Array.from(
    { length: (WEEKS_BEFORE + WEEKS_AFTER + 1) * DAYS_IN_WEEK }, (_, index) => addDays(first, index),
  ), [first]);

  // Выбранный день за краем ленты (выбран не в ней: «Текущая дата», месяц) — лента встаёт на его неделю;
  // видимый день не сдвигает ленту
  useLayoutEffect(() => {
    const strip = stripRef.current;
    const cell = strip?.querySelector<HTMLElement>(`[data-day="${picked}"]`);
    if (!strip || !cell) return;
    const isVisible = cell.offsetLeft >= strip.scrollLeft
      && cell.offsetLeft + cell.offsetWidth <= strip.scrollLeft + strip.clientWidth;
    if (isVisible) return;
    const weekCell = strip.querySelector<HTMLElement>(`[data-day="${weekStart}"]`) || cell;
    strip.scrollLeft = weekCell.offsetLeft;
  }, [picked, weekStart]);

  const handleClick = useLastCallback((e: React.MouseEvent<HTMLButtonElement>) => {
    onPickDay(e.currentTarget.dataset.day!);
  });

  // Загрузка дней — из индекса недели (его же читает сетка дня под полосой)
  const cells = useMemo(() => {
    const index = getDayRange(state, days[0], days[days.length - 1]);
    return days.map((day) => {
      const entry = index.get(day);
      const load = entry?.minutes || 0;
      const budget = getDayBudget(state, day);
      return {
        day, load, budget, isHoliday: Boolean(entry?.isHoliday), fraction: budget ? Math.min(1, load / budget) : 0,
      };
    });
  }, [state, days]);

  return (
    <div ref={stripRef} className={styles.dayStrip} data-day-strip>
      {cells.map(({
        day, load, budget, isHoliday, fraction,
      }) => {
        return (
          <button
            key={day}
            type="button"
            className={buildClassName(
              styles.dayStripDay,
              day === today && styles.dayStripToday,
              day === picked && styles.dayStripPicked,
              isHoliday && styles.dayStripHoliday,
            )}
            data-day={day}
            aria-pressed={day === picked}
            aria-label={formatDayLong(lang, day)}
            onClick={handleClick}
          >
            <span className={styles.dayStripWeekday}>{formatWeekday(lang, (fromDayKey(day).getDay() + 6) % 7)}</span>
            <span className={styles.dayStripNumber}>{fromDayKey(day).getDate()}</span>
            <span className={styles.dayStripLoad} data-load={Math.round(fraction * PERCENT)}>
              <span
                className={buildClassName(styles.dayStripLoadFill, load > budget && styles.dayStripLoadOver)}
                style={`width: ${fraction * PERCENT}%`}
              />
            </span>
          </button>
        );
      })}
    </div>
  );
};

export default memo(PlannerDayStrip);
