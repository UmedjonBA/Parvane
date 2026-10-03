// Протокол v2 (spec 007, T056/T073/T084/T125): группы v2 между тремя web-клиентами.
// Алиса создаёт группу с Бобом (оба v2 → группа с подписанным журналом),
// Кэрол вступает по ссылке v2 `https://<домен>/join/<link_id>#<секрет>` (клик
// в личке → нативная модалка «Join Group»), сообщение доходит всем троим;
// Алиса банит Кэрол — новая эпоха, Кэрол новое сообщение не читает, Боб читает.
import assert from 'node:assert/strict';

import { chromium } from '../web/telegram-tt/node_modules/playwright/index.mjs';

import {
  callProviderForChat,
  dismissRecoveryKeyDialog,
  dumpDiagJournal,
  findMessage,
  LOGIN_TIMEOUT_MS,
  openGroupChatByTitle,
  openGroupManagement,
  openPrivateChatStrict,
  preparePage,
  sendText,
  createGroupViaUi,
} from './e2e_web_helpers.mjs';

const PASSWORD = 'Parvane-v2-groups-password';
const V2_SEED = { 'parvane:proto': 'v2' };
const V2_LINK = /https:\/\/[^/\s]+\/join\/[A-Za-z0-9_-]{43}#[A-Za-z0-9_-]{43}/;
// Новая эпоха — не чаще раза в 10 с: ключи новой эпохи приходят не сразу
const EPOCH_TIMEOUT_MS = 60000;
const BAN_SETTLE_MS = 15000;

const browser = await chromium.launch();
const names = ['alice', 'bob', 'carol'];
const contexts = Object.fromEntries(await Promise.all(names.map(async (n) => [n, await browser.newContext()])));
const logs = Object.fromEntries(names.map((n) => [n, []]));
const consoleTail = Object.fromEntries(names.map((n) => [n, []]));
const sessions = {};

// «Печатает», ушедшее v1-кадром с открытыми `{from, to}`: в группе v2 таких нет
const typingV1 = Object.fromEntries(names.map((n) => [n, []]));

names.forEach((who) => {
  contexts[who].on('page', (page) => {
    page.on('console', (m) => {
      const t = m.text();
      if (t.includes('[parvane] v2')) logs[who].push(t);
      consoleTail[who].push(`${m.type()}: ${t.slice(0, 300)}`);
      if (consoleTail[who].length > 80) consoleTail[who].shift();
    });
    page.on('pageerror', (e) => consoleTail[who].push(`pageerror: ${String(e).slice(0, 500)}`));
    page.on('websocket', (ws) => ws.on('framesent', ({ payload }) => {
      if (typeof payload !== 'string') return;
      try {
        const frame = JSON.parse(payload);
        if (frame.op === 'pub' && /^msg\.typing\./.test(frame.subject || '')) typingV1[who].push(frame.subject);
      } catch {
        // не JSON-кадр v1
      }
    }));
  });
});

async function waitLog(who, needle, timeout = LOGIN_TIMEOUT_MS) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (logs[who].some((l) => l.includes(needle))) return;
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => { setTimeout(r, 200); });
  }
  throw new Error(`${who}: нет записи «${needle}» (журнал v2: ${logs[who].join(' | ')})`);
}

// Текст есть в сообщениях глобального состояния (независимо от прокрутки/открытого чата)
function hasMessageText(page, text) {
  return page.evaluate((needle) => {
    const g = globalThis.__parvaneGetGlobal?.();
    if (!g) return false;
    return Object.values(g.messages.byChatId).some((chat) => Object.values(chat.byId || {})
      .some((m) => m.content?.text?.text?.includes(needle)));
  }, text);
}

// Композер открытого чата (после вступления в DOM два чата — переход)
async function sendInActiveChat(page, text) {
  const composer = page.locator('.Transition_slide-active #editable-message-text').last();
  await composer.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await composer.fill(text);
  await composer.press('Enter');
}

const TYPING_SETTLE_MS = 4000;

function serviceMessage(page, text) {
  return page.locator('.Transition_slide-active > .MessageList .ActionMessage').filter({ hasText: text });
}

// Переключатель режима группы — в экране управления (только у админа с правом
// менять сведения); после — обратно в чат группы
async function toggleGroupL2(page, title) {
  const right = await openGroupManagement(page, title);
  const row = right.locator('.Management .ListItem').filter({ hasText: 'Enhanced privacy' });
  await row.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await row.locator('.ListItem-button').click();
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  await openGroupChatByTitle(page, title);
}

try {
  const suffix = `${Date.now()}-${process.pid}`;
  const address = (n) => `g2${n[0]}-${suffix}@local`;
  const nick = (n) => address(n).split('@')[0];

  for (const who of names) {
    // eslint-disable-next-line no-await-in-loop
    sessions[who] = await preparePage(contexts[who], address(who), PASSWORD, { seedLocalStorage: V2_SEED });
  }
  await Promise.all(names.map((who) => waitLog(who, 'v2: готов')));
  for (const who of names) {
    // eslint-disable-next-line no-await-in-loop
    assert.ok(await dismissRecoveryKeyDialog(sessions[who].page), `${who}: не показан ключ восстановления v2`);
  }
  const alicePage = sessions.alice.page;

  // Собеседники в пикере — после переписки (личка идёт по v2)
  await openPrivateChatStrict(alicePage, address('bob'));
  await sendText(alicePage, `hi-bob-${suffix}`);
  await openPrivateChatStrict(alicePage, address('carol'));
  await sendText(alicePage, `hi-carol-${suffix}`);
  await openPrivateChatStrict(sessions.bob.page, address('alice'));
  await findMessage(sessions.bob.page, `hi-bob-${suffix}`).waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });

  // ── Группа v2: Алиса + Боб ─────────────────────────────────────────────────
  const title = `G2-${suffix.slice(-6)}`;
  await createGroupViaUi(alicePage, title, [nick('bob')]);
  await waitLog('alice', 'v2: группа создана');
  await waitLog('alice', 'v2: новая эпоха группы');
  await openGroupChatByTitle(sessions.bob.page, title);
  const first = `g2-first-${suffix}`;
  await sendText(alicePage, first);
  await findMessage(sessions.bob.page, first).waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });

  // ── «Печатает» в группе v2 (T127, FR-064): анонимно, канал из ключа эпохи ──
  const draft = alicePage.locator('#editable-message-text[contenteditable="true"]');
  await draft.click();
  await draft.pressSequentially('typing-in-group', { delay: 120 });
  await sessions.bob.page.locator('.MiddleHeader .typing-status')
    .waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await draft.fill('');
  assert.deepEqual(typingV1.alice, [], 'alice: «печатает» группы v2 ушло v1-кадром');

  // ── Групповой L2 (T139, L2-1): владелец включает режим в управлении группой —
  // служебное сообщение у всех, «печатает» не показывается, сообщения ходят;
  // выключение — снова служебное сообщение
  await toggleGroupL2(alicePage, title);
  await serviceMessage(sessions.bob.page, 'enabled enhanced privacy')
    .waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await draft.click();
  await draft.pressSequentially('typing-under-group-l2', { delay: 120 });
  await sessions.bob.page.waitForTimeout(TYPING_SETTLE_MS);
  assert.equal(await sessions.bob.page.locator('.MiddleHeader .typing-status').count(), 0,
    'bob: «печатает» в группе с L2 показывается');
  await draft.fill('');
  const underL2 = `g2-under-l2-${suffix}`;
  await sendText(alicePage, underL2);
  await findMessage(sessions.bob.page, underL2).waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await toggleGroupL2(alicePage, title);
  await serviceMessage(sessions.bob.page, 'disabled enhanced privacy')
    .waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });

  // ── Ссылка v2: создаёт Алиса, Кэрол вступает кликом в личке ────────────────
  const exported = await callProviderForChat(alicePage, 'exportChatInvite', title, undefined, { peer: '$chat' });
  const inviteUrl = exported?.result?.link;
  assert.match(String(inviteUrl), V2_LINK, `ссылка не v2: ${JSON.stringify(exported)}`);
  await openPrivateChatStrict(alicePage, address('carol'));
  await sendText(alicePage, inviteUrl);
  const carolPage = sessions.carol.page;
  await openPrivateChatStrict(carolPage, address('alice'));
  const link = carolPage.locator('.Transition_slide-active > .MessageList a[href*="/join/"]').first();
  await link.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await link.click();
  const modal = carolPage.locator('.Modal .modal-dialog').filter({ hasText: title }).first();
  await modal.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await modal.getByRole('button', { name: /join group/i }).first().click();
  await carolPage.locator('.MiddleHeader').getByText(title).first()
    .waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await waitLog('carol', 'v2: вступление в группу');

  // Алиса начинает эпоху для нового состава; сообщение видят все трое
  const welcome = `g2-welcome-${suffix}`;
  await openGroupChatByTitle(alicePage, title);
  await sendText(alicePage, welcome);
  await findMessage(carolPage, welcome).waitFor({ state: 'visible', timeout: EPOCH_TIMEOUT_MS });
  await findMessage(sessions.bob.page, welcome).waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  // Кэрол пишет в группу ключом отправки новой эпохи
  const carolHello = `g2-carol-${suffix}`;
  await sendInActiveChat(carolPage, carolHello);
  await findMessage(alicePage, carolHello).waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });

  // ── Бан Кэрол: новая эпоха без неё ──────────────────────────────────────────
  const ban = await callProviderForChat(alicePage, 'updateChatMemberBannedRights', title, nick('carol'), {
    chat: '$chat', user: '$user', bannedRights: { viewMessages: true },
  });
  assert.ok(ban?.result, `бан не прошёл: ${JSON.stringify(ban)}`);
  const afterBan = `g2-after-ban-${suffix}`;
  await sendText(alicePage, afterBan);
  await findMessage(sessions.bob.page, afterBan).waitFor({ state: 'visible', timeout: EPOCH_TIMEOUT_MS });
  await carolPage.waitForTimeout(BAN_SETTLE_MS);
  assert.equal(await hasMessageText(carolPage, afterBan), false, 'забаненная Кэрол прочитала новое сообщение');
  assert.equal(await hasMessageText(carolPage, welcome), true, 'у Кэрол пропало сообщение до бана');

  for (const who of names) {
    assert.ok(!logs[who].some((l) => l.includes('запуск не удался')), `${who}: ${logs[who].join(' | ')}`);
  }
  console.log('e2e_protocol_groups: OK');
} catch (error) {
  const shotDir = process.env.PARVANE_E2E_SHOT_DIR || 'web/telegram-tt/test-results';
  for (const who of names) {
    const session = sessions[who];
    if (!session) continue;
    // eslint-disable-next-line no-await-in-loop
    await session.page.screenshot({ path: `${shotDir}/protocol-groups-${who}.png` }).catch(() => undefined);
    // eslint-disable-next-line no-await-in-loop
    await dumpDiagJournal(session.page, who);
    console.error(`консоль ${who}:\n${consoleTail[who].join('\n')}`);
    console.error(`v2 журнал ${who}: ${logs[who].join('\n')}`);
  }
  throw error;
} finally {
  await browser.close();
}
