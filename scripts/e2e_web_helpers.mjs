// Общие помощники двухбраузерных Web e2e сценариев (живой стек NATS+gateway).
// Скрипты-сценарии: e2e_web_sync_reconnect.mjs, e2e_web_media_ttl.mjs и другие.
import assert from 'node:assert/strict';

export const LOGIN_TIMEOUT_MS = 60000;
export const RECONNECT_TIMEOUT_MS = 30000;

export function requireEnv() {
  const baseUrl = process.env.PARVANE_E2E_BASE_URL;
  const gatewayUrl = process.env.PARVANE_E2E_GATEWAY_URL;
  assert(baseUrl, 'PARVANE_E2E_BASE_URL is required');
  assert(gatewayUrl, 'PARVANE_E2E_GATEWAY_URL is required');
  return { baseUrl, gatewayUrl };
}

export async function preparePage(context, user, password, { seedLocalStorage } = {}) {
  const { baseUrl, gatewayUrl } = requireEnv();
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (err) => errors.push(err.message));
  await page.addInitScript(({ gatewayUrl: url, seed }) => {
    localStorage.setItem('parvane:gateway', url);
    Object.entries(seed || {}).forEach(([key, value]) => {
      localStorage.setItem(key, value);
    });
    const NativeWebSocket = window.WebSocket;
    globalThis.__parvaneE2eSockets = { opened: 0, closed: 0, active: new Set() };
    globalThis.__parvaneE2eDisconnect = () => {
      for (const socket of globalThis.__parvaneE2eSockets.active) {
        socket.close(4001, 'e2e network interruption');
      }
    };
    window.WebSocket = class TrackedWebSocket extends NativeWebSocket {
      constructor(url2, protocols) {
        super(url2, protocols);
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
  }, { gatewayUrl, seed: seedLocalStorage });
  await page.route(/https:\/\/(?:t\.me|telegram\.me|telegram\.dog)\/_websync_/, async (route) => {
    await route.fulfill({ contentType: 'application/javascript', body: '' });
  });
  await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });

  const addressScreen = page.locator('.Transition_slide-active > #auth-phone-number-form');
  const addressInput = addressScreen.getByLabel('Address (user@server)');
  await addressInput.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await addressInput.fill(user);
  await addressScreen.getByRole('button', { name: 'Next' }).click();

  const passwordScreen = page.locator('.Transition_slide-active > #auth-password-form');
  await passwordScreen.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await passwordScreen.locator('#sign-in-password').fill(password);
  await passwordScreen.getByRole('button', { name: 'Next' }).click();
  await page.locator('#LeftColumn').waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await page.waitForFunction(() => globalThis.__parvaneE2eSockets?.opened === 1);
  return { page, errors };
}

export async function openPrivateChat(page, address) {
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

export async function sendText(page, text) {
  const input = page.locator('#editable-message-text');
  await input.fill(text);
  await input.press('Enter');
  await page.waitForFunction(() => !document.querySelector('#editable-message-text')?.textContent);
}

export function findMessage(page, text) {
  return page
    .locator('.Transition_slide-active > .MessageList .Message .text-content')
    .filter({ hasText: text });
}

export function findMessageContainers(page, text) {
  return page
    .locator('.Transition_slide-active > .MessageList .Message')
    .filter({ hasText: text });
}

export function findMessageContainer(page, text) {
  return findMessageContainers(page, text).last();
}

export async function openMessageMenuOn(container) {
  const box = await container.boundingBox();
  assert(box, 'message is not visible');
  await container.click({
    button: 'right',
    position: { x: box.width / 2, y: box.height / 2 },
  });
}

export async function selectMessageActionOn(page, container, action) {
  await openMessageMenuOn(container);
  const item = page.locator('.MessageContextMenu').getByRole('menuitem', { name: action, exact: true });
  await item.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await item.click();
}

export async function openMessageMenu(page, text) {
  await openMessageMenuOn(findMessageContainer(page, text));
}

export async function selectMessageAction(page, text, action) {
  await selectMessageActionOn(page, findMessageContainer(page, text), action);
}

export async function addReaction(page, text, emoji) {
  await openMessageMenu(page, text);
  const reaction = page.locator('.MessageContextMenu .ReactionSelector')
    .getByRole('button', { name: emoji, exact: true });
  await reaction.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await reaction.click();
}

export async function pinMessage(page, text) {
  await selectMessageAction(page, text, 'Pin');
  const confirm = page.locator('.Modal.pin').getByRole('button', { name: 'Pin', exact: true });
  await confirm.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await confirm.click();
}

export async function pickForwardRecipientAndSend(page, address) {
  const displayName = address.split('@')[0];
  const picker = page.locator('.Modal').filter({ has: page.locator('.ChatOrUserPicker-item') });
  await picker.locator('.search-input').fill(displayName);
  const recipient = picker.locator('.Transition_slide-active .ChatOrUserPicker-item')
    .filter({ hasText: displayName }).last();
  await recipient.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await recipient.click();
  await recipient.locator('.picker-checkbox.selected').waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await picker.locator('.picker-footer-button').click();
  const embedded = page.locator('.Transition_slide-active .ComposerEmbeddedMessage');
  await embedded.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await page.locator('.Transition_slide-active .Composer')
    .getByRole('button', { name: 'Forward', exact: true }).click();
  await embedded.waitFor({ state: 'hidden', timeout: LOGIN_TIMEOUT_MS });
}

export async function forwardMessage(page, text, address) {
  await selectMessageAction(page, text, 'Forward');
  await pickForwardRecipientAndSend(page, address);
}

export async function editText(page, sourceText, editedText) {
  await selectMessageAction(page, sourceText, 'Edit');
  await page.locator('.ComposerEmbeddedMessage').filter({ hasText: sourceText })
    .waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  const input = page.locator('#editable-message-text');
  await input.fill(editedText);
  await input.press('Enter');
}

export async function deleteMessage(page, text) {
  await selectMessageAction(page, text, 'Delete');
  const confirm = page.locator('.Modal').getByRole('button', { name: 'Delete', exact: true });
  await confirm.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await confirm.click();
}

export async function waitForSocketCount(page, field, count) {
  await page.waitForFunction(
    ({ fieldName, expected }) => globalThis.__parvaneE2eSockets?.[fieldName] >= expected,
    { fieldName: field, expected: count },
    { timeout: RECONNECT_TIMEOUT_MS },
  );
}

export async function disconnectWhileOffline(context, page) {
  await context.setOffline(true);
  await page.evaluate(() => globalThis.__parvaneE2eDisconnect());
}

export function assertNoPageErrors(sessions) {
  for (const [name, session] of Object.entries(sessions)) {
    assert.deepEqual(session.errors, [], `${name} page errors: ${session.errors.join('; ')}`);
  }
}

// Reload + вход. keep-signed-in (92e73322): пароль сохранён и вход после
// reload автоматический; форма пароля появляется только без сохранённой сессии
export async function relogin(page, password) {
  await page.reload({ waitUntil: 'domcontentloaded' });
  const passwordScreen = page.locator('.Transition_slide-active > #auth-password-form');
  const leftColumn = page.locator('#LeftColumn');
  await Promise.race([
    passwordScreen.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS }),
    leftColumn.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS }),
  ]);
  if (await passwordScreen.isVisible()) {
    await passwordScreen.locator('#sign-in-password').fill(password);
    await passwordScreen.getByRole('button', { name: 'Next' }).click();
  }
  await leftColumn.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
}

// Журнал действий клиента (web util/parvaneDiag, localStorage parvane:diag:v1)
// — при падении сценария печатаем хвост: видно апдейты/ошибки провайдера
export async function dumpDiagJournal(page, label, limit = 40) {
  const lines = await page.evaluate((max) => {
    try {
      const raw = localStorage.getItem('parvane:diag:v1');
      const entries = raw ? JSON.parse(raw) : [];
      return entries.slice(-max).map((e) => `${new Date(e.t).toISOString().slice(11, 23)} ${e.k}${e.n ? ` x${e.n}` : ''} ${(e.d || '').slice(0, 140)}`);
    } catch (e) { return [`diag unavailable: ${e}`]; }
  }, limit).catch((e) => [`diag eval failed: ${e.message}`]);
  console.error(`--- diag ${label} ---\n${lines.join('\n')}`);
}
