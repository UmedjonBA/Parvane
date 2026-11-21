import { memo, useMemo } from '../../../lib/teact/teact';

import type { PlannerRepeat, PlannerRepeatKind } from './plannerModel';

import buildClassName from '../../../util/buildClassName';
import { formatRepeat, formatWeekday } from './plannerFormat';
import {
  MAX_REPEAT_COUNT, MAX_REPEAT_INTERVAL, PLANNER_REPEAT_KINDS, validateRepeat,
} from './plannerModel';

import useLang from '../../../hooks/useLang';
import useLastCallback from '../../../hooks/useLastCallback';

import PvSegment from '../notes/PvSegment';
import PlannerField from './PlannerField';

import kit from '../notes/PvKit.module.scss';
import styles from './Planner.module.scss';
import more from './PlannerEditor.module.scss';

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
  daily: 'PlannerRepeatSegDay',
  weekly: 'PlannerRepeatSegWeek',
  monthly: 'PlannerRepeatSegMonth',
  yearly: 'PlannerRepeatSegYear',
} as const satisfies Record<PlannerRepeatKind, string>;

const END_KINDS: { value: PlannerRepeatDraft['endKind']; key: 'PlannerRepeatEndNever' | 'PlannerRepeatEndOnDate'
  | 'PlannerRepeatEndTimes'; }[] = [
  { value: 'never', key: 'PlannerRepeatEndNever' },
  { value: 'until', key: 'PlannerRepeatEndOnDate' },
  { value: 'count', key: 'PlannerRepeatEndTimes' },
];

// Подпись шага называет единицу: «Повторять каждые (недель)»
const INTERVAL_KEYS = {
  none: 'PlannerRepeatIntervalDays',
  daily: 'PlannerRepeatIntervalDays',
  weekly: 'PlannerRepeatIntervalWeeks',
  monthly: 'PlannerRepeatIntervalMonths',
  yearly: 'PlannerRepeatIntervalYears',
} as const satisfies Record<PlannerRepeatDraft['kind'], string>;

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

// Поля правила повтора (spec 011; вид — доска `DkPlanMore`): вид переключателем «Нет / День / Неделя / Месяц / Год»,
// дни недели чипами, конец ряда чипами; шаг, число месяца и начало ряда — второй строкой
const PlannerRepeatFields = ({ value, onChange }: OwnProps) => {
  const lang = useLang();

  // Правило словами — как оно будет показано у дела; негодный черновик не описывается
  const repeat = draftToRepeat(value);
  const summary = repeat && !validateRepeat(repeat) ? formatRepeat(lang, repeat) : undefined;

  const kinds = useMemo(() => [
    { value: 'none' as const, label: lang('PlannerRepeatSegNone') },
    ...PLANNER_REPEAT_KINDS.map((kind) => ({ value: kind, label: lang(KIND_KEYS[kind]) })),
  ], [lang]);

  const set = useLastCallback((patch: Partial<PlannerRepeatDraft>) => {
    onChange((previous) => ({ ...previous, ...patch }));
  });

  const handleKind = useLastCallback((kind: PlannerRepeatDraft['kind']) => {
    set({ kind });
  });

  const handleEndKind = useLastCallback((e: React.MouseEvent<HTMLButtonElement>) => {
    set({ endKind: e.currentTarget.dataset.repeatEnd as PlannerRepeatDraft['endKind'] });
  });

  const handleWeekdayToggle = useLastCallback((e: React.MouseEvent<HTMLButtonElement>) => {
    const weekday = Number(e.currentTarget.dataset.weekday);
    // От прежнего черновика, а не от пропса: два дня, отмеченные между отрисовками, не затирают друг друга
    onChange((previous) => {
      const rest = previous.weekdays.filter((item) => item !== weekday);
      return { ...previous, weekdays: previous.weekdays.includes(weekday) ? rest : [...rest, weekday] };
    });
  });

  const handleInterval = useLastCallback((interval: string) => set({ interval }));
  const handleMonthDay = useLastCallback((monthDay: string) => set({ monthDay }));
  const handleStartDay = useLastCallback((startDay: string) => set({ startDay }));
  const handleEndDay = useLastCallback((endDay: string) => set({ endDay }));
  const handleCount = useLastCallback((count: string) => set({ count }));

  return (
    <div className={styles.repeat} data-repeat-kind={value.kind}>
      <PvSegment
        items={kinds}
        value={value.kind}
        label={lang('PlannerRepeatLabel')}
        className={more.repeatKinds}
        onChange={handleKind}
      />
      {value.kind === 'weekly' && (
        <div
          className={buildClassName(kit.chips, more.weekdays)}
          role="group"
          aria-label={lang('PlannerRepeatWeekdays')}
        >
          {WEEKDAYS.map((weekday) => {
            const isOn = value.weekdays.includes(weekday);
            return (
              <button
                key={weekday}
                type="button"
                className={buildClassName(kit.chip, more.weekday, isOn && kit.chipOn)}
                aria-pressed={isOn}
                data-weekday={weekday}
                onClick={handleWeekdayToggle}
              >
                {formatWeekday(lang, (weekday + 6) % 7)}
              </button>
            );
          })}
        </div>
      )}
      {value.kind !== 'none' && (
        <>
          <div className={more.repeatEnd} role="group" aria-label={lang('PlannerRepeatEnd')}>
            <span className={more.repeatEndLabel}>{lang('PlannerRepeatEndLabel')}</span>
            {END_KINDS.map((item) => (
              <button
                key={item.value}
                type="button"
                className={buildClassName(kit.chip, value.endKind === item.value && kit.chipOn)}
                aria-pressed={value.endKind === item.value}
                data-repeat-end={item.value}
                onClick={handleEndKind}
              >
                {lang(item.key)}
              </button>
            ))}
          </div>
          <div className={styles.fields}>
            <PlannerField
              label={lang(INTERVAL_KEYS[value.kind])}
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
          {summary && <p className={styles.small} data-repeat-summary>{summary}</p>}
        </>
      )}
    </div>
  );
};

export default memo(PlannerRepeatFields);
