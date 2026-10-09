// Фон чата (spec 014): в галерее есть фоны с узором, выбранный фон переживает перезагрузку,
// «Размытие» действует только на свою картинку, загруженная картинка остаётся в галерее.
// Запуск: scripts/run_web_chat_background_e2e.sh
import assert from 'node:assert/strict';

import { chromium } from '../web/telegram-tt/node_modules/playwright/index.mjs';

import {
  buildPngBuffer, dismissRecoveryKeyDialog, LOGIN_TIMEOUT_MS, preparePage, reloadPage, relogin,
} from './e2e_web_helpers.mjs';

const PASSWORD = 'Parvane-background-e2e-1';
const STEP_TIMEOUT_MS = 20000;

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
let session;

// Слой фона чата: элемент с переменной `--custom-background`; фильтр — у его `::before`
function readBackground(page) {
  return page.evaluate(() => {
    const layer = [...document.querySelectorAll('#Main div[style*="--custom-background"]')][0];
    if (!layer) return undefined;
    return {
      image: layer.style.getPropertyValue('--custom-background'),
      filter: getComputedStyle(layer, '::before').filter,
    };
  });
}

async function waitBackground(page, check, what) {
  let last;
  for (let attempt = 0; attempt < 75; attempt++) {
    last = await readBackground(page);
    if (last && check(last)) return last;
    await page.waitForTimeout(200);
  }
  return assert.fail(`${what}: ${JSON.stringify(last)}`);
}

async function openBackgroundSettings(page) {
  await page.getByRole('button', { name: 'Open menu' }).first().click();
  await page.getByRole('menuitem', { name: 'Settings' }).click();
  await page.getByText('General Settings', { exact: false }).first().click();
  await page.getByText('Chat Wallpaper', { exact: true }).first().click();
  await page.locator('.settings-wallpapers .WallpaperTile').first().waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
}

try {
  const user = `bg-${Date.now().toString(36)}@local`;
  session = await preparePage(context, user, PASSWORD);
  const { page } = session;
  await dismissRecoveryKeyDialog(page).catch(() => undefined);

  await openBackgroundSettings(page);
  const tiles = page.locator('.settings-wallpapers .WallpaperTile');
  const blur = page.locator('.SettingsGeneralBackground input[type="checkbox"]');
  // Восемь фонов с узором и десять градиентов
  await page.waitForFunction(() => document.querySelectorAll('.settings-wallpapers .WallpaperTile').length >= 18, undefined, {
    timeout: STEP_TIMEOUT_MS,
  });
  assert.ok(await blur.isDisabled(), 'без своей картинки «Размытие» должно быть недоступно');
  console.log(`OK: в галерее ${await tiles.count()} фонов, «Размытие» недоступно без своей картинки`);

  // Фон с узором: выбирается, не размывается, переживает перезагрузку
  await tiles.first().click();
  const pattern = await waitBackground(page, (bg) => bg.image.includes('blob:'), 'фон с узором не применился');
  assert.equal(pattern.filter, 'none', 'фон с узором не должен размываться');
  assert.ok(await blur.isDisabled(), 'для узора «Размытие» недоступно');
  // Настройки темы пишутся на диск с задержкой
  await page.waitForTimeout(4000);
  await reloadPage(page);
  await relogin(page, PASSWORD).catch(() => undefined);
  await page.locator('#LeftColumn').waitFor({ state: 'visible', timeout: 60000 });
  await waitBackground(page, (bg) => bg.image.includes('blob:'), 'фон с узором не пережил перезагрузку');
  console.log('OK: фон с узором применён и пережил перезагрузку');

  // Своя картинка: «Размытие» включается и выключается
  await openBackgroundSettings(page);
  const chooser = page.waitForEvent('filechooser');
  await page.getByText('Upload Image', { exact: false }).first().click();
  await (await chooser).setFiles({ name: 'wall.png', mimeType: 'image/png', buffer: buildPngBuffer(256, [0x20, 0x80, 0xc0]) });
  await page.waitForFunction(() => document.querySelectorAll('.settings-wallpapers .WallpaperTile').length >= 19, undefined, {
    timeout: STEP_TIMEOUT_MS,
  });
  await tiles.first().click();
  for (let attempt = 0; attempt < 50 && await blur.isDisabled(); attempt++) await page.waitForTimeout(200);
  assert.equal(await blur.isDisabled(), false, 'для своей картинки «Размытие» доступно');
  if (!(await blur.isChecked())) await blur.check({ force: true });
  await waitBackground(page, (bg) => /blur\(/.test(bg.filter), 'своя картинка не размыта при включённом «Размытии»');
  await blur.uncheck({ force: true });
  await waitBackground(page, (bg) => bg.filter === 'none', 'размытие не снялось');
  await blur.check({ force: true });
  await waitBackground(page, (bg) => /blur\(/.test(bg.filter), 'размытие не включилось снова');
  console.log('OK: «Размытие» своей картинки включается и выключается');

  // После перезагрузки: фон размыт, плитка своей картинки в галерее и отмечена
  // Настройки темы пишутся на диск с задержкой
  await page.waitForTimeout(4000);
  await reloadPage(page);
  await relogin(page, PASSWORD).catch(() => undefined);
  await page.locator('#LeftColumn').waitFor({ state: 'visible', timeout: 60000 });
  await waitBackground(page, (bg) => bg.image.includes('blob:') && /blur\(/.test(bg.filter), 'своя картинка или размытие не пережили перезагрузку');
  await openBackgroundSettings(page);
  await page.waitForFunction(() => document.querySelectorAll('.settings-wallpapers .WallpaperTile').length >= 19, undefined, {
    timeout: STEP_TIMEOUT_MS,
  });
  assert.match(await tiles.first().getAttribute('class'), /selected/, 'плитка своей картинки не отмечена после перезагрузки');
  console.log('OK: своя картинка и размытие пережили перезагрузку, плитка в галерее');

  assert.deepEqual(session.errors || [], [], 'ошибки страницы');
  console.log('e2e_web_chat_background: OK');
} catch (error) {
  const dir = process.env.PARVANE_E2E_SHOT_DIR || process.env.PARVANE_E2E_BACKEND_LOG_DIR;
  if (dir) await session?.page.screenshot({ path: `${dir}/chat-background-failure.png` }).catch(() => {});
  throw error;
} finally {
  await browser.close();
}
