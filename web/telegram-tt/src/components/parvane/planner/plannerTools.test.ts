import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  beforeAll, describe, expect, it,
} from 'vitest';

import { engineStatic, loadProtocol } from '../../../api/parvane/v2/engine';
import { createEmptyPlannerState } from './plannerModel';
import { findFreeTime, parseScheduleText } from './plannerTools';

type Case = { name: string; call: string; args: unknown; expect: unknown };

const SAMPLE = JSON.parse(
  readFileSync(resolve(__dirname, '../../../../../../conformance/planner-tools/cases.json'), 'utf8'),
) as { cases: Case[] };

describe('Подсказки «Плана» (PLANNER-2)', () => {
  beforeAll(async () => {
    await loadProtocol();
  });

  it('движок web отвечает по общему образцу', () => {
    expect(SAMPLE.cases.length).toBeGreaterThanOrEqual(8);
    SAMPLE.cases.forEach((item) => {
      expect(engineStatic(item.call, item.args), item.name).toEqual(item.expect);
    });
  });

  it('вход собирается из состояния «Плана»', () => {
    const state = {
      ...createEmptyPlannerState(),
      events: [{
        id: 'e1', name: 'Созвон', start: '09:00', end: '12:00', day: '2026-11-16', occurrences: [],
      }],
    };
    const result = findFreeTime({
      state, minutes: 60, fromDay: '2026-11-16', days: 1, part: 'any', limit: 3, today: '2026-11-16', nowMinute: 0,
    });
    expect(result.slots[0].start).toBe(12 * 60 + state.settings.margin);
    expect(parseScheduleText('пн 10-11 созвон', '2026-11-16').items[0].description).toBeUndefined();
  });
});
