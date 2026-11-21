// Контакты: по умолчанию список пуст (каталог сервера не показываем),
// «Новый контакт» по нику добавляет пользователя, собеседник с перепиской
// попадает в контакты сам, «Удалить контакт» убирает. Своё имя контакта и «Заметка» (CONTACT-1) показываются
// вместо имени собеседника. Всё переживает reload.
import assert from 'node:assert/strict';

import { chromium } from '../web/telegram-tt/node_modules/playwright/index.mjs';

import {
  LOGIN_TIMEOUT_MS,
  assertNoPageErrors,
  dumpDiagJournal,
  findMessage,
  openPrivateChatStrict,
  preparePage as preparePageShared,
  sendText,
  openProfile,
  showChatList,
  waitForChatList,
  profileRow,
} from './e2e_web_helpers.mjs';

const PASSWORD = 'Parvane-contacts-e2e-password';
const preparePage = (context, user) => preparePageShared(context, user, PASSWORD);

const browser = await chromium.launch();
const aliceContext = await browser.newContext();
const bobContext = await browser.newContext();
const carolContext = await browser.newContext();
let aliceSession;
let bobSession;
let carolSession;

async function openContacts(page) {
  await openProfile(page);
  await profileRow(page, 'Contacts').click();
  await page.getByPlaceholder('Search contacts').waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
}

// «Контакты» открыты из «Профиля»: «назад» возвращает в «Профиль», к списку чатов — кнопка «Чаты»
async function closeContacts(page) {
  await page.locator('#LeftMainHeader').getByRole('button', { name: 'Return to chat list' }).click();
  await page.locator('#Settings').waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await showChatList(page);
  await waitForChatList(page);
}

const contactRow = (page, nick) => page.locator('.contact-list-item').filter({ hasText: nick });

try {
  const suffix = `${Date.now()}-${process.pid}`;
  const alice = `contacts-alice-${suffix}@local`;
  const bob = `contacts-bob-${suffix}@local`;
  const carol = `contacts-carol-${suffix}@local`;
  const nick = (address) => address.split('@')[0];

  aliceSession = await preparePage(aliceContext, alice);
  bobSession = await preparePage(bobContext, bob);
  carolSession = await preparePage(carolContext, carol);
  const { page } = aliceSession;

  // ── Пустой список у свежего аккаунта (не спиннер) ─────────────────────────
  await openContacts(page);
  await page.getByText('Contact list is empty.').waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  console.log('OK: у нового аккаунта список контактов пуст');

  // ── «Новый контакт» по нику ───────────────────────────────────────────────
  await page.getByRole('button', { name: 'Create New Contact' }).click();
  const nickInput = page.getByLabel('Nickname').last();
  await nickInput.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  // Модалка при открытии сбрасывает поля эффектом — ввод, попавший в тот же
  // кадр, стирается, и «Done» остаётся выключенной. Вводим, пока форма не
  // примет оба значения (кнопка включилась)
  const firstNameInput = page.getByLabel('First name (required)').last();
  const lastNameInput = page.getByLabel('Last name').last();
  const doneButton = page.getByRole('button', { name: 'Done' }).last();
  // Своё имя контакта (выдуманное) — вместо имени, которое bob задал себе сам
  const ownName = 'Robin Contact';
  const formDeadline = Date.now() + LOGIN_TIMEOUT_MS;
  for (;;) {
    await nickInput.fill(nick(bob));
    await firstNameInput.fill('Robin');
    await lastNameInput.fill('Contact');
    const isReady = await doneButton.isEnabled({ timeout: 2000 }).catch(() => false);
    if (isReady && await nickInput.inputValue() === nick(bob) && await firstNameInput.inputValue() === 'Robin'
      && await lastNameInput.inputValue() === 'Contact') break;
    assert(Date.now() < formDeadline, 'new contact form never accepted the nickname and the first name');
    await page.waitForTimeout(300);
  }
  await doneButton.click();
  await nickInput.waitFor({ state: 'hidden', timeout: LOGIN_TIMEOUT_MS });
  // importContact открывает чат с добавленным; экран контактов остаётся открыт. Шапка и список — своим именем
  await page.locator('#MiddleColumn').getByText(ownName).first().waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await contactRow(page, ownName).first().waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  assert.equal(await contactRow(page, nick(carol)).count(), 0, 'carol не должна быть в контактах');
  console.log('OK: контакт по нику добавлен и виден в списке под своим именем');
  await closeContacts(page);

  // ── Профиль собеседника: отпечаток ключа безопасности (12 групп hex) ──────
  await page.locator('#MiddleColumn .ChatInfo, #MiddleColumn .chat-info-wrapper, #MiddleColumn .MiddleHeader').first().click();
  // Профиль по доске `RpChat`: «Защита переписки» → «Код безопасности · сверить» раскрывает отпечатки
  const right = page.locator('#RightColumn');
  await right.locator('[data-peer-info]').waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await right.locator('[data-peer-status]').getByText(`@${nick(bob)}`, { exact: false })
    .waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await right.locator('[data-peer-code]').click();
  await right.locator('[data-peer-code-list]').getByText(/^([0-9a-f]{4} ){11}[0-9a-f]{4}$/).first()
    .waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  for (const row of ['[data-peer-shared]', '[data-peer-block]']) {
    await right.locator(row).waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  }
  console.log('OK: в профиле показан код безопасности, «Общие файлы и заметки», «Заблокировать»');

  // ── «Заметка — видна только вам» правится прямо в профиле, сохраняется по уходу из поля ─────────
  const noteText = 'Plays the cello on Fridays';
  const noteInput = right.locator('[data-peer-note]');
  await noteInput.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await noteInput.fill(noteText);
  await noteInput.press('Tab');
  await page.waitForFunction((text) => {
    const g = window.__parvaneGetGlobal?.();
    return Object.values(g?.users.fullInfoById || {}).some((info) => info?.note?.text === text);
  }, noteText, { timeout: LOGIN_TIMEOUT_MS });
  assert.equal(await noteInput.inputValue(), noteText);
  console.log('OK: заметка о контакте сохранена на месте');
  await page.keyboard.press('Escape');

  // ── Переписка делает собеседника контактом ────────────────────────────────
  const hello = `hello-${suffix}`;
  await openPrivateChatStrict(carolSession.page, alice);
  await sendText(carolSession.page, hello);
  await openPrivateChatStrict(page, carol);
  await findMessage(page, hello).waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await openContacts(page);
  await contactRow(page, nick(carol)).first().waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  console.log('OK: собеседник с перепиской виден в контактах');
  await closeContacts(page);

  // ── Reload: оба контакта на месте ─────────────────────────────────────────
  await page.waitForTimeout(1500);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.locator('#LeftColumn').waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await page.getByPlaceholder('Search').first().waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await openContacts(page);
  await contactRow(page, ownName).first().waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await contactRow(page, nick(carol)).first().waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  console.log('OK: контакты пережили reload');
  await contactRow(page, ownName).first().click();
  await page.locator('#MiddleColumn').getByText(ownName).first().waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await page.locator('#MiddleColumn .ChatInfo, #MiddleColumn .chat-info-wrapper, #MiddleColumn .MiddleHeader').first().click();
  await page.waitForFunction((text) => document.querySelector('#RightColumn [data-peer-note]')?.value === text,
    noteText, { timeout: LOGIN_TIMEOUT_MS });
  console.log('OK: своё имя контакта и заметка пережили reload');
  await page.keyboard.press('Escape');

  assertNoPageErrors({ alice: aliceSession, bob: bobSession, carol: carolSession });
  console.log('OK: контакты — пустой список, добавление по нику, переписка, persist');
} catch (error) {
  const shotDir = process.env.PARVANE_E2E_SHOT_DIR;
  if (shotDir && aliceSession) await aliceSession.page.screenshot({ path: `${shotDir}/contacts-alice.png` }).catch(() => {});
  if (aliceSession) await dumpDiagJournal(aliceSession.page, 'alice').catch(() => {});
  throw error;
} finally {
  await browser.close();
}
