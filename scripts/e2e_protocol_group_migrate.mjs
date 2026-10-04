// Протокол v2 (spec 007, T180, SC-002): группа, созданная по v1, переводится в v2.
// alice (владелец) и bob заводят группу и переписываются по v1. Затем оба
// обновляются до v2 на тех же устройствах: клиент владельца сам создаёт группу v2
// с записью о прежнем group_id, клиенты продолжают ПРЕЖНИЙ чат — история v1
// остаётся в нём, новые сообщения идут по v2 (в шину v1 `msg.chat.send` не
// уходит). В списке чатов группа одна, после перезагрузки — тоже.
// Запуск: scripts/run_protocol_mixed_e2e.sh group-migrate
import assert from 'node:assert/strict';

import { chromium } from '../web/telegram-tt/node_modules/playwright/index.mjs';

import {
  createGroupViaUi,
  dismissRecoveryKeyDialog,
  dumpDiagJournal,
  findMessage,
  LOGIN_TIMEOUT_MS,
  openGroupChatByTitle,
  openPrivateChatStrict,
  preparePage,
  reloadPage,
  sendText,
} from './e2e_web_helpers.mjs';

const PASSWORD = 'Parvane-v2-e2e-password';
const V1_SEED = { 'parvane:proto': 'v1' };

const browser = await chromium.launch();
const aliceContext = await browser.newContext();
const bobContext = await browser.newContext();
const logs = { alice: [], bob: [] };
const consoleTail = { alice: [], bob: [] };
// Отправки сообщений по шине v1 — после перевода группы их быть не должно
const v1Sends = { alice: 0, bob: 0 };

function trackContext(context, who) {
  context.on('page', (page) => {
    page.on('console', (m) => {
      const t = m.text();
      if (t.includes('[parvane]')) logs[who].push(t.slice(0, 300));
      consoleTail[who].push(`${m.type()}: ${t.slice(0, 300)}`);
      if (consoleTail[who].length > 80) consoleTail[who].shift();
    });
    page.on('pageerror', (e) => consoleTail[who].push(`pageerror: ${String(e).slice(0, 500)}`));
    page.on('websocket', (ws) => ws.on('framesent', ({ payload }) => {
      if (typeof payload !== 'string') return;
      try {
        const frame = JSON.parse(payload);
        if (frame.op === 'pub' && frame.subject === 'msg.chat.send') v1Sends[who] += 1;
      } catch {
        // не JSON-кадр v1
      }
    }));
  });
}
trackContext(aliceContext, 'alice');
trackContext(bobContext, 'bob');

async function waitLog(who, needle, timeout = LOGIN_TIMEOUT_MS, from = 0) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (logs[who].slice(from).some((l) => l.includes(needle))) return;
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => { setTimeout(r, 200); });
  }
  throw new Error(`${who}: нет записи «${needle}» (журнал: ${logs[who].slice(-40).join(' | ')})`);
}

// Композер открытого чата (после перехода в DOM два чата)
async function sendInActiveChat(page, text) {
  const composer = page.locator('.Transition_slide-active #editable-message-text').last();
  await composer.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await composer.fill(text);
  await composer.press('Enter');
}

// Сколько чатов с таким названием в списке (перевод не должен завести второй)
function chatsWithTitle(page, title) {
  return page.locator('#LeftColumn .chat-list .ListItem').filter({ hasText: title }).count();
}

// Переход клиента на v2 на том же устройстве
async function upgradeToV2(session, who) {
  const mark = logs[who].length;
  await session.page.addInitScript(() => localStorage.setItem('parvane:proto', 'v2'));
  await reloadPage(session.page);
  await waitLog(who, 'v2: готов', LOGIN_TIMEOUT_MS, mark);
  await dismissRecoveryKeyDialog(session.page);
}

let aliceSession;
let bobSession;
try {
  const suffix = `${Date.now()}-${process.pid}`;
  const alice = `gma-${suffix}@local`;
  const bob = `gmb-${suffix}@local`;

  // ── эпоха v1: переписка, группа, сообщения в группе ────────────────────────
  aliceSession = await preparePage(aliceContext, alice, PASSWORD, { seedLocalStorage: V1_SEED });
  bobSession = await preparePage(bobContext, bob, PASSWORD, { seedLocalStorage: V1_SEED });
  await openPrivateChatStrict(aliceSession.page, bob);
  await sendText(aliceSession.page, `hi-bob-${suffix}`);
  await openPrivateChatStrict(bobSession.page, alice);
  await findMessage(bobSession.page, `hi-bob-${suffix}`).waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });

  const title = `Mig-${suffix.slice(-6)}`;
  await createGroupViaUi(aliceSession.page, title, [bob.split('@')[0]]);
  await openGroupChatByTitle(aliceSession.page, title);
  const v1FromAlice = `v1-group-alice-${suffix}`;
  await sendText(aliceSession.page, v1FromAlice);
  await openGroupChatByTitle(bobSession.page, title);
  await findMessage(bobSession.page, v1FromAlice).waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  const v1FromBob = `v1-group-bob-${suffix}`;
  await sendInActiveChat(bobSession.page, v1FromBob);
  await findMessage(aliceSession.page, v1FromBob).waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  assert.ok(v1Sends.alice > 0 && v1Sends.bob > 0, 'переписка эпохи v1 шла не по v1');

  // ── оба обновляются до v2; владелец — последним ───────────────────────────
  await upgradeToV2(bobSession, 'bob');
  await upgradeToV2(aliceSession, 'alice');
  await waitLog('alice', 'v2: группа v1 ', 90000);
  const migrated = logs.alice.find((l) => l.includes('v2: группа v1 ') && l.includes('переведена в v2g:'));
  assert.ok(migrated, `alice: группа не переведена (${logs.alice.slice(-20).join(' | ')})`);
  const sendsBefore = { ...v1Sends };

  // ── прежний чат: история v1 на месте, новые сообщения — по v2 ──────────────
  await openGroupChatByTitle(aliceSession.page, title);
  await findMessage(aliceSession.page, v1FromBob).waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  const v2FromAlice = `v2-group-alice-${suffix}`;
  await sendInActiveChat(aliceSession.page, v2FromAlice);
  await openGroupChatByTitle(bobSession.page, title);
  await findMessage(bobSession.page, v2FromAlice).waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await findMessage(bobSession.page, v1FromAlice).waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  const v2FromBob = `v2-group-bob-${suffix}`;
  await sendInActiveChat(bobSession.page, v2FromBob);
  await findMessage(aliceSession.page, v2FromBob).waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  assert.deepEqual(v1Sends, sendsBefore, 'сообщения переведённой группы ушли по шине v1');
  for (const [who, session] of [['alice', aliceSession], ['bob', bobSession]]) {
    assert.equal(await chatsWithTitle(session.page, title), 1, `${who}: группа в списке чатов не одна`);
  }

  // ── перезагрузка: чат один, история обеих эпох на месте ────────────────────
  const mark = logs.bob.length;
  await reloadPage(bobSession.page);
  await waitLog('bob', 'v2: готов', LOGIN_TIMEOUT_MS, mark);
  await openGroupChatByTitle(bobSession.page, title);
  await findMessage(bobSession.page, v1FromAlice).waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await findMessage(bobSession.page, v2FromAlice).waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  assert.equal(await chatsWithTitle(bobSession.page, title), 1, 'bob: после перезагрузки группа в списке не одна');
  const afterReload = `v2-group-after-reload-${suffix}`;
  await sendInActiveChat(aliceSession.page, afterReload);
  await findMessage(bobSession.page, afterReload).waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });

  for (const who of ['alice', 'bob']) {
    assert.ok(!logs[who].some((l) => l.includes('запуск не удался')), `${who}: ${logs[who].slice(-20).join(' | ')}`);
  }
  console.log('e2e_protocol_group_migrate: OK');
} catch (error) {
  const shotDir = process.env.PARVANE_E2E_SHOT_DIR || 'web/telegram-tt/test-results';
  for (const [who, session] of [['alice', aliceSession], ['bob', bobSession]]) {
    if (!session) continue;
    await session.page.screenshot({ path: `${shotDir}/protocol-group-migrate-${who}.png` }).catch(() => undefined);
    await dumpDiagJournal(session.page, who);
  }
  console.error(`консоль alice:\n${consoleTail.alice.join('\n')}\nконсоль bob:\n${consoleTail.bob.join('\n')}`);
  console.error(`журнал alice: ${logs.alice.slice(-60).join('\n')}\nbob: ${logs.bob.slice(-60).join('\n')}`);
  throw error;
} finally {
  await browser.close();
}
