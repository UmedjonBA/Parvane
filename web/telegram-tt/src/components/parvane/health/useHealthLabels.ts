import type { HealthEntry } from './healthTypes';

import { formatDate } from '../planner/plannerFormat';
import { FOOD_KIND, WORKOUT_KIND, workoutTitleKey } from './healthDayFormat';
import {
  dayRelation, entryClock, formatNumber, formatValue, kindTitleKey, splitDuration, unitKey,
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

  const entryValue = useLastCallback((entry: HealthEntry) => {
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
    lang, kindTitle, unitTitle, dayTitle, duration, entryValue, entryWhen,
  };
}
