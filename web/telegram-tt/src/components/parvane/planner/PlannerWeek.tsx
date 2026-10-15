import {
  memo, useEffect, useMemo, useRef, useState,
} from '../../../lib/teact/teact';

import type { PlannerLayers } from './plannerLayers';
import type { PlannerDayIndexEntry, PlannerEvent, PlannerState } from './plannerModel';

import buildClassName from '../../../util/buildClassName';
import {
  formatDay, formatHours, formatHoursNumber, formatSpan, formatWeekday, listColorStyle,
} from './plannerFormat';
import { getDailyRecord, getDayBudget, isShortSleep } from './plannerHealth';
import { formatDescriptionLine, formatPlainName } from './plannerLinks';
import {
  addDays, fromDayKey, getDayRange, getEventColor, getListColor, getNutrientTotal, instanceKey, layoutTimed,
  MINUTES_IN_DAY, toMinutes, toTime,
} from './plannerModel';

import useInterval from '../../../hooks/schedulers/useInterval';
import useLang from '../../../hooks/useLang';
import useLastCallback from '../../../hooks/useLastCallback';

import Icon from '../../common/icons/Icon';
import PlannerName from './PlannerName';

import styles from './Planner.module.scss';

type OwnProps = {
  state: PlannerState;
  // Семь дней недели либо один день (телефон: сетка дня под полосой дней)
  days: string[];
  picked: string;
  today: string;
  layers: PlannerLayers;
  onPickDay: (day: string) => void;
  onCreateForDay: (day: string) => void;
  // Нажатие на свободное время создаёт дело в этом дне с этого времени
  onCreateAt: (day: string, start: number) => void;
  onOpenTask: (taskId: string, day?: string) => void;
  onOpenEvent: (eventId: string, day: string) => void;
};

const ALL_DAY_FILL_PERCENT = 14;
const MINUTES_IN_HOUR = 60;
const HOURS_IN_DAY = 24;
const PERCENT = 100;
const MINUTE_MS = 60000;
// Высота часа в сетке, rem: неделя и сетка одного дня на телефоне
const HOUR_REM = 3;
const HOUR_REM_SINGLE = 3.5;
const MIN_BLOCK_REM = 1.5;
// Новое дело из сетки начинается с получаса и длится час
const CREATE_STEP = 30;
const CREATE_MINUTES = 60;
// Сетка открывается чуть выше начала дня (либо текущего часа), а не вплотную к нему
const SCROLL_LEAD_HOURS = 0.3;
const NOW_LEAD_HOURS = 2;
const EMPTY_ENTRY: PlannerDayIndexEntry = {
  tasks: [], events: [], deadlines: [], isHoliday: false, minutes: 0, timed: [], untimed: [], allDay: [],
  conflicts: 0, unrated: 0,
};

function getNowMinutes() {
  const now = new Date();
  return now.getHours() * MINUTES_IN_HOUR + now.getMinutes();
}

// Сетка по часам: неделя либо один день. Над сеткой недели — шапки дней с загрузкой и строка «весь день»
// (сон, калории, события на весь день, задачи без времени, сроки). В сетке — время вне дня затемнено, сон
// полосой до подъёма, блоки дел цветом вида записи, отметки приёмов пищи, черта «сейчас»
// Заливка события на весь день — один тон на строку «весь день» и на колонку дня; несколько событий
// делят ширину поровну
function allDayFillStyle(state: PlannerState, events: PlannerEvent[]) {
  const share = PERCENT / events.length;
  const stops = events.map((event, index) => {
    const eventColor = getEventColor(state, event);
    const color = eventColor
      ? `var(--color-peer-${eventColor - 1})` : `var(--pv-${event.isHoliday ? 'red' : 'event'})`;
    const tone = `color-mix(in srgb, ${color} ${ALL_DAY_FILL_PERCENT}%, transparent)`;
    return `${tone} ${index * share}% ${(index + 1) * share}%`;
  });
  return `background: linear-gradient(to right, ${stops.join(', ')})`;
}

const PlannerWeek = ({
  state, days, picked, today, layers, onPickDay, onCreateForDay, onCreateAt, onOpenTask, onOpenEvent,
}: OwnProps) => {
  const lang = useLang();

  const scrollRef = useRef<HTMLDivElement>();
  const [nowMinutes, setNowMinutes] = useState(getNowMinutes);

  const isSingle = days.length === 1;
  const hourRem = isSingle ? HOUR_REM_SINGLE : HOUR_REM;
  const { dayStart, dayEnd } = state.settings;
  const firstDay = days[0];
  const hasToday = days.includes(today);

  // Черта «сейчас» идёт по минутам, только пока сегодняшний день на экране
  useInterval(() => setNowMinutes(getNowMinutes()), hasToday ? MINUTE_MS : undefined, true);

  // Дела колонок — из индекса дней (один проход по записям на неделю); пересчёт только при смене
  // состояния, дней либо слоёв
  const columns = useMemo(() => {
    const index = getDayRange(state, firstDay, days[days.length - 1]);
    return days.map((day) => {
      const entry = index.get(day) || EMPTY_ENTRY;
      const sleep = layers.sleep ? getDailyRecord(state, 'sleep', day) : undefined;
      const nextSleep = layers.sleep ? getDailyRecord(state, 'sleep', addDays(day, 1)) : undefined;
      // Лёг до полуночи — вечер этого дня тоже сон
      const bedtime = nextSleep?.time && nextSleep.endTime && nextSleep.time > nextSleep.endTime
        ? toMinutes(nextSleep.time) : undefined;
      return {
        day,
        layout: layers.work ? layoutTimed(entry.timed) : [],
        allDay: layers.work ? entry.allDay : [],
        untimed: layers.work ? entry.untimed : [],
        deadlines: layers.work ? entry.deadlines : [],
        meals: layers.food ? (state.nutrition[day]?.entries || []).filter((item) => item.time) : [],
        kcal: layers.food ? Math.round(getNutrientTotal(state, day, 'kcal').value) : 0,
        sleep,
        wake: sleep?.endTime ? toMinutes(sleep.endTime) : undefined,
        bedtime,
        isShort: isShortSleep(state, day),
        isHoliday: entry.isHoliday,
        load: entry.minutes,
        budget: getDayBudget(state, day),
      };
    });
  }, [state, days, firstDay, layers]);
  // Сетка начинается за час до начала дня и покрывает всё, что выходит за окна дня
  const starts = columns.flatMap((column) => [
    ...column.layout.map(({ item }) => toMinutes(item.start)),
    ...column.meals.map((entry) => toMinutes(entry.time!)),
    ...(column.wake === undefined ? [] : [column.wake - MINUTES_IN_HOUR]),
  ]);
  const ends = columns.flatMap((column) => [
    ...column.layout.map(({ item }) => toMinutes(item.end)),
    ...column.meals.map((entry) => toMinutes(entry.time!) + MINUTES_IN_HOUR),
    ...(column.bedtime === undefined ? [] : [MINUTES_IN_DAY]),
  ]);
  const firstHour = Math.max(0, Math.floor(Math.min(dayStart - MINUTES_IN_HOUR, ...starts) / MINUTES_IN_HOUR));
  const lastHour = Math.min(HOURS_IN_DAY, Math.ceil(Math.max(dayEnd + MINUTES_IN_HOUR, ...ends) / MINUTES_IN_HOUR));
  const hours = Array.from({ length: lastHour - firstHour }, (_, i) => firstHour + i);
  const gridStart = firstHour * MINUTES_IN_HOUR;
  const gridMinutes = hours.length * MINUTES_IN_HOUR;
  const offset = (minutes: number) => (
    (Math.max(0, Math.min(gridMinutes, minutes - gridStart)) / MINUTES_IN_HOUR) * hourRem
  );
  // Границы затемнения времени вне дня: полоса сна его вытесняет
  const offTop = (wake?: number) => (wake !== undefined && wake > gridStart ? offset(wake) : 0);
  const offBottom = (bedtime: number) => (gridMinutes / MINUTES_IN_HOUR) * hourRem - offset(bedtime);
  const hasMorningSleep = (sleep?: { endTime?: string }) => (
    Boolean(sleep?.endTime && toMinutes(sleep.endTime) > gridStart)
  );
  // Неделя открывается на начале дня, а текущая — за пару часов до «сейчас». Сетка одного дня листается
  // вместе со страницей
  useEffect(() => {
    const scroller = scrollRef.current;
    if (!scroller || isSingle) return;
    const hour = hasToday
      ? Math.min(dayStart, getNowMinutes() - NOW_LEAD_HOURS * MINUTES_IN_HOUR) / MINUTES_IN_HOUR
      : dayStart / MINUTES_IN_HOUR;
    const hourPx = scroller.scrollHeight / hours.length;
    scroller.scrollTop = Math.max(0, (hour - firstHour - SCROLL_LEAD_HOURS) * hourPx);
    // Прокрутка ставится при смене недели, а не при каждой правке дел
    // eslint-disable-next-line react-hooks-static-deps/exhaustive-deps
  }, [firstDay, isSingle]);

  const handleDayClick = useLastCallback((e: React.MouseEvent<HTMLElement>) => {
    onPickDay(e.currentTarget.dataset.day!);
  });

  const handleColumnDoubleClick = useLastCallback((e: React.MouseEvent<HTMLElement>) => {
    if ((e.target as HTMLElement).closest('[data-kind]')) return;
    onCreateForDay(e.currentTarget.dataset.day!);
  });

  const handleColumnClick = useLastCallback((e: React.MouseEvent<HTMLElement>) => {
    if ((e.target as HTMLElement).closest('[data-block]')) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const minutes = gridStart + ((e.clientY - rect.top) / rect.height) * gridMinutes;
    const start = Math.floor(minutes / CREATE_STEP) * CREATE_STEP;
    onCreateAt(e.currentTarget.dataset.day!, Math.max(0, Math.min(start, gridStart + gridMinutes - CREATE_MINUTES)));
  });

  const handleItemClick = useLastCallback((e: React.MouseEvent<HTMLButtonElement>) => {
    e.stopPropagation();
    const { kind, id, day } = e.currentTarget.dataset;
    if (kind === 'event') onOpenEvent(id!, day!);
    else onOpenTask(id!, day);
  });

  return (
    <div
      className={buildClassName(styles.week, isSingle && styles.weekSingle)}
      style={`--planner-week-days: ${days.length}; --planner-hour: ${hourRem}rem`}
      data-planner-view={isSingle ? undefined : 'week'}
      data-day-grid={isSingle ? '1' : undefined}
    >
      {!isSingle && (
        <div className={styles.weekHead}>
          <span />
          {columns.map(({
            day, isHoliday, load, budget,
          }) => {
            const date = fromDayKey(day);
            const isOver = load > budget;
            return (
              <button
                key={day}
                type="button"
                className={buildClassName(
                  styles.weekDay,
                  day === today && styles.weekDayToday,
                  day === picked && styles.weekDayPicked,
                  isHoliday && styles.weekDayHoliday,
                )}
                data-day={day}
                aria-label={formatDay(lang, day)}
                onClick={handleDayClick}
              >
                <span className={styles.weekDayName}>{formatWeekday(lang, (date.getDay() + 6) % 7)}</span>
                <span className={styles.weekDayRow}>
                  <span className={styles.weekDayNumber}>{date.getDate()}</span>
                  <span className={buildClassName(styles.weekDayLoad, isOver && styles.red)}>
                    {`${formatHoursNumber(lang, load)}/${formatHours(lang, budget)}`}
                  </span>
                </span>
                <span
                  className={buildClassName(styles.prog, styles.progThin, isOver ? styles.kindDue : styles.kindEvent)}
                >
                  <span
                    className={styles.progFill}
                    style={`width: ${budget ? Math.min(1, load / budget) * PERCENT : 0}%`}
                  />
                </span>
              </button>
            );
          })}
          <span className={styles.weekAllDayLabel}>{lang('PlannerAllDayShort')}</span>
          {columns.map(({
            day, allDay, untimed, deadlines, sleep, isShort, kcal,
          }) => (
            <div
              key={day}
              className={buildClassName(
                styles.weekAllDayCell, !allDay.length && hasMorningSleep(sleep) && styles.weekAllDayCellSleep,
              )}
              style={allDay.length ? allDayFillStyle(state, allDay) : undefined}
              data-day={day}
            >
              {sleep && (
                <span className={buildClassName(styles.tag, isShort ? styles.kindDue : styles.kindSleep)}>
                  <Icon name="darkmode" />
                  {formatSpan(sleep.value)}
                </span>
              )}
              {Boolean(kcal) && (
                <span className={buildClassName(styles.tag, styles.kindFood)}>
                  <Icon name="eats" />
                  {lang.number(kcal)}
                </span>
              )}
              {allDay.map((event) => (
                <button
                  key={`e${instanceKey(event)}`}
                  type="button"
                  className={buildClassName(
                    styles.tag, styles.tagButton, event.isHoliday ? styles.kindDue : styles.kindEvent,
                  )}
                  style={listColorStyle(getEventColor(state, event))}
                  title={event.isHoliday
                    ? `${lang('PlannerHoliday')}: ${formatPlainName(event.name)}` : formatPlainName(event.name)}
                  data-kind="event"
                  data-all-day={event.id}
                  data-holiday={event.isHoliday ? '1' : undefined}
                  data-id={event.id}
                  data-day={day}
                  onClick={handleItemClick}
                >
                  {event.isHoliday && <Icon name="star" />}
                  <PlannerName name={event.name} />
                </button>
              ))}
              {untimed.map((task) => (
                <button
                  key={`t${instanceKey(task)}`}
                  type="button"
                  className={buildClassName(
                    styles.tag, styles.tagButton, styles.kindTask, task.status === 'done' && styles.tagDone,
                  )}
                  style={listColorStyle(getListColor(state, task.project))}
                  title={formatPlainName(task.name)}
                  data-kind="task"
                  data-id={task.id}
                  data-day={day}
                  onClick={handleItemClick}
                >
                  {task.status === 'done' && <Icon name="check" />}
                  <PlannerName name={task.name} />
                </button>
              ))}
              {deadlines.map((task) => (
                <button
                  key={`d${task.id}`}
                  type="button"
                  className={buildClassName(styles.tag, styles.tagButton, styles.kindDue)}
                  title={lang('PlannerDeadlinePreview', { name: formatPlainName(task.name) })}
                  data-kind="task"
                  data-id={task.id}
                  onClick={handleItemClick}
                >
                  <Icon name="flag" />
                  {lang('PlannerDeadlinePreview', { name: formatPlainName(task.name) })}
                </button>
              ))}
            </div>
          ))}
        </div>
      )}
      <div ref={scrollRef} className={buildClassName(styles.weekScroll, 'custom-scroll')}>
        <div
          className={styles.weekGrid}
          style={`height: ${hours.length * hourRem}rem`}
          data-first-hour={firstHour}
          data-hours={hours.length}
        >
          <div className={styles.weekHours}>
            {hours.map((hour, index) => (
              <span key={hour} className={styles.weekHour} style={`top: ${index * hourRem}rem`}>
                {toTime(hour * MINUTES_IN_HOUR)}
              </span>
            ))}
          </div>
          {columns.map(({
            day, layout, meals, wake, bedtime, allDay,
          }) => (
            <div
              key={day}
              className={buildClassName(styles.weekColumn, day === today && styles.weekColumnToday)}
              style={`height: ${hours.length * hourRem}rem`}
              data-day={day}
              onClick={handleColumnClick}
              onDoubleClick={isSingle ? undefined : handleColumnDoubleClick}
            >
              {Boolean(allDay.length) && (
                <span
                  className={styles.weekAllDayFill}
                  style={allDayFillStyle(state, allDay)}
                  data-all-day-fill={allDay[0].id}
                />
              )}
              {/* Время вне дня не затемняется там, где день залит событием или сном: заливка одного тона */}
              {!allDay.length && offTop(wake) < offset(dayStart) && (
                <span
                  className={styles.weekOff}
                  style={`top: ${offTop(wake)}rem; height: ${offset(dayStart) - offTop(wake)}rem`}
                />
              )}
              {!allDay.length && (bedtime === undefined || bedtime > dayEnd) && (
                <span
                  className={styles.weekOff}
                  style={`top: ${offset(dayEnd)}rem; bottom: ${bedtime !== undefined ? offBottom(bedtime) : 0}rem`}
                />
              )}
              {wake !== undefined && wake > gridStart && (
                <span className={styles.weekSleep} style={`top: 0; height: ${offset(wake)}rem`} data-sleep="morning" />
              )}
              {bedtime !== undefined && (
                <span
                  className={buildClassName(styles.weekSleep, styles.weekSleepNight)}
                  style={`top: ${offset(bedtime)}rem; bottom: 0`}
                  data-sleep="night"
                />
              )}
              {layout.map(({
                item, lane, lanes, right,
              }) => {
                const start = toMinutes(item.start);
                const top = ((start - gridStart) / MINUTES_IN_HOUR) * hourRem;
                const height = Math.max(MIN_BLOCK_REM, ((toMinutes(item.end) - start) / MINUTES_IN_HOUR) * hourRem);
                // Колонки пересечения; блок тянется вправо, пока не закрыл бы чужой заголовок (`layoutTimed`)
                const position = `top: ${top}rem; height: ${height}rem; z-index: ${lane + 1}; `
                  + `inset-inline-start: ${(lane / lanes) * PERCENT}%; width: ${((right - lane) / lanes) * PERCENT}%`;
                const color = listColorStyle(
                  item.task ? getListColor(state, item.task.project) : getEventColor(state, item.event!),
                );
                const itemKey = item.task ? `t${instanceKey(item.task)}` : `e${instanceKey(item.event!)}`;
                // Описание — третьей строкой: видно, когда блок достаточно высок, иначе обрезается
                const note = formatDescriptionLine(item.task ? item.task.description : item.event!.description);
                return (
                  <div
                    key={itemKey}
                    className={buildClassName(
                      styles.weekBlock,
                      item.task ? styles.kindTask : styles.kindEvent,
                      item.task?.status === 'done' && styles.weekBlockDone,
                    )}
                    style={color ? `${position}; ${color}` : position}
                    data-block={itemKey}
                    data-lane={lane}
                  >
                    <button
                      type="button"
                      className={styles.weekBlockOpen}
                      title={`${item.start}–${item.end} ${formatPlainName(item.name)}${note ? ` — ${note}` : ''}`}
                      data-kind={item.task ? 'task' : 'event'}
                      data-id={item.task ? item.task.id : item.event!.id}
                      data-day={day}
                      onClick={handleItemClick}
                    >
                      <span className={styles.weekBlockName}><PlannerName name={item.name} /></span>
                      <span className={styles.weekBlockTime}>{`${item.start}–${item.end}`}</span>
                      {note && <span className={styles.weekBlockNote} data-block-note>{note}</span>}
                    </button>
                  </div>
                );
              })}
              {meals.map((entry) => (
                <span
                  key={entry.id}
                  className={styles.weekMeal}
                  style={`top: ${offset(toMinutes(entry.time!))}rem`}
                  title={entry.name}
                  data-meal={entry.id}
                >
                  <Icon name="eats" />
                  {lang.number(Math.round(entry.kcal))}
                </span>
              ))}
              {day === today && nowMinutes >= gridStart && nowMinutes <= gridStart + gridMinutes && (
                <span className={styles.weekNow} style={`top: ${offset(nowMinutes)}rem`} />
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};

export default memo(PlannerWeek);
