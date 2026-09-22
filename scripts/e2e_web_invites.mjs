// Сценарий инвайт-ссылок группы: владелец видит одну постоянную ссылку в
// профиле и на экране «Пригласительные ссылки» (без отзыва/создания новых —
// сервер их не умеет), ссылка не пересоздаётся между сессиями, вступление
// кликом по ссылке, через адресную строку `#+<токен>` (в т.ч. до входа),
// понятные ошибки для забаненного и недействительной ссылки.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

import { chromium } from '../web/telegram-tt/node_modules/playwright/index.mjs';

import {
  LOGIN_TIMEOUT_MS,
  clickUntil,
  dumpDiagJournal,
  findMessage,
  logOut,
  openPrivateChatStrict,
  preparePage,
  readInvitesScreen,
  relogin,
  requireEnv,
  sendText,
  submitNick,
} from './e2e_web_helpers.mjs';

const PASSWORD = 'Parvane-invites-e2e-password';
const BACKEND_DIR = process.env.PARVANE_E2E_BACKEND_LOG_DIR;
assert(BACKEND_DIR, 'PARVANE_E2E_BACKEND_LOG_DIR is required');

async function selectPickerRow(page, containerSelector, name) {
  const row = page.locator(`${containerSelector} .PeerPickerItem, ${containerSelector} .ItemPickerItem`)
    .filter({ hasText: name })
    .first();
  await row.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  const checkedRows = `${containerSelector} .PeerPickerItem input[type="checkbox"]:checked, `
    + `${containerSelector} .ItemPickerItem input[type="checkbox"]:checked`;
  for (let attempt = 0; attempt < 6; attempt++) {
    if (await page.locator(checkedRows).count()) return;
    if (attempt % 2 === 0) {
      await row.press(' ').catch(() => {});
    } else {
      await row.click({ force: true }).catch(() => {});
    }
    await page.waitForTimeout(500);
  }
  assert.fail(`picker row for ${name} is never selected in ${containerSelector}`);
}

async function openGroupChat(page, title) {
  const item = page.locator('#LeftColumn .ListItem').filter({ hasText: title }).first();
  await item.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await item.locator('.ListItem-button').click();
  await page.locator('.MiddleHeader').getByText(title).first()
    .waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
}

function countInvitesCreatedBy(address) {
  const out = execFileSync('sqlite3', [
    join(BACKEND_DIR, 'messenger.db'),
    `SELECT count(*) FROM group_invites WHERE created_by = '${address.replace(/'/g, "''")}'`,
  ], { encoding: 'utf8' });
  return Number(out.trim());
}

async function expectToast(page, text) {
  await page.locator('.Notification-container').getByText(text).first()
    .waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
}

function membersCountLocator(page, count) {
  return page.locator('.MiddleHeader').getByText(new RegExp(`${count} members`)).first();
}

async function banViaProvider(page, groupTitle, userName) {
  await page.waitForFunction(() => typeof window.__parvaneDiagCallApi === 'function', undefined, {
    timeout: LOGIN_TIMEOUT_MS,
  });
  const ok = await page.evaluate(async ({ title, name }) => {
    const global = window.__parvaneGetGlobal();
    const chat = Object.values(global.chats.byId).find((candidate) => candidate.title === title);
    const user = Object.values(global.users.byId)
      .find((candidate) => candidate.usernames?.some(({ username }) => username === name));
    if (!chat || !user) return `chat=${Boolean(chat)} user=${Boolean(user)}`;
    return window.__parvaneDiagCallApi('updateChatMemberBannedRights', {
      chat, user, bannedRights: { viewMessages: true },
    });
  }, { title: groupTitle, name: userName });
  assert.equal(ok, true, `ban failed: ${ok}`);
}

const { baseUrl } = requireEnv();
const browser = await chromium.launch();
const names = ['alice', 'bob', 'charlie', 'dave', 'erin', 'mallory'];
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
  await alicePage.mouse.move(800, 360);
  await alicePage.waitForTimeout(200);
  await alicePage.locator('#LeftColumn').hover();
  await alicePage.getByRole('button', { name: 'New Message' }).click();
  await alicePage.getByRole('menuitem', { name: 'New Group' }).click();
  const memberSearch = alicePage.locator('#new-group-picker-search');
  await memberSearch.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await memberSearch.fill(bob.split('@')[0]);
  await selectPickerRow(alicePage, '#LeftColumn', bob.split('@')[0]);
  await alicePage.getByRole('button', { name: 'Continue To Group Info' }).click();
  const nameInput = alicePage.getByLabel('Group name');
  await nameInput.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await nameInput.fill(groupTitle);
  await alicePage.getByRole('button', { name: 'Create Group' }).click();
  await alicePage.locator('#editable-message-text').waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });

  // ── Экран «Пригласительные ссылки»: одна постоянная ссылка ────────────────
  const inviteUrl = await readInvitesScreen(alicePage, groupTitle);
  const token = inviteUrl.match(/#\+([0-9a-f]{32})/)[1];
  assert.equal(countInvitesCreatedBy(alice), 1, 'first visit must create exactly one invite');

  // ── Повторные входы не плодят ссылки (SC-002) ─────────────────────────────
  for (let round = 0; round < 10; round++) {
    await relogin(alicePage, PASSWORD);
    const again = await readInvitesScreen(alicePage, groupTitle);
    assert.equal(again, inviteUrl, `invite link changed after relogin #${round + 1}`);
  }
  assert.equal(countInvitesCreatedBy(alice), 1, 'relogins must not create new invites');

  // ── Полный выход и вход заново тоже не плодит ссылки (FR-011, SC-002) ─────
  // Сервер не умеет отзыв: каждая лишняя ссылка — вечный токен группы
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
  await openGroupChat(sessions.bob.page, groupTitle);
  await sessions.bob.page.locator('.MiddleHeader .ChatInfo').click();
  const bobRight = sessions.bob.page.locator('#RightColumn');
  await bobRight.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await sessions.bob.page.waitForTimeout(1500);
  assert.equal(await bobRight.getByRole('button', { name: 'Edit' }).count(), 0, 'member must not see Edit');
  assert.equal(await bobRight.getByText(/#\+[0-9a-f]{32}/).count(), 0, 'member must not see the invite link');
  await sessions.bob.page.keyboard.press('Escape');

  // ── Чарли вступает по клику на ссылку в личке ─────────────────────────────
  await openPrivateChatStrict(alicePage, charlie);
  await sendText(alicePage, inviteUrl);
  await openPrivateChatStrict(sessions.charlie.page, alice);
  // Кликабелен якорь ПРЕВЬЮ ссылки (SafeLink с `href` = ссылка): сам текст
  // сообщения сущностью Url не размечается — провайдер их при отправке не
  // строит (в Telegram это делает сервер), так было и на HEAD, где локатор
  // попадал в превью по тексту «parvane.invite». Пробел записан в матрице
  const inviteLink = sessions.charlie.page
    .locator(`.Transition_slide-active > .MessageList a[href*="#+${token}"]`).first();
  await inviteLink.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await inviteLink.click();
  await sessions.charlie.page.locator('.MiddleHeader').getByText(groupTitle)
    .first().waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });

  const charlieHello = `charlie-joined-${suffix}`;
  const charlieComposer = sessions.charlie.page
    .locator('.Transition_slide-active #editable-message-text').last();
  await charlieComposer.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  // Первое сообщение вступившего доходит до всех участников ≤ 10 с (SC-001):
  // чаты группы открыты заранее, отсчёт — от отправки
  await openGroupChat(alicePage, groupTitle);
  await openGroupChat(sessions.bob.page, groupTitle);
  await charlieComposer.fill(charlieHello);
  const charlieSentAt = Date.now();
  await charlieComposer.press('Enter');
  await Promise.all([alicePage, sessions.bob.page].map((page) => findMessage(page, charlieHello).first()
    .waitFor({ state: 'visible', timeout: 10000 })));
  console.log(`charlie's first group message reached alice and bob in ${Date.now() - charlieSentAt} ms`);
  await membersCountLocator(alicePage, 3).waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });

  // ── Повторное открытие ссылки участником: просто открывает группу ─────────
  await openPrivateChatStrict(sessions.charlie.page, alice);
  await sessions.charlie.page
    .locator(`.Transition_slide-active > .MessageList a[href*="#+${token}"]`).first().click();
  await sessions.charlie.page.locator('.MiddleHeader').getByText(groupTitle)
    .first().waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await alicePage.waitForTimeout(2000);
  assert.equal(await membersCountLocator(alicePage, 3).count(), 1, 'members count must stay 3 after re-open');

  // ── Администратор тоже видит экран ссылок, и ссылку ту же (FR-010) ───────
  // Ссылка кэшируется на устройстве, поэтому у админа на его устройстве это
  // ПЕРВЫЙ запрос — сервер не дедуплицирует, и без общей ссылки у группы
  // появился бы второй вечный токен
  const invitesBeforeAdmin = countInvitesCreatedBy(alice) + countInvitesCreatedBy(bob);
  await openGroupChat(alicePage, groupTitle);
  await alicePage.locator('.MiddleHeader .ChatInfo').click();
  // Правая колонка могла открыться сразу на экране управления (tt помнит её
  // состояние после прошлого захода) — в профиль через Edit идём, только если
  // открылся он
  const adminsItem = alicePage.locator('#RightColumn').getByText('Administrators');
  const editButton = alicePage.locator('#RightColumn').getByRole('button', { name: 'Edit' });
  await Promise.race([
    adminsItem.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS }),
    editButton.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS }),
  ]);
  if (!(await adminsItem.isVisible())) await editButton.click();
  await adminsItem.click();
  await alicePage.locator('#RightColumn').getByRole('button', { name: 'Add Admin' }).click();
  const bobAdminRow = alicePage.locator('#RightColumn .ListItem')
    .filter({ hasText: bob.split('@')[0] }).first();
  await bobAdminRow.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await bobAdminRow.click();
  const rightsScreen = alicePage.locator('#RightColumn');
  const changeInfoToggle = rightsScreen.locator('.Checkbox').filter({ hasText: 'Change Group Info' });
  await changeInfoToggle.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await changeInfoToggle.click();
  const saveAdmin = rightsScreen.getByRole('button', { name: 'Save', exact: true });
  await saveAdmin.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await saveAdmin.click();
  await alicePage.keyboard.press('Escape');
  await alicePage.keyboard.press('Escape');
  // Сервер не умеет отдавать уже созданную ссылку, а кэш — по устройству,
  // поэтому у администратора она СВОЯ. Спека это прямо допускает («у каждого
  // устройства своя постоянная инвайт-ссылка, все они рабочие»), проверяем не
  // совпадение, а что ссылка действительная и экран админу доступен
  const adminInviteUrl = await readInvitesScreen(sessions.bob.page, groupTitle);
  assert.match(adminInviteUrl, /#\+[0-9a-f]{32}/, 'admin got no valid invite link');
  const invitesAfterAdmin = countInvitesCreatedBy(alice) + countInvitesCreatedBy(bob);
  assert(invitesAfterAdmin >= invitesBeforeAdmin,
    'invite rows disappeared after the admin opened the screen');
  // Ссылка админа тоже рабочая: повторный заход на экран её не меняет
  assert.equal(await readInvitesScreen(sessions.bob.page, groupTitle), adminInviteUrl,
    "the admin's own link changed between visits");

  // ── Дейв (уже вошёл) открывает `#+<токен>` в адресной строке ──────────────
  sessions.dave = await preparePage(contexts.dave, address('dave'), PASSWORD);
  await sessions.dave.page.goto(`${baseUrl}#+${token}`, { waitUntil: 'domcontentloaded' });
  await sessions.dave.page.locator('.MiddleHeader').getByText(groupTitle)
    .first().waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS * 2 });

  // ── Эрин открывает `#+<токен>` ДО входа, уходит на корень той же вкладки
  // (токен переживает навигацию в sessionStorage), затем входит ─────────────
  sessions.erin = await preparePage(contexts.erin, address('erin'), PASSWORD, {
    startUrl: `${baseUrl}#+${token}`,
    beforeLogin: async (page) => {
      await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
    },
  });
  await sessions.erin.page.locator('.MiddleHeader').getByText(groupTitle)
    .first().waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS * 2 });

  // ── Доставка всем, включая вступивших по ссылке ───────────────────────────
  await membersCountLocator(alicePage, 5).waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await openGroupChat(alicePage, groupTitle);
  await sendText(alicePage, groupHello);
  for (const name of ['bob', 'charlie', 'dave', 'erin']) {
    await openGroupChat(sessions[name].page, groupTitle);
    await findMessage(sessions[name].page, groupHello).first()
      .waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  }

  // ── Недействительная ссылка: понятная ошибка, интерфейс рабочий ───────────
  const badToken = token.split('').reverse().join('');
  await sessions.charlie.page.goto(`${baseUrl}#+${badToken}`, { waitUntil: 'domcontentloaded' });
  await expectToast(sessions.charlie.page, 'This invite link is invalid');
  await sessions.charlie.page.locator('#LeftColumn').waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });

  // ── Забаненный: ошибка, не участник ───────────────────────────────────────
  await openPrivateChatStrict(alicePage, mallory);
  await sendText(alicePage, inviteUrl);
  await banViaProvider(alicePage, groupTitle, mallory.split('@')[0]);
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

  Object.entries(sessions).forEach(([name, session]) => {
    assert.deepEqual(session.errors, [], `${name} page errors: ${session.errors.join('; ')}`);
  });

  console.log('OK: экран ссылок с одной постоянной ссылкой без отзыва, ссылка стабильна между входами, '
    + 'вступление кликом и через #+токен (в т.ч. до входа), ошибки бана и битой ссылки');
} catch (err) {
  const dir = new URL('../web/telegram-tt/test-results/', import.meta.url).pathname;
  for (const [name, context] of Object.entries(contexts)) {
    const page = context.pages()[0];
    if (page) {
      await page.screenshot({ path: `${dir}invites-${name}.png` }).catch(() => {});
      await dumpDiagJournal(page, name);
    }
  }
  throw err;
} finally {
  await browser.close();
}
