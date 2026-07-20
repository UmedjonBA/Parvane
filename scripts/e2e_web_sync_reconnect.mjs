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
  return page.locator('.Message .text-content').filter({ hasText: text });
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
  assert.deepEqual(aliceSession.errors, [], `Alice page errors: ${aliceSession.errors.join('; ')}`);
  assert.deepEqual(bobSession.errors, [], `Bob page errors: ${bobSession.errors.join('; ')}`);

  console.log('OK: two-browser offline delivery, reconnect and UUID idempotency');
} finally {
  await aliceContext.close();
  await bobContext.close();
  await browser.close();
}
