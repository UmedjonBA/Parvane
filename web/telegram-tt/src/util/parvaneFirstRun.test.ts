import { describe, expect, it } from 'vitest';

import { describeFirstRunCount } from './parvaneFirstRun';

describe('parvaneFirstRun', () => {
  it('до пяти модулей лента помещается без прокрутки', () => {
    expect(describeFirstRunCount(4, 7)).toEqual({ selected: 4, total: 7, doesFit: true });
    expect(describeFirstRunCount(5, 7).doesFit).toBe(true);
    expect(describeFirstRunCount(6, 7).doesFit).toBe(false);
  });
});
