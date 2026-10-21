import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { callSignalFromV2, callSignalToV2, cleanGroupTitle, groupInviteFromV2 } from './v2/callMap';
import {
  deriveBundleKey, type KeyBundlePayload, openKeyBundle, pickRecoveryKey, sealKeyBundle,
} from './v2/keyBundle';
import { exportEncryptedBackup, importEncryptedBackup, type KeyBackupPayload } from './keyBackup';
import { buildPvpkArchive, packContentHash, parsePvpkArchive } from './stickerPacks';

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
      const vector = { password: KEYBACKUP_PASSWORD, payload: KEYBACKUP_PAYLOAD, file: JSON.parse(file) };
      writeFileSync(webFile, `${JSON.stringify(vector, undefined, 2)}\n`);
    }
    const web = JSON.parse(readFileSync(webFile, 'utf8')) as {
      password: string; payload: KeyBackupPayload; file: unknown;
    };
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
        recoveryKey: BUNDLE_KEY,
        address: BUNDLE_ADDRESS,
        bundleKey: b64(key),
        sealed: b64(sealed),
        payload: BUNDLE_PAYLOAD,
        pick,
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

// Сигналы звонка v1 ↔ v2 (CALL-1, CALL-2, spec 024): desktop обязан отображать так же
const CALL_ID = '0192f1a2-1111-7000-8000-000000000001';
const CALL_CASES_TO_V2: unknown[] = [
  { type: 'invite', call_id: CALL_ID, media: 'video', sdp: 'v=0 offer' },
  { type: 'answer', call_id: CALL_ID, sdp: 'v=0 answer' },
  { type: 'reject', call_id: CALL_ID, reason: 'busy' },
  { type: 'reject', call_id: CALL_ID, reason: 'answered_elsewhere' },
  { type: 'reject', call_id: CALL_ID, reason: 'media_failed' },
  { type: 'reject', call_id: CALL_ID },
  { type: 'hangup', call_id: CALL_ID },
  { type: 'media', call_id: CALL_ID, audio_muted: true, video_muted: false },
  {
    type: 'group_invite', group_call_id: CALL_ID, participants: ['a@x', 'b@x'], media: 'audio',
    group: 'v2g:0011aabb', title: '  Семья\u202e  \n дача ',
  },
];
const CALL_CASES_FROM_V2: unknown[] = [
  { call_id: 'AZLxohERcACAAAAAAAAAAQ==', offer: { sdp: 'v=0', video: true } },
  { call_id: 'AZLxohERcACAAAAAAAAAAQ==', hangup: { reason: 'HANGUP_REASON_ANSWERED_ELSEWHERE' } },
  { call_id: 'AZLxohERcACAAAAAAAAAAQ==', hangup: { reason: 6 } },
  { call_id: 'AZLxohERcACAAAAAAAAAAQ==', hangup: { reason: 'HANGUP_REASON_MISSED' } },
  { call_id: 'AZLxohERcACAAAAAAAAAAQ==', mediaState: { audioMuted: false, videoMuted: true } },
  {
    call_id: 'AZLxohERcACAAAAAAAAAAQ==',
    group_ring: {
      participants: [{ address: 'a@x' }], video: false, group: { domain: 'x', id: 'ABGqsw==' }, title: 'Дача',
    },
  },
];
const TITLE_CASES = ['Обычное', ' много   пробелов ', 'бидиу\u202eкод', 'перевод\nстроки', 'я'.repeat(300)];

/* eslint-disable no-null/no-null -- в JSON-векторе отсутствие результата записано как null */
describe('Векторы форматов клиентов: сигналы звонка', () => {
  it('web пишет таблицу отображения; desktop сверяет её в webcompat_tests', () => {
    const file = vectorPath('calls-web.json');
    if (REGEN || !existsSync(file)) {
      mkdirSync(DIR, { recursive: true });
      writeFileSync(file, `${JSON.stringify({
        domain: 'vec.example',
        toV2: CALL_CASES_TO_V2.map((input) => ({
          input, output: callSignalToV2(input as never, undefined, 'vec.example') ?? null,
        })),
        fromV2: CALL_CASES_FROM_V2.map((input) => ({
          input, output: groupInviteFromV2(input as never) ?? callSignalFromV2(input as never) ?? null,
        })),
        titles: TITLE_CASES.map((input) => ({ input, output: cleanGroupTitle(input) })),
      }, undefined, 2)}\n`);
    }
    const table = JSON.parse(readFileSync(file, 'utf8')) as {
      domain: string; toV2: { input: unknown; output: unknown }[]; fromV2: { input: unknown; output: unknown }[];
      titles: { input: string; output: string }[];
    };
    table.toV2.forEach(({ input, output }) => {
      expect(callSignalToV2(input as never, undefined, table.domain) ?? null).toEqual(output);
    });
    table.fromV2.forEach(({ input, output }) => {
      expect(groupInviteFromV2(input as never) ?? callSignalFromV2(input as never) ?? null).toEqual(output);
    });
    table.titles.forEach(({ input, output }) => expect(cleanGroupTitle(input)).toBe(output));
  });
});

// PACK-2: отпечаток содержимого набора стикеров — тот же вектор читает desktop (`webcompat_tests.cpp`)
describe('Векторы форматов клиентов: отпечаток набора стикеров (PACK-2)', () => {
  it('отпечаток файлов и распакованного архива совпадает с вектором', async () => {
    const table = JSON.parse(readFileSync(vectorPath('pack-hash.json'), 'utf8')) as {
      cases: { name: string; files: { name: string; data: string }[]; content_hash: string }[];
    };
    expect(table.cases.length).toBeGreaterThan(0);
    for (const entry of table.cases) {
      const files = entry.files.map(({ name, data }) => ({ name, data: unb64(data).slice().buffer }));
      expect(b64(await packContentHash(files)), entry.name).toBe(entry.content_hash);
      const unpacked = parsePvpkArchive(buildPvpkArchive(files)!)!;
      expect(b64(await packContentHash(unpacked)), entry.name).toBe(entry.content_hash);
    }
  });
});
