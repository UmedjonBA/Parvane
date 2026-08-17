import { describe, expect, it } from 'vitest';

import {
  exportLinkPublicKey,
  generateLinkKeyPair,
  openLinkBox,
  sasCodeForEphPub,
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

  it('derives a stable 6-digit sas code from the offer key', async () => {
    const pair = await generateLinkKeyPair();
    const pub = await exportLinkPublicKey(pair);
    const first = await sasCodeForEphPub(pub);
    const second = await sasCodeForEphPub(pub);
    expect(first).toMatch(/^\d{6}$/);
    expect(second).toBe(first);

    const otherPub = await exportLinkPublicKey(await generateLinkKeyPair());
    // Коллизия возможна, но для случайных ключей практически исключена
    expect(await sasCodeForEphPub(otherPub)).not.toBe(first);
  });
});
