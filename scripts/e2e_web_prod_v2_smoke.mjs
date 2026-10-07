// Дым против РАЗВЁРНУТОГО сервера с протоколом v2 и подтверждением регистрации через
// Telegram-бота (прод). Свой стек не поднимает. Роль бота играет сценарий: шлёт
// identity.telegram.confirm в gateway с общим секретом сервера (как настоящий бот).
// Заводит двух свежих пользователей (уникальный суффикс) и проверяет по v2: вход,
// текст в обе стороны, правку, реакцию, группу с сообщениями, ссылку-приглашение,
// историю после перезагрузки вкладки, описатель сервера /.well-known/parvane.
//
//   PARVANE_E2E_BASE_URL=https://host:20443 PARVANE_E2E_GATEWAY_URL=wss://host:20443/ws \
//   PARVANE_TELEGRAM_BOT=<bot> PARVANE_TELEGRAM_SECRET=<секрет> node scripts/e2e_web_prod_v2_smoke.mjs
import assert from 'node:assert/strict';

import { chromium } from '../web/telegram-tt/node_modules/playwright/index.mjs';

import {
  addReaction,
  autoDismissRecoveryKeyDialog,
  createGroupViaUi,
  editText,
  findMessage,
  LOGIN_TIMEOUT_MS,
  openGroupChatByTitle,
  openPrivateChatStrict,
  readInvitesScreen,
  relogin,
  requireEnv,
  sendText,
} from './e2e_web_helpers.mjs';
import { botConfirmV2 } from './e2e_tg_confirm_v2.mjs';

const PASSWORD = 'Parvane-prod-smoke-1';
const SECRET = process.env.PARVANE_TELEGRAM_SECRET;
const BOT = process.env.PARVANE_TELEGRAM_BOT;
assert(SECRET && BOT, 'PARVANE_TELEGRAM_BOT/SECRET are required');
const V2_START_TIMEOUT_MS = 90000;
const EPOCH_TIMEOUT_MS = 60000;

// «Бот»: один запрос подтверждения через gateway по протоколу v2
// (`identity.account.confirm_telegram`, канал PRE) — как настоящий бот на VPS
async function botConfirm(token, telegramId) {
  const { gatewayUrl } = requireEnv();
  return botConfirmV2(gatewayUrl, SECRET, token, telegramId, `tg${telegramId}`);
}

// Регистрация через форму и подтверждение «ботом»; возвращает сессию с журналом провайдера
async function register(context, nick, telegramId) {
  const { baseUrl, gatewayUrl } = requireEnv();
  const page = await context.newPage();
  await autoDismissRecoveryKeyDialog(page);
  const errors = [];
  const logs = [];
  page.on('pageerror', (err) => errors.push(err.message));
  page.on('console', (message) => {
    const text = message.text();
    if (text.includes('[parvane]')) logs.push(text.slice(0, 300));
  });
  await page.addInitScript((url) => {
    localStorage.setItem('parvane:gateway', url);
  }, gatewayUrl);
  await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
  const startScreen = page.locator('.Transition_slide-active > #auth-phone-number-form');
  await startScreen.getByLabel('Nickname').waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  // Кнопка — событием mousedown: стартовая маска в headless-вкладке перехватывает указатель
  const deadline = Date.now() + LOGIN_TIMEOUT_MS;
  for (;;) {
    await startScreen.getByRole('button', { name: 'Create account' }).dispatchEvent('mousedown', { button: 0 });
    const isShown = await page.locator('.Transition_slide-active > #auth-registration-form')
      .waitFor({ state: 'visible', timeout: 3000 }).then(() => true, () => false);
    if (isShown) break;
    assert(Date.now() < deadline, 'форма регистрации не открылась');
  }
  const form = page.locator('.Transition_slide-active > #auth-registration-form');
  await form.locator('#sign-up-parvane-nick').fill(nick);
  await form.locator('#sign-up-parvane-password').fill(PASSWORD);
  await form.getByRole('button', { name: 'Create account' }).click();
  const link = page.locator('.Transition_slide-active > #auth-telegram-form #auth-telegram-link');
  await link.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  const href = await link.getAttribute('href');
  const match = /^https:\/\/t\.me\/([^?]+)\?start=([A-Za-z0-9_-]+)$/.exec(href || '');
  assert(match, `ссылка на бота: ${href}`);
  assert.equal(match[1], BOT, 'сервер назвал другого бота');
  const confirm = await botConfirm(match[2], telegramId);
  assert.equal(confirm.ok, true, `подтверждение регистрации: ${JSON.stringify(confirm)}`);
  await page.locator('#LeftColumn').waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  return { page, errors, logs, address: confirm.user };
}

async function waitLog(session, needle, timeout) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (session.logs.some((line) => line.includes(needle))) return;
    await session.page.waitForTimeout(300);
  }
  assert.fail(`в журнале нет «${needle}»; хвост:\n${session.logs.slice(-20).join('\n')}`);
}

const browser = await chromium.launch();
const sessions = {};

try {
  const { baseUrl } = requireEnv();
  // ── Описатель сервера v2 ────────────────────────────────────────────────────
  const wellKnown = await fetch(`${baseUrl}/.well-known/parvane`);
  assert.equal(wellKnown.status, 200, `/.well-known/parvane: ${wellKnown.status}`);
  const descriptor = await wellKnown.json();
  console.log(`OK: описатель сервера отдан (${Object.keys(descriptor).join(', ')})`);

  const suffix = `${Date.now().toString(36)}`;
  // Telegram-id для дыма — из диапазона, которого у настоящих пользователей нет
  const tgBase = 9_000_000_000_000 + (Date.now() % 1_000_000_000) * 10;
  sessions.alice = await register(await browser.newContext(), `smoke-a-${suffix}`, tgBase + 1);
  sessions.bob = await register(await browser.newContext(), `smoke-b-${suffix}`, tgBase + 2);
  const { alice, bob } = sessions;
  console.log(`OK: регистрация через Telegram-подтверждение (${alice.address}, ${bob.address})`);
  await waitLog(alice, 'v2: готов', V2_START_TIMEOUT_MS);
  await waitLog(bob, 'v2: готов', V2_START_TIMEOUT_MS);
  console.log('OK: у обоих поднят протокол v2');

  // ── Личный чат по v2: текст в обе стороны, правка, реакция ──────────────────
  const hello = `prod-hello-${suffix}`;
  const reply = `prod-reply-${suffix}`;
  await openPrivateChatStrict(alice.page, bob.address);
  await sendText(alice.page, hello);
  await openPrivateChatStrict(bob.page, alice.address);
  await findMessage(bob.page, hello).first().waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await sendText(bob.page, reply);
  await findMessage(alice.page, reply).first().waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  const edited = `prod-edited-${suffix}`;
  await editText(alice.page, hello, edited);
  await findMessage(bob.page, edited).first().waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await addReaction(bob.page, edited, '👍');
  await alice.page.locator('.Transition_slide-active > .MessageList .Message').filter({ hasText: edited })
    .locator('.Reactions').first().waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  assert.ok(!alice.logs.some((line) => /иду по v1|понижен/.test(line)), 'alice: переписка ушла по v1');
  console.log('OK: личный чат — текст в обе стороны, правка, реакция');

  // ── Группа v2: создание, сообщения, ссылка-приглашение ─────────────────────
  const groupTitle = `Smoke ${suffix}`;
  await createGroupViaUi(alice.page, groupTitle, [bob.address.split('@')[0]]);
  await waitLog(alice, 'v2: группа создана', EPOCH_TIMEOUT_MS);
  await openGroupChatByTitle(alice.page, groupTitle);
  const groupHello = `prod-group-${suffix}`;
  await sendText(alice.page, groupHello);
  await openGroupChatByTitle(bob.page, groupTitle);
  await findMessage(bob.page, groupHello).first().waitFor({ state: 'visible', timeout: EPOCH_TIMEOUT_MS });
  const groupReply = `prod-group-reply-${suffix}`;
  await sendText(bob.page, groupReply);
  await findMessage(alice.page, groupReply).first().waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  // Через экран «Invite Links»: диагностических хуков в прод-сборке нет
  const inviteLink = await readInvitesScreen(alice.page, groupTitle);
  assert.match(inviteLink, /\/join\/[A-Za-z0-9_-]{43}#[A-Za-z0-9_-]{43}$/, `ссылка-приглашение не v2: ${inviteLink}`);
  console.log('OK: группа v2 — сообщения в обе стороны, ссылка-приглашение');

  // ── История после перезагрузки вкладки ─────────────────────────────────────
  await relogin(alice.page, PASSWORD);
  await openPrivateChatStrict(alice.page, bob.address);
  await findMessage(alice.page, edited).first().waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await findMessage(alice.page, reply).first().waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await openGroupChatByTitle(alice.page, groupTitle);
  await findMessage(alice.page, groupReply).first().waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  console.log('OK: после перезагрузки история личного чата и группы на месте');

  for (const [name, session] of Object.entries(sessions)) {
    assert.deepEqual(session.errors, [], `${name} page errors: ${session.errors.join('; ')}`);
  }
  console.log('OK: дым прода по v2 пройден');
} catch (err) {
  for (const [name, session] of Object.entries(sessions)) {
    await session.page.screenshot({ path: `web/telegram-tt/test-results/prod-smoke-${name}.png` }).catch(() => {});
    console.error(`--- журнал ${name} ---\n${session.logs.slice(-30).join('\n')}`);
  }
  throw err;
} finally {
  await browser.close();
}
