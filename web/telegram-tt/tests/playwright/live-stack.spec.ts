import { expect, test } from '@playwright/test';

import {
  callDiagApi,
  LOGIN_TIMEOUT_MS,
  openApp,
  readSecureStateSnapshot,
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

  // Хранилище движка (spec 035): ключ профиля non-extractable, состояние движка v2 записано (оно пишется
  // после подъёма движка, уже за экраном входа — ждём) и открывается ключом профиля; пароля нет ни в
  // значениях базы профиля, ни в localStorage
  await expect.poll(async () => (await readSecureStateSnapshot(page, user)).hasState, {
    timeout: LOGIN_TIMEOUT_MS,
  }).toBe(true);
  const storage = await readSecureStateSnapshot(page, user, { secret: E2E_PASSWORD });
  expect(storage).toMatchObject({
    hasKey: true,
    keyExtractable: false,
    hasRoot: true,
    secretLeaked: false,
    loginAddress: user,
    legacyE2eKeyCount: 0,
  });
  expect(await page.evaluate(() => localStorage.getItem('parvane:creds'))).toBeNull();
  expect(await callDiagApi(page, 'parvaneDiagHasSecureRecord', { name: 'v2-engine-bin' })).toBe(true);
});
