// Пустые состояния свежего аккаунта: список чатов и переписка без истории
// должны показывать empty-state, а не вечный спиннер. Регрессия на гонку
// folderManager (active+archived прогружаются в одно throttle-окно) и на
// no-op updateListedIds для несуществующего треда.
import assert from 'node:assert/strict';

import { chromium } from '../web/telegram-tt/node_modules/playwright/index.mjs';

import { LOGIN_TIMEOUT_MS, assertNoPageErrors, openPrivateChat, preparePage } from './e2e_web_helpers.mjs';

const PASSWORD = 'Parvane-empty-state-e2e-password';

const browser = await chromium.launch();
const aliceContext = await browser.newContext();
const bobContext = await browser.newContext();

try {
  const suffix = `${Date.now()}-${process.pid}`;
  const alice = `empty-a-${suffix}@local`;
  const bob = `empty-b-${suffix}@local`;

  const aliceSession = await preparePage(aliceContext, alice, PASSWORD);
  const bobSession = await preparePage(bobContext, bob, PASSWORD);
  const { page } = aliceSession;

  // Пустой список чатов: empty-state вместо спиннера
  const emptyFolderTitle = page.locator('.chat-list h3', { hasText: 'No chats yet' });
  await emptyFolderTitle.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  assert.equal(await page.locator('.chat-list .Loading').count(), 0, 'chat list stuck in spinner');

  // Пустая переписка: greeting вместо спиннера
  await openPrivateChat(page, bob);
  const greeting = page.locator('#MiddleColumn', { hasText: 'No messages here yet' });
  await greeting.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  assert.equal(await page.locator('.MessageList .Loading').count(), 0, 'message list stuck in spinner');

  assertNoPageErrors({ alice: aliceSession, bob: bobSession });
  console.log('OK: пустой аккаунт показывает empty-state списка чатов и переписки без спиннеров');
} finally {
  await browser.close();
}
