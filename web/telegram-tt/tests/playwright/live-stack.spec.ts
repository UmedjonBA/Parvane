import { expect, test } from '@playwright/test';

const E2E_PASSWORD = 'Parvane-e2e-password';
const LOGIN_TIMEOUT_MS = 60000;

test('registers and signs in through the live production stack', async ({ page }, testInfo) => {
  const gatewayUrl = process.env.PARVANE_E2E_GATEWAY_URL;
  expect(gatewayUrl, 'The live-stack runner must provide PARVANE_E2E_GATEWAY_URL').toBeTruthy();

  await page.addInitScript((url) => {
    localStorage.setItem('parvane:gateway', url);
  }, gatewayUrl);
  await page.route(/https:\/\/(?:t\.me|telegram\.me|telegram\.dog)\/_websync_/, async (route) => {
    await route.fulfill({ contentType: 'application/javascript', body: '' });
  });

  const pageErrors: string[] = [];
  page.on('pageerror', (err) => pageErrors.push(err.message));

  const user = `web-e2e-${testInfo.project.name.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}@local`;
  await page.goto('/', { waitUntil: 'domcontentloaded' });

  const addressScreen = page.locator('.Transition_slide-active > #auth-phone-number-form');
  const addressInput = addressScreen.getByLabel('Address (user@server)');
  await expect(addressInput).toBeVisible({ timeout: LOGIN_TIMEOUT_MS });
  await addressInput.pressSequentially(user);
  await addressScreen.getByRole('button', { name: 'Next' }).click();

  const passwordScreen = page.locator('.Transition_slide-active > #auth-password-form');
  await expect(passwordScreen).toBeVisible({ timeout: LOGIN_TIMEOUT_MS });
  await passwordScreen.locator('#sign-in-password').pressSequentially(E2E_PASSWORD);
  await passwordScreen.getByRole('button', { name: 'Next' }).click();

  await expect(page.locator('#LeftColumn')).toBeVisible({ timeout: LOGIN_TIMEOUT_MS });
  await expect(addressScreen).toHaveCount(0);
  expect(pageErrors).toEqual([]);

  const storage = await page.evaluate(async ({ address, password }) => {
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
    const [key, state] = await Promise.all([
      read<CryptoKey>(`key:${address}`),
      read<{ version: number; ciphertext: ArrayBuffer }>(`state:${address}`),
    ]);
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
  }, { address: user, password: E2E_PASSWORD });
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
