import { memo, useMemo } from '../../../lib/teact/teact';

import type { PlannerDayIndexEntry, PlannerState } from './plannerModel';

import buildClassName from '../../../util/buildClassName';
import { formatDay, formatMonthName, getLoadLevel } from './plannerFormat';
import { getDayBudget } from './plannerHealth';
import { formatPlainName } from './plannerLinks';
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
  // Телефон: легенда под подписью; компьютер — легенда в шапке (`PlannerYearLegend`), записи дня — при наведении
  isNarrow: boolean;
  onOpenMonth: (day: string) => void;
};

const LEGEND_LEVELS = [0, 1, 2, 3];
const LEGEND_CLASSES = [undefined, pv.legendCell1, pv.legendCell2, pv.legendCell3];
// Столько записей дня видно в подсказке при наведении
const HOVER_ITEMS = 6;

// Легенда ступеней загрузки «меньше ▢▢▢▢ больше» (доски `XdPlan`, `XpPlan`)
function YearLegend() {
  const lang = useLang();
  return (
    <div className={pv.legend} aria-hidden data-year-legend>
      {lang('PlannerYearLess')}
      {LEGEND_LEVELS.map((level) => (
        <span key={level} className={buildClassName(pv.legendCell, LEGEND_CLASSES[level])} />
      ))}
      {lang('PlannerYearMore')}
    </div>
  );
}

export const PlannerYearLegend = memo(YearLegend);

// Подсказка клетки: дата и записи дня — «15 ноября: 10:00 Созвон, Отчёт»
function formatDayHover(lang: ReturnType<typeof useLang>, day: string, entry: PlannerDayIndexEntry | undefined) {
  const items = [
    ...(entry?.events || []).map((event) => (event.isAllDay ? formatPlainName(event.name)
      : `${event.start} ${formatPlainName(event.name)}`)),
    ...(entry?.tasks || []).map((task) => (task.start ? `${task.start} ${formatPlainName(task.name)}`
      : formatPlainName(task.name))),
    ...(entry?.deadlines || []).map((task) => lang('PlannerDeadlinePreview', { name: formatPlainName(task.name) })),
  ];
  const shown = items.slice(0, HOVER_ITEMS);
  if (items.length > HOVER_ITEMS) shown.push(`+${items.length - HOVER_ITEMS}`);
  return shown.length ? `${formatDay(lang, day)}: ${shown.join(', ')}` : formatDay(lang, day);
}

// Вид «Год»: двенадцать месяцев клетками без чисел; насыщенность клетки — загрузка дня (четыре ступени),
// красная рамка — праздник, точка — срок задачи. Наведение показывает записи дня, нажатие открывает месяц
const PlannerYear = ({
  state, year, picked, today, isNarrow, onOpenMonth,
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
                      title={formatDayHover(lang, day, entry)}
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
      <p className={styles.yearLegend}>{lang(isNarrow ? 'PlannerYearHintPhone' : 'PlannerYearHint')}</p>
      {isNarrow && <PlannerYearLegend />}
    </div>
  );
};

export default memo(PlannerYear);
