import { describe, expect, it } from 'vitest';

import { parseCoordinates } from './locationInput';

describe('parseCoordinates', () => {
  it('reads latitude and longitude with any separator', () => {
    expect(parseCoordinates('41.3111, 69.2797')).toEqual({ lat: 41.3111, long: 69.2797 });
    expect(parseCoordinates(' -33.9 151.2 ')).toEqual({ lat: -33.9, long: 151.2 });
    expect(parseCoordinates('10;20')).toEqual({ lat: 10, long: 20 });
  });

  it('rejects incomplete and out-of-range input', () => {
    expect(parseCoordinates('41.3111')).toBeUndefined();
    expect(parseCoordinates('91, 10')).toBeUndefined();
    expect(parseCoordinates('10, 181')).toBeUndefined();
    expect(parseCoordinates('north, east')).toBeUndefined();
    expect(parseCoordinates('1, 2, 3')).toBeUndefined();
  });
});
