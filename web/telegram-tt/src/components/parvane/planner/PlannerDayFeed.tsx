import type { TeactNode } from '../../../lib/teact/teact';
import { memo, useState } from '../../../lib/teact/teact';

import type { PlannerLayers } from './plannerLayers';
import type { PlannerState } from './plannerModel';

import buildClassName from '../../../util/buildClassName';
import { formatDuration, formatSpan, listColorStyle } from './plannerFormat';
import { getDailyRecord, getWorkouts, isShortSleep } from './plannerHealth';
import {
  getEventsForDay, getListColor, getTasksForDay, getTimedForDay, instanceKey, setTaskDone, toMinutes, toTime,
} from './plannerModel';
import { updatePlanner } from './plannerStore';

import useInterval from '../../../hooks/schedulers/useInterval';
import useLang from '../../../hooks/useLang';
import useLastCallback from '../../../hooks/useLastCallback';

import Icon from '../../common/icons/Icon';
import PlannerName from './PlannerName';

import styles from './Planner.module.scss';

type OwnProps = {
  state: PlannerState;
  day: string;
  today: string;
  layers: PlannerLayers;
  onOpenTask: (taskId: string, day?: string) => void;
  onOpenEvent: (eventId: string, day: string) => void;
};

type FeedRow = { minutes: number; node: TeactNode };

const MINUTE_MS = 60000;
const MEAL_LABELS = {
  breakfast: 'PlannerMealBreakfast',
  lunch: 'PlannerMealLunch',
  dinner: 'PlannerMealDinner',
  snack: 'PlannerMealSnack',
  other: 'PlannerMealOther',
} as const;

function getNowMinutes() {
  const now = new Date();
  return now.getHours() * 60 + now.getMinutes();
}

// Расписание дня списком по времени: подъём, приёмы пищи, события, задачи и тренировки; сегодня — красная
// черта «сейчас» между прошедшим и предстоящим
const PlannerDayFeed = ({
  state, day, today, layers, onOpenTask, onOpenEvent,
}: OwnProps) => {
  const [nowMinutes, setNowMinutes] = useState(getNowMinutes);

  const lang = useLang();

  useInterval(() => setNowMinutes(getNowMinutes()), MINUTE_MS, true);

  const handleItemClick = useLastCallback((e: React.MouseEvent<HTMLButtonElement>) => {
    const { kind, id } = e.currentTarget.dataset;
    if (kind === 'event') onOpenEvent(id!, day);
    else onOpenTask(id!, day);
  });

  const handleToggle = useLastCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const { id } = e.currentTarget.dataset;
    const { checked } = e.currentTarget;
    const task = getTasksForDay(state, day).find((candidate) => candidate.id === id);
    if (!task) return;
    updatePlanner((draft) => {
      setTaskDone(draft, task, checked);
    }, lang(checked ? 'PlannerNoticeDone' : 'PlannerNoticeReopened', { name: task.name }));
  });

  const rows: FeedRow[] = [];
  const allDay = layers.work ? getEventsForDay(state, day).filter((event) => event.isAllDay) : [];

  const sleep = layers.sleep ? getDailyRecord(state, 'sleep', day) : undefined;
  if (sleep?.endTime) {
    rows.push({
      // Подъём стоит раньше дела, начавшегося в ту же минуту
      minutes: toMinutes(sleep.endTime) - 0.5,
      node: (
        <div key="sleep" className={styles.feedLine} data-feed="sleep">
          <span className={styles.feedTime}>{sleep.endTime}</span>
          <span
            className={buildClassName(styles.feedMark, isShortSleep(state, day) ? styles.kindDue : styles.kindSleep)}
          >
            <Icon name="darkmode" />
            <span className={styles.feedMarkText}>{lang('PlannerFeedWake', { sleep: formatSpan(sleep.value) })}</span>
          </span>
        </div>
      ),
    });
  }

  if (layers.food) {
    (state.nutrition[day]?.entries || []).forEach((entry) => {
      if (!entry.time) return;
      rows.push({
        minutes: toMinutes(entry.time),
        node: (
          <div key={`meal${entry.id}`} className={styles.feedLine} data-feed="meal">
            <span className={styles.feedTime}>{entry.time}</span>
            <span className={buildClassName(styles.feedMark, styles.kindFood)}>
              <Icon name="eats" />
              <span className={styles.feedMarkText}>{`${lang(MEAL_LABELS[entry.meal])}: ${entry.name}`}</span>
              <span className={styles.feedMarkValue}>{lang.number(Math.round(entry.kcal))}</span>
            </span>
          </div>
        ),
      });
    });
  }

  if (layers.work) {
    getTimedForDay(state, day).forEach((item) => {
      const itemKey = item.task ? `t${instanceKey(item.task)}` : `e${instanceKey(item.event!)}`;
      const color = item.task ? getListColor(state, item.task.project) : item.event!.color;
      rows.push({
        minutes: toMinutes(item.start),
        node: (
          <div key={itemKey} className={styles.feedLine}>
            <span className={styles.feedTime}>{item.start}</span>
            <div
              className={buildClassName(
                styles.feedBlock,
                item.task ? styles.kindTask : styles.kindEvent,
                item.task?.status === 'done' && styles.feedBlockDone,
              )}
              style={listColorStyle(color)}
              data-block={itemKey}
            >
              {item.task && (
                <input
                  type="checkbox"
                  className={buildClassName(styles.check, styles.checkSmall)}
                  checked={item.task.status === 'done'}
                  aria-label={lang('PlannerAriaDone', { name: item.task.name })}
                  data-id={item.task.id}
                  onChange={handleToggle}
                />
              )}
              <button
                type="button"
                className={styles.feedBlockOpen}
                data-kind={item.task ? 'task' : 'event'}
                data-id={item.task ? item.task.id : item.event!.id}
                onClick={handleItemClick}
              >
                <span className={styles.feedBlockName}><PlannerName name={item.name} /></span>
                <span className={styles.feedBlockSub}>
                  <span>{`${item.start}–${item.end}`}</span>
                  {item.task?.description.includes('[[') && <PlannerName name={item.task.description} onlyLinks />}
                </span>
              </button>
            </div>
          </div>
        ),
      });
    });
    getWorkouts(state, [day]).forEach((record) => {
      if (!record.time) return;
      const start = toMinutes(record.time);
      rows.push({
        minutes: start,
        node: (
          <div key={`w${record.id}`} className={styles.feedLine} data-feed="workout">
            <span className={styles.feedTime}>{record.time}</span>
            <div className={buildClassName(styles.feedBlock, styles.kindWorkout)}>
              <span className={styles.feedBlockOpen}>
                <span className={styles.feedBlockName}>{record.name}</span>
                <span className={styles.feedBlockSub}>
                  {record.value ? `${record.time}–${toTime(start + record.value)}` : record.time}
                  {record.value ? ` · ${formatDuration(lang, record.value)}` : ''}
                </span>
              </span>
            </div>
          </div>
        ),
      });
    });
  }

  rows.sort((a, b) => a.minutes - b.minutes);
  const isToday = day === today;
  const nowIndex = isToday ? rows.filter((row) => row.minutes <= nowMinutes).length : -1;
  const nowLine = (
    <div key="now" className={styles.feedNow} data-feed="now">
      <span>{toTime(nowMinutes)}</span>
      <span className={styles.feedNowLine} />
    </div>
  );

  const nodes = rows.map((row) => row.node);
  if (isToday) nodes.splice(nowIndex, 0, nowLine);

  if (!rows.length && !allDay.length && !isToday) {
    return <p className={styles.muted}>{lang('PlannerFree')}</p>;
  }

  return (
    <div className={styles.feed} data-day-feed={day}>
      {allDay.map((event) => (
        <div key={`a${instanceKey(event)}`} className={styles.feedLine}>
          <span className={styles.feedTime}>{lang('PlannerAllDayTiny')}</span>
          <div
            className={buildClassName(styles.feedBlock, event.isHoliday ? styles.kindDue : styles.kindEvent)}
            style={listColorStyle(event.color)}
            data-all-day={event.id}
            data-holiday={event.isHoliday ? '1' : undefined}
          >
            <button
              type="button"
              className={styles.feedBlockOpen}
              data-kind="event"
              data-id={event.id}
              onClick={handleItemClick}
            >
              <span className={styles.feedBlockName}><PlannerName name={event.name} /></span>
              <span className={styles.feedBlockSub}>{lang(event.isHoliday ? 'PlannerHoliday' : 'PlannerAllDay')}</span>
            </button>
          </div>
        </div>
      ))}
      {nodes}
    </div>
  );
};

export default memo(PlannerDayFeed);
