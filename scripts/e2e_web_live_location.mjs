// e2e: геолокация и live-локация в web-клиенте.
//  - статичная точка: карта (склейка OSM-тайлов через шард preview) рендерится
//    у получателя картинкой, а не вечным скелетоном;
//  - live: пункт Live Location → 15 min; у получателя таймер обратного отсчёта
//    и «updated …»; позиция обновляется правкой (меняем геолокацию контекста);
//  - Stop Sharing Location у автора гасит live у получателя.
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import {
  preparePage,
  openPrivateChatStrict,
  openMessageMenu,
  dumpDiagJournal,
  LOGIN_TIMEOUT_MS,
} from './e2e_web_helpers.mjs';

const PASSWORD = 'pw1';
const LIVE_UPDATE_TIMEOUT_MS = 60000;
const browser = await chromium.launch();
const aliceContext = await browser.newContext({
  permissions: ['geolocation'], geolocation: { latitude: 52.52, longitude: 13.405 },
});
const bobContext = await browser.newContext();

function locationBubbles(page) {
  return page.locator('.Transition_slide-active > .MessageList .Message .Location');
}

try {
  const suffix = `${Date.now().toString(36)}${Math.floor(Math.random() * 100)}`;
  const alice = `lla${suffix}@local`;
  const bob = `llb${suffix}@local`;
  const aliceSession = await preparePage(aliceContext, alice, PASSWORD);
  const bobSession = await preparePage(bobContext, bob, PASSWORD);
  await openPrivateChatStrict(aliceSession.page, bob);
  await openPrivateChatStrict(bobSession.page, alice);

  console.log('[live-location] статичная точка + карта');
  await aliceSession.page.getByRole('button', { name: 'Add an attachment' }).click();
  await aliceSession.page.getByRole('menuitem', { name: 'Location', exact: true }).click();
  const bobStatic = locationBubbles(bobSession.page).first();
  await bobStatic.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await bobStatic.locator('img.map[src^="blob:"]').waitFor({ state: 'visible', timeout: LIVE_UPDATE_TIMEOUT_MS });
  await aliceSession.page.locator('.Transition_slide-active > .MessageList .Message .Location img.map[src^="blob:"]')
    .first().waitFor({ state: 'visible', timeout: LIVE_UPDATE_TIMEOUT_MS });

  console.log('[live-location] live на 15 минут');
  await aliceSession.page.getByRole('button', { name: 'Add an attachment' }).click();
  await aliceSession.page.getByRole('menuitem', { name: 'Live Location' }).hover();
  const period = aliceSession.page.getByRole('menuitem', { name: '15 min' });
  await period.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await period.click();
  const bobLive = locationBubbles(bobSession.page).nth(1);
  await bobLive.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await bobLive.locator('.geo-countdown').waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await bobLive.locator('.location-avatar').waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });

  console.log('[live-location] обновление позиции доезжает получателю');
  await aliceContext.setGeolocation({ latitude: 48.8566, longitude: 2.3522 });
  await bobSession.page.waitForFunction(() => {
    const g = window.__parvaneGetGlobal?.();
    const tab = Object.values(g?.byTabId || {})[0];
    const chatId = tab?.messageLists?.[0]?.chatId;
    const byId = g?.messages?.byChatId?.[chatId]?.byId || {};
    return Object.values(byId).some((m) => m.content?.location?.mediaType === 'geoLive'
      && Math.abs(m.content.location.geo.lat - 48.8566) < 0.01);
  }, undefined, { timeout: LIVE_UPDATE_TIMEOUT_MS });
  await bobLive.locator('.geo-countdown').waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });

  console.log('[live-location] Stop Sharing Location');
  await openMessageMenu(aliceSession.page, 'Live Location');
  const stopItem = aliceSession.page.locator('.MessageContextMenu').getByRole('menuitem', { name: 'Stop Sharing Location' });
  await stopItem.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await stopItem.click();
  await bobLive.locator('.geo-countdown').waitFor({ state: 'hidden', timeout: LIVE_UPDATE_TIMEOUT_MS });
  // У автора таймер тоже гаснет (истёкший period)
  await locationBubbles(aliceSession.page).nth(1).locator('.geo-countdown')
    .waitFor({ state: 'hidden', timeout: LIVE_UPDATE_TIMEOUT_MS });
  assert.equal(await locationBubbles(bobSession.page).count(), 2, 'both location bubbles remain');

  console.log('OK: location map, live location start/update/stop');
} catch (err) {
  const dir = new URL('../web/telegram-tt/test-results/', import.meta.url).pathname;
  for (const [name, context] of [['alice', aliceContext], ['bob', bobContext]]) {
    const page = context.pages()[0];
    if (page) {
      await page.screenshot({ path: `${dir}live-location-${name}.png` }).catch(() => {});
      await dumpDiagJournal(page, name, 200);
    }
  }
  throw err;
} finally {
  await browser.close();
}
