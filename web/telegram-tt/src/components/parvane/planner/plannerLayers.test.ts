import { describe, expect, it } from 'vitest';

import { ALL_LAYERS, parseLayers, serializeLayers } from './plannerLayers';

describe('планировщик: слои календаря', () => {
  it('без сохранённого значения показаны все слои', () => {
    expect(parseLayers(undefined)).toEqual(ALL_LAYERS);
    expect(parseLayers('')).toEqual(ALL_LAYERS);
  });

  it('выключенные слои переживают запись и чтение', () => {
    const layers = { sleep: false, food: true, work: false };
    expect(serializeLayers(layers)).toBe('sleep,work');
    expect(parseLayers(serializeLayers(layers))).toEqual(layers);
  });

  it('незнакомое название слоя пропускается', () => {
    expect(parseLayers('food,moon')).toEqual({ sleep: true, food: false, work: true });
  });
});
