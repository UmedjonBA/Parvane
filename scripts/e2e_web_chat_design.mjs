// Чаты по макету (spec 041 E5; доски `DeskChats`, `Main`, `ZpChat`, `PhCalls`).
// Компьютер: в шапке списка чатов одно поле поиска 40 px (кнопки «Написать» нет, создание — «+» панели
// модулей); меню сообщения несёт «В план» и «В заметку» с пояснением справа — заметка создаётся, «План»
// открывает окно ввода с текстом сообщения. Телефон: заголовок «Чаты» и поиск значком; меню сообщения и
// вложения — шторки у нижнего края во всю ширину, вложения — плитками в ряд.
// Запуск: scripts/run_web_chat_design_e2e.sh
import assert from 'node:assert/strict';

import { chromium } from '../web/telegram-tt/node_modules/playwright/index.mjs';

import {
  disconnectWhileOffline,
  dismissRecoveryKeyDialog,
  expectToast,
  findMessageContainer,
  openMessageMenuOn,
  openSavedMessages,
  preparePage,
  reloadPage,
  sendText,
  waitForSocketCount,
} from './e2e_web_helpers.mjs';

const PASSWORD = 'Parvane-chat-design-e2e-1';
const WIDE = { width: 1280, height: 800 };
const PHONE = { width: 360, height: 800 };
const STEP_TIMEOUT_MS = 30000;
const SEARCH_HEIGHT = 40;
const TAP_TARGET = 44;

const browser = await chromium.launch();

try {
  const suffix = `${Date.now().toString(36)}-${process.pid}`;

  // ── Компьютер ────────────────────────────────────────────────────────────────
  const wide = await browser.newContext({ viewport: WIDE });
  const { page } = await preparePage(wide, `design-vera-${suffix}@local`, PASSWORD);
  await dismissRecoveryKeyDialog(page).catch(() => undefined);

  const header = page.locator('#LeftMainHeader');
  await header.getByRole('heading', { name: 'Chats' }).waitFor({ state: 'attached', timeout: STEP_TIMEOUT_MS });
  assert.equal(await header.locator('.left-header-compose').count(), 0, 'кнопки «Написать» в шапке нет');
  const searchBox = await header.locator('.SearchInput').boundingBox();
  const headerBox = await header.boundingBox();
  assert.ok(Math.abs(searchBox.height - SEARCH_HEIGHT) <= 1, `поле поиска 40 px: ${JSON.stringify(searchBox)}`);
  assert.ok(searchBox.width > headerBox.width - 40, `поле поиска во всю шапку: ${JSON.stringify(searchBox)}`);
  const titleBox = await header.locator('.left-header-title').boundingBox();
  assert.ok(titleBox.width <= 2, 'заголовок на компьютере — только для чтения с экрана');
  // Создание чата — «+» панели модулей
  await page.locator('[data-add-for="chats"]').click();
  await page.getByRole('menuitem', { name: 'New group' }).waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await page.keyboard.press('Escape');
  console.log('OK: шапка списка чатов на компьютере — поле поиска 40 px');
  // «Новое сообщение» (доска `ZpChat2`): «Новая группа», «Новый канал», контакты и ник с другого сервера
  await page.locator('[data-add-for="chats"]').click();
  await page.getByRole('menuitem', { name: 'New message' }).click();
  const remote = page.locator('#LeftColumn [data-contacts-remote]');
  await remote.waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  for (const name of ['New group', 'New channel']) {
    await page.locator('#LeftColumn .ListItem').filter({ hasText: name }).first()
      .waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  }
  await remote.getByPlaceholder('@nick@server').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await page.keyboard.press('Escape');
  await remote.waitFor({ state: 'hidden', timeout: STEP_TIMEOUT_MS });
  console.log('OK: «Новое сообщение» — группа, канал, контакты и ник с другого сервера');

  await openSavedMessages(page);
  const noteText = `Сверить копии ${suffix}`;
  await sendText(page, noteText);
  await openMessageMenuOn(findMessageContainer(page, noteText));
  const menu = page.locator('.MessageContextMenu');
  const toNote = menu.getByRole('menuitem', { name: /^To a note/ });
  await toNote.waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  assert.equal((await toNote.locator('.MessageContextMenu--hint').innerText()).trim(), 'new or existing');
  assert.equal(
    (await menu.getByRole('menuitem', { name: /^To plan/ }).locator('.MessageContextMenu--hint').innerText()).trim(),
    'task from the text',
  );
  await toNote.click();
  // Выбор: новая заметка либо существующая (доска `ZpChat`: «новая или в существующую»)
  await page.locator('[data-note-pick-new]').click();
  await expectToast(page, `Saved to notes: “${noteText}”`);
  // Второе сообщение дописывается в ту же заметку
  const moreText = `Ещё строка ${suffix}`;
  await sendText(page, moreText);
  await openMessageMenuOn(findMessageContainer(page, moreText));
  await menu.getByRole('menuitem', { name: /^To a note/ }).click();
  await page.locator(`[data-article-notes] [data-article-note="${noteText}"]`)
    .click({ timeout: 60000 });
  await expectToast(page, `Saved to notes: “${noteText}”`);
  await page.locator('#FoldersSidebar').getByRole('tab', { name: 'Notes' }).click();
  const noteRow = page.locator(`#ParvaneKnowledge [data-note-row="${noteText}"]`).first();
  await noteRow.waitFor({ state: 'visible', timeout: 60000 });
  await noteRow.click();
  for (const text of [noteText, moreText]) {
    await page.locator('#ParvaneKnowledge [data-note-body]').getByText(text).first()
      .waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  }
  await page.locator('#FoldersSidebar').getByRole('tab', { name: 'Chats' }).click();
  console.log('OK: «В заметку» — новая заметка и дописывание в существующую');

  const planText = `Проверить диск ${suffix} завтра 12:00`;
  await sendText(page, planText);
  await openMessageMenuOn(findMessageContainer(page, planText));
  await menu.getByRole('menuitem', { name: /^To plan/ }).click();
  const quick = page.locator('#planner-quick-input');
  await quick.waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  // Текст ложится в поле кадром позже появления окна
  await page.waitForFunction(
    (wanted) => document.getElementById('planner-quick-input')?.value === wanted, planText, { timeout: STEP_TIMEOUT_MS },
  ).catch(async () => assert.equal(await quick.inputValue(), planText, 'окно ввода «Плана» несёт текст сообщения'));
  await page.keyboard.press('Escape');
  console.log('OK: «В план» открывает окно ввода с текстом сообщения');

  // Плашка «ключ безопасности изменился · Сверить» (доска `ZpChat`): отметку смены ключа ставит синхронизация;
  // здесь она подставлена в память устройства для своего чата, проверяется показ и «Сверить»
  await page.evaluate(() => {
    localStorage.setItem('parvane:key-changed', JSON.stringify([window.__parvaneGetGlobal().currentUserId]));
  });
  await reloadPage(page);
  await openSavedMessages(page);
  const keyPane = page.locator('[data-key-change-pane]');
  await keyPane.getByText('security key has changed', { exact: false }).waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  // Кадры служебных плашек для сверки с доской `ZpChat-03`
  if (process.env.PARVANE_E2E_SHOT_DIR) await page.screenshot({ path: `${process.env.PARVANE_E2E_SHOT_DIR}/chat-key-changed.png` });
  await keyPane.getByRole('button', { name: 'Verify', exact: true }).click();
  await keyPane.waitFor({ state: 'detached', timeout: STEP_TIMEOUT_MS });
  await page.locator('#RightColumn').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  assert.equal(await page.evaluate(() => localStorage.getItem('parvane:key-changed')), '[]');
  console.log('OK: плашка смены ключа и «Сверить» открывает профиль');

  // «Не доставлено · Отменить отправку» (доска `ZpChat`): без связи отправка не удаётся — под сообщением строка
  // с кнопкой, она убирает неотправленное
  await page.keyboard.press('Escape');
  await openSavedMessages(page);
  await disconnectWhileOffline(wide, page);
  await waitForSocketCount(page, 'closed', 1);
  const lostText = `Без связи ${suffix}`;
  await sendText(page, lostText);
  const failedRow = findMessageContainer(page, lostText).locator('[data-message-send-failed]');
  await failedRow.getByText('Not delivered', { exact: false }).waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  if (process.env.PARVANE_E2E_SHOT_DIR) await page.screenshot({ path: `${process.env.PARVANE_E2E_SHOT_DIR}/chat-not-delivered.png` });
  await wide.setOffline(false);
  await failedRow.getByRole('button', { name: 'Cancel sending', exact: true }).click();
  await page.waitForFunction(
    (text) => ![...document.querySelectorAll('.Transition_slide-active > .MessageList .Message')]
      .some((element) => element.textContent.includes(text)),
    lostText,
    { timeout: STEP_TIMEOUT_MS },
  );
  console.log('OK: «Не доставлено · Отменить отправку» убирает неотправленное');

  // Широкое окно: строка ввода занимает всю нижнюю полосу (доска `DeskChats`: скрепка у левого края), а не ширину
  // ленты сообщений по центру
  await page.setViewportSize({ width: 1896, height: 1030 });
  await page.waitForFunction(() => {
    const middle = document.querySelector('#MiddleColumn')?.getBoundingClientRect();
    const attach = document.querySelector('#MiddleColumn .middle-column-footer .AttachMenu')?.getBoundingClientRect();
    return middle && attach && attach.left - middle.left < 80;
  }, undefined, { timeout: STEP_TIMEOUT_MS });
  console.log('OK: строка ввода на широком окне — во всю нижнюю полосу');
  // Край колонки чатов перетащен мышью: ширина пишется в `style` колонки, а «Профиль» всё равно во всю ширину
  const handle = await page.locator('#MiddleColumn .resize-handle').first().boundingBox();
  await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
  await page.mouse.down();
  await page.mouse.move(handle.x - 120, handle.y + handle.height / 2, { steps: 8 });
  await page.mouse.up();
  const resized = await page.locator('#LeftColumn').boundingBox();
  await page.locator('[data-module="profile"]').click();
  await page.waitForFunction(
    (narrowWidth) => {
      const left = document.querySelector('#Main.section-profile > #LeftColumn')?.getBoundingClientRect();
      return left && left.width > narrowWidth + 600;
    },
    resized.width,
    { timeout: STEP_TIMEOUT_MS },
  );
  await page.locator('[data-module="chats"]').click();
  await page.waitForFunction(
    (narrowWidth) => Math.abs(document.querySelector('#LeftColumn').getBoundingClientRect().width - narrowWidth) <= 2,
    resized.width,
    { timeout: STEP_TIMEOUT_MS },
  );
  console.log('OK: «Профиль» во всю ширину и после перетаскивания края колонки чатов');
  await wide.close();

  // ── Телефон ──────────────────────────────────────────────────────────────────
  const narrow = await browser.newContext({ viewport: PHONE, hasTouch: true, isMobile: true });
  const { page: phone } = await preparePage(narrow, `design-gleb-${suffix}@local`, PASSWORD);
  await dismissRecoveryKeyDialog(phone).catch(() => undefined);

  const phoneHeader = phone.locator('#LeftMainHeader');
  await phoneHeader.getByRole('heading', { name: 'Chats' }).waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  const phoneTitle = await phoneHeader.locator('.left-header-title').boundingBox();
  const phoneSearch = await phoneHeader.locator('.SearchInput').boundingBox();
  assert.ok(phoneTitle.width > 30, 'на телефоне заголовок «Чаты» показан');
  assert.ok(Math.abs(phoneSearch.width - TAP_TARGET) <= 1 && Math.abs(phoneSearch.height - TAP_TARGET) <= 1,
    `поиск на телефоне — значок 44 px: ${JSON.stringify(phoneSearch)}`);
  console.log('OK: шапка списка чатов на телефоне — заголовок и поиск значком');

  await openSavedMessages(phone);
  const phoneText = `Ключ от стойки ${suffix}`;
  await sendText(phone, phoneText);

  // Вложения — шторка у нижнего края, плитки в ряд
  await phone.locator('#attach-menu-button').evaluate((el) => el.click());
  const sheet = phone.locator('.AttachMenu--menu .bubble');
  await sheet.getByText('Attachment', { exact: true }).waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await phone.waitForTimeout(400);
  const sheetBox = await sheet.boundingBox();
  assert.ok(sheetBox.x === 0 && Math.round(sheetBox.width) === PHONE.width, `шторка во всю ширину: ${JSON.stringify(sheetBox)}`);
  assert.ok(Math.abs(sheetBox.y + sheetBox.height - PHONE.height) <= 1, `шторка у нижнего края: ${JSON.stringify(sheetBox)}`);
  const tiles = sheet.getByRole('menuitem');
  assert.ok(await tiles.count() >= 4, 'плиток вложений не меньше четырёх');
  if (process.env.PARVANE_E2E_SHOT_DIR) await phone.screenshot({ path: `${process.env.PARVANE_E2E_SHOT_DIR}/chat-attach-sheet-phone.png` });
  const [first, second] = [await tiles.nth(0).boundingBox(), await tiles.nth(1).boundingBox()];
  assert.ok(Math.abs(first.y - second.y) <= 1 && second.x > first.x, 'плитки стоят в ряд');
  await phone.keyboard.press('Escape');
  await sheet.waitFor({ state: 'hidden', timeout: STEP_TIMEOUT_MS });
  console.log('OK: вложения на телефоне — шторка с плитками');

  // Меню сообщения — шторка у нижнего края
  await openMessageMenuOn(findMessageContainer(phone, phoneText));
  const phoneMenu = phone.locator('.MessageContextMenu .bubble');
  await phoneMenu.getByRole('menuitem', { name: /^To plan/ }).waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await phone.waitForTimeout(400);
  const menuBox = await phoneMenu.boundingBox();
  assert.ok(menuBox.x === 0 && Math.round(menuBox.width) === PHONE.width, `меню во всю ширину: ${JSON.stringify(menuBox)}`);
  assert.ok(Math.abs(menuBox.y + menuBox.height - PHONE.height) <= 1, `меню у нижнего края: ${JSON.stringify(menuBox)}`);
  await phoneMenu.getByRole('menuitem', { name: 'Reply', exact: true }).click();
  await phone.locator('.ComposerEmbeddedMessage').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  console.log('OK: меню сообщения на телефоне — шторка, пункт срабатывает');
  await narrow.close();
} finally {
  await browser.close();
}
