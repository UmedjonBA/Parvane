import { describe, expect, it } from 'vitest';

import type { HealthMetricView } from './healthTypes';

import {
  buildSleepSpan, buildSparkline, dayRelation, formatClock, formatDelta, formatDurationShort, formatValue,
  fromLocalParts, orderMetrics, parseNumber, sleepAxis, sleepAxisLabels, sleepBar, splitDuration, toLocalParts,
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
    // Лёг в 00:10, встал в 07:05 на шкале досок 22:00–08:00
    const bar = sleepBar(10, 425);
    expect(bar.left).toBeCloseTo(130 / 600);
    expect(bar.width).toBeCloseTo(415 / 600);
    expect(sleepBar(1410, 420).left).toBeCloseTo(90 / 600);
  });

  it('шкала режима расширяется под ночи и подписана через два часа', () => {
    expect(sleepAxis([{ bedMin: 1410, wakeMin: 420 }])).toEqual({ start: 1320, span: 600 });
    expect(sleepAxisLabels(sleepAxis([]))).toEqual(['22', '00', '02', '04', '06', '08']);
    // Лёг в 21:10, встал в 08:50: шкала 20:00–10:00
    const wide = sleepAxis([{ bedMin: 1270, wakeMin: 530 }, {}]);
    expect(wide).toEqual({ start: 1200, span: 840 });
    expect(sleepAxisLabels(wide)[0]).toBe('20');
  });

  it('день относительно сегодняшнего', () => {
    expect(dayRelation('2026-11-15', '2026-11-15')).toBe('today');
    expect(dayRelation('2026-11-14', '2026-11-15')).toBe('yesterday');
    expect(dayRelation('2026-10-31', '2026-11-01')).toBe('yesterday');
    expect(dayRelation('2026-11-10', '2026-11-15')).toBe('date');
  });

  it('поля формы: день и время в поясе записи', () => {
    // 2026-11-15 07:20 в UTC+3
    const ms = Date.UTC(2026, 10, 15, 4, 20);
    expect(toLocalParts(ms, 180)).toEqual({ day: '2026-11-15', time: '07:20' });
    expect(toLocalParts(Date.UTC(2026, 10, 14, 22, 30), 180)).toEqual({ day: '2026-11-15', time: '01:30' });
    expect(fromLocalParts('2026-11-15', '07:20', 180)).toBe(ms);
    expect(fromLocalParts('', '07:20', 180)).toBeUndefined();
    expect(parseNumber('72,5')).toBe(72.5);
    expect(parseNumber(' 64 ')).toBe(64);
    expect(parseNumber('')).toBeUndefined();
    expect(parseNumber('семь')).toBeUndefined();
  });

  it('отрезок сна считается от дня пробуждения', () => {
    const night = buildSleepSpan('2026-11-15', '23:30', '07:00', 180)!;
    expect(toLocalParts(night.atMs, 180)).toEqual({ day: '2026-11-14', time: '23:30' });
    expect(night.minutes).toBe(450);
    const nap = buildSleepSpan('2026-11-14', '14:00', '15:10', 180)!;
    expect(toLocalParts(nap.atMs, 180).day).toBe('2026-11-14');
    expect(nap.minutes).toBe(70);
    expect(buildSleepSpan('2026-11-14', '', '15:10', 180)).toBeUndefined();
  });
});
