// Расписание на неделю текстом → еженедельные события «Плана» (16 окт 2026, просьба пользователя).
// Строка с днём недели («Понедельник», «Пн», «Monday», «Mon», можно с двоеточием или «— свободна») открывает день;
// строки «ЧЧ:ММ–ЧЧ:ММ Название, подробности» под ним — события. Дата конца — «до 15.12.2026» (или «до 2026-12-15»,
// «until …») в любом месте текста. Название — до первой запятой, остальное — описание.

import type { PlannerEvent } from './plannerModel';

import { newId, toMinutes, validateRepeat } from './plannerModel';

export type ScheduleItem = { weekday: number; start: string; end: string; name: string; description?: string };

export type ParsedSchedule = {
  items: ScheduleItem[];
  // Дата конца из текста (`YYYY-MM-DD`), если есть
  endDay?: string;
  // Строки со временем, которые не удалось отнести к дню или разобрать
  skipped: string[];
};

// Дни недели как у `Date.getDay`: 0 — воскресенье. Граница слова — явная: `\b` в JS не видит кириллицу
const WEEKDAY_END = '(?=$|[\\s:,.;—–-])';
const WEEKDAY_WORDS: [RegExp, number][] = ([
  ['понедельник|пн|monday|mon', 1],
  ['вторник|вт|tuesday|tues|tue', 2],
  ['среда|ср|wednesday|wed', 3],
  ['четверг|чт|thursday|thurs|thu', 4],
  ['пятница|пт|friday|fri', 5],
  ['суббота|сб|saturday|sat', 6],
  ['воскресенье|вс|sunday|sun', 0],
] as const).map(([words, day]) => [new RegExp(`^(${words})${WEEKDAY_END}[\\s:,.;—–-]*`, 'i'), day]);
const TIME_RANGE = /^(\d{1,2})[:.](\d{2})\s*[-–—]\s*(\d{1,2})[:.](\d{2})\s*(.*)$/;
const END_DOTTED = /(?:^|\s)(?:до|until|till)\s+(\d{1,2})\.(\d{1,2})\.(\d{4})/i;
const END_ISO = /(?:^|\s)(?:до|until|till)\s+(\d{4})-(\d{2})-(\d{2})/i;
const MAX_NAME_LENGTH = 200;

export function parseSchedule(text: string): ParsedSchedule {
  const items: ScheduleItem[] = [];
  const skipped: string[] = [];
  let weekday: number | undefined;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    // День недели — заголовком («Понедельник») или в начале строки со временем («Пн 10:00–11:00 …»)
    const day = matchWeekday(line);
    if (day) weekday = day.weekday;
    const range = TIME_RANGE.exec(day ? day.rest : line);
    if (!range) continue;
    const start = toTimeString(range[1], range[2]);
    const end = toTimeString(range[3], range[4]);
    const title = range[5].trim();
    if (weekday === undefined || !start || !end || toMinutes(end) <= toMinutes(start) || !title) {
      skipped.push(line);
      continue;
    }
    const comma = title.indexOf(',');
    const name = (comma > 0 ? title.slice(0, comma) : title).trim().slice(0, MAX_NAME_LENGTH);
    const description = comma > 0 ? title.slice(comma + 1).trim() || undefined : undefined;
    items.push({
      weekday, start, end, name, description,
    });
  }
  return { items, endDay: findEndDay(text), skipped };
}

/** События расписания: каждое — еженедельный ряд в свой день с `startDay` по `endDay` включительно. */
export function buildScheduleEvents(items: ScheduleItem[], startDay: string, endDay: string): PlannerEvent[] {
  return items.map((item) => ({
    id: newId(),
    name: item.name,
    description: item.description,
    start: item.start,
    end: item.end,
    repeat: {
      kind: 'weekly' as const, interval: 1, weekdays: [item.weekday], startDay, endDay,
    },
    occurrences: [],
  })).filter((event) => !validateRepeat(event.repeat));
}

function matchWeekday(line: string) {
  for (const [pattern, weekday] of WEEKDAY_WORDS) {
    const match = pattern.exec(line);
    if (match) return { weekday, rest: line.slice(match[0].length) };
  }
  return undefined;
}

function toTimeString(hours: string, minutes: string) {
  const h = Number(hours);
  const m = Number(minutes);
  if (h > 23 || m > 59) return undefined;
  return `${String(h).padStart(2, '0')}:${minutes}`;
}

function findEndDay(text: string) {
  const dotted = END_DOTTED.exec(text);
  const iso = END_ISO.exec(text);
  const [year, month, day] = dotted ? [dotted[3], dotted[2], dotted[1]] : iso ? [iso[1], iso[2], iso[3]] : [];
  if (!year) return undefined;
  const key = `${year}-${month!.padStart(2, '0')}-${day!.padStart(2, '0')}`;
  const date = new Date(`${key}T00:00:00`);
  return Number.isNaN(date.getTime()) || date.getDate() !== Number(day) ? undefined : key;
}
