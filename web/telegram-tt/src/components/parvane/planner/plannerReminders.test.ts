import { describe, expect, it } from 'vitest';

import type { PlannerEvent, PlannerTask } from './plannerModel';

import { createEmptyPlannerState } from './plannerModel';
import { getDueReminders, getReminders, reminderKey } from './plannerReminders';

const at = (day: string, time: string) => new Date(`${day}T${time}:00`).getTime();

function task(patch: Partial<PlannerTask>): PlannerTask {
  return {
    id: 't1', name: 'Отчёт', description: '', steps: [], status: 'queue', project: '', rank: 0, ...patch,
  };
}

function event(patch: Partial<PlannerEvent>): PlannerEvent {
  return {
    id: 'e1', name: 'Созвон', start: '16:00', end: '16:30', ...patch,
  };
}

describe('напоминания «Плана»', () => {
  it('момент — начало минус «за сколько»; без времени — начало дня; выполненное не напоминает', () => {
    const state = {
      ...createEmptyPlannerState(),
      tasks: [
        task({ day: '2026-10-20', start: '10:00', remind: 15 }),
        task({ id: 't2', name: 'Без времени', day: '2026-10-20', remind: 0 }),
        task({ id: 't3', name: 'Сделано', day: '2026-10-20', start: '11:00', remind: 5, status: 'done' }),
        task({ id: 't4', name: 'Без напоминания', day: '2026-10-20', start: '12:00' }),
      ],
      events: [event({ day: '2026-10-21', remind: 60 * 24 })],
    };
    const list = getReminders(state, at('2026-10-20', '00:00'), at('2026-10-20', '23:59'));
    expect(list.map(({ key, at: moment }) => [key, new Date(moment).toTimeString().slice(0, 5)])).toEqual([
      [reminderKey('t2', '2026-10-20', 0), '09:00'],
      [reminderKey('t1', '2026-10-20', 15), '09:45'],
      [reminderKey('e1', '2026-10-21', 1440), '16:00'],
    ]);
  });

  it('у ряда — каждый экземпляр своим ключом; отмеченные уже не сработают повторно', () => {
    const state = {
      ...createEmptyPlannerState(),
      events: [event({ repeat: { kind: 'daily', interval: 1, startDay: '2026-10-20' }, remind: 10 })],
      reminded: [reminderKey('e1', '2026-10-20', 10)],
    };
    const due = getDueReminders(state, at('2026-10-21', '16:00'), at('2026-10-19', '00:00'));
    expect(due.map(({ key }) => key)).toEqual([reminderKey('e1', '2026-10-21', 10)]);
  });
});
