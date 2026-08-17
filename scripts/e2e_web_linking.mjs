// Авто-линковка истории: один аккаунт (bob) на двух устройствах. Проверяем:
// (1) свежее устройство НЕ читает старую sealed-историю и публикует оффер
//     (Settings → Devices показывает код ожидания);
// (2) старое устройство видит запрос с ТЕМ ЖЕ кодом и подтверждает;
// (3) после передачи новое устройство читает всю историю БЕЗ ручного
//     экспорта/импорта: входящие от Алисы, СВОИ исходящие (extra_signing
//     в sync — доказательство владения ключом старого устройства) и группу;
// (4) новые сообщения после линковки приходят на оба устройства.
import assert from 'node:assert/strict';

import { chromium } from '../web/telegram-tt/node_modules/playwright/index.mjs';

import {
  LOGIN_TIMEOUT_MS,
  assertNoPageErrors,
  findMessage,
  openPrivateChat,
  preparePage,
  sendText,
} from './e2e_web_helpers.mjs';

const PASSWORD = 'Parvane-linking-e2e-password';
const DEVICE_LIST_TTL_WAIT_MS = 17000;
const SIBLING_SYNC_TIMEOUT_MS = 45000;
// Грант опрашивается новым устройством каждые 5с + импорт + ресинк
const LINK_TIMEOUT_MS = 60000;

async function openPrivateChatStrict(page, address) {
  const name = address.split('@')[0];
  for (let attempt = 0; attempt < 3; attempt++) {
    await openPrivateChat(page, address).catch(() => {});
    const isOpen = await page.locator('.MiddleHeader').getByText(name).first()
      .isVisible().catch(() => false);
    if (isOpen) return;
    await page.keyboard.press('Escape');
    await page.waitForTimeout(500);
  }
  assert.fail(`chat with ${address} did not open`);
}

async function selectPickerRow(page, containerSelector, name) {
  const row = page.locator(`${containerSelector} .PeerPickerItem, ${containerSelector} .ItemPickerItem`)
    .filter({ hasText: name })
    .first();
  await row.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  const checkedRows = `${containerSelector} .PeerPickerItem input[type="checkbox"]:checked, `
    + `${containerSelector} .ItemPickerItem input[type="checkbox"]:checked`;
  for (let attempt = 0; attempt < 6; attempt++) {
    const checked = await page.locator(checkedRows).count();
    if (checked > 0) return;
    if (attempt % 2 === 0) {
      await row.press(' ').catch(() => {});
    } else {
      await row.click({ force: true }).catch(() => {});
    }
    await page.waitForTimeout(400);
  }
  throw new Error(`Row '${name}' was not selected in picker ${containerSelector}`);
}

async function createGroupWith(page, memberName, groupTitle) {
  await page.mouse.move(800, 360);
  await page.waitForTimeout(200);
  await page.locator('#LeftColumn').hover();
  await page.getByRole('button', { name: 'New Message' }).click();
  await page.getByRole('menuitem', { name: 'New Group' }).click();
  const memberSearch = page.locator('#new-group-picker-search');
  await memberSearch.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await memberSearch.fill(memberName);
  await selectPickerRow(page, '#LeftColumn', memberName);
  await page.getByRole('button', { name: 'Continue To Group Info' }).click();
  const nameInput = page.getByLabel('Group name');
  await nameInput.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  for (let attempt = 0; attempt < 5; attempt++) {
    await page.waitForTimeout(700);
    await nameInput.fill(groupTitle);
    if (await nameInput.inputValue() === groupTitle) break;
  }
  assert.equal(await nameInput.inputValue(), groupTitle, 'group title must survive auto-suggestion');
  await page.getByRole('button', { name: 'Create Group' }).click();
  await page.locator('#editable-message-text').waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
}

async function openGroupChat(page, title) {
  const item = page.locator('#LeftColumn .ListItem').filter({ hasText: title }).first();
  await item.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await item.locator('.ListItem-button').click();
  await page.locator('#editable-message-text').waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
}

async function openDevicesScreen(page) {
  await page.getByRole('button', { name: 'Open menu' }).first().click();
  await page.getByRole('menuitem', { name: 'Settings' }).click();
  await page.getByRole('button', { name: 'Devices' }).click();
  const screen = page.locator('.SettingsActiveSessions');
  await screen.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  return screen;
}

async function closeSettings(page) {
  // Возврат в список чатов: Escape закрывает экраны настроек по одному.
  // Проверять надо ВИДИМОСТЬ поиска — в DOM он смонтирован и под настройками
  for (let attempt = 0; attempt < 6; attempt++) {
    if (await page.locator('#telegram-search-input').isVisible()) return;
    await page.keyboard.press('Escape');
    await page.waitForTimeout(500);
  }
  throw new Error('Failed to return to chat list from settings');
}

const browser = await chromium.launch();
const aliceContext = await browser.newContext();
const bobDevice1Context = await browser.newContext();
const bobDevice2Context = await browser.newContext();

try {
  const suffix = `${Date.now()}-${process.pid}`;
  const alice = `lk-alice-${suffix}@local`;
  const bob = `lk-bob-${suffix}@local`;
  const bobName = bob.split('@')[0];
  const incomingOld = `lk-incoming-${suffix}`;
  const outgoingOld = `lk-outgoing-${suffix}`;
  const groupOld = `lk-group-${suffix}`;
  const afterLink = `lk-after-${suffix}`;
  const groupTitle = `LK Group ${suffix}`;

  const aliceSession = await preparePage(aliceContext, alice, PASSWORD);
  const bobDevice1 = await preparePage(bobDevice1Context, bob, PASSWORD);

  // ── История до второго устройства: входящее, исходящее, группа ─────────────
  await openPrivateChatStrict(aliceSession.page, bob);
  await sendText(aliceSession.page, incomingOld);
  await openPrivateChatStrict(bobDevice1.page, alice);
  await findMessage(bobDevice1.page, incomingOld).first()
    .waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await sendText(bobDevice1.page, outgoingOld);
  await findMessage(aliceSession.page, outgoingOld).first()
    .waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });

  await createGroupWith(aliceSession.page, bobName, groupTitle);
  await openGroupChat(aliceSession.page, groupTitle);
  await sendText(aliceSession.page, groupOld);
  await openGroupChat(bobDevice1.page, groupTitle);
  await findMessage(bobDevice1.page, groupOld).first()
    .waitFor({ state: 'visible', timeout: SIBLING_SYNC_TIMEOUT_MS });

  // ── Новое устройство: история нечитаема, оффер линковки опубликован ───────
  const bobDevice2 = await preparePage(bobDevice2Context, bob, PASSWORD);
  // Диагностика линковки: клиентские логи нового устройства в stdout
  bobDevice2.page.on('console', (msg) => {
    const text = msg.text();
    if (/линковк|расшифро/.test(text)) console.log('[dev2]', text);
  });
  await bobDevice2.page.waitForTimeout(4000);
  assert.equal(
    await findMessage(bobDevice2.page, incomingOld).count(),
    0,
    'sealed history must be unreadable before linking',
  );

  const dev2Screen = await openDevicesScreen(bobDevice2.page);
  const pendingText = dev2Screen.getByText(/confirm code \d{6}/);
  await pendingText.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  const dev2Code = (await pendingText.textContent()).match(/(\d{6})/)[1];

  // ── Старое устройство видит запрос с тем же кодом и подтверждает ──────────
  const dev1Screen = await openDevicesScreen(bobDevice1.page);
  const offerItem = dev1Screen.locator('.ListItem').filter({ hasText: 'Code:' }).first();
  await offerItem.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  const offerText = await offerItem.textContent();
  // Именно из «Code: NNNNNN» — device_id в заголовке тоже содержит цифры
  const dev1Code = offerText.match(/Code: (\d{6})/)[1];
  assert.equal(dev1Code, dev2Code, 'SAS codes must match on both devices');

  await offerItem.locator('.ListItem-button').click();
  const transferButton = bobDevice1.page.getByRole('button', { name: 'Transfer', exact: true });
  await transferButton.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await transferButton.click();
  await bobDevice1.page.getByText('History transferred')
    .waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });

  // ── Новое устройство получает историю целиком ─────────────────────────────
  await closeSettings(bobDevice2.page);
  await openPrivateChatStrict(bobDevice2.page, alice);
  await findMessage(bobDevice2.page, incomingOld).first()
    .waitFor({ state: 'visible', timeout: LINK_TIMEOUT_MS });
  await findMessage(bobDevice2.page, outgoingOld).first()
    .waitFor({ state: 'visible', timeout: LINK_TIMEOUT_MS });
  await openGroupChat(bobDevice2.page, groupTitle);
  await findMessage(bobDevice2.page, groupOld).first()
    .waitFor({ state: 'visible', timeout: LINK_TIMEOUT_MS });

  // ── Новые сообщения после линковки приходят на оба устройства ─────────────
  await closeSettings(bobDevice1.page);
  await aliceSession.page.waitForTimeout(DEVICE_LIST_TTL_WAIT_MS);
  await openPrivateChatStrict(aliceSession.page, bob);
  await sendText(aliceSession.page, afterLink);
  await openPrivateChatStrict(bobDevice1.page, alice);
  await findMessage(bobDevice1.page, afterLink).first()
    .waitFor({ state: 'visible', timeout: SIBLING_SYNC_TIMEOUT_MS });
  await openPrivateChatStrict(bobDevice2.page, alice);
  await findMessage(bobDevice2.page, afterLink).first()
    .waitFor({ state: 'visible', timeout: SIBLING_SYNC_TIMEOUT_MS });

  assertNoPageErrors({
    alice: aliceSession,
    'bob-device-1': bobDevice1,
    'bob-device-2': bobDevice2,
  });

  console.log('OK: авто-линковка — коды совпали, подтверждение передало историю (входящие, исходящие, группа) без ручного экспорта, новые сообщения видны на обоих устройствах');
} catch (err) {
  const dir = new URL('../web/telegram-tt/test-results/', import.meta.url).pathname;
  for (const [name, context] of [
    ['alice', aliceContext], ['bob-dev1', bobDevice1Context], ['bob-dev2', bobDevice2Context],
  ]) {
    const page = context.pages()[0];
    if (page) await page.screenshot({ path: `${dir}linking-${name}.png` }).catch(() => {});
  }
  throw err;
} finally {
  await browser.close();
}
