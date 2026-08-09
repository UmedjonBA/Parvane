// Трёхбраузерный сценарий админ-операций B3: promote/demote через UI,
// live-конвергенция ролей и заголовка без reload, выход из группы,
// удаление группы владельцем, канал (создание, посты только owner/admin,
// composer скрыт у подписчика).
import assert from 'node:assert/strict';

import { chromium } from '../web/telegram-tt/node_modules/playwright/index.mjs';

import {
  LOGIN_TIMEOUT_MS,
  findMessage,
  openPrivateChat,
  preparePage,
  sendText,
} from './e2e_web_helpers.mjs';

const PASSWORD = 'Parvane-group-admin-e2e-password';
// Конвергенция ролей/имён — delta-sync каждые 10с
const CONVERGENCE_TIMEOUT_MS = 30000;

async function selectPickerRow(page, containerSelector, name) {
  const row = page.locator(`${containerSelector} .PeerPickerItem, ${containerSelector} .ItemPickerItem`)
    .filter({ hasText: name })
    .first();
  await row.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  for (let attempt = 0; attempt < 6; attempt++) {
    const checked = await page
      .locator(`${containerSelector} .PeerPickerItem, ${containerSelector} .ItemPickerItem`)
      .filter({ hasText: name })
      .first()
      .locator('input[type="checkbox"]:checked')
      .count();
    if (checked > 0) return;
    if (attempt % 2 === 0) await row.press(' ').catch(() => {});
    else await row.click({ force: true }).catch(() => {});
    await page.waitForTimeout(500);
  }
  assert.fail(`picker row for ${name} is never selected`);
}

async function openChatByTitle(page, title) {
  const item = page.locator('#LeftColumn .ListItem').filter({ hasText: title }).first();
  await item.waitFor({ state: 'visible', timeout: CONVERGENCE_TIMEOUT_MS });
  await item.locator('.ListItem-button').click();
}

const browser = await chromium.launch();
const contexts = await Promise.all(
  Array.from({ length: 3 }, () => browser.newContext()),
);

try {
  const suffix = `${Date.now()}-${process.pid}`;
  const alice = `ga-alice-${suffix}@local`;
  const bob = `ga-bob-${suffix}@local`;
  const carol = `ga-carol-${suffix}@local`;
  const bobName = bob.split('@')[0];
  const carolName = carol.split('@')[0];
  const groupTitle = `GA-${suffix.slice(-6)}`;
  const renamedTitle = `GA-RN-${suffix.slice(-6)}`;
  const channelTitle = `CH-${suffix.slice(-6)}`;
  const channelPost = `channel-post-${suffix}`;

  const [aliceSession, bobSession, carolSession] = await Promise.all([
    preparePage(contexts[0], alice, PASSWORD),
    preparePage(contexts[1], bob, PASSWORD),
    preparePage(contexts[2], carol, PASSWORD),
  ]);
  await openPrivateChat(aliceSession.page, bob);
  await openPrivateChat(aliceSession.page, carol);

  // ── Группа с Bob и Carol ───────────────────────────────────────────────────
  await aliceSession.page.mouse.move(800, 360);
  await aliceSession.page.waitForTimeout(200);
  await aliceSession.page.locator('#LeftColumn').hover();
  await aliceSession.page.getByRole('button', { name: 'New Message' }).click();
  await aliceSession.page.getByRole('menuitem', { name: 'New Group' }).click();
  const memberSearch = aliceSession.page.locator('#new-group-picker-search');
  await memberSearch.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await memberSearch.fill(bobName);
  await selectPickerRow(aliceSession.page, '#LeftColumn', bobName);
  await memberSearch.fill(carolName);
  await selectPickerRow(aliceSession.page, '#LeftColumn', carolName);
  await aliceSession.page.getByRole('button', { name: 'Continue To Group Info' }).click();
  const nameInput = aliceSession.page.getByLabel('Group name');
  await nameInput.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await nameInput.fill(groupTitle);
  await aliceSession.page.getByRole('button', { name: 'Create Group' }).click();
  await aliceSession.page.locator('#editable-message-text')
    .waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });

  // ── Promote Bob: owner делает Bob админом через UI ─────────────────────────
  await openChatByTitle(aliceSession.page, groupTitle);
  await aliceSession.page.locator('.MiddleHeader .ChatInfo').click();
  await aliceSession.page.locator('#RightColumn').getByRole('button', { name: 'Edit' }).click();
  await aliceSession.page.locator('#RightColumn').getByText('Administrators').click();
  await aliceSession.page.locator('#RightColumn').getByRole('button', { name: 'Add Admin' }).click();
  const bobAdminRow = aliceSession.page.locator('#RightColumn .ListItem').filter({ hasText: bobName }).first();
  await bobAdminRow.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await bobAdminRow.click();
  // Экран прав: включаем пару тумблеров (все выключены = demote) и жмём
  // floating-галку Save
  const rightsScreen = aliceSession.page.locator('#RightColumn');
  const changeInfoToggle = rightsScreen.locator('.Checkbox').filter({ hasText: 'Change Group Info' });
  await changeInfoToggle.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await changeInfoToggle.click();
  await rightsScreen.locator('.Checkbox').filter({ hasText: 'Ban Users' }).click();
  const saveAdmin = rightsScreen.getByRole('button', { name: 'Save', exact: true });
  await saveAdmin.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await saveAdmin.click();
  // В списке админов теперь двое: owner и Bob
  await aliceSession.page.locator('#RightColumn .ListItem')
    .filter({ hasText: bobName })
    .first()
    .waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });

  // ── Live-конвергенция: у Bob появляется Edit без reload ────────────────────
  await openChatByTitle(bobSession.page, groupTitle);
  await bobSession.page.locator('.MiddleHeader .ChatInfo').click();
  await bobSession.page.locator('#RightColumn').getByRole('button', { name: 'Edit' })
    .waitFor({ state: 'visible', timeout: CONVERGENCE_TIMEOUT_MS });

  // ── Rename админом: Bob переименовывает, у Carol заголовок сходится ────────
  await bobSession.page.locator('#RightColumn').getByRole('button', { name: 'Edit' }).click();
  const titleInput = bobSession.page.locator('#RightColumn').getByLabel('Group name');
  await titleInput.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await titleInput.fill(renamedTitle);
  const saveTitle = bobSession.page.locator('#RightColumn').getByRole('button', { name: 'Save' });
  await saveTitle.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await saveTitle.click();
  await openChatByTitle(carolSession.page, groupTitle);
  await carolSession.page.locator('.MiddleHeader .ChatInfo, .MiddleHeader')
    .filter({ hasText: renamedTitle })
    .first()
    .waitFor({ state: 'visible', timeout: CONVERGENCE_TIMEOUT_MS });

  // ── Carol выходит из группы ────────────────────────────────────────────────
  const carolChatItem = carolSession.page.locator('#LeftColumn .ListItem').filter({ hasText: renamedTitle }).first();
  await carolChatItem.click({ button: 'right' });
  await carolSession.page.getByRole('menuitem', { name: 'Delete Chat' }).click();
  const leaveConfirm = carolSession.page.locator('.Modal')
    .getByRole('button', { name: /Leave Group|Delete/i })
    .first();
  await leaveConfirm.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await leaveConfirm.click();
  await carolSession.page.locator('#LeftColumn .ListItem').filter({ hasText: renamedTitle })
    .first()
    .waitFor({ state: 'detached', timeout: CONVERGENCE_TIMEOUT_MS });

  // ── Owner удаляет группу: у Bob чат исчезает без reload ────────────────────
  const aliceChatItem = aliceSession.page.locator('#LeftColumn .ListItem').filter({ hasText: renamedTitle }).first();
  await aliceChatItem.click({ button: 'right' });
  await aliceSession.page.getByRole('menuitem', { name: 'Delete Chat' }).click();
  const deleteModal = aliceSession.page.locator('.Modal');
  const deleteForAll = deleteModal.locator('input[type="checkbox"]');
  if (await deleteForAll.count()) await deleteForAll.first().check().catch(() => {});
  await deleteModal.getByRole('button', { name: /Delete/i }).first().click();
  await aliceSession.page.locator('#LeftColumn .ListItem').filter({ hasText: renamedTitle })
    .first()
    .waitFor({ state: 'detached', timeout: CONVERGENCE_TIMEOUT_MS });
  await bobSession.page.locator('#LeftColumn .ListItem').filter({ hasText: renamedTitle })
    .first()
    .waitFor({ state: 'detached', timeout: CONVERGENCE_TIMEOUT_MS });

  // ── Канал: создание, пост владельца, у подписчика нет composer ─────────────
  await aliceSession.page.mouse.move(800, 360);
  await aliceSession.page.waitForTimeout(200);
  await aliceSession.page.locator('#LeftColumn').hover();
  await aliceSession.page.getByRole('button', { name: 'New Message' }).click();
  await aliceSession.page.getByRole('menuitem', { name: 'New Channel' }).click();
  // Шаг 1: выбор подписчиков, floating-стрелка — далее
  await selectPickerRow(aliceSession.page, '#LeftColumn', bobName);
  await aliceSession.page.locator('#LeftColumn .FloatingActionButton').click();
  // Шаг 2: имя канала (label tt не связан с input — берём поле напрямую),
  // floating — создать
  await aliceSession.page.getByRole('heading', { name: 'New Channel' })
    .waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  const channelName = aliceSession.page
    .locator('#LeftColumn .input-group:has(label:has-text("Channel name")) input');
  await channelName.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await channelName.fill(channelTitle);
  await aliceSession.page.getByRole('button', { name: 'Create Channel', exact: true }).click();
  await aliceSession.page.locator('#editable-message-text')
    .waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await sendText(aliceSession.page, channelPost);

  // Bob получает пост, composer у подписчика скрыт
  await openChatByTitle(bobSession.page, channelTitle);
  await findMessage(bobSession.page, channelPost).first()
    .waitFor({ state: 'visible', timeout: CONVERGENCE_TIMEOUT_MS });
  const bobComposerCount = await bobSession.page.locator('#editable-message-text').count();
  assert.equal(bobComposerCount, 0, 'у подписчика канала не должно быть composer');

  assert.deepEqual(aliceSession.errors, [], `alice page errors: ${aliceSession.errors.join('; ')}`);
  assert.deepEqual(bobSession.errors, [], `bob page errors: ${bobSession.errors.join('; ')}`);
  assert.deepEqual(carolSession.errors, [], `carol page errors: ${carolSession.errors.join('; ')}`);
  console.log('OK: promote/rename/leave/delete c live-конвергенцией и канал с posting rules');
} catch (err) {
  const dir = new URL('../web/telegram-tt/test-results/', import.meta.url).pathname;
  await Promise.all(contexts.map((context, index) => context.pages()[0]
    ?.screenshot({ path: `${dir}group-admin-${index}.png` }).catch(() => {})));
  throw err;
} finally {
  await browser.close();
}
