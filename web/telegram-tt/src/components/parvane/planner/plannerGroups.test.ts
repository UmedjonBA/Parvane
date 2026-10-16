import { describe, expect, it } from 'vitest';

import type { PlannerEvent, PlannerState } from './plannerModel';

import {
  assignToGroup, createGroup, deleteGroup, renameGroup, setGroupColor,
} from './plannerGroups';
import { applyQuickDraft } from './plannerHealth';
import { createEmptyPlannerState, getEventColor } from './plannerModel';

const weekly = (id: string, name: string): PlannerEvent => ({
  id,
  name,
  start: '10:00',
  end: '11:00',
  repeat: {
    kind: 'weekly', interval: 1, weekdays: [1], startDay: '2026-10-12',
  },
  occurrences: [],
});

function makeState() {
  const state: PlannerState = createEmptyPlannerState();
  state.events.push(weekly('lesson', 'Лекция'), {
    id: 'once', name: 'Встреча', start: '12:00', end: '13:00', day: '2026-10-20', color: 3,
  });
  state.tasks.push({
    id: 't1', name: 'Задание', status: 'queue', project: '', rank: 0, steps: [], description: '',
  });
  return state;
}

describe('группы «Плана»', () => {
  it('создание: имя обязательно и не повторяется, цвет сохраняется', () => {
    const state = makeState();
    expect(createGroup(state, '  ', 2)).toBe('name');
    expect(createGroup(state, 'Учёба', 4)).toBeUndefined();
    expect(createGroup(state, 'Учёба', 1)).toBe('duplicate');
    expect(state.lists.find((l) => l.name === 'Учёба')?.color).toBe(4);
    expect(state.projects).toContain('Учёба');
  });

  it('ряд целиком с повторами: событие красится цветом группы', () => {
    const state = makeState();
    createGroup(state, 'Учёба', 5);
    assignToGroup(state, [
      { kind: 'event', id: 'lesson', day: '2026-10-19', isRepeat: true },
      { kind: 'event', id: 'lesson', day: '2026-10-26', isRepeat: true },
      { kind: 'event', id: 'once', isRepeat: false },
      { kind: 'task', id: 't1', isRepeat: false },
    ], 'Учёба', true);
    const lesson = state.events.find((e) => e.id === 'lesson')!;
    expect(lesson.project).toBe('Учёба');
    expect(state.events).toHaveLength(2);
    expect(getEventColor(state, lesson)).toBe(5);
    expect(getEventColor(state, state.events.find((e) => e.id === 'once')!)).toBe(5);
    expect(state.tasks[0].project).toBe('Учёба');
  });

  it('без повторов: отделяется только отмеченный день', () => {
    const state = makeState();
    createGroup(state, 'Работа', 2);
    assignToGroup(state, [{ kind: 'event', id: 'lesson', day: '2026-10-19', isRepeat: true }], 'Работа', false);
    const lesson = state.events.find((e) => e.id === 'lesson')!;
    expect(lesson.project).toBeUndefined();
    expect(lesson.occurrences).toEqual([{ day: '2026-10-19', excluded: true }]);
    const detached = state.events.find((e) => e.origin?.seriesId === 'lesson')!;
    expect(detached).toMatchObject({ day: '2026-10-19', project: 'Работа' });
  });

  it('переименование и удаление проходят по всем записям; цвет меняется у группы', () => {
    const state = makeState();
    createGroup(state, 'Учёба', 5);
    assignToGroup(state, [
      { kind: 'event', id: 'lesson', isRepeat: true }, { kind: 'task', id: 't1', isRepeat: false },
    ], 'Учёба', true);
    expect(renameGroup(state, 'Учёба', 'Университет')).toBeUndefined();
    expect(state.events.find((e) => e.id === 'lesson')!.project).toBe('Университет');
    expect(state.tasks[0].project).toBe('Университет');
    expect(state.projects).not.toContain('Учёба');
    setGroupColor(state, 'Университет', 7);
    expect(getEventColor(state, state.events.find((e) => e.id === 'lesson')!)).toBe(7);
    createGroup(state, 'Работа', 1);
    expect(renameGroup(state, 'Университет', 'Работа')).toBe('duplicate');
    deleteGroup(state, 'Университет');
    expect(state.lists.map((l) => l.name)).toEqual(['Работа']);
    expect(state.events.find((e) => e.id === 'lesson')!.project).toBeUndefined();
    expect(state.tasks[0].project).toBe('');
    // Без группы событие снова своего цвета
    expect(getEventColor(state, state.events.find((e) => e.id === 'once')!)).toBe(3);
  });
});

describe('группа из ввода текстом', () => {
  it('событие с меткой #группа попадает в существующую группу без учёта регистра, новая — создаётся', () => {
    const state = makeState();
    createGroup(state, 'Учёба', 5);
    applyQuickDraft(state, {
      kind: 'event', name: 'пара', start: '10:00', end: '11:30', day: '2026-10-19', list: 'учёба',
    } as QuickDraft, '2026-10-16');
    const added = state.events[state.events.length - 1];
    expect(added.project).toBe('Учёба');
    expect(getEventColor(state, added)).toBe(5);
    applyQuickDraft(state, {
      kind: 'event', name: 'зал', start: '19:00', end: '20:00', day: '2026-10-19', list: 'Спорт',
    } as QuickDraft, '2026-10-16');
    expect(state.events[state.events.length - 1].project).toBe('Спорт');
    expect(state.lists.map((l) => l.name)).toContain('Спорт');
  });
});
