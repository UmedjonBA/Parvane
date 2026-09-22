// Обход нативного UI: пункты без поддержки в текущем контракте скрыты, а
// экраны управления группой/каналом, профиля, меню сообщений и чатов, панели
// GIF и приватности не вызывают нереализованных методов провайдера
// (spec 002 US8, FR-080…FR-082, SC-012).
import assert from 'node:assert/strict';

import { chromium } from '../web/telegram-tt/node_modules/playwright/index.mjs';

import {
  LOGIN_TIMEOUT_MS,
  addReaction,
  dumpDiagJournal,
  openMessageMenu,
  openPrivateChatStrict,
  preparePage,
  readDiagJournal,
  sendText,
} from './e2e_web_helpers.mjs';

const PASSWORD = 'Parvane-honest-ui-e2e-password';

async function selectPickerRow(page, containerSelector, name) {
  const row = page.locator(`${containerSelector} .PeerPickerItem, ${containerSelector} .ItemPickerItem`)
    .filter({ hasText: name }).first();
  await row.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  for (let attempt = 0; attempt < 6; attempt++) {
    const checked = await row.locator('input[type="checkbox"]:checked').count();
    if (checked > 0) return;
    if (attempt % 2 === 0) await row.press(' ').catch(() => {});
    else await row.click({ force: true }).catch(() => {});
    await page.waitForTimeout(500);
  }
  assert.fail(`picker row for ${name} is never selected`);
}

async function openChatByTitle(page, title) {
  const item = page.locator('#LeftColumn .ListItem').filter({ hasText: title }).first();
  await item.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await item.locator('.ListItem-button').click();
  await page.locator('.MiddleHeader').getByText(title).first().waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
}

// Отметка времени, с которой считаем НОВЫЕ записи. По ПОЗИЦИИ метить нельзя:
// журнал кольцевой (MAX_ENTRIES = 800 в util/parvaneDiag.ts), при переполнении
// начало срезается и индексы уезжают
async function diagJournalMark(page) {
  await page.waitForTimeout(2000); // журнал пишется с задержкой ~1.5 с
  const entries = await readDiagJournal(page);
  return entries.length ? entries[entries.length - 1].t : 0;
}

// Нереализованные методы, вызванные ПОСЛЕ отметки. Сравниваем по времени, а не
// по множеству имён: метод, уже попавший в журнал на старте, не должен
// амнистироваться, если его снова зовёт экран обхода (SC-012)
async function missingMethodsSince(page, sinceTs) {
  await page.waitForTimeout(2000);
  return (await readDiagJournal(page))
    .filter((entry) => entry.k === 'api-missing' && entry.t > sinceTs)
    .map((entry) => entry.d);
}

async function assertAbsent(scope, texts, label) {
  for (const text of texts) {
    const count = await scope.getByText(text, { exact: true }).count();
    assert.equal(count, 0, `${label}: "${text}" must be hidden`);
  }
}

const browser = await chromium.launch();
const aliceContext = await browser.newContext();
const bobContext = await browser.newContext();
const sessions = {};

try {
  const suffix = `${Date.now()}-${process.pid}`;
  const alice = `hu-alice-${suffix}@local`;
  const bob = `hu-bob-${suffix}@local`;
  const aliceName = alice.split('@')[0];
  const bobName = bob.split('@')[0];
  const groupTitle = `HU-G-${suffix.slice(-6)}`;
  const channelTitle = `HU-C-${suffix.slice(-6)}`;

  sessions.alice = await preparePage(aliceContext, alice, PASSWORD);
  sessions.bob = await preparePage(bobContext, bob, PASSWORD);
  const page = sessions.alice.page;
  await openPrivateChatStrict(page, bob);
  await sendText(page, `hi-${suffix}`);
  await openPrivateChatStrict(sessions.bob.page, alice);
  await sendText(sessions.bob.page, `hello-${suffix}`);

  // ── Группа и канал ────────────────────────────────────────────────────────
  await page.mouse.move(800, 360);
  await page.locator('#LeftColumn').hover();
  await page.getByRole('button', { name: 'New Message' }).click();
  await page.getByRole('menuitem', { name: 'New Group' }).click();
  const memberSearch = page.locator('#new-group-picker-search');
  await memberSearch.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await memberSearch.fill(bobName);
  await selectPickerRow(page, '#LeftColumn', bobName);
  await page.getByRole('button', { name: 'Continue To Group Info' }).click();
  await page.getByLabel('Group name').fill(groupTitle);
  await page.getByRole('button', { name: 'Create Group' }).click();
  await page.locator('#editable-message-text').waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });

  await page.mouse.move(800, 360);
  await page.locator('#LeftColumn').hover();
  await page.getByRole('button', { name: 'New Message' }).click();
  await page.getByRole('menuitem', { name: 'New Channel' }).click();
  await selectPickerRow(page, '#LeftColumn', bobName);
  await page.locator('#LeftColumn .FloatingActionButton').click();
  const channelName = page.locator('#LeftColumn .input-group:has(label:has-text("Channel name")) input');
  await channelName.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await channelName.fill(channelTitle);
  await page.getByRole('button', { name: 'Create Channel', exact: true }).click();
  await page.locator('#editable-message-text').waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });

  // Нереализованные методы, вызванные фоном до обхода (синк, стикеры) —
  // обход не должен добавлять новых
  const journalMark = await diagJournalMark(page);

  // ── Управление группой ────────────────────────────────────────────────────
  await openChatByTitle(page, groupTitle);
  await page.locator('.MiddleHeader .ChatInfo').click();
  const right = page.locator('#RightColumn');

  // ── Участники группы с ролями (US8/AC2, FR-081) ───────────────────────────
  // Бейдж роли (RankBadge, «Owner»/«Admin») рисуется только там, где в
  // PrivateChatInfo передан chatMember, — это список участников в ПРОФИЛЕ
  // группы (components/right/Profile.tsx); на экране управления его нет
  const membersTab = right.locator('.Tab').filter({ hasText: 'Members' }).first();
  if (await membersTab.count()) await membersTab.click();
  const memberRows = right.locator('.ListItem.contact-list-item');
  const membersDeadline = Date.now() + LOGIN_TIMEOUT_MS;
  while (await memberRows.count() < 2 && Date.now() < membersDeadline) {
    await page.waitForTimeout(500);
  }
  // Полнота списка: ровно состав группы — владелец alice и участник bob
  assert.equal(await memberRows.count(), 2, 'group profile: members list must hold exactly the group members');
  const ownerRows = memberRows.filter({ hasText: 'Owner' });
  assert.equal(await ownerRows.count(), 1, 'group profile: exactly one owner badge expected');
  assert.match(await ownerRows.first().innerText(), new RegExp(aliceName),
    'group profile: the owner badge must be on the creator');
  const bobRow = memberRows.filter({ hasText: bobName }).first();
  assert.doesNotMatch(await bobRow.innerText(), /Owner|Admin/,
    'group profile: a plain member must carry no rank badge');

  await right.getByRole('button', { name: 'Edit' }).click();
  await right.locator('.Management').waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await page.waitForTimeout(1000);
  await assertAbsent(right, [
    'Description (optional)', 'Group Type', 'Permissions', 'Reactions', 'Topics', 'Chat History For New Members',
    'Member Requests',
  ], 'ManageGroup');
  assert.equal(await right.locator('.AvatarEditable').count(), 0, 'ManageGroup: group photo must be hidden');
  await right.getByText('Administrators').first().waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await right.getByText('Invite Links').first().waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  // Участники с ролями
  await right.getByText('Members').first().click();
  await right.locator('.ListItem').filter({ hasText: bobName }).first()
    .waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');

  // ── Управление каналом ────────────────────────────────────────────────────
  await openChatByTitle(page, channelTitle);
  await page.locator('.MiddleHeader .ChatInfo').click();
  await right.getByRole('button', { name: 'Edit' }).click();
  await right.locator('.Management').waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await page.waitForTimeout(1000);
  await assertAbsent(right, ['Description (optional)', 'Channel Type', 'Discussion', 'Reactions', 'Subscribe Requests'],
    'ManageChannel');
  assert.equal(await right.locator('.AvatarEditable').count(), 0, 'ManageChannel: channel photo must be hidden');
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');

  // ── Контекстное меню группы в списке чатов: нет «Report» ─────────────────
  const groupItem = page.locator('#LeftColumn .ListItem').filter({ hasText: groupTitle }).first();
  await groupItem.click({ button: 'right' });
  await page.waitForTimeout(600);
  assert.equal(await page.getByRole('menuitem', { name: 'Report' }).count(), 0, 'chat list: Report must be hidden');
  // Контекстное меню списка чатов Escape не закрывает — кликаем мимо
  await page.mouse.click(900, 300);
  await page.getByRole('menuitem', { name: 'Archive' }).waitFor({ state: 'hidden', timeout: LOGIN_TIMEOUT_MS });

  // ── Шапка и меню сообщения: нет перевода и жалобы ────────────────────────
  await openPrivateChatStrict(page, bob);
  await page.getByRole('button', { name: 'More actions' }).click();
  await page.waitForTimeout(500);
  assert.equal(await page.getByRole('menuitem', { name: /Translate/ }).count(), 0, 'header: Translate must be hidden');
  assert.equal(await page.getByRole('menuitem', { name: 'Report' }).count(), 0, 'header: Report must be hidden');
  await page.keyboard.press('Escape');
  const message = page.locator('.Transition_slide-active > .MessageList .Message').filter({ hasText: `hello-${suffix}` }).first();
  await message.click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Reply' }).waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  assert.equal(await page.getByRole('menuitem', { name: 'Report' }).count(), 0, 'message menu: Report must be hidden');
  assert.equal(await page.getByRole('menuitem', { name: /Translate/ }).count(), 0,
    'message menu: Translate must be hidden');
  await page.keyboard.press('Escape');

  // ── «Кто отреагировал» (FR-081) ───────────────────────────────────────────
  // В ГРУППЕ селектор реакций не монтируется вовсе: провайдер не отдаёт
  // chatFullInfo.enabledReactions, поэтому withReactions в MessageContextMenu
  // всегда false, и поставить реакцию в группе через меню нельзя. Фиксируем
  // это фактом, иначе проверка «пункт скрыт» ничего не утверждает
  await openChatByTitle(page, groupTitle);
  await sendText(page, `react-${suffix}`);
  const groupMessage = page.locator('.Transition_slide-active > .MessageList .Message')
    .filter({ hasText: `react-${suffix}` }).first();
  await groupMessage.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await groupMessage.click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Reply' }).waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  assert.equal(
    await page.locator('.MessageContextMenu .ReactionSelector').count(), 0,
    'group: reaction selector unexpectedly mounted (provider now supplies enabledReactions?)',
  );
  await page.keyboard.press('Escape');

  // Реакция ставится рабочим путём — в ЛИЧНОМ чате — и только после этого
  // проверяется, что пункт «кто отреагировал» не предлагается: провод не
  // несёт авторов реакций, а `message.reactors` остаётся пустым
  await openPrivateChatStrict(page, bob);
  const reactedText = `reacted-${suffix}`;
  await sendText(page, reactedText);
  await addReaction(page, reactedText, '👍');
  const reactedMessage = page.locator('.Transition_slide-active > .MessageList .Message')
    .filter({ hasText: reactedText }).first();
  await reactedMessage.locator('.message-reaction').filter({ hasText: '👍' })
    .waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await openMessageMenu(page, reactedText);
  await page.getByRole('menuitem', { name: 'Reply' }).waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  // Пункт подписан ChatContextReactionCount = «{count} reactions» — прежняя
  // проверка искала /reacted/ и не совпала бы даже с поставленной реакцией
  for (const label of [/reactions?$/i, /reacted/i]) {
    assert.equal(await page.getByRole('menuitem', { name: label }).count(), 0,
      `message menu: reactors list must be hidden (${label})`);
  }
  await page.keyboard.press('Escape');

  // ── Профиль пользователя (правая колонка из личного чата) ────────────────
  await page.locator('.MiddleHeader .ChatInfo').first().click();
  await right.locator('.Profile, .ProfileInfo').first().waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await right.getByText(bobName).first().waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await page.waitForTimeout(1500);
  await page.keyboard.press('Escape');
  await right.locator('.Profile, .ProfileInfo').first().waitFor({ state: 'hidden', timeout: LOGIN_TIMEOUT_MS })
    .catch(() => {});

  // ── Панель GIF: без поиска ────────────────────────────────────────────────
  await page.getByRole('button', { name: 'Choose emoji, sticker or GIF' }).first().click();
  await page.locator('.SymbolMenu').waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  for (const tab of ['GIFs', 'Stickers']) {
    await page.locator('.SymbolMenu').getByRole('button', { name: tab, exact: true }).click();
    await page.waitForTimeout(400);
    assert.equal(await page.locator('.SymbolMenu .symbol-search-button').count(), 0, `${tab}: search must be hidden`);
  }
  await page.keyboard.press('Escape');

  // ── Приватность: только работающие пункты ────────────────────────────────
  // Шаг обязательный: не нашли меню или пункт — сценарий падает, а не пропускает
  await page.getByRole('button', { name: 'Open menu' }).first().click();
  await page.getByRole('menuitem', { name: 'Settings' }).first().click();
  const privacyItem = page.getByText('Privacy and Security', { exact: true }).first();
  await privacyItem.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await privacyItem.click();
  await page.locator('#LeftColumn').getByText('Blocked Users').first()
    .waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await assertAbsent(page.locator('#LeftColumn'), [
    'Phone Number', 'Last Seen & Online', 'Profile Photos', 'Forwarded Messages', 'Calls', 'Voice Messages',
    'Invites',
  ], 'Privacy');
  await page.keyboard.press('Escape');

  const missingDuringWalkthrough = await missingMethodsSince(page, journalMark);
  assert.deepEqual(missingDuringWalkthrough, [],
    `screens called unimplemented provider methods: ${missingDuringWalkthrough.join(', ')}`);

  Object.entries(sessions).forEach(([name, session]) => {
    assert.deepEqual(session.errors, [], `${name} page errors: ${session.errors.join('; ')}`);
  });
  console.log('OK: нативный UI без мёртвых пунктов — управление группой и каналом, меню чата и сообщения, '
    + 'панель GIF, приватность; обход не вызывает нереализованных методов');
} catch (err) {
  const dir = new URL('../web/telegram-tt/test-results/', import.meta.url).pathname;
  for (const [name, session] of Object.entries(sessions)) {
    await session.page.screenshot({ path: `${dir}honest-ui-${name}.png` }).catch(() => {});
    await dumpDiagJournal(session.page, name);
  }
  throw err;
} finally {
  await browser.close();
}
