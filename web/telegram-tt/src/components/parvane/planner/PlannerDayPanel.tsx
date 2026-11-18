import { memo } from '../../../lib/teact/teact';

import type { PlannerLayers } from './plannerLayers';
import type { PlannerState } from './plannerModel';

import buildClassName from '../../../util/buildClassName';
import { formatDayLong, formatRelativeDay } from './plannerFormat';
import { getDayBudget } from './plannerHealth';
import { getDayEntry, getListColor, instanceKey } from './plannerModel';

import useLang from '../../../hooks/useLang';

import Icon from '../../common/icons/Icon';
import PlannerDayFeed from './PlannerDayFeed';
import PlannerDayTags from './PlannerDayTags';
import PlannerLoad from './PlannerLoad';
import PlannerTaskRow from './PlannerTaskRow';

import styles from './Planner.module.scss';
import pv from './PlannerPv.module.scss';

type OwnProps = {
  state: PlannerState;
  day: string;
  today: string;
  layers: PlannerLayers;
  // `rail` — левая колонка компьютера (загрузка и дела выбранного дня), `list` — день под сеткой месяца
  // на телефоне
  variant: 'rail' | 'list';
  onAdd?: NoneToVoidFunction;
  onOpenTask: (taskId: string, day?: string) => void;
  onOpenEvent: (eventId: string, day: string) => void;
  // Сон дня: открыть «Здоровье» на этом дне (правка и удаление сна)
  onOpenSleep?: (day: string) => void;
};

// Выбранный день календаря: загрузка полосой, метки дня, задачи без времени и расписание списком
const PlannerDayPanel = ({
  state, day, today, layers, variant, onAdd, onOpenTask, onOpenEvent, onOpenSleep,
}: OwnProps) => {
  const lang = useLang();

  // Дела дня — из индекса (построен сеткой календаря либо для одного дня)
  const entry = getDayEntry(state, day);
  const untimed = layers.work ? entry.untimed : [];
  const isRail = variant === 'rail';

  return (
    <section className={isRail ? pv.railDay : pv.dayList} data-planner-day={day}>
      {!isRail && <h3 className={buildClassName(pv.cap, pv.capFlush)}>{formatDayLong(lang, day)}</h3>}
      <PlannerLoad
        title={isRail ? lang('PlannerTodayLoad') : formatRelativeDay(lang, day, today)}
        minutes={entry.minutes}
        budget={getDayBudget(state, day)}
        isCaption={isRail}
      />
      <PlannerDayTags state={state} day={day} layers={layers} onOpenTask={onOpenTask} />
      {isRail && (
        <h3 className={buildClassName(pv.cap, pv.capFlush)}>
          {day === today ? lang('PlannerRailToday') : formatDayLong(lang, day)}
        </h3>
      )}
      <div className={isRail ? styles.rowsPlain : pv.dayCard}>
        {untimed.map((task) => (
          <PlannerTaskRow
            key={instanceKey(task)}
            task={task}
            context="day"
            color={getListColor(state, task.project)}
            onOpen={onOpenTask}
          />
        ))}
        <PlannerDayFeed
          state={state}
          day={day}
          today={today}
          layers={layers}
          onOpenTask={onOpenTask}
          onOpenEvent={onOpenEvent}
          onOpenSleep={onOpenSleep}
        />
      </div>
      {onAdd && (
        <button type="button" className={pv.wideButton} onClick={onAdd}>
          <Icon name="add" />
          {lang('PlannerAddForDay')}
        </button>
      )}
    </section>
  );
};

export default memo(PlannerDayPanel);
