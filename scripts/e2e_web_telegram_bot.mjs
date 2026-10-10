// Настоящий Telegram-бот Parvane (backend/infra/telegram-bot/parvane_tg_bot.py)
// против поддельного Bot API (spec 015). Сценарий поднимает HTTP-сервер вместо
// api.telegram.org, запускает бота и играет роль ВЛАДЕЛЬЦА в Telegram:
//  1. регистрация: /start <token> → бот спрашивает кнопками → «Подтвердить» →
//     клиент входит сам;
//  2. бот присылает в чат ключ восстановления — тот же, что в диалоге клиента;
//  3. вход с нового устройства (первое закрыто): бот просит ответить ключом
//     (force_reply); на неверный ключ отвечает «не подошёл», на верный — «принят»,
//     и новое устройство подключается;
//  4. посторонний текст без запроса — обычная справка;
//  5. ключа восстановления нет в журнале бота.
// Запуск: scripts/run_web_telegram_bot_e2e.sh
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium } from '../web/telegram-tt/node_modules/playwright/index.mjs';

import {
  LOGIN_TIMEOUT_MS, assertNoPageErrors, dismissRecoveryKeyDialog, openDevicesScreen, requireEnv, submitNick,
} from './e2e_web_helpers.mjs';

const PASSWORD = 'Parvane-telegram-bot-e2e-1';
const SECRET = process.env.PARVANE_TELEGRAM_SECRET;
assert(SECRET, 'PARVANE_TELEGRAM_SECRET is required');
const PYTHON = process.env.PARVANE_E2E_BOT_PYTHON;
assert(PYTHON && existsSync(PYTHON), `python с websockets не найден: ${PYTHON} (см. run_web_telegram_bot_e2e.sh)`);
const BOT_SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '../backend/infra/telegram-bot/parvane_tg_bot.py');
const BOT_TOKEN = 'e2e-bot-token';
const TG_ALICE = 6001;
const STEP_TIMEOUT_MS = 30000;
const JOIN_TIMEOUT_MS = 90000;
const KEY_PATTERN = /([0-9A-Z]{4}(?:-[0-9A-Z]{4}){9})/;

const { baseUrl, gatewayUrl } = requireEnv();

// ── Поддельный Bot API ──────────────────────────────────────────────────────
const sent = []; // sendMessage / editMessageText бота
const updates = [];
let nextUpdateId = 1;
let nextMessageId = 100;

function readForm(request) {
  return new Promise((resolve) => {
    let raw = '';
    request.on('data', (chunk) => { raw += chunk; });
    request.on('end', () => resolve(Object.fromEntries(new URLSearchParams(raw))));
  });
}

const api = createServer(async (request, response) => {
  const method = request.url.split('/').pop();
  const params = await readForm(request);
  const reply = (result) => {
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ ok: true, result }));
  };
  if (!request.url.startsWith(`/bot${BOT_TOKEN}/`)) {
    response.statusCode = 404;
    response.end('{"ok":false}');
    return;
  }
  if (method === 'getMe') return reply({ id: 1, username: 'parvane_e2e_bot' });
  if (method === 'getUpdates') {
    const offset = Number(params.offset || 0);
    const deadline = Date.now() + 1500;
    for (;;) {
      const ready = updates.filter((update) => update.update_id >= offset);
      if (ready.length || Date.now() > deadline) return reply(ready);
      await new Promise((resolve) => { setTimeout(resolve, 100); });
    }
  }
  if (method === 'sendMessage' || method === 'editMessageText') {
    const message = {
      method, chatId: Number(params.chat_id), text: params.text || '', parseMode: params.parse_mode,
      replyMarkup: params.reply_markup ? JSON.parse(params.reply_markup) : undefined,
      messageId: method === 'sendMessage' ? nextMessageId++ : Number(params.message_id),
    };
    sent.push(message);
    return reply({ message_id: message.messageId });
  }
  return reply(true);
});
await new Promise((resolve) => { api.listen(0, '127.0.0.1', resolve); });
const apiBase = `http://127.0.0.1:${api.address().port}`;

const owner = (telegramId) => ({ id: telegramId, username: `tg${telegramId}`, first_name: 'E2E' });

function ownerWrites(telegramId, text) {
  updates.push({
    update_id: nextUpdateId++,
    message: { message_id: nextMessageId++, chat: { id: telegramId, type: 'private' }, from: owner(telegramId), text },
  });
}

function ownerPresses(telegramId, botMessage, data) {
  updates.push({
    update_id: nextUpdateId++,
    callback_query: {
      id: `cq${nextUpdateId}`, from: owner(telegramId), data,
      message: { message_id: botMessage.messageId, chat: { id: telegramId, type: 'private' } },
    },
  });
}

/** Дождаться сообщения бота, появившегося после отметки `from`. */
async function botSays(telegramId, predicate, from = 0, timeout = STEP_TIMEOUT_MS) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const found = sent.slice(from).find((message) => message.chatId === telegramId && predicate(message));
    if (found) return found;
    assert(
      Date.now() < deadline,
      `бот не прислал ожидаемое сообщение; его сообщения: ${JSON.stringify(sent.slice(from).map((m) => m.text.slice(0, 80)))}`,
    );
    await new Promise((resolve) => { setTimeout(resolve, 200); });
  }
}

// ── Бот ─────────────────────────────────────────────────────────────────────
let botLog = '';
const bot = spawn(PYTHON, [BOT_SCRIPT], {
  env: {
    ...process.env,
    PARVANE_TG_BOT_TOKEN: BOT_TOKEN,
    PARVANE_TELEGRAM_SECRET: SECRET,
    PARVANE_GATEWAY_URL: gatewayUrl,
    PARVANE_TG_API_BASE: apiBase,
    PYTHONUNBUFFERED: '1',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
bot.stdout.on('data', (chunk) => { botLog += chunk; });
bot.stderr.on('data', (chunk) => { botLog += chunk; });

async function openStartPage(context) {
  const page = await context.newPage();
  const errors = [];
  const logs = [];
  page.on('pageerror', (err) => errors.push(err.message));
  page.on('console', (message) => {
    if (message.text().includes('[parvane]')) logs.push(message.text().slice(0, 300));
  });
  await page.addInitScript((url) => {
    localStorage.setItem('parvane:gateway', url);
  }, gatewayUrl);
  await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
  const startScreen = page.locator('.Transition_slide-active > #auth-phone-number-form');
  await startScreen.getByLabel('Nickname').waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  return { page, errors, logs, startScreen };
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

const browser = await chromium.launch();

try {
  await new Promise((resolve) => { setTimeout(resolve, 1500); });
  assert.equal(bot.exitCode, null, `бот не запустился:\n${botLog}`);
  const nick = `bot-a-${Date.now().toString(36)}${process.pid}`;
  const address = `${nick}@local`;

  // ── 1. Регистрация: /start → кнопки → «Подтвердить» ──
  const context1 = await browser.newContext();
  const first = await openStartPage(context1);
  await pressAuthButton(first.page, first.startScreen, 'Create account', '#auth-registration-form');
  const form = first.page.locator('.Transition_slide-active > #auth-registration-form');
  await form.locator('#sign-up-parvane-nick').fill(nick);
  await form.locator('#sign-up-parvane-password').fill(PASSWORD);
  await form.getByRole('button', { name: 'Create account' }).click();
  const link = first.page.locator('.Transition_slide-active > #auth-telegram-form #auth-telegram-link');
  await link.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  const token = /start=([A-Za-z0-9_-]+)$/.exec(await link.getAttribute('href'))[1];
  ownerWrites(TG_ALICE, `/start ${token}`);
  const question = await botSays(TG_ALICE, (m) => Boolean(m.replyMarkup?.inline_keyboard));
  // До нажатия кнопки аккаунт не подтверждён (P-15)
  assert.equal(await first.page.locator('#LeftColumn').count(), 0);
  const confirmData = question.replyMarkup.inline_keyboard[0][0].callback_data;
  assert.match(confirmData, /^c:/);
  ownerPresses(TG_ALICE, question, confirmData);
  await first.page.locator('#LeftColumn').waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await botSays(TG_ALICE, (m) => m.method === 'editMessageText' && m.text.includes(`@${nick}`));
  console.log('OK: бот подтвердил регистрацию по кнопке, клиент вошёл сам');

  // ── 2. Ключ восстановления — в чат владельца ──
  const keyMessage = await botSays(TG_ALICE, (m) => m.method === 'sendMessage' && m.text.includes('<code>'));
  assert.equal(keyMessage.parseMode, 'HTML');
  const key = KEY_PATTERN.exec(/<code>([^<]+)<\/code>/.exec(keyMessage.text)[1])?.[1];
  assert(key, `в сообщении бота нет ключа: ${keyMessage.text}`);
  assert(keyMessage.text.includes(`@${nick}`), 'в сообщении назван аккаунт');
  // Окна с ключом в приложении нет: ключ хранится в чате с ботом
  assert.equal(await dismissRecoveryKeyDialog(first.page, 2500), undefined, 'окно с ключом показано');
  console.log('OK: бот прислал владельцу ключ восстановления, окна с ключом в приложении нет');

  // Копия ключей аккаунта должна успеть уйти на сервер
  const hasBundle = () => first.logs.some((line) => line.includes('копия ключей аккаунта обновлена на сервере'));
  const bundleDeadline = Date.now() + 60000;
  while (!hasBundle()) {
    assert(Date.now() < bundleDeadline, 'копия ключей аккаунта не ушла на сервер');
    await first.page.waitForTimeout(500);
  }

  // ── 4. Текст без запроса — справка ──
  let mark = sent.length;
  ownerWrites(TG_ALICE, 'привет');
  await botSays(TG_ALICE, (m) => m.text.includes('Create account'), mark);

  // ── 3. Новое устройство: бот просит ключ, владелец отвечает ──
  await first.page.close();
  mark = sent.length;
  const context2 = await browser.newContext();
  const second = await openStartPage(context2);
  await submitNick(second.page, nick);
  const passwordScreen = second.page.locator('.Transition_slide-active > #auth-password-form');
  await passwordScreen.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await passwordScreen.locator('#sign-in-password').fill(PASSWORD);
  await passwordScreen.getByRole('button', { name: 'Next' }).click();
  await second.page.locator('#LeftColumn').waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  const devices = await openDevicesScreen(second.page);
  await devices.locator('[data-telegram-recovery="waiting"]').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  const ask = await botSays(TG_ALICE, (m) => m.replyMarkup?.force_reply === true, mark);
  assert(ask.text.includes(`@${nick}`), 'в просьбе назван аккаунт');
  assert(!ask.text.includes(key), 'в просьбе ключа нет');

  mark = sent.length;
  ownerWrites(TG_ALICE, key.replace('0', '1').replace('2', '3').replace('A', 'B'));
  await botSays(TG_ALICE, (m) => m.text.includes('не подошёл'), mark);
  assert.equal(await devices.locator('[data-telegram-recovery="waiting"]').count(), 1);

  mark = sent.length;
  ownerWrites(TG_ALICE, key);
  await botSays(TG_ALICE, (m) => m.text.includes('Ключ принят'), mark);
  await devices.locator('[data-telegram-recovery="done"]').waitFor({ state: 'visible', timeout: JOIN_TIMEOUT_MS });
  const readyDeadline = Date.now() + JOIN_TIMEOUT_MS;
  while (!second.logs.some((line) => line.includes('[parvane] v2: готов'))) {
    assert(Date.now() < readyDeadline, 'новое устройство не поднялось');
    await second.page.waitForTimeout(300);
  }
  console.log('OK: бот попросил ключ, отклонил неверный, принял верный — новое устройство подключено');

  // ── 5. Ключа нет в журнале бота ──
  assert(!botLog.includes(key), 'ключ восстановления попал в журнал бота');
  assert(!/Traceback|ERROR/.test(botLog), `ошибки в журнале бота:\n${botLog}`);
  console.log('OK: в журнале бота нет ключа и ошибок');

  assertNoPageErrors({ second: { ...second, address } });
} catch (err) {
  console.error(`--- журнал бота ---\n${botLog}`);
  throw err;
} finally {
  bot.kill();
  await browser.close();
  api.close();
}
