import { expect, test } from '@playwright/test';

import {
  LOGIN_TIMEOUT_MS,
  openApp,
  registerAndSignIn,
  requireGatewayUrl,
} from './helpers';

const E2E_PASSWORD = 'Parvane-e2e-password';

test('registers and signs in through the live production stack', async ({ page }, testInfo) => {
  const gatewayUrl = requireGatewayUrl();

  const pageErrors = await openApp(page, gatewayUrl);
  const user = `web-e2e-${testInfo.project.name.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}@local`;
  await registerAndSignIn(page, user, E2E_PASSWORD);
  await expect(page.locator('#auth-phone-number-form')).toHaveCount(0);
  expect(pageErrors).toEqual([]);

  const storage = await page.evaluate(async ({ address, password, timeoutMs }) => {
    const localEntries = Object.keys(localStorage).map((key) => [key, localStorage.getItem(key)]);
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('parvane-e2e-v2');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const read = <T,>(key: string) => new Promise<T | undefined>((resolve, reject) => {
      const request = db.transaction('secure-state').objectStore('secure-state').get(key);
      request.onsuccess = () => resolve(request.result as T | undefined);
      request.onerror = () => reject(request.error);
    });
    // Состояние движка v2 — именованная запись под non-extractable ключом
    // (secureStorage.ts: `rec:<адрес>:<имя>`, v2/controller.ts: STATE_RECORD).
    // Пишется после подъёма движка, уже за экраном входа — ждём её появления
    const key = await read<CryptoKey>(`key:${address}`);
    let state: { version: number; ciphertext: ArrayBuffer } | undefined;
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      state = await read<{ version: number; ciphertext: ArrayBuffer }>(`rec:${address}:v2-engine`);
      if (state || Date.now() > deadline) break;
      await new Promise((resolve) => {
        setTimeout(resolve, 250);
      });
    }
    db.close();
    return {
      passwordLeaked: JSON.stringify(localEntries).includes(password),
      legacyCredentials: localStorage.getItem('parvane:creds'),
      savedAddress: localStorage.getItem('parvane:login-address'),
      legacyE2eKeys: localEntries.filter(([keyName]) => keyName.startsWith('parvane:e2e:')),
      keyExtractable: key?.extractable,
      stateVersion: state?.version,
      ciphertextLeaked: state
        ? new TextDecoder().decode(state.ciphertext).includes(password)
        : true,
    };
  }, { address: user, password: E2E_PASSWORD, timeoutMs: LOGIN_TIMEOUT_MS });
  expect(storage.legacyCredentials).toBeNull();
  expect(storage).toMatchObject({
    passwordLeaked: false,
    savedAddress: user,
    legacyE2eKeys: [],
    keyExtractable: false,
    stateVersion: 2,
    ciphertextLeaked: false,
  });
});
