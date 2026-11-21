import { memo, useMemo } from '../../../lib/teact/teact';

import type { PlannerLayers } from './plannerLayers';
import type { PlannerState } from './plannerModel';

import buildClassName from '../../../util/buildClassName';
import { formatDayLong, formatMonth, formatWeekNumber } from './plannerFormat';
import {
  fromDayKey, getMonthGridKeys, getUndatedTasks, getWeekKeys,
} from './plannerModel';

import useLang from '../../../hooks/useLang';
import useLastCallback from '../../../hooks/useLastCallback';

import PlannerDayPanel from './PlannerDayPanel';

import pv from './PlannerPv.module.scss';

type OwnProps = {
  state: PlannerState;
  picked: string;
  today: string;
  layers: PlannerLayers;
  onPickDay: (day: string) => void;
  onOpenTask: (taskId: string, day?: string) => void;
  onOpenEvent: (eventId: string, day: string) => void;
  onOpenUndated: NoneToVoidFunction;
};

// Левая колонка «Плана» на компьютере (доска `DeskPlan`): месяц с выбранной неделей, загрузка и дела
// выбранного дня одним списком, внизу — «Без даты · N» (всегда, и при нуле). Запись добавляется полем в шапке
const PlannerRail = ({
  state, picked, today, layers, onPickDay, onOpenTask, onOpenEvent, onOpenUndated,
}: OwnProps) => {
  const lang = useLang();

  const monthKey = picked.slice(0, 7);
  const days = useMemo(() => {
    const date = fromDayKey(`${monthKey}-01`);
    return getMonthGridKeys(new Date(date.getFullYear(), date.getMonth(), 1));
  }, [monthKey]);
  const week = useMemo(() => getWeekKeys(picked), [picked]);
  const undatedCount = useMemo(() => getUndatedTasks(state).length, [state]);

  const handleDayClick = useLastCallback((e: React.MouseEvent<HTMLButtonElement>) => {
    onPickDay(e.currentTarget.dataset.miniDay!);
  });

  return (
    <aside className={buildClassName(pv.rail, 'custom-scroll')} data-planner-rail>
      <div>
        <div className={pv.miniHead}>
          <span className={pv.miniTitle}>{formatMonth(lang, fromDayKey(`${monthKey}-01`))}</span>
          <span className={pv.miniWeek}>{lang('PlannerWeekShort', { week: formatWeekNumber(picked) })}</span>
        </div>
        <div className={pv.miniGrid} data-planner-mini>
          {days.map((day) => (
            <button
              key={day}
              type="button"
              className={buildClassName(
                pv.miniDay,
                !day.startsWith(monthKey) && pv.miniDayOutside,
                week.includes(day) && pv.miniDayWeek,
                day === today && pv.miniDayToday,
                day === picked && pv.miniDayPicked,
              )}
              aria-label={formatDayLong(lang, day)}
              aria-pressed={day === picked}
              data-mini-day={day}
              onClick={handleDayClick}
            >
              {fromDayKey(day).getDate()}
            </button>
          ))}
        </div>
      </div>
      <PlannerDayPanel
        state={state}
        day={picked}
        today={today}
        layers={layers}
        variant="rail"
        onOpenTask={onOpenTask}
        onOpenEvent={onOpenEvent}
      />
      <div className={pv.railFoot}>
        <button type="button" className={pv.wideButton} data-today-undated onClick={onOpenUndated}>
          {lang('PlannerUndated', { count: undatedCount })}
        </button>
      </div>
    </aside>
  );
};

export default memo(PlannerRail);
