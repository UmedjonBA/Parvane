import { memo } from '../../../lib/teact/teact';

import type { PlannerState } from './plannerModel';

import buildClassName from '../../../util/buildClassName';
import { formatDayLong, formatWeekday } from './plannerFormat';
import { getDayBudget } from './plannerHealth';
import { fromDayKey, getDayLoad, isHolidayOn } from './plannerModel';

import useLang from '../../../hooks/useLang';
import useLastCallback from '../../../hooks/useLastCallback';

import styles from './Planner.module.scss';

type OwnProps = {
  state: PlannerState;
  // Семь дней недели
  days: string[];
  picked: string;
  today: string;
  onPickDay: (day: string) => void;
};

const PERCENT = 100;

// Телефон, вид «Неделя»: полоса дней недели над сеткой выбранного дня. У дня — день недели, число
// и полоска загрузки (занято от бюджета дня)
const PlannerDayStrip = ({
  state, days, picked, today, onPickDay,
}: OwnProps) => {
  const lang = useLang();

  const handleClick = useLastCallback((e: React.MouseEvent<HTMLButtonElement>) => {
    onPickDay(e.currentTarget.dataset.day!);
  });

  return (
    <div className={styles.dayStrip} data-day-strip data-swipe="week">
      {days.map((day, index) => {
        const load = getDayLoad(state, day);
        const budget = getDayBudget(state, day);
        const fraction = budget ? Math.min(1, load / budget) : 0;
        return (
          <button
            key={day}
            type="button"
            className={buildClassName(
              styles.dayStripDay,
              day === today && styles.dayStripToday,
              day === picked && styles.dayStripPicked,
              isHolidayOn(state, day) && styles.dayStripHoliday,
            )}
            data-day={day}
            aria-pressed={day === picked}
            aria-label={formatDayLong(lang, day)}
            onClick={handleClick}
          >
            <span className={styles.dayStripWeekday}>{formatWeekday(lang, index)}</span>
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
