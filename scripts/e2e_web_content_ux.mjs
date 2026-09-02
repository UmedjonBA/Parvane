// Двухбраузерный сценарий B4 (контент/UX): черновик переживает reload и
// расходится между вкладками; нерасшифрованное sealed-сообщение НЕ оседает
// в «Избранном» получателя.
import assert from 'node:assert/strict';

import { chromium } from '../web/telegram-tt/node_modules/playwright/index.mjs';

import {
  relogin,
  LOGIN_TIMEOUT_MS,
  openPrivateChat,
  preparePage,
  sendText,
} from './e2e_web_helpers.mjs';

const PASSWORD = 'Parvane-content-ux-e2e-password';


const browser = await chromium.launch();
const aliceContext = await browser.newContext();
const bobContext = await browser.newContext();

try {
  const suffix = `${Date.now()}-${process.pid}`;
  const alice = `cx-alice-${suffix}@local`;
  const bob = `cx-bob-${suffix}@local`;
  const draftText = `draft-${suffix}`;

  const aliceSession = await preparePage(aliceContext, alice, PASSWORD);
  const bobSession = await preparePage(bobContext, bob, PASSWORD);
  await openPrivateChat(aliceSession.page, bob);
  await openPrivateChat(bobSession.page, alice);

  // ── Черновик: набираем текст, НЕ отправляем ────────────────────────────────
  const input = aliceSession.page.locator('#editable-message-text');
  await input.fill(draftText);
  // Debounce useDraft — даём сохраниться, затем уводим фокус кликом по поиску
  await aliceSession.page.waitForTimeout(1500);
  await aliceSession.page.locator('#telegram-search-input').click();
  await aliceSession.page.keyboard.press('Escape');
  await aliceSession.page.waitForTimeout(1500);

  // ── Черновик переживает reload ─────────────────────────────────────────────
  await relogin(aliceSession.page, PASSWORD);
  // Чат с черновиком появляется в списке после fetchChats
  await aliceSession.page.locator('#LeftColumn .ListItem').filter({ hasText: bob.split('@')[0] })
    .first().waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await openPrivateChat(aliceSession.page, bob);
  await aliceSession.page.waitForTimeout(1000);
  const restoredDraft = await aliceSession.page.locator('#editable-message-text').innerText();
  assert.match(restoredDraft, new RegExp(draftText), 'черновик не восстановился после reload');

  // ── Кросс-таб: вторая вкладка того же пользователя видит черновик ──────────
  const aliceTab2 = await aliceContext.newPage();
  await aliceTab2.goto(aliceSession.page.url(), { waitUntil: 'domcontentloaded' });
  // Вторая вкладка стартует из кэша; черновик уже в localStorage
  const passwordScreen = aliceTab2.locator('.Transition_slide-active > #auth-password-form');
  if (await passwordScreen.isVisible().catch(() => false)) {
    await passwordScreen.locator('#sign-in-password').fill(PASSWORD);
    await passwordScreen.getByRole('button', { name: 'Next' }).click();
  }
  await aliceTab2.locator('#LeftColumn').waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await openPrivateChat(aliceTab2, bob);
  const tab2Draft = await aliceTab2.locator('#editable-message-text').innerText();
  assert.match(tab2Draft, new RegExp(draftText), 'черновик не виден во второй вкладке');
  await aliceTab2.close();

  // ── Очистка черновика отправкой ────────────────────────────────────────────
  await openPrivateChat(aliceSession.page, bob);
  await sendText(aliceSession.page, draftText);
  await aliceSession.page.waitForTimeout(1500);
  await relogin(aliceSession.page, PASSWORD);
  await openPrivateChat(aliceSession.page, bob);
  const clearedDraft = await aliceSession.page.locator('#editable-message-text').innerText();
  assert.equal(clearedDraft.trim(), '', 'черновик не очистился после отправки');

  // ── Link preview: шард тянет OG-метаданные example.com ─────────────────────
  // (машине нужен интернет). Первое сообщение прогревает кэш шарда — второе
  // попадает в кэш и укладывается в клиентский дедлайн с полным title
  await openPrivateChat(aliceSession.page, bob);
  await sendText(aliceSession.page, 'warm https://example.com first');
  await aliceSession.page.waitForTimeout(3000);
  await sendText(aliceSession.page, 'see https://example.com now');
  const bobWebPage = bobSession.page.locator('.Transition_slide-active > .MessageList .Message .WebPage')
    .last();
  await bobWebPage.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  const siteName = await bobWebPage.locator('.site-name').innerText();
  assert.match(siteName, /example\.com/, `site-name карточки: ${siteName}`);
  const cardTitle = await bobWebPage.locator('.site-title').innerText().catch(() => '');
  assert.match(cardTitle, /Example Domain/, `title карточки (rich preview): ${cardTitle}`);

  // ── Saved Messages не засорён: у Боба «Избранное» без чужих sealed ─────────
  // (Боб не пересылал ничего себе — self-чат должен отсутствовать в списке)
  const bobSavedCount = await bobSession.page.locator('#LeftColumn .ListItem')
    .filter({ hasText: 'Saved Messages' }).count();
  assert.equal(bobSavedCount, 0, 'в списке чатов Боба ошибочно появились Saved Messages');

  // ── Пин чата: закрепляется и переживает reload ─────────────────────────────
  const bobChatItem = () => aliceSession.page.locator('#LeftColumn .ListItem').filter({ hasText: bob.split('@')[0] }).first();
  await bobChatItem().click({ button: 'right' });
  await aliceSession.page.getByRole('menuitem', { name: /Pin to top|Pin/ }).first().click();
  await aliceSession.page.waitForTimeout(500);
  await relogin(aliceSession.page, PASSWORD);
  const pinnedChat = aliceSession.page.locator('#LeftColumn .ListItem').first();
  await pinnedChat.filter({ hasText: bob.split('@')[0] })
    .waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });

  // ── Архив: чат уходит в архив и исчезает из основного списка ───────────────
  await bobChatItem().click({ button: 'right' });
  await aliceSession.page.getByRole('menuitem', { name: 'Archive' }).click();
  await aliceSession.page.waitForTimeout(500);
  await relogin(aliceSession.page, PASSWORD);
  const bobInMain = await aliceSession.page.locator('#LeftColumn .ListItem')
    .filter({ hasText: bob.split('@')[0] }).count();
  assert.equal(bobInMain, 0, 'архивированный чат остался в основном списке после reload');

  assert.deepEqual(aliceSession.errors, [], `alice page errors: ${aliceSession.errors.join('; ')}`);
  assert.deepEqual(bobSession.errors, [], `bob page errors: ${bobSession.errors.join('; ')}`);
  console.log('OK: черновики, Saved Messages, link preview, пин и архив с persist после reload');
} catch (err) {
  const dir = new URL('../web/telegram-tt/test-results/', import.meta.url).pathname;
  await aliceContext.pages()[0]?.screenshot({ path: `${dir}content-ux-alice.png` }).catch(() => {});
  await bobContext.pages()[0]?.screenshot({ path: `${dir}content-ux-bob.png` }).catch(() => {});
  throw err;
} finally {
  await browser.close();
}
