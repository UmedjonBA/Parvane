// Защита метаданных в режиме L2 (spec 025 И2, И3): с включённым режимом записи уходят тактами, в простое —
// пустышки того же размера (по кадрам не видно, когда человек пишет); сообщения доходят; пустышки нигде не
// видны; открытие чата не порождает запроса журнала устройств собеседника; без L2 — ни тактов, ни шума.
import assert from 'node:assert/strict';

import { chromium } from '../web/telegram-tt/node_modules/playwright/index.mjs';

import {
  assertNoPageErrors,
  exchangeMessages,
  findMessage,
  LOGIN_TIMEOUT_MS,
  openPrivateChatStrict,
  preparePage,
  sendText,
  showChatList,
} from './e2e_web_helpers.mjs';

const PASSWORD = 'Parvane-l2-metadata-e2e-password';
const IDLE_WINDOW_MS = 30000;
// Такт 5 с ± 2 с: за 30 с простоя — не меньше 4 записей
const MIN_COVERS = 4;

// Кадры v2 двоичные; имя метода в них — строкой протокола, адрес собеседника — тоже открытым текстом
function trackFrames(context) {
  const frames = [];
  context.on('page', (page) => {
    page.on('websocket', (ws) => ws.on('framesent', ({ payload }) => {
      const bytes = typeof payload === 'string' ? Buffer.from(payload) : payload;
      frames.push({ at: Date.now(), size: bytes.length, text: bytes.toString('latin1') });
    }));
  });
  return frames;
}

const deliveries = (frames, since) => frames.filter((f) => f.at >= since && f.text.includes('msg.deliver_sealed'));

function l2Row(page) {
  return page.locator('#RightColumn .ListItem').filter({ hasText: 'Enhanced privacy' });
}

async function toggleL2(page) {
  if (!(await l2Row(page).isVisible().catch(() => false))) {
    await page.locator('.MiddleHeader .ChatInfo').first().click();
  }
  await l2Row(page).waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await l2Row(page).locator('.ListItem-button').click();
}

const browser = await chromium.launch();
const aliceContext = await browser.newContext();
const bobContext = await browser.newContext();
const aliceFrames = trackFrames(aliceContext);
const sessions = {};

try {
  const suffix = `${Date.now()}-${process.pid}`;
  const alice = `l2m-alice-${suffix}@local`;
  const bob = `l2m-bob-${suffix}@local`;
  sessions.alice = await preparePage(aliceContext, alice, PASSWORD);
  sessions.bob = await preparePage(bobContext, bob, PASSWORD);
  const { page: a } = sessions.alice;
  const { page: b } = sessions.bob;
  await exchangeMessages(a, alice, b, bob, suffix);

  // ── Без L2: в простое записей нет ─────────────────────────────────────────
  // Хвост переписки (квитанции, раздача ключа) успевает уйти — затем окно тишины
  await a.waitForTimeout(10000);
  let since = Date.now();
  await a.waitForTimeout(15000);
  assert(deliveries(aliceFrames, since).length <= 1, 'без L2 в простое идёт поток записей');
  console.log('OK: без L2 — ни тактов, ни шума');

  // ── L2: шум в простое, записи одного размера ─────────────────────────────
  await toggleL2(a);
  await a.locator('.ActionMessage').filter({ hasText: 'You enabled enhanced privacy' }).first()
    .waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await a.waitForTimeout(8000);
  since = Date.now();
  await a.waitForTimeout(IDLE_WINDOW_MS);
  const idle = deliveries(aliceFrames, since);
  assert(idle.length >= MIN_COVERS, `за ${IDLE_WINDOW_MS} мс простоя ушло ${idle.length} записей`);
  const sizes = new Set(idle.map((f) => f.size));
  assert.equal(sizes.size, 1, `записи шума разного размера: ${[...sizes].join(', ')}`);
  console.log(`OK: L2 — ${idle.length} пустышек за ${IDLE_WINDOW_MS / 1000} с, размер ${[...sizes][0]} байт`);

  // ── Сообщение доходит, по размеру неотличимо от пустышки ─────────────────
  const text = `under-l2-${suffix}`;
  since = Date.now();
  await sendText(a, text);
  await findMessage(b, text).first().waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  const withMessage = deliveries(aliceFrames, since);
  assert(withMessage.every((f) => sizes.has(f.size)), 'запись с сообщением отличается размером от шума');
  console.log('OK: сообщение дошло тактом, размер как у пустышки');

  // Пустышки не видны: в чатах Алисы нет лишних сообщений
  await showChatList(a);
  await openPrivateChatStrict(a, bob);
  const bubbles = await a.locator('.Transition_slide-active > .MessageList .Message').count();
  assert(bubbles <= 4, `в чате лишние сообщения: ${bubbles}`);

  // ── Открытие чата не порождает запроса журнала собеседника ───────────────
  await showChatList(a);
  await a.waitForTimeout(20000);
  since = Date.now();
  await openPrivateChatStrict(a, bob);
  await a.waitForTimeout(4000);
  const logFetches = aliceFrames.filter((f) => f.at >= since
    && f.text.includes('identity.device.log_sync_anon') && f.text.includes(bob));
  assert.equal(logFetches.length, 0, 'открытие чата запросило журнал устройств собеседника');
  console.log('OK: открытие чата не выдаёт собеседника запросом');

  // ── L2 выключен: шум прекращается ────────────────────────────────────────
  await toggleL2(a);
  await a.locator('.ActionMessage').filter({ hasText: 'You disabled enhanced privacy' }).first()
    .waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await a.waitForTimeout(8000);
  since = Date.now();
  await a.waitForTimeout(15000);
  assert(deliveries(aliceFrames, since).length <= 1, 'после выключения L2 шум продолжается');
  console.log('OK: без L2 шум прекратился');

  assertNoPageErrors(sessions);
  console.log('OK: сценарий защиты метаданных пройден');
} finally {
  await browser.close();
}
