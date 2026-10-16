import { describe, expect, it } from 'vitest';

import type {
  PlannerEvent, PlannerHealthRecord, PlannerRepeat, PlannerState, PlannerTask,
} from './plannerModel';

import {
  getDailyRecord, getLatestRecord, getWorkouts,
} from './plannerHealth';
import {
  addDays, countConflicts, countUnrated, createEmptyPlannerState, expandRepeat, getDayEntry, getDayIndex,
  getDayLoad, getDeadlines, getEventsForDay, getTasksForDay, getTimedForDay, hasInstanceOn, isHolidayOn,
  isInstanceDone, nextOpenInstance, noteTasksSignature, occursOn, resetPlannerCaches, taskInstance,
} from './plannerModel';

// Ревью производительности 13 окт 2026 (C2, C3): индекс дня и обход рядов шагом правила дают то же, что
// прежние функции дня и проверка каждого дня подряд. Эталон — прежний `ordinalOf` без разбора правила

const DAY_KEY = /^\d{4}-\d{2}-\d{2}$/;

function epochDays(day: string) {
  const [year, month, date] = day.split('-').map(Number);
  return Math.floor(Date.UTC(year, month - 1, date) / 86400000);
}

function weekIndex(day: string) {
  return Math.floor((epochDays(day) + 3) / 7);
}

function daysInMonth(year: number, month: number) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function parts(day: string) {
  const [year, month, date] = day.split('-').map(Number);
  return { year, month, date };
}

function weekdayOf(day: string) {
  const d = parts(day);
  return new Date(Date.UTC(d.year, d.month - 1, d.date)).getUTCDay();
}

function mondayBased(weekday: number) {
  return (weekday + 6) % 7;
}

// Прежний порядковый номер экземпляра — как в plannerModel.ts до ревью
function ordinalOfNaive(repeat: PlannerRepeat, day: string): number | undefined {
  const { kind, interval } = repeat;
  if (!DAY_KEY.test(day) || !Number.isInteger(interval) || interval < 1) return undefined;
  if (repeat.startDay && day < repeat.startDay) return undefined;
  if (repeat.endDay && day > repeat.endDay) return undefined;
  const d = parts(day);
  if (kind === 'weekly') {
    const weekdays = [...(repeat.weekdays || [])].sort((a, b) => mondayBased(a) - mondayBased(b));
    const index = weekdays.indexOf(weekdayOf(day));
    if (index < 0) return undefined;
    if (!repeat.startDay) return 1;
    const weeks = weekIndex(day) - weekIndex(repeat.startDay);
    if (weeks % interval !== 0) return undefined;
    const startPosition = mondayBased(weekdayOf(repeat.startDay));
    const skippedInFirstWeek = weekdays.filter((w) => mondayBased(w) < startPosition).length;
    return (weeks / interval) * weekdays.length + index + 1 - skippedInFirstWeek;
  }
  if (!repeat.startDay) return undefined;
  const start = parts(repeat.startDay);
  if (kind === 'daily') {
    const diff = epochDays(day) - epochDays(repeat.startDay);
    return diff % interval === 0 ? diff / interval + 1 : undefined;
  }
  if (kind === 'monthly') {
    const months = (d.year * 12 + d.month) - (start.year * 12 + start.month);
    if (months % interval !== 0) return undefined;
    const wanted = Math.min(repeat.monthDay || start.date, daysInMonth(d.year, d.month));
    return d.date === wanted ? months / interval + 1 : undefined;
  }
  const years = d.year - start.year;
  if (years % interval !== 0 || d.month !== start.month) return undefined;
  const wanted = Math.min(start.date, daysInMonth(d.year, d.month));
  return d.date === wanted ? years / interval + 1 : undefined;
}

function occursOnNaive(repeat: PlannerRepeat, day: string) {
  const ordinal = ordinalOfNaive(repeat, day);
  if (ordinal === undefined) return false;
  return !repeat.count || ordinal <= repeat.count;
}

function expandNaive(repeat: PlannerRepeat, fromDay: string, toDay: string) {
  const days: string[] = [];
  for (let day = fromDay; day <= toDay; day = addDays(day, 1)) {
    if (occursOnNaive(repeat, day)) days.push(day);
  }
  return days;
}

function nextOpenNaive(task: PlannerTask, today: string) {
  for (let i = 0; i < 366; i++) {
    const day = addDays(today, i);
    if (hasInstanceOn(task, day) && !isInstanceDone(task, day)) return taskInstance(task, day);
  }
  return undefined;
}

const RULES: [string, PlannerRepeat][] = [
  ['каждый день', { kind: 'daily', interval: 1, startDay: '2026-01-15' }],
  ['каждые 3 дня, до даты', {
    kind: 'daily', interval: 3, startDay: '2026-01-15', endDay: '2026-03-01',
  }],
  ['каждые 7 дней, 5 раз', {
    kind: 'daily', interval: 7, startDay: '2026-12-29', count: 5,
  }],
  ['по будням', {
    kind: 'weekly', interval: 1, weekdays: [1, 2, 3, 4, 5], startDay: '2026-01-14',
  }],
  ['раз в 2 недели, пн и вс (начало в среду)', {
    kind: 'weekly', interval: 2, weekdays: [0, 1], startDay: '2026-01-14',
  }],
  ['раз в 3 недели, сб и вс, 4 раза', {
    kind: 'weekly', interval: 3, weekdays: [6, 0], startDay: '2026-01-17', count: 4,
  }],
  ['по дням недели без начала (унаследованный ряд)', {
    kind: 'weekly', interval: 1, weekdays: [2, 4], startDay: '',
  }],
  ['по дням недели без начала, до даты', {
    kind: 'weekly', interval: 1, weekdays: [3], startDay: '', endDay: '2026-02-10',
  }],
  ['каждый месяц 31-го', { kind: 'monthly', interval: 1, monthDay: 31, startDay: '2026-01-31' }],
  ['каждые 2 месяца 10-го, начало после 10-го', {
    kind: 'monthly', interval: 2, monthDay: 10, startDay: '2026-01-20',
  }],
  ['каждый месяц по числу начала, 3 раза', {
    kind: 'monthly', interval: 1, startDay: '2026-01-29', count: 3,
  }],
  ['каждый год 29 февраля', { kind: 'yearly', interval: 1, startDay: '2024-02-29' }],
  ['каждые 2 года, до даты', {
    kind: 'yearly', interval: 2, startDay: '2024-06-15', endDay: '2028-06-14',
  }],
  ['негодный интервал', { kind: 'daily', interval: 0, startDay: '2026-01-15' }],
  ['дробный интервал', { kind: 'weekly', interval: 1.5, weekdays: [1], startDay: '2026-01-12' }],
];

const FROM = '2023-12-01';
const TO = '2029-01-31';

function allDays(fromDay: string, toDay: string) {
  const days: string[] = [];
  for (let day = fromDay; day <= toDay; day = addDays(day, 1)) days.push(day);
  return days;
}

describe('повторы: обход шагом правила (C3) совпадает с проверкой каждого дня', () => {
  const days = allDays(FROM, TO);

  it.each(RULES)('%s: occursOn по дням и expandRepeat', (_, repeat) => {
    const naive = days.filter((day) => occursOnNaive(repeat, day));
    expect(days.filter((day) => occursOn(repeat, day))).toEqual(naive);
    expect(expandRepeat(repeat, FROM, TO)).toEqual(naive);
    // Промежутки внутри ряда, в том числе пустые и из одного дня
    expect(expandRepeat(repeat, '2026-02-27', '2026-03-02')).toEqual(expandNaive(repeat, '2026-02-27', '2026-03-02'));
    expect(expandRepeat(repeat, '2026-12-31', '2027-01-05')).toEqual(expandNaive(repeat, '2026-12-31', '2027-01-05'));
    expect(expandRepeat(repeat, '2026-03-15', '2026-03-15')).toEqual(expandNaive(repeat, '2026-03-15', '2026-03-15'));
    expect(expandRepeat(repeat, '2026-03-15', '2026-03-14')).toEqual([]);
  });

  it('negодный день — не экземпляр', () => {
    expect(occursOn(RULES[0][1], '2026-1-5')).toBe(false);
    expect(occursOn(RULES[0][1], '')).toBe(false);
  });

  it('ближайший невыполненный экземпляр — тот же, что при переборе дней', () => {
    const template = (repeat: PlannerRepeat): PlannerTask => ({
      id: 'r', name: 'Ряд', description: '', steps: [], status: 'queue', project: '', rank: 0, repeat,
      occurrences: [
        { day: '2026-01-15', done: true }, { day: '2026-01-16', excluded: true }, { day: '2026-02-10', done: true },
      ],
    });
    RULES.forEach(([, repeat]) => {
      const task = template(repeat);
      ['2025-12-31', '2026-01-15', '2026-01-16', '2026-02-10', '2027-05-05'].forEach((today) => {
        const naive = nextOpenNaive(task, today);
        const fast = nextOpenInstance(task, today);
        expect(fast?.instanceDay).toBe(naive?.instanceDay);
        if (naive) expect(fast).toBe(naive);
      });
    });
  });

  it('экземпляр устойчив, пока шаблон тот же, и обновляется после правки шаблона на месте', () => {
    const task: PlannerTask = {
      id: 't', name: 'Зарядка', description: '', steps: [{ text: 'а', isDone: false }], status: 'queue', project: '',
      rank: 0, repeat: RULES[0][1],
    };
    const first = taskInstance(task, '2026-02-01');
    expect(taskInstance(task, '2026-02-01')).toBe(first);
    task.name = 'Пробежка';
    expect(taskInstance(task, '2026-02-01')).not.toBe(first);
    expect(taskInstance(task, '2026-02-01').name).toBe('Пробежка');
    task.steps[0].text = 'б';
    expect(taskInstance(task, '2026-02-01').steps[0].text).toBe('б');
    task.occurrences = [{ day: '2026-02-01', done: true }];
    expect(taskInstance(task, '2026-02-01').status).toBe('done');
    task.occurrences[0].done = false;
    expect(taskInstance(task, '2026-02-01').status).toBe('queue');
  });
});

// ── индекс дня ──────────────────────────────────────────────────────────────

// Детерминированный генератор (LCG): таблица состояний воспроизводима
function random(seed: number) {
  let value = seed;
  return () => {
    value = (value * 1664525 + 1013904223) % 4294967296;
    return value / 4294967296;
  };
}

function synthState(seed: number, count: number): PlannerState {
  const next = random(seed);
  const pick = <T>(items: T[]) => items[Math.floor(next() * items.length)];
  const day = () => addDays('2026-01-01', Math.floor(next() * 400));
  const time = () => `${String(Math.floor(next() * 23)).padStart(2, '0')}:${pick(['00', '15', '30', '45'])}`;
  const repeat = (): PlannerRepeat | undefined => {
    if (next() < 0.7) return undefined;
    return pick(RULES.slice(0, 13))[1];
  };
  const occurrences = () => (next() < 0.5 ? undefined : [
    { day: '2026-01-15', done: next() < 0.5, doneSteps: [0] },
    { day: '2026-02-10', excluded: next() < 0.5 },
    { day: '2026-03-31', excluded: true },
  ]);
  const tasks: PlannerTask[] = Array.from({ length: count }, (_, i) => {
    const rule = repeat();
    const withTime = next() < 0.5;
    return {
      id: `t${i}`,
      name: `Задача ${i}`,
      description: '',
      steps: next() < 0.3 ? [{ text: 'шаг', isDone: false }, { text: 'ещё', isDone: true }] : [],
      status: pick(['queue', 'active', 'done'] as const),
      project: pick(['', 'Дом', 'Работа']),
      rank: i,
      day: rule ? undefined : (next() < 0.8 ? day() : undefined),
      start: withTime ? time() : undefined,
      minutes: withTime || next() < 0.5 ? pick([15, 30, 60, 120]) : undefined,
      due: !rule && next() < 0.3 ? day() : undefined,
      repeat: rule,
      occurrences: rule ? occurrences() : undefined,
      source: next() < 0.2 ? { chat: `note:n${i % 7}`, opId: `o${i}` } : undefined,
    };
  });
  const events: PlannerEvent[] = Array.from({ length: Math.floor(count / 2) }, (_, i) => {
    const rule = repeat();
    const isAllDay = next() < 0.2;
    const start = time();
    return {
      id: `e${i}`,
      name: `Событие ${i}`,
      start: isAllDay ? '00:00' : start,
      end: isAllDay ? '23:59' : `${String(Math.min(23, Number(start.slice(0, 2)) + 1)).padStart(2, '0')}:30`,
      day: rule ? undefined : day(),
      repeat: rule,
      occurrences: rule ? occurrences() : undefined,
      isAllDay: isAllDay || undefined,
      isHoliday: isAllDay && next() < 0.5 ? true : undefined,
      color: next() < 0.3 ? 3 : undefined,
    };
  });
  const health: PlannerHealthRecord[] = Array.from({ length: Math.floor(count / 2) }, (_, i) => {
    const kind = pick(['weight', 'sleep', 'steps', 'workout', 'pressure']);
    return {
      id: `h${i}`, day: day(), kind, value: i, time: kind === 'workout' ? time() : undefined,
    };
  });
  return {
    ...createEmptyPlannerState(), tasks, events, health,
  };
}

describe('индекс дня (C2) совпадает с функциями дня', () => {
  it.each([[1, 60], [7, 300], [42, 120]])('состояние #%d из %d задач', (seed, count) => {
    const state = synthState(seed, count);
    const from = '2026-01-01';
    const to = '2027-02-10';
    const index = getDayIndex(state, from, to);
    expect(getDayIndex(state, from, to)).toBe(index);
    const ids = (items: { id: string; instanceDay?: string }[]) => (
      items.map((item) => `${item.id}@${item.instanceDay || ''}`)
    );
    allDays(from, to).forEach((day) => {
      const entry = index.get(day);
      const tasks = getTasksForDay(state, day);
      const events = getEventsForDay(state, day);
      const deadlines = getDeadlines(state, day);
      if (!entry) {
        expect(tasks).toEqual([]);
        expect(events).toEqual([]);
        expect(deadlines).toEqual([]);
        return;
      }
      expect(ids(entry.tasks)).toEqual(ids(tasks));
      // Те же объекты: экземпляры рядов из кэша
      entry.tasks.forEach((task, i) => expect(task).toBe(tasks[i]));
      expect(ids(entry.events)).toEqual(ids(events));
      expect(ids(entry.deadlines)).toEqual(ids(deadlines));
      expect(entry.minutes).toBe(getDayLoad(state, day));
      expect(entry.unrated).toBe(countUnrated(state, day));
      expect(entry.conflicts).toBe(countConflicts(state, day));
      expect(entry.isHoliday).toBe(isHolidayOn(state, day));
      expect(entry.holiday).toBe(events.find((event) => event.isHoliday));
      const timed = getTimedForDay(state, day);
      expect(entry.timed.map((item) => [item.name, item.start, item.end])).toEqual(
        timed.map((item) => [item.name, item.start, item.end]),
      );
      expect(entry.allDay).toEqual(events.filter((event) => event.isAllDay));
      expect(entry.untimed).toEqual(tasks.filter((task) => !task.start || task.minutes === undefined));
      // Запись одного дня — из уже построенного индекса либо та же по содержимому
      expect(getDayEntry(state, day).tasks).toEqual(entry.tasks);
    });
    // День вне построенных индексов — индекс одного дня
    expect(getDayEntry(state, '2031-01-01').tasks).toEqual(getTasksForDay(state, '2031-01-01'));
    expect(getDayEntry(state, '2019-01-01').tasks).toEqual(getTasksForDay(state, '2019-01-01'));
  });

  it('индекс одного дня строится при первом обращении и переиспользуется', () => {
    const state = synthState(3, 40);
    const entry = getDayEntry(state, '2026-01-15');
    expect(getDayEntry(state, '2026-01-15')).toBe(entry);
    resetPlannerCaches();
    expect(getDayEntry(state, '2026-01-15')).not.toBe(entry);
    expect(getDayEntry(state, '2026-01-15')).toEqual(entry);
  });

  it('подпись задач из заметок меняется только от таких задач', () => {
    const state = synthState(5, 50);
    const signature = noteTasksSignature(state);
    expect(noteTasksSignature(state)).toBe(signature);
    const other = { ...state, tasks: state.tasks.map((task) => (task.source ? task : { ...task, name: 'x' })) };
    expect(noteTasksSignature(other)).toBe(signature);
    const noteTask = state.tasks.find((task) => task.source)!;
    const changed = {
      ...state,
      tasks: state.tasks.map((task) => (task === noteTask
        ? { ...task, status: task.status === 'done' ? 'queue' as const : 'done' as const } : task)),
    };
    expect(noteTasksSignature(changed)).not.toBe(signature);
    const removed = { ...state, tasks: state.tasks.filter((task) => task !== noteTask) };
    expect(noteTasksSignature(removed)).not.toBe(signature);
  });
});

describe('индекс здоровья (C2) совпадает с перебором записей', () => {
  it.each([[11, 200], [12, 500]])('состояние #%d', (seed, count) => {
    const state = synthState(seed, count);
    const kinds = ['weight', 'sleep', 'steps', 'pressure'] as const;
    allDays('2025-12-20', '2027-02-20').forEach((day) => {
      kinds.forEach((kind) => {
        const dayRecords = state.health.filter((record) => record.kind === kind && record.day === day);
        if (kind === 'sleep' && dayRecords.length > 1) {
          // Несколько снов дня (16 окт 2026): сумма, время — самого долгого
          const main = dayRecords.reduce((best, item) => (item.value > best.value ? item : best));
          expect(getDailyRecord(state, kind, day))
            .toEqual({ ...main, value: dayRecords.reduce((sum, item) => sum + item.value, 0) });
        } else {
          expect(getDailyRecord(state, kind, day)).toBe(dayRecords[0]);
        }
        const latest = state.health.filter((record) => record.kind === kind && record.day <= day)
          .sort((a, b) => (a.day < b.day ? 1 : a.day > b.day ? -1 : 0))[0];
        expect(getLatestRecord(state, kind, day)).toBe(latest);
      });
    });
    const week = allDays('2026-03-01', '2026-03-07');
    expect(getWorkouts(state, week)).toEqual(state.health
      .filter((record) => record.kind === 'workout' && week.includes(record.day))
      .sort((a, b) => (a.day === b.day ? (b.time || '').localeCompare(a.time || '') : a.day < b.day ? 1 : -1)));
  });

  it('дописанный на месте массив перечитывается', () => {
    const state = synthState(2, 10);
    expect(getDailyRecord(state, 'mood', '2026-05-05')).toBeUndefined();
    state.health.push({
      id: 'm', day: '2026-05-05', kind: 'mood', value: 4,
    });
    expect(getDailyRecord(state, 'mood', '2026-05-05')?.id).toBe('m');
  });
});

describe('замер: 5 000 записей', () => {
  it('индекс года и месяца, перебор дней', () => {
    const state = synthState(99, 3300);
    const start = performance.now();
    getDayIndex(state, '2026-01-01', '2026-12-31');
    const year = performance.now() - start;
    resetPlannerCaches();
    const monthStart = performance.now();
    getDayIndex(state, '2026-03-01', '2026-03-31');
    const month = performance.now() - monthStart;
    const naiveStart = performance.now();
    allDays('2026-03-01', '2026-03-31').forEach((day) => {
      getDayLoad(state, day);
      countUnrated(state, day);
      countConflicts(state, day);
      getEventsForDay(state, day);
      getTasksForDay(state, day);
      getDeadlines(state, day);
    });
    const naive = performance.now() - naiveStart;
    process.stdout.write(`[perf] 5 000 записей: индекс года ${year.toFixed(1)} мс, месяца ${month.toFixed(1)} мс, `
      + `месяц функциями дня ${naive.toFixed(1)} мс\n`);
    expect(year).toBeLessThan(2000);
  });
});
