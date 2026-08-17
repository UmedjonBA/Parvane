// Settings → Devices: один аккаунт (bob) на двух устройствах. Проверяем:
// (1) список устройств показывает оба (текущее + второе «Web …»);
// (2) отзыв второго устройства убирает его из списка;
// (3) новые 1-на-1 сообщения после отзыва НЕ читаются на отозванном
//     устройстве (fan-out его больше не включает);
// (4) новые групповые сообщения после отзыва НЕ читаются на отозванном
//     устройстве (ротация Megolm при исчезновении устройства из каталога),
//     при этом живое устройство читает всё.
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

const PASSWORD = 'Parvane-devices-e2e-password';
// Клиентский кэш списка устройств контакта (DEVICE_LIST_TTL_MS в e2e.ts) + запас
const DEVICE_LIST_TTL_WAIT_MS = 17000;
// Дельта-синк соседнего устройства — интервал 10с + запас
const SIBLING_SYNC_TIMEOUT_MS = 45000;
// Ожидание «сообщение НЕ должно появиться»: live-пуш мгновенный, дельта-синк 10с
const NEGATIVE_WAIT_MS = 12000;

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

async function relogin(page, password) {
  await page.reload({ waitUntil: 'domcontentloaded' });
  const passwordScreen = page.locator('.Transition_slide-active > #auth-password-form');
  await passwordScreen.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await passwordScreen.locator('#sign-in-password').fill(password);
  await passwordScreen.getByRole('button', { name: 'Next' }).click();
  await page.locator('#LeftColumn').waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
}

const browser = await chromium.launch();
const aliceContext = await browser.newContext();
const bobDevice1Context = await browser.newContext();
const bobDevice2Context = await browser.newContext();

try {
  const suffix = `${Date.now()}-${process.pid}`;
  const alice = `dv-alice-${suffix}@local`;
  const bob = `dv-bob-${suffix}@local`;
  const bobName = bob.split('@')[0];
  const beforeRevoke = `dv-before-${suffix}`;
  const groupBefore = `dv-group-before-${suffix}`;
  const afterRevokeDirect = `dv-after-direct-${suffix}`;
  const afterRevokeGroup = `dv-after-group-${suffix}`;
  const groupTitle = `DV Group ${suffix}`;

  const aliceSession = await preparePage(aliceContext, alice, PASSWORD);
  const bobDevice1 = await preparePage(bobDevice1Context, bob, PASSWORD);
  const bobDevice2 = await preparePage(bobDevice2Context, bob, PASSWORD);

  // Отправитель обнаруживает второе устройство после истечения TTL кэша списка
  await aliceSession.page.waitForTimeout(DEVICE_LIST_TTL_WAIT_MS);

  // ── До отзыва: 1-на-1 и группа читаются на обоих устройствах ───────────────
  await openPrivateChat(aliceSession.page, bob);
  await sendText(aliceSession.page, beforeRevoke);
  await openPrivateChat(bobDevice1.page, alice);
  await findMessage(bobDevice1.page, beforeRevoke).first()
    .waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await openPrivateChat(bobDevice2.page, alice);
  await findMessage(bobDevice2.page, beforeRevoke).first()
    .waitFor({ state: 'visible', timeout: SIBLING_SYNC_TIMEOUT_MS });

  await createGroupWith(aliceSession.page, bobName, groupTitle);
  await openGroupChat(aliceSession.page, groupTitle);
  await sendText(aliceSession.page, groupBefore);
  await openGroupChat(bobDevice1.page, groupTitle);
  await findMessage(bobDevice1.page, groupBefore).first()
    .waitFor({ state: 'visible', timeout: SIBLING_SYNC_TIMEOUT_MS });
  await openGroupChat(bobDevice2.page, groupTitle);
  await findMessage(bobDevice2.page, groupBefore).first()
    .waitFor({ state: 'visible', timeout: SIBLING_SYNC_TIMEOUT_MS });

  // ── Settings → Devices на первом устройстве: видим второе и отзываем ───────
  await bobDevice1.page.getByRole('button', { name: 'Open menu' }).first().click();
  await bobDevice1.page.getByRole('menuitem', { name: 'Settings' }).click();
  await bobDevice1.page.getByRole('button', { name: 'Devices' }).click();

  const sessionsScreen = bobDevice1.page.locator('.SettingsActiveSessions');
  await sessionsScreen.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  // Текущее устройство — отдельным блоком, второе — в «Active sessions»
  await sessionsScreen.getByText('THIS DEVICE').first()
    .waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  const otherSession = sessionsScreen.locator('.ListItem').filter({ hasText: 'Web ' }).first();
  await otherSession.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });

  // Клик по устройству → модалка → Terminate Session
  await otherSession.locator('.ListItem-button').click();
  const terminateButton = bobDevice1.page.getByRole('button', { name: 'Terminate Session' });
  await terminateButton.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await terminateButton.click();
  // Второе устройство исчезло из списка (секция Active sessions скрывается)
  await sessionsScreen.getByText('Active sessions')
    .waitFor({ state: 'hidden', timeout: LOGIN_TIMEOUT_MS });

  // Обратно в чаты (и заодно проверяем персист после revoke)
  await relogin(bobDevice1.page, PASSWORD);

  // Алиса должна заметить исчезновение устройства (TTL кэша) перед отправкой
  await aliceSession.page.waitForTimeout(DEVICE_LIST_TTL_WAIT_MS);

  // ── После отзыва: 1-на-1 читает только живое устройство ────────────────────
  await openPrivateChat(aliceSession.page, bob);
  await sendText(aliceSession.page, afterRevokeDirect);
  await openPrivateChat(bobDevice1.page, alice);
  await findMessage(bobDevice1.page, afterRevokeDirect).first()
    .waitFor({ state: 'visible', timeout: SIBLING_SYNC_TIMEOUT_MS });
  await bobDevice2.page.waitForTimeout(NEGATIVE_WAIT_MS);
  assert.equal(
    await findMessage(bobDevice2.page, afterRevokeDirect).count(),
    0,
    'revoked device must not read new direct messages',
  );

  // ── После отзыва: группа читает только живое устройство (ротация Megolm) ───
  await openGroupChat(aliceSession.page, groupTitle);
  await sendText(aliceSession.page, afterRevokeGroup);
  await openGroupChat(bobDevice1.page, groupTitle);
  await findMessage(bobDevice1.page, afterRevokeGroup).first()
    .waitFor({ state: 'visible', timeout: SIBLING_SYNC_TIMEOUT_MS });
  await bobDevice2.page.waitForTimeout(NEGATIVE_WAIT_MS);
  assert.equal(
    await findMessage(bobDevice2.page, afterRevokeGroup).count(),
    0,
    'revoked device must not read new group messages after Megolm rotation',
  );
  // Старая история при этом на месте (отзыв не трогает уже полученное)
  assert.equal(
    await findMessage(bobDevice2.page, groupBefore).count(),
    1,
    'history received before revoke stays readable on the revoked device',
  );

  assertNoPageErrors({
    alice: aliceSession,
    'bob-device-1': bobDevice1,
    'bob-device-2': bobDevice2,
  });

  console.log('OK: устройства — список показывает оба, отзыв убирает из списка, отозванное устройство не читает новые 1-на-1 и групповые сообщения, живое читает всё');
} catch (err) {
  const dir = new URL('../web/telegram-tt/test-results/', import.meta.url).pathname;
  for (const [name, context] of [
    ['alice', aliceContext], ['bob-dev1', bobDevice1Context], ['bob-dev2', bobDevice2Context],
  ]) {
    const page = context.pages()[0];
    if (page) await page.screenshot({ path: `${dir}devices-${name}.png` }).catch(() => {});
  }
  throw err;
} finally {
  await browser.close();
}
