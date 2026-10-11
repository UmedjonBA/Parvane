import { describe, expect, it } from 'vitest';

import type { QuickContext, QuickDraft } from './plannerQuick';

import { parseQuickInput } from './plannerQuick';

// 8 октября 2026 — четверг, полдень; окно дня 09:00–21:00
const CTX: QuickContext = {
  today: '2026-10-08', nowMinutes: 12 * 60, dayStart: 9 * 60, dayEnd: 21 * 60,
};
const WEEKLY = { kind: 'weekly', interval: 1 } as const;

type Row = [input: string, expected: Partial<QuickDraft>, ctx?: Partial<QuickContext>];

function run(rows: Row[]) {
  rows.forEach(([input, expected, ctx]) => {
    it(input, () => {
      const draft = parseQuickInput(input, { ...CTX, ...ctx });
      // Значение undefined в ожидании — «поля быть не должно»
      const entries = Object.entries(expected);
      expect(draft).toMatchObject(Object.fromEntries(entries.filter(([, value]) => value !== undefined)));
      entries.filter(([, value]) => value === undefined).forEach(([key]) => {
        expect(draft[key as keyof QuickDraft], key).toBeUndefined();
      });
    });
  });
}

describe('ввод текстом: тип и название', () => {
  run([
    ['купить блок питания', { kind: 'task', name: 'купить блок питания', day: undefined, error: undefined }],
    ['Позвонить Маме', { kind: 'task', name: 'Позвонить Маме' }],
    ['задача проверить работы', { kind: 'task', name: 'проверить работы' }],
    ['Задача: проверить работы', { kind: 'task', name: 'проверить работы' }],
    ['задачу проверить работы', { kind: 'task', name: 'проверить работы' }],
    ['задачник по физике', { kind: 'task', name: 'задачник по физике' }],
    ['событие педсовет', { kind: 'event', name: 'педсовет', isAllDay: true, day: '2026-10-08' }],
    ['созвон 16:00', { kind: 'event', name: 'созвон', start: '16:00', end: '17:00' }],
    ['задача созвон 16:00', { kind: 'task', name: 'созвон', start: '16:00', minutes: 30, day: '2026-10-08' }],
    ['', { kind: 'task', name: '', error: 'name' }],
    ['   ', { kind: 'task', name: '', error: 'name' }],
    ['завтра 15:00', { kind: 'event', name: '', error: 'name' }],
    ['созвон 16:00', { kind: 'task', name: 'созвон', start: '16:00', minutes: 30 }, { kind: 'task' }],
    ['отчёт', { kind: 'event', name: 'отчёт', isAllDay: true }, { kind: 'event' }],
    ['обед 520 ккал', { kind: 'task', name: 'обед 520 ккал' }, { kinds: ['task', 'event'] }],
    ['вода 500 мл', { kind: 'task', name: 'вода 500 мл' }, { kinds: ['task', 'event'] }],
  ]);
});

describe('ввод текстом: время', () => {
  run([
    ['созвон 9:05', { start: '09:05', end: '10:05', day: '2026-10-09', isDayAssumed: true }],
    ['созвон в 15:30', { name: 'созвон', start: '15:30', end: '16:30', day: '2026-10-08', isDayAssumed: true }],
    ['созвон в 15', { name: 'созвон', start: '15:00', end: '16:00' }],
    ['созвон в 5', { name: 'созвон', start: '17:00', end: '18:00' }],
    ['созвон в 9', { name: 'созвон', start: '09:00', day: '2026-10-09' }],
    ['созвон в 12', { name: 'созвон', start: '12:00', day: '2026-10-09' }],
    ['созвон в 5 вечера', { name: 'созвон', start: '17:00' }],
    ['созвон в 5 утра', { name: 'созвон', start: '05:00', day: '2026-10-09' }],
    ['созвон в 2 дня', { name: 'созвон', start: '14:00' }],
    ['созвон в 11 ночи', { name: 'созвон', start: '23:00', end: '23:59' }],
    ['созвон в 7:30 вечера', { name: 'созвон', start: '19:30', end: '20:30' }],
    ['созвон в 5', { start: '05:00' }, { dayStart: 4 * 60, dayEnd: 12 * 60 }],
    ['пара с 10 до 12', { kind: 'event', name: 'пара', start: '10:00', end: '12:00', minutes: 120 }],
    ['пара 10:00-11:30', { name: 'пара', start: '10:00', end: '11:30', minutes: 90 }],
    ['пара 10–12:30', { name: 'пара', start: '10:00', end: '12:30' }],
    ['пара 10:00 — 11:00', { name: 'пара', start: '10:00', end: '11:00' }],
    ['счёт 10-12', { kind: 'task', name: 'счёт 10-12', start: undefined }],
    ['сон 23:40-07:30', { kind: 'event', error: 'time' }],
    ['созвон 23:30', { start: '23:30', end: undefined, error: 'time' }],
    ['созвон 23:00', { start: '23:00', end: '23:59', error: undefined }],
    ['созвон 25:00', { kind: 'task', name: 'созвон 25:00' }],
    ['созвон 16:00 и 18:00', { name: 'созвон и 18:00', start: '16:00' }],
    ['версия 3.5', { kind: 'task', name: 'версия 3.5', day: undefined }],
    ['встреча в 15.10', { kind: 'task', name: 'встреча', day: '2026-10-15', start: undefined }],
  ]);
});

describe('ввод текстом: длительность', () => {
  run([
    ['созвон 16:00 45 мин', { name: 'созвон', start: '16:00', end: '16:45', minutes: 45 }],
    ['созвон 16:00 1,5 ч', { name: 'созвон', end: '17:30', minutes: 90 }],
    ['созвон 16:00 2 часа', { name: 'созвон', end: '18:00' }],
    ['созвон 16:00 1 ч 30 мин', { name: 'созвон', end: '17:30', minutes: 90 }],
    ['созвон 16:00 полчаса', { name: 'созвон', end: '16:30' }],
    ['созвон 16:00 полтора часа', { name: 'созвон', end: '17:30' }],
    ['разобрать почту 20 минут', { kind: 'task', name: 'разобрать почту', minutes: 20, day: undefined }],
    ['разобрать почту 45м', { kind: 'task', name: 'разобрать почту', minutes: 45 }],
    ['задача отчёт завтра 18:00 40 мин', {
      kind: 'task', name: 'отчёт', day: '2026-10-09', start: '18:00', minutes: 40,
    }],
    ['купить 5 метров кабеля', { name: 'купить 5 метров кабеля', minutes: undefined }],
    ['курс 5 мес', { name: 'курс 5 мес', minutes: undefined, repeat: undefined }],
    ['созвон 23:00 2 часа', { error: 'time' }],
    ['задача уборка 23:30 60 мин', { kind: 'task', error: 'pastMidnight' }],
  ]);
});

describe('ввод текстом: дата и срок', () => {
  run([
    ['отчёт сегодня', { kind: 'task', name: 'отчёт', day: '2026-10-08' }],
    ['отчёт завтра', { name: 'отчёт', day: '2026-10-09', isDayAssumed: undefined }],
    ['отчёт послезавтра', { name: 'отчёт', day: '2026-10-10' }],
    ['отчёт через 3 дня', { name: 'отчёт', day: '2026-10-11' }],
    ['отчёт через неделю', { name: 'отчёт', day: '2026-10-15' }],
    ['отчёт через 2 недели', { name: 'отчёт', day: '2026-10-22' }],
    ['отчёт на следующей неделе', { name: 'отчёт', day: '2026-10-12' }],
    ['отчёт в пт', { name: 'отчёт', day: '2026-10-09' }],
    ['отчёт в пятницу', { name: 'отчёт', day: '2026-10-09' }],
    ['отчёт в чт', { name: 'отчёт', day: '2026-10-15' }],
    ['отчёт во вторник', { name: 'отчёт', day: '2026-10-13' }],
    ['отчёт вс', { name: 'отчёт', day: '2026-10-11' }],
    ['отчёт в среду', { name: 'отчёт', day: '2026-10-14' }],
    ['отчёт 12.10', { name: 'отчёт', day: '2026-10-12' }],
    ['отчёт 05.03', { name: 'отчёт', day: '2027-03-05' }],
    ['отчёт 08.10', { name: 'отчёт', day: '2026-10-08' }],
    ['отчёт 12.10.2027', { name: 'отчёт', day: '2027-10-12' }],
    ['отчёт 31.02', { name: 'отчёт 31.02', day: undefined }],
    ['отчёт 12 октября', { name: 'отчёт', day: '2026-10-12' }],
    ['отчёт 1 мая', { name: 'отчёт', day: '2027-05-01' }],
    ['отчёт 3 марта', { name: 'отчёт', day: '2027-03-03' }],
    ['отчёт на завтра', { name: 'отчёт', day: '2026-10-09' }],
    ['созвон чт 16:00', { kind: 'event', name: 'созвон', day: '2026-10-15', start: '16:00', end: '17:00' }],
    ['зал завтра 19:00 60 мин', { kind: 'event', name: 'зал', day: '2026-10-09', start: '19:00', end: '20:00' }],
    ['задача проверить работы до пт', { kind: 'task', name: 'проверить работы', due: '2026-10-09', day: undefined }],
    ['отчёт до 20.10', { name: 'отчёт', due: '2026-10-20' }],
    ['отчёт до завтра', { name: 'отчёт', due: '2026-10-09' }],
    ['отчёт до марта', { name: 'отчёт', due: '2027-03-01' }],
    ['отчёт завтра до пт', { name: 'отчёт', day: '2026-10-09', due: '2026-10-09' }],
    ['отчёт в пн до пт', { name: 'отчёт', day: '2026-10-12', due: '2026-10-09', error: 'dayAfterDue' }],
    ['дойти до магазина', { name: 'дойти до магазина', due: undefined }],
    ['блок питания 1000 Вт', { name: 'блок питания 1000 Вт', day: undefined }],
    ['лампа 60 вт и провод', { name: 'лампа 60 вт и провод', day: undefined }],
    ['среди документов найти договор', { name: 'среди документов найти договор', day: undefined }],
    ['мартышка и очки', { name: 'мартышка и очки', day: undefined }],
    ['отчёт завтра и послезавтра', { name: 'отчёт и послезавтра', day: '2026-10-09' }],
    ['Сдать ОТЧЁТ Завтра', { name: 'Сдать ОТЧЁТ', day: '2026-10-09' }],
    ['ёлку купить завтра', { name: 'ёлку купить', day: '2026-10-09' }],
  ]);
});

describe('ввод текстом: повтор', () => {
  run([
    ['урок вт 15:00 каждую неделю 5 мес', {
      kind: 'event',
      name: 'урок',
      start: '15:00',
      end: '16:00',
      day: '2026-10-13',
      repeat: {
        ...WEEKLY, weekdays: [2], startDay: '2026-10-13', endDay: '2027-03-13',
      },
      error: undefined,
    }],
    ['зарядка каждый день', {
      kind: 'task', name: 'зарядка', repeat: { kind: 'daily', interval: 1, startDay: '2026-10-08' },
    }],
    ['зарядка ежедневно 8:00 15 мин', {
      kind: 'event', name: 'зарядка', start: '08:00', end: '08:15', repeat: { kind: 'daily', startDay: '2026-10-08' },
    }],
    ['полив каждые 3 дня', { name: 'полив', repeat: { kind: 'daily', interval: 3 } }],
    ['отчёт каждую неделю', { name: 'отчёт', repeat: { ...WEEKLY, weekdays: [4], startDay: '2026-10-08' } }],
    ['отчёт еженедельно', { name: 'отчёт', repeat: { ...WEEKLY, weekdays: [4] } }],
    ['отчёт каждые 2 недели', { name: 'отчёт', repeat: { kind: 'weekly', interval: 2, weekdays: [4] } }],
    ['отчёт раз в две недели', { name: 'отчёт', repeat: { kind: 'weekly', interval: 2 } }],
    ['отчёт раз в неделю', { name: 'отчёт', repeat: { kind: 'weekly', interval: 1 } }],
    ['аренда каждый месяц', { name: 'аренда', repeat: { kind: 'monthly', interval: 1, startDay: '2026-10-08' } }],
    ['аренда ежемесячно 20.10', { name: 'аренда', repeat: { kind: 'monthly', startDay: '2026-10-20' } }],
    ['страховка каждый год', { name: 'страховка', repeat: { kind: 'yearly', interval: 1 } }],
    ['страховка ежегодно', { name: 'страховка', repeat: { kind: 'yearly' } }],
    ['зал по будням 19:00', {
      kind: 'event', name: 'зал', repeat: { ...WEEKLY, weekdays: [1, 2, 3, 4, 5], startDay: '2026-10-08' },
    }],
    ['уборка по выходным', { name: 'уборка', repeat: { ...WEEKLY, weekdays: [0, 6], startDay: '2026-10-10' } }],
    ['зал по пн, ср и пт 19:00', {
      name: 'зал', start: '19:00', repeat: { ...WEEKLY, weekdays: [1, 3, 5], startDay: '2026-10-09' },
    }],
    ['урок по вт и чт в 5 вечера 45 мин', {
      kind: 'event',
      name: 'урок',
      start: '17:00',
      end: '17:45',
      repeat: { ...WEEKLY, weekdays: [2, 4], startDay: '2026-10-08' },
    }],
    ['урок по вторникам', { name: 'урок', repeat: { ...WEEKLY, weekdays: [2], startDay: '2026-10-13' } }],
    ['урок каждый вторник 15:00', { name: 'урок', repeat: { ...WEEKLY, weekdays: [2] } }],
    ['урок каждую пятницу', { name: 'урок', repeat: { ...WEEKLY, weekdays: [5], startDay: '2026-10-09' } }],
    ['урок каждую неделю до 20.12', { name: 'урок', repeat: { ...WEEKLY, endDay: '2026-12-20' }, due: undefined }],
    ['урок каждую неделю до марта', { name: 'урок', repeat: { ...WEEKLY, endDay: '2027-03-01' } }],
    ['урок каждую неделю 10 раз', { name: 'урок', repeat: { ...WEEKLY, count: 10 } }],
    ['урок каждую неделю 6 недель', { name: 'урок', repeat: { ...WEEKLY, endDay: '2026-11-19' } }],
    ['урок каждый день 2 мес', { name: 'урок', repeat: { kind: 'daily', endDay: '2026-12-08' } }],
    ['урок по вт с 12.10', { name: 'урок с', repeat: { ...WEEKLY, weekdays: [2], startDay: '2026-10-13' } }],
    ['повторить 10 раз упражнение', { name: 'повторить 10 раз упражнение', repeat: undefined }],
    ['поговорить по душам', { name: 'поговорить по душам', repeat: undefined }],
  ]);
});

describe('ввод текстом: снятые значения остаются в названии', () => {
  run([
    ['созвон завтра 16:00', { kind: 'task', name: 'созвон 16:00', day: '2026-10-09' }, { skip: ['time'] }],
    ['созвон завтра 16:00', { name: 'созвон завтра', start: '16:00', day: '2026-10-08' }, { skip: ['day'] }],
    ['отчёт до пт', { name: 'отчёт до', due: undefined, day: '2026-10-09' }, { skip: ['due'] }],
    ['урок каждую неделю', { name: 'урок каждую неделю', repeat: undefined }, { skip: ['repeat'] }],
    ['разобрать почту 20 минут', { name: 'разобрать почту 20 минут', minutes: undefined }, { skip: ['minutes'] }],
    ['задача отчёт', { name: 'задача отчёт' }, { skip: ['kind'] }],
  ]);
});

describe('ввод текстом: еда и вода', () => {
  run([
    ['обед гречка 150г б30 ж10 у60 кл6 520 ккал', {
      kind: 'food',
      name: 'гречка',
      meal: 'lunch',
      grams: 150,
      nutrients: {
        kcal: 520, protein: 30, fat: 10, carbs: 60, fiber: 6,
      },
      day: '2026-10-08',
      error: undefined,
    }],
    ['обед гречка 13:00 650 ккал', { kind: 'food', name: 'гречка', meal: 'lunch', nutrients: { kcal: 650 } }],
    ['овсянка 9:00 300 ккал', { kind: 'food', name: 'овсянка', meal: 'breakfast' }],
    ['творог 200 ккал', { kind: 'food', name: 'творог', meal: 'lunch' }],
    ['творог 200 ккал', { meal: 'dinner' }, { nowMinutes: 19 * 60 }],
    ['ужин 600 ккал', { kind: 'food', name: 'ужин', meal: 'dinner' }],
    ['перекус орехи 30 г 180 кал', { kind: 'food', name: 'орехи', meal: 'snack', grams: 30 }],
    ['курица белки 30 жиры 5 углеводы 0', {
      kind: 'food', name: 'курица', nutrients: { protein: 30, fat: 5, carbs: 0, kcal: 165 },
    }],
    ['сыр б 12,5 ж 15', { kind: 'food', name: 'сыр', nutrients: { protein: 12.5, fat: 15, kcal: 185 } }],
    ['520 ккал', { kind: 'food', error: 'name' }],
    ['обед завтра 700 ккал', { kind: 'food', day: '2026-10-09', meal: 'lunch' }],
    ['обед с Петей 13:00', { kind: 'event', name: 'обед с Петей', start: '13:00' }],
    ['вода 500 мл', { kind: 'water', waterMl: 500, name: '', day: '2026-10-08' }],
    ['2 стакана', { kind: 'water', waterMl: 500 }],
    ['1,5 л', { kind: 'water', waterMl: 1500 }],
    ['вода 2 литра', { kind: 'water', waterMl: 2000 }],
    ['воды стакан', { kind: 'task', name: 'воды стакан' }],
    ['купить молоко 2 л', { kind: 'task', name: 'купить молоко 2 л', waterMl: undefined }],
    ['кефир', { kind: 'water', waterMl: undefined }, { kind: 'water' }],
    ['гречка', { kind: 'food', name: 'гречка', nutrients: {} }, { kind: 'food' }],
  ]);
});

describe('ввод текстом: участки', () => {
  it('помечает распознанное и не трогает название', () => {
    const text = 'Созвон завтра 16:00 45 мин';
    const { spans } = parseQuickInput(text, CTX);
    expect(spans.map(({ field, from, to }) => [field, text.slice(from, to)])).toEqual([
      ['day', 'завтра'], ['time', '16:00'], ['minutes', '45 мин'],
    ]);
  });
});
