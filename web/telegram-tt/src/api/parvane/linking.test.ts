import { describe, expect, it } from 'vitest';

import {
  exportLinkPublicKey,
  generateLinkKeyPair,
  linkCommitment,
  linkCommitmentMatches,
  openLinkBox,
  sasCodeV2,
  sealLinkBox,
} from './linking';

describe('linking crypto', () => {
  it('seals and opens a box across two ephemeral key pairs', async () => {
    const newDevice = await generateLinkKeyPair();
    const oldDevice = await generateLinkKeyPair();
    const newPub = await exportLinkPublicKey(newDevice);
    const oldPub = await exportLinkPublicKey(oldDevice);

    const payload = { file_id: 'f-1', file_key: 'k==', file_nonce: 'n==' };
    const box = await sealLinkBox(oldDevice.privateKey, newPub, payload);
    const opened = await openLinkBox(newDevice.privateKey, oldPub, box);
    expect(opened).toEqual(payload);
  });

  it('rejects a box sealed for a different key pair', async () => {
    const newDevice = await generateLinkKeyPair();
    const oldDevice = await generateLinkKeyPair();
    const mallory = await generateLinkKeyPair();
    const newPub = await exportLinkPublicKey(newDevice);
    const oldPub = await exportLinkPublicKey(oldDevice);

    const box = await sealLinkBox(oldDevice.privateKey, newPub, {
      file_id: 'f-1', file_key: 'k==', file_nonce: 'n==',
    });
    expect(await openLinkBox(mallory.privateKey, oldPub, box)).toBeUndefined();
  });

  // P-03: SAS v2 — 12 цифр (≥ 40 бит) от ПАРЫ эфемерных ключей
  it('derives a stable 12-digit sas code from both ephemeral keys', async () => {
    const newPub = await exportLinkPublicKey(await generateLinkKeyPair());
    const oldPub = await exportLinkPublicKey(await generateLinkKeyPair());
    const first = await sasCodeV2(newPub, oldPub);
    expect(first).toMatch(/^\d{4} \d{4} \d{4}$/);
    expect(await sasCodeV2(newPub, oldPub)).toBe(first);

    // Другой ключ любой из сторон → другой код (сервер-MITM не подберёт пару)
    const otherOld = await exportLinkPublicKey(await generateLinkKeyPair());
    expect(await sasCodeV2(newPub, otherOld)).not.toBe(first);
    const otherNew = await exportLinkPublicKey(await generateLinkKeyPair());
    expect(await sasCodeV2(otherNew, oldPub)).not.toBe(first);
    // Порядок ключей фиксирован (new, old)
    expect(await sasCodeV2(oldPub, newPub)).not.toBe(first);
  });

  // P-03: обязательство на ключ — публикуется до раскрытия
  it('binds the revealed key to its commitment', async () => {
    const pub = await exportLinkPublicKey(await generateLinkKeyPair());
    const commitment = await linkCommitment(pub);
    expect(commitment).toMatch(/^[A-Za-z0-9+/]{43}=$/);
    expect(await linkCommitmentMatches(pub, commitment)).toBe(true);

    const otherPub = await exportLinkPublicKey(await generateLinkKeyPair());
    expect(await linkCommitmentMatches(otherPub, commitment)).toBe(false);
    expect(await linkCommitmentMatches('', commitment)).toBe(false);
    expect(await linkCommitmentMatches(pub, '')).toBe(false);
  });

  // P-48: бокс переносит подписанный перенос владения, а не приватный аккаунт
  it('carries the signed transfer inside the box', async () => {
    const newDevice = await generateLinkKeyPair();
    const oldDevice = await generateLinkKeyPair();
    const newPub = await exportLinkPublicKey(newDevice);
    const oldPub = await exportLinkPublicKey(oldDevice);
    const payload = {
      file_id: 'f-1', file_key: 'k==', file_nonce: 'n==',
      transfer: { old_signing_key: 'OLD', signature: 'SIG' },
    };
    const box = await sealLinkBox(oldDevice.privateKey, newPub, payload);
    const opened = await openLinkBox(newDevice.privateKey, oldPub, box);
    expect(opened).toEqual(payload);
    expect(JSON.stringify(opened)).not.toContain('pickle');
  });
  // Кросс-клиентские векторы (те же в desktop tests/linking_tests.cpp и sync-rules.json)
  it('matches the cross-client vectors', async () => {
    const newPub = btoa(String.fromCharCode(...new Uint8Array(65)));
    const oldRaw = new Uint8Array(65).fill(1);
    oldRaw[0] = 4;
    const oldPub = btoa(String.fromCharCode(...oldRaw));
    expect(await linkCommitment(newPub)).toBe('mM5C3u9R1AJp1UL1MUvvLHRo1AGtXYUWi/q0wBCPdfc=');
    expect(await sasCodeV2(newPub, oldPub)).toBe('5659 7031 8371');
  });
});
