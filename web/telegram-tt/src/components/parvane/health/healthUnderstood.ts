import type { HealthParsedEntry } from './healthTypes';

import { dayRelation } from './healthFormat';

// Parvane (доски `PlusModes`, `DeskOverlays`): «Понято как …» — чем разобранная строка ляжет в «Здоровье».
// Чистая часть: сравнение ночи с целью сна и день ночи словом

// Отклонение меньше этого — «ровно по цели»
const ON_GOAL_SLACK_MIN = 5;
const MINUTES_IN_DAY = 1440;
const HALF_DAY_MIN = MINUTES_IN_DAY / 2;

export type SleepVerdict = {
  // День пробуждения относительно сегодняшнего
  night: 'today' | 'yesterday' | 'date';
  // Длительность против цели: минуты (меньше нуля — короче), `undefined` — цели нет
  totalDelta?: number;
  // Отбой против цели отбоя: минуты (больше нуля — позже), `undefined` — цели нет либо разница мала
  bedDelta?: number;
};

/** Ночь со временем «лёг — встал» против целей сна; у отметки и длительности без времени — только длительность. */
export function buildSleepVerdict(
  entry: HealthParsedEntry, today: string, goalMinutes?: number, goalBedMin?: number,
): SleepVerdict {
  const wakeDay = entry.endDay || entry.day;
  const totalDelta = goalMinutes ? roundSlack(entry.value - goalMinutes) : undefined;
  const bedMin = entry.endMs ? parseClockMinutes(entry.time) : undefined;
  const bedDelta = goalBedMin === undefined || bedMin === undefined
    ? undefined
    : roundSlack(wrapDay(bedMin - goalBedMin));
  return {
    night: dayRelation(wakeDay, today),
    totalDelta,
    bedDelta: bedDelta || undefined,
  };
}

/** Строка — одна запись сна со временем либо длительностью: для неё показывается раскладка «Отбой / Подъём / Всего». */
export function isSleepSpan(entry: HealthParsedEntry) {
  return entry.kind === 'sleep' && entry.endMs > entry.atMs && Boolean(entry.endTime);
}

function roundSlack(delta: number) {
  return Math.abs(delta) < ON_GOAL_SLACK_MIN ? 0 : Math.round(delta);
}

// Разница времени суток — в пределах ±12 часов (отбой 00:10 против цели 23:40 — на 30 минут позже)
function wrapDay(delta: number) {
  if (delta > HALF_DAY_MIN) return delta - MINUTES_IN_DAY;
  if (delta < -HALF_DAY_MIN) return delta + MINUTES_IN_DAY;
  return delta;
}

function parseClockMinutes(time: string) {
  const match = /^(\d{1,2}):(\d{2})$/.exec(time);
  return match ? Number(match[1]) * 60 + Number(match[2]) : undefined;
}
