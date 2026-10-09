// Звонки против РАЗВЁРНУТОГО сервера (прод): два свежих аккаунта (подтверждение — роль бота,
// как в e2e_web_prod_v2_smoke.mjs), аудио- и видеозвонок с поддельными камерой и микрофоном.
//   PARVANE_E2E_BASE_URL=… PARVANE_E2E_GATEWAY_URL=… PARVANE_TELEGRAM_BOT=… PARVANE_TELEGRAM_SECRET=… \
//   node scripts/e2e_web_prod_v2_calls.mjs
import assert from 'node:assert/strict';

import { chromium } from '../web/telegram-tt/node_modules/playwright/index.mjs';

import {
  autoDismissRecoveryKeyDialog,
  callMediaStats,
  expectMediaFlowing,
  findMessage,
  LOGIN_TIMEOUT_MS,
  openPrivateChatStrict,
  requireEnv,
  sendText,
} from './e2e_web_helpers.mjs';
import { botConfirmV2 } from './e2e_tg_confirm_v2.mjs';

const PASSWORD = 'Parvane-prod-smoke-1';
const SECRET = process.env.PARVANE_TELEGRAM_SECRET;
const BOT = process.env.PARVANE_TELEGRAM_BOT;
assert(SECRET && BOT, 'PARVANE_TELEGRAM_BOT/SECRET are required');
const V2_START_TIMEOUT_MS = 90000;

// «Бот»: один запрос подтверждения через gateway по протоколу v2
// (`identity.account.confirm_telegram`, канал PRE) — как настоящий бот на VPS
async function botConfirm(token, telegramId) {
  const { gatewayUrl } = requireEnv();
  return botConfirmV2(gatewayUrl, SECRET, token, telegramId, `tg${telegramId}`);
}

// Регистрация через форму и подтверждение «ботом»; возвращает сессию с журналом провайдера
async function register(context, nick, telegramId) {
  const { baseUrl, gatewayUrl } = requireEnv();
  // Прод-сборка не ведёт список соединений WebRTC для сценариев — ведём его сами
  // PARVANE_E2E_FORCE_RELAY=1 — медиа только через TURN: так звонят из разных сетей за NAT
  await context.addInitScript((isRelayOnly) => {
    const Original = window.RTCPeerConnection;
    if (!Original || window.__parvaneE2ePeers) return;
    window.__parvaneE2ePeers = [];
    window.RTCPeerConnection = function PeerConnection(config, ...rest) {
      const pc = new Original(isRelayOnly ? { ...config, iceTransportPolicy: 'relay' } : config, ...rest);
      window.__parvaneE2ePeers.push(pc);
      return pc;
    };
    window.RTCPeerConnection.prototype = Original.prototype;
    Object.assign(window.RTCPeerConnection, { generateCertificate: Original.generateCertificate });
  }, process.env.PARVANE_E2E_FORCE_RELAY === '1');
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

const browser = await chromium.launch({
  args: [
    '--use-fake-ui-for-media-stream',
    '--use-fake-device-for-media-stream',
    '--autoplay-policy=no-user-gesture-required',
  ],
});
const sessions = {};
const CALL_TIMEOUT_MS = 45000;

async function dump(label) {
  for (const [name, session] of Object.entries(sessions)) {
    const tail = session.logs.filter((line) => !line.includes('метод не реализован')).slice(-45);
    console.error(`--- ${label}: журнал ${name} ---\n${tail.join('\n')}`);
    console.error(`--- ${label}: экран ${name} ---\n${(await session.page.locator('body').innerText().catch(() => '')).slice(0, 600)}`);
    await session.page.screenshot({ path: `local-workdirs/spec015-review/prod-call-${label}-${name}.png` }).catch(() => undefined);
  }
}

try {
  const suffix = `${Date.now().toString(36)}`;
  const tgBase = 9_000_000_000_000 + (Date.now() % 1_000_000_000) * 10;
  const media = { permissions: ['microphone', 'camera'] };
  sessions.alice = await register(await browser.newContext(media), `smoke-a-${suffix}`, tgBase + 1);
  sessions.bob = await register(await browser.newContext(media), `smoke-b-${suffix}`, tgBase + 2);
  const { alice, bob } = sessions;
  await waitLog(alice, 'v2: готов', V2_START_TIMEOUT_MS);
  await waitLog(bob, 'v2: готов', V2_START_TIMEOUT_MS);
  await openPrivateChatStrict(alice.page, bob.address);
  await sendText(alice.page, `call-hi-${suffix}`);
  await openPrivateChatStrict(bob.page, alice.address);
  await findMessage(bob.page, `call-hi-${suffix}`).first().waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await sendText(bob.page, `call-hello-${suffix}`);
  await findMessage(alice.page, `call-hello-${suffix}`).first().waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  console.log('OK: аккаунты заведены, переписка в обе стороны');

  // ── Аудиозвонок ──
  await alice.page.getByRole('button', { name: 'Call', exact: true }).click();
  await alice.page.getByText('ringing...', { exact: true }).waitFor({ state: 'visible', timeout: CALL_TIMEOUT_MS });
  await bob.page.getByText('is calling you...', { exact: true }).waitFor({ state: 'visible', timeout: CALL_TIMEOUT_MS });
  console.log('OK: вызов дошёл до собеседника');
  await bob.page.getByRole('button', { name: 'Accept' }).click();
  await Promise.all([alice.page, bob.page].map((page) => page.getByText(/^\d+:\d{2}$/).first()
    .waitFor({ state: 'visible', timeout: CALL_TIMEOUT_MS })));
  await expectMediaFlowing(alice.page, { audio: true });
  await expectMediaFlowing(bob.page, { audio: true });
  console.log('OK: аудиозвонок соединён, звук идёт в обе стороны');
  console.log(`   путь медиа: ${(await callMediaStats(alice.page)).map((p) => `${p.connectionState}/${p.candidateType}`).join(', ')}`);
  await alice.page.getByRole('button', { name: 'End Call' }).click();
  await bob.page.getByRole('button', { name: 'End Call' }).waitFor({ state: 'detached', timeout: CALL_TIMEOUT_MS });

  // ── Видеозвонок ──
  await alice.page.waitForTimeout(3000);
  await alice.page.getByRole('button', { name: 'More actions' }).click();
  await alice.page.getByRole('menuitem', { name: 'Video Call' }).click();
  await bob.page.getByText('is calling you...', { exact: true }).waitFor({ state: 'visible', timeout: CALL_TIMEOUT_MS });
  await bob.page.getByRole('button', { name: 'Accept' }).click();
  await Promise.all([alice.page, bob.page].map((page) => page.getByText(/^\d+:\d{2}$/).first()
    .waitFor({ state: 'visible', timeout: CALL_TIMEOUT_MS })));
  await expectMediaFlowing(alice.page, { audio: true, video: true });
  await expectMediaFlowing(bob.page, { audio: true, video: true });
  console.log('OK: видеозвонок соединён, видео и звук идут в обе стороны');
  await alice.page.getByRole('button', { name: 'End Call' }).click();
  console.log('OK: звонки на проде работают');
} catch (err) {
  await dump('fail');
  throw err;
} finally {
  await browser.close();
}
