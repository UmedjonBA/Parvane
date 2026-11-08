import { describe, expect, it } from 'vitest';

import { savePrivacySetting } from './privacySave';

// B14 ревью 7 ноя 2026: отказ сервера возвращает прежнее значение, экран откатывает переключатель
describe('privacy toggles roll back on server failure (B14)', () => {
  function makeStore(initial: string) {
    let value = initial;
    return {
      read: () => value,
      write: (next: string) => {
        value = next;
      },
    };
  }

  it('saved: the new value stays', async () => {
    const store = makeStore('anyone');
    expect(await savePrivacySetting({ ...store, next: 'nobody', push: () => Promise.resolve(true) })).toBe(true);
    expect(store.read()).toBe('nobody');
  });

  it('server refused or engine not ready: the previous value is restored', async () => {
    const store = makeStore('anyone');
    expect(await savePrivacySetting({ ...store, next: 'nobody', push: () => Promise.resolve(false) })).toBe(false);
    expect(store.read()).toBe('anyone');
    expect(await savePrivacySetting({
      ...store, next: 'nobody', push: () => Promise.reject(new Error('offline')),
    })).toBe(false);
    expect(store.read()).toBe('anyone');
  });

  it('the value is sent to the server already written (push reads it)', async () => {
    const store = makeStore('anyone');
    let seen = '';
    await savePrivacySetting({
      ...store,
      next: 'nobody',
      push: () => {
        seen = store.read();
        return Promise.resolve(true);
      },
    });
    expect(seen).toBe('nobody');
  });
});
