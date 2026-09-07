import { describe, expect, it } from 'vitest';

import { diagLog, getDiagEntries, summarize } from './parvaneDiag';

describe('parvaneDiag summarize', () => {
  it('never journals a top-level string argument verbatim (passwords)', () => {
    const out = summarize('Parvane-secret-password');
    expect(out).toBe('len=23');
    expect(out).not.toContain('secret');
  });

  it('journals api:* string arguments only as length (provideAuthPassword)', () => {
    diagLog('api:provideAuthPassword', 'Parvane-secret-password');
    const last = getDiagEntries().at(-1);
    expect(last?.k).toBe('api:provideAuthPassword');
    expect(last?.d).toBe('len=23');
    expect(JSON.stringify(getDiagEntries())).not.toContain('secret');
  });

  it('keeps only lengths for non-allowlisted string fields', () => {
    const out = summarize({ user: 'alice@local', password: 'top-secret', chatId: '42' });
    expect(out).toContain('password:len=10');
    expect(out).toContain('user:len=11');
    expect(out).toContain('chatId:"42"');
    expect(out).not.toContain('top-secret');
  });
});
