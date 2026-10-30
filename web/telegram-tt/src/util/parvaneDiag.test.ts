import {
  afterEach, beforeEach, describe, expect, it, vi,
} from 'vitest';

import {
  diagLog, flushDiag, getDiagEntries, scrubErrorText, summarize,
} from './parvaneDiag';

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

describe('parvaneDiag persistence (perf A12)', () => {
  const setItem = vi.fn();
  beforeEach(() => {
    vi.useFakeTimers();
    // Среда теста без localStorage — подменяем хранилище целиком
    vi.stubGlobal('localStorage', { getItem: () => undefined, setItem, removeItem: () => undefined });
    // Отложенная запись прежних тестов (реальный таймер) — дописать и забыть
    flushDiag();
    setItem.mockClear();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('does not touch localStorage synchronously and coalesces a burst into one deferred write', () => {
    for (let i = 0; i < 50; i++) diagLog('act:test', { chatId: String(i) });
    expect(setItem).not.toHaveBeenCalled();
    vi.advanceTimersByTime(4999);
    expect(setItem).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    // без requestIdleCallback — запись сразу по таймеру
    expect(setItem).toHaveBeenCalledTimes(1);
    // Нечего дописывать — повторной записи нет
    flushDiag();
    expect(setItem).toHaveBeenCalledTimes(1);
  });
});

describe('parvaneDiag secrets in urls and errors', () => {
  it('cuts the fragment of a url field (cloud link key lives after #)', () => {
    const out = summarize({ url: 'https://srv.example/s/abc#k=SECRETKEYSECRETKEY' });
    expect(out).not.toContain('SECRET');
  });

  it('scrubs url queries, emails and long tokens from error text', () => {
    const out = scrubErrorText(
      'fail https://srv.example/s/a?x=1#k=SECRETSECRET to bob@mail.example tok AAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    );
    expect(out).not.toContain('SECRET');
    expect(out).not.toContain('bob@');
    expect(out).not.toContain('AAAAAAAAAAAA');
  });
});
