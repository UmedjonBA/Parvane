// Двухбраузерный сценарий контент-функций: стикеры, GIF, кастом-эмодзи,
// запланированные сообщения, геолокация, папки чатов и блок-лист — включая
// персист после reload.
import assert from 'node:assert/strict';

import { chromium } from '../web/telegram-tt/node_modules/playwright/index.mjs';

import {
  relogin,
  LOGIN_TIMEOUT_MS,
  findMessage,
  findMessageContainers,
  openPrivateChat,
  preparePage,
  sendText,
} from './e2e_web_helpers.mjs';

const PASSWORD = 'Parvane-content-e2e-password';
const SCHEDULE_DELAY_SECS = 75;


async function openSymbolTab(page, tabName) {
  await page.getByRole('button', { name: 'Choose emoji, sticker or GIF' }).first().click();
  await page.locator('.SymbolMenu').waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await page.locator('.SymbolMenu').getByRole('button', { name: tabName, exact: true }).click();
}

const browser = await chromium.launch();
const aliceContext = await browser.newContext({ permissions: ['geolocation'], geolocation: { latitude: 52.52, longitude: 13.405 } });
const bobContext = await browser.newContext();

try {
  const suffix = `${Date.now()}-${process.pid}`;
  const alice = `content-alice-${suffix}@local`;
  const bob = `content-bob-${suffix}@local`;
  const bobName = bob.split('@')[0];
  const scheduledText = `scheduled-${suffix}`;
  const folderName = `F-${suffix.slice(-6)}`;

  const aliceSession = await preparePage(aliceContext, alice, PASSWORD);
  const bobSession = await preparePage(bobContext, bob, PASSWORD);
  await openPrivateChat(aliceSession.page, bob);
  await openPrivateChat(bobSession.page, alice);

  // ── Стикер: отправка из нативной панели, приём и reload у получателя ───────
  await openSymbolTab(aliceSession.page, 'Stickers');
  const firstSticker = aliceSession.page.locator('.SymbolMenu .symbol-set .StickerButton').first();
  await firstSticker.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await firstSticker.click();
  const bobSticker = bobSession.page.locator('.Transition_slide-active > .MessageList .Message .media-inner');
  await bobSticker.first().waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });

  // ── GIF: отправка из панели, приём как видео-бабл ──────────────────────────
  await openSymbolTab(aliceSession.page, 'GIFs');
  const firstGif = aliceSession.page.locator('.SymbolMenu .GifButton').first();
  await firstGif.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await firstGif.click();
  await bobSession.page.locator('.Transition_slide-active > .MessageList .Message video')
    .first().waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });

  // ── Кастом-эмодзи: вставка в сообщение и приём ─────────────────────────────
  await openSymbolTab(aliceSession.page, 'Custom Emoji');
  const firstCustomEmoji = aliceSession.page.locator('.SymbolMenu .symbol-set .StickerButton').first();
  await firstCustomEmoji.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await firstCustomEmoji.click();
  await aliceSession.page.keyboard.press('Escape');
  await aliceSession.page.locator('#editable-message-text').press('Enter');
  await bobSession.page.locator('.Transition_slide-active > .MessageList .Message .custom-emoji')
    .first().waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });

  // Reload Bob: стикер и GIF переживают повторный вход
  await relogin(bobSession.page, PASSWORD);
  await openPrivateChat(bobSession.page, alice);
  await bobSticker.first().waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await bobSession.page.locator('.Transition_slide-active > .MessageList .Message video')
    .first().waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });

  // Полученный GIF сохранился в панели GIF (2 builtin + принятый)
  await openSymbolTab(bobSession.page, 'GIFs');
  const bobGifButtons = bobSession.page.locator('.SymbolMenu .GifButton');
  await bobGifButtons.nth(2).waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await bobSession.page.keyboard.press('Escape');
  await bobSession.page.locator('.SymbolMenu').waitFor({ state: 'hidden', timeout: 10000 }).catch(() => {});

  // ── Геолокация: статичная точка ────────────────────────────────────────────
  await aliceSession.page.getByRole('button', { name: 'Add an attachment' }).click();
  await aliceSession.page.getByRole('menuitem', { name: 'Location', exact: true }).click();
  await bobSession.page.locator('.Transition_slide-active > .MessageList .Message .Location')
    .first().waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });

  // ── Запланированное сообщение: создаётся, переживает reload и доставляется ─
  const composerInput = aliceSession.page.locator('#editable-message-text');
  await composerInput.fill(scheduledText);
  await aliceSession.page.locator('.Composer .main-button.send').click({ button: 'right' });
  await aliceSession.page.getByRole('menuitem', { name: 'Schedule Message' }).click();
  const calendar = aliceSession.page.locator('.CalendarModal');
  await calendar.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  // Ближайший доступный слот: подтверждаем предложенное время
  await calendar.locator('.footer .Button, .footer button').first().click();
  await calendar.waitFor({ state: 'hidden', timeout: LOGIN_TIMEOUT_MS });

  // Reload Alice до срабатывания: очередь обязана пережить повторный вход
  await relogin(aliceSession.page, PASSWORD);
  await openPrivateChat(aliceSession.page, bob);

  await findMessage(bobSession.page, scheduledText).first()
    .waitFor({ state: 'visible', timeout: (SCHEDULE_DELAY_SECS + 90) * 1000 });

  // ── Папки чатов: локальный персист после reload ────────────────────────────
  await aliceSession.page.getByRole('button', { name: 'Open menu' }).first().click();
  await aliceSession.page.getByRole('menuitem', { name: 'Settings' }).click();
  await aliceSession.page.getByRole('button', { name: 'Chat Folders' }).click();
  await aliceSession.page.getByRole('button', { name: 'Create New Folder' }).click();
  const folderNameInput = aliceSession.page.getByRole('textbox', { name: 'Folder name' });
  await folderNameInput.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await folderNameInput.fill(folderName);
  await aliceSession.page.getByRole('button', { name: 'Add Chats' }).first().click();
  // Пикер переиспользует поиск new-group-picker-search; строка чата — не
  // кнопка, отмечаем через чекбокс отфильтрованной строки
  const folderSearch = aliceSession.page.locator('#new-group-picker-search');
  await folderSearch.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await folderSearch.fill(bobName);
  const folderChatRow = aliceSession.page.locator('#LeftColumn')
    .getByRole('button')
    .filter({ hasText: bobName })
    .first();
  await folderChatRow.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  // Клик может не отметить строку из-за анимаций — повторяем до чекбокса
  for (let attempt = 0; attempt < 6; attempt++) {
    if (await aliceSession.page.locator('#LeftColumn input[type="checkbox"]:checked').count()) break;
    await folderChatRow.click({ force: true });
    await aliceSession.page.waitForTimeout(500);
  }
  await aliceSession.page.getByRole('button', { name: 'Save', exact: true }).click();
  await aliceSession.page.getByRole('button', { name: 'Create folder' }).click();
  // Выходим из настроек по Escape: кнопки «назад» нестабильны в переходах
  for (let i = 0; i < 3; i++) {
    await aliceSession.page.keyboard.press('Escape');
    await aliceSession.page.waitForTimeout(400);
  }
  const folderTab = aliceSession.page.locator('#LeftColumn').getByText(folderName, { exact: true });
  await folderTab.first().waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });

  await relogin(aliceSession.page, PASSWORD);
  await folderTab.first().waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });

  // ── Блокировка: список переживает reload ───────────────────────────────────
  await aliceSession.page.getByRole('button', { name: 'Open menu' }).first().click();
  await aliceSession.page.getByRole('menuitem', { name: 'Settings' }).click();
  await aliceSession.page.getByRole('button', { name: 'Privacy and Security' }).click();
  await aliceSession.page.getByRole('button', { name: 'Blocked Users' }).click();
  const blockFab = aliceSession.page.getByRole('button', { name: 'Block', exact: true }).last();
  await blockFab.waitFor({ state: 'attached', timeout: LOGIN_TIMEOUT_MS });
  // Нативная клавиатурная активация <button> надёжнее кликов сквозь
  // reveal-анимацию FAB
  for (let attempt = 0; attempt < 6; attempt++) {
    if (await aliceSession.page.locator('.ChatOrUserPicker-item').count()) break;
    if (attempt % 2 === 0) {
      await blockFab.press('Enter').catch(() => {});
    } else {
      await blockFab.click({ force: true }).catch(() => {});
    }
    await aliceSession.page.waitForTimeout(500);
  }
  const blockPickerItem = aliceSession.page.locator('.ChatOrUserPicker-item')
    .filter({ hasText: bobName })
    .first();
  await blockPickerItem.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await blockPickerItem.click();
  const blockedRow = aliceSession.page.locator('#LeftColumn').getByText(bobName).filter({ visible: true });
  await blockedRow.first().waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });

  await relogin(aliceSession.page, PASSWORD);
  await aliceSession.page.getByRole('button', { name: 'Open menu' }).first().click();
  await aliceSession.page.getByRole('menuitem', { name: 'Settings' }).click();
  await aliceSession.page.getByRole('button', { name: 'Privacy and Security' }).click();
  await aliceSession.page.getByRole('button', { name: 'Blocked Users' }).click();
  await blockedRow.first().waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });

  assert.deepEqual(aliceSession.errors, [], `Alice page errors: ${aliceSession.errors.join('; ')}`);
  assert.deepEqual(bobSession.errors, [], `Bob page errors: ${bobSession.errors.join('; ')}`);

  console.log('OK: stickers, GIFs, custom emoji, scheduled send, location, folders and blocked list with reload');
} catch (err) {
  const dir = new URL('../web/telegram-tt/test-results/', import.meta.url).pathname;
  for (const [name, context] of [['alice', aliceContext], ['bob', bobContext]]) {
    const page = context.pages()[0];
    if (page) await page.screenshot({ path: `${dir}content-${name}.png` }).catch(() => {});
  }
  throw err;
} finally {
  await aliceContext.close();
  await bobContext.close();
  await browser.close();
}
