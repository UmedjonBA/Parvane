import assert from 'node:assert/strict';

import { chromium } from '../web/telegram-tt/node_modules/playwright/index.mjs';

const BASE_URL = process.env.PARVANE_E2E_BASE_URL;
const GATEWAY_URL = process.env.PARVANE_E2E_GATEWAY_URL;
const PASSWORD = 'Parvane-sync-e2e-password';
const LOGIN_TIMEOUT_MS = 60000;
const RECONNECT_TIMEOUT_MS = 30000;

assert(BASE_URL, 'PARVANE_E2E_BASE_URL is required');
assert(GATEWAY_URL, 'PARVANE_E2E_GATEWAY_URL is required');

async function preparePage(context, user) {
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (err) => errors.push(err.message));
  await page.addInitScript(({ gatewayUrl }) => {
    localStorage.setItem('parvane:gateway', gatewayUrl);
    const NativeWebSocket = window.WebSocket;
    globalThis.__parvaneE2eSockets = { opened: 0, closed: 0, active: new Set() };
    globalThis.__parvaneE2eDisconnect = () => {
      for (const socket of globalThis.__parvaneE2eSockets.active) {
        socket.close(4001, 'e2e network interruption');
      }
    };
    window.WebSocket = class TrackedWebSocket extends NativeWebSocket {
      constructor(url, protocols) {
        super(url, protocols);
        globalThis.__parvaneE2eSockets.active.add(this);
        this.addEventListener('open', () => {
          globalThis.__parvaneE2eSockets.opened += 1;
        });
        this.addEventListener('close', () => {
          globalThis.__parvaneE2eSockets.active.delete(this);
          globalThis.__parvaneE2eSockets.closed += 1;
        });
      }
    };
  }, { gatewayUrl: GATEWAY_URL });
  await page.route(/https:\/\/(?:t\.me|telegram\.me|telegram\.dog)\/_websync_/, async (route) => {
    await route.fulfill({ contentType: 'application/javascript', body: '' });
  });
  await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });

  const addressScreen = page.locator('.Transition_slide-active > #auth-phone-number-form');
  const addressInput = addressScreen.getByLabel('Address (user@server)');
  await addressInput.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await addressInput.fill(user);
  await addressScreen.getByRole('button', { name: 'Next' }).click();

  const passwordScreen = page.locator('.Transition_slide-active > #auth-password-form');
  await passwordScreen.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await passwordScreen.locator('#sign-in-password').fill(PASSWORD);
  await passwordScreen.getByRole('button', { name: 'Next' }).click();
  await page.locator('#LeftColumn').waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await page.waitForFunction(() => globalThis.__parvaneE2eSockets?.opened === 1);
  return { page, errors };
}

async function openPrivateChat(page, address) {
  const search = page.locator('#telegram-search-input');
  const displayName = address.split('@')[0];
  await search.click();
  await page.locator('.LeftSearch').waitFor({ state: 'visible', timeout: 10000 });
  await page.waitForTimeout(250);
  await search.fill(displayName);
  const result = page.locator('.LeftSearch .search-result').filter({ hasText: displayName }).first();
  await result.waitFor({ state: 'visible', timeout: 15000 });
  await result.locator('.ListItem-button').click();
  await page.locator('#editable-message-text').waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
}

async function sendText(page, text) {
  const input = page.locator('#editable-message-text');
  await input.fill(text);
  await input.press('Enter');
  await page.waitForFunction(() => !document.querySelector('#editable-message-text')?.textContent);
}

function findMessage(page, text) {
  return page
    .locator('.Transition_slide-active > .MessageList .Message .text-content')
    .filter({ hasText: text });
}

function findMessageContainer(page, text) {
  return page
    .locator('.Transition_slide-active > .MessageList .Message')
    .filter({ hasText: text })
    .last();
}

async function openMessageMenu(page, text) {
  const message = findMessageContainer(page, text);
  const box = await message.boundingBox();
  assert(box, `message is not visible: ${text}`);
  await message.click({
    button: 'right',
    position: { x: box.width / 2, y: box.height / 2 },
  });
}

async function selectMessageAction(page, text, action) {
  await openMessageMenu(page, text);
  const item = page.locator('.MessageContextMenu').getByRole('menuitem', { name: action, exact: true });
  await item.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await item.click();
}

async function addReaction(page, text, emoji) {
  await openMessageMenu(page, text);
  const reaction = page.locator('.MessageContextMenu .ReactionSelector')
    .getByRole('button', { name: emoji, exact: true });
  await reaction.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await reaction.click();
}

async function pinMessage(page, text) {
  await selectMessageAction(page, text, 'Pin');
  const confirm = page.locator('.Modal.pin').getByRole('button', { name: 'Pin', exact: true });
  await confirm.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await confirm.click();
}

async function forwardMessage(page, text, address) {
  const displayName = address.split('@')[0];
  await selectMessageAction(page, text, 'Forward');
  const picker = page.locator('.Modal').filter({ has: page.locator('.ChatOrUserPicker-item') });
  await picker.locator('.search-input').fill(displayName);
  const recipient = picker.locator('.Transition_slide-active .ChatOrUserPicker-item')
    .filter({ hasText: displayName }).last();
  await recipient.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await recipient.click();
  await recipient.locator('.picker-checkbox.selected').waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await picker.locator('.picker-footer-button').click();
  const embedded = page.locator('.Transition_slide-active .ComposerEmbeddedMessage').filter({ hasText: text });
  await embedded.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await page.locator('.Transition_slide-active .Composer')
    .getByRole('button', { name: 'Forward', exact: true }).click();
  await embedded.waitFor({ state: 'hidden', timeout: LOGIN_TIMEOUT_MS });
}

async function editText(page, sourceText, editedText) {
  await selectMessageAction(page, sourceText, 'Edit');
  await page.locator('.ComposerEmbeddedMessage').filter({ hasText: sourceText })
    .waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  const input = page.locator('#editable-message-text');
  await input.fill(editedText);
  await input.press('Enter');
}

async function deleteMessage(page, text) {
  await selectMessageAction(page, text, 'Delete');
  const confirm = page.locator('.Modal').getByRole('button', { name: 'Delete', exact: true });
  await confirm.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await confirm.click();
}

async function waitForSocketCount(page, field, count) {
  await page.waitForFunction(
    ({ fieldName, expected }) => globalThis.__parvaneE2eSockets?.[fieldName] >= expected,
    { fieldName: field, expected: count },
    { timeout: RECONNECT_TIMEOUT_MS },
  );
}

async function disconnectWhileOffline(context, page) {
  await context.setOffline(true);
  await page.evaluate(() => globalThis.__parvaneE2eDisconnect());
}

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
  assert.deepEqual(aliceSession.errors, [], `Alice page errors: ${aliceSession.errors.join('; ')}`);
  assert.deepEqual(bobSession.errors, [], `Bob page errors: ${bobSession.errors.join('; ')}`);

  console.log('OK: two-browser reconnect, reply, edit, delete, reaction, pin, forward and UUID idempotency');
} finally {
  await aliceContext.close();
  await bobContext.close();
  await browser.close();
}
