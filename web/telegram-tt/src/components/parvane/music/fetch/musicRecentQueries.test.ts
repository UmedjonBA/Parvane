import { describe, expect, it } from 'vitest';

import { forgetQuery, getRecentQueries, rememberQuery } from './musicRecentQueries';

describe('«Недавние запросы» «Музыки»', () => {
  it('новые первыми, без повторов по регистру, не больше восьми', () => {
    ['один', 'два', 'Один', '  ', 'три'].forEach(rememberQuery);
    expect(getRecentQueries()).toEqual(['три', 'Один', 'два']);
    for (let i = 0; i < 10; i++) rememberQuery(`q${i}`);
    expect(getRecentQueries()).toHaveLength(8);
    expect(getRecentQueries()[0]).toBe('q9');
    forgetQuery('q9');
    expect(getRecentQueries()[0]).toBe('q8');
  });
});
