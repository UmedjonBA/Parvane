// Публичные группы (spec 023). Владелец делает группу публичной (`@имя`, экран «Тип группы»), включает «Читать
// без вступления» и «Историю для новых участников»; посторонний находит её поиском, открывает `<origin>/@имя`, видит
// ленту до вступления, вступает без приглашения и получает следующее сообщение; имя группы и ник пользователя —
// одно пространство; возврат в «Частную» убирает группу из поиска и освобождает имя; открытого текста в базах нет.
// Запуск: scripts/run_web_public_groups_e2e.sh
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { chromium } from '../web/telegram-tt/node_modules/playwright/index.mjs';

import {
  callProviderForChat,
  closeRightColumn,
  createGroupViaUi,
  dismissRecoveryKeyDialog,
  dumpDiagJournal,
  exchangeMessages,
  openGroupChatByTitle,
  openGroupManagement,
  preparePage,
  sendText,
  showChatList,
} from './e2e_web_helpers.mjs';

const PASSWORD = 'Parvane-public-groups-e2e-1';
const WIDE = { width: 1440, height: 900 };
const STEP_TIMEOUT_MS = 30000;
const BACKEND_DIR = process.env.PARVANE_E2E_BACKEND_LOG_DIR;
assert(BACKEND_DIR, 'PARVANE_E2E_BACKEND_LOG_DIR is required');

function plaintextLeaks(words) {
  const leaks = new Set();
  for (const file of readdirSync(BACKEND_DIR)) {
    if (!/\.db(-wal)?$/.test(file)) continue;
    const text = readFileSync(join(BACKEND_DIR, file)).toString('utf8');
    for (const word of words) if (text.includes(word)) leaks.add(`${file}:${word}`);
  }
  return [...leaks];
}

async function diagCall(page, method, args) {
  await page.waitForFunction(() => typeof window.__parvaneDiagCallApi === 'function', undefined, {
    timeout: STEP_TIMEOUT_MS,
  });
  return page.evaluate(async ({ fn, params }) => window.__parvaneDiagCallApi(fn, params), { fn: method, params: args });
}

async function chatUsernameOf(page, title) {
  return page.evaluate((t) => {
    const chat = Object.values(window.__parvaneGetGlobal().chats.byId).find((c) => c.title === t);
    return chat?.usernames?.[0]?.username;
  }, title);
}

async function waitFor(check, timeoutMs, message) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) assert.fail(message);
    await new Promise((resolve) => {
      setTimeout(resolve, 1000);
    });
  }
}

const browser = await chromium.launch();
const sessions = {};

try {
  const suffix = Date.now().toString(36);
  const alice = `pub-alice-${suffix}@local`;
  const carol = `pub-carol-${suffix}@local`;
  const bob = `pub-bob-${suffix}@local`;
  const title = `Клуб-${suffix}`;
  const name = `club_${suffix}`;
  const before = `до-публичности-${suffix}`;
  const afterPublic = `после-публичности-${suffix}`;
  const afterJoin = `после-вступления-${suffix}`;

  sessions.alice = await preparePage(await browser.newContext({ viewport: WIDE }), alice, PASSWORD);
  sessions.carol = await preparePage(await browser.newContext({ viewport: WIDE }), carol, PASSWORD);
  sessions.bob = await preparePage(await browser.newContext({ viewport: WIDE }), bob, PASSWORD);
  for (const s of Object.values(sessions)) await dismissRecoveryKeyDialog(s.page).catch(() => undefined);
  await exchangeMessages(sessions.alice.page, alice, sessions.carol.page, carol, suffix);

  // ── Частная группа; затем «Тип группы» → «Публичная» с именем ──
  const page = sessions.alice.page;
  await showChatList(page);
  await createGroupViaUi(page, title, [carol.split('@')[0]]);
  await sendText(page, before);
  const right = await openGroupManagement(page, title);
  await right.locator('.ListItem').filter({ hasText: 'Group Type' }).first().click();
  const screen = right.locator('.Management').last();
  await screen.getByText('Public Group', { exact: true }).first().click();
  const linkInput = screen.locator('.settings-input input');
  await linkInput.waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  const origin = new URL(page.url()).origin;
  await linkInput.fill(`${origin}/@${name}`);
  await screen.getByText(/is available/).first().waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await screen.locator('[data-public-warning]').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  // FAB «Save» выезжает после проверки имени; до класса `revealed` нажатие ему не передаётся
  const save = screen.locator('.FloatingActionButton.revealed');
  await save.waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await page.waitForTimeout(400);
  await save.click();
  await waitFor(async () => (await chatUsernameOf(page, title)) === name, STEP_TIMEOUT_MS, 'группа не стала публичной');
  console.log(`OK: группа публичная @${name}`);

  // ── Настройки «Читать без вступления» и «История для новых участников» ──
  const readOptions = async () => (
    await callProviderForChat(page, 'parvaneGetPublicOptions', title, undefined, { chat: '$chat' })
  ).result;
  for (const [option, expected] of [['preview', { isPreview: true, isHistory: false }],
    ['history', { isPreview: true, isHistory: true }]]) {
    const toggle = screen.locator(`[data-public-option="${option}"]`);
    const fallback = screen.locator('label').filter({ hasText: option === 'preview' ? 'Read without joining' : 'History for new members' });
    if (await toggle.count()) await toggle.first().click({ force: true });
    else await fallback.first().click();
    await waitFor(async () => {
      const current = await readOptions();
      return current?.isPreview === expected.isPreview && current?.isHistory === expected.isHistory;
    }, STEP_TIMEOUT_MS, `настройка ${option} не сохранилась`);
  }
  await closeRightColumn(page);
  await openGroupChatByTitle(page, title);
  await sendText(page, afterPublic);
  console.log('OK: настройки сохранены, сообщение после публичности отправлено');

  // ── Имя занято: группой и ником пользователя (общее пространство) ──
  const taken = await diagCall(sessions.carol.page, 'checkChatUsername', { username: name });
  assert.equal(taken.result, false, 'имя группы занято');
  const nick = await diagCall(sessions.carol.page, 'checkChatUsername', { username: bob.split('@')[0].replace(/-/g, '_') });
  assert(nick, 'проверка ника отвечает');
  const own = await diagCall(sessions.carol.page, 'checkChatUsername', { username: `free_${suffix}` });
  assert.equal(own.result, true, 'свободное имя');
  console.log('OK: занятое имя отвергается, свободное — нет');

  // ── Посторонний: поиск находит группу ──
  const bobPage = sessions.bob.page;
  const found = await waitFor(async () => {
    const r = await diagCall(bobPage, 'searchChats', { query: name.slice(0, 6) });
    const ids = r?.globalResultIds || [];
    const titles = await bobPage.evaluate((list) => list
      .map((id) => window.__parvaneGetGlobal().chats.byId[id]?.title).filter(Boolean), ids);
    return titles.includes(title) ? titles : undefined;
  }, STEP_TIMEOUT_MS, 'поиск не нашёл публичную группу');
  console.log(`OK: поиск нашёл: ${found.join(', ')}`);

  // ── `<origin>/@имя`: превью с лентой и «Вступить» ──
  await bobPage.goto(`${origin}/@${name}`);
  // Сохранённая сессия входит сама; иначе — экран пароля
  const passwordScreen = bobPage.locator('.Transition_slide-active > #auth-password-form');
  await Promise.race([
    passwordScreen.waitFor({ state: 'visible', timeout: 60000 }),
    bobPage.locator('#LeftColumn').waitFor({ state: 'visible', timeout: 60000 }),
  ]);
  if (await passwordScreen.isVisible()) {
    await passwordScreen.locator('#sign-in-password').fill(PASSWORD);
    await passwordScreen.getByRole('button', { name: 'Next' }).click();
  }
  await bobPage.locator('.MiddleHeader').getByText(title).first().waitFor({ state: 'visible', timeout: 60000 });
  const bobFeed = bobPage.locator('#MiddleColumn .Message');
  await bobFeed.filter({ hasText: afterPublic }).first().waitFor({ state: 'visible', timeout: 60000 })
    .catch(() => assert.fail('лента до вступления не показана'));
  await bobPage.getByRole('button', { name: /Join/ }).first().click();
  await waitFor(async () => bobPage.evaluate((t) => {
    const chat = Object.values(window.__parvaneGetGlobal().chats.byId).find((c) => c.title === t);
    return chat && !chat.isNotJoined;
  }, title), 60000, 'вступление не прошло');
  console.log('OK: превью с лентой, вступление без приглашения');

  // ── После вступления: новое сообщение доходит; новичок пишет сам ──
  await sendText(page, afterJoin);
  await bobFeed.filter({ hasText: afterJoin }).first().waitFor({ state: 'visible', timeout: 60000 })
    .catch(() => assert.fail('новое сообщение не дошло до вступившего'));
  const bobLine = `от-боба-${suffix}`;
  await sendText(bobPage, bobLine);
  await page.locator('#MiddleColumn .Message').filter({ hasText: bobLine }).first()
    .waitFor({ state: 'visible', timeout: 60000 }).catch(() => assert.fail('сообщение новичка не дошло владельцу'));
  console.log('OK: переписка в обе стороны после вступления');

  // ── Снова частная: из поиска пропала, имя свободно ──
  const priv = await callProviderForChat(page, 'setChatUsername', title, undefined, { chat: '$chat', username: '' });
  assert.equal(priv.result, true, 'группа снова частная');
  await waitFor(async () => {
    const r = await diagCall(bobPage, 'checkChatUsername', { username: name });
    return r.result === true;
  }, STEP_TIMEOUT_MS, 'имя не освободилось');
  const after = await diagCall(sessions.carol.page, 'searchChats', { query: name.slice(0, 6) });
  const titles = await sessions.carol.page.evaluate((list) => list
    .map((id) => window.__parvaneGetGlobal().chats.byId[id]?.title).filter(Boolean), after?.globalResultIds || []);
  assert(!titles.includes(title), 'частная группа нашлась поиском');
  console.log('OK: частная группа не находится, имя свободно');

  // ── Мастер создания: публичное имя сразу ──
  const title2 = `Сразу-${suffix}`;
  const name2 = `soon_${suffix}`;
  await showChatList(page);
  await createGroupViaUi(page, title2, [carol.split('@')[0]], { publicName: name2 });
  await waitFor(async () => (await chatUsernameOf(page, title2)) === name2, STEP_TIMEOUT_MS,
    'группа из мастера не стала публичной');
  console.log(`OK: мастер создания — группа сразу публичная @${name2}`);

  assert.deepEqual(plaintextLeaks([before, afterPublic, afterJoin, bobLine]), [], 'текст сообщений в базах шардов');
  console.log('e2e_web_public_groups: OK');
} catch (error) {
  for (const [who, session] of Object.entries(sessions)) {
    await dumpDiagJournal(session.page, who).catch(() => {});
    await session.page.screenshot({ path: `${BACKEND_DIR}/public-groups-${who}.png` }).catch(() => {});
    console.log(`--- журнал ${who} ---\n${(session.logs || [])
      .filter((line) => /публичн|v2: |группа|group/i.test(line)).slice(-40).join('\n')}`);
  }
  throw error;
} finally {
  await browser.close();
}
