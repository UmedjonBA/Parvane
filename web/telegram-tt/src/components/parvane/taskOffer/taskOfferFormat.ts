import type { LangFn } from '../../../util/localization';

import { formatDuration } from '../planner/plannerFormat';
import { fromDayKey, toDayKey } from '../planner/plannerModel';

type OfferWhen = { day?: string; start?: string; minutes?: number; due?: string };

function formatOfferDay(lang: LangFn, day: string, today: string) {
  const date = fromDayKey(day).toLocaleDateString(lang.code, { weekday: 'short', day: 'numeric', month: 'short' });
  return day === today ? `${lang('WeekdayToday')}, ${date}` : date;
}

/** Строка карточки под названием: день · начало · длительность · срок. */
export function formatOfferWhen(lang: LangFn, offer: OfferWhen, today = toDayKey(new Date())) {
  return [
    offer.day ? formatOfferDay(lang, offer.day, today) : undefined,
    offer.day ? offer.start : undefined,
    offer.minutes ? formatDuration(lang, offer.minutes) : undefined,
    offer.due ? lang('PlannerDueValue', { date: formatOfferDay(lang, offer.due, today) }) : undefined,
  ].filter(Boolean).join(' · ');
}
