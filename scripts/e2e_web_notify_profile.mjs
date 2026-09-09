// Уведомления и профильные поля кросс-девайс (web ↔ web):
//  1) alice(dev1) правит bio в Settings → Edit profile ДО первого резолва её
//     профиля у bob (профиль контакта кэшируется по TTL — PROFILE-1); bob
//     открывает профиль alice и видит bio (identity resolve);
//  2) alice(dev1) мутит чат с bob через контекстное меню списка чатов
//     («Mute…» → «навсегда») — блоб уходит в msg.chat.setnotify;
//  3) alice(dev2) — второе устройство того же аккаунта — после входа видит
//     чат с bob замученным (notify_settings из sync).
import assert from 'node:assert/strict';

import { chromium } from '../web/telegram-tt/node_modules/playwright/index.mjs';

import {
  LOGIN_TIMEOUT_MS,
  assertNoPageErrors,
  findMessage,
  openPrivateChatStrict,
  preparePage,
  sendText,
} from './e2e_web_helpers.mjs';

const PASSWORD = 'Parvane-notify-e2e-password';
const SIBLING_SYNC_TIMEOUT_MS = 60000;

// Число замученных чатов по глобальному стейту tt (диаг-хук e2e-сборки)
async function mutedChatCount(page) {
  return page.evaluate(() => {
    const global = window.__parvaneGetGlobal?.();
    if (!global) return -1;
    const now = Math.floor(Date.now() / 1000);
    return Object.values(global.chats.notifyExceptionById || {})
      .filter((s) => s && s.mutedUntil && s.mutedUntil > now).length;
  });
}

function waitMuted(page, timeout) {
  return page.waitForFunction(() => {
    const global = window.__parvaneGetGlobal?.();
    const now = Math.floor(Date.now() / 1000);
    return Object.values(global?.chats.notifyExceptionById || {})
      .some((s) => s && s.mutedUntil && s.mutedUntil > now);
  }, undefined, { timeout });
}

async function muteChatForever(page, address) {
  const nick = address.split('@')[0];
  const item = page.locator('#LeftColumn .ListItem').filter({ hasText: nick }).first();
  await item.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await item.locator('.ListItem-button').click({ button: 'right' });
  await page.getByRole('menuitem', { name: /^Mute/ }).click();
  // Корень .Modal Playwright считает скрытым (opacity-transition) — ждём
  // содержимое: радио-группу длительности
  const modal = page.locator('.Modal.delete');
  const options = modal.locator('.dialog-checkbox-group');
  await options.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  // Последний вариант — «навсегда» (MuteDuration.Forever)
  await options.locator('label').last().click();
  await modal.locator('.confirm-dialog-button').first().click();
  await options.waitFor({ state: 'hidden', timeout: LOGIN_TIMEOUT_MS });
}

async function openEditProfile(page) {
  await page.getByRole('button', { name: 'Open menu' }).first().click();
  await page.getByRole('menuitem', { name: 'Settings' }).click();
  await page.getByRole('button', { name: 'Edit profile' }).click();
  await page.getByLabel('First name (required)').waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
}

// Из Edit profile — назад до списка чатов. После перехода кнопка «Go back»
// ещё видна в уходящем слайде (Transition_slide-to), а шапка списка чатов
// перехватывает клики — поэтому ориентируемся на «Open menu» и жмём назад
// только в активном слайде.
async function closeSettings(page) {
  const menu = page.getByRole('button', { name: 'Open menu' }).first();
  for (let i = 0; i < 6; i++) {
    if (await menu.isVisible().catch(() => false)) return;
    const back = page.locator('.Transition_slide-active').getByRole('button', { name: /Go back|Return to Chat List/ }).first();
    if (await back.isVisible().catch(() => false)) {
      await back.click({ timeout: 5000 }).catch(() => {});
    }
    await page.waitForTimeout(600);
  }
  await menu.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
}

const browser = await chromium.launch();
const aliceDev1Context = await browser.newContext();
const aliceDev2Context = await browser.newContext();
const bobContext = await browser.newContext();

try {
  const suffix = `${Date.now()}-${process.pid}`;
  const alice = `np-alice-${suffix}@local`;
  const bob = `np-bob-${suffix}@local`;
  const hello = `np-hello-${suffix}`;
  const bio = `Bio from dev1 ${suffix}`;

  const aliceDev1 = await preparePage(aliceDev1Context, alice, PASSWORD);

  // ── dev1 правит bio ДО того, как bob впервые резолвит alice ───────────────
  await openEditProfile(aliceDev1.page);
  await aliceDev1.page.getByLabel('Bio').fill(bio);
  await aliceDev1.page.getByRole('button', { name: 'Save', exact: true }).click();
  // FAB прячется классом (не display) — ждём потерю класса revealed
  await aliceDev1.page.waitForFunction(() => {
    const fab = document.querySelector('.FloatingActionButton');
    return !fab || !fab.classList.contains('revealed');
  }, undefined, { timeout: LOGIN_TIMEOUT_MS });
  await closeSettings(aliceDev1.page);
  console.log('OK: dev1 сохранил bio');

  // ── Чат alice↔bob существует на обеих сторонах ────────────────────────────
  const bobSession = await preparePage(bobContext, bob, PASSWORD);
  await openPrivateChatStrict(aliceDev1.page, bob);
  await sendText(aliceDev1.page, hello);
  await openPrivateChatStrict(bobSession.page, alice);
  await findMessage(bobSession.page, hello).first().waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });

  // ── bob видит bio alice в профиле ─────────────────────────────────────────
  await bobSession.page.locator('.MiddleHeader .chat-info-wrapper').first().click();
  await bobSession.page.locator('#RightColumn').getByText(bio, { exact: true })
    .waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  console.log('OK: bob видит bio alice в профиле');

  // ── dev1 мутит bob навсегда ───────────────────────────────────────────────
  assert.equal(await mutedChatCount(aliceDev1.page), 0, 'до мута замученных нет');
  await muteChatForever(aliceDev1.page, bob);
  await waitMuted(aliceDev1.page, LOGIN_TIMEOUT_MS);
  console.log('OK: dev1 замутил чат с bob');

  // ── dev2 (чистый контекст, тот же аккаунт) видит мут из sync ──────────────
  const aliceDev2 = await preparePage(aliceDev2Context, alice, PASSWORD);
  await waitMuted(aliceDev2.page, SIBLING_SYNC_TIMEOUT_MS);
  console.log('OK: dev2 получил мут с первого устройства');

  assertNoPageErrors({ aliceDev1, aliceDev2, bob: bobSession });
  console.log('OK: уведомления и профильные поля кросс-девайс (web)');
} finally {
  await browser.close();
}
