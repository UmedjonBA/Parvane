import {
  afterEach, beforeEach, describe, expect, it, vi,
} from 'vitest';

import type { PlannerReminder } from '../../components/parvane/planner/plannerReminders';

import { createReminderScheduler } from './reminders';

// Общие данные «Плана» двух устройств: отметки «напомнено» сходятся через синк
const shared = { reminded: new Set<string>(), due: [] as PlannerReminder[], upcoming: [] as PlannerReminder[] };

vi.mock('../../components/parvane/planner/plannerReminders', () => ({
  readReminders: () => ({
    upcoming: shared.upcoming,
    due: shared.due.filter(({ key }) => !shared.reminded.has(key)),
  }),
}));

function reminder(patch: Partial<PlannerReminder>): PlannerReminder {
  return {
    key: 't1@2026-10-20@15', at: Date.now(), startsAt: Date.now(), title: 'Отчёт', kind: 'task', day: '2026-10-20',
    ...patch,
  };
}

function device() {
  const sent: string[] = [];
  const rung: string[] = [];
  const alarms: number[][] = [];
  const saved: unknown[] = [];
  const scheduler = createReminderScheduler({
    stateJson: () => '{}',
    isReady: () => true,
    apply: (changes) => {
      (changes as { reminded: { id: string } }[]).forEach(({ reminded }) => shared.reminded.add(reminded.id));
    },
    flush: () => Promise.resolve(),
    syncNow: () => Promise.resolve(),
    sendToSelf: (text) => {
      sent.push(text);
      return Promise.resolve(true);
    },
    ring: ({ key }) => rung.push(key),
    setAlarms: (atMs) => {
      alarms.push(atMs);
      return Promise.resolve(true);
    },
    saveForWorker: (items) => {
      saved.push(items);
      return Promise.resolve();
    },
    markShown: () => Promise.resolve(),
    canKeepText: () => Promise.resolve(true),
    formatMessage: ({ title }) => `⏰ ${title}`,
    log: () => undefined,
  });
  return {
    scheduler, sent, rung, alarms, saved,
  };
}

describe('планировщик напоминаний', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    shared.reminded.clear();
    shared.due = [];
    shared.upcoming = [];
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('ближайшие уходят серверу и service worker один раз, пока не изменились', async () => {
    shared.upcoming = [
      reminder({ at: Date.now() + 60_000 }),
      reminder({ key: 'e1@2026-10-20@0', at: Date.now() + 60_000 }),
    ];
    const a = device();
    a.scheduler.start();
    await vi.advanceTimersByTimeAsync(2000);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(a.alarms).toEqual([[Date.now() - 32_000 + 60_000]]);
    expect(a.saved).toHaveLength(1);
    a.scheduler.stop();
  });

  it('два устройства звонят оба, а в «Избранное» пишет одно', async () => {
    shared.due = [reminder({})];
    const a = device();
    const b = device();
    const random = vi.spyOn(Math, 'random');
    random.mockReturnValueOnce(0).mockReturnValueOnce(0.9);
    a.scheduler.start();
    b.scheduler.start();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(a.rung).toEqual(['t1@2026-10-20@15']);
    expect(b.rung).toEqual(['t1@2026-10-20@15']);
    expect(a.sent.length + b.sent.length).toBe(1);
    expect(shared.reminded.has('t1@2026-10-20@15')).toBe(true);
    a.scheduler.stop();
    b.scheduler.stop();
  });

  it('пропущенное без приложения не звенит, но дописывается в «Избранное»', async () => {
    shared.due = [reminder({ at: Date.now() - 3 * 60 * 60 * 1000 })];
    const a = device();
    a.scheduler.start();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(a.rung).toEqual([]);
    expect(a.sent).toEqual(['⏰ Отчёт']);
    a.scheduler.stop();
  });
});
