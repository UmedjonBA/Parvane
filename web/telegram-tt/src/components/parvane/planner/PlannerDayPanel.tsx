import type { TeactNode } from '../../../lib/teact/teact';
import { memo } from '../../../lib/teact/teact';

import type { PlannerLayers } from './plannerLayers';
import type { PlannerState } from './plannerModel';

import buildClassName from '../../../util/buildClassName';
import {
  formatDay, formatHours, formatHoursNumber, formatRelativeDay, formatSpan,
} from './plannerFormat';
import { getDailyRecord, getDayBudget, isShortSleep } from './plannerHealth';
import { formatPlainName } from './plannerLinks';
import {
  getDayEntry, getListColor, getNutrientTotal, instanceKey,
} from './plannerModel';

import useLang from '../../../hooks/useLang';
import useLastCallback from '../../../hooks/useLastCallback';

import Icon from '../../common/icons/Icon';
import PvResizer, { PLANNER_SIDE_MAX, PLANNER_SIDE_MIN } from '../notes/PvResizer';
import PlannerDayFeed from './PlannerDayFeed';
import PlannerTaskRow from './PlannerTaskRow';

import styles from './Planner.module.scss';

type OwnProps = {
  state: PlannerState;
  day: string;
  today: string;
  layers: PlannerLayers;
  // `island` — правая панель календаря (шапка со стрелками дня), `card` — карточка под месяцем на телефоне,
  // `summary` — только сводка и задачи без времени над сеткой дня
  variant: 'island' | 'card' | 'summary';
  onShiftDay?: (delta: number) => void;
  onAdd?: NoneToVoidFunction;
  onOpenTask: (taskId: string, day?: string) => void;
  onOpenEvent: (eventId: string, day: string) => void;
  // Сон дня: открыть «Здоровье» на этом дне (правка и удаление сна)
  onOpenSleep?: (day: string) => void;
};

// День календаря: предупреждение о недосыпе, сводка плашками, задачи без времени и расписание списком
const PlannerDayPanel = ({
  state, day, today, layers, variant, onShiftDay, onAdd, onOpenTask, onOpenEvent, onOpenSleep,
}: OwnProps) => {
  const lang = useLang();

  const handlePrev = useLastCallback(() => onShiftDay!(-1));
  const handleNext = useLastCallback(() => onShiftDay!(1));

  const handleDeadlineClick = useLastCallback((e: React.MouseEvent<HTMLButtonElement>) => {
    onOpenTask(e.currentTarget.dataset.id!);
  });

  // Дела дня — из индекса (построен сеткой календаря либо для одного дня)
  const entry = getDayEntry(state, day);
  const load = entry.minutes;
  const budget = getDayBudget(state, day);
  const { unrated } = entry;
  const sleep = getDailyRecord(state, 'sleep', day);
  const isShort = isShortSleep(state, day);
  const kcal = Math.round(getNutrientTotal(state, day, 'kcal').value);
  const untimed = layers.work ? entry.untimed : [];
  const deadlines = layers.work ? entry.deadlines : [];
  const title = formatDay(lang, day);
  const relative = formatRelativeDay(lang, day, today);

  const body: TeactNode = (
    <>
      {isShort && (
        <div className={styles.warn} role="note">
          <Icon name="warning" />
          {lang('PlannerSleepWarn', { sleep: formatSpan(sleep!.value), budget: formatHours(lang, budget) })}
        </div>
      )}
      <div className={styles.sumRow}>
        <span
          className={buildClassName(styles.tag, styles.tagLarge, load > budget ? styles.kindDue : styles.kindEvent)}
        >
          {lang('PlannerDayPlan', { planned: formatHoursNumber(lang, load), budget: formatHours(lang, budget) })}
        </span>
        {Boolean(unrated) && (
          <span className={buildClassName(styles.tag, styles.tagLarge, styles.kindMuted)}>
            {lang('PlannerDayUnrated', { count: unrated })}
          </span>
        )}
        {layers.sleep && sleep && variant === 'summary' && (
          <span className={buildClassName(styles.tag, styles.tagLarge, isShort ? styles.kindDue : styles.kindSleep)}>
            <Icon name="darkmode" />
            {formatSpan(sleep.value)}
          </span>
        )}
        {layers.food && Boolean(kcal) && (
          <span className={buildClassName(styles.tag, styles.tagLarge, styles.kindFood)}>
            <Icon name="eats" />
            {lang('PlannerHealthKcal', { value: lang.number(kcal) })}
          </span>
        )}
        {deadlines.map((task) => (
          <button
            key={task.id}
            type="button"
            className={buildClassName(styles.tag, styles.tagLarge, styles.tagButton, styles.kindDue)}
            data-id={task.id}
            onClick={handleDeadlineClick}
          >
            <Icon name="flag" />
            {lang('PlannerDeadlinePreview', { name: formatPlainName(task.name) })}
          </button>
        ))}
      </div>
      {Boolean(untimed.length) && (
        <div className={styles.rows}>
          {untimed.map((task) => (
            <PlannerTaskRow
              key={instanceKey(task)}
              task={task}
              context="day"
              color={getListColor(state, task.project)}
              onOpen={onOpenTask}
            />
          ))}
        </div>
      )}
      {variant !== 'summary' && (
        <PlannerDayFeed
          state={state}
          day={day}
          today={today}
          layers={layers}
          onOpenTask={onOpenTask}
          onOpenEvent={onOpenEvent}
          onOpenSleep={onOpenSleep}
        />
      )}
      {onAdd && (
        <button type="button" className={styles.btn} onClick={onAdd}>
          <Icon name="add" />
          {lang('PlannerAddForDay')}
        </button>
      )}
    </>
  );

  if (variant === 'summary') {
    return <div className={styles.daySummary} data-day-summary={day}>{body}</div>;
  }

  if (variant === 'card') {
    return (
      <section className={buildClassName(styles.card, styles.stack)} data-planner-day={day}>
        <h3 className={styles.dayCardTitle}>{`${relative}, ${title}`}</h3>
        {body}
      </section>
    );
  }

  return (
    <aside className={styles.side} data-planner-day={day}>
      <PvResizer panel="planner-side" edge="start" min={PLANNER_SIDE_MIN} max={PLANNER_SIDE_MAX} />
      <div className={styles.hdr}>
        <div className={styles.hdrText}>
          <span className={styles.hdrOver}>{relative}</span>
          <h2 className={styles.sideTitle}>{title}</h2>
        </div>
        <span className={styles.grow} />
        <button type="button" className={styles.ib} aria-label={lang('PlannerPrevDay')} onClick={handlePrev}>
          <Icon name="previous" />
        </button>
        <button type="button" className={styles.ib} aria-label={lang('PlannerNextDay')} onClick={handleNext}>
          <Icon name="next" />
        </button>
      </div>
      <div className={buildClassName(styles.content, styles.sideContent, styles.stack, 'custom-scroll')}>{body}</div>
    </aside>
  );
};

export default memo(PlannerDayPanel);
