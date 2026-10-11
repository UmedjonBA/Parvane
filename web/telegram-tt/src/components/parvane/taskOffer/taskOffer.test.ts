import { describe, expect, it } from 'vitest';

import type { LangFn } from '../../../util/localization';

import { getParvaneSection, getPlannerView, setParvaneSection } from '../../../util/parvaneSection';
import { formatOfferWhen } from './taskOfferFormat';
import { consumePlannerDayRequest, getPlannerDayRequest, openOfferInPlan } from './taskOfferOpen';

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
