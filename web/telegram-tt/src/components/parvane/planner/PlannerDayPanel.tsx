import { memo } from '../../../lib/teact/teact';

import type { PlannerLayers } from './plannerLayers';
import type { PlannerState } from './plannerModel';

import buildClassName from '../../../util/buildClassName';
import { formatDayLong } from './plannerFormat';
import { getDayBudget } from './plannerHealth';
import { getDayEntry } from './plannerModel';

import useLang from '../../../hooks/useLang';

import PlannerDayList from './PlannerDayList';
import PlannerDayTags from './PlannerDayTags';
import PlannerLoad from './PlannerLoad';

import pv from './PlannerPv.module.scss';

type OwnProps = {
  state: PlannerState;
  day: string;
  today: string;
  layers: PlannerLayers;
  // `rail` — левая колонка компьютера (загрузка и дела выбранного дня, доска `DeskPlan`), `list` — день под
  // сеткой месяца на телефоне (доска `PhPlanMore`)
  variant: 'rail' | 'list';
  onOpenTask: (taskId: string, day?: string) => void;
  onOpenEvent: (eventId: string, day: string) => void;
};

// Выбранный день календаря. Компьютер: загрузка полосой, метки дня, «Задачи на сегодня» одним списком с
// галочкой слева. Телефон: подпись дня и плотный список «время · название · длительность»
const PlannerDayPanel = ({
  state, day, today, layers, variant, onOpenTask, onOpenEvent,
}: OwnProps) => {
  const lang = useLang();

  // Дела дня — из индекса (построен сеткой календаря либо для одного дня)
  const entry = getDayEntry(state, day);
  const isRail = variant === 'rail';

  return (
    <section className={isRail ? pv.railDay : pv.dayList} data-planner-day={day}>
      {!isRail && <h3 className={buildClassName(pv.cap, pv.capFlush)}>{formatDayLong(lang, day)}</h3>}
      {isRail && (
        <>
          <PlannerLoad
            title={lang('PlannerTodayLoad')}
            minutes={entry.minutes}
            budget={getDayBudget(state, day)}
            isCaption
          />
          <PlannerDayTags state={state} day={day} layers={layers} onOpenTask={onOpenTask} />
          <h3 className={buildClassName(pv.cap, pv.capFlush)}>
            {day === today ? lang('PlannerRailToday') : formatDayLong(lang, day)}
          </h3>
        </>
      )}
      <div className={isRail ? undefined : pv.dayCard}>
        <PlannerDayList
          state={state}
          day={day}
          entry={entry}
          variant={variant}
          onOpenTask={onOpenTask}
          onOpenEvent={onOpenEvent}
        />
      </div>
    </section>
  );
};

export default memo(PlannerDayPanel);
