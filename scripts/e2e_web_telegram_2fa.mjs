// Двухфакторный вход через Telegram (по желанию, Settings → Privacy):
// регистрация с подтверждением ботом (tg 1001) → включаем 2FA → выход →
// вход по паролю ведёт на экран «Подтвердите вход» с deep link → чужой
// Telegram (1002) отклонён → привязанный (1001) подтверждает → вход; reload
// на том же устройстве — без Telegram (доверенное устройство); новый браузер
// (другое устройство) — снова подтверждение; выключение 2FA — обычный вход.
import assert from 'node:assert/strict';

import { chromium } from '../web/telegram-tt/node_modules/playwright/index.mjs';

import {
  LOGIN_TIMEOUT_MS, assertNoPageErrors, clickUntil, requireEnv, submitNick,
} from './e2e_web_helpers.mjs';

const PASSWORD = 'Parvane-telegram-2fa-password';
const SECRET = process.env.PARVANE_TELEGRAM_SECRET;
const BOT = process.env.PARVANE_TELEGRAM_BOT;
assert(SECRET && BOT, 'PARVANE_TELEGRAM_BOT/SECRET are required');
const TG_OWNER = 2001;
const TG_STRANGER = 2002;

async function botConfirm(token, telegramId) {
  const { gatewayUrl } = requireEnv();
  const ws = new WebSocket(gatewayUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', () => reject(new Error('gateway ws error')), { once: true });
  });
  const payload = JSON.stringify({
    secret: SECRET, token, telegram_id: telegramId, telegram_name: `tg${telegramId}`,
  });
  const reply = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('gateway reply timeout')), 10000);
    ws.addEventListener('message', (event) => {
      const frame = JSON.parse(String(event.data));
      if (frame.id !== '1') return;
      clearTimeout(timer);
      resolve(frame.op === 'err' ? { ok: false, error: frame.error } : JSON.parse(frame.payload || '{}'));
    });
  });
  ws.send(JSON.stringify({ op: 'req', id: '1', subject: 'identity.telegram.confirm', payload, timeout_ms: 5000 }));
  const result = await reply;
  ws.close();
  return result;
}

async function openStartPage(context) {
  const { baseUrl, gatewayUrl } = requireEnv();
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (err) => errors.push(err.message));
  await page.addInitScript((url) => { localStorage.setItem('parvane:gateway', url); }, gatewayUrl);
  await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
  const startScreen = page.locator('.Transition_slide-active > #auth-phone-number-form');
  await startScreen.getByLabel('Nickname').waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  return { page, errors, startScreen };
}

async function pressAuthButton(page, screen, name, targetScreenId) {
  const deadline = Date.now() + LOGIN_TIMEOUT_MS;
  for (;;) {
    await screen.getByRole('button', { name }).dispatchEvent('mousedown', { button: 0 });
    try {
      await page.locator(`.Transition_slide-active > ${targetScreenId}`).waitFor({ state: 'visible', timeout: 3000 });
      return;
    } catch (err) {
      if (Date.now() > deadline) throw err;
    }
  }
}

async function waitTelegramScreen(page, expectedTitle) {
  const telegramScreen = page.locator('.Transition_slide-active > #auth-telegram-form');
  await telegramScreen.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  if (expectedTitle) {
    await telegramScreen.getByText(expectedTitle, { exact: false }).waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  }
  const link = telegramScreen.locator('#auth-telegram-link');
  await link.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  const href = await link.getAttribute('href');
  const match = /^https:\/\/t\.me\/([^?]+)\?start=([A-Za-z0-9_-]+)$/.exec(href || '');
  assert(match, `deep link: ${href}`);
  return { telegramScreen, token: match[2] };
}

const signedIn = (page) => page.locator('#LeftColumn').waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });

async function loginWithPassword(page, nick) {
  await submitNick(page, nick);
  const passwordScreen = page.locator('.Transition_slide-active > #auth-password-form');
  await passwordScreen.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await passwordScreen.locator('#sign-in-password').fill(PASSWORD);
  await passwordScreen.getByRole('button', { name: 'Next' }).click();
}

async function openPrivacySettings(page) {
  await page.getByRole('button', { name: 'Open menu' }).first().click();
  await page.getByRole('menuitem', { name: 'Settings' }).click();
  await page.getByRole('button', { name: /Privacy and Security/ }).click();
  const toggle = page.getByLabel('Confirm sign-in in Telegram');
  await toggle.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  return toggle;
}

async function setTwoFactor(page, enabled) {
  const toggle = await openPrivacySettings(page);
  // состояние подтягивается с сервера — ждём, пока чекбокс станет активным
  await page.waitForFunction((el) => el && !el.disabled, await toggle.elementHandle(), { timeout: LOGIN_TIMEOUT_MS });
  if ((await toggle.isChecked()) !== enabled) {
    await toggle.click({ force: true });
    await page.waitForFunction(
      ([el, want]) => el && el.checked === want, [await toggle.elementHandle(), enabled], { timeout: LOGIN_TIMEOUT_MS },
    );
  }
  await page.waitForTimeout(1000);
}

async function logOut(page) {
  // Из экрана Privacy — назад в корень настроек, где меню с «Log Out»
  await page.getByRole('button', { name: /Go back|Return to Chat List/ }).first().click();
  await page.getByRole('button', { name: 'More actions' }).first().waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await page.getByRole('button', { name: 'More actions' }).first().click();
  await page.getByRole('menuitem', { name: 'Log Out' }).click();
  await clickUntil(
    page.getByRole('button', { name: 'Log Out' }).last(),
    () => page.locator('.Transition_slide-active > #auth-phone-number-form').waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS }),
    { settleMs: 15000 },
  );
}

const browser = await chromium.launch();
try {
  const suffix = `${Date.now()}-${process.pid}`;
  const nick = `tfa-${suffix}`;

  // ── Регистрация + привязка Telegram (владелец 2001) ──
  const ctx1 = await browser.newContext();
  const s1 = await openStartPage(ctx1);
  await pressAuthButton(s1.page, s1.startScreen, 'Create account', '#auth-registration-form');
  const registerScreen = s1.page.locator('.Transition_slide-active > #auth-registration-form');
  await registerScreen.locator('#sign-up-parvane-nick').fill(nick);
  await registerScreen.locator('#sign-up-parvane-password').fill(PASSWORD);
  await registerScreen.getByRole('button', { name: 'Create account' }).click();
  const { token: regToken } = await waitTelegramScreen(s1.page, 'Confirm via Telegram');
  assert.equal((await botConfirm(regToken, TG_OWNER)).ok, true);
  await signedIn(s1.page);

  // ── Включаем 2FA в Settings → Privacy ──
  await setTwoFactor(s1.page, true);
  console.log('OK: двухфакторный вход включён в настройках');

  // ── Выход и вход по паролю → экран подтверждения входа ──
  await logOut(s1.page);
  await loginWithPassword(s1.page, nick);
  const { telegramScreen, token: loginToken } = await waitTelegramScreen(s1.page, 'Confirm sign-in');
  assert.notEqual(loginToken, regToken);
  assert.equal(await s1.page.locator('#LeftColumn').count(), 0, 'без подтверждения входа быть не должно');
  const stranger = await botConfirm(loginToken, TG_STRANGER);
  assert.equal(stranger.ok, false, 'чужой Telegram не должен подтверждать вход');
  assert.match(stranger.error || '', /привязан/);
  await telegramScreen.getByRole('button', { name: 'I pressed Start' }).click();
  await telegramScreen.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  const owner = await botConfirm(loginToken, TG_OWNER);
  assert.equal(owner.ok, true, `подтверждение владельцем: ${JSON.stringify(owner)}`);
  assert.equal(owner.kind, 'login');
  await signedIn(s1.page);
  console.log('OK: вход подтверждён только привязанным Telegram');

  // ── То же устройство: reload без Telegram (доверенное) ──
  await s1.page.waitForTimeout(1500);
  await s1.page.reload({ waitUntil: 'domcontentloaded' });
  await signedIn(s1.page);
  assert.equal(await s1.page.locator('#auth-telegram-form').count(), 0);
  console.log('OK: доверенное устройство входит без повторного подтверждения');

  // ── Новое устройство (другой контекст): снова подтверждение ──
  const ctx2 = await browser.newContext();
  const s2 = await openStartPage(ctx2);
  await loginWithPassword(s2.page, nick);
  const { token: loginToken2 } = await waitTelegramScreen(s2.page, 'Confirm sign-in');
  assert.equal((await botConfirm(loginToken2, TG_OWNER)).ok, true);
  await signedIn(s2.page);
  console.log('OK: новое устройство подтверждает вход заново');

  // ── Выключаем 2FA — вход без Telegram на третьем устройстве ──
  await setTwoFactor(s2.page, false);
  const ctx3 = await browser.newContext();
  const s3 = await openStartPage(ctx3);
  await loginWithPassword(s3.page, nick);
  await signedIn(s3.page);
  assert.equal(await s3.page.locator('#auth-telegram-form').count(), 0);
  console.log('OK: после выключения 2FA обычный вход');

  assertNoPageErrors({ one: s1, two: s2, three: s3 });
  console.log('OK: двухфакторный вход через Telegram');
} catch (error) {
  const shotDir = process.env.PARVANE_E2E_SHOT_DIR;
  if (shotDir) {
    await Promise.all(browser.contexts().map((c, i) => c.pages()[0]?.screenshot({ path: `${shotDir}/tfa-${i}.png` }).catch(() => {})));
  }
  throw error;
} finally {
  await browser.close();
}
