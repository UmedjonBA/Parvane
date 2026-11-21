import { describe, expect, it } from 'vitest';

import {
  getEndByDuration, getOnlyNewTime, getSpanMinutes, parseDuration,
} from './plannerEditorFormat';

describe('планировщик: значения карточки записи', () => {
  it('длительность понимается числом минут, часами и минутами, «ч:мм»', () => {
    expect(parseDuration('')).toBeUndefined();
    expect(parseDuration(' 90 ')).toBe(90);
    expect(parseDuration('1:30')).toBe(90);
    expect(parseDuration('1 ч 30 мин')).toBe(90);
    expect(parseDuration('1,5 ч')).toBe(90);
    expect(parseDuration('45 мин')).toBe(45);
    expect(parseDuration('2h 15m')).toBe(135);
    expect(parseDuration('2 часа')).toBe(120);
    expect(parseDuration('полчаса')).toBeNaN();
    expect(parseDuration('1 ч и ещё')).toBeNaN();
  });

  it('конец события считается от начала и длительности, за полночь — нет', () => {
    expect(getEndByDuration('18:00', 90)).toBe('19:30');
    expect(getEndByDuration('23:00', 60)).toBeUndefined();
    expect(getEndByDuration('10:00', 0)).toBeUndefined();
    expect(getSpanMinutes('18:00', '19:30')).toBe(90);
    expect(getSpanMinutes('18:00', '17:00')).toBeUndefined();
  });

  it('новое время называется, только когда правка меняет одно время', () => {
    const before = { start: '18:00', end: '19:30', name: 'Зал' };
    expect(getOnlyNewTime({ ...before, start: '19:00', end: '20:30' }, before)).toBe('19:00');
    expect(getOnlyNewTime({ ...before, start: '19:00', name: 'Бассейн' }, before)).toBeUndefined();
    expect(getOnlyNewTime({ name: 'Бассейн' }, before)).toBeUndefined();
    expect(getOnlyNewTime({ start: '18:00' }, before)).toBeUndefined();
  });
});
