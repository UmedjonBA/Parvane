// Двухбраузерный сценарий: offline-доставка, reconnect, идемпотентность UUID,
// мутации сообщений, receipts/presence/typing, мульти-пересылка и поиск.
import assert from 'node:assert/strict';

import { chromium } from '../web/telegram-tt/node_modules/playwright/index.mjs';

import {
  LOGIN_TIMEOUT_MS,
  addReaction,
  deleteMessage,
  disconnectWhileOffline,
  editText,
  findMessage,
  findMessageContainer,
  forwardMessage,
  openPrivateChat,
  pickForwardRecipientAndSend,
  pinMessage,
  preparePage as preparePageShared,
  selectMessageAction,
  selectMessageActionOn,
  sendText,
  waitForSocketCount,
} from './e2e_web_helpers.mjs';

const PASSWORD = 'Parvane-sync-e2e-password';

const preparePage = (context, user) => preparePageShared(context, user, PASSWORD);

const browser = await chromium.launch();
const aliceContext = await browser.newContext();
const bobContext = await browser.newContext();

try {
  const suffix = `${Date.now()}-${process.pid}`;
  const alice = `sync-alice-${suffix}@local`;
  const bob = `sync-bob-${suffix}@local`;
  const message = `offline-reconnect-${suffix}`;
  const reply = `reply-${suffix}`;
  const editedReply = `modified-${suffix}`;

  const aliceSession = await preparePage(aliceContext, alice);
  const bobSession = await preparePage(bobContext, bob);
  await openPrivateChat(aliceSession.page, bob);
  await openPrivateChat(bobSession.page, alice);

  await disconnectWhileOffline(aliceContext, aliceSession.page);
  await waitForSocketCount(aliceSession.page, 'closed', 1);
  await sendText(bobSession.page, message);

  await aliceContext.setOffline(false);
  await waitForSocketCount(aliceSession.page, 'opened', 2);
  await findMessage(aliceSession.page, message).waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  assert.equal(await findMessage(aliceSession.page, message).count(), 1, 'offline message duplicated after reconnect');

  // Повторный reconnect обязан быть идемпотентным: sync/queue replay не создаёт
  // вторую копию уже применённого UUID.
  await disconnectWhileOffline(aliceContext, aliceSession.page);
  await waitForSocketCount(aliceSession.page, 'closed', 2);
  await aliceContext.setOffline(false);
  await waitForSocketCount(aliceSession.page, 'opened', 3);
  await aliceSession.page.waitForTimeout(1000);
  assert.equal(await findMessage(aliceSession.page, message).count(), 1, 'message duplicated after second reconnect');

  await addReaction(aliceSession.page, message, '👍');
  const bobOriginal = findMessageContainer(bobSession.page, message);
  await bobOriginal.locator('.message-reaction').filter({ hasText: '👍' })
    .waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });

  await pinMessage(aliceSession.page, message);
  await bobSession.page.locator('.HeaderPinnedMessageWrapper').filter({ hasText: message })
    .waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });

  await forwardMessage(aliceSession.page, message, bob);
  await bobSession.page.waitForFunction(
    (expected) => Array.from(document.querySelectorAll('.Transition_slide-active > .MessageList .Message'))
      .filter((element) => element.textContent?.includes(expected)).length === 2,
    message,
    { timeout: LOGIN_TIMEOUT_MS },
  );
  const forwarded = findMessageContainer(bobSession.page, message);
  assert.equal(await forwarded.locator('.forwarded-message').count(), 1, 'forward metadata is missing');

  await selectMessageAction(aliceSession.page, message, 'Reply');
  await aliceSession.page.locator('.ComposerEmbeddedMessage').filter({ hasText: message })
    .waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await sendText(aliceSession.page, reply);
  const bobReply = findMessageContainer(bobSession.page, reply);
  await bobReply.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  assert.match(await bobReply.innerText(), new RegExp(message), 'reply does not reference the original message');

  await editText(aliceSession.page, reply, editedReply);
  await findMessage(bobSession.page, editedReply).waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await findMessage(bobSession.page, reply).waitFor({ state: 'detached', timeout: LOGIN_TIMEOUT_MS });

  await deleteMessage(aliceSession.page, editedReply);
  await findMessage(bobSession.page, editedReply).waitFor({ state: 'detached', timeout: LOGIN_TIMEOUT_MS });

  // ── Живая доставка без reconnect (Bob → Alice при обоих онлайн) ────────────
  const liveMessage = `live-${suffix}`;
  await sendText(bobSession.page, liveMessage);
  await findMessage(aliceSession.page, liveMessage).waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });

  // ── Read receipt: Alice держит чат открытым → у Bob исходящее становится ✓✓ ─
  await findMessageContainer(bobSession.page, liveMessage)
    .locator('.icon-message-read')
    .waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });

  // ── Presence: Bob видит Alice онлайн (heartbeat раз в 30 секунд) ───────────
  await bobSession.page.locator('.MiddleHeader')
    .getByText('online', { exact: true })
    .waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });

  // ── Typing: Alice печатает → Bob видит индикатор ───────────────────────────
  await aliceSession.page.locator('#editable-message-text').pressSequentially('typing-probe', { delay: 60 });
  await bobSession.page.locator('.MiddleHeader')
    .getByText(/typing/i)
    .waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await aliceSession.page.locator('#editable-message-text').fill('');

  // ── Снятие реакции: клик по бейджу убирает 👍 у обоих ──────────────────────
  const aliceReacted = aliceSession.page.locator('.Transition_slide-active > .MessageList .Message')
    .filter({ hasText: message })
    .filter({ has: aliceSession.page.locator('.message-reaction') })
    .first();
  await aliceReacted.locator('.message-reaction').filter({ hasText: '👍' }).click();
  await bobSession.page.waitForFunction(
    () => !document.querySelector('.Transition_slide-active > .MessageList .message-reaction'),
    undefined,
    { timeout: LOGIN_TIMEOUT_MS },
  );

  // ── Unpin: закреп снимается у обоих ────────────────────────────────────────
  const alicePinned = aliceSession.page.locator('.Transition_slide-active > .MessageList .Message')
    .filter({ hasText: message })
    .first();
  await selectMessageActionOn(aliceSession.page, alicePinned, 'Unpin');
  await bobSession.page.locator('.HeaderPinnedMessageWrapper')
    .waitFor({ state: 'detached', timeout: LOGIN_TIMEOUT_MS });

  // ── Мульти-пересылка: две выбранные — одной операцией ──────────────────────
  const multiA = `multi-a-${suffix}`;
  const multiB = `multi-b-${suffix}`;
  await sendText(aliceSession.page, multiA);
  await sendText(aliceSession.page, multiB);
  await findMessage(bobSession.page, multiB).waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await selectMessageAction(aliceSession.page, multiA, 'Select');
  const selectToolbar = aliceSession.page.locator('.MessageSelectToolbar');
  await selectToolbar.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  // Клик по второму сообщению может промахнуться (анимации) — тогда пересылка
  // уйдёт с ОДНИМ выбранным (известный флак). Добиваемся счётчика «2 …»
  for (let attempt = 0; attempt < 6; attempt++) {
    await findMessageContainer(aliceSession.page, multiB).click();
    await aliceSession.page.waitForTimeout(300);
    if (/\b2\b/.test(await selectToolbar.innerText())) break;
  }
  assert.match(
    await selectToolbar.innerText(), /\b2\b/,
    'both messages must be selected before multi-forward',
  );
  await selectToolbar.getByRole('button', { name: 'Forward', exact: true }).click();
  await pickForwardRecipientAndSend(aliceSession.page, bob);
  for (const forwardedText of [multiA, multiB]) {
    await bobSession.page.waitForFunction(
      (expected) => Array.from(document.querySelectorAll('.Transition_slide-active > .MessageList .Message'))
        .filter((element) => element.textContent?.includes(expected)).length === 2,
      forwardedText,
      { timeout: LOGIN_TIMEOUT_MS },
    );
    assert.equal(
      await findMessageContainer(bobSession.page, forwardedText).locator('.forwarded-message').count(),
      1,
      `multi-forward metadata is missing for ${forwardedText}`,
    );
  }

  // ── Поиск по сообщениям: глобальный поиск находит текст ────────────────────
  const searchInput = bobSession.page.locator('#telegram-search-input');
  await searchInput.click();
  await bobSession.page.locator('.LeftSearch').waitFor({ state: 'visible', timeout: 10000 });
  await searchInput.fill(multiA);
  await bobSession.page.locator('.LeftSearch')
    .getByText(multiA)
    .first()
    .waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });

  assert.deepEqual(aliceSession.errors, [], `Alice page errors: ${aliceSession.errors.join('; ')}`);
  assert.deepEqual(bobSession.errors, [], `Bob page errors: ${bobSession.errors.join('; ')}`);

  console.log('OK: two-browser reconnect, mutations, receipts, presence, typing, multi-forward and search');
} finally {
  await aliceContext.close();
  await bobContext.close();
  await browser.close();
}
