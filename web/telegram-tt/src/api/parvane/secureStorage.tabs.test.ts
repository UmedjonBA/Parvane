// spec 035 T040 (FR-027): две вкладки одного профиля. DEK у открытой вкладки при смене обёртки не меняется,
// поэтому её записи остаются читаемыми; при переносе поколения вкладка, получившая
// `storage-generation-switched`, перечитывает корень до следующей записи — либо блокируется до ввода PIN.
import { beforeEach, describe, expect, it } from 'vitest';

import * as tabA from './secureStorage';

type Hooks = {
  forgetAll?: () => void;
  settled?: (user: string) => Promise<void>;
  createTab?: () => typeof tabA;
};
const hooks = tabA.secureStorageInternals as unknown as Hooks;
const USER = 'tabs@local';
const PIN = 'tabs-pin-123';

const tick = (ms = 30) => new Promise((resolve) => {
  setTimeout(resolve, ms);
});

// «Перезагрузка» и чтение записи заново с диска
async function reloadAndRead(name: string) {
  tabA.lockStorage(USER);
  hooks.forgetAll?.();
  if (await tabA.hasStoragePin(USER)) expect(await tabA.unlockStorageWithPin(USER, PIN)).toBe(true);
  return (await tabA.SecureE2eStorage.open(USER)).loadRecord(name);
}

describe('spec 035 T040: смена PIN в одной вкладке, запись во второй', () => {
  beforeEach(async () => {
    await tabA.SecureE2eStorage.clear(USER);
  });

  it('экземпляр, открытый до смены PIN, пишет так, что запись читается после перезапуска', async () => {
    const early = await tabA.SecureE2eStorage.open(USER);
    await early.saveRecord('seed', { v: 0 });
    await tabA.setStoragePin(USER, PIN);
    await hooks.settled?.(USER);
    await early.saveRecord('from-b', { v: 1 });
    expect(await reloadAndRead('from-b')).toEqual({ v: 1 });
    expect(await reloadAndRead('seed')).toEqual({ v: 0 });
  });

  it('вторая вкладка (свой движок): записи читаются после перезапуска либо она заблокирована', async () => {
    expect(typeof hooks.createTab).toBe('function');
    const tabB = hooks.createTab!();
    const a = await tabA.SecureE2eStorage.open(USER);
    await a.saveRecord('seed', { v: 0 });
    const b = await tabB.SecureE2eStorage.open(USER);
    await b.saveRecord('b-before', { v: 1 });

    await tabA.setStoragePin(USER, PIN);
    await tick();
    let wroteDuring = true;
    await b.saveRecord('b-during', { v: 2 }).catch(() => {
      wroteDuring = false;
    });
    await hooks.settled?.(USER);
    await tick();
    let wroteAfter = true;
    await b.saveRecord('b-after', { v: 3 }).catch(() => {
      wroteAfter = false;
    });
    if (!wroteAfter) expect(tabB.isStorageUnlocked(USER)).toBe(false);

    expect(await reloadAndRead('b-before')).toEqual({ v: 1 });
    if (wroteDuring) expect(await reloadAndRead('b-during')).toEqual({ v: 2 });
    if (wroteAfter) expect(await reloadAndRead('b-after')).toEqual({ v: 3 });
    expect(await reloadAndRead('seed')).toEqual({ v: 0 });
  });
});
