// Мультидевайс: один аккаунт (bob) на двух «устройствах» (два изолированных
// браузерных контекста). Проверяем: (1) старая sealed-история нечитаема на
// новом устройстве (E2E честный); (2) новые входящие 1-на-1 приходят на ОБА
// устройства (fan-out копий у отправителя); (3) исходящее со второго
// устройства видит и Алиса, и первое устройство (self-копии + подписанный
// sync); (4) групповое сообщение читается обоими устройствами (SKDM fan-out);
// (5) всё переживает перезапуск второго устройства.
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

const PASSWORD = 'Parvane-multidevice-e2e-password';
// Клиентский кэш списка устройств контакта (DEVICE_LIST_TTL_MS в e2e.ts) + запас:
// отправитель заметит новое устройство не раньше истечения TTL
const DEVICE_LIST_TTL_WAIT_MS = 17000;
// Дельта-синк соседнего устройства — интервал 10с + запас
const SIBLING_SYNC_TIMEOUT_MS = 45000;

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
// Второе «устройство» Боба — полностью чистый контекст, тот же аккаунт
const bobDevice2Context = await browser.newContext();

try {
  const suffix = `${Date.now()}-${process.pid}`;
  const alice = `md-alice-${suffix}@local`;
  const bob = `md-bob-${suffix}@local`;
  const bobName = bob.split('@')[0];
  const beforeSecondDevice = `md-before-${suffix}`;
  const forBothDevices = `md-both-${suffix}`;
  const replyFromSecond = `md-reply-${suffix}`;
  const groupTitle = `MD Group ${suffix}`;
  const groupMessage = `md-group-${suffix}`;

  const aliceSession = await preparePage(aliceContext, alice, PASSWORD);
  const bobDevice1 = await preparePage(bobDevice1Context, bob, PASSWORD);

  // ── До второго устройства: обычная sealed-переписка ────────────────────────
  await openPrivateChat(aliceSession.page, bob);
  await sendText(aliceSession.page, beforeSecondDevice);
  await openPrivateChat(bobDevice1.page, alice);
  await findMessage(bobDevice1.page, beforeSecondDevice).first()
    .waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });

  // ── Логин второго устройства НЕ перетирает первое ──────────────────────────
  // Чат с Алисой НЕ открываем: вся его история пока нечитаема, а лента из
  // одних пропущенных сообщений виснет в спиннере (известный шов, как в
  // keys_backup). Нечитаемость ассертим по счётчику после ожидания синка
  const bobDevice2 = await preparePage(bobDevice2Context, bob, PASSWORD);
  await bobDevice2.page.waitForTimeout(4000);
  assert.equal(
    await findMessage(bobDevice2.page, beforeSecondDevice).count(),
    0,
    'old sealed history must stay unreadable on a brand-new device',
  );

  // Отправитель обнаруживает новое устройство после истечения TTL кэша списка
  await aliceSession.page.waitForTimeout(DEVICE_LIST_TTL_WAIT_MS);

  // ── Новое входящее приходит на ОБА устройства ──────────────────────────────
  await openPrivateChat(aliceSession.page, bob);
  await sendText(aliceSession.page, forBothDevices);
  await findMessage(bobDevice1.page, forBothDevices).first()
    .waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await openPrivateChat(bobDevice2.page, alice);
  await findMessage(bobDevice2.page, forBothDevices).first()
    .waitFor({ state: 'visible', timeout: SIBLING_SYNC_TIMEOUT_MS });

  // Первое устройство при этом НЕ разлогинено и живо (прежний баг: свежий
  // логин перетирал identity)
  await sendText(bobDevice2.page, replyFromSecond);
  await findMessage(aliceSession.page, replyFromSecond).first()
    .waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  // …и исходящее со второго устройства появляется на первом (self-копия)
  await findMessage(bobDevice1.page, replyFromSecond).first()
    .waitFor({ state: 'visible', timeout: SIBLING_SYNC_TIMEOUT_MS });

  // ── Группа: SKDM-fan-out — читают оба устройства Боба ──────────────────────
  await aliceSession.page.mouse.move(800, 360);
  await aliceSession.page.waitForTimeout(200);
  await aliceSession.page.locator('#LeftColumn').hover();
  await aliceSession.page.getByRole('button', { name: 'New Message' }).click();
  await aliceSession.page.getByRole('menuitem', { name: 'New Group' }).click();
  const memberSearch = aliceSession.page.locator('#new-group-picker-search');
  await memberSearch.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await memberSearch.fill(bobName);
  await selectPickerRow(aliceSession.page, '#LeftColumn', bobName);
  await aliceSession.page.getByRole('button', { name: 'Continue To Group Info' }).click();
  const nameInput = aliceSession.page.getByLabel('Group name');
  await nameInput.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  // NewChatStep2 асинхронно подставляет авто-имя из участников — даём эффекту
  // отработать и перепроверяем, что наше название не перетёрто
  for (let attempt = 0; attempt < 5; attempt++) {
    await aliceSession.page.waitForTimeout(700);
    await nameInput.fill(groupTitle);
    if (await nameInput.inputValue() === groupTitle) break;
  }
  assert.equal(await nameInput.inputValue(), groupTitle, 'group title must survive auto-suggestion');
  await aliceSession.page.getByRole('button', { name: 'Create Group' }).click();
  await aliceSession.page.locator('#editable-message-text').waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await openGroupChat(aliceSession.page, groupTitle);
  await sendText(aliceSession.page, groupMessage);

  await openGroupChat(bobDevice1.page, groupTitle);
  await findMessage(bobDevice1.page, groupMessage).first()
    .waitFor({ state: 'visible', timeout: SIBLING_SYNC_TIMEOUT_MS });
  await openGroupChat(bobDevice2.page, groupTitle);
  await findMessage(bobDevice2.page, groupMessage).first()
    .waitFor({ state: 'visible', timeout: SIBLING_SYNC_TIMEOUT_MS });

  // ── Перезапуск второго устройства: ключи и копии персистентны ──────────────
  await relogin(bobDevice2.page, PASSWORD);
  await openPrivateChat(bobDevice2.page, alice);
  await findMessage(bobDevice2.page, forBothDevices).first()
    .waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await findMessage(bobDevice2.page, replyFromSecond).first()
    .waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await openGroupChat(bobDevice2.page, groupTitle);
  await findMessage(bobDevice2.page, groupMessage).first()
    .waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });

  assertNoPageErrors({
    alice: aliceSession,
    'bob-device-1': bobDevice1,
    'bob-device-2': bobDevice2,
  });

  console.log('OK: мультидевайс — второй логин не перетирает первый, входящие и исходящие видны на обоих устройствах, группа читается, рестарт переживается');
} catch (err) {
  const dir = new URL('../web/telegram-tt/test-results/', import.meta.url).pathname;
  for (const [name, context] of [
    ['alice', aliceContext], ['bob-dev1', bobDevice1Context], ['bob-dev2', bobDevice2Context],
  ]) {
    const page = context.pages()[0];
    if (page) await page.screenshot({ path: `${dir}multidevice-${name}.png` }).catch(() => {});
  }
  throw err;
} finally {
  await browser.close();
}
