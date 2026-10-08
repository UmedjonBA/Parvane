import { memo } from '../../../lib/teact/teact';

import type { PlannerRepeat, PlannerRepeatKind } from './plannerModel';

import { formatWeekday } from './plannerFormat';
import { MAX_REPEAT_COUNT, MAX_REPEAT_INTERVAL, PLANNER_REPEAT_KINDS } from './plannerModel';

import useLang from '../../../hooks/useLang';
import useLastCallback from '../../../hooks/useLastCallback';

import Checkbox from '../../ui/Checkbox';
import Select from '../../ui/Select';
import PlannerField from './PlannerField';

import styles from './Planner.module.scss';

// Черновик правила повтора в форме: числа — строками, как в остальных полях
export type PlannerRepeatDraft = {
  kind: PlannerRepeatKind | 'none';
  interval: string;
  weekdays: number[];
  monthDay: string;
  startDay: string;
  endKind: 'never' | 'until' | 'count';
  endDay: string;
  count: string;
};

type OwnProps = {
  value: PlannerRepeatDraft;
  // Функциональное обновление: два поля, заполненные между отрисовками, не затирают друг друга
  onChange: (update: (previous: PlannerRepeatDraft) => PlannerRepeatDraft) => void;
};

const KIND_KEYS = {
  daily: 'PlannerRepeatKindDaily',
  weekly: 'PlannerRepeatKindWeekly',
  monthly: 'PlannerRepeatKindMonthly',
  yearly: 'PlannerRepeatKindYearly',
} as const satisfies Record<PlannerRepeatKind, string>;

// Понедельник — первым; значения — как `Date.getDay`
const WEEKDAYS = [1, 2, 3, 4, 5, 6, 0];

export function emptyRepeatDraft(startDay = ''): PlannerRepeatDraft {
  return {
    kind: 'none', interval: '1', weekdays: [], monthDay: '', startDay, endKind: 'never', endDay: '', count: '',
  };
}

export function repeatToDraft(repeat: PlannerRepeat | undefined, startDay = ''): PlannerRepeatDraft {
  if (!repeat) return emptyRepeatDraft(startDay);
  return {
    kind: repeat.kind,
    interval: String(repeat.interval),
    weekdays: repeat.weekdays || [],
    monthDay: repeat.monthDay ? String(repeat.monthDay) : '',
    startDay: repeat.startDay,
    endKind: repeat.endDay ? 'until' : repeat.count ? 'count' : 'never',
    endDay: repeat.endDay || '',
    count: repeat.count ? String(repeat.count) : '',
  };
}

/** Черновик → правило; `undefined` — разовое дело. Проверка значений — `validateRepeat`. */
export function draftToRepeat(draft: PlannerRepeatDraft): PlannerRepeat | undefined {
  if (draft.kind === 'none') return undefined;
  return {
    kind: draft.kind,
    interval: draft.interval === '' ? 1 : Number(draft.interval),
    weekdays: draft.kind === 'weekly' ? draft.weekdays : undefined,
    monthDay: draft.kind === 'monthly' && draft.monthDay !== '' ? Number(draft.monthDay) : undefined,
    startDay: draft.startDay,
    endDay: draft.endKind === 'until' && draft.endDay ? draft.endDay : undefined,
    count: draft.endKind === 'count' && draft.count !== '' ? Number(draft.count) : undefined,
  };
}

// Поля правила повтора (spec 011): вид, шаг, дни недели или число, начало и конец ряда
const PlannerRepeatFields = ({ value, onChange }: OwnProps) => {
  const lang = useLang();

  const set = useLastCallback((patch: Partial<PlannerRepeatDraft>) => {
    onChange((previous) => ({ ...previous, ...patch }));
  });

  const handleKind = useLastCallback((e: React.ChangeEvent<HTMLSelectElement>) => {
    set({ kind: e.currentTarget.value as PlannerRepeatDraft['kind'] });
  });

  const handleEndKind = useLastCallback((e: React.ChangeEvent<HTMLSelectElement>) => {
    set({ endKind: e.currentTarget.value as PlannerRepeatDraft['endKind'] });
  });

  const handleWeekdayToggle = useLastCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const weekday = Number(e.currentTarget.value);
    set({
      weekdays: e.currentTarget.checked
        ? [...value.weekdays, weekday] : value.weekdays.filter((item) => item !== weekday),
    });
  });

  const handleInterval = useLastCallback((interval: string) => set({ interval }));
  const handleMonthDay = useLastCallback((monthDay: string) => set({ monthDay }));
  const handleStartDay = useLastCallback((startDay: string) => set({ startDay }));
  const handleEndDay = useLastCallback((endDay: string) => set({ endDay }));
  const handleCount = useLastCallback((count: string) => set({ count }));

  return (
    <div className={styles.repeat} data-repeat-kind={value.kind}>
      <Select label={lang('PlannerRepeatLabel')} value={value.kind} hasArrow onChange={handleKind}>
        <option value="none">{lang('PlannerRepeatKindNone')}</option>
        {PLANNER_REPEAT_KINDS.map((kind) => <option key={kind} value={kind}>{lang(KIND_KEYS[kind])}</option>)}
      </Select>
      {value.kind !== 'none' && (
        <>
          <div className={styles.fields}>
            <PlannerField
              label={lang('PlannerRepeatInterval')}
              type="number"
              value={value.interval}
              min={1}
              max={MAX_REPEAT_INTERVAL}
              step={1}

              onInput={handleInterval}
            />
            {value.kind === 'monthly' && (
              <PlannerField
                label={lang('PlannerRepeatMonthDay')}
                type="number"
                value={value.monthDay}
                min={1}
                max={31}
                step={1}
                placeholder={lang('PlannerRepeatMonthDayFromStart')}

                onInput={handleMonthDay}
              />
            )}
            <PlannerField
              label={lang('PlannerRepeatStart')}
              type="date"
              value={value.startDay}

              onInput={handleStartDay}
            />
          </div>
          {value.kind === 'weekly' && (
            <div className={styles.weekdays}>
              {WEEKDAYS.map((weekday) => (
                <Checkbox
                  key={weekday}
                  value={String(weekday)}
                  label={formatWeekday(lang, (weekday + 6) % 7)}
                  checked={value.weekdays.includes(weekday)}

                  onChange={handleWeekdayToggle}
                />
              ))}
            </div>
          )}
          <div className={styles.fields}>
            <Select
              label={lang('PlannerRepeatEnd')}
              value={value.endKind}
              hasArrow

              onChange={handleEndKind}
            >
              <option value="never">{lang('PlannerRepeatEndNever')}</option>
              <option value="until">{lang('PlannerRepeatEndUntil')}</option>
              <option value="count">{lang('PlannerRepeatEndCount')}</option>
            </Select>
            {value.endKind === 'until' && (
              <PlannerField
                label={lang('PlannerRepeatEndDate')}
                type="date"
                value={value.endDay}

                onInput={handleEndDay}
              />
            )}
            {value.endKind === 'count' && (
              <PlannerField
                label={lang('PlannerRepeatCount')}
                type="number"
                value={value.count}
                min={1}
                max={MAX_REPEAT_COUNT}
                step={1}

                onInput={handleCount}
              />
            )}
          </div>
        </>
      )}
    </div>
  );
};

export default memo(PlannerRepeatFields);
