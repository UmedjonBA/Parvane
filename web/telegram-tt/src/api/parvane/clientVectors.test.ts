import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { exportEncryptedBackup, importEncryptedBackup, type KeyBackupPayload } from './keyBackup';
import {
  deriveBundleKey, type KeyBundlePayload, openKeyBundle, pickRecoveryKey, sealKeyBundle,
} from './v2/keyBundle';

// Общие векторы форматов клиентов (spec 029, FR-006): файл, который пишет web, обязан читать desktop
// (`parvane-core/tests/webcompat_tests.cpp`), и наоборот. Вектор web создаётся, если его нет (или
// PARVANE_REGEN_VECTORS=1); вектор desktop пишет тест desktop.

const DIR = path.resolve(process.cwd(), '../../proto/parvane/vectors/clients');
const REGEN = process.env.PARVANE_REGEN_VECTORS === '1';

const KEYBACKUP_PASSWORD = 'Vector-pass-2026';
const KEYBACKUP_PAYLOAD: KeyBackupPayload = {
  deviceId: 'vec-device-1',
  v2: { key: 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=', state: 'c3RhdGUtYnl0ZXM=' },
  v2History: [{ chat: 'bob@local', id: '0192f1a2-0000-7000-8000-000000000001', text: 'привет' }],
};

function vectorPath(name: string) {
  return path.join(DIR, name);
}

describe('Векторы форматов клиентов: копия ключей (формат 2)', () => {
  it('файл web читается web, а файл desktop — web', async () => {
    const webFile = vectorPath('keybackup-web.json');
    if (REGEN || !existsSync(webFile)) {
      mkdirSync(DIR, { recursive: true });
      const file = await exportEncryptedBackup(KEYBACKUP_PASSWORD, KEYBACKUP_PAYLOAD);
      writeFileSync(webFile, `${JSON.stringify({ password: KEYBACKUP_PASSWORD, payload: KEYBACKUP_PAYLOAD, file: JSON.parse(file) }, undefined, 2)}\n`);
    }
    const web = JSON.parse(readFileSync(webFile, 'utf8')) as { password: string; payload: KeyBackupPayload; file: unknown };
    expect(await importEncryptedBackup(web.password, JSON.stringify(web.file))).toEqual(web.payload);

    const desktopFile = vectorPath('keybackup-desktop.json');
    expect(existsSync(desktopFile)).toBe(true);
    const desktop = JSON.parse(readFileSync(desktopFile, 'utf8')) as {
      password: string; payload: KeyBackupPayload; file: unknown;
    };
    expect(await importEncryptedBackup(desktop.password, JSON.stringify(desktop.file))).toEqual(desktop.payload);
    await expect(importEncryptedBackup('wrong-password', JSON.stringify(desktop.file))).rejects.toThrow();
  });
});

const BUNDLE_KEY = 'A1B2-C3D4-E5F6-G7H8-J9K0-M1N2-P3Q4-R5S6-T7V8-W9X0';
const BUNDLE_ADDRESS = 'vera@parvane.example';
const BUNDLE_PAYLOAD: KeyBundlePayload = {
  grant: 'eyJzc2siOiIwMCJ9',
  planner: '{"id":"aa"}',
  cloud: '[]',
  history: {
    fileId: 'f1', fileKey: 'k1', fileNonce: 'n1', at: 1760000000000, mark: 'm1', size: 42,
  },
};
// Ключ в окружающем тексте, длинное тире, буквы-двойники; ничего похожего — исходный текст
const PICK_CASES = [
  `Ваш ключ: ${BUNDLE_KEY}. Сохраните его.`,
  BUNDLE_KEY.toLowerCase().replace(/-/g, '—'),
  BUNDLE_KEY.replace(/-/g, ''),
  'A1B2 C3D4 E5F6 G7H8 J9K0 M1N2 P3Q4 R5S6 T7V8 W9XO',
  '  не ключ  ',
  'XA1B2-C3D4-E5F6-G7H8-J9K0-M1N2-P3Q4-R5S6-T7V8-W9X0',
];

const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64');
const unb64 = (s: string) => new Uint8Array(Buffer.from(s, 'base64'));

describe('Векторы форматов клиентов: копия ключей аккаунта (PVKB)', () => {
  it('ключ копии, файл web и разбор ключа читаются desktop; файл desktop читается web', async () => {
    const webFile = vectorPath('keybundle-web.json');
    if (REGEN || !existsSync(webFile)) {
      mkdirSync(DIR, { recursive: true });
      const key = (await deriveBundleKey(BUNDLE_KEY, BUNDLE_ADDRESS))!;
      const sealed = await sealKeyBundle(key, BUNDLE_ADDRESS, BUNDLE_PAYLOAD);
      const pick = PICK_CASES.map((input) => ({ input, output: pickRecoveryKey(input) }));
      writeFileSync(webFile, `${JSON.stringify({
        recoveryKey: BUNDLE_KEY, address: BUNDLE_ADDRESS, bundleKey: b64(key), sealed: b64(sealed), payload: BUNDLE_PAYLOAD, pick,
      }, undefined, 2)}\n`);
    }
    const web = JSON.parse(readFileSync(webFile, 'utf8')) as {
      recoveryKey: string; address: string; bundleKey: string; sealed: string; payload: KeyBundlePayload;
      pick: { input: string; output: string }[];
    };
    const key = (await deriveBundleKey(web.recoveryKey, web.address))!;
    expect(b64(key)).toBe(web.bundleKey);
    expect(await openKeyBundle(key, web.address, unb64(web.sealed))).toEqual(web.payload);
    expect(await openKeyBundle(key, 'other@parvane.example', unb64(web.sealed))).toBeUndefined();
    web.pick.forEach(({ input, output }) => expect(pickRecoveryKey(input)).toBe(output));

    const desktopFile = vectorPath('keybundle-desktop.json');
    expect(existsSync(desktopFile)).toBe(true);
    const desktop = JSON.parse(readFileSync(desktopFile, 'utf8')) as {
      recoveryKey: string; address: string; sealed: string; payload: KeyBundlePayload;
    };
    const desktopKey = (await deriveBundleKey(desktop.recoveryKey, desktop.address))!;
    expect(await openKeyBundle(desktopKey, desktop.address, unb64(desktop.sealed))).toEqual(desktop.payload);
  });
});
