import { describe, expect, it } from 'vitest';

import type { QuickContext } from './plannerQuick';

import { createEmptyPlannerState } from './plannerModel';
import { parseQuickInput } from './plannerQuick';
import { applyQuickDraft } from './plannerQuickApply';

const TODAY = '2026-10-08';
const CTX: QuickContext = {
  today: TODAY, nowMinutes: 12 * 60, dayStart: 9 * 60, dayEnd: 21 * 60,
};

function stateAfter(lines: string[]) {
  const state = createEmptyPlannerState();
  lines.forEach((line) => applyQuickDraft(state, parseQuickInput(line, CTX)));
  return state;
}

describe('ввод текстом: черновик → состояние', () => {
  it('задача и событие', () => {
    const state = stateAfter(['купить кабель', 'созвон завтра 16:00 45 мин', 'урок вт 15:00 каждую неделю']);
    expect(state.tasks.map(({ name }) => name)).toEqual(['купить кабель']);
    expect(state.events[0]).toMatchObject({ name: 'созвон', day: '2026-10-09', start: '16:00', end: '16:45' });
    expect(state.events[1].day).toBeUndefined();
    expect(state.events[1].repeat?.weekdays).toEqual([2]);
  });

  it('описание из строки уходит в событие и в задачу', () => {
    const state = stateAfter([
      'вт 15:00 пара по Английскому будет тест  лисининг', 'задача сдать отчёт до пт — приложить таблицу',
      'созвон завтра 16:00',
    ]);
    expect(state.events[0]).toMatchObject({
      name: 'пара по Английскому', description: 'будет тест лисининг', day: '2026-10-13', start: '15:00', end: '16:45',
    });
    expect(state.tasks[0]).toMatchObject({ name: 'сдать отчёт', description: 'приложить таблицу', due: '2026-10-09' });
    expect(state.events[1].description).toBeUndefined();
  });

  it('метки строки: список, место и «важное»', () => {
    const state = stateAfter([
      'купить молоко #Дом', 'купить хлеб #дом @Ашан ! — бородинский', 'пара вт 15:00 @301ГК — взять тетрадь',
      'созвон завтра 16:00 @Zoom', 'позвонить в банк #мой_банк',
    ]);
    // Список создаётся один раз; второе упоминание находит его без учёта регистра
    expect(state.lists.map(({ name }) => name)).toEqual(['Дом', 'мой банк']);
    expect(state.projects).toEqual(['', 'Дом', 'мой банк']);
    expect(state.tasks[0]).toMatchObject({ name: 'купить молоко', project: 'Дом', status: 'queue', description: '' });
    expect(state.tasks[1]).toMatchObject({
      name: 'купить хлеб', project: 'Дом', status: 'active', description: '@Ашан\nбородинский',
    });
    expect(state.tasks[2]).toMatchObject({ name: 'позвонить в банк', project: 'мой банк' });
    expect(state.events[0]).toMatchObject({ name: 'пара', description: '@301ГК\nвзять тетрадь' });
    expect(state.events[1]).toMatchObject({ name: 'созвон', description: '@Zoom' });
  });

  it('черновик с ошибкой не записывается', () => {
    const state = stateAfter(['', 'событие']);
    expect(state.tasks).toHaveLength(0);
    expect(state.events).toHaveLength(0);
  });
});
