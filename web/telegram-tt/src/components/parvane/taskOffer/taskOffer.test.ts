import { describe, expect, it } from 'vitest';

import type { LangFn } from '../../../util/localization';
import type { PlannerState } from '../planner/plannerModel';

import { getParvaneSection, getPlannerView, setParvaneSection } from '../../../util/parvaneSection';
import { findOfferInPlan } from '../../../api/parvane/taskOffers';
import { createEmptyPlannerState } from '../planner/plannerModel';
import { formatOfferWhen } from './taskOfferFormat';
import { consumePlannerDayRequest, getPlannerDayRequest, openOfferInPlan } from './taskOfferOpen';
import { offerInPlanKey, parseOfferInPlanKey } from './taskOfferPlan';

const lang = Object.assign(
  (key: string, params?: Record<string, unknown>) => (params ? `${key}(${Object.values(params).join(',')})` : key),
  { code: 'en' },
) as unknown as LangFn;

describe('карточка «Задание» / «Событие» в чате', () => {
  it('строка под названием: день, начало, длительность, срок', () => {
    const today = '2026-10-12';
    expect(formatOfferWhen(lang, { day: '2026-10-12', start: '10:00', minutes: 45 }, today))
      .toBe('WeekdayToday, Mon, Oct 12 · 10:00 · PlannerMinutesValue(45)');
    expect(formatOfferWhen(lang, { day: '2026-10-20', minutes: 90, due: '2026-10-21' }, today))
      .toBe('Tue, Oct 20 · PlannerHoursValue(1) PlannerMinutesValue(30) · PlannerDueValue(Wed, Oct 21)');
    // Время без дня не показывается: такую карточку в план ставят без времени
    expect(formatOfferWhen(lang, { start: '10:00' }, today)).toBe('');
    expect(formatOfferWhen(lang, {}, today)).toBe('');
  });

  it('«открыть»: задание — «Сегодня», событие — «Календарь», день лежит запросом до его разбора', () => {
    setParvaneSection('messenger');
    openOfferInPlan('event', '2026-10-20');
    expect(getParvaneSection()).toBe('planner');
    expect(getPlannerView()).toBe('calendar');
    expect(getPlannerDayRequest()).toBe('2026-10-20');
    consumePlannerDayRequest();
    expect(getPlannerDayRequest()).toBeUndefined();

    setParvaneSection('messenger');
    openOfferInPlan('task');
    expect(getParvaneSection()).toBe('planner');
    expect(getPlannerView()).toBe('today');
    expect(getPlannerDayRequest()).toBeUndefined();
  });
});

describe('запись плана по карточке — ключом по индексу состояния (C6)', () => {
  const UUID = '0190c5b0-1234-7abc-8def-0123456789ab';
  const OP_ID = UUID.replace(/-/g, '');
  const task = (id: string, opId?: string, day?: string): PlannerState['tasks'][number] => ({
    id, name: id, description: '', steps: [], status: 'queue', project: '', rank: 0, day,
    source: opId ? { chat: 'c1', opId } : undefined,
  });
  const event = (id: string, day?: string): PlannerState['events'][number] => ({
    id, name: id, start: '10:00', end: '11:00', day,
  });
  const states: [string, PlannerState][] = [
    ['пусто', createEmptyPlannerState()],
    ['задача по opId с днём', { ...createEmptyPlannerState(), tasks: [task('t0'), task('t1', OP_ID, '2026-10-20')] }],
    ['задача без дня', { ...createEmptyPlannerState(), tasks: [task('t1', OP_ID)] }],
    ['две задачи по одному opId — первая', {
      ...createEmptyPlannerState(), tasks: [task('a', OP_ID, '2026-10-01'), task('b', OP_ID, '2026-10-02')],
    }],
    ['событие с id карточки', { ...createEmptyPlannerState(), events: [event('e0'), event(UUID, '2026-10-21')] }],
    ['задача старше события', {
      ...createEmptyPlannerState(), tasks: [task('t1', OP_ID, '2026-10-20')], events: [event(UUID, '2026-10-21')],
    }],
    ['чужая запись', { ...createEmptyPlannerState(), tasks: [task('t1', 'ffff')], events: [event('other')] }],
  ];

  it('совпадает с findOfferInPlan на таблице состояний', () => {
    states.forEach(([, state]) => {
      expect(parseOfferInPlanKey(offerInPlanKey(state, UUID))).toEqual(findOfferInPlan(state, UUID));
    });
    expect(offerInPlanKey(undefined, UUID)).toBeUndefined();
  });

  it('ключ — одна и та же строка для одной записи в разных объектах состояния', () => {
    const [, a] = states[1];
    const b = { ...a, tasks: a.tasks.map((t) => ({ ...t })) };
    expect(offerInPlanKey(a, UUID)).toBe(offerInPlanKey(b, UUID));
    expect(offerInPlanKey(a, UUID)).toBe(offerInPlanKey(a, UUID));
  });
});
