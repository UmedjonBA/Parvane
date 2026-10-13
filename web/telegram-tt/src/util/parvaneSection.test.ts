import { describe, expect, it } from 'vitest';

import {
  getPlannerCalendarView, getPlannerPickedDay, setPlannerCalendarView, setPlannerPickedDay,
} from './parvaneSection';

describe('выбранный день и вид календаря «Плана» переживают размонтирование раздела (E1)', () => {
  it('до выбора значений нет — раздел берёт «сегодня» и сохранённый вид', () => {
    expect(getPlannerPickedDay()).toBeUndefined();
    expect(getPlannerCalendarView()).toBeUndefined();
  });

  it('выбранное читается тем же', () => {
    setPlannerPickedDay('2026-10-20');
    setPlannerCalendarView('week');
    expect(getPlannerPickedDay()).toBe('2026-10-20');
    expect(getPlannerCalendarView()).toBe('week');
  });
});
