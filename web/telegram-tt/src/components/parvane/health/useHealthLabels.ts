import type { HealthEntry } from './healthTypes';

import { formatDate } from '../planner/plannerFormat';
import { FOOD_KIND, WORKOUT_KIND, workoutTitleKey } from './healthDayFormat';
import {
  dayRelation, entryClock, formatNumber, formatValue, kindTitleKey, MOOD_KIND, MS_IN_DAY, NO_SLEEP_TAG, splitDuration,
  unitKey,
} from './healthFormat';

import useLang from '../../../hooks/useLang';
import useLastCallback from '../../../hooks/useLastCallback';

// Parvane (spec 038): подписи «Здоровья» на языке интерфейса — название вида, единица, день, длительность
export default function useHealthLabels(today: string) {
  const lang = useLang();

  const kindTitle = useLastCallback((kind: string) => {
    const key = kindTitleKey(kind);
    return key ? lang(key) : kind;
  });

  const unitTitle = useLastCallback((unit: string) => {
    const key = unitKey(unit);
    return key ? lang(key) : '';
  });

  const dayTitle = useLastCallback((day: string) => {
    const relation = dayRelation(day, today);
    if (relation === 'today') return lang('HealthToday');
    if (relation === 'yesterday') return lang('HealthYesterday');
    return formatDate(lang.code, new Date(`${day}T12:00:00`), { day: 'numeric', month: 'short' });
  });

  const duration = useLastCallback((minutes: number) => {
    const parts = splitDuration(minutes);
    return lang('HealthDuration', { hours: parts.hours, minutes: parts.minutes });
  });

  // Короткая длительность без «0 ч»: «35 мин», «1 ч 35 мин», «2 ч»
  const shortDuration = useLastCallback((minutes: number) => {
    const parts = splitDuration(Math.abs(minutes));
    const hours = parts.hours ? `${parts.hours} ${lang('HealthUnitHour')}` : '';
    const rest = parts.minutes || !parts.hours ? `${parts.minutes} ${lang('HealthUnitMin')}` : '';
    return [hours, rest].filter(Boolean).join(' ');
  });

  // День словом: «Сегодня», «Вчера», в пределах недели — день недели, раньше — дата; `withDate` дописывает дату
  const dayWord = useLastCallback((day: string, withDate?: boolean) => {
    const relation = dayRelation(day, today);
    const date = new Date(`${day}T12:00:00`);
    const dateText = formatDate(lang.code, date, { day: 'numeric', month: 'long' });
    if (relation === 'today') return capitalize(lang('HealthToday'));
    if (relation === 'yesterday') return capitalize(lang('HealthYesterday'));
    if (!isWithinWeek(day, today)) return withDate ? dateText : formatDate(lang.code, date, DAY_SHORT);
    const weekday = capitalize(formatDate(lang.code, date, { weekday: 'long' }));
    return withDate ? `${weekday}, ${dateText}` : weekday;
  });

  // «Сегодня, 07:20»
  const entryTitle = useLastCallback((entry: HealthEntry, withDate?: boolean) => (
    `${dayWord(entry.day, withDate)}, ${entryClock(entry)}`
  ));

  const entryValue = useLastCallback((entry: HealthEntry) => {
    if (entry.kind === MOOD_KIND) return lang('HealthMoodScore', { value: Math.round(entry.value) });
    if (entry.kind === 'sleep' && entry.endMs > entry.atMs) {
      return `${entryClock(entry)} → ${entryClock({ atMs: entry.endMs, tzMin: entry.tzMin })}`;
    }
    if (entry.kind === 'sleep' && entry.tag === NO_SLEEP_TAG) return lang('HealthSleepNoSleep');
    if (entry.kind === 'sleep') {
      return duration(entry.endMs > entry.atMs ? (entry.endMs - entry.atMs) / 60000 : entry.value);
    }
    if (entry.kind === 'sleep_start' || entry.kind === 'sleep_end') return entryClock(entry);
    if (entry.kind === FOOD_KIND) {
      const kcal = lang('HealthKcalValue', { value: formatNumber(entry.value, lang.code) });
      return entry.name ? `${entry.name} · ${kcal}` : kcal;
    }
    if (entry.kind === WORKOUT_KIND) {
      const pieces = [entry.name || lang(workoutTitleKey(entry.tag))];
      if (entry.value > 0) pieces.push(duration(entry.value));
      if (entry.parts.km !== undefined) {
        pieces.push(lang('HealthKmValue', { value: formatNumber(entry.parts.km, lang.code) }));
      }
      return pieces.join(' · ');
    }
    const unit = unitTitle(entry.unit);
    return unit ? `${formatValue(entry, lang.code)} ${unit}` : formatValue(entry, lang.code);
  });

  const entryWhen = useLastCallback((entry: HealthEntry) => `${dayTitle(entry.day)}, ${entryClock(entry)}`);

  return {
    lang, kindTitle, unitTitle, dayTitle, dayWord, duration, shortDuration, entryValue, entryWhen, entryTitle,
  };
}

const DAY_SHORT = { day: 'numeric', month: 'short' } as const;
const WEEK_DAYS = 7;

function isWithinWeek(day: string, today: string) {
  const days = (Date.parse(`${today}T12:00:00Z`) - Date.parse(`${day}T12:00:00Z`)) / MS_IN_DAY;
  return days >= 0 && days < WEEK_DAYS;
}

function capitalize(text: string) {
  return text.charAt(0).toUpperCase() + text.slice(1);
}
