// e2e: геолокация и live-локация в web-клиенте.
//  - статичная точка: карта (склейка OSM-тайлов через шард preview) рендерится
//    у получателя картинкой, а не вечным скелетоном;
//  - live: пункт Live Location → 15 min; у получателя таймер обратного отсчёта
//    и «updated …»; позиция обновляется правкой (меняем геолокацию контекста);
//  - Stop Sharing Location у автора гасит live у получателя.
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import {
  LOGIN_TIMEOUT_MS,
  dumpDiagJournal,
  openMessageMenu,
  openPrivateChatStrict,
  preparePage,
  sendLocation,
} from './e2e_web_helpers.mjs';

const PASSWORD = 'Parvane-live-location-e2e-password';
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
  await sendLocation(aliceSession.page);
  const bobStatic = locationBubbles(bobSession.page).first();
  await bobStatic.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await bobStatic.locator('img.map[src^="blob:"]').waitFor({ state: 'visible', timeout: LIVE_UPDATE_TIMEOUT_MS });
  await aliceSession.page.locator('.Transition_slide-active > .MessageList .Message .Location img.map[src^="blob:"]')
    .first().waitFor({ state: 'visible', timeout: LIVE_UPDATE_TIMEOUT_MS });

  console.log('[live-location] live на 15 минут');
  await sendLocation(aliceSession.page, { period: '15 min' });
  const bobLive = locationBubbles(bobSession.page).nth(1);
  await bobLive.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await bobLive.locator('.geo-countdown').waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await bobLive.locator('.location-avatar').waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });

  console.log('[live-location] обновление позиции доезжает получателю');
  // Без хуков window.__parvane* (в прод-сборке их нет): новая позиция →
  // новый хэш карты → у получателя меняется blob-картинка карты
  const liveMap = bobLive.locator('img.map[src^="blob:"]');
  await liveMap.waitFor({ state: 'visible', timeout: LIVE_UPDATE_TIMEOUT_MS });
  const mapBefore = await liveMap.getAttribute('src');
  await aliceContext.setGeolocation({ latitude: 48.8566, longitude: 2.3522 });
  await bobSession.page.waitForFunction(
    ({ selector, before }) => {
      const bubbles = document.querySelectorAll('.Transition_slide-active > .MessageList .Message .Location');
      const img = bubbles[1]?.querySelector(selector);
      return Boolean(img) && img.getAttribute('src') !== before;
    },
    { selector: 'img.map[src^="blob:"]', before: mapBefore },
    { timeout: LIVE_UPDATE_TIMEOUT_MS },
  );
  await bobLive.locator('.geo-countdown').waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });

  console.log('[live-location] Stop Sharing Location');
  // Карточка трансляции по доске `ZpChat`: «Вы показываете, где вы», «обновлено … · ещё N мин»
  await openMessageMenu(aliceSession.page, 'You are sharing your location');
  const stopItem = aliceSession.page.locator('.MessageContextMenu').getByRole('menuitem', { name: 'Stop Sharing Location' });
  await stopItem.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await stopItem.click();
  await bobLive.locator('.geo-countdown').waitFor({ state: 'hidden', timeout: LIVE_UPDATE_TIMEOUT_MS });
  // У автора таймер тоже гаснет (истёкший period)
  await locationBubbles(aliceSession.page).nth(1).locator('.geo-countdown')
    .waitFor({ state: 'hidden', timeout: LIVE_UPDATE_TIMEOUT_MS });
  assert.equal(await locationBubbles(bobSession.page).count(), 2, 'both location bubbles remain');

  console.log('OK: location map, live location start/update/stop');

  // Доска `ZpSysGen`: у Боба доступа к геопозиции нет — сначала лист «Доступ к геопозиции» (до запроса браузера),
  // «Не сейчас» оставляет ручной ввод и «Открыть настройки» с инструкцией вместо повторного запроса
  console.log('[live-location] лист перед запросом геопозиции');
  const bobPage = bobSession.page;
  await bobPage.getByRole('button', { name: 'Add an attachment' }).click();
  await bobPage.getByRole('menuitem', { name: 'Location', exact: true }).click();
  const ask = bobPage.locator('[data-location-ask-sheet]');
  await ask.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await ask.getByText('Needed to send a place to the chat').waitFor({ state: 'visible' });
  await ask.locator('[data-location-ask="later"]').click();
  await ask.waitFor({ state: 'detached', timeout: LOGIN_TIMEOUT_MS });
  await bobPage.locator('[data-location-settings]').click();
  const denied = bobPage.locator('[data-permission-denied="location"]');
  await denied.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await denied.getByRole('button', { name: 'OK', exact: true }).click();
  await denied.waitFor({ state: 'detached', timeout: LOGIN_TIMEOUT_MS });
  assert.equal(await bobPage.locator('[data-location-manual]').isVisible(), true, 'ручной ввод точки пропал');
  console.log('OK: лист «Доступ к геопозиции» и «Открыть настройки» без разрешения');
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
