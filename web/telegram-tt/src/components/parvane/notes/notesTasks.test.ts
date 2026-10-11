import { describe, expect, it } from 'vitest';

import type { QuickContext } from '../planner/plannerQuick';

import { createEmptyPlannerState } from '../planner/plannerModel';
import {
  applyNoteTasks, applyPlannerToNote, getNoteTasks, noteTaskId, planNoteTasks,
} from './notesTasks';

const CTX: QuickContext = {
  today: '2026-10-08', nowMinutes: 12 * 60, dayStart: 9 * 60, dayEnd: 21 * 60,
};
const NOTE = [
  '# Сервер', '', '- [ ] заказать блок питания до пт', '- [ ] проверить обе GPU', '- [x] созвон завтра 18:00',
  '- [ ] блок питания 1000 Вт',
].join('\n');

function ids() {
  let n = 0;
  return () => `a00${++n}`;
}

describe('заметки: пункты с датой → задачи плана', () => {
  it('метку получает только пункт с датой либо сроком', () => {
    const { text, tasks } = planNoteTasks(NOTE, CTX, ids());
    expect(text.split('\n')).toEqual([
      '# Сервер', '', '- [ ] заказать блок питания до пт ^ta001', '- [ ] проверить обе GPU',
      '- [x] созвон завтра 18:00 ^ta002', '- [ ] блок питания 1000 Вт',
    ]);
    expect(tasks).toEqual([
      {
        marker: 'ta001', name: 'заказать блок питания', isDone: false, due: '2026-10-09',
      },
      {
        marker: 'ta002', name: 'созвон', isDone: true, day: '2026-10-09', start: '18:00', minutes: 30,
      },
    ]);
    // Повторный разбор ничего не меняет
    expect(planNoteTasks(text, CTX, ids()).text).toBe(text);
  });

  it('задачи создаются, правятся и убираются вместе с пунктами', () => {
    const state = createEmptyPlannerState();
    const first = planNoteTasks(NOTE, CTX, ids());
    expect(applyNoteTasks(state, 'n1', first.tasks)).toBe(true);
    expect(getNoteTasks(state, 'n1').map(({ id, status }) => [id, status]))
      .toEqual([[noteTaskId('ta001'), 'queue'], [noteTaskId('ta002'), 'done']]);
    expect(state.tasks[0].source).toEqual({ chat: 'note:n1', opId: 'ta001' });
    expect(applyNoteTasks(state, 'n1', first.tasks)).toBe(false);

    // Пункт отмечен и перенесён, второй пункт удалён из заметки
    const edited = first.text.replace('- [ ] заказать блок питания до пт', '- [x] заказать блок питания до 20.10')
      .replace('- [x] созвон завтра 18:00 ^ta002\n', '');
    const second = planNoteTasks(edited, CTX, ids());
    expect(applyNoteTasks(state, 'n1', second.tasks)).toBe(true);
    expect(getNoteTasks(state, 'n1')).toHaveLength(1);
    expect(state.tasks[0]).toMatchObject({ status: 'done', due: '2026-10-20', name: 'заказать блок питания' });
    // Задачи других заметок и обычные задачи не трогаются
    state.tasks.push({
      id: 'x', name: 'своя', description: '', steps: [], status: 'queue', project: '', rank: 9,
    });
    applyNoteTasks(state, 'n2', []);
    expect(state.tasks).toHaveLength(2);
  });

  it('скопированный пункт получает свою метку и свою задачу', () => {
    const { text } = planNoteTasks(NOTE, CTX, ids());
    const copied = `${text}\n- [ ] заказать блок питания до пт ^ta001`;
    const { tasks } = planNoteTasks(copied, CTX, ids());
    expect(new Set(tasks.map(({ marker }) => marker)).size).toBe(3);
  });
});

describe('заметки: задачи плана → пункты', () => {
  it('галочка следует за задачей; пункт удалённой задачи убирается, новый — нет', () => {
    const state = createEmptyPlannerState();
    const { text, tasks } = planNoteTasks(NOTE, CTX, ids());
    applyNoteTasks(state, 'n1', tasks);
    state.tasks[0].status = 'done';
    const known = new Set(['ta001', 'ta002']);
    const afterDone = applyPlannerToNote(text, getNoteTasks(state, 'n1'), known);
    expect(afterDone).toContain('- [x] заказать блок питания до пт ^ta001');

    state.tasks = state.tasks.filter(({ id }) => id !== noteTaskId('ta002'));
    const afterDelete = applyPlannerToNote(afterDone, getNoteTasks(state, 'n1'), known);
    expect(afterDelete).not.toContain('созвон');
    expect(afterDelete).toContain('проверить обе GPU');
    // Метка, которой задача ещё не выдавалась, удалением не считается
    expect(applyPlannerToNote(text, [], new Set())).toBe(text);
  });
});
