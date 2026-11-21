import { describe, expect, it } from 'vitest';

import type { HealthParsedEntry, HealthParseResult } from '../health/healthTypes';

import {
  isHealthChoice, isPlanChoice, listQuickChoices, pickHealthParse,
} from './quickKinds';

const ALL_BLOCKS = ['sleep', 'body', 'food', 'water', 'workouts'] as const;

function result(kinds: string[], unparsed: string[] = []): HealthParseResult {
  const entries = kinds.map((kind): HealthParsedEntry => ({
    kind, atMs: 0, endMs: 0, tzMin: 0, value: 1, value2: 0, unit: '', source: 'text', day: '2026-11-15', time: '10:00',
  }));
  return { entries, unparsed, problems: [] };
}

describe('listQuickChoices', () => {
  it('все модули включены — виды по доске', () => {
    expect(listQuickChoices({ isPlanOn: true, isHealthOn: true, isNotesOn: true }, ALL_BLOCKS)).toEqual([
      'auto', 'event', 'task', 'sleep', 'weight', 'pressure', 'pulse', 'steps', 'mood', 'note',
    ]);
  });

  it('выключенные модули и блоки не предлагаются', () => {
    expect(listQuickChoices({ isPlanOn: true, isHealthOn: true, isNotesOn: false }, ['sleep'])).toEqual([
      'auto', 'event', 'task', 'sleep',
    ]);
    expect(listQuickChoices({ isPlanOn: false, isHealthOn: false, isNotesOn: true }, ALL_BLOCKS)).toEqual([
      'auto', 'note',
    ]);
  });
});

describe('pickHealthParse', () => {
  it('строка как есть подходит — берётся она', () => {
    const plain = result(['weight']);
    expect(pickHealthParse('weight', plain, result(['weight', 'pulse']))).toBe(plain);
  });

  it('без слова вида не понято — берётся разбор со словом', () => {
    const withWord = result(['weight']);
    expect(pickHealthParse('weight', result([], ['72']), withWord)).toBe(withWord);
  });

  it('другой вид, лишние куски — не годится', () => {
    expect(pickHealthParse('pulse', result(['weight']), result(['pulse'], ['завтра']))).toBeUndefined();
  });

  it('отметки «лёг» и «встал» — это сон', () => {
    const plain = result(['sleep_start']);
    expect(pickHealthParse('sleep', plain)).toBe(plain);
  });
});

describe('виды', () => {
  it('различает виды «Плана» и «Здоровья»', () => {
    expect(isHealthChoice('steps')).toBe(true);
    expect(isHealthChoice('note')).toBe(false);
    expect(isPlanChoice('task')).toBe(true);
    expect(isPlanChoice('auto')).toBe(false);
  });
});
