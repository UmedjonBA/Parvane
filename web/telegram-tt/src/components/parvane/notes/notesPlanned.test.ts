import { describe, expect, it } from 'vitest';

import type { QuickContext } from '../planner/plannerQuick';

import { applyQuickDraft } from '../planner/plannerHealth';
import { createEmptyPlannerState } from '../planner/plannerModel';
import { parseQuickInput } from '../planner/plannerQuick';
import {
  buildPlannedIndex, nearestPlanned, notePlanLine, plannedOf,
} from './notesPlanned';

// 8 октября 2026 — четверг, полдень
const TODAY = '2026-10-08';
const CTX: QuickContext = {
  today: TODAY, nowMinutes: 12 * 60, dayStart: 9 * 60, dayEnd: 21 * 60,
};

// Запись, которую добавит окно ввода текстом из строки «Запланировать» с дописанным пользователем хвостом
function plan(title: string, tail: string) {
  const state = createEmptyPlannerState();
  const draft = parseQuickInput(`${notePlanLine(title)}${tail}`, CTX);
  expect(draft.error).toBeUndefined();
  applyQuickDraft(state, draft, TODAY);
  return state;
}

describe('заметки: «Запланировать» → «Запланировано»', () => {
  it('заготовка — ссылка на заметку и пробел для продолжения', () => {
    expect(notePlanLine('Сервер X99')).toBe('[[Сервер X99]] ');
    expect(notePlanLine('  Сервер  ')).toBe('[[Сервер]] ');
  });

  it('событие из заготовки стоит в «Запланировано» своей заметки', () => {
    const state = plan('Сервер X99', 'созвон завтра 16:00');
    expect(state.events).toMatchObject([{ name: '[[Сервер X99]] созвон', day: '2026-10-09', start: '16:00' }]);
    const index = buildPlannedIndex(state, TODAY);
    const planned = plannedOf(index, { id: 'n1', title: 'Сервер X99' });
    expect(planned).toMatchObject([{ kind: 'event', name: 'созвон', day: '2026-10-09', time: '16:00' }]);
    expect(nearestPlanned(planned, TODAY)).toBe(planned[0]);
    expect(plannedOf(index, { id: 'n2', title: 'Другая' })).toEqual([]);
  });

  it('слова названия заметки датой и временем записи не становятся', () => {
    const state = plan('Встреча завтра в 9', 'сб 15:00');
    expect(state.events).toMatchObject([{ name: '[[Встреча завтра в 9]]', day: '2026-10-10', start: '15:00' }]);
    const planned = plannedOf(buildPlannedIndex(state, TODAY), { id: 'n1', title: 'встреча завтра в 9' });
    // Название записи из одной ссылки показывается названием заметки
    expect(planned).toMatchObject([{ kind: 'event', name: 'Встреча завтра в 9', day: '2026-10-10' }]);
  });

  it('заготовка без продолжения — задача без даты со ссылкой', () => {
    const state = plan('Parvane', '');
    expect(state.tasks).toMatchObject([{ name: '[[Parvane]]', day: undefined }]);
    const planned = plannedOf(buildPlannedIndex(state, TODAY), { id: 'n1', title: 'Parvane' });
    expect(planned).toMatchObject([{ kind: 'task', name: 'Parvane', day: undefined }]);
  });
});
