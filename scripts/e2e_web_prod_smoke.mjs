// Smoke-прогон против РАЗВЁРНУТОГО стека (prod m60-7 или любой https-инстанс
// с self-signed сертификатом). Не поднимает свой стек: цели берутся из env.
//
//   PARVANE_E2E_BASE_URL=https://185.81.248.52:20443 \
//   PARVANE_E2E_GATEWAY_URL=wss://185.81.248.52:20443/ws \
//   node scripts/e2e_web_prod_smoke.mjs
//
// Регистрирует двух свежих пользователей (уникальный суффикс — прогоны не
// мешают друг другу) и проверяет: текст в обе стороны, правку, реакцию, пин,
// удаление, фото, превью ссылки, группу, персистентность после reload.
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import {
  LOGIN_TIMEOUT_MS,
  preparePage,
  openPrivateChat,
  sendText,
  findMessage,
  findMessageContainers,
  addReaction,
  pinMessage,
  editText,
  deleteMessage,
  assertNoPageErrors,
} from './e2e_web_helpers.mjs';

const PASSWORD = 'smoke-password-1';
// 1x1 красный PNG
const PNG_1PX = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

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
      await row.click().catch(() => {});
    }
    await page.waitForTimeout(400);
  }
  assert.fail(`picker row ${name} not selected`);
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

async function attachPhoto(page, caption) {
  await page.getByRole('button', { name: 'Add an attachment' }).click();
  const fileChooserPromise = page.waitForEvent('filechooser');
  await page.getByRole('menuitem', { name: 'Photo or Video' }).click();
  const fileChooser = await fileChooserPromise;
  await fileChooser.setFiles({ name: 'smoke.png', mimeType: 'image/png', buffer: PNG_1PX });
  const captionInput = page.locator('#editable-message-text-modal');
  await captionInput.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await captionInput.fill(caption);
  await captionInput.press('Enter');
  await captionInput.waitFor({ state: 'hidden', timeout: LOGIN_TIMEOUT_MS });
}

const browser = await chromium.launch();
// Basic-auth гейта сайта (Caddy): PARVANE_E2E_HTTP_USER/PASS — через
// httpCredentials контекста, а НЕ userinfo в URL (ненадёжно для WS).
const httpCredentials = process.env.PARVANE_E2E_HTTP_USER
  ? { username: process.env.PARVANE_E2E_HTTP_USER, password: process.env.PARVANE_E2E_HTTP_PASS || '' }
  : undefined;
const aliceContext = await browser.newContext({ ignoreHTTPSErrors: true, httpCredentials });
const bobContext = await browser.newContext({ ignoreHTTPSErrors: true, httpCredentials });
// Аплинк прод-сервера скромный, бандл большой — дефолтных 30s на goto мало
aliceContext.setDefaultNavigationTimeout(120000);
bobContext.setDefaultNavigationTimeout(120000);

try {
  const suffix = `${Date.now().toString(36)}${Math.floor(Math.random() * 100)}`;
  const alice = `sma${suffix}@local`;
  const bob = `smb${suffix}@local`;
  const aliceName = alice.split('@')[0];
  const bobName = bob.split('@')[0];
  const groupTitle = `smoke-group-${suffix}`;

  console.log(`[smoke] register+login: ${alice}, ${bob}`);
  const aliceSession = await preparePage(aliceContext, alice, PASSWORD);
  const bobSession = await preparePage(bobContext, bob, PASSWORD);

  console.log('[smoke] 1-1 текст в обе стороны');
  const helloAB = `hello-from-alice-${suffix}`;
  const helloBA = `hello-from-bob-${suffix}`;
  await openPrivateChatStrict(aliceSession.page, bob);
  await sendText(aliceSession.page, helloAB);
  await openPrivateChatStrict(bobSession.page, alice);
  await findMessage(bobSession.page, helloAB).first()
    .waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await sendText(bobSession.page, helloBA);
  await findMessage(aliceSession.page, helloBA).first()
    .waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });

  console.log('[smoke] правка');
  const edited = `edited-by-alice-${suffix}`;
  await editText(aliceSession.page, helloAB, edited);
  await findMessage(bobSession.page, edited).first()
    .waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });

  console.log('[smoke] реакция');
  await addReaction(bobSession.page, edited, '👍');
  await findMessageContainers(aliceSession.page, edited).first()
    .locator('.Reactions, .reactions, .ReactionButton')
    .first()
    .waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });

  console.log('[smoke] пин (отредактированного сообщения — регрессия ctHash-фикса decCache)');
  await pinMessage(aliceSession.page, edited);
  await aliceSession.page.locator('.HeaderPinnedMessageWrapper')
    .first()
    .waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  // Пин едет к собеседнику периодическим delta-sync (10s) — ждём до 90s
  await bobSession.page.locator('.HeaderPinnedMessageWrapper')
    .first()
    .waitFor({ state: 'visible', timeout: 90000 });

  console.log('[smoke] удаление');
  const doomed = `to-delete-${suffix}`;
  await sendText(bobSession.page, doomed);
  await findMessage(aliceSession.page, doomed).first()
    .waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await deleteMessage(bobSession.page, doomed);
  await findMessage(aliceSession.page, doomed).first()
    .waitFor({ state: 'hidden', timeout: LOGIN_TIMEOUT_MS });

  console.log('[smoke] фото через cloud');
  const photoCaption = `photo-${suffix}`;
  await attachPhoto(aliceSession.page, photoCaption);
  const bobPhoto = findMessageContainers(bobSession.page, photoCaption).first();
  await bobPhoto.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await bobPhoto.locator('img').first().waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });

  console.log('[smoke] превью ссылки (шард preview)');
  // Первый send прогревает кэш шарда (холодный fetch не успевает в дедлайн)
  await sendText(aliceSession.page, 'look https://example.com/');
  await aliceSession.page.waitForTimeout(4000);
  await sendText(aliceSession.page, 'again https://example.com/');
  await findMessageContainers(bobSession.page, 'again https://example.com/').first()
    .waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  const bobPreview = bobSession.page.locator('.WebPage').last();
  await bobPreview.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });

  console.log('[smoke] группа');
  const groupHello = `group-hello-${suffix}`;
  const groupReply = `group-reply-${suffix}`;
  await createGroupWith(aliceSession.page, bobName, groupTitle);
  await openGroupChat(aliceSession.page, groupTitle);
  await aliceSession.page.locator('.MiddleHeader').getByText('2 members')
    .waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS }).catch(() => {});
  await sendText(aliceSession.page, groupHello);
  await openGroupChat(bobSession.page, groupTitle);
  await findMessage(bobSession.page, groupHello).first()
    .waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await sendText(bobSession.page, groupReply);
  await findMessage(aliceSession.page, groupReply).first()
    .waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });

  console.log('[smoke] reload-персистентность (E2E-ключи и история)');
  await aliceSession.page.reload({ waitUntil: 'domcontentloaded' });
  // Клиент по дизайну не хранит пароль: после перезагрузки помнит адрес и
  // просит пароль заново — вводим и ждём загрузки
  const reloginPassword = aliceSession.page.locator('#sign-in-password');
  await reloginPassword.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await reloginPassword.fill(PASSWORD);
  await aliceSession.page.locator('.Transition_slide-active > #auth-password-form')
    .getByRole('button', { name: 'Next' }).click();
  await aliceSession.page.locator('#LeftColumn').waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await openPrivateChatStrict(aliceSession.page, bob);
  await findMessage(aliceSession.page, helloBA).first()
    .waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await findMessage(aliceSession.page, edited).first()
    .waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });

  assertNoPageErrors({ [aliceName]: aliceSession, [bobName]: bobSession });
  console.log('PROD SMOKE OK');
} catch (err) {
  const shotDir = new URL('../web/telegram-tt/test-results/', import.meta.url).pathname;
  for (const [who, ctx] of [['alice', aliceContext], ['bob', bobContext]]) {
    const page = ctx.pages()[0];
    if (page) {
      await page.screenshot({ path: `${shotDir}prod-smoke-${who}.png`, fullPage: true })
        .catch(() => {});
    }
  }
  console.error(`screenshots: ${shotDir}prod-smoke-{alice,bob}.png`);
  throw err;
} finally {
  await browser.close();
}
