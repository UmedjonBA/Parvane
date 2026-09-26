// Управление группой (spec 003): фото и описание (US1), права участников по
// умолчанию (US2), заявки на вступление (US5), доставка изменений группы
// открытым экранам без перезагрузки и догон отсутствовавшего устройства
// (US6, conformance GROUP-1). Три основных браузера (alice — владелец, bob,
// carol) плюс вступающие dave/erin/frank.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { chromium } from '../web/telegram-tt/node_modules/playwright/index.mjs';

import {
  LOGIN_TIMEOUT_MS,
  buildPngBuffer,
  callProviderForChat,
  clickUntil,
  closeRightColumn,
  createGroupViaUi,
  dumpDiagJournal,
  expectToast,
  findMessage,
  inviteTokenOf,
  openGroupChatByTitle,
  openGroupManagement,
  openPrivateChatStrict,
  preparePage as preparePageShared,
  readDiagJournal,
  relogin,
  requireEnv,
  sendText,
} from './e2e_web_helpers.mjs';

const PASSWORD = 'Parvane-group-info-e2e-password';
// Изменение группы доезжает нотисом в инбокс мгновенно; 10 с — SC-001
const CONVERGENCE_TIMEOUT_MS = 10000;
const preparePage = (context, user, options) => preparePageShared(context, user, PASSWORD, options);

// Возвращение того же устройства: новая страница в сохранённом контексте
async function reopenDevice(context) {
  const { baseUrl } = requireEnv();
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (err) => errors.push(err.message));
  await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
  const passwordScreen = page.locator('.Transition_slide-active > #auth-password-form');
  const leftColumn = page.locator('#LeftColumn');
  await Promise.race([
    passwordScreen.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS }),
    leftColumn.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS }),
  ]);
  if (await passwordScreen.isVisible()) {
    await passwordScreen.locator('#sign-in-password').fill(PASSWORD);
    await clickUntil(
      passwordScreen.getByRole('button', { name: 'Next' }),
      () => leftColumn.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS }),
      { settleMs: 15000 },
    );
  }
  await leftColumn.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  return { page, errors };
}

// Профиль группы в правой колонке (не экран управления)
async function openGroupProfile(page, title) {
  await openGroupChatByTitle(page, title);
  const right = page.locator('#RightColumn');
  if (!(await right.locator('.Profile, .ProfileInfo').first().isVisible().catch(() => false))) {
    await page.locator('.MiddleHeader .ChatInfo').click();
  }
  await right.locator('.Profile, .ProfileInfo').first().waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  // После прежних заходов колонка может открыться на экране управления
  const back = right.getByRole('button', { name: /Back|Close/ }).first();
  if (await right.locator('.Management').isVisible().catch(() => false)) {
    await back.click().catch(() => {});
    await right.locator('.Profile, .ProfileInfo').first().waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  }
  return right;
}

// Аватар в шапке чата: картинка (не инициалы)
async function waitHeaderAvatarImage(page, timeout = CONVERGENCE_TIMEOUT_MS) {
  await page.waitForFunction(() => {
    const img = document.querySelector('.MiddleHeader .ChatInfo .Avatar img');
    return Boolean(img && img.getAttribute('src'));
  }, undefined, { timeout });
}

async function waitHeaderAvatarInitials(page, timeout = CONVERGENCE_TIMEOUT_MS) {
  await page.waitForFunction(() => !document.querySelector('.MiddleHeader .ChatInfo .Avatar img'), undefined, { timeout });
}

async function setDescriptionViaUi(page, title, about) {
  const right = await openGroupManagement(page, title);
  const aboutField = right.locator('#group-about');
  await aboutField.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await aboutField.fill(about);
  await right.getByRole('button', { name: 'Save', exact: true }).last().click();
  await page.waitForFunction(() => {
    const fab = document.querySelector('#RightColumn .FloatingActionButton');
    return !fab || !fab.classList.contains('revealed');
  }, undefined, { timeout: LOGIN_TIMEOUT_MS });
  await closeRightColumn(page);
}

async function setPhotoViaUi(page, title, pngPath) {
  const right = await openGroupManagement(page, title);
  const input = right.locator('.AvatarEditable input[type="file"]');
  await input.waitFor({ state: 'attached', timeout: LOGIN_TIMEOUT_MS });
  await input.setInputFiles(pngPath);
  // tt открывает кроп-модалку «Drag to reposition» — подтверждаем круглой
  // кнопкой-галкой (корень `.Modal` не считается видимым, ждём диалог)
  const cropDialog = page.locator('.Modal.CropModal .modal-dialog');
  await cropDialog.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await cropDialog.locator('button').last().click();
  await cropDialog.waitFor({ state: 'hidden', timeout: LOGIN_TIMEOUT_MS });
  await right.getByRole('button', { name: 'Save', exact: true }).last().click();
  await page.waitForFunction(() => {
    const fab = document.querySelector('#RightColumn .FloatingActionButton');
    return !fab || !fab.classList.contains('revealed');
  }, undefined, { timeout: LOGIN_TIMEOUT_MS });
  await closeRightColumn(page);
}

// Ключ запрета tt, который правит чекбокс экрана Permissions
const PERMISSION_KEYS = { 'Send Messages': 'sendPlain', 'Send Media': 'sendMedia', 'Add Users': 'inviteUsers' };

async function readPermissionBanned(page, title, key) {
  return page.evaluate(({ title: t, key: k }) => {
    const global = window.__parvaneGetGlobal();
    const chat = Object.values(global.chats.byId).find((candidate) => candidate.title === t);
    return Boolean(chat?.defaultBannedRights?.[k]);
  }, { title, key });
}

async function togglePermission(page, title, label, { expectChecked }) {
  const key = PERMISSION_KEYS[label];
  const right = await openGroupManagement(page, title);
  await right.locator('.ListItem').filter({ hasText: 'Permissions' }).first().click();
  const screen = right.locator('.Management');
  await screen.getByText('What can members of this group do?').first().waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await page.waitForTimeout(600); // анимация перехода
  const box = screen.locator('.Checkbox').filter({ hasText: label }).first();
  await box.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  const input = box.locator('input[type="checkbox"]');
  const fab = right.locator('.FloatingActionButton.revealed');
  for (let attempt = 0; attempt < 4; attempt++) {
    if ((await input.isChecked()) === expectChecked && await fab.count()) break;
    // Клик по самому чекбоксу: у «Send Media» подпись открывает список
    // подпунктов, а не переключает
    // Нативный click по скрытому input (size 0): force-клик Playwright попадает в подпись
    if ((await input.isChecked()) !== expectChecked) await input.evaluate((el) => el.click());
    await page.waitForTimeout(500);
  }
  assert.equal(await input.isChecked(), expectChecked, `${label} toggle did not switch`);
  await fab.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await fab.last().click();
  // Сохранение подтверждается состоянием чата (права пришли с сервера)
  await page.waitForFunction(({ t, k, banned }) => {
    const global = window.__parvaneGetGlobal();
    const chat = Object.values(global.chats.byId).find((candidate) => candidate.title === t);
    return Boolean(chat?.defaultBannedRights?.[k]) === banned;
  }, { t: title, k: key, banned: !expectChecked }, { timeout: LOGIN_TIMEOUT_MS });
  await closeRightColumn(page);
  assert.equal(await readPermissionBanned(page, title, key), !expectChecked, `${label}: server state mismatch`);
}

async function acceptInviteModal(page, buttonName) {
  const modal = page.locator('.Modal .modal-dialog').filter({ has: page.getByRole('button', { name: buttonName }) }).first();
  await modal.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS * 2 });
  await modal.getByRole('button', { name: buttonName }).first().click();
  await modal.waitFor({ state: 'hidden', timeout: LOGIN_TIMEOUT_MS }).catch(() => {});
}

const { baseUrl } = requireEnv();
const browser = await chromium.launch();
const names = ['alice', 'bob', 'carol', 'dave', 'erin', 'frank', 'grace'];
const contexts = Object.fromEntries(await Promise.all(names.map(async (name) => [name, await browser.newContext()])));
const sessions = {};
let fixtureDir;

try {
  const suffix = `${Date.now()}-${process.pid}`;
  const address = (name) => `gi-${name}-${suffix}@local`;
  const nick = (name) => address(name).split('@')[0];
  const groupTitle = `GI-${suffix.slice(-6)}`;
  fixtureDir = mkdtempSync(join(tmpdir(), 'pv-group-info-'));
  const pngPath = join(fixtureDir, 'group.png');
  writeFileSync(pngPath, buildPngBuffer(96));

  sessions.alice = await preparePage(contexts.alice, address('alice'));
  sessions.bob = await preparePage(contexts.bob, address('bob'));
  sessions.carol = await preparePage(contexts.carol, address('carol'));
  await openPrivateChatStrict(sessions.alice.page, address('bob'));
  await sendText(sessions.alice.page, `hi-bob-${suffix}`);
  await openPrivateChatStrict(sessions.alice.page, address('carol'));
  await sendText(sessions.alice.page, `hi-carol-${suffix}`);
  const alicePage = sessions.alice.page;
  await createGroupViaUi(alicePage, groupTitle, [nick('bob'), nick('carol')]);
  await openGroupChatByTitle(sessions.bob.page, groupTitle);
  await openGroupChatByTitle(sessions.carol.page, groupTitle);

  // ══ US1: фото и описание ═══════════════════════════════════════════════════
  const about1 = `Описание ${suffix.slice(-6)}`;
  await setDescriptionViaUi(alicePage, groupTitle, about1);
  // Bob видит описание в профиле группы без перезагрузки
  const bobProfile = await openGroupProfile(sessions.bob.page, groupTitle);
  await bobProfile.getByText(about1).first().waitFor({ state: 'visible', timeout: CONVERGENCE_TIMEOUT_MS });
  // Участник не редактирует: кнопки Edit нет, а сервер отклоняет обход
  assert.equal(await bobProfile.getByRole('button', { name: 'Edit' }).count(), 0, 'member must not see Edit');
  const bobAbout = await callProviderForChat(sessions.bob.page, 'updateChatAbout', groupTitle, undefined, ['$chat', 'взлом']);
  assert.equal(bobAbout.result, null, `member must not change the description: ${JSON.stringify(bobAbout)}`);
  await closeRightColumn(sessions.bob.page);

  await setPhotoViaUi(alicePage, groupTitle, pngPath);
  const photoSetAt = Date.now();
  await openGroupChatByTitle(sessions.bob.page, groupTitle);
  await waitHeaderAvatarImage(sessions.bob.page);
  console.log(`group photo reached bob in ${Date.now() - photoSetAt} ms`);
  await openGroupChatByTitle(sessions.carol.page, groupTitle);
  await waitHeaderAvatarImage(sessions.carol.page);

  // Лимит описания: 255 принимается, 256 отклоняет сервер
  const ok255 = await callProviderForChat(alicePage, 'updateChatAbout', groupTitle, undefined, ['$chat', 'я'.repeat(255)]);
  assert.equal(ok255.result, true, `255 chars must be accepted: ${JSON.stringify(ok255)}`);
  const bad256 = await callProviderForChat(alicePage, 'updateChatAbout', groupTitle, undefined, ['$chat', 'я'.repeat(256)]);
  assert.equal(bad256.result, null, `256 chars must be rejected: ${JSON.stringify(bad256)}`);
  await setDescriptionViaUi(alicePage, groupTitle, about1);

  // Вступивший позже (dave, по ссылке) видит фото и описание сразу
  const invite = await callProviderForChat(alicePage, 'exportChatInvite', groupTitle, undefined, { peer: '$chat' });
  const primaryToken = inviteTokenOf(invite.result.link);
  assert(primaryToken, `no primary link: ${JSON.stringify(invite)}`);
  sessions.dave = await preparePage(contexts.dave, address('dave'));
  await sessions.dave.page.goto(`${baseUrl}#+${primaryToken}`, { waitUntil: 'domcontentloaded' });
  // Модалка приглашения показывает фото и описание группы до вступления
  const daveModal = sessions.dave.page.locator('.Modal .modal-dialog').filter({ hasText: groupTitle }).first();
  await daveModal.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS * 2 });
  await daveModal.getByText(about1).first().waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await acceptInviteModal(sessions.dave.page, /join group/i);
  await sessions.dave.page.locator('.MiddleHeader').getByText(groupTitle).first()
    .waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await waitHeaderAvatarImage(sessions.dave.page, LOGIN_TIMEOUT_MS);
  const daveProfile = await openGroupProfile(sessions.dave.page, groupTitle);
  await daveProfile.getByText(about1).first().waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await closeRightColumn(sessions.dave.page);

  // После перезагрузки фото и описание на месте (у владельца и участника)
  await relogin(alicePage, PASSWORD);
  await openGroupChatByTitle(alicePage, groupTitle);
  await waitHeaderAvatarImage(alicePage, LOGIN_TIMEOUT_MS);
  await relogin(sessions.bob.page, PASSWORD);
  const bobProfileAgain = await openGroupProfile(sessions.bob.page, groupTitle);
  await bobProfileAgain.getByText(about1).first().waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await closeRightColumn(sessions.bob.page);

  // Снять фото: у всех снова инициалы
  const cleared = await callProviderForChat(alicePage, 'editChatPhoto', groupTitle, undefined, { peer: '$chat' });
  assert.equal(cleared.result, true, `clear photo failed: ${JSON.stringify(cleared)}`);
  await openGroupChatByTitle(sessions.carol.page, groupTitle);
  await waitHeaderAvatarInitials(sessions.carol.page);
  await setPhotoViaUi(alicePage, groupTitle, pngPath);
  await waitHeaderAvatarImage(sessions.carol.page);

  // ══ US2: права участников по умолчанию ═════════════════════════════════════
  await openGroupChatByTitle(sessions.bob.page, groupTitle);
  await togglePermission(alicePage, groupTitle, 'Send Messages', { expectChecked: false });
  const restrictedAt = Date.now();
  await sessions.bob.page.locator('.messaging-disabled').first()
    .waitFor({ state: 'visible', timeout: CONVERGENCE_TIMEOUT_MS });
  console.log(`send restriction reached bob in ${Date.now() - restrictedAt} ms`);
  await sessions.bob.page.getByText('Sending messages is not allowed in this group').first()
    .waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  assert.equal(await sessions.bob.page.locator('.Transition_slide-active #editable-message-text').count(), 0,
    'restricted member must have no composer');
  // Владелец пишет; участник в обход композера — сервер отклоняет (у alice не видно)
  await openGroupChatByTitle(alicePage, groupTitle);
  await sendText(alicePage, `owner-writes-${suffix}`);
  await findMessage(sessions.bob.page, `owner-writes-${suffix}`).first()
    .waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await callProviderForChat(sessions.bob.page, 'sendMessage', groupTitle, undefined, { chat: '$chat', text: `bypass-${suffix}` })
    .catch(() => undefined);
  await alicePage.waitForTimeout(4000);
  assert.equal(await findMessage(alicePage, `bypass-${suffix}`).count(), 0,
    'server must drop a message from a member without send_messages');
  // Включили обратно — bob пишет
  await togglePermission(alicePage, groupTitle, 'Send Messages', { expectChecked: true });
  await sessions.bob.page.locator('.Transition_slide-active #editable-message-text').last()
    .waitFor({ state: 'visible', timeout: CONVERGENCE_TIMEOUT_MS });
  await sendText(sessions.bob.page, `bob-again-${suffix}`);
  await findMessage(alicePage, `bob-again-${suffix}`).first().waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });

  // «Add Users» выключено — участник не добавляет (UI и сервер)
  sessions.erin = await preparePage(contexts.erin, address('erin'));
  await openPrivateChatStrict(sessions.bob.page, address('erin'));
  await sendText(sessions.bob.page, `hi-erin-${suffix}`);
  await togglePermission(alicePage, groupTitle, 'Add Users', { expectChecked: false });
  await sessions.bob.page.waitForTimeout(2000);
  const addDenied = await callProviderForChat(sessions.bob.page, 'addChatMembers', groupTitle, nick('erin'), ['$chat', ['$user']]);
  assert.equal(addDenied.result, null, `member without invite_users must not add: ${JSON.stringify(addDenied)}`);
  await togglePermission(alicePage, groupTitle, 'Add Users', { expectChecked: true });
  await sessions.bob.page.waitForTimeout(2000);
  const addOk = await callProviderForChat(sessions.bob.page, 'addChatMembers', groupTitle, nick('erin'), ['$chat', ['$user']]);
  assert.equal(addOk.result, true, `member with invite_users must add: ${JSON.stringify(addOk)}`);

  // «Send Media» выключено: у bob нет кнопки вложений, а фото в обход
  // композера у alice не показывается (приёмный фильтр FR-009)
  await openGroupChatByTitle(sessions.bob.page, groupTitle);
  await togglePermission(alicePage, groupTitle, 'Send Media', { expectChecked: false });
  // Кнопка вложений в tt остаётся, запрет применяется к пунктам меню —
  // сходимость права у bob проверяем по состоянию чата (нотис ≤10 с)
  await sessions.bob.page.waitForFunction(({ t }) => {
    const global = window.__parvaneGetGlobal();
    const chat = Object.values(global.chats.byId).find((candidate) => candidate.title === t);
    return Boolean(chat?.defaultBannedRights?.sendMedia && chat?.defaultBannedRights?.sendPhotos);
  }, { t: groupTitle }, { timeout: CONVERGENCE_TIMEOUT_MS });
  await sessions.bob.page.getByRole('button', { name: 'Add an attachment' }).first().click().catch(() => {});
  await sessions.bob.page.waitForTimeout(600);
  assert.equal(await sessions.bob.page.getByRole('menuitem', { name: 'Photo or Video' }).count(), 0,
    'member without send_media must not be offered Photo or Video');
  await sessions.bob.page.keyboard.press('Escape');
  // Журнал кольцевой (MAX_ENTRIES) — считать по метке времени, не по индексу
  const journalMark = Date.now();
  await sessions.bob.page.evaluate(async ({ title, caption }) => {
    const global = window.__parvaneGetGlobal();
    const chat = Object.values(global.chats.byId).find((candidate) => candidate.title === title);
    const canvas = document.createElement('canvas');
    canvas.width = 8;
    canvas.height = 8;
    canvas.getContext('2d').fillRect(0, 0, 8, 8);
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
    return window.__parvaneDiagCallApi('sendMessage', {
      chat,
      text: caption,
      attachment: {
        blob, blobUrl: URL.createObjectURL(blob), filename: 'bypass.png', mimeType: 'image/png', size: blob.size, quick: { width: 8, height: 8 },
      },
    });
  }, { title: groupTitle, caption: `media-bypass-${suffix}` }).catch(() => undefined);
  await alicePage.waitForTimeout(5000);
  assert.equal(await findMessage(alicePage, `media-bypass-${suffix}`).count(), 0,
    'media from a member without send_media must be hidden on receive');
  const hidden = (await readDiagJournal(alicePage)).filter((entry) => entry.k === 'group-perm-hidden' && entry.t >= journalMark - 1000);
  assert(hidden.length >= 1, 'receiver must journal the hidden message as group-perm-hidden');
  await togglePermission(alicePage, groupTitle, 'Send Media', { expectChecked: true });

  // Участник экрана «Permissions» не видит (нет Edit) — проверено выше

  // ══ US6: изменения доходят до открытых экранов и отсутствовавшего устройства ═
  const bobOpenProfile = await openGroupProfile(sessions.bob.page, groupTitle);
  const about2 = `Обновлено ${suffix.slice(-6)}`;
  const changedAt = Date.now();
  await setDescriptionViaUi(alicePage, groupTitle, about2);
  await bobOpenProfile.getByText(about2).first().waitFor({ state: 'visible', timeout: CONVERGENCE_TIMEOUT_MS });
  console.log(`description change reached bob's open profile in ${Date.now() - changedAt} ms`);
  // Роль: bob становится админом — у него появляется Edit без перезагрузки
  const promote = await callProviderForChat(alicePage, 'updateChatAdmin', groupTitle, nick('bob'), {
    peer: '$chat', adminRights: { changeInfo: true, pinMessages: true },
  });
  assert.equal(promote.result, true, `promote failed: ${JSON.stringify(promote)}`);
  await bobOpenProfile.getByRole('button', { name: 'Edit' }).waitFor({ state: 'visible', timeout: CONVERGENCE_TIMEOUT_MS });
  // Состав: у bob в профиле появляется frank после добавления владельцем
  sessions.frank = await preparePage(contexts.frank, address('frank'));
  await openPrivateChatStrict(alicePage, address('frank'));
  await sendText(alicePage, `hi-frank-${suffix}`);
  const added = await callProviderForChat(alicePage, 'addChatMembers', groupTitle, nick('frank'), ['$chat', ['$user']]);
  assert.equal(added.result, true, `add frank failed: ${JSON.stringify(added)}`);
  const membersTab = bobOpenProfile.locator('.Tab').filter({ hasText: 'Members' }).first();
  if (await membersTab.count()) await membersTab.click();
  await bobOpenProfile.locator('.ListItem').filter({ hasText: nick('frank') }).first()
    .waitFor({ state: 'visible', timeout: CONVERGENCE_TIMEOUT_MS });
  await closeRightColumn(sessions.bob.page);
  // Удалённый теряет группу без перезагрузки
  const removed = await callProviderForChat(alicePage, 'deleteChatMember', groupTitle, nick('carol'), ['$chat', '$user']);
  assert.equal(removed.result, true, `remove carol failed: ${JSON.stringify(removed)}`);
  await sessions.carol.page.locator('#LeftColumn .ListItem').filter({ hasText: groupTitle }).first()
    .waitFor({ state: 'detached', timeout: CONVERGENCE_TIMEOUT_MS });

  // «Устройство отсутствовало»: dave закрывает страницу, alice меняет описание
  // трижды и фото, dave возвращается тем же устройством и видит итог
  await sessions.dave.page.close();
  const finalAbout = `Итог ${suffix.slice(-6)}`;
  for (const text of [`Промежуточное-1 ${suffix.slice(-4)}`, `Промежуточное-2 ${suffix.slice(-4)}`, finalAbout]) {
    const r = await callProviderForChat(alicePage, 'updateChatAbout', groupTitle, undefined, ['$chat', text]);
    assert.equal(r.result, true, `updateChatAbout failed: ${JSON.stringify(r)}`);
  }
  const clearedAgain = await callProviderForChat(alicePage, 'editChatPhoto', groupTitle, undefined, { peer: '$chat' });
  assert.equal(clearedAgain.result, true);
  sessions.dave = await reopenDevice(contexts.dave);
  await openGroupChatByTitle(sessions.dave.page, groupTitle);
  await waitHeaderAvatarInitials(sessions.dave.page, LOGIN_TIMEOUT_MS);
  const daveBack = await openGroupProfile(sessions.dave.page, groupTitle);
  await daveBack.getByText(finalAbout).first().waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  assert.equal(await daveBack.getByText(/Промежуточное-/).count(), 0, 'returned device must show the final state only');
  await closeRightColumn(sessions.dave.page);

  // ══ US5: заявки на вступление ══════════════════════════════════════════════
  const approval = await callProviderForChat(alicePage, 'exportChatInvite', groupTitle, undefined, {
    peer: '$chat', title: 'approve', isRequestNeeded: true,
  });
  const approvalToken = inviteTokenOf(approval.result?.link || '');
  assert(approvalToken, `approval link not created: ${JSON.stringify(approval)}`);
  // carol (уже не участник) подаёт заявку через модалку «Request to Join»
  await sessions.carol.page.goto(`${baseUrl}#+${approvalToken}`, { waitUntil: 'domcontentloaded' });
  await acceptInviteModal(sessions.carol.page, /request to join/i);
  await expectToast(sessions.carol.page, /approves your request/);
  await sessions.carol.page.waitForTimeout(1500);
  assert.equal(await sessions.carol.page.locator('#LeftColumn .ListItem').filter({ hasText: groupTitle }).count(), 0,
    'requester must not get the group before approval');
  // Владелец: пункт «Join Requests» появляется без перезагрузки → одобрить
  const requestsAt = Date.now();
  const rightReq = await openGroupManagement(alicePage, groupTitle);
  const requestsItem = rightReq.locator('.ListItem').filter({ hasText: 'Join Requests' }).first();
  await requestsItem.waitFor({ state: 'visible', timeout: CONVERGENCE_TIMEOUT_MS });
  console.log(`join request reached the owner's screen in ${Date.now() - requestsAt} ms`);
  await requestsItem.click();
  const requestRow = rightReq.locator('.ListItem, .JoinRequest').filter({ hasText: nick('carol') }).first();
  await requestRow.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await rightReq.getByRole('button', { name: 'Add to group' }).first().click();
  await sessions.carol.page.locator('#LeftColumn .ListItem').filter({ hasText: groupTitle }).first()
    .waitFor({ state: 'visible', timeout: CONVERGENCE_TIMEOUT_MS });
  await rightReq.locator('.ListItem, .JoinRequest').filter({ hasText: nick('carol') }).first()
    .waitFor({ state: 'detached', timeout: CONVERGENCE_TIMEOUT_MS });
  await closeRightColumn(alicePage);
  // Заявитель после одобрения получает новые сообщения
  await openGroupChatByTitle(alicePage, groupTitle);
  await sendText(alicePage, `after-approve-${suffix}`);
  await openGroupChatByTitle(sessions.carol.page, groupTitle);
  await findMessage(sessions.carol.page, `after-approve-${suffix}`).first()
    .waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  // grace (не участник): заявка отклонена → группы нет, повтор — тост «отклонена»
  sessions.grace = await preparePage(contexts.grace, address('grace'));
  await sessions.grace.page.goto(`${baseUrl}#+${approvalToken}`, { waitUntil: 'domcontentloaded' });
  await acceptInviteModal(sessions.grace.page, /request to join/i);
  await expectToast(sessions.grace.page, /approves your request/);
  // Отклонение — нативно на экране Join Requests («Dismiss request»)
  const rightDecline = await openGroupManagement(alicePage, groupTitle);
  const requestsItem2 = rightDecline.locator('.ListItem').filter({ hasText: 'Join Requests' }).first();
  await requestsItem2.waitFor({ state: 'visible', timeout: CONVERGENCE_TIMEOUT_MS });
  await requestsItem2.click();
  await rightDecline.locator('.ListItem, .JoinRequest').filter({ hasText: nick('grace') }).first()
    .waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await rightDecline.getByRole('button', { name: 'Dismiss request' }).first().click();
  await rightDecline.locator('.ListItem, .JoinRequest').filter({ hasText: nick('grace') }).first()
    .waitFor({ state: 'detached', timeout: CONVERGENCE_TIMEOUT_MS });
  await closeRightColumn(alicePage);
  await sessions.grace.page.waitForTimeout(1500);
  assert.equal(await sessions.grace.page.locator('#LeftColumn .ListItem').filter({ hasText: groupTitle }).count(), 0,
    'declined requester must not get the group');
  await sessions.grace.page.goto(`${baseUrl}#+${approvalToken}`, { waitUntil: 'domcontentloaded' });
  await acceptInviteModal(sessions.grace.page, /request to join/i);
  await expectToast(sessions.grace.page, 'Your join request was declined');
  // Участник (bob — админ без invite_users) заявок не видит
  const bobReqs = await callProviderForChat(sessions.bob.page, 'fetchChatInviteImporters', groupTitle, undefined, { peer: '$chat', isRequested: true });
  assert.equal(bobReqs.result, null, `admin without invite_users must not list requests: ${JSON.stringify(bobReqs)}`);

  Object.entries(sessions).forEach(([name, session]) => {
    assert.deepEqual(session.errors, [], `${name} page errors: ${session.errors.join('; ')}`);
  });
  console.log('OK: фото и описание группы, права по умолчанию (композер, вложения, сервер, приёмный фильтр), '
    + 'живые изменения открытых экранов, догон отсутствовавшего устройства, заявки на вступление');
} catch (err) {
  const dir = new URL('../web/telegram-tt/test-results/', import.meta.url).pathname;
  for (const [name, context] of Object.entries(contexts)) {
    const page = context.pages().at(-1);
    if (page) {
      await page.screenshot({ path: `${dir}group-info-${name}.png` }).catch(() => {});
      await dumpDiagJournal(page, name);
    }
  }
  throw err;
} finally {
  await browser.close();
  if (fixtureDir) rmSync(fixtureDir, { recursive: true, force: true });
}
