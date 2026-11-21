// Экраны входа по макету (spec 041 E4): одна форма «сервер, ник, пароль», шаг пароля на том же экране,
// ошибки под полями, переход к регистрации и обратно, язык и тема до входа, телефон без горизонтальной
// прокрутки. Режимы `PARVANE_E2E_AUTH_MODE=email|telegram` (сервер с подтверждением) проверяют экран кода и
// экран Telegram. Данные выдуманные. Запуск: scripts/run_web_auth_screens_e2e.sh
import assert from 'node:assert/strict';

import { chromium } from '../web/telegram-tt/node_modules/playwright/index.mjs';

import { shootAuthScreen } from './e2e_web_auth_shots.mjs';
import { LOGIN_TIMEOUT_MS, requireEnv } from './e2e_web_helpers.mjs';

const PASSWORD = 'Parvane-auth-screens-1';
const WRONG_PASSWORD = 'Parvane-auth-screens-0';
const MODE = process.env.PARVANE_E2E_AUTH_MODE || 'base';
const DESKTOP = { viewport: { width: 1120, height: 700 }, locale: 'ru-RU' };
const PHONE = {
  viewport: { width: 360, height: 800 }, locale: 'ru-RU', hasTouch: true, isMobile: true,
};
const STEP_TIMEOUT_MS = 15000;

const { baseUrl, gatewayUrl } = requireEnv();
const browser = await chromium.launch();
const suffix = `${Date.now().toString(36)}${process.pid}`;
// Журнал провайдера всех вкладок — хвост печатается при падении
const logs = [];
const LOG_TAIL = 25;

const screen = (page, id) => page.locator(`.Transition_slide-active > #${id}`);
const visible = (locator, what) => locator.waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS })
  .catch((err) => { throw new Error(`${what}: ${String(err).split('\n')[0]}`); });

async function openStart(options) {
  const context = await browser.newContext(options);
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (err) => errors.push(err.message));
  page.on('console', (message) => logs.push(message.text()));
  await page.addInitScript((url) => {
    localStorage.setItem('parvane:gateway', url);
  }, gatewayUrl);
  await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
  await screen(page, 'auth-phone-number-form').locator('#sign-in-parvane-address')
    .waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  return { context, page, errors };
}

async function expectNoOverflow(page, what) {
  const overflow = await page.evaluate(() => {
    const root = document.querySelector('.Transition_slide-active > [id^="auth-"]');
    return root.scrollWidth - root.clientWidth;
  });
  assert(overflow <= 0, `${what}: содержимое шире экрана на ${overflow}px`);
}

async function openRegistration(page) {
  await screen(page, 'auth-phone-number-form').locator('[data-auth-register]').click();
  const form = screen(page, 'auth-registration-form');
  await visible(form, 'форма регистрации');
  return form;
}

async function runBase() {
  const nick = `vera-${suffix}`;

  // ── Вход одной формой; язык и тема до входа ──
  const first = await openStart(DESKTOP);
  let page = first.page;
  const start = screen(page, 'auth-phone-number-form');
  assert.equal(await start.locator('#sign-in-parvane-server').inputValue(), new URL(baseUrl).host, 'сервер в форме');
  assert.equal(await page.locator('#auth-language').inputValue(), 'ru', 'язык взят из браузера');
  await visible(start.getByLabel('Ник', { exact: true }), 'подпись поля на русском');
  await shootAuthScreen(page, 'login');

  await page.locator('#auth-language').selectOption('en');
  await visible(start.getByLabel('Nickname', { exact: true }), 'подпись поля на английском');
  await page.locator('#auth-language').selectOption('ru');
  await visible(start.getByLabel('Ник', { exact: true }), 'подпись поля снова на русском');
  await page.locator('#auth-theme').selectOption('dark');
  await page.waitForFunction(() => document.documentElement.classList.contains('theme-dark'));
  await page.locator('#auth-theme').selectOption('light');
  await page.waitForFunction(() => document.documentElement.classList.contains('theme-light'));
  await page.locator('#auth-theme').selectOption('auto');
  console.log('OK: язык и тема переключаются на экране входа');

  await start.locator('#sign-in-parvane-address').fill('два слова');
  await start.locator('#sign-in-parvane-address').press('Enter');
  await visible(start.locator('[role="alert"]'), 'ошибка ника под полем');
  assert.equal(await screen(page, 'auth-password-form').count(), 0, 'негодный ник не должен вести к паролю');

  await start.locator('#sign-in-parvane-address').fill(nick);
  await start.locator('#sign-in-password').fill(PASSWORD);
  await page.locator('[data-auth-submit]').click();
  await page.locator('#LeftColumn').waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  console.log('OK: ник и пароль одной формой — вход выполнен');
  assert.deepEqual(first.errors, [], 'ошибки страницы при входе');
  await first.context.close();

  // ── Неверный пароль, шаг пароля, правка ника ──
  const second = await openStart(DESKTOP);
  page = second.page;
  await page.locator('#sign-in-parvane-address').fill(nick);
  await page.locator('#sign-in-password').fill(WRONG_PASSWORD);
  await page.locator('[data-auth-submit]').click();
  const passwordStep = screen(page, 'auth-password-form');
  await visible(passwordStep.locator('[role="alert"]'), 'ошибка пароля под полем');
  assert.equal(await passwordStep.locator('#sign-in-parvane-address').inputValue(), nick, 'ник остался в форме');
  // spec 041: сервер сообщает, сколько попыток осталось до временной блокировки входа (порог 5)
  assert.match(await passwordStep.locator('[role="alert"]').innerText(), /4 (attempts left|попытки)/, 'счётчик попыток');
  assert.equal(await page.locator('#LeftColumn').count(), 0, 'неверный пароль не должен входить');
  await shootAuthScreen(page, 'login-error');

  await passwordStep.locator('#sign-in-parvane-address').fill(`${nick}x`);
  await visible(screen(page, 'auth-phone-number-form'), 'правка ника возвращает шаг ника');
  assert.equal(await page.locator('[role="alert"]').count(), 0, 'ошибка пароля снята правкой ника');

  await page.locator('#sign-in-parvane-address').fill(nick);
  await page.locator('#sign-in-password').fill('');
  await page.locator('#sign-in-parvane-address').press('Enter');
  await visible(passwordStep, 'Enter в поле ника без пароля — шаг пароля');
  await page.waitForFunction(() => document.activeElement?.id === 'sign-in-password');
  await passwordStep.locator('#sign-in-password').fill(PASSWORD);
  await passwordStep.locator('#sign-in-password').press('Enter');
  await page.locator('#LeftColumn').waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  console.log('OK: неверный пароль, правка ника, шаг пароля по Enter');
  await second.context.close();

  // ── Регистрация: шаг, ошибки под полями, возврат ──
  const third = await openStart(DESKTOP);
  page = third.page;
  let form = await openRegistration(page);
  await visible(form.locator('[data-auth-register][aria-pressed="true"]'), 'переключатель на «Новый аккаунт»');
  await form.locator('#sign-up-parvane-nick').fill(`nina-${suffix}`);
  await form.locator('#sign-up-parvane-password').fill('пароль-пример');
  await shootAuthScreen(page, 'register');
  await form.locator('#sign-up-parvane-password').fill('кратко');
  await form.locator('[data-auth-submit]').click();
  await visible(form.locator('[role="alert"]'), 'ошибка короткого пароля');
  await visible(form, 'короткий пароль не отправляет форму');
  await shootAuthScreen(page, 'register-error');
  await form.locator('[data-auth-login]').click();
  await visible(screen(page, 'auth-phone-number-form'), 'возврат ко входу');
  console.log('OK: регистрация на компьютере — переключатель, ошибка под полем, возврат');
  await third.context.close();

  // ── Телефон ──
  const phone = await openStart(PHONE);
  page = phone.page;
  await expectNoOverflow(page, 'вход на телефоне');
  form = await openRegistration(page);
  await expectNoOverflow(page, 'регистрация на телефоне');
  await form.locator('[data-auth-back="bar"]').click();
  await visible(screen(page, 'auth-phone-number-form'), 'стрелка «Назад» регистрации');
  form = await openRegistration(page);
  await form.locator('#sign-up-parvane-nick').fill(`lada-${suffix}`);
  await form.locator('#sign-up-parvane-password').fill(PASSWORD);
  await form.locator('[data-auth-submit]').click();
  await page.locator('#LeftColumn').waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  // Ключ восстановления — последний шаг регистрации, дальше — выбор модулей (доски `XpAuth`, `XpStart`)
  const keyScreen = page.locator('[data-recovery-key-screen]');
  await visible(keyScreen, 'экран ключа восстановления после регистрации');
  // На телефоне шаг — в шапке экрана (`AuthBar`), подпись окна скрыта
  await visible(keyScreen.getByText(/^(step 2 of 2|шаг 2 из 2)$/).filter({ visible: true }).first(), '«шаг N из N» на экране ключа');
  await keyScreen.locator('[data-recovery-key-saved]').check();
  const keyDone = keyScreen.locator('[data-recovery-key-done]');
  // Телефон сценария — на русском (язык браузера)
  assert.match((await keyDone.textContent()).trim(), /^(Next: choose modules|Дальше: выбрать модули)$/, 'кнопка ведёт к выбору модулей');
  await keyDone.click();
  await visible(page.locator('[data-first-run="phone"]'), 'выбор модулей после ключа');
  console.log('OK: телефон — без горизонтальной прокрутки, регистрация входит, ключ ведёт к выбору модулей');
  await phone.context.close();
}

async function runEmail() {
  const { page } = await openStart(DESKTOP);
  const form = await openRegistration(page);
  const email = `olga-${suffix}@example.com`;
  await visible(form.locator('#sign-up-parvane-email'), 'поле почты');
  await form.locator('#sign-up-parvane-nick').fill(`olga-${suffix}`);
  await form.locator('#sign-up-parvane-password').fill(PASSWORD);
  await form.locator('#sign-up-parvane-email').fill(email);
  await shootAuthScreen(page, 'register-email');
  await form.locator('[data-auth-submit]').click();
  const code = screen(page, 'auth-code-form');
  await visible(code.locator('[data-auth-email]').getByText(email), 'почта на экране кода');
  await code.locator('#sign-in-code').pressSequentially('482');
  assert.equal(await code.locator('#sign-in-code').inputValue(), '482');
  await shootAuthScreen(page, 'code');
  await page.setViewportSize(PHONE.viewport);
  await expectNoOverflow(page, 'код на телефоне');
  await page.setViewportSize(DESKTOP.viewport);
  await code.locator('#sign-in-code').pressSequentially('000');
  await visible(code.locator('[role="alert"]'), 'ошибка неверного кода');
  await shootAuthScreen(page, 'code-error');
  await code.locator('[data-auth-back="dialog"]').click();
  await visible(screen(page, 'auth-phone-number-form'), 'возврат с экрана кода');
  console.log('OK: экран кода — клетки, ошибка, возврат');
}

async function runTelegram() {
  const { page } = await openStart(DESKTOP);
  const form = await openRegistration(page);
  await form.locator('#sign-up-parvane-nick').fill(`zoya-${suffix}`);
  await form.locator('#sign-up-parvane-password').fill(PASSWORD);
  await form.locator('[data-auth-submit]').click();
  const telegram = screen(page, 'auth-telegram-form');
  await visible(telegram, 'экран Telegram');
  const href = await telegram.locator('#auth-telegram-link').getAttribute('href');
  assert.match(href || '', /^https:\/\/t\.me\/[^?]+\?start=/, 'ссылка на бота');
  assert.equal(await telegram.locator('[data-telegram-open]').getAttribute('href'), href, 'кнопка «Открыть»');
  assert.equal(await telegram.getAttribute('data-telegram-mode'), 'register');
  // «Показать QR» (spec 041 E4): та же ссылка картинкой
  await telegram.locator('[data-telegram-qr]').click();
  await telegram.locator('[data-telegram-qr] + div svg').first().waitFor({ state: 'visible', timeout: 15000 });
  await telegram.locator('[data-telegram-qr]').click();
  await shootAuthScreen(page, 'telegram');
  await page.setViewportSize(PHONE.viewport);
  await expectNoOverflow(page, 'Telegram на телефоне');
  await page.setViewportSize(DESKTOP.viewport);
  await telegram.locator('[data-telegram-check]').click();
  await visible(telegram, 'без подтверждения экран Telegram остаётся');
  await telegram.locator('[data-auth-back="dialog"]').click();
  await visible(screen(page, 'auth-phone-number-form'), 'возврат с экрана Telegram');
  console.log('OK: экран Telegram — ссылка, проверка, возврат');
}

try {
  if (MODE === 'email') await runEmail();
  else if (MODE === 'telegram') await runTelegram();
  else await runBase();
  console.log(`OK: экраны входа (${MODE})`);
} catch (err) {
  const dir = process.env.PARVANE_E2E_SHOT_DIR;
  const pages = browser.contexts().flatMap((context) => context.pages());
  if (dir) await Promise.all(pages.map((page, n) => page.screenshot({ path: `${dir}/auth-fail-${n}.png` }).catch(() => {})));
  console.error(`--- журнал вкладок ---\n${logs.slice(-LOG_TAIL).join('\n')}`);
  throw err;
} finally {
  await browser.close();
}
