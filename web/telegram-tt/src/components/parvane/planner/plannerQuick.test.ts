import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import type { QuickContext, QuickDraft } from './plannerQuick';

import { getQuickLang, parseQuickInput } from './plannerQuick';

// 8 октября 2026 — четверг, полдень; окно дня 09:00–21:00
const CTX: QuickContext = {
  today: '2026-10-08', nowMinutes: 12 * 60, dayStart: 9 * 60, dayEnd: 21 * 60,
};
// Тот же день при английском интерфейсе
const EN: QuickContext = { ...CTX, lang: 'en' };
const WEEKLY = { kind: 'weekly', interval: 1 } as const;

type Row = [input: string, expected: Partial<QuickDraft>, ctx?: Partial<QuickContext>];

function run(rows: Row[], base: QuickContext = CTX) {
  rows.forEach(([input, expected, ctx]) => {
    it(input, () => {
      const draft = parseQuickInput(input, { ...base, ...ctx });
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
    ['сон 23:40-07:30', { kind: 'event', error: 'time' }, { kinds: ['task', 'event'] }],
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
      end: '15:45',
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
    ['Рисование(ауд. 12) по понидельникам с 17:00 до 18:30 каждую ниделю', {
      kind: 'event', name: 'Рисование(ауд. 12)', start: '17:00', end: '18:30', repeat: { ...WEEKLY, weekdays: [1] },
    }],
    ['пара в суботу в 9:00 каждую ниделю', {
      kind: 'event', name: 'пара', start: '09:00', end: '10:45', repeat: { ...WEEKLY, weekdays: [6] },
    }],
    ['урок завтра 9:00', { kind: 'event', name: 'урок', start: '09:00', end: '09:45' }],
    ['урок завтра 9:00 60 мин', { kind: 'event', start: '09:00', end: '10:00' }],
    ['пара завтра с 9 до 10:30', { kind: 'event', start: '09:00', end: '10:30' }],
    ['сдать пару отчётов завтра 9:00', { kind: 'event', start: '09:00', end: '10:00' }],
    ['урок по понедльникам 15:00', { kind: 'event', name: 'урок', repeat: { ...WEEKLY, weekdays: [1] } }],
    ['завтрак с мамой завтар 9:00', { kind: 'event', name: 'завтрак с мамой', day: '2026-10-09' }],
    ['выходные задачи события', { kind: 'task', name: 'выходные задачи события', repeat: undefined }],
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

describe('ввод текстом: обычная длительность по первому слову названия', () => {
  run([
    ['вт 15:00 пара по английскому', {
      kind: 'event', name: 'пара по английскому', description: undefined, start: '15:00', end: '16:45',
    }],
    ['завтра в 9 урок', { kind: 'event', name: 'урок', day: '2026-10-09', start: '09:00', end: '09:45' }],
    ['пара завтра 9:00', { name: 'пара', start: '09:00', end: '10:45' }],
    ['событие пара 10:00', { kind: 'event', name: 'пара', start: '10:00', end: '11:45' }],
    ['сдать пару отчётов завтра 9:00', { name: 'сдать пару отчётов', start: '09:00', end: '10:00' }],
    ['подготовка к уроку завтра 9:00', { name: 'подготовка к уроку', end: '10:00' }],
    // Названная длительность и названный конец сильнее обычной
    ['вт 15:00 пара по физике 2 часа', { name: 'пара по физике', end: '17:00' }],
    ['вт пара по физике 15:00-16:20', { name: 'пара по физике', end: '16:20' }],
    ['пара завтра 9:00 — принести тетрадь', { name: 'пара', description: 'принести тетрадь', end: '10:45' }],
  ]);
});

describe('ввод текстом: название и описание', () => {
  const OWNER = {
    kind: 'event', name: 'пара по Английскому', description: 'будет тест лисининг', day: '2026-10-13',
    start: '15:00', end: '16:45', error: undefined,
  } as const;
  run([
    // Строка пользователя (12 окт 2026): «пара» — 1 ч 45 мин, «будет…» — описание
    ['вт 15:00 пара по Английскому будет тест  лисининг', OWNER],
    // Значения — в любом месте строки
    ['пара по Английскому вт 15:00 будет тест лисининг', OWNER],
    ['пара по Английскому будет тест лисининг вт 15:00', OWNER],
    ['пара по Английскому вт будет тест лисининг 15:00', OWNER],
    ['пара по английскому — тест по лисенингу вт 15:00', {
      name: 'пара по английскому', description: 'тест по лисенингу', day: '2026-10-13', end: '16:45',
    }],
    ['завтра созвон — обсудить бюджет в 16:00 45 мин', {
      name: 'созвон', description: 'обсудить бюджет', day: '2026-10-09', start: '16:00', end: '16:45',
    }],
    // Явные разделители
    ['созвон завтра 16:00 — обсудить бюджет', {
      kind: 'event', name: 'созвон', description: 'обсудить бюджет', day: '2026-10-09', start: '16:00', end: '17:00',
    }],
    ['созвон – обсудить бюджет', { kind: 'task', name: 'созвон', description: 'обсудить бюджет' }],
    ['купить молоко - 2 пакета', { name: 'купить молоко', description: '2 пакета' }],
    ['встреча с Петей: бюджет, сроки', { name: 'встреча с Петей', description: 'бюджет, сроки' }],
    ['купить подарок; маме нравятся серьги', { name: 'купить подарок', description: 'маме нравятся серьги' }],
    ['Сдать отчёт. Приложить таблицу', { name: 'Сдать отчёт', description: 'Приложить таблицу' }],
    ['стрижка сб 12:00 // мастер Аня', {
      name: 'стрижка', description: 'мастер Аня', day: '2026-10-10', start: '12:00',
    }],
    ['созвон завтра\nобсудить бюджет\nи сроки', {
      name: 'созвон', description: 'обсудить бюджет\nи сроки', day: '2026-10-09',
    }],
    ['отчёт: добавить графики', {
      kind: 'event', name: 'отчёт', description: 'добавить графики', isAllDay: true,
    }, { kind: 'event' }],
    // Явный знак сильнее слова-ввода
    ['Маме нужно позвонить — насчёт дачи', { name: 'Маме нужно позвонить', description: 'насчёт дачи' }],
    // Метки: подпись отбрасывается, метка со смыслом остаётся
    ['встреча с куратором описание: обсудить диплом', {
      name: 'встреча с куратором', description: 'обсудить диплом',
    }],
    ['встреча с куратором прим. взять зачётку', { name: 'встреча с куратором', description: 'взять зачётку' }],
    ['встреча с куратором, заметка: взять зачётку', {
      name: 'встреча с куратором', description: 'взять зачётку',
    }],
    ['встреча — примечание: взять паспорт', { name: 'встреча', description: 'взять паспорт' }],
    ['пара по физике тема: оптика', { name: 'пара по физике', description: 'тема: оптика' }],
    ['написать описание проекта', { name: 'написать описание проекта', description: undefined }],
    ['новая тема оформления', { name: 'новая тема оформления', description: undefined }],
    ['написать описание. Срочно', { name: 'написать описание', description: 'Срочно' }],
    // Слова-вводы описания: слово остаётся в описании
    ['врач пт 10:30 нужно взять полис', {
      kind: 'event', name: 'врач', description: 'нужно взять полис', day: '2026-10-09', start: '10:30',
    }],
    ['собрание жильцов надо принести квитанции', {
      name: 'собрание жильцов', description: 'надо принести квитанции',
    }],
    ['поездка в Казань не забыть зарядку', { name: 'поездка в Казань', description: 'не забыть зарядку' }],
    ['бассейн взять шапочку', { name: 'бассейн', description: 'взять шапочку' }],
    ['семинар принести ноутбук', { name: 'семинар', description: 'принести ноутбук' }],
    ['контрольные будут сложные вопросы', { name: 'контрольные', description: 'будут сложные вопросы' }],
    ['купить молоко, надо успеть до закрытия', { name: 'купить молоко', description: 'надо успеть до закрытия' }],
    // Срок и повтор вместе с описанием
    ['задача проверить работы до пт — классы 9Б и 10А', {
      kind: 'task', name: 'проверить работы', due: '2026-10-09', description: 'классы 9Б и 10А',
    }],
    ['отчёт до 20.10: добавить графики', { name: 'отчёт', due: '2026-10-20', description: 'добавить графики' }],
    ['английский по вт и чт 18:00 — взять учебник', {
      kind: 'event', name: 'английский', description: 'взять учебник', repeat: { ...WEEKLY, weekdays: [2, 4] },
    }],
    ['планёрка каждый день надо собрать статусы', {
      kind: 'task', name: 'планёрка', description: 'надо собрать статусы', repeat: { kind: 'daily', interval: 1 },
    }],
    // Опечатки в словах разбора по-прежнему исправляются
    ['пара по английскому во вторнек 15:00 будет тест', {
      name: 'пара по английскому', description: 'будет тест', day: '2026-10-13', end: '16:45',
    }],
    ['отчёт послезавтро — приложить таблицу', {
      name: 'отчёт', description: 'приложить таблицу', day: '2026-10-10',
    }],
    // Не делят
    ['Рисование(ауд. 12) вт 15:00', { name: 'Рисование(ауд. 12)', description: undefined, day: '2026-10-13' }],
    ['купить молоко, хлеб', { name: 'купить молоко, хлеб', description: undefined }],
    ['купить кое-что завтра', { name: 'купить кое-что', description: undefined }],
    ['пара 10:00 — 11:30', { name: 'пара', description: undefined, end: '11:30' }],
    ['созвон 16:00 —', { name: 'созвон', description: undefined }],
    ['— купить хлеб', { name: 'купить хлеб', description: undefined }],
    ['1. купить хлеб', { name: '1. купить хлеб', description: undefined }],
    ['зайти на ул. Ленина 5', { name: 'зайти на ул. Ленина 5', description: undefined }],
    ['доклад и т.д. завтра', { name: 'доклад и т.д.', description: undefined, day: '2026-10-09' }],
    ['купить 2 кг. яблок', { name: 'купить 2 кг. яблок', description: undefined }],
    ['позвонить Иванову И. И. завтра', { name: 'позвонить Иванову И. И.', description: undefined }],
    ['у Пети будет день рождения', { name: 'у Пети будет день рождения', description: undefined }],
    ['презентация будет в 305 аудитории', { name: 'презентация', description: 'будет в 305 аудитории' }],
    ['надо взять паспорт', { name: 'надо взять паспорт', description: undefined }],
    ['не забыть взять паспорт', { name: 'не забыть взять паспорт', description: undefined }],
    ['завтра надо купить молоко', { name: 'надо купить молоко', description: undefined, day: '2026-10-09' }],
    ['мне надо купить молоко', { name: 'мне надо купить молоко', description: undefined }],
    ['в банке взять справку', { name: 'в банке взять справку', description: undefined }],
    ['встреча не будет долгой', { name: 'встреча не будет долгой', description: undefined }],
    ['тест будет в пятницу', { name: 'тест будет', description: undefined, day: '2026-10-09' }],
    // Снятое описание возвращается в название
    ['вт 15:00 пара по Английскому будет тест', {
      name: 'пара по Английскому будет тест', description: undefined, end: '16:45',
    }, { skip: ['description'] }],
    ['созвон завтра — обсудить бюджет', {
      name: 'созвон — обсудить бюджет', description: undefined,
    }, { skip: ['description'] }],
    // Еда, вода и здоровье названий не делят
    ['обед гречка 13:00 650 ккал — вкусно', { kind: 'food', name: 'гречка — вкусно', description: undefined }],
    ['бег 5 км 28 мин — парк', { kind: 'workout', description: undefined }],
    ['сон 23:40-07:30', { kind: 'sleep', description: undefined }],
  ]);

  it('помечает участок описания', () => {
    const text = 'Созвон завтра 16:00 — обсудить бюджет';
    const { spans } = parseQuickInput(text, CTX);
    expect(spans.map(({ field, from, to }) => [field, text.slice(from, to)])).toEqual([
      ['day', 'завтра'], ['time', '16:00'], ['description', 'обсудить бюджет'],
    ]);
  });
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

describe('ввод текстом: здоровье (spec 020)', () => {
  run([
    ['сон 23:40-07:30', {
      kind: 'sleep', start: '23:40', end: '07:30', minutes: 470, day: '2026-10-08', error: undefined,
    }],
    ['сон 00:50–07:36', { kind: 'sleep', start: '00:50', end: '07:36', minutes: 406 }],
    ['спал 7,5 ч', { kind: 'sleep', minutes: 450, start: undefined }],
    ['сегодня я спал с 4:00 до 12:00', { kind: 'sleep', start: '04:00', end: '12:00', minutes: 480, error: undefined }],
    ['спал с 4 до 12', { kind: 'sleep', start: '04:00', end: '12:00', minutes: 480 }],
    ['поспала с 23 до 7:30', { kind: 'sleep', start: '23:00', end: '07:30', minutes: 510 }],
    ['лёг в 1:30, встал в 9', { kind: 'sleep', start: '01:30', end: '09:00', minutes: 450 }],
    ['уснула в 23 и проснулась в 6:45', { kind: 'sleep', start: '23:00', end: '06:45', minutes: 465 }],
    ['спал с 11 до 7', { kind: 'sleep', start: '23:00', end: '07:00', minutes: 480 }],
    ['я спал 6 ч', { kind: 'sleep', minutes: 360, start: undefined }],
    ['я спал плохо', { kind: 'task', name: 'я спал плохо' }],
    ['сон 7 ч 30 мин', { kind: 'sleep', minutes: 450 }],
    ['сон', { kind: 'sleep', error: 'time' }],
    ['сон 25:00-07:00', { kind: 'sleep', error: 'time' }],
    ['сонная лощина', { kind: 'task', name: 'сонная лощина' }],
    ['вес 72,4', { kind: 'metric', metric: 'weight', value: 72.4, day: '2026-10-08', error: undefined }],
    ['Вес 80 кг', { kind: 'metric', metric: 'weight', value: 80 }],
    ['давление 120/80', { kind: 'metric', metric: 'pressure', value: 120, value2: 80 }],
    ['давление 130 на 85', { kind: 'metric', metric: 'pressure', value: 130, value2: 85 }],
    ['давление 120', { kind: 'metric', metric: 'pressure', error: 'name' }],
    ['пульс 64', { kind: 'metric', metric: 'pulse', value: 64 }],
    ['шаги 9500', { kind: 'metric', metric: 'steps', value: 9500 }],
    ['шаги 12 300', { kind: 'metric', metric: 'steps', value: 12300 }],
    ['самочувствие 4', { kind: 'metric', metric: 'mood', value: 4 }],
    ['самочувствие 7', { kind: 'metric', metric: 'mood', error: 'name' }],
    ['вес книги проверить', { kind: 'metric', error: 'name' }],
    ['вес книги проверить', { kind: 'task', name: 'вес книги проверить' }, { kind: 'task' }],
    ['бег 5 км 28 мин', {
      kind: 'workout', name: 'бег', distanceKm: 5, minutes: 28, day: '2026-10-08', error: undefined,
    }],
    ['Бег 10,5 км', { kind: 'workout', name: 'Бег', distanceKm: 10.5, minutes: undefined, error: undefined }],
    ['зал присед 4x8x80, жим 3x10x60', {
      kind: 'workout',
      name: 'зал',
      exercises: [{ name: 'присед', sets: 4, reps: 8, weight: 80 }, { name: 'жим', sets: 3, reps: 10, weight: 60 }],
      error: undefined,
    }],
    ['зал подтягивания 3х8', { kind: 'workout', exercises: [{ name: 'подтягивания', sets: 3, reps: 8 }] }],
    ['зал 60 мин', { kind: 'workout', name: 'зал', minutes: 60, start: undefined }],
    ['зал', { kind: 'workout', error: 'minutes' }],
    ['йога вчера 40 мин', { kind: 'workout', name: 'йога', day: '2026-10-07', minutes: 40 }],
    ['отчёт вчера', { kind: 'task', name: 'отчёт', day: '2026-10-07' }],
    // Тренировка с временем, на будущий день либо с повтором — событие календаря
    ['зал завтра 19:00 60 мин', { kind: 'event', name: 'зал', day: '2026-10-09', start: '19:00', end: '20:00' }],
    ['зал 19:00', { kind: 'event', name: 'зал', start: '19:00' }],
    ['бег по вт и чт 7:00', { kind: 'event', name: 'бег' }],
    ['зал завтра', { kind: 'task', name: 'зал', day: '2026-10-09' }],
    ['зал завтра 19:00 60 мин', { kind: 'workout', name: 'зал', day: '2026-10-09', start: '19:00', minutes: 60 }, {
      kind: 'workout',
    }],
    ['залить фундамент', { kind: 'task', name: 'залить фундамент' }],
    ['обед гречка сахар 14 соль 0,5 520 ккал', {
      kind: 'food', name: 'гречка', nutrients: { kcal: 520, sugar: 14, salt: 0.5 },
    }],
    ['цель белок 140 вода 2,5л сон 8ч день с 8 до 22', {
      kind: 'goal',
      day: undefined,
      goalChanges: {
        goals: { protein: 140, water: 2500 }, health: { sleepMinutes: 480 }, dayStart: 480, dayEnd: 1320,
      },
      error: undefined,
    }],
    ['цели ккал 2200 жиры 75 углеводы 260 клетчатка 30', {
      kind: 'goal',
      goalChanges: {
        goals: {
          kcal: 2200, fat: 75, carbs: 260, fiber: 30,
        },
        health: {},
      },
    }],
    ['цель сахар 50 соль 5 вес 72 шаги 8000 бюджет 10 ч', {
      kind: 'goal',
      goalChanges: {
        goals: {},
        health: {
          sugarMax: 50, saltMax: 5, weight: 72, steps: 8000,
        },
        budget: 600,
      },
    }],
    ['цель вода 2000', { kind: 'goal', goalChanges: { goals: { water: 2000 }, health: {} } }],
    ['цель день с 22 до 8', { kind: 'goal', error: 'time' }],
    ['цель выучить язык', { kind: 'goal', error: 'name' }],
    ['цель выучить язык', { kind: 'task', name: 'цель выучить язык' }, { kinds: ['task', 'event'] }],
    ['целый день дома', { kind: 'task', name: 'целый день дома' }],
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

// ── английский словарь: те же разделы, что у русской таблицы ─────────────────

describe('quick input (en): kind and name', () => {
  run([
    ['buy a power supply', { kind: 'task', name: 'buy a power supply', day: undefined, error: undefined }],
    ['Call Mom', { kind: 'task', name: 'Call Mom' }],
    ['task check the papers', { kind: 'task', name: 'check the papers' }],
    ['Task: check the papers', { kind: 'task', name: 'check the papers' }],
    ['todo check the papers', { kind: 'task', name: 'check the papers' }],
    ['tasks for the team', { kind: 'task', name: 'tasks for the team' }],
    ['eventually fix it', { kind: 'task', name: 'eventually fix it' }],
    ['event staff meeting', { kind: 'event', name: 'staff meeting', isAllDay: true, day: '2026-10-08' }],
    ['call 16:00', { kind: 'event', name: 'call', start: '16:00', end: '17:00' }],
    ['task call 16:00', { kind: 'task', name: 'call', start: '16:00', minutes: 30, day: '2026-10-08' }],
    ['tomorrow 15:00', { kind: 'event', name: '', error: 'name' }],
    ['call 16:00', { kind: 'task', name: 'call', start: '16:00', minutes: 30 }, { kind: 'task' }],
    ['report', { kind: 'event', name: 'report', isAllDay: true }, { kind: 'event' }],
    ['lunch 520 kcal', { kind: 'task', name: 'lunch 520 kcal' }, { kinds: ['task', 'event'] }],
    ['water 500 ml', { kind: 'task', name: 'water 500 ml' }, { kinds: ['task', 'event'] }],
  ], EN);
});

describe('quick input (en): time', () => {
  run([
    ['call 9:05', { start: '09:05', end: '10:05', day: '2026-10-09', isDayAssumed: true }],
    ['call at 15:30', { name: 'call', start: '15:30', end: '16:30', day: '2026-10-08', isDayAssumed: true }],
    ['call at 15', { name: 'call', start: '15:00', end: '16:00' }],
    ['call at 5', { name: 'call', start: '17:00', end: '18:00' }],
    ['call at 9', { name: 'call', start: '09:00', day: '2026-10-09' }],
    ['call at 5', { start: '05:00' }, { dayStart: 4 * 60, dayEnd: 12 * 60 }],
    ['call 5pm', { kind: 'event', name: 'call', start: '17:00' }],
    ['call 5 pm', { name: 'call', start: '17:00' }],
    ['call at 5 am', { name: 'call', start: '05:00', day: '2026-10-09' }],
    ['call at 12am', { name: 'call', start: '00:00', day: '2026-10-09' }],
    ['call 12pm', { name: 'call', start: '12:00' }],
    ['call at 7:30 pm', { name: 'call', start: '19:30', end: '20:30' }],
    ['call 7:30pm', { name: 'call', start: '19:30' }],
    ['call at 11 at night', { name: 'call', start: '23:00', end: '23:59' }],
    ['call at 7 in the morning', { name: 'call', start: '07:00' }],
    ['standup at noon', { kind: 'event', name: 'standup', start: '12:00' }],
    ['class from 10 to 12', { kind: 'event', name: 'class', start: '10:00', end: '12:00', minutes: 120 }],
    ['class 10:00-11:30', { name: 'class', start: '10:00', end: '11:30', minutes: 90 }],
    ['class 10–12:30', { name: 'class', start: '10:00', end: '12:30' }],
    ['class 5-6pm', { name: 'class', start: '17:00', end: '18:00' }],
    ['class 10am-2pm', { name: 'class', start: '10:00', end: '14:00' }],
    ['class 11-1pm', { name: 'class', start: '11:00', end: '13:00' }],
    ['score 10-12', { kind: 'task', name: 'score 10-12', start: undefined }],
    ['10 to 12 people', { kind: 'task', name: '10 to 12 people', start: undefined }],
    ['call 23:30', { start: '23:30', end: undefined, error: 'time' }],
    ['call 25:00', { kind: 'task', name: 'call 25:00' }],
    ['call 16:00 and 18:00', { name: 'call and 18:00', start: '16:00' }],
    ['version 3.5', { kind: 'task', name: 'version 3.5', day: undefined }],
    ['meeting on 15.10', { kind: 'task', name: 'meeting', day: '2026-10-15', start: undefined }],
  ], EN);
});

describe('quick input (en): duration', () => {
  run([
    ['call 16:00 45 min', { name: 'call', start: '16:00', end: '16:45', minutes: 45 }],
    ['call 16:00 1.5 h', { name: 'call', end: '17:30', minutes: 90 }],
    ['call 16:00 2 hours', { name: 'call', end: '18:00' }],
    ['call 16:00 1 h 30 min', { name: 'call', end: '17:30', minutes: 90 }],
    ['call 16:00 1h 30m', { name: 'call', end: '17:30', minutes: 90 }],
    ['call 16:00 half an hour', { name: 'call', end: '16:30' }],
    ['call 16:00 an hour and a half', { name: 'call', end: '17:30' }],
    ['sort the mail 20 minutes', { kind: 'task', name: 'sort the mail', minutes: 20, day: undefined }],
    ['sort the mail 45m', { kind: 'task', name: 'sort the mail', minutes: 45 }],
    ['task report tomorrow 18:00 40 min', {
      kind: 'task', name: 'report', day: '2026-10-09', start: '18:00', minutes: 40,
    }],
    ['buy 5 m of cable', { name: 'buy 5 m of cable', minutes: undefined }],
    ['course 5 months', { name: 'course 5 months', minutes: undefined, repeat: undefined }],
    ['call 23:00 2 hours', { error: 'time' }],
  ], EN);
});

describe('quick input (en): date and deadline', () => {
  run([
    ['report today', { kind: 'task', name: 'report', day: '2026-10-08' }],
    ['report tomorrow', { name: 'report', day: '2026-10-09', isDayAssumed: undefined }],
    ['report the day after tomorrow', { name: 'report', day: '2026-10-10' }],
    ['report yesterday', { name: 'report', day: '2026-10-07' }],
    ['report in 3 days', { name: 'report', day: '2026-10-11' }],
    ['report in a week', { name: 'report', day: '2026-10-15' }],
    ['report in 2 weeks', { name: 'report', day: '2026-10-22' }],
    ['report in 2 months', { name: 'report', day: '2026-12-08' }],
    ['report next week', { name: 'report', day: '2026-10-12' }],
    ['report on fri', { name: 'report', day: '2026-10-09' }],
    ['report friday', { name: 'report', day: '2026-10-09' }],
    ['report thu', { name: 'report', day: '2026-10-15' }],
    ['report on Tuesday', { name: 'report', day: '2026-10-13' }],
    ['report next wednesday', { name: 'report', day: '2026-10-14' }],
    ['report sun', { name: 'report', day: '2026-10-11' }],
    ['report 12.10', { name: 'report', day: '2026-10-12' }],
    ['report 05.03', { name: 'report', day: '2027-03-05' }],
    ['report Oct 12', { name: 'report', day: '2026-10-12' }],
    ['report 12 Oct', { name: 'report', day: '2026-10-12' }],
    ['report October 12', { name: 'report', day: '2026-10-12' }],
    ['report 12th of October', { name: 'report', day: '2026-10-12' }],
    ['report May 1', { name: 'report', day: '2027-05-01' }],
    ['report 3 March', { name: 'report', day: '2027-03-03' }],
    ['report 31.02', { name: 'report 31.02', day: undefined }],
    ['report Feb 31', { name: 'report Feb 31', day: undefined }],
    ['report for tomorrow', { name: 'report', day: '2026-10-09' }],
    ['call thu 16:00', { kind: 'event', name: 'call', day: '2026-10-15', start: '16:00', end: '17:00' }],
    ['call at 5 fri', { kind: 'event', name: 'call', day: '2026-10-09', start: '17:00' }],
    ['task check the papers by fri', { kind: 'task', name: 'check the papers', due: '2026-10-09', day: undefined }],
    ['report by 20.10', { name: 'report', due: '2026-10-20' }],
    ['report until tomorrow', { name: 'report', due: '2026-10-09' }],
    ['report by March', { name: 'report', due: '2027-03-01' }],
    ['report due Oct 20', { name: 'report', due: '2026-10-20' }],
    ['report on mon by fri', { name: 'report', day: '2026-10-12', due: '2026-10-09', error: 'dayAfterDue' }],
    ['stand by me', { name: 'stand by me', due: undefined }],
    // Ловушки: слова, похожие на дни и месяцы
    ['power supply 1000 W', { name: 'power supply 1000 W', day: undefined }],
    ['room 12 fri', { name: 'room 12 fri', day: undefined }],
    ['march of the penguins', { name: 'march of the penguins', day: undefined, due: undefined }],
    ['may be later', { name: 'may be later', day: undefined }],
    ['sat down with the team', { name: 'sat down with the team', day: undefined }],
    ['sun cream and a hat', { name: 'sun cream and a hat', day: undefined }],
    ['wed planner review', { name: 'wed planner review', day: undefined }],
    ['satellite launch', { name: 'satellite launch', day: undefined }],
    ['monitor stand', { name: 'monitor stand', day: undefined }],
    ['meeting sat 15:00', { kind: 'event', name: 'meeting', day: '2026-10-10', start: '15:00' }],
    ['party on sat', { name: 'party', day: '2026-10-10' }],
    ['dentist wed at 5', { kind: 'event', name: 'dentist', day: '2026-10-14', start: '17:00' }],
    ['report tomorrow and friday', { name: 'report and friday', day: '2026-10-09' }],
    ['Submit REPORT Tomorrow', { name: 'Submit REPORT', day: '2026-10-09' }],
  ], EN);
});

describe('quick input (en): repeat', () => {
  run([
    ['lesson tue 15:00 every week for 5 months', {
      kind: 'event',
      name: 'lesson',
      start: '15:00',
      end: '15:45',
      day: '2026-10-13',
      repeat: {
        ...WEEKLY, weekdays: [2], startDay: '2026-10-13', endDay: '2027-03-13',
      },
      error: undefined,
    }],
    ['exercise every day', {
      kind: 'task', name: 'exercise', repeat: { kind: 'daily', interval: 1, startDay: '2026-10-08' },
    }],
    ['exercise daily 8:00 15 min', {
      kind: 'event', name: 'exercise', start: '08:00', end: '08:15', repeat: { kind: 'daily', startDay: '2026-10-08' },
    }],
    ['watering every 3 days', { name: 'watering', repeat: { kind: 'daily', interval: 3 } }],
    ['watering every other day', { name: 'watering', repeat: { kind: 'daily', interval: 2 } }],
    ['report every week', { name: 'report', repeat: { ...WEEKLY, weekdays: [4], startDay: '2026-10-08' } }],
    ['report weekly', { name: 'report', repeat: { ...WEEKLY, weekdays: [4] } }],
    ['report every 2 weeks', { name: 'report', repeat: { kind: 'weekly', interval: 2, weekdays: [4] } }],
    ['report once every two weeks', { name: 'report', repeat: { kind: 'weekly', interval: 2 } }],
    ['report once a week', { name: 'report', repeat: { kind: 'weekly', interval: 1 } }],
    ['rent every month', { name: 'rent', repeat: { kind: 'monthly', interval: 1, startDay: '2026-10-08' } }],
    ['rent monthly 20.10', { name: 'rent', repeat: { kind: 'monthly', startDay: '2026-10-20' } }],
    ['rent every 3 months', { name: 'rent', repeat: { kind: 'monthly', interval: 3 } }],
    ['insurance every year', { name: 'insurance', repeat: { kind: 'yearly', interval: 1 } }],
    ['insurance yearly', { name: 'insurance', repeat: { kind: 'yearly' } }],
    ['gym on weekdays 19:00', {
      kind: 'event', name: 'gym', repeat: { ...WEEKLY, weekdays: [1, 2, 3, 4, 5], startDay: '2026-10-08' },
    }],
    ['cleaning on weekends', { name: 'cleaning', repeat: { ...WEEKLY, weekdays: [0, 6], startDay: '2026-10-10' } }],
    ['gym on mon, wed and fri 19:00', {
      name: 'gym', start: '19:00', repeat: { ...WEEKLY, weekdays: [1, 3, 5], startDay: '2026-10-09' },
    }],
    ['lesson on tue and thu at 5 pm 45 min', {
      kind: 'event',
      name: 'lesson',
      start: '17:00',
      end: '17:45',
      repeat: { ...WEEKLY, weekdays: [2, 4], startDay: '2026-10-08' },
    }],
    ['lesson on tuesdays', { name: 'lesson', repeat: { ...WEEKLY, weekdays: [2], startDay: '2026-10-13' } }],
    ['lesson tuesdays 15:00', { kind: 'event', name: 'lesson', repeat: { ...WEEKLY, weekdays: [2] } }],
    ['lesson every tuesday 15:00', { name: 'lesson', repeat: { ...WEEKLY, weekdays: [2] } }],
    ['lesson every friday', { name: 'lesson', repeat: { ...WEEKLY, weekdays: [5], startDay: '2026-10-09' } }],
    ['lesson every week until 20.12', { name: 'lesson', repeat: { ...WEEKLY, endDay: '2026-12-20' }, due: undefined }],
    ['lesson every week until March', { name: 'lesson', repeat: { ...WEEKLY, endDay: '2027-03-01' } }],
    ['lesson every week 10 times', { name: 'lesson', repeat: { ...WEEKLY, count: 10 } }],
    ['lesson every week for 6 weeks', { name: 'lesson', repeat: { ...WEEKLY, endDay: '2026-11-19' } }],
    ['lesson every day 2 months', { name: 'lesson', repeat: { kind: 'daily', endDay: '2026-12-08' } }],
    // Один день после «on» — дата, не повтор
    ['report on friday', { name: 'report', day: '2026-10-09', repeat: undefined }],
    ['repeat the exercise 10 times', { name: 'repeat the exercise 10 times', repeat: undefined }],
    ['weekend trip', { name: 'weekend trip', repeat: undefined }],
  ], EN);
});

describe('quick input (en): removed values stay in the name', () => {
  run([
    ['call tomorrow 16:00', { kind: 'task', name: 'call 16:00', day: '2026-10-09' }, { skip: ['time'] }],
    ['call tomorrow 16:00', { name: 'call tomorrow', start: '16:00', day: '2026-10-08' }, { skip: ['day'] }],
    ['report by fri', { name: 'report by', due: undefined, day: '2026-10-09' }, { skip: ['due'] }],
    ['lesson every week', { name: 'lesson every week', repeat: undefined }, { skip: ['repeat'] }],
    ['sort the mail 20 minutes', { name: 'sort the mail 20 minutes', minutes: undefined }, { skip: ['minutes'] }],
    ['task report', { name: 'task report' }, { skip: ['kind'] }],
  ], EN);
});

describe('quick input (en): usual duration by the head word of the name', () => {
  run([
    ['tue 15:00 lesson on English', {
      kind: 'event', name: 'lesson on English', description: undefined, start: '15:00', end: '15:45',
    }],
    ['tomorrow at 9 lesson', { kind: 'event', name: 'lesson', day: '2026-10-09', start: '09:00', end: '09:45' }],
    ['event lessons 10:00', { kind: 'event', name: 'lessons', start: '10:00', end: '10:45' }],
    ['prepare lessons tomorrow 9:00', { name: 'prepare lessons', start: '09:00', end: '10:00' }],
    ['English lesson tue 15:00', { name: 'English lesson', end: '16:00' }],
    ['tue 15:00 lesson on physics 2 hours', { name: 'lesson on physics', end: '17:00' }],
    ['tue lesson on physics 15:00-16:20', { name: 'lesson on physics', end: '16:20' }],
  ], EN);
});

describe('quick input (en): name and description', () => {
  const OWNER = {
    kind: 'event', name: 'lesson on English', description: 'will be a listening test', day: '2026-10-13',
    start: '15:00', end: '15:45', error: undefined,
  } as const;
  run([
    ['tue 15:00 lesson on English will be a listening test', OWNER],
    ['lesson on English tue 15:00 will be a listening test', OWNER],
    ['lesson on English will be a listening test tue 15:00', OWNER],
    ['lesson on English — listening test tue 15:00', {
      name: 'lesson on English', description: 'listening test', day: '2026-10-13', end: '15:45',
    }],
    // Separators
    ['call tomorrow 16:00 — discuss the budget', {
      kind: 'event', name: 'call', description: 'discuss the budget', day: '2026-10-09', start: '16:00', end: '17:00',
    }],
    ['call – discuss the budget', { kind: 'task', name: 'call', description: 'discuss the budget' }],
    ['buy milk - 2 cartons', { name: 'buy milk', description: '2 cartons' }],
    ['meeting with Pete: budget, deadlines', { name: 'meeting with Pete', description: 'budget, deadlines' }],
    ['buy a gift; mom likes earrings', { name: 'buy a gift', description: 'mom likes earrings' }],
    ['Send the report. Attach the table', { name: 'Send the report', description: 'Attach the table' }],
    ['haircut sat 12:00 // ask for Anna', {
      name: 'haircut', description: 'ask for Anna', day: '2026-10-10', start: '12:00',
    }],
    ['call tomorrow\ndiscuss the budget\nand deadlines', {
      name: 'call', description: 'discuss the budget\nand deadlines', day: '2026-10-09',
    }],
    ['Mom needs a call — about the cottage', { name: 'Mom needs a call', description: 'about the cottage' }],
    // Labels
    ['meeting with advisor note: check the draft', { name: 'meeting with advisor', description: 'check the draft' }],
    ['meeting with advisor - description: check the draft', {
      name: 'meeting with advisor', description: 'check the draft',
    }],
    ['physics class topic: optics', { name: 'physics class', description: 'topic: optics' }],
    ['meeting notes - check the draft', { name: 'meeting notes', description: 'check the draft' }],
    ['write description of the project', { name: 'write description of the project', description: undefined }],
    ['send note to John', { name: 'send note to John', description: undefined }],
    ['pick a topic for the talk', { name: 'pick a topic for the talk', description: undefined }],
    // Lead-ins
    ['dentist fri 10:30 need to bring insurance card', {
      kind: 'event', name: 'dentist', description: 'need to bring insurance card', day: '2026-10-09', start: '10:30',
    }],
    ['trip to Boston don\'t forget the charger', {
      name: 'trip to Boston', description: 'don\'t forget the charger',
    }],
    ['trip to Boston dont forget the charger', { name: 'trip to Boston', description: 'dont forget the charger' }],
    ['seminar bring laptop', { name: 'seminar', description: 'bring laptop' }],
    ['car service needs an oil change', { name: 'car service', description: 'needs an oil change' }],
    // Deadline and repeat with a description
    ['task check the papers by fri — classes 9B and 10A', {
      kind: 'task', name: 'check the papers', due: '2026-10-09', description: 'classes 9B and 10A',
    }],
    ['English on tue and thu 18:00 — bring the textbook', {
      kind: 'event', name: 'English', description: 'bring the textbook', repeat: { ...WEEKLY, weekdays: [2, 4] },
    }],
    ['standup daily: collect the statuses', {
      kind: 'task', name: 'standup', description: 'collect the statuses', repeat: { kind: 'daily', interval: 1 },
    }],
    // Typos are still corrected
    ['lesson tomorow 9:00 — bring notebook', {
      name: 'lesson', description: 'bring notebook', day: '2026-10-09', end: '09:45',
    }],
    // No split
    ['Python from scratch(R212) tue 15:00', {
      name: 'Python from scratch(R212)', description: undefined, day: '2026-10-13',
    }],
    ['buy milk, bread', { name: 'buy milk, bread', description: undefined }],
    ['buy a T-shirt tomorrow', { name: 'buy a T-shirt', description: undefined }],
    ['class 10:00 — 11:30', { name: 'class', description: undefined, end: '11:30' }],
    ['meet Mr. Smith tomorrow', { name: 'meet Mr. Smith', description: undefined }],
    ['buy milk e.g. oat tomorrow', { name: 'buy milk e.g. oat', description: undefined }],
    ['buy 2 kg. of apples', { name: 'buy 2 kg. of apples', description: undefined }],
    ['U.S. visa interview fri 10:00', { name: 'U.S. visa interview', description: undefined }],
    ['need to bring passport', { name: 'need to bring passport', description: undefined }],
    ['don\'t forget to bring passport', { name: 'don\'t forget to bring passport', description: undefined }],
    ['I need to buy milk', { name: 'I need to buy milk', description: undefined }],
    ['at the bank bring the form', { name: 'at the bank bring the form', description: undefined }],
    ['remember to bring laptop', { name: 'remember to bring laptop', description: undefined }],
    ['test will be on friday', { name: 'test will be', description: undefined, day: '2026-10-09' }],
    // The removed description goes back to the name
    ['tue 15:00 lesson on English will be a test', {
      name: 'lesson on English will be a test', description: undefined, end: '15:45',
    }, { skip: ['description'] }],
    // Meals and health records are not split
    ['lunch buckwheat 13:00 650 kcal — tasty', { kind: 'food', description: undefined }],
    ['run 5 km 28 min - park', { kind: 'workout', description: undefined }],
  ], EN);
});

describe('quick input (en): meal and water', () => {
  run([
    ['lunch buckwheat 150g p30 f10 c60 fiber 6 520 kcal', {
      kind: 'food',
      name: 'buckwheat',
      meal: 'lunch',
      grams: 150,
      nutrients: {
        kcal: 520, protein: 30, fat: 10, carbs: 60, fiber: 6,
      },
      day: '2026-10-08',
      error: undefined,
    }],
    ['lunch buckwheat 13:00 650 kcal', { kind: 'food', name: 'buckwheat', meal: 'lunch', nutrients: { kcal: 650 } }],
    ['oatmeal 9:00 300 kcal', { kind: 'food', name: 'oatmeal', meal: 'breakfast' }],
    ['cottage cheese 200 kcal', { kind: 'food', name: 'cottage cheese', meal: 'lunch' }],
    ['cottage cheese 200 kcal', { meal: 'dinner' }, { nowMinutes: 19 * 60 }],
    ['dinner 600 kcal', { kind: 'food', name: 'dinner', meal: 'dinner' }],
    ['snack nuts 30 g 180 cal', { kind: 'food', name: 'nuts', meal: 'snack', grams: 30 }],
    ['chicken protein 30 fat 5 carbs 0', {
      kind: 'food', name: 'chicken', nutrients: { protein: 30, fat: 5, carbs: 0, kcal: 165 },
    }],
    ['cheese p 12.5 f 15', { kind: 'food', name: 'cheese', nutrients: { protein: 12.5, fat: 15, kcal: 185 } }],
    ['lunch buckwheat sugar 14 salt 0.5 520 kcal', {
      kind: 'food', name: 'buckwheat', nutrients: { kcal: 520, sugar: 14, salt: 0.5 },
    }],
    ['520 kcal', { kind: 'food', error: 'name' }],
    ['lunch tomorrow 700 kcal', { kind: 'food', day: '2026-10-09', meal: 'lunch' }],
    ['lunch with Pete 13:00', { kind: 'event', name: 'lunch with Pete', start: '13:00' }],
    // Одна буква с числом — не питание, пока признак один
    ['watch f1 race 15:00', { kind: 'event', name: 'watch f1 race', start: '15:00' }],
    ['vitamin c 500', { kind: 'task', name: 'vitamin c 500' }],
    ['water 500 ml', { kind: 'water', waterMl: 500, name: '', day: '2026-10-08' }],
    ['2 glasses', { kind: 'water', waterMl: 500 }],
    ['1.5 l', { kind: 'water', waterMl: 1500 }],
    ['water 2 liters', { kind: 'water', waterMl: 2000 }],
    ['glass of water', { kind: 'task', name: 'glass of water' }],
    ['buy milk 2 l', { kind: 'task', name: 'buy milk 2 l', waterMl: undefined }],
    ['waterproof jacket 2 l', { kind: 'task', name: 'waterproof jacket 2 l', waterMl: undefined }],
    ['kefir', { kind: 'water', waterMl: undefined }, { kind: 'water' }],
    ['buckwheat', { kind: 'food', name: 'buckwheat', nutrients: {} }, { kind: 'food' }],
  ], EN);
});

describe('quick input (en): health', () => {
  run([
    ['sleep 23:40-07:30', {
      kind: 'sleep', start: '23:40', end: '07:30', minutes: 470, day: '2026-10-08', error: undefined,
    }],
    ['slept 7.5 h', { kind: 'sleep', minutes: 450, start: undefined }],
    ['today i slept from 4:00 to 12:00', { kind: 'sleep', start: '04:00', end: '12:00', minutes: 480 }],
    ['slept from 11 to 7', { kind: 'sleep', start: '23:00', end: '07:00', minutes: 480 }],
    ['went to bed at 1:30, woke up at 9', { kind: 'sleep', start: '01:30', end: '09:00', minutes: 450 }],
    ['sleep 7 hours 30 min', { kind: 'sleep', minutes: 450 }],
    ['slept', { kind: 'sleep', error: 'time' }],
    ['sleep 25:00-07:00', { kind: 'sleep', error: 'time' }, { kind: 'sleep' }],
    ['sleepy hollow', { kind: 'task', name: 'sleepy hollow' }],
    ['weight 72.4', { kind: 'metric', metric: 'weight', value: 72.4, day: '2026-10-08', error: undefined }],
    ['Weight 80 kg', { kind: 'metric', metric: 'weight', value: 80 }],
    ['bp 120/80', { kind: 'metric', metric: 'pressure', value: 120, value2: 80 }],
    ['blood pressure 130 over 85', { kind: 'metric', metric: 'pressure', value: 130, value2: 85 }],
    ['bp 120', { kind: 'metric', metric: 'pressure', error: 'name' }],
    ['pulse 64', { kind: 'metric', metric: 'pulse', value: 64 }],
    ['hr 64 bpm', { kind: 'metric', metric: 'pulse', value: 64 }],
    ['steps 9500', { kind: 'metric', metric: 'steps', value: 9500 }],
    ['steps 12 300', { kind: 'metric', metric: 'steps', value: 12300 }],
    ['mood 4', { kind: 'metric', metric: 'mood', value: 4 }],
    ['mood 7', { kind: 'metric', metric: 'mood', error: 'name' }, { kind: 'metric' }],
    // Обычные слова в начале строки: без значения — название дела
    ['weight of the book', { kind: 'task', name: 'weight of the book' }],
    ['weight of the book', { kind: 'metric', error: 'name' }, { kind: 'metric' }],
    ['steps to reproduce the bug', { kind: 'task', name: 'steps to reproduce the bug' }],
    ['run tests', { kind: 'task', name: 'run tests' }],
    ['walk the dog', { kind: 'task', name: 'walk the dog' }],
    ['running late', { kind: 'task', name: 'running late' }],
    ['goal learn the language', { kind: 'task', name: 'goal learn the language' }],
    ['goal learn the language', { kind: 'goal', error: 'name' }, { kind: 'goal' }],
    ['run 5 km 28 min', {
      kind: 'workout', name: 'run', distanceKm: 5, minutes: 28, day: '2026-10-08', error: undefined,
    }],
    ['Run 10.5 km', { kind: 'workout', name: 'Run', distanceKm: 10.5, minutes: undefined, error: undefined }],
    ['run 5k', { kind: 'workout', name: 'run', distanceKm: 5 }],
    ['run 3 mi 30 min', { kind: 'workout', name: 'run', distanceKm: 4.83, minutes: 30 }],
    ['gym squat 4x8x80, bench press 3x10x60', {
      kind: 'workout',
      name: 'gym',
      exercises: [
        { name: 'squat', sets: 4, reps: 8, weight: 80 }, { name: 'bench press', sets: 3, reps: 10, weight: 60 },
      ],
      error: undefined,
    }],
    ['gym pullups 3x8', { kind: 'workout', exercises: [{ name: 'pullups', sets: 3, reps: 8 }] }],
    ['gym 60 min', { kind: 'workout', name: 'gym', minutes: 60, start: undefined }],
    ['gym', { kind: 'workout', error: 'minutes' }],
    ['yoga yesterday 40 min', { kind: 'workout', name: 'yoga', day: '2026-10-07', minutes: 40 }],
    // Тренировка с временем, на будущий день либо с повтором — событие календаря
    ['gym tomorrow 19:00 60 min', { kind: 'event', name: 'gym', day: '2026-10-09', start: '19:00', end: '20:00' }],
    ['gym 7pm', { kind: 'event', name: 'gym', start: '19:00' }],
    ['run on tue and thu 7:00', { kind: 'event', name: 'run' }],
    ['gym tomorrow', { kind: 'task', name: 'gym', day: '2026-10-09' }],
    ['gym tomorrow 19:00 60 min', { kind: 'workout', name: 'gym', day: '2026-10-09', start: '19:00', minutes: 60 }, {
      kind: 'workout',
    }],
    ['goal protein 140 water 2.5l sleep 8h day from 8 to 22', {
      kind: 'goal',
      day: undefined,
      goalChanges: {
        goals: { protein: 140, water: 2500 }, health: { sleepMinutes: 480 }, dayStart: 480, dayEnd: 1320,
      },
      error: undefined,
    }],
    ['goals kcal 2200 fat 75 carbs 260 fiber 30', {
      kind: 'goal',
      goalChanges: {
        goals: {
          kcal: 2200, fat: 75, carbs: 260, fiber: 30,
        },
        health: {},
      },
    }],
    ['goal sugar 50 salt 5 weight 72 steps 8000 budget 10 h', {
      kind: 'goal',
      goalChanges: {
        goals: {},
        health: {
          sugarMax: 50, saltMax: 5, weight: 72, steps: 8000,
        },
        budget: 600,
      },
    }],
    ['goal water 2000', { kind: 'goal', goalChanges: { goals: { water: 2000 }, health: {} } }],
    ['goal day from 22 to 8', { kind: 'goal', error: 'time' }],
    // Поле целей на экране «Здоровье»: тип задан, слова «goal» нет
    ['protein 140 water 2.5l', { kind: 'goal', goalChanges: { goals: { protein: 140, water: 2500 } } }, {
      kind: 'goal',
    }],
  ], EN);
});

describe('ввод текстом: язык словаря', () => {
  run([
    // Русский интерфейс (по умолчанию), строка латиницей — английский словарь
    ['call tomorrow 5pm', { kind: 'event', name: 'call', day: '2026-10-09', start: '17:00' }],
    ['weight 72.4', { kind: 'metric', metric: 'weight', value: 72.4 }],
    // Смешанные буквы — словарь, распознавший больше; при равенстве — язык интерфейса
    ['созвон tomorrow 16:00', { kind: 'event', name: 'созвон', day: '2026-10-09', start: '16:00' }],
    ['созвон Zoom завтра 16:00', { kind: 'event', name: 'созвон Zoom', day: '2026-10-09', start: '16:00' }],
    ['зал squat 4x8x80', { kind: 'workout', name: 'зал', exercises: [{ name: 'squat', sets: 4, reps: 8 }] }],
    ['MacBook завтра', { kind: 'task', name: 'MacBook', day: '2026-10-09' }],
    ['обед sat down', { kind: 'task', name: 'обед sat down', day: undefined }],
    ['белок 140 вода 2,5л', { kind: 'goal', goalChanges: { goals: { protein: 140, water: 2500 } } }, { kind: 'goal' }],
  ]);
  run([
    // Английский интерфейс, строка кириллицей — русский словарь
    ['созвон завтра в 5', { kind: 'event', name: 'созвон', day: '2026-10-09', start: '17:00' }],
    ['вес 72,4', { kind: 'metric', metric: 'weight', value: 72.4 }],
    ['созвон tomorrow 16:00 ', { kind: 'event', name: 'созвон', day: '2026-10-09', start: '16:00' }],
    ['call завтра 16:00', { kind: 'event', name: 'call', day: '2026-10-09', start: '16:00' }],
    ['зал присед 4x8x80, жим 3x10x60', { kind: 'workout', name: 'зал', error: undefined }],
    ['созвон Zoom 16:00', { kind: 'event', name: 'созвон Zoom', start: '16:00' }],
  ], EN);

  it('язык словаря по языку интерфейса', () => {
    expect(['ru', 'ru-RU', 'en', 'de', undefined].map(getQuickLang)).toEqual(['ru', 'ru', 'en', 'en', 'en']);
  });

  // Примеры и подсказки экранов лежат в строках локализации: каждый обязан разбираться своим словарём
  it.each([['fallback.strings', 'en'], ['ru.strings', 'ru']] as const)('примеры из %s разбираются', (file, lang) => {
    const strings = readFileSync(resolve(__dirname, '../../../assets/localization', file), 'utf8');
    const value = (key: string) => new RegExp(`^"${key}" = "(.*)";$`, 'm').exec(strings)![1];
    const examples = value('PlannerHealthExamples').split(/\s*\|\s*/);
    expect(examples).toHaveLength(9);
    [...examples, value('PlannerQuickPlaceholder')].forEach((line) => {
      const draft = parseQuickInput(line, { ...CTX, lang });
      expect(draft.error, line).toBeUndefined();
      expect(draft.kind === 'task' && !draft.spans.length, line).toBe(false);
    });
    const goals = parseQuickInput(value('PlannerHealthGoalsPlaceholder'), { ...CTX, lang, kind: 'goal' });
    expect(goals.goalChanges).toMatchObject({
      goals: { protein: 140, water: 2500 }, health: { sleepMinutes: 480 }, dayStart: 480, dayEnd: 1320,
    });
  });

  // Примеры окна ввода: каждый разбирается без ошибки, один показывает описание
  it.each([['fallback.strings', 'en'], ['ru.strings', 'ru']] as const)('примеры окна из %s', (file, lang) => {
    const strings = readFileSync(resolve(__dirname, '../../../assets/localization', file), 'utf8');
    const examples = /^"PlannerQuickExamples" = "(.*)";$/m.exec(strings)![1].split(/\s*\|\s*/);
    const drafts = examples.map((line) => parseQuickInput(line, { ...CTX, lang }));
    drafts.forEach((draft, index) => expect(draft.error, examples[index]).toBeUndefined());
    const described = drafts.filter(({ description }) => description);
    expect(described).toHaveLength(1);
    expect(described[0]).toMatchObject({ kind: 'event', day: '2026-10-13', start: '15:00' });
    expect(described[0].name).toMatch(/^(пара по английскому|English lesson)$/);
    // Подсказка окна приводит тот же пример
    expect(/^"PlannerQuickHint" = "(.*)";$/m.exec(strings)![1]).toContain(examples[1]);
  });

  it('помечает участки английской строки', () => {
    const text = 'Call tomorrow 16:00 45 min';
    const { spans } = parseQuickInput(text, EN);
    expect(spans.map(({ field, from, to }) => [field, text.slice(from, to)])).toEqual([
      ['day', 'tomorrow'], ['time', '16:00'], ['minutes', '45 min'],
    ]);
  });
});
