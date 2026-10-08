/* eslint-disable no-null/no-null -- JSON движка: null = «не задано» */
import { describe, expect, it } from 'vitest';

import type { PlannerState } from './plannerModel';

import { createEmptyPlannerState } from './plannerModel';
import {
  diffChanges, type EngineState, fromEngineState, isLegacyPlannerRecord, legacyToChanges,
} from './plannerSync';

const ENGINE: EngineState = {
  tasks: [{
    id: 't1',
    name: 'Задача',
    description: 'описание',
    steps: [{ text: 'шаг', isDone: true }],
    status: 'active',
    listId: 'l1',
    rank: 2,
    day: '2026-10-08',
    start: '10:00',
    due: '',
    minutes: 90,
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
  }],
  lists: [{ id: 'l1', name: 'Работа', order: 0 }],
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
    }],
    isComplete: true,
    fixedGoals: {
      kcal: { target: 2000, tolerance: 100 }, protein: { target: 120, tolerance: 20 }, fat: null, carbs: null,
    },
    waterMl: 500,
  }],
  settings: { dayStart: 480, dayEnd: 1200, lunchStart: 0, lunchEnd: 0, margin: 10, budget: 480 },
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
  headSeq: 7,
  sizeBytes: 1234,
};

describe('планировщик ↔ движок (spec 010)', () => {
  it('состояние движка превращается в состояние экранов: списки по имени, «не задано», значения на 100 г', () => {
    const state = fromEngineState(ENGINE);
    expect(state.projects).toEqual(['', 'Работа']);
    expect(state.tasks[0]).toMatchObject({
      id: 't1', project: 'Работа', minutes: 90, day: '2026-10-08', due: undefined,
    });
    expect(state.tasks[1]).toMatchObject({ project: '', minutes: undefined, day: undefined });
    // События «по дням недели» этапов 1–2 читаются как еженедельный ряд без нижней границы (R5)
    expect(state.events[0])
      .toMatchObject({ repeat: { kind: 'weekly', interval: 1, weekdays: [1, 2], startDay: '' }, day: undefined });
    expect(state.events[1]).toMatchObject({
      repeat: { kind: 'weekly', weekdays: [1, 3], startDay: '2026-10-12', endDay: undefined, count: undefined },
      occurrences: [{ day: '2026-10-14', excluded: true, done: false, doneSteps: [] }],
      origin: undefined,
    });
    expect(state.goals).toEqual({ kcal: { target: 2100, tolerance: 100 }, water: { target: 2000, tolerance: 300 } });
    expect(state.goalPeriods).toEqual([{
      id: 'g1', startDay: '2026-10-15', endDay: '2026-10-15', goals: { kcal: { target: 1500, tolerance: 100 } },
    }]);
    const day = state.nutrition['2026-10-08'];
    expect(day.entries[0]).toMatchObject({ kcal: 300, protein: 45, fat: undefined, grams: 250 });
    expect(day.entries[0].per100).toEqual({ kcal: 120, protein: 18 });
    expect(day.fixedGoals).toEqual({ kcal: { target: 2000, tolerance: 100 }, protein: { target: 120, tolerance: 20 } });
    expect(day.waterMl).toBe(500);
    expect(state.budget).toBe(480);
    expect(state.settings.dayStart).toBe(480);
  });

  it('разница состояний — только изменённые объекты; удаление — надгробие; список создаётся', () => {
    const before = fromEngineState(ENGINE);
    const after: PlannerState = structuredClone(before);
    after.tasks[0].status = 'done';
    after.tasks = after.tasks.filter((t) => t.id !== 't2');
    after.lists.push({ id: 'l2', name: 'Дом', order: 1 });
    after.projects.push('Дом');
    after.tasks.push({
      id: 't3', name: 'Новая', description: '', steps: [], status: 'queue', project: 'Дом', rank: 1,
    });
    after.nutrition['2026-10-08'].entries = [];
    after.budget = 600;
    const changes = diffChanges(before, after);
    const kinds = changes.map((c) => Object.keys(c)[0]);
    expect(kinds.sort()).toEqual(['list', 'nutritionDay', 'settings', 'task', 'task', 'task']);
    const taskChange = (id: string) => changes.find((c) => (c.task as { id?: string } | undefined)?.id === id);
    expect(taskChange('t1')).toMatchObject({ task: { status: 'done', listId: 'l1', minutes: 90 } });
    expect(taskChange('t2')).toEqual({ task: { id: 't2', deleted: true } });
    expect(taskChange('t3')).toMatchObject({ task: { listId: 'l2', minutes: null, day: '' } });
    const day = changes.find((c) => c.nutritionDay) as { nutritionDay: { entries: unknown[] } };
    expect(day.nutritionDay.entries).toEqual([{ id: 'f1', deleted: true }]);
    expect(changes.find((c) => c.settings)).toEqual({ settings: { ...after.settings, budget: 600 } });
    // Ничего не менялось — изменений нет
    expect(diffChanges(after, structuredClone(after))).toEqual([]);
  });

  it('spec 011: правило повтора и только изменённые дни экземпляров; записи целей — целиком и надгробием', () => {
    const before = fromEngineState(ENGINE);
    const after: PlannerState = structuredClone(before);
    // Отметка ещё одного дня и правка правила ряда
    after.events[1].occurrences!.push({ day: '2026-10-21', excluded: true });
    after.events[1].repeat = { ...after.events[1].repeat!, endDay: '2026-12-31' };
    after.tasks[0].repeat = { kind: 'monthly', interval: 1, monthDay: 20, startDay: '2026-10-01' };
    after.tasks[0].occurrences = [{ day: '2026-10-20', done: true, doneSteps: [0] }];
    after.goalPeriods = [{
      id: 'g2', startDay: '2026-11-01', endDay: '', goals: { water: { target: 2500, tolerance: 200 } },
    }];
    after.goals = { kcal: { target: 2100, tolerance: 100 } };
    const changes = diffChanges(before, after);
    expect(changes.find((c) => (c.event as { id?: string } | undefined)?.id === 'e2')).toMatchObject({
      event: {
        repeat: {
          kind: 'weekly',
          interval: 1,
          weekdays: [1, 3],
          monthDay: 0,
          startDay: '2026-10-12',
          endDay: '2026-12-31',
          count: 0,
        },
        occurrences: [{ day: '2026-10-21', excluded: true, done: false, doneSteps: [] }],
        weekdays: null,
      },
    });
    expect(changes.find((c) => (c.task as { id?: string } | undefined)?.id === 't1')).toMatchObject({
      task: {
        repeat: {
          kind: 'monthly', interval: 1, weekdays: [], monthDay: 20, startDay: '2026-10-01', endDay: '', count: 0,
        },
        occurrences: [{ day: '2026-10-20', excluded: false, done: true, doneSteps: [0] }],
        origin: null,
        source: null,
      },
    });
    const periods = changes.filter((c) => c.goalPeriod);
    expect(periods).toEqual([
      {
        goalPeriod: {
          id: 'g2',
          startDay: '2026-11-01',
          endDay: '',
          kcal: null,
          protein: null,
          fat: null,
          carbs: null,
          fiber: null,
          water: { target: 2500, tolerance: 200 },
        },
      },
      { goalPeriod: { id: 'g1', deleted: true } },
    ]);
    expect(changes.find((c) => c.goals)).toEqual({
      goals: {
        kcal: { target: 2100, tolerance: 100 }, protein: null, fat: null, carbs: null, fiber: null, water: null,
      },
    });
    // Унаследованное событие по дням недели при записи получает правило, а `weekdays` обнуляется
    const legacyEvent = structuredClone(before);
    legacyEvent.events[0].name = 'Стендап-2';
    expect(diffChanges(before, legacyEvent)[0]).toMatchObject({
      event: { id: 'e1', weekdays: null, repeat: { kind: 'weekly', weekdays: [1, 2], startDay: '' } },
    });
  });

  it('перенос этапа 1: числовые id получают префикс устройства, последним — отметка переноса', () => {
    const legacy = createEmptyPlannerState();
    legacy.tasks.push({
      id: '7', name: 'Старая', description: '', steps: [], status: 'queue', project: 'Дом', rank: 0,
    });
    legacy.lists.push({ id: 'list-x', name: 'Дом', order: 0 });
    legacy.projects.push('Дом');
    legacy.events.push({ id: '9', name: 'Событие', start: '10:00', end: '11:00', day: '2026-10-09' });
    const changes = legacyToChanges(legacy, 'web-1');
    expect(changes.map((c) => Object.keys(c)[0])).toEqual(['list', 'task', 'event', 'migration']);
    expect((changes[1].task as { id: string }).id).toBe('legacy-web-1-7');
    expect((changes[2].event as { id: string }).id).toBe('legacy-web-1-9');
    expect(changes[3]).toEqual({ migration: { sourceDevice: 'web-1', count: 3 } });
    expect(isLegacyPlannerRecord(legacy)).toBe(true);
    expect(isLegacyPlannerRecord({ migrated: true, at: 1 })).toBe(false);
  });
});
