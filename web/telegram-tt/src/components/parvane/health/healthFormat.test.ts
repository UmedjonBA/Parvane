import { describe, expect, it } from 'vitest';

import type { HealthMetricView } from './healthTypes';

import {
  buildSparkline, dayRelation, formatClock, formatDelta, formatDurationShort, formatValue, orderMetrics, sleepBar,
  splitDuration,
} from './healthFormat';

describe('Оформление значений «Здоровья»', () => {
  it('время и длительность', () => {
    expect(formatClock(10)).toBe('00:10');
    expect(formatClock(1410)).toBe('23:30');
    expect(formatClock(1450)).toBe('00:10');
    expect(splitDuration(415)).toEqual({ hours: 6, minutes: 55 });
    expect(formatDurationShort(445)).toBe('7:25');
  });

  it('значения и изменения', () => {
    expect(formatValue({ kind: 'pressure', value: 120, value2: 80 }, 'ru')).toBe('120/80');
    expect(formatValue({ kind: 'weight', value: 72, value2: 0 }, 'ru')).toBe('72,0');
    expect(formatValue({ kind: 'steps', value: 8400, value2: 0 }, 'en')).toBe('8,400');
    expect(formatDelta(-0.6, 'ru')).toBe('−0,6');
    expect(formatDelta(1.25, 'en')).toBe('+1.3');
    expect(formatDelta(0, 'ru')).toBe('0');
  });

  it('плитки: показатели тела по порядку, остальные по алфавиту', () => {
    const metric = (kind: string) => ({ kind } as HealthMetricView);
    expect(orderMetrics(['water', 'steps', 'glucose', 'weight', 'pressure'].map(metric)).map(({ kind }) => kind))
      .toEqual(['weight', 'pressure', 'steps', 'glucose', 'water']);
  });

  it('график и полоса сна', () => {
    expect(buildSparkline([], 100, 20)).toBe('');
    expect(buildSparkline([1, 3, 2], 102, 22)).toBe('2.0,20.0 51.0,2.0 100.0,11.0');
    expect(buildSparkline([5], 100, 20)).toBe('2.0,18.0');
    // Лёг в 00:10, встал в 07:05 на шкале 20:00–12:00
    const bar = sleepBar(10, 425);
    expect(bar.left).toBeCloseTo(250 / 960);
    expect(bar.width).toBeCloseTo(415 / 960);
    expect(sleepBar(1410, 420).left).toBeCloseTo(210 / 960);
  });

  it('день относительно сегодняшнего', () => {
    expect(dayRelation('2026-11-15', '2026-11-15')).toBe('today');
    expect(dayRelation('2026-11-14', '2026-11-15')).toBe('yesterday');
    expect(dayRelation('2026-10-31', '2026-11-01')).toBe('yesterday');
    expect(dayRelation('2026-11-10', '2026-11-15')).toBe('date');
  });
});
