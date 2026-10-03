// Сценарий инвайт-ссылок группы (spec 003): у группы одна основная ссылка,
// общая для всех устройств и админов (список сервера), плюс дополнительные с
// лимитом; вступление — через нативную модалку «Join Group» по клику в личке,
// через адресную строку `#+<токен>` (в т.ч. до входа); понятные ошибки для
// забаненного, недействительной, исчерпанной и отозванной ссылки; отзыв,
// раздел «Revoked Links» и удаление; обычный участник управления не видит.
import assert from 'node:assert/strict';

// Сценарий проверяет модель ссылок v1-шарда (токены `#+<hex>`, состояния
// active/expired/exhausted/revoked, список отозванных, declined, записи
// group_invites) — клиенты идут по v1. Ссылки и заявки группы v2 —
// scripts/e2e_protocol_groups.mjs (пара web2-groups)
process.env.PARVANE_E2E_PROTO = 'v1';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

import { chromium } from '../web/telegram-tt/node_modules/playwright/index.mjs';

import {
  LOGIN_TIMEOUT_MS,
  callProviderForChat,
  clickUntil,
  closeRightColumn,
  createGroupViaUi,
  dumpDiagJournal,
  expectToast,
  findMessage,
  inviteTokenOf,
  logOut,
  openGroupChatByTitle,
  openGroupManagement,
  openPrivateChatStrict,
  preparePage,
  readDiagJournal,
  readInvitesScreen,
  relogin,
  requireEnv,
  sendText,
  submitNick,
} from './e2e_web_helpers.mjs';

const PASSWORD = 'Parvane-invites-e2e-password';
const BACKEND_DIR = process.env.PARVANE_E2E_BACKEND_LOG_DIR;
assert(BACKEND_DIR, 'PARVANE_E2E_BACKEND_LOG_DIR is required');
// Изменения группы доезжают нотисом мгновенно; запас — на delta-sync (10 с)
const CONVERGENCE_TIMEOUT_MS = 15000;

function countInvitesCreatedBy(address) {
  const out = execFileSync('sqlite3', [
    join(BACKEND_DIR, 'messenger.db'),
    `SELECT count(*) FROM group_invites WHERE created_by = '${address.replace(/'/g, "''")}'`,
  ], { encoding: 'utf8' });
  return Number(out.trim());
}

// Число участников — по состоянию чата: подпись в шапке временно сменяется
// статусом «is typing», и текст «N members» пропадает
async function waitMembersCount(page, title, count, timeout = LOGIN_TIMEOUT_MS) {
  await page.waitForFunction(({ t, n }) => {
    const global = window.__parvaneGetGlobal();
    const chat = Object.values(global.chats.byId).find((candidate) => candidate.title === t);
    return chat?.membersCount === n;
  }, { t: title, n: count }, { timeout });
}

// Нативная модалка приглашения: кнопка «JOIN GROUP» / «Request to Join»
async function acceptInviteModal(page, buttonName = /join group/i) {
  const modal = page.locator('.Modal .modal-dialog').filter({ has: page.getByRole('button', { name: buttonName }) }).first();
  await modal.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS * 2 });
  await modal.getByRole('button', { name: buttonName }).first().click();
  await modal.waitFor({ state: 'hidden', timeout: LOGIN_TIMEOUT_MS }).catch(() => {});
}

async function openLinkInAddressBar(page, baseUrl, token) {
  await page.goto(`${baseUrl}#+${token}`, { waitUntil: 'domcontentloaded' });
}

async function joinByAddressBar(page, baseUrl, token, groupTitle) {
  await openLinkInAddressBar(page, baseUrl, token);
  await acceptInviteModal(page);
  await page.locator('.MiddleHeader').getByText(groupTitle).first()
    .waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS * 2 });
}

const { baseUrl } = requireEnv();
const browser = await chromium.launch();
const names = ['alice', 'bob', 'charlie', 'dave', 'erin', 'mallory', 'frank', 'grace', 'heidi'];
const contexts = Object.fromEntries(await Promise.all(
  names.map(async (name) => [name, await browser.newContext()]),
));
const sessions = {};

try {
  const suffix = `${Date.now()}-${process.pid}`;
  const address = (name) => `inv-${name}-${suffix}@local`;
  const alice = address('alice');
  const bob = address('bob');
  const charlie = address('charlie');
  const mallory = address('mallory');
  const groupTitle = `Invites ${suffix}`;
  const groupHello = `group-hello-${suffix}`;

  sessions.alice = await preparePage(contexts.alice, alice, PASSWORD);
  sessions.bob = await preparePage(contexts.bob, bob, PASSWORD);
  sessions.charlie = await preparePage(contexts.charlie, charlie, PASSWORD);
  sessions.mallory = await preparePage(contexts.mallory, mallory, PASSWORD);

  await openPrivateChatStrict(sessions.alice.page, bob);
  await sendText(sessions.alice.page, `hi-bob-${suffix}`);
  await openPrivateChatStrict(sessions.alice.page, charlie);
  await sendText(sessions.alice.page, `hi-charlie-${suffix}`);
  await openPrivateChatStrict(sessions.alice.page, mallory);
  await sendText(sessions.alice.page, `hi-mallory-${suffix}`);

  // ── Группа с Бобом ─────────────────────────────────────────────────────────
  const { page: alicePage } = sessions.alice;
  await createGroupViaUi(alicePage, groupTitle, [bob.split('@')[0]]);

  // ── Экран «Пригласительные ссылки»: основная ссылка + «Create a New Link» ─
  const inviteUrl = await readInvitesScreen(alicePage, groupTitle);
  const token = inviteTokenOf(inviteUrl);
  assert.equal(countInvitesCreatedBy(alice), 1, 'first visit must create exactly one invite');

  // ── Повторные входы не плодят ссылки: источник истины — список сервера ────
  for (let round = 0; round < 3; round++) {
    await relogin(alicePage, PASSWORD);
    const again = await readInvitesScreen(alicePage, groupTitle);
    assert.equal(again, inviteUrl, `invite link changed after relogin #${round + 1}`);
  }
  assert.equal(countInvitesCreatedBy(alice), 1, 'relogins must not create new invites');

  // ── Полный выход и вход заново тоже не плодит ссылки ──────────────────────
  await logOut(alicePage);
  await submitNick(alicePage, alice);
  const passwordScreen = alicePage.locator('.Transition_slide-active > #auth-password-form');
  await passwordScreen.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await passwordScreen.locator('#sign-in-password').fill(PASSWORD);
  await clickUntil(
    passwordScreen.getByRole('button', { name: 'Next' }),
    () => alicePage.locator('#LeftColumn').waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS }),
    { settleMs: 15000 },
  );
  const afterLogout = await readInvitesScreen(alicePage, groupTitle);
  assert.equal(afterLogout, inviteUrl, 'invite link changed after a full logout and sign-in');
  assert.equal(countInvitesCreatedBy(alice), 1, 'logout and sign-in must not create a new invite');

  // ── Обычный участник не видит управления ссылками ─────────────────────────
  await openGroupChatByTitle(sessions.bob.page, groupTitle);
  await sessions.bob.page.locator('.MiddleHeader .ChatInfo').click();
  const bobRight = sessions.bob.page.locator('#RightColumn');
  await bobRight.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await sessions.bob.page.waitForTimeout(1500);
  assert.equal(await bobRight.getByRole('button', { name: 'Edit' }).count(), 0, 'member must not see Edit');
  assert.equal(await bobRight.getByText(/#\+[0-9a-f]{32}/).count(), 0, 'member must not see the invite link');
  const bobList = await callProviderForChat(sessions.bob.page, 'fetchExportedChatInvites', groupTitle, undefined, { peer: '$chat' });
  assert.deepEqual(bobList.result, { invites: [] }, `member must not list invites: ${JSON.stringify(bobList)}`);
  await sessions.bob.page.keyboard.press('Escape');

  // ── Чарли вступает по клику на ссылку в личке: превью → «Join Group» ──────
  await openPrivateChatStrict(alicePage, charlie);
  await sendText(alicePage, inviteUrl);
  await openPrivateChatStrict(sessions.charlie.page, alice);
  const inviteLink = sessions.charlie.page
    .locator(`.Transition_slide-active > .MessageList a[href*="#+${token}"]`).first();
  await inviteLink.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await inviteLink.click();
  await sessions.charlie.page.waitForTimeout(3000);
  console.log('charlie after link click:', (await readDiagJournal(sessions.charlie.page)).slice(-12)
    .map((entry) => `${entry.k} ${(entry.d || '').slice(0, 80)}`).join(' | '));
  // Модалка показывает имя группы и число участников до вступления
  const charlieModal = sessions.charlie.page.locator('.Modal .modal-dialog').filter({ hasText: groupTitle }).first();
  await charlieModal.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await charlieModal.getByText(/2 members/).first().waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await acceptInviteModal(sessions.charlie.page);
  await sessions.charlie.page.locator('.MiddleHeader').getByText(groupTitle)
    .first().waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });

  const charlieHello = `charlie-joined-${suffix}`;
  const charlieComposer = sessions.charlie.page
    .locator('.Transition_slide-active #editable-message-text').last();
  await charlieComposer.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await openGroupChatByTitle(alicePage, groupTitle);
  await openGroupChatByTitle(sessions.bob.page, groupTitle);
  await charlieComposer.fill(charlieHello);
  const charlieSentAt = Date.now();
  await charlieComposer.press('Enter');
  await Promise.all([alicePage, sessions.bob.page].map((page) => findMessage(page, charlieHello).first()
    .waitFor({ state: 'visible', timeout: 10000 })));
  console.log(`charlie's first group message reached alice and bob in ${Date.now() - charlieSentAt} ms`);
  // Состав у владельца обновился нотисом без перезагрузки
  await waitMembersCount(alicePage, groupTitle, 3, CONVERGENCE_TIMEOUT_MS);

  // ── Повторное открытие ссылки участником: просто открывает группу ─────────
  await openPrivateChatStrict(sessions.charlie.page, alice);
  await sessions.charlie.page
    .locator(`.Transition_slide-active > .MessageList a[href*="#+${token}"]`).first().click();
  await sessions.charlie.page.locator('.MiddleHeader').getByText(groupTitle)
    .first().waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  assert.equal(await sessions.charlie.page.locator('.Modal .modal-dialog').filter({ hasText: groupTitle }).count(), 0,
    'a member must not see the join modal again');
  await alicePage.waitForTimeout(2000);
  await waitMembersCount(alicePage, groupTitle, 3, 5000);

  // ── Администратор видит ТУ ЖЕ основную ссылку (список сервера) ────────────
  const promoted = await callProviderForChat(alicePage, 'updateChatAdmin', groupTitle, bob.split('@')[0], {
    peer: '$chat', adminRights: { inviteUsers: true, changeInfo: true },
  });
  assert.equal(promoted.result, true, `promote failed: ${JSON.stringify(promoted)}`);
  const adminInviteUrl = await readInvitesScreen(sessions.bob.page, groupTitle);
  assert.equal(adminInviteUrl, inviteUrl, 'admin must see the same primary link as the owner');
  assert.equal(countInvitesCreatedBy(bob), 0, 'admin opening the screen must not mint a link');

  // ── Дейв (уже вошёл) открывает `#+<токен>` в адресной строке ──────────────
  sessions.dave = await preparePage(contexts.dave, address('dave'), PASSWORD);
  await joinByAddressBar(sessions.dave.page, baseUrl, token, groupTitle);

  // ── Эрин открывает `#+<токен>` ДО входа, уходит на корень той же вкладки
  // (токен переживает навигацию в sessionStorage), затем входит ─────────────
  sessions.erin = await preparePage(contexts.erin, address('erin'), PASSWORD, {
    startUrl: `${baseUrl}#+${token}`,
    beforeLogin: async (page) => {
      await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
    },
  });
  await acceptInviteModal(sessions.erin.page);
  await sessions.erin.page.locator('.MiddleHeader').getByText(groupTitle)
    .first().waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS * 2 });

  // ── Доставка всем, включая вступивших по ссылке ───────────────────────────
  await waitMembersCount(alicePage, groupTitle, 5, CONVERGENCE_TIMEOUT_MS);
  await openGroupChatByTitle(alicePage, groupTitle);
  await sendText(alicePage, groupHello);
  for (const name of ['bob', 'charlie', 'dave', 'erin']) {
    await openGroupChatByTitle(sessions[name].page, groupTitle);
    await findMessage(sessions[name].page, groupHello).first()
      .waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  }

  // ── Недействительная ссылка: понятная ошибка, интерфейс рабочий ───────────
  const badToken = token.split('').reverse().join('');
  await openLinkInAddressBar(sessions.charlie.page, baseUrl, badToken);
  await expectToast(sessions.charlie.page, 'This invite link is invalid');
  await sessions.charlie.page.locator('#LeftColumn').waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });

  // ── Забаненный: ошибка, не участник ───────────────────────────────────────
  await openPrivateChatStrict(alicePage, mallory);
  await sendText(alicePage, inviteUrl);
  const banned = await callProviderForChat(alicePage, 'updateChatMemberBannedRights', groupTitle, mallory.split('@')[0], {
    peer: '$chat', bannedRights: { viewMessages: true },
  });
  assert.equal(banned.result, true, `ban failed: ${JSON.stringify(banned)}`);
  await openPrivateChatStrict(sessions.mallory.page, alice);
  const malloryLink = sessions.mallory.page
    .locator(`.Transition_slide-active > .MessageList a[href*="#+${token}"]`).first();
  await malloryLink.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await malloryLink.click();
  await expectToast(sessions.mallory.page, 'You are banned in this group');
  await sessions.mallory.page.waitForTimeout(1500);
  assert.equal(
    await sessions.mallory.page.locator('#LeftColumn .ListItem').filter({ hasText: groupTitle }).count(),
    0,
    'banned user must not get the group',
  );

  // ── Дополнительная ссылка с лимитом 1 через нативный экран ────────────────
  const right = await openGroupManagement(alicePage, groupTitle);
  await right.locator('.ListItem').filter({ hasText: 'Invite Links' }).first().click();
  const invitesScreen = right.locator('.ManageInvites');
  await invitesScreen.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await invitesScreen.getByText('Create a New Link').first().click();
  // Форма «New Link»: первый input экрана — тумблер одобрения, поэтому поле
  // названия ищем по placeholder; ждём конец анимации перехода
  const linkName = right.getByPlaceholder('Link Name (Optional)').first();
  await linkName.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await alicePage.waitForTimeout(700);
  await linkName.fill(`limit-1-${suffix.slice(-4)}`);
  // Лимит использований: радио «1»
  const usageOne = right.locator('input[name="usageOptions"][value="1"]').first();
  await usageOne.waitFor({ state: 'attached', timeout: LOGIN_TIMEOUT_MS });
  await usageOne.check({ force: true });
  await right.getByRole('button', { name: 'Create Link' }).click();
  // В списке появилась ссылка с названием и лимитом
  const limitedRow = invitesScreen.locator('.ListItem').filter({ hasText: `limit-1-${suffix.slice(-4)}` }).first();
  await limitedRow.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  const limitedLinks = await callProviderForChat(alicePage, 'fetchExportedChatInvites', groupTitle, undefined, { peer: '$chat' });
  const limited = limitedLinks.result.invites.find((invite) => invite.title === `limit-1-${suffix.slice(-4)}`);
  assert(limited && limited.usageLimit === 1, `limited link not listed: ${JSON.stringify(limitedLinks)}`);
  const limitedToken = inviteTokenOf(limited.link);
  await alicePage.keyboard.press('Escape');
  await alicePage.keyboard.press('Escape');
  await alicePage.keyboard.press('Escape');

  sessions.frank = await preparePage(contexts.frank, address('frank'), PASSWORD);
  await joinByAddressBar(sessions.frank.page, baseUrl, limitedToken, groupTitle);
  sessions.grace = await preparePage(contexts.grace, address('grace'), PASSWORD);
  await openLinkInAddressBar(sessions.grace.page, baseUrl, limitedToken);
  await expectToast(sessions.grace.page, 'This invite link has reached its usage limit');
  await sessions.grace.page.waitForTimeout(1000);
  assert.equal(await sessions.grace.page.locator('#LeftColumn .ListItem').filter({ hasText: groupTitle }).count(), 0,
    'exhausted link must not admit');
  // Счётчик вступивших по лимитной ссылке = 1/1 в списке владельца
  const afterFrank = await callProviderForChat(alicePage, 'fetchExportedChatInvites', groupTitle, undefined, { peer: '$chat' });
  const limitedAfter = afterFrank.result.invites.find((invite) => inviteTokenOf(invite.link) === limitedToken);
  assert.equal(limitedAfter?.usage, 1, `usage must be 1: ${JSON.stringify(limitedAfter)}`);

  // ── Отзыв основной ссылки: раздел «Revoked Links», удаление ───────────────
  const right2 = await openGroupManagement(alicePage, groupTitle);
  await right2.locator('.ListItem').filter({ hasText: 'Invite Links' }).first().click();
  await right2.locator('.ManageInvites').waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  const primaryMenu = right2.locator('.ManageInvites').getByRole('button', { name: /menu|more/i }).first();
  await primaryMenu.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await primaryMenu.click();
  await alicePage.getByRole('menuitem', { name: 'Revoke' }).first().click();
  // Подтверждение — нативный ConfirmDialog (корень `.Modal` Playwright не
  // считает видимым, ждём диалог)
  const confirm = alicePage.locator('.Modal .modal-dialog').getByRole('button', { name: /Revoke/i }).first();
  await confirm.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await confirm.click();
  await right2.getByText('Revoked Links').first().waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await closeRightColumn(alicePage);
  // Новая основная ссылка создана автоматически и отличается от отозванной
  const newPrimary = await readInvitesScreen(alicePage, groupTitle);
  assert.notEqual(newPrimary, inviteUrl, 'a new primary link must replace the revoked one');
  sessions.heidi = await preparePage(contexts.heidi, address('heidi'), PASSWORD);
  await openLinkInAddressBar(sessions.heidi.page, baseUrl, token);
  await expectToast(sessions.heidi.page, 'This invite link was revoked');
  await sessions.heidi.page.waitForTimeout(1000);
  assert.equal(await sessions.heidi.page.locator('#LeftColumn .ListItem').filter({ hasText: groupTitle }).count(), 0,
    'revoked link must not admit');
  // Новая основная пускает
  await joinByAddressBar(sessions.heidi.page, baseUrl, inviteTokenOf(newPrimary), groupTitle);
  // Удаление отозванной
  const deleted = await callProviderForChat(alicePage, 'deleteExportedChatInvite', groupTitle, undefined, { peer: '$chat', link: inviteUrl });
  assert.equal(deleted.result, true, `delete revoked failed: ${JSON.stringify(deleted)}`);
  const revokedLeft = await callProviderForChat(alicePage, 'fetchExportedChatInvites', groupTitle, undefined, { peer: '$chat', isRevoked: true });
  assert.deepEqual(revokedLeft.result, { invites: [] }, `revoked list must be empty: ${JSON.stringify(revokedLeft)}`);
  await openLinkInAddressBar(sessions.grace.page, baseUrl, token);
  await expectToast(sessions.grace.page, 'This invite link is invalid');

  Object.entries(sessions).forEach(([name, session]) => {
    assert.deepEqual(session.errors, [], `${name} page errors: ${session.errors.join('; ')}`);
  });

  console.log('OK: основная ссылка общая для владельца и админа, стабильна между входами; вступление через '
    + 'модалку по клику и #+токен (в т.ч. до входа); лимит, отзыв, revoked-раздел, удаление; ошибки бана, '
    + 'исчерпания, отзыва и битой ссылки');
} catch (err) {
  const dir = new URL('../web/telegram-tt/test-results/', import.meta.url).pathname;
  for (const [name, context] of Object.entries(contexts)) {
    const page = context.pages()[0];
    if (page) {
      await page.screenshot({ path: `${dir}invites-${name}.png` }).catch(() => {});
      await dumpDiagJournal(page, name, name === 'charlie' ? 200 : 40);
    }
  }
  throw err;
} finally {
  await browser.close();
}
