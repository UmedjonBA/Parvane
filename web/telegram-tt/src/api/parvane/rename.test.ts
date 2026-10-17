// Смена ника (spec 026) на устройстве: хранилище под новым адресом, прежний адрес ведёт в прежний чат.
import { describe, expect, it } from 'vitest';

import {
  loadSecureSession, lockStorage, migrateStorageUser, saveSecureSession, SecureE2eStorage, setStoragePin,
  unlockStorageWithPin,
} from './secureStorage';
import { ParvaneStore } from './store';

describe('смена ника', () => {
  it('хранилище переходит к новому адресу: записи, двоичные записи, состояние и сессия', async () => {
    const [from, to] = ['rename-old@local', 'rename-new@local'];
    const old = await SecureE2eStorage.open(from);
    await old.save({ state: 1 });
    await old.saveRecord('m:1', { text: 'история' });
    await old.saveBytesRecord('v2-engine-bin', new Uint8Array([1, 2, 3]));
    await saveSecureSession(from, 'token-old');
    await migrateStorageUser(from, to);
    const moved = await SecureE2eStorage.open(to);
    expect(await moved.load()).toEqual({ state: 1 });
    expect(await moved.loadRecord('m:1')).toEqual({ text: 'история' });
    expect(Array.from(await moved.loadBytesRecord('v2-engine-bin') || [])).toEqual([1, 2, 3]);
    expect(await loadSecureSession(to)).toBe('token-old');
    // Прежний адрес пуст
    const empty = await SecureE2eStorage.open(from);
    expect(await empty.load()).toBeUndefined();
    expect(await empty.loadRecord('m:1')).toBeUndefined();
    await SecureE2eStorage.clear(to);
    await SecureE2eStorage.clear(from);
  });

  it('PIN хранилища переходит вместе с ним', async () => {
    const [from, to] = ['rename-pin-old@local', 'rename-pin-new@local'];
    const old = await SecureE2eStorage.open(from);
    await old.saveRecord('x', 7);
    await setStoragePin(from, '12345678');
    await migrateStorageUser(from, to);
    lockStorage(to);
    expect(await unlockStorageWithPin(to, '00000000')).toBe(false);
    expect(await unlockStorageWithPin(to, '12345678')).toBe(true);
    expect(await (await SecureE2eStorage.open(to)).loadRecord('x')).toBe(7);
    await SecureE2eStorage.clear(to);
  });

  it('прежний адрес собеседника — тот же чат, сообщения прежнего адреса — от него', () => {
    const store = new ParvaneStore();
    store.self = 'me@local';
    const chat = store.getIdForAddress('ann@local');
    expect(store.registerUserRename('ann@local', 'anna@local')).toBe(true);
    expect(store.registerUserRename('ann@local', 'anna@local')).toBe(false);
    expect(store.getIdForAddress('anna@local')).toBe(chat);
    expect(store.getIdForAddress('ann@local')).toBe(chat);
    expect(store.getAddressForId(chat)).toBe('anna@local');
    // Цепочка: ник сменён ещё раз
    store.registerUserRename('anna@local', 'anya@local');
    expect(store.getIdForAddress('ann@local')).toBe(chat);
    expect(store.getIdForAddress('anya@local')).toBe(chat);
    expect(store.formerAddresses('anya@local').sort()).toEqual(['ann@local', 'anna@local']);
    const msg = store.buildApiMessage({
      id: 'u1', from: 'ann@local', to: 'me@local', ts: 1, content: { kind: 'text', text: 'hi' },
    });
    expect(msg.chatId).toBe(chat);
    expect(msg.isOutgoing).toBe(false);
  });

  it('свои сообщения под прежним ником — исходящие', () => {
    const store = new ParvaneStore();
    store.self = 'me-new@local';
    store.registerUserRename('me-old@local', 'me-new@local');
    const msg = store.buildApiMessage({
      id: 'u2', from: 'me-old@local', to: 'bob@local', ts: 1, content: { kind: 'text', text: 'hi' },
    });
    expect(msg.isOutgoing).toBe(true);
    expect(msg.chatId).toBe(store.getIdForAddress('bob@local'));
    expect(store.isSelfAddress('me-old@local')).toBe(true);
  });
});
