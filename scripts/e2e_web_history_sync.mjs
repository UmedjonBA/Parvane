// Синхронизация истории между устройствами аккаунта (spec 033, HIST-1, HIST-2, READ-2) — сквозной сценарий web.
// Повод (30 окт 2026): после входа с нового устройства вернулись сообщения, удалённые «у всех», и висели
// непрочитанные, хотя всё прочитано на другом устройстве.
//
// Алиса — устройства A (первое) и B (вошло ответом боту), друг — Боб. Проверяется:
//   1. B получает историю из журнала истории аккаунта (не из снимка в копии ключей);
//   2. B офлайн; на A: своё «у всех», чужое «у всех» (личный чат, как Telegram), своё и чужое «только у меня» —
//      у Боба исчезают только удалённые «у всех»;
//   3. Боб присылает 9 сообщений, A читает → после подключения B видит то же: удалённого нет, бейдж 0;
//   4. живое прочтение: новое сообщение Боба, A читает → бейдж B обнуляется не позже READ_SYNC_MS (SC-002, 2 с);
//   5. новые устройства C (ключ руками) и D (подтверждение с B): удалённого нет, бейдж 0, оставшееся на месте;
//   6. перезагрузка A, B, C — то же (удалённое не воскресает из кэша).
// Запуск: scripts/run_web_history_sync_e2e.sh (стек и бот поднимает раннер)
import assert from 'node:assert/strict';

import { chromium } from '../web/telegram-tt/node_modules/playwright/index.mjs';

import {
  assertNoPageErrors, findMessage, linkSecondDevice, openPrivateChatStrict, relogin, selectMessageAction, sendText,
} from './e2e_web_helpers.mjs';
import {
  LOGIN_TIMEOUT_MS, PASSWORD, STEP_TIMEOUT_MS, TG_ALICE, TG_BOB, WIDE, baseUrl, gatewayUrl, joinByTelegram,
  joinByTypedKey, login, pullFor, register, waitLog,
} from './e2e_web_join_lib.mjs';

// Прочтение на одном своём устройстве видно на другом в сети — не позже (SC-002)
const READ_SYNC_MS = Number(process.env.PARVANE_E2E_READ_SYNC_MS) || 2000;
// Догон устройства, бывшего офлайн, и вход нового устройства
const CATCH_UP_MS = 30000;
const UNREAD_COUNT = 9;

const browser = await chromium.launch();
const sessions = {};

/** Бейдж непрочитанного чата в списке чатов (0 — бейджа нет), как видит человек. */
async function badge(session, peerNick) {
  const item = session.page.locator('#LeftColumn .ListItem').filter({ hasText: peerNick }).first();
  const number = item.getByText(/^\d{1,3}$/);
  if (!(await number.count())) return 0;
  return Number(await number.first().textContent());
}

async function waitBadge(session, peerNick, expected, timeout) {
  const started = Date.now();
  let last;
  while (Date.now() - started < timeout) {
    last = await badge(session, peerNick);
    if (last === expected) return Date.now() - started;
    await session.page.waitForTimeout(100);
  }
  assert.fail(`${session.label}: бейдж чата ${peerNick} = ${last}, ждали ${expected} (${timeout} мс)\n`
    + `${session.logs.slice(-25).join('\n')}`);
  return timeout;
}

/** Закрыть открытый чат (иначе входящее сразу «прочитано»). */
async function closeChat(session) {
  await session.page.keyboard.press('Escape');
  await session.page.waitForTimeout(300);
}

/** Удалить сообщение через окно удаления: `forAll` — галочка «удалить и у собеседника». */
async function deleteVia(session, text, forAll) {
  const { page } = session;
  await selectMessageAction(page, text, 'Delete');
  const modal = page.locator('.Modal .modal-dialog');
  await modal.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  const box = modal.locator('.dialog-checkbox input[type="checkbox"]');
  if (await box.count()) {
    if ((await box.isChecked()) !== forAll) await modal.locator('.dialog-checkbox').click();
    assert.equal(await box.isChecked(), forAll, `${session.label}: галочка «у всех» не встала`);
  } else {
    assert.equal(forAll, true, `${session.label}: в окне удаления нет выбора «у всех / только у меня»`);
  }
  await modal.getByRole('button', { name: 'Delete', exact: true }).click();
  await findMessage(page, text).first().waitFor({ state: 'detached', timeout: STEP_TIMEOUT_MS });
}

/** В открытом чате: оставшееся видно, удалённого нет. */
async function expectChat(session, peerAddress, { present, absent }, timeout = CATCH_UP_MS) {
  await openPrivateChatStrict(session.page, peerAddress);
  for (const text of present) {
    await findMessage(session.page, text).first().waitFor({ state: 'visible', timeout });
  }
  for (const text of absent) {
    assert.equal(await findMessage(session.page, text).count(), 0, `${session.label}: удалённое «${text}» видно`);
  }
}

try {
  const suffix = `${Date.now().toString(36)}${process.pid}`;
  const aliceNick = `hs-a-${suffix}`;
  const bobNick = `hs-b-${suffix}`;
  const alice = await register(await browser.newContext({ viewport: WIDE }), aliceNick, TG_ALICE);
  alice.label = 'A';
  sessions.A = alice;
  const bob = await register(await browser.newContext({ viewport: WIDE }), bobNick, TG_BOB);
  bob.label = 'bob';
  sessions.bob = bob;

  const t = {
    ownAll: `own-all-${suffix}`,
    ownMe: `own-me-${suffix}`,
    bobAll: `bob-all-${suffix}`,
    bobMe: `bob-me-${suffix}`,
    keep: `keep-${suffix}`,
  };
  await openPrivateChatStrict(alice.page, bob.address);
  for (const text of [t.ownAll, t.ownMe, t.keep]) await sendText(alice.page, text);
  await openPrivateChatStrict(bob.page, alice.address);
  await findMessage(bob.page, t.keep).first().waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  for (const text of [t.bobAll, t.bobMe]) await sendText(bob.page, text);
  await findMessage(alice.page, t.bobMe).first().waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  // Входящее пишется в журнал через 1–5 с
  await waitLog(alice, /история: в журнал записано/, STEP_TIMEOUT_MS);
  await alice.page.waitForTimeout(6000);

  // ── 1. B входит ответом боту: история — из журнала истории ──
  const bContext = await browser.newContext({ viewport: WIDE });
  const b = await login(bContext, aliceNick, 'B');
  sessions.B = b;
  // Бот спрашивает ключ в Telegram Алисы — отвечаем ключом восстановления
  await joinByTelegram(b, alice.key);
  await waitLog(b, /история: журнал подключён/, LOGIN_TIMEOUT_MS);
  await expectChat(b, bob.address, { present: [t.ownAll, t.ownMe, t.bobAll, t.bobMe, t.keep], absent: [] });
  assert(!b.logs.some((line) => line.includes('снимок истории')), 'B: история пришла снимком копии ключей');
  console.log('OK: B получило историю из журнала истории аккаунта');
  await closeChat(b);

  // ── 2. B офлайн; на A удаления всех видов ──
  await b.page.close();
  await openPrivateChatStrict(alice.page, bob.address);
  await deleteVia(alice, t.ownAll, true);
  await deleteVia(alice, t.bobAll, true);
  await deleteVia(alice, t.ownMe, false);
  await deleteVia(alice, t.bobMe, false);
  await expectChat(bob, alice.address, { present: [t.ownMe, t.bobMe, t.keep], absent: [t.ownAll, t.bobAll] });
  console.log('OK: у Боба исчезли только удалённые «у всех» (в том числе его сообщение), «только у меня» — остались');

  // ── 3. Боб присылает 9 сообщений; A читает ──
  await closeChat(alice);
  const unread = Array.from({ length: UNREAD_COUNT }, (_, i) => `unread-${i + 1}-${suffix}`);
  for (const text of unread) await sendText(bob.page, text);
  await waitBadge(alice, bobNick, UNREAD_COUNT, STEP_TIMEOUT_MS);
  await openPrivateChatStrict(alice.page, bob.address);
  await findMessage(alice.page, unread.at(-1)).first().waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await waitBadge(alice, bobNick, 0, STEP_TIMEOUT_MS);
  await closeChat(alice);
  await waitLog(alice, /история: в журнал записано/, STEP_TIMEOUT_MS);
  await alice.page.waitForTimeout(6000);

  // B возвращается: удалённого нет, бейдж 0
  b.page = await bContext.newPage();
  b.page.on('console', (message) => {
    if (message.text().includes('[parvane]')) b.logs.push(message.text().slice(0, 300));
  });
  b.page.on('pageerror', (err) => b.errors.push(err.message));
  await b.page.addInitScript((url) => {
    localStorage.setItem('parvane:gateway', url);
  }, gatewayUrl);
  await b.page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
  await relogin(b.page, PASSWORD);
  await waitBadge(b, bobNick, 0, CATCH_UP_MS);
  await expectChat(b, bob.address, {
    present: [t.keep, ...unread], absent: [t.ownAll, t.bobAll, t.ownMe, t.bobMe],
  });
  console.log('OK: B после офлайна совпадает с A — удалённого нет, бейдж 0');
  await closeChat(b);

  // ── 4. Живое прочтение: бейдж B — 0 не позже READ_SYNC_MS ──
  const live = `live-${suffix}`;
  await sendText(bob.page, live);
  await waitBadge(b, bobNick, 1, STEP_TIMEOUT_MS);
  await waitBadge(alice, bobNick, 1, STEP_TIMEOUT_MS);
  await openPrivateChatStrict(alice.page, bob.address);
  await findMessage(alice.page, live).first().waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  const readMs = await waitBadge(b, bobNick, 0, READ_SYNC_MS + 1000);
  assert(readMs <= READ_SYNC_MS, `B: бейдж обнулился через ${readMs} мс (> ${READ_SYNC_MS})`);
  console.log(`OK: прочтение на A видно на B через ${readMs} мс`);
  await closeChat(alice);

  // ── 5. Новые устройства: C ключом руками, D подтверждением с B ──
  const c = await login(await browser.newContext({ viewport: WIDE }), aliceNick, 'C');
  sessions.C = c;
  await joinByTypedKey(c, alice.key);
  await waitLog(c, /история: журнал подключён/, LOGIN_TIMEOUT_MS);
  await waitBadge(c, bobNick, 0, CATCH_UP_MS);
  await expectChat(c, bob.address, {
    present: [t.keep, live, ...unread], absent: [t.ownAll, t.bobAll, t.ownMe, t.bobMe],
  });
  console.log('OK: C (ключ руками) — удалённого нет, бейдж 0');

  const d = await login(await browser.newContext({ viewport: WIDE }), aliceNick, 'D');
  sessions.D = d;
  // Бот спросил ключ и у этого устройства — просьбу забираем, входим подтверждением с B
  await pullFor(TG_ALICE, 'ask').catch(() => undefined);
  await linkSecondDevice(b.page, d.page);
  await waitLog(d, /история: журнал подключён/, LOGIN_TIMEOUT_MS);
  await waitBadge(d, bobNick, 0, CATCH_UP_MS);
  await expectChat(d, bob.address, {
    present: [t.keep, live], absent: [t.ownAll, t.bobAll, t.ownMe, t.bobMe],
  });
  console.log('OK: D (подтверждение с B) — удалённого нет, бейдж 0');

  // ── 6. Перезагрузка всех своих устройств ──
  for (const session of [alice, b, c]) {
    await relogin(session.page, PASSWORD);
    await waitBadge(session, bobNick, 0, CATCH_UP_MS);
    await expectChat(session, bob.address, {
      present: [t.keep, live], absent: [t.ownAll, t.bobAll, t.ownMe, t.bobMe],
    });
    await closeChat(session);
  }
  console.log('OK: после перезагрузки A, B, C удалённое не вернулось, бейджи 0');

  assertNoPageErrors(Object.fromEntries(Object.entries(sessions).filter(([name]) => name !== 'B')));
  console.log('HISTORY SYNC: OK');
} catch (err) {
  for (const [name, session] of Object.entries(sessions)) {
    console.log(`--- ${name} (последние строки журнала) ---\n${(session.logs || []).slice(-40).join('\n')}`);
  }
  throw err;
} finally {
  await browser.close();
}

