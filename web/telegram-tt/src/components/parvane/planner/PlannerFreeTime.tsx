import { memo, useMemo, useState } from '../../../lib/teact/teact';

import type { PlannerState } from './plannerModel';
import type { FreeSlot, FreeTimePart, FreeTimeResult } from './plannerTools';

import buildClassName from '../../../util/buildClassName';
import {
  formatDate, formatDay, formatDuration, formatSpan,
} from './plannerFormat';
import { addDays, fromDayKey, toTime } from './plannerModel';
import { findFreeTime, FREE_TIME_DAYS } from './plannerTools';

import useFlag from '../../../hooks/useFlag';
import useLang from '../../../hooks/useLang';
import useLastCallback from '../../../hooks/useLastCallback';
import useWindowSize from '../../../hooks/window/useWindowSize';

import PvSheet from '../notes/PvSheet';
import { PlannerCardRow } from './PlannerCardRow';

import kit from '../notes/PvKit.module.scss';
import styles from './PlannerMore.module.scss';

type OwnProps = {
  state: PlannerState;
  name: string;
  // Длительность записи; нет — окно не ищется
  minutes?: number;
  // С какого дня искать (не раньше сегодня)
  fromDay: string;
  today: string;
  // Сама запись (её место в дне не считается занятым)
  exceptKey?: string;
  onPick: (day: string, start: number, end: number) => void;
};

const PARTS: { value: FreeTimePart; key: 'PlannerFreeTimeAny' | 'PlannerFreeTimeMorning' | 'PlannerFreeTimeEvening'
  | 'PlannerFreeTimeWeekend'; }[] = [
  { value: 'any', key: 'PlannerFreeTimeAny' },
  { value: 'morning', key: 'PlannerFreeTimeMorning' },
  { value: 'evening', key: 'PlannerFreeTimeEvening' },
  { value: 'weekend', key: 'PlannerFreeTimeWeekend' },
];
const FIRST_LIMIT = 3;
const MORE_STEP = 3;
const MINUTES_IN_HOUR = 60;
// Ширина, до которой «План» — одна колонка (`Planner.module.scss`)
const NARROW_WIDTH = 925;
const EMPTY_RESULT: FreeTimeResult = { slots: [], total: 0 };

// «Найти свободное время» (доски `ZpPlanX`, `DkPlanMore`): окна считает движок (`plannerFreeTime`). На компьютере —
// блок в карточке записи, на телефоне — кнопка и шторка
const PlannerFreeTime = ({
  state, name, minutes, fromDay, today, exceptKey, onPick,
}: OwnProps) => {
  const lang = useLang();
  const [part, setPart] = useState<FreeTimePart>('any');
  const [limit, setLimit] = useState(FIRST_LIMIT);
  const [days, setDays] = useState(FREE_TIME_DAYS);
  const [isSheetOpen, openSheet, closeSheet] = useFlag();
  const { width } = useWindowSize();
  const isNarrow = width <= NARROW_WIDTH;
  const isShown = !isNarrow || isSheetOpen;
  const base = fromDay > today ? fromDay : today;

  const result = useMemo(() => {
    if (!isShown || !minutes) return EMPTY_RESULT;
    const now = new Date();
    try {
      return findFreeTime({
        state,
        minutes,
        fromDay: base,
        days,
        part,
        limit,
        today,
        nowMinute: now.getHours() * MINUTES_IN_HOUR + now.getMinutes(),
        exceptKey,
      });
    } catch (err) {
      // Движок ещё не поднялся (снимок с устройства): окон просто нет
      return EMPTY_RESULT;
    }
  }, [isShown, minutes, state, base, days, part, limit, today, exceptKey]);

  const lastDay = addDays(base, days - 1);

  const handlePart = useLastCallback((e: React.MouseEvent<HTMLButtonElement>) => {
    setPart(e.currentTarget.dataset.part as FreeTimePart);
    setLimit(FIRST_LIMIT);
  });

  const handleMore = useLastCallback(() => {
    setLimit((current) => current + MORE_STEP);
  });

  const handleFurther = useLastCallback(() => {
    setDays((current) => current + FREE_TIME_DAYS);
  });

  const handlePick = useLastCallback((e: React.MouseEvent<HTMLButtonElement>) => {
    const slot = result.slots[Number(e.currentTarget.dataset.index)];
    closeSheet();
    onPick(slot.day, slot.start, slot.end);
  });

  function describeSlot(slot: FreeSlot) {
    if (slot.isFreeAfter) return lang('PlannerFreeTimeFreeAfter');
    if (slot.isBeforeFirst) return lang('PlannerFreeTimeBeforeFirst');
    return lang('PlannerFreeTimeLoad', { load: formatSpan(slot.load), budget: formatSpan(slot.budget) });
  }

  function renderBody() {
    if (!minutes) return <p className={styles.hint}>{lang('PlannerErrorNeedMinutes')}</p>;
    return (
      <>
        <p className={styles.hint}>
          {lang('PlannerFreeTimeHint', {
            name,
            duration: formatDuration(lang, minutes),
            date: formatDay(lang, lastDay),
            margin: state.settings.margin,
          })}
        </p>
        <div className={styles.slots} aria-live="polite">
          {result.slots.map((slot, index) => {
            const date = fromDayKey(slot.day);
            const label = `${formatDate(lang.code, date, { weekday: 'short' })} ${date.getDate()} · `
              + `${toTime(slot.start)}–${toTime(slot.end)}`;
            return (
              <div key={`${slot.day}${slot.start}`} className={styles.slot} data-free-slot={slot.day}>
                <span className={kit.rowText}>
                  <span className={buildClassName(kit.ttl, kit.mono)}>{label}</span>
                  <span className={kit.sub}>{describeSlot(slot)}</span>
                </span>
                <button type="button" className={kit.chip} data-index={index} onClick={handlePick}>
                  {lang('PlannerFreeTimePick')}
                </button>
              </div>
            );
          })}
          {!result.slots.length && (
            <p className={styles.hint} data-free-none>
              {lang('PlannerFreeTimeNone', { date: formatDay(lang, lastDay) })}
            </p>
          )}
        </div>
        <div className={kit.chips} role="group" aria-label={lang('PlannerFreeTimeTitle')}>
          {PARTS.map((item) => (
            <button
              key={item.value}
              type="button"
              className={buildClassName(kit.chip, part === item.value && kit.chipOn)}
              aria-pressed={part === item.value}
              data-part={item.value}
              onClick={handlePart}
            >
              {lang(item.key)}
            </button>
          ))}
        </div>
        {result.total > result.slots.length && (
          <button type="button" className={buildClassName(kit.btn, styles.wide)} onClick={handleMore}>
            {lang('PlannerFreeTimeMore')}
          </button>
        )}
        {!result.slots.length && (
          <button
            type="button"
            className={buildClassName(kit.btn, styles.wide)}
            data-free-further
            onClick={handleFurther}
          >
            {lang('PlannerFreeTimeFurther')}
          </button>
        )}
      </>
    );
  }

  if (!isNarrow) {
    return (
      <PlannerCardRow icon="search" row="slots">
        <div className={styles.freeTime} data-free-time>
          <h4 className={kit.grp}>{lang('PlannerFreeTimeTitle')}</h4>
          {renderBody()}
        </div>
      </PlannerCardRow>
    );
  }

  return (
    <PlannerCardRow icon="search" row="slots">
      <button type="button" className={kit.btn} data-free-time-open onClick={openSheet}>
        {lang('PlannerFreeTimeTitle')}
      </button>
      <PvSheet isOpen={isSheetOpen} title={lang('PlannerFreeTimeTitle')} onClose={closeSheet}>
        <div className={styles.freeTime} data-free-time>{renderBody()}</div>
      </PvSheet>
    </PlannerCardRow>
  );
};

export default memo(PlannerFreeTime);
