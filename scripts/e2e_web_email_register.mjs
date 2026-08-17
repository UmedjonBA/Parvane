// Регистрация через почту (PARVANE_EMAIL_REQUIRED=1, dev-режим SMTP: код в лог
// identity). Проверяет: новый адрес → экран email → экран кода (неверный код
// отклоняется, верный подтверждает) → залогинен; повторный вход по паролю идёт
// сразу в чат; вход в НЕподтверждённый аккаунт перевысылает код и ведёт на
// экран кода.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { chromium } from '../web/telegram-tt/node_modules/playwright/index.mjs';

import { LOGIN_TIMEOUT_MS, assertNoPageErrors, preparePage, requireEnv } from './e2e_web_helpers.mjs';

const PASSWORD = 'Parvane-email-e2e-password';
const backendLogDir = process.env.PARVANE_E2E_BACKEND_LOG_DIR;
assert(backendLogDir, 'PARVANE_E2E_BACKEND_LOG_DIR is required');
const identityLogPath = path.join(backendLogDir, 'identity.log');

// Последний dev-код подтверждения для email из лога identity-шарда
async function fetchLatestCode(email, { notEqualTo } = {}) {
  const pattern = new RegExp(`код подтверждения для ${email.replace(/[.@]/g, '\\$&')}: (\\d{6})`, 'g');
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const log = await readFile(identityLogPath, 'utf8').catch(() => '');
    const codes = [...log.matchAll(pattern)].map((match) => match[1]);
    const latest = codes[codes.length - 1];
    if (latest && latest !== notEqualTo) return latest;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`код для ${email} не появился в ${identityLogPath}`);
}

async function openLoginPage(context, user) {
  const { baseUrl, gatewayUrl } = requireEnv();
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (err) => errors.push(err.message));
  await page.addInitScript((url) => {
    localStorage.setItem('parvane:gateway', url);
  }, gatewayUrl);
  await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });

  const addressScreen = page.locator('.Transition_slide-active > #auth-phone-number-form');
  const addressInput = addressScreen.getByLabel('Address (user@server)');
  await addressInput.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await addressInput.fill(user);
  await addressScreen.getByRole('button', { name: 'Next' }).click();

  const passwordScreen = page.locator('.Transition_slide-active > #auth-password-form');
  await passwordScreen.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await passwordScreen.locator('#sign-in-password').fill(PASSWORD);
  await passwordScreen.getByRole('button', { name: 'Next' }).click();
  return { page, errors };
}

async function waitCodeScreen(page) {
  const codeScreen = page.locator('.Transition_slide-active > #auth-code-form');
  await codeScreen.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  return codeScreen;
}

async function submitCode(codeScreen, code) {
  const input = codeScreen.locator('#sign-in-code');
  await input.fill('');
  await input.pressSequentially(code);
}

const browser = await chromium.launch();

try {
  const suffix = `${Date.now()}-${process.pid}`;
  const alice = `email-a-${suffix}@local`;
  const aliceEmail = `alice-${suffix}@example.com`;

  // ── Новый аккаунт: адрес → пароль → email → код ──
  const registerContext = await browser.newContext();
  const registerSession = await openLoginPage(registerContext, alice);
  const { page } = registerSession;

  const emailScreen = page.locator('.Transition_slide-active > #auth-registration-form');
  await emailScreen.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await emailScreen.locator('#sign-up-parvane-email').fill(aliceEmail);
  await emailScreen.getByRole('button', { name: 'Next' }).click();

  const codeScreen = await waitCodeScreen(page);
  const code = await fetchLatestCode(aliceEmail);

  // Неверный код отклоняется с ошибкой, аккаунт не активируется
  const wrongCode = code === '000000' ? '000001' : '000000';
  await submitCode(codeScreen, wrongCode);
  await codeScreen.getByText('Invalid code', { exact: false })
    .waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });

  // Верный код завершает регистрацию и логинит
  await submitCode(codeScreen, code);
  await page.locator('#LeftColumn').waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  console.log('OK: регистрация с подтверждением почты завершена, клиент залогинен');
  assertNoPageErrors({ alice: registerSession });
  await registerContext.close();

  // ── Подтверждённый аккаунт: обычный вход без экранов email/кода ──
  const reloginContext = await browser.newContext();
  const reloginSession = await preparePage(reloginContext, alice, PASSWORD);
  console.log('OK: повторный вход подтверждённого аккаунта идёт сразу в чат');
  assertNoPageErrors({ alice: reloginSession });
  await reloginContext.close();

  // ── Незавершённая регистрация: вход перевысылает код и ведёт на экран кода ──
  const bob = `email-b-${suffix}@local`;
  const bobEmail = `bob-${suffix}@example.com`;
  const abandonContext = await browser.newContext();
  const abandonSession = await openLoginPage(abandonContext, bob);
  const bobEmailScreen = abandonSession.page
    .locator('.Transition_slide-active > #auth-registration-form');
  await bobEmailScreen.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await bobEmailScreen.locator('#sign-up-parvane-email').fill(bobEmail);
  await bobEmailScreen.getByRole('button', { name: 'Next' }).click();
  await waitCodeScreen(abandonSession.page);
  const firstBobCode = await fetchLatestCode(bobEmail);
  await abandonContext.close();

  const resumeContext = await browser.newContext();
  const resumeSession = await openLoginPage(resumeContext, bob);
  const resumeCodeScreen = await waitCodeScreen(resumeSession.page);
  // Fallback-register при логине перевыслал НОВЫЙ код на сохранённую почту
  const resentCode = await fetchLatestCode(bobEmail, { notEqualTo: firstBobCode });
  await submitCode(resumeCodeScreen, resentCode);
  await resumeSession.page.locator('#LeftColumn').waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  console.log('OK: вход в неподтверждённый аккаунт перевысылает код и завершает регистрацию');
  assertNoPageErrors({ bob: resumeSession });
  await resumeContext.close();
} finally {
  await browser.close();
}
