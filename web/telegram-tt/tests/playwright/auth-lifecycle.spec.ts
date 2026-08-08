import { expect, test } from '@playwright/test';

import {
  expectSignedIn,
  LOGIN_TIMEOUT_MS,
  openApp,
  readSecureStateSnapshot,
  registerAndSignIn,
  requireGatewayUrl,
  submitAddress,
  submitPassword,
  uniqueUser,
} from './helpers';

const PASSWORD = 'Parvane-auth-e2e-password';
const WRONG_PASSWORD = 'Parvane-auth-wrong-password';

test('keeps the saved address after reload and rejects an invalid password', async ({ page }, testInfo) => {
  const gatewayUrl = requireGatewayUrl();
  const user = uniqueUser('auth-reload', testInfo.project.name);

  await openApp(page, gatewayUrl);
  await registerAndSignIn(page, user, PASSWORD);

  await page.reload({ waitUntil: 'domcontentloaded' });

  // После reload адрес запомнен: сразу экран пароля, без экрана адреса
  const passwordScreen = page.locator('.Transition_slide-active > #auth-password-form');
  await expect(passwordScreen).toBeVisible({ timeout: LOGIN_TIMEOUT_MS });
  await expect(page.locator('.Transition_slide-active > #auth-phone-number-form')).toHaveCount(0);

  await submitPassword(page, WRONG_PASSWORD);

  // Неверный пароль: наблюдаемая ошибка, сессии нет, регистрация не происходит
  await expect(passwordScreen.getByText('Invalid password, please try again'))
    .toBeVisible({ timeout: LOGIN_TIMEOUT_MS });
  await expect(page.locator('#LeftColumn')).toHaveCount(0);

  await submitPassword(page, PASSWORD);
  await expectSignedIn(page);
});

test('logs out through settings and clears the local session state', async ({ page }, testInfo) => {
  // Playwright WebKit-движок на этом окружении спорадически падает (Target
  // crashed) и зависает в длинных сценариях; startup/login WebKit покрывает
  // live-stack.spec.ts, глубокие флоу гоняются на Chromium и Firefox
  test.skip(['webkit', 'ios'].includes(testInfo.project.name),
    'flaky WebKit build in long flows; engine startup/login covered by live-stack.spec.ts');
  const gatewayUrl = requireGatewayUrl();
  const user = uniqueUser('auth-logout', testInfo.project.name);

  await openApp(page, gatewayUrl);
  await registerAndSignIn(page, user, PASSWORD);

  const signedInState = await readSecureStateSnapshot(page, user);
  expect(signedInState).toMatchObject({
    hasKey: true,
    hasState: true,
    loginAddress: user,
  });

  await page.getByRole('button', { name: 'Open menu' }).first().click();
  await page.getByRole('menuitem', { name: 'Settings' }).click();
  await page.getByRole('button', { name: 'More actions' }).click();
  await page.getByRole('menuitem', { name: 'Log Out' }).click();
  await page.getByRole('button', { name: 'Log Out', exact: true }).click();

  // Инвариант logout — очистка локального состояния; вид переходного экрана
  // авторизации отличается между движками и проверяется после reload
  // Ключи, зашифрованный state и адрес логина удалены
  await expect.poll(async () => readSecureStateSnapshot(page, user), {
    timeout: LOGIN_TIMEOUT_MS,
  }).toMatchObject({
    hasKey: false,
    hasState: false,
    hasLoginAddress: false,
    legacyE2eKeyCount: 0,
  });

  // После повторной навигации чистый storage детерминированно даёт экран
  // адреса (goto устойчивее reload, который может зависнуть в гонке с
  // пост-logout переинициализацией)
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('.Transition_slide-active > #auth-phone-number-form'))
    .toBeVisible({ timeout: LOGIN_TIMEOUT_MS });

  // Учётная запись на сервере жива: повторный вход с тем же паролем успешен
  await submitAddress(page, user);
  await submitPassword(page, PASSWORD);
  await expectSignedIn(page);
});
