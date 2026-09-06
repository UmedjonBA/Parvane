// Контакты: по умолчанию список пуст (каталог сервера не показываем),
// «Новый контакт» по нику добавляет пользователя, собеседник с перепиской
// попадает в контакты сам, «Удалить контакт» убирает. Всё переживает reload.
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
  await page.getByRole('button', { name: 'Open menu' }).first().click();
  await page.getByRole('menuitem', { name: 'Contacts' }).click();
  await page.getByPlaceholder('Search contacts').waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
}

async function closeContacts(page) {
  await page.getByRole('button', { name: /Return to chat list|Go back/ }).first().click();
  await page.getByPlaceholder('Search').first().waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
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
  await nickInput.fill(nick(bob));
  await page.getByLabel('First name (required)').last().fill('Bob');
  await page.getByRole('button', { name: 'Done' }).last().click();
  await nickInput.waitFor({ state: 'hidden', timeout: LOGIN_TIMEOUT_MS });
  // importContact открывает чат с добавленным; экран контактов остаётся открыт
  await page.locator('#MiddleColumn').getByText(nick(bob)).first().waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await contactRow(page, nick(bob)).first().waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  assert.equal(await contactRow(page, nick(carol)).count(), 0, 'carol не должна быть в контактах');
  console.log('OK: контакт по нику добавлен и виден в списке');
  await closeContacts(page);

  // ── Профиль собеседника: отпечаток ключа безопасности (12 групп hex) ──────
  await page.locator('#MiddleColumn .ChatInfo, #MiddleColumn .chat-info-wrapper, #MiddleColumn .MiddleHeader').first().click();
  const securityRow = page.locator('#RightColumn').getByText('Security key', { exact: true });
  await securityRow.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await page.locator('#RightColumn').getByText(/^([0-9a-f]{4} ){11}[0-9a-f]{4}$/).first()
    .waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  console.log('OK: в профиле показан отпечаток ключа безопасности');
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
  await contactRow(page, nick(bob)).first().waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await contactRow(page, nick(carol)).first().waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  console.log('OK: контакты пережили reload');

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
