// Проверка release-APK Android на ПРОДЕ (spec 031, T077): свежий web-пользователь (регистрация с подтверждением
// «ботом», как e2e_web_prod_v2_smoke.mjs) пишет аккаунту Android и ждёт его ответа. Android отвечает вручную или
// сценарием через интерфейс (в release нет dev-хуков). Данные — выдуманные.
//
//   PARVANE_E2E_BASE_URL=https://host:20443 PARVANE_E2E_GATEWAY_URL=wss://host:20443/ws PARVANE_TELEGRAM_BOT=<bot> \
//   PARVANE_TELEGRAM_SECRET=<секрет> PV_PEER=<ник@сервер> PV_HELLO=<текст> PV_REPLY=<текст ответа> \
//   node scripts/e2e_web_prod_android_pair.mjs
// Печатает «READY <адрес web>» после отправки; «OK» — ответ Android пришёл.
import assert from 'node:assert/strict';

import { chromium } from '../web/telegram-tt/node_modules/playwright/index.mjs';

import { botConfirmV2 } from './e2e_tg_confirm_v2.mjs';
import {
  autoDismissRecoveryKeyDialog,
  findMessage,
  LOGIN_TIMEOUT_MS,
  openPrivateChatStrict,
  requireEnv,
  sendText,
} from './e2e_web_helpers.mjs';

const PASSWORD = 'Parvane-prod-android-1';
const SECRET = process.env.PARVANE_TELEGRAM_SECRET;
const BOT = process.env.PARVANE_TELEGRAM_BOT;
const PEER = process.env.PV_PEER;
const HELLO = process.env.PV_HELLO;
const REPLY = process.env.PV_REPLY;
const REPLY_TIMEOUT_MS = Number(process.env.PV_REPLY_TIMEOUT_MS) || 600000;
assert(SECRET && BOT && PEER && HELLO && REPLY, 'PARVANE_TELEGRAM_BOT/SECRET, PV_PEER, PV_HELLO, PV_REPLY are required');

const browser = await chromium.launch();
try {
  const { baseUrl, gatewayUrl } = requireEnv();
  const context = await browser.newContext();
  const page = await context.newPage();
  await autoDismissRecoveryKeyDialog(page);
  const logs = [];
  page.on('console', (message) => {
    if (message.text().includes('[parvane]')) logs.push(message.text().slice(0, 300));
  });
  await page.addInitScript((url) => {
    localStorage.setItem('parvane:gateway', url);
  }, gatewayUrl);
  await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
  const startScreen = page.locator('.Transition_slide-active > #auth-phone-number-form');
  await startScreen.getByLabel('Nickname').waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  const deadline = Date.now() + LOGIN_TIMEOUT_MS;
  for (;;) {
    await startScreen.getByRole('button', { name: 'Create account' }).dispatchEvent('mousedown', { button: 0 });
    const isShown = await page.locator('.Transition_slide-active > #auth-registration-form')
      .waitFor({ state: 'visible', timeout: 3000 }).then(() => true, () => false);
    if (isShown) break;
    assert(Date.now() < deadline, 'форма регистрации не открылась');
  }
  const form = page.locator('.Transition_slide-active > #auth-registration-form');
  await form.locator('#sign-up-parvane-nick').fill(`smoke-w-${Date.now().toString(36)}`);
  await form.locator('#sign-up-parvane-password').fill(PASSWORD);
  await form.getByRole('button', { name: 'Create account' }).click();
  const link = page.locator('.Transition_slide-active > #auth-telegram-form #auth-telegram-link');
  await link.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  const match = /^https:\/\/t\.me\/([^?]+)\?start=([A-Za-z0-9_-]+)$/.exec((await link.getAttribute('href')) || '');
  assert(match, 'ссылка на бота');
  // Telegram-id из диапазона, которого у настоящих пользователей нет
  const telegramId = 9_000_000_000_000 + (Date.now() % 1_000_000_000) * 10 + 7;
  const confirm = await botConfirmV2(gatewayUrl, SECRET, match[2], telegramId, `tg${telegramId}`);
  assert.equal(confirm.ok, true, `подтверждение регистрации: ${JSON.stringify(confirm)}`);
  await page.locator('#LeftColumn').waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  const readyDeadline = Date.now() + 90000;
  while (!logs.some((line) => line.includes('v2: готов'))) {
    assert(Date.now() < readyDeadline, 'web: v2 не поднялся');
    await page.waitForTimeout(300);
  }
  await openPrivateChatStrict(page, PEER);
  await sendText(page, HELLO);
  console.log(`READY ${confirm.user}`);
  await findMessage(page, REPLY).first().waitFor({ state: 'visible', timeout: REPLY_TIMEOUT_MS });
  console.log('OK: ответ Android пришёл в web');
} finally {
  await browser.close();
}
