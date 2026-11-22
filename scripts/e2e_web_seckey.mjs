// Ключ безопасности — второй фактор входа (SECKEY-1, доска `ZdProfileX` «Ключ безопасности»). Виртуальный
// аутентификатор Chromium (CDP `WebAuthn`). Первое устройство заводит ключ в «Блокировка и ключ безопасности» со
// свежим паролем; новое устройство после верного пароля получает шаг «вставьте ключ»: отказ ключа оставляет на шаге,
// тот же ключ (перенесённый в аутентификатор второго браузера) открывает вход; потерянный ключ заменяет ключ
// восстановления (неверный — отказ); снятый ключ возвращает вход по паролю. rpId — `localhost` (раннер ставит
// `PARVANE_WEBAUTHN_RP_ID`), страница открывается на `localhost`: ключ WebAuthn не привязывается к IP-адресу.
import assert from 'node:assert/strict';

import { chromium } from '../web/telegram-tt/node_modules/playwright/index.mjs';

import {
  dismissRecoveryKeyDialog,
  expectToast,
  LOGIN_TIMEOUT_MS,
  openSettingsScreen,
  preparePage,
  submitNickUntilPassword,
} from './e2e_web_helpers.mjs';

const PASSWORD = 'Parvane-seckey-e2e-password';
const WAIT_MS = 20_000;
const RECOVERY_KEY_PATTERN = /[A-Z0-9]{4}(?:-[A-Z0-9]{4}){3,}/;
const AUTHENTICATOR = {
  protocol: 'ctap2',
  ctap2Version: 'ctap2_1',
  transport: 'usb',
  hasResidentKey: false,
  hasUserVerification: true,
  isUserVerified: true,
  automaticPresenceSimulation: true,
};

const browser = await chromium.launch();
const suffix = Date.now().toString(36);
const user = `seckey-${suffix}@local`;
const baseUrl = process.env.PARVANE_E2E_BASE_URL.replace('127.0.0.1', 'localhost');
const pages = [];

const shown = (locator, timeout = WAIT_MS) => locator.waitFor({ state: 'visible', timeout });
const slide = (page) => page.locator('#Settings .Transition_slide-active');
const stepScreen = (page) => page.locator('[data-security-key-step]');

async function shot(page, name) {
  const dir = process.env.PARVANE_E2E_SHOT_DIR;
  if (!dir) return;
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${dir}/seckey-${name}.png` });
}

async function addAuthenticator(context, page) {
  const cdp = await context.newCDPSession(page);
  await cdp.send('WebAuthn.enable');
  const { authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', { options: AUTHENTICATOR });
  return { cdp, authenticatorId };
}

async function openLockScreen(page) {
  await openSettingsScreen(page, 'Privacy and security');
  await slide(page).locator('[data-pin-state]').click();
  await shown(slide(page).locator('[data-security-keys]'));
}

async function confirmPassword(page, kind, password = PASSWORD) {
  const form = slide(page).locator(`[data-security-key-confirm="${kind}"]`);
  await shown(form);
  await form.locator('input[type="password"]').fill(password);
  await form.getByRole('button').first().click();
}

// Новое устройство: ник и пароль на странице `localhost`, без ожидания списка чатов
async function signInNewDevice(context) {
  const page = await context.newPage();
  pages.push(page);
  await page.addInitScript((url) => {
    localStorage.setItem('parvane:gateway', url);
  }, process.env.PARVANE_E2E_GATEWAY_URL);
  await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
  const passwordScreen = await submitNickUntilPassword(page, user);
  await passwordScreen.locator('#sign-in-password').fill(PASSWORD);
  await passwordScreen.locator('[data-auth-submit]').click();
  return page;
}

try {
  // ── Первое устройство: личность, ключ восстановления, ключ безопасности ──────────────────────────
  const contextA = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const session = await preparePage(contextA, user, PASSWORD, {
    startUrl: baseUrl, seedLocalStorage: { 'parvane:proto': 'v2' },
  });
  const pageA = session.page;
  pages.push(pageA);
  const keyText = await dismissRecoveryKeyDialog(pageA, LOGIN_TIMEOUT_MS);
  const recoveryKey = keyText?.match(RECOVERY_KEY_PATTERN)?.[0];
  assert.ok(recoveryKey, `ключ восстановления не показан: ${keyText}`);
  const authA = await addAuthenticator(contextA, pageA);

  await openLockScreen(pageA);
  await shown(slide(pageA).locator('[data-security-keys="0"]'));
  // Копия корня уходит на сервер через несколько секунд после создания личности — до неё ключ не заводится
  for (let attempt = 0; ; attempt++) {
    await slide(pageA).locator('[data-security-key-add]').click();
    const isAsked = await slide(pageA).locator('[data-security-key-confirm="add"]')
      .waitFor({ state: 'visible', timeout: 3000 }).then(() => true).catch(() => false);
    if (isAsked) break;
    assert.ok(attempt < 15, 'копия корня так и не появилась на сервере');
    await pageA.waitForTimeout(2000);
    await openLockScreen(pageA);
  }
  // Неверный пароль — отказ, ключ не заведён
  await confirmPassword(pageA, 'add', 'Wrong-password-1');
  await shown(slide(pageA).getByText('Wrong password', { exact: true }));
  await confirmPassword(pageA, 'add');
  await expectToast(pageA, 'Security key added');
  await shown(slide(pageA).locator('[data-security-keys="1"]'));
  await shown(slide(pageA).locator('[data-security-key-required="on"][aria-checked="true"]'));
  await shown(slide(pageA).getByText('Security key 1', { exact: true }));
  await shot(pageA, 'settings');
  const { credentials } = await authA.cdp.send('WebAuthn.getCredentials', { authenticatorId: authA.authenticatorId });
  assert.equal(credentials.length, 1, 'ключ не создан в аутентификаторе');
  console.log('OK: ключ безопасности заведён со свежим паролем, требование при входе включено');

  // ── Новое устройство без ключа: шаг ключа, отказ браузера оставляет на шаге ─────────────────────
  const contextB = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const pageB = await signInNewDevice(contextB);
  await shown(stepScreen(pageB), LOGIN_TIMEOUT_MS);
  await shot(pageB, 'login-step');
  await pageB.evaluate(() => {
    navigator.credentials.get = () => Promise.reject(new DOMException('no key in e2e', 'NotAllowedError'));
  });
  await stepScreen(pageB).locator('[data-security-key-use]').click();
  await shown(stepScreen(pageB).locator('[data-security-key-error]'));
  assert.equal(await pageB.locator('#LeftColumn').isVisible(), false, 'вход без ключа');
  console.log('OK: новое устройство без ключа на шаг дальше пароля не проходит');

  // Тот же ключ во втором браузере — вход
  await pageB.reload({ waitUntil: 'domcontentloaded' });
  const authB = await addAuthenticator(contextB, pageB);
  await authB.cdp.send('WebAuthn.addCredential', {
    authenticatorId: authB.authenticatorId,
    credential: { ...credentials[0], isResidentCredential: false },
  });
  const passwordB = await submitNickUntilPassword(pageB, user);
  await passwordB.locator('#sign-in-password').fill(PASSWORD);
  await passwordB.locator('[data-auth-submit]').click();
  await shown(stepScreen(pageB), LOGIN_TIMEOUT_MS);
  await stepScreen(pageB).locator('[data-security-key-use]').click();
  await shown(pageB.locator('#LeftColumn'), LOGIN_TIMEOUT_MS);
  await stepScreen(pageB).waitFor({ state: 'detached', timeout: WAIT_MS });
  console.log('OK: вход нового устройства с ключом безопасности');

  // ── Ключ потерян: ключ восстановления вместо него ────────────────────────────────────────────
  const contextC = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const pageC = await signInNewDevice(contextC);
  await shown(stepScreen(pageC), LOGIN_TIMEOUT_MS);
  await stepScreen(pageC).locator('[data-security-key-lost]').click();
  const recoveryForm = stepScreen(pageC).locator('[data-security-key-recovery]');
  await shown(recoveryForm);
  await recoveryForm.locator('input').fill('AAAA-BBBB-CCCC-DDDD');
  await recoveryForm.locator('[data-auth-submit]').click();
  await shown(stepScreen(pageC).getByText('The recovery key did not match', { exact: true }));
  await recoveryForm.locator('input').fill(recoveryKey);
  await recoveryForm.locator('[data-auth-submit]').click();
  await shown(pageC.locator('#LeftColumn'), LOGIN_TIMEOUT_MS);
  console.log('OK: без ключа безопасности — вход ключом восстановления, неверный не подходит');

  // ── Первое устройство снимает ключ — вход паролем как раньше ──────────────────────────────────
  await openLockScreen(pageA);
  await shown(slide(pageA).locator('[data-security-keys="1"]'));
  await shown(slide(pageA).getByText(/· used /));
  await slide(pageA).locator('[data-security-key-remove]').click();
  await confirmPassword(pageA, 'remove');
  await expectToast(pageA, 'Security key removed');
  await shown(slide(pageA).locator('[data-security-keys="0"]'));
  const contextD = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const pageD = await signInNewDevice(contextD);
  await shown(pageD.locator('#LeftColumn'), LOGIN_TIMEOUT_MS);
  assert.equal(await stepScreen(pageD).count(), 0, 'шаг ключа после снятия ключа');
  console.log('OK: снятый ключ — вход нового устройства одним паролем');
} catch (err) {
  for (const [index, page] of pages.entries()) {
    await page.screenshot({ path: `web/telegram-tt/test-results/seckey-fail-${index}.png` }).catch(() => {});
  }
  throw err;
} finally {
  await browser.close();
}
