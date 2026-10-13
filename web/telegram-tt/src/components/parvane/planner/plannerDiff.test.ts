/* eslint-disable no-null/no-null -- JSON движка: null = «не задано» */
import { describe, expect, it } from 'vitest';

import type { PlannerState } from './plannerModel';
import type { EngineState } from './plannerSync';

import { diffChanges, fromEngineState } from './plannerSync';

// Таблица правок состояния для проверки `diffChanges` (C4): результат должен совпадать с прежней реализацией

const DIFF_ENGINE: EngineState = {
  tasks: [{
    id: 't1',
    name: 'Задача',
    description: 'описание',
    steps: [{ text: 'шаг', isDone: true }, { text: 'ещё', isDone: false }],
    status: 'active',
    listId: 'l1',
    rank: 2,
    day: '2026-10-08',
    start: '10:00',
    due: '2026-10-20',
    minutes: 90,
    source: { chat: 'note:Идеи', opId: 'op1' },
  }, {
    id: 't2',
    name: 'Без оценки',
    description: '',
    steps: [],
    status: 'queue',
    listId: '',
    rank: 0,
    day: '',
    start: '',
    due: '',
    minutes: null,
  }, {
    id: 't3',
    name: 'Ряд',
    description: '',
    steps: [],
    status: 'queue',
    listId: 'l1',
    rank: 1,
    day: '',
    start: '08:00',
    due: '',
    minutes: 15,
    repeat: {
      kind: 'daily', interval: 1, weekdays: [], monthDay: 0, startDay: '2026-10-01', endDay: '', count: 0,
    },
    occurrences: [{ day: '2026-10-05', excluded: false, done: true, doneSteps: [] }],
    origin: null,
  }],
  events: [{ id: 'e1', name: 'Стендап', start: '09:30', end: '09:45', weekdays: [1, 2], day: '' }, {
    id: 'e2',
    name: 'Бассейн',
    start: '19:00',
    end: '20:00',
    weekdays: null,
    day: '',
    repeat: {
      kind: 'weekly', interval: 1, weekdays: [1, 3], monthDay: 0, startDay: '2026-10-12', endDay: '', count: 0,
    },
    occurrences: [{ day: '2026-10-14', excluded: true, done: false, doneSteps: [] }],
    origin: null,
  }, {
    id: 'e3', name: 'Праздник', start: '00:00', end: '23:59', weekdays: null, day: '2026-11-04', allDay: true,
    isHoliday: true, color: 0, description: 'выходной',
  }],
  lists: [{ id: 'l1', name: 'Работа', order: 0 }, { id: 'l2', name: 'Дом', order: 1, color: 3 }],
  nutrition: [{
    day: '2026-10-08',
    entries: [{
      id: 'f1',
      name: 'Творог',
      meal: 'breakfast',
      kcal: 300,
      protein: 45,
      fat: null,
      carbs: null,
      fiber: null,
      grams: 250,
      per100: true,
      time: '08:30',
    }, {
      id: 'f2', name: 'Суп', meal: 'lunch', kcal: 450, protein: 20, fat: 15, carbs: 40, fiber: 5, grams: null,
      per100: false, sugar: 3, salt: 2,
    }],
    isComplete: true,
    fixedGoals: {
      kcal: { target: 2000, tolerance: 100 }, protein: { target: 120, tolerance: 20 }, fat: null, carbs: null,
    },
    waterMl: 500,
  }, {
    day: '2026-10-09', entries: [], isComplete: false, fixedGoals: null, waterMl: 1250,
  }],
  settings: { dayStart: 480, dayEnd: 1200, lunchStart: 780, lunchEnd: 840, margin: 10, budget: 480 },
  goals: {
    kcal: { target: 2100, tolerance: 100 },
    protein: null,
    fat: null,
    carbs: null,
    water: { target: 2000, tolerance: 300 },
  },
  goalPeriods: [{
    id: 'g1',
    startDay: '2026-10-15',
    endDay: '2026-10-15',
    kcal: { target: 1500, tolerance: 100 },
    protein: null,
    fat: null,
    carbs: null,
    fiber: null,
    water: null,
  }],
  health: [{
    id: 'h1', day: '2026-10-08', kind: 'sleep', time: '23:30', endTime: '07:00', value: 450, value2: 0, name: '',
    details: '',
  }, {
    id: 'h2', day: '2026-10-08', kind: 'weight', time: '', endTime: '', value: 81.5, value2: 0, name: '', details: '',
  }, {
    id: 'h3', day: '2026-10-07', kind: 'workout', time: '18:00', endTime: '', value: 45, value2: 5, name: 'бег',
    details: '{"ex":[{"name":"бег","minutes":45}]}',
  }, {
    id: 'health-goals', day: '2000-01-01', kind: 'goals', time: '', endTime: '', value: 0, value2: 0, name: '',
    details: '{"steps":8000,"bedtime":"23:00"}',
  }],
  learned: [{
    id: 'пара', kind: '', kindCount: 0, minutes: 105, minutesCount: 4, touched: 9,
  }, {
    id: 'зал', kind: 'event', kindCount: 3, minutes: null, minutesCount: 0, touched: 10,
  }],
  quickLines: [{
    id: 'q1', text: 'Купить кабель', count: 2, touched: 3, hidden: false,
  }, {
    id: 'q2', text: 'обед', count: 0, touched: 1, hidden: true,
  }],
  headSeq: 7,
  sizeBytes: 1234,
};

const DIFF_CASES: [string, (draft: PlannerState) => void][] = [
  ['ничего', () => {}],
  ['выполнение задачи', (d) => {
    d.tasks[0].status = 'done';
  }],
  ['шаг и описание задачи', (d) => {
    d.tasks[0].steps[1].isDone = true;
    d.tasks[0].description = 'новое';
  }],
  ['удаление и добавление задачи', (d) => {
    d.tasks = d.tasks.filter((t) => t.id !== 't2');
    d.tasks.push({
      id: 't9', name: 'Новая', description: '', steps: [], status: 'queue', project: 'Дом', rank: 1, due: '2026-12-01',
    });
  }],
  ['новый список и перенос задачи', (d) => {
    d.lists.push({ id: 'l3', name: 'Учёба', order: 2, color: 5 });
    d.projects.push('Учёба');
    d.tasks[1].project = 'Учёба';
    d.tasks[0].project = '';
  }],
  ['удаление списка', (d) => {
    d.lists = d.lists.filter((l) => l.id !== 'l2');
    d.projects = d.projects.filter((p) => p !== 'Дом');
  }],
  ['цвет списка', (d) => {
    d.lists[0].color = 2;
    d.lists[1].color = undefined;
  }],
  ['отметка экземпляра ряда и новое правило', (d) => {
    d.tasks[2].occurrences!.push({ day: '2026-10-06', done: true });
    d.tasks[2].occurrences![0].done = false;
    d.tasks[2].repeat = {
      kind: 'weekly', interval: 2, weekdays: [1, 5], startDay: '2026-10-01', endDay: '2026-12-31', count: 10,
    };
  }],
  ['снятие ряда с задачи и дата', (d) => {
    d.tasks[2].repeat = undefined;
    d.tasks[2].occurrences = undefined;
    d.tasks[2].day = '2026-10-20';
  }],
  ['перенос времени события и исключение дня', (d) => {
    d.events[1].start = '18:00';
    d.events[1].end = '19:00';
    d.events[1].occurrences!.push({ day: '2026-10-21', excluded: true });
  }],
  ['событие по дням недели прежнего формата становится рядом', (d) => {
    d.events[0].repeat = {
      kind: 'weekly', interval: 1, weekdays: [1, 2, 4], startDay: '2026-10-05',
    };
  }],
  ['удаление события и новое разовое', (d) => {
    d.events = d.events.filter((e) => e.id !== 'e3');
    d.events.push({
      id: 'e9', name: 'Врач', start: '11:00', end: '11:30', day: '2026-10-22', color: 4, description: 'взять полис',
    });
  }],
  ['отделённый день ряда', (d) => {
    d.events.push({
      id: 'e10', name: 'Бассейн', start: '20:00', end: '21:00', day: '2026-10-19',
      origin: { seriesId: 'e2', day: '2026-10-19' },
    });
    d.events[1].occurrences!.push({ day: '2026-10-19', excluded: true });
  }],
  ['правка и удаление записи еды, вода', (d) => {
    const day = d.nutrition['2026-10-08'];
    day.entries[0].kcal = 320;
    day.entries[0].time = '09:00';
    day.entries = day.entries.filter((e) => e.id !== 'f2');
    day.waterMl = 750;
  }],
  ['новая запись еды и закрытие дня', (d) => {
    d.nutrition['2026-10-09'].entries.push({
      id: 'f9', name: 'Яблоко', meal: 'snack', kcal: 80, carbs: 20, fiber: 3, grams: 150, time: '16:00',
    });
    d.nutrition['2026-10-09'].isComplete = true;
    d.nutrition['2026-10-09'].fixedGoals = { kcal: { target: 1800, tolerance: 50 } };
  }],
  ['день еды исчезает и появляется новый', (d) => {
    delete d.nutrition['2026-10-09'];
    d.nutrition['2026-10-10'] = { entries: [], isComplete: false, waterMl: 250 };
  }],
  ['цели и настройки', (d) => {
    d.goals = { ...d.goals, protein: { target: 130, tolerance: 10 } };
    d.budget = 600;
    d.settings = { ...d.settings, dayEnd: 1260 };
  }],
  ['только бюджет', (d) => {
    d.budget = 420;
  }],
  ['период целей: правка, удаление, новый', (d) => {
    d.goalPeriods[0].goals = { kcal: { target: 1400, tolerance: 100 }, water: { target: 2500, tolerance: 200 } };
    d.goalPeriods.push({ id: 'g2', startDay: '2026-11-01', endDay: '2026-11-07', goals: {} });
  }],
  ['удаление периода целей', (d) => {
    d.goalPeriods = [];
  }],
  ['здоровье: правка, удаление, новая запись', (d) => {
    d.health[1].value = 81.1;
    d.health = d.health.filter((r) => r.id !== 'h3');
    d.health.push({
      id: 'h9', day: '2026-10-08', kind: 'workout', time: '19:00', value: 30, value2: 4.2, name: 'бег',
      exercises: [{ name: 'бег', minutes: 30 }],
    } as PlannerState['health'][number]);
  }],
  ['цели здоровья', (d) => {
    d.healthGoals = { ...d.healthGoals, steps: 10000, waterMl: 2500 } as PlannerState['healthGoals'];
  }],
  ['словарь: правка типа, длительности, удаление, новое слово', (d) => {
    d.learned[0].minutes = 120;
    d.learned[0].minutesCount = 5;
    d.learned[0].touched = 12;
    d.learned = d.learned.filter((w) => w.id !== 'зал');
    d.learned.push({
      id: 'созвон', kind: 'event', kindCount: 1, minutesCount: 0, touched: 13,
    });
  }],
  ['словарь: только тип', (d) => {
    d.learned[1].kind = 'task';
    d.learned[1].kindCount = 4;
  }],
  ['история ввода: правка, удаление, новая строка', (d) => {
    d.quickLines[0].count = 3;
    d.quickLines[0].touched = 5;
    d.quickLines = d.quickLines.filter((l) => l.id !== 'q2');
    d.quickLines.push({
      id: 'q9', text: 'зал 19:00', count: 1, touched: 6,
    });
  }],
  ['всё сразу', (d) => {
    d.tasks[0].status = 'done';
    d.tasks[1].name = 'Переименовано';
    d.events[2].color = 2;
    d.lists[1].order = 5;
    d.nutrition['2026-10-08'].isComplete = false;
    d.budget = 500;
    d.goalPeriods[0].endDay = '2026-10-16';
    d.health[0].value = 420;
    d.healthGoals = { ...d.healthGoals, bedtime: '22:30' } as PlannerState['healthGoals'];
    d.learned[1].touched = 11;
    d.quickLines[1].touched = 2;
  }],
];

// Результат прежней реализации `diffChanges` (JSON.stringify + find) на каждой правке таблицы
const EXPECTED: Record<string, unknown[]> = {
  ничего: [],
  'выполнение задачи': [
    {
      task: {
        id: 't1',
        status: 'done',
      },
    },
  ],
  'шаг и описание задачи': [
    {
      task: {
        id: 't1',
        description: 'новое',
        steps: [
          {
            text: 'шаг',
            isDone: true,
          },
          {
            text: 'ещё',
            isDone: true,
          },
        ],
      },
    },
  ],
  'удаление и добавление задачи': [
    {
      task: {
        id: 't9',
        name: 'Новая',
        description: '',
        steps: [],
        status: 'queue',
        listId: 'l2',
        rank: 1,
        day: '',
        start: '',
        due: '2026-12-01',
        minutes: null,
        repeat: null,
        occurrences: [],
        origin: null,
        source: null,
      },
    },
    {
      task: {
        id: 't2',
        deleted: true,
      },
    },
  ],
  'новый список и перенос задачи': [
    {
      list: {
        id: 'l3',
        name: 'Учёба',
        order: 2,
        color: 5,
      },
    },
    {
      task: {
        id: 't1',
        listId: '',
      },
    },
    {
      task: {
        id: 't2',
        listId: 'l3',
      },
    },
  ],
  'удаление списка': [
    {
      list: {
        id: 'l2',
        deleted: true,
      },
    },
  ],
  'цвет списка': [
    {
      list: {
        id: 'l1',
        color: 2,
      },
    },
    {
      list: {
        id: 'l2',
        color: 0,
      },
    },
  ],
  'отметка экземпляра ряда и новое правило': [
    {
      task: {
        id: 't3',
        repeat: {
          kind: 'weekly',
          interval: 2,
          weekdays: [
            1,
            5,
          ],
          monthDay: 0,
          startDay: '2026-10-01',
          endDay: '2026-12-31',
          count: 10,
        },
        occurrences: [
          {
            day: '2026-10-05',
            excluded: false,
            done: false,
            doneSteps: [],
          },
          {
            day: '2026-10-06',
            excluded: false,
            done: true,
            doneSteps: [],
          },
        ],
      },
    },
  ],
  'снятие ряда с задачи и дата': [
    {
      task: {
        id: 't3',
        day: '2026-10-20',
        repeat: null,
      },
    },
  ],
  'перенос времени события и исключение дня': [
    {
      event: {
        id: 'e2',
        start: '18:00',
        end: '19:00',
        weekdays: null,
        repeat: {
          kind: 'weekly',
          interval: 1,
          weekdays: [
            1,
            3,
          ],
          monthDay: 0,
          startDay: '2026-10-12',
          endDay: '',
          count: 0,
        },
        occurrences: [
          {
            day: '2026-10-21',
            excluded: true,
            done: false,
            doneSteps: [],
          },
        ],
      },
    },
  ],
  'событие по дням недели прежнего формата становится рядом': [
    {
      event: {
        id: 'e1',
        weekdays: null,
        repeat: {
          kind: 'weekly',
          interval: 1,
          weekdays: [
            1,
            2,
            4,
          ],
          monthDay: 0,
          startDay: '2026-10-05',
          endDay: '',
          count: 0,
        },
      },
    },
  ],
  'удаление события и новое разовое': [
    {
      event: {
        id: 'e9',
        name: 'Врач',
        start: '11:00',
        end: '11:30',
        weekdays: null,
        day: '2026-10-22',
        repeat: null,
        occurrences: [],
        origin: null,
        allDay: false,
        isHoliday: false,
        color: 4,
        description: 'взять полис',
      },
    },
    {
      event: {
        id: 'e3',
        deleted: true,
      },
    },
  ],
  'отделённый день ряда': [
    {
      event: {
        id: 'e2',
        weekdays: null,
        repeat: {
          kind: 'weekly',
          interval: 1,
          weekdays: [
            1,
            3,
          ],
          monthDay: 0,
          startDay: '2026-10-12',
          endDay: '',
          count: 0,
        },
        occurrences: [
          {
            day: '2026-10-19',
            excluded: true,
            done: false,
            doneSteps: [],
          },
        ],
      },
    },
    {
      event: {
        id: 'e10',
        name: 'Бассейн',
        start: '20:00',
        end: '21:00',
        weekdays: null,
        day: '2026-10-19',
        repeat: null,
        occurrences: [],
        origin: {
          seriesId: 'e2',
          day: '2026-10-19',
        },
        allDay: false,
        isHoliday: false,
        color: 0,
        description: '',
      },
    },
  ],
  'правка и удаление записи еды, вода': [
    {
      nutritionDay: {
        day: '2026-10-08',
        entries: [
          {
            id: 'f1',
            name: 'Творог',
            meal: 'breakfast',
            kcal: 320,
            protein: 45,
            fat: null,
            carbs: null,
            fiber: null,
            grams: 250,
            per100: true,
            sugar: null,
            salt: null,
            time: '09:00',
          },
          {
            id: 'f2',
            deleted: true,
          },
        ],
        waterMl: 750,
      },
    },
  ],
  'новая запись еды и закрытие дня': [
    {
      nutritionDay: {
        day: '2026-10-09',
        entries: [
          {
            id: 'f9',
            name: 'Яблоко',
            meal: 'snack',
            kcal: 80,
            protein: null,
            fat: null,
            carbs: 20,
            fiber: 3,
            grams: 150,
            per100: false,
            sugar: null,
            salt: null,
            time: '16:00',
          },
        ],
        isComplete: true,
        fixedGoals: {
          kcal: {
            target: 1800,
            tolerance: 50,
          },
          protein: null,
          fat: null,
          carbs: null,
          fiber: null,
          water: null,
        },
      },
    },
  ],
  'день еды исчезает и появляется новый': [
    {
      nutritionDay: {
        day: '2026-10-10',
        entries: [],
        isComplete: false,
        fixedGoals: null,
        waterMl: 250,
      },
    },
    {
      nutritionDay: {
        day: '2026-10-09',
        entries: [],
        waterMl: null,
      },
    },
  ],
  'цели и настройки': [
    {
      settings: {
        dayStart: 480,
        dayEnd: 1260,
        lunchStart: 780,
        lunchEnd: 840,
        margin: 10,
        budget: 600,
      },
    },
    {
      goals: {
        kcal: {
          target: 2100,
          tolerance: 100,
        },
        protein: {
          target: 130,
          tolerance: 10,
        },
        fat: null,
        carbs: null,
        fiber: null,
        water: {
          target: 2000,
          tolerance: 300,
        },
      },
    },
  ],
  'только бюджет': [
    {
      settings: {
        dayStart: 480,
        dayEnd: 1200,
        lunchStart: 780,
        lunchEnd: 840,
        margin: 10,
        budget: 420,
      },
    },
  ],
  'период целей: правка, удаление, новый': [
    {
      goalPeriod: {
        id: 'g1',
        startDay: '2026-10-15',
        endDay: '2026-10-15',
        kcal: {
          target: 1400,
          tolerance: 100,
        },
        protein: null,
        fat: null,
        carbs: null,
        fiber: null,
        water: {
          target: 2500,
          tolerance: 200,
        },
      },
    },
    {
      goalPeriod: {
        id: 'g2',
        startDay: '2026-11-01',
        endDay: '2026-11-07',
        kcal: null,
        protein: null,
        fat: null,
        carbs: null,
        fiber: null,
        water: null,
      },
    },
  ],
  'удаление периода целей': [
    {
      goalPeriod: {
        id: 'g1',
        deleted: true,
      },
    },
  ],
  'здоровье: правка, удаление, новая запись': [
    {
      health: {
        id: 'h2',
        day: '2026-10-08',
        kind: 'weight',
        time: '',
        endTime: '',
        value: 81.1,
        value2: 0,
        name: '',
        details: '',
      },
    },
    {
      health: {
        id: 'h9',
        day: '2026-10-08',
        kind: 'workout',
        time: '19:00',
        endTime: '',
        value: 30,
        value2: 4.2,
        name: 'бег',
        details: '{"ex":[{"name":"бег","minutes":30}]}',
      },
    },
    {
      health: {
        id: 'h3',
        deleted: true,
      },
    },
  ],
  'цели здоровья': [
    {
      health: {
        id: 'health-goals',
        day: '2000-01-01',
        kind: 'goals',
        value: 0,
        details: '{"steps":10000,"bedtime":"23:00","waterMl":2500}',
      },
    },
  ],
  'словарь: правка типа, длительности, удаление, новое слово': [
    {
      learned: {
        id: 'пара',
        minutes: 120,
        minutesCount: 5,
        touched: 12,
      },
    },
    {
      learned: {
        id: 'созвон',
        kind: 'event',
        kindCount: 1,
        minutes: null,
        minutesCount: 0,
        touched: 13,
      },
    },
    {
      learned: {
        id: 'зал',
        deleted: true,
      },
    },
  ],
  'словарь: только тип': [
    {
      learned: {
        id: 'зал',
        kind: 'task',
        kindCount: 4,
      },
    },
  ],
  'история ввода: правка, удаление, новая строка': [
    {
      quickLine: {
        id: 'q1',
        text: 'Купить кабель',
        count: 3,
        touched: 5,
        hidden: false,
      },
    },
    {
      quickLine: {
        id: 'q9',
        text: 'зал 19:00',
        count: 1,
        touched: 6,
        hidden: false,
      },
    },
    {
      quickLine: {
        id: 'q2',
        deleted: true,
      },
    },
  ],
  'всё сразу': [
    {
      list: {
        id: 'l2',
        order: 5,
      },
    },
    {
      task: {
        id: 't1',
        status: 'done',
      },
    },
    {
      task: {
        id: 't2',
        name: 'Переименовано',
      },
    },
    {
      event: {
        id: 'e3',
        weekdays: null,
        repeat: null,
        color: 2,
      },
    },
    {
      nutritionDay: {
        day: '2026-10-08',
        entries: [],
        isComplete: false,
      },
    },
    {
      settings: {
        dayStart: 480,
        dayEnd: 1200,
        lunchStart: 780,
        lunchEnd: 840,
        margin: 10,
        budget: 500,
      },
    },
    {
      goalPeriod: {
        id: 'g1',
        startDay: '2026-10-15',
        endDay: '2026-10-16',
        kcal: {
          target: 1500,
          tolerance: 100,
        },
        protein: null,
        fat: null,
        carbs: null,
        fiber: null,
        water: null,
      },
    },
    {
      health: {
        id: 'h1',
        day: '2026-10-08',
        kind: 'sleep',
        time: '23:30',
        endTime: '07:00',
        value: 420,
        value2: 0,
        name: '',
        details: '',
      },
    },
    {
      health: {
        id: 'health-goals',
        day: '2000-01-01',
        kind: 'goals',
        value: 0,
        details: '{"steps":8000,"bedtime":"22:30"}',
      },
    },
    {
      learned: {
        id: 'зал',
        touched: 11,
      },
    },
    {
      quickLine: {
        id: 'q2',
        text: 'обед',
        count: 0,
        touched: 2,
        hidden: true,
      },
    },
  ],
};

describe('diffChanges (C4): результат совпадает с прежней реализацией на таблице правок', () => {
  const base = fromEngineState(DIFF_ENGINE);

  DIFF_CASES.forEach(([name, mutate]) => {
    it(name, () => {
      const draft = structuredClone(base);
      mutate(draft);
      expect(diffChanges(base, draft)).toEqual(EXPECTED[name]);
      // Обратная правка — зеркальна по составу записей
      const back = diffChanges(draft, base);
      expect(back.length).toBeGreaterThanOrEqual(name === 'ничего' ? 0 : 1);
    });
  });

  it('эхо движка с переиспользованными объектами даёт пустую разницу', () => {
    const draft = structuredClone(base);
    draft.tasks[0].status = 'done';
    const echo = fromEngineState({
      ...DIFF_ENGINE, tasks: DIFF_ENGINE.tasks.map((t) => (t.id === 't1' ? { ...t, status: 'done' } : t)),
    }, draft);
    expect(echo.tasks[0]).toBe(draft.tasks[0]);
    expect(diffChanges(draft, echo)).toEqual([]);
  });
});
