// Регистрация через почту (PARVANE_EMAIL_REQUIRED=1, dev-режим SMTP: код в лог
// identity). Проверяет: «Создать аккаунт» → форма (ник БЕЗ @домена, почта,
// пароль) → экран кода (неверный код отклоняется, верный подтверждает) →
// залогинен; повторный вход по нику идёт сразу в чат; вход под несуществующим
// ником ведёт на форму регистрации с заполненным ником; вход в
// НЕподтверждённый аккаунт перевысылает код и ведёт на экран кода.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { chromium } from '../web/telegram-tt/node_modules/playwright/index.mjs';

import {
  LOGIN_TIMEOUT_MS, assertNoPageErrors, preparePage, requireEnv, submitNick,
} from './e2e_web_helpers.mjs';

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

async function openStartPage(context) {
  const { baseUrl, gatewayUrl } = requireEnv();
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (err) => errors.push(err.message));
  await page.addInitScript((url) => {
    localStorage.setItem('parvane:gateway', url);
  }, gatewayUrl);
  await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
  const startScreen = page.locator('.Transition_slide-active > #auth-phone-number-form');
  await startScreen.getByLabel('Nickname').waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  return { page, errors, startScreen };
}

// Экран входа: ник → пароль (как обычный логин)
async function openLoginPage(context, user) {
  const session = await openStartPage(context);
  const { page } = session;
  await submitNick(page, user);

  const passwordScreen = page.locator('.Transition_slide-active > #auth-password-form');
  await passwordScreen.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await passwordScreen.locator('#sign-in-password').fill(PASSWORD);
  await passwordScreen.getByRole('button', { name: 'Next' }).click();
  return session;
}

// «Создать аккаунт» на экране входа. Провайдер после чтения storage повторно
// шлёт WaitPhoneNumber — ранний клик может быть перекрыт, повторяем. Клик —
// событием mousedown напрямую (Button срабатывает на mousedown): маска UiLoader в headless-вкладке подолгу
// висит в состоянии closing и перехватывает указатель
async function openRegisterForm(page, startScreen) {
  const deadline = Date.now() + LOGIN_TIMEOUT_MS;
  for (;;) {
    await startScreen.getByRole('button', { name: 'Create account' }).dispatchEvent('mousedown', { button: 0 });
    try {
      await page.locator('.Transition_slide-active > #auth-registration-form')
        .waitFor({ state: 'visible', timeout: 3000 });
      return;
    } catch (err) {
      if (Date.now() > deadline) throw err;
    }
  }
}

async function waitRegisterScreen(page) {
  const registerScreen = page.locator('.Transition_slide-active > #auth-registration-form');
  await registerScreen.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  // Поле почты появляется после ответа server.info (сервер требует почту)
  await registerScreen.locator('#sign-up-parvane-email').waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  return registerScreen;
}

async function submitRegisterForm(registerScreen, { nick, email }) {
  if (nick !== undefined) {
    await registerScreen.locator('#sign-up-parvane-nick').fill(nick);
  }
  await registerScreen.locator('#sign-up-parvane-email').fill(email);
  await registerScreen.locator('#sign-up-parvane-password').fill(PASSWORD);
  await registerScreen.getByRole('button', { name: 'Create account' }).click();
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
  // Ник без @домена: сервер (PARVANE_DOMAIN=local по умолчанию) сам дополняет
  const aliceNick = `email-a-${suffix}`;
  const aliceEmail = `alice-${suffix}@example.com`;

  // ── Новый аккаунт: «Создать аккаунт» → ник + почта + пароль → код ──
  const registerContext = await browser.newContext();
  const registerSession = await openStartPage(registerContext);
  const { page, startScreen } = registerSession;
  await openRegisterForm(page, startScreen);
  const registerScreen = await waitRegisterScreen(page);
  await submitRegisterForm(registerScreen, { nick: aliceNick, email: aliceEmail });

  const codeScreen = await waitCodeScreen(page);
  // В шапке экрана кода — почта, а не адрес аккаунта
  await codeScreen.locator('h1').getByText(aliceEmail).waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  const code = await fetchLatestCode(aliceEmail);

  // Неверный код отклоняется с ошибкой, аккаунт не активируется
  const wrongCode = code === '000000' ? '000001' : '000000';
  await submitCode(codeScreen, wrongCode);
  await codeScreen.getByText('Invalid code', { exact: false })
    .waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });

  // Верный код завершает регистрацию и логинит
  await submitCode(codeScreen, code);
  await page.locator('#LeftColumn').waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  // Аккаунт создан на домене сервера: в профиле — @ник, адрес в localStorage — ник@local
  const savedAddress = await page.evaluate(() => localStorage.getItem('parvane:login-address') || '');
  assert.equal(savedAddress, `${aliceNick}@local`, `адрес аккаунта: ${savedAddress}`);
  console.log('OK: регистрация по нику без @домена с подтверждением почты завершена, клиент залогинен');
  assertNoPageErrors({ alice: registerSession });
  await registerContext.close();

  // ── Подтверждённый аккаунт: обычный вход по нику без экранов email/кода ──
  const reloginContext = await browser.newContext();
  const reloginSession = await preparePage(reloginContext, aliceNick, PASSWORD);
  console.log('OK: повторный вход по нику подтверждённого аккаунта идёт сразу в чат');
  assertNoPageErrors({ alice: reloginSession });
  await reloginContext.close();

  // ── Занятый ник: форма регистрации показывает ошибку ──
  const takenContext = await browser.newContext();
  const takenSession = await openStartPage(takenContext);
  await openRegisterForm(takenSession.page, takenSession.startScreen);
  const takenScreen = await waitRegisterScreen(takenSession.page);
  await submitRegisterForm(takenScreen, { nick: aliceNick, email: `other-${suffix}@example.com` });
  await takenScreen.getByText('already taken', { exact: false })
    .waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  console.log('OK: занятый ник отклонён на форме регистрации');
  assertNoPageErrors({ taken: takenSession });
  await takenContext.close();

  // ── Вход под несуществующим ником → форма регистрации с заполненным ником ──
  const bobNick = `email-b-${suffix}`;
  const bobEmail = `bob-${suffix}@example.com`;
  const abandonContext = await browser.newContext();
  const abandonSession = await openLoginPage(abandonContext, bobNick);
  const bobRegisterScreen = await waitRegisterScreen(abandonSession.page);
  await bobRegisterScreen.getByText('no account with this nickname', { exact: false })
    .waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  assert.equal(await bobRegisterScreen.locator('#sign-up-parvane-nick').inputValue(), bobNick);
  await submitRegisterForm(bobRegisterScreen, { email: bobEmail });
  await waitCodeScreen(abandonSession.page);
  const firstBobCode = await fetchLatestCode(bobEmail);
  console.log('OK: вход под новым ником ведёт на форму регистрации с этим ником');
  await abandonContext.close();

  // ── Незавершённая регистрация: вход перевысылает код и ведёт на экран кода ──
  const resumeContext = await browser.newContext();
  const resumeSession = await openLoginPage(resumeContext, bobNick);
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
