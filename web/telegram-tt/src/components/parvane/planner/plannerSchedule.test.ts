import { describe, expect, it } from 'vitest';

import { buildScheduleEvents, parseSchedule } from './plannerSchedule';

const SAMPLE = `Понедельник

17:00–18:30 Рисование, ауд. 12
18:30–20:00 Шахматный кружок, ауд. 12

Вторник

10:35–12:00 Алгебра (семинар), преп. Иванова А.А., 101 ГК
13:55–15:20 Основы программирования
15:30–16:55 Иностранный язык
17:30–19:00 Робототехника, группа 1, каб. 5

Среда

12:10–13:35 Алгебра (лекция), проф. Петров П.П., 202 ГК

Четверг

15:30–16:55 Иностранный язык
18:40–20:05 История (семинар), преп. Сидоров С.С., 303 ГК

Пятница

15:00–16:30 Бассейн, дорожка 3, СК

Суббота — свободна

Воскресенье

11:00–12:45 Английский клуб, группа 2, каб. 7
13:00–14:45 Робототехника, группа 2, каб. 7

до 15.12.2026`;

describe('расписание текстом', () => {
  it('разбирает недельное расписание и дату конца', () => {
    const { items, endDay, skipped } = parseSchedule(SAMPLE);
    expect(endDay).toBe('2026-12-15');
    expect(skipped).toEqual([]);
    expect(items).toHaveLength(12);
    expect(items.filter((i) => i.weekday === 6)).toHaveLength(0);
    expect(items[0]).toEqual({
      weekday: 1, start: '17:00', end: '18:30', name: 'Рисование', description: 'ауд. 12',
    });
    expect(items.find((i) => i.start === '10:35')).toMatchObject({
      weekday: 2, name: 'Алгебра (семинар)', description: 'преп. Иванова А.А., 101 ГК',
    });
    expect(items.find((i) => i.start === '13:55')).toMatchObject({
      name: 'Основы программирования', description: undefined,
    });
    expect(items.filter((i) => i.weekday === 0).map((i) => i.start)).toEqual(['11:00', '13:00']);
  });

  it('день в той же строке, короткие названия, дефис и ISO-дата', () => {
    const { items, endDay } = parseSchedule('Пн 9:00-10:00 Зарядка\nвс: 20.00 - 21.30 Кино\nuntil 2027-01-31');
    expect(items).toEqual([
      { weekday: 1, start: '09:00', end: '10:00', name: 'Зарядка', description: undefined },
      { weekday: 0, start: '20:00', end: '21:30', name: 'Кино', description: undefined },
    ]);
    expect(endDay).toBe('2027-01-31');
  });

  it('время без дня и неверный интервал — в пропущенных, неверная дата — без даты', () => {
    const { items, skipped, endDay } = parseSchedule('10:00–11:00 Без дня\nСреда\n12:00–11:00 Наоборот\nдо 31.02.2026');
    expect(items).toEqual([]);
    expect(skipped).toEqual(['10:00–11:00 Без дня', '12:00–11:00 Наоборот']);
    expect(endDay).toBeUndefined();
  });

  it('события — еженедельные ряды с началом и концом', () => {
    const events = buildScheduleEvents(parseSchedule(SAMPLE).items, '2026-10-16', '2026-12-15');
    expect(events).toHaveLength(12);
    expect(events[0].repeat).toEqual({
      kind: 'weekly', interval: 1, weekdays: [1], startDay: '2026-10-16', endDay: '2026-12-15',
    });
    expect(new Set(events.map((e) => e.id)).size).toBe(12);
    expect(buildScheduleEvents(parseSchedule(SAMPLE).items, '2026-12-20', '2026-12-15')).toEqual([]);
  });
});
