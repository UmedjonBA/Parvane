import { describe, expect, it } from 'vitest';

import {
  ALL_LAYERS, applyLayers, getEffectiveLayers, getIsLayerLocked, parseLayers, serializeLayers,
} from './plannerLayers';
import { createEmptyPlannerState } from './plannerModel';

describe('планировщик: слои календаря', () => {
  it('без сохранённого значения показаны все слои', () => {
    expect(parseLayers(undefined)).toEqual(ALL_LAYERS);
    expect(parseLayers('')).toEqual(ALL_LAYERS);
  });

  it('выключенные слои переживают запись и чтение', () => {
    const layers = {
      events: true, tasks: false, sleep: false, food: true, sport: true,
    };
    expect(serializeLayers(layers)).toBe('tasks,sleep');
    expect(parseLayers(serializeLayers(layers))).toEqual(layers);
  });

  it('незнакомое название слоя пропускается', () => {
    expect(parseLayers('food,moon,work')).toEqual({ ...ALL_LAYERS, food: false });
  });

  it('слои «Здоровья» заблокированы, когда выключен модуль или блок; события на телефоне видны всегда', () => {
    expect(getIsLayerLocked('sleep', true, ['sleep', 'body'])).toBe(false);
    expect(getIsLayerLocked('food', true, ['sleep', 'body'])).toBe(true);
    expect(getIsLayerLocked('sport', false, ['workouts'])).toBe(true);
    expect(getIsLayerLocked('tasks', false, [])).toBe(false);
    const shown = getEffectiveLayers({ ...ALL_LAYERS, events: false }, true, ['sleep'], true);
    expect(shown).toEqual({
      events: true, tasks: true, sleep: true, food: false, sport: false,
    });
    expect(getEffectiveLayers({ ...ALL_LAYERS, events: false }, true, ['sleep']).events).toBe(false);
  });

  it('выключенные слои и группы убирают записи из видов календаря', () => {
    const state = {
      ...createEmptyPlannerState(),
      tasks: [
        { id: 't1', name: 'Отчёт', day: '2026-11-15', project: 'Работа' },
        { id: 't2', name: 'Без даты', project: '' },
      ],
      events: [
        { id: 'e1', name: 'Зал', start: '18:00', end: '19:30', day: '2026-11-15', project: 'Спорт' },
        { id: 'e2', name: 'Созвон', start: '10:00', end: '11:00', day: '2026-11-15' },
      ],
    } as unknown as ReturnType<typeof createEmptyPlannerState>;
    expect(applyLayers(state, ALL_LAYERS, [])).toBe(state);
    const noTasks = applyLayers(state, { ...ALL_LAYERS, tasks: false }, []);
    expect(noTasks.tasks.map(({ id }) => id)).toEqual(['t2']);
    const noSport = applyLayers(state, ALL_LAYERS, ['Спорт', '']);
    expect(noSport.events.map(({ id }) => id)).toEqual([]);
    expect(noSport.tasks.map(({ id }) => id)).toEqual(['t1']);
  });
});
