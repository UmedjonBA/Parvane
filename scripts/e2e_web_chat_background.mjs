// Фон чата: рисунок и цвет выбираются по отдельности (сочетание «градиент + рисунок»), выбранное сочетание
// переживает перезагрузку, фон прежнего вида (жёсткая пара) показан своей парой, «Размытие» действует только
// на свою картинку, своя картинка остаётся в блоке «Свои», «Сбросить» возвращает фон по умолчанию.
// Запуск: scripts/run_web_chat_background_e2e.sh
import assert from 'node:assert/strict';

import { chromium } from '../web/telegram-tt/node_modules/playwright/index.mjs';

import {
  buildPngBuffer, dismissRecoveryKeyDialog, LOGIN_TIMEOUT_MS, preparePage, reloadPage, relogin,
  openProfile,
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

const PATTERN_COUNT = 10;
const GRADIENT_COUNT = 18;

async function openBackgroundSettings(page) {
  await openProfile(page);
  await page.getByText('General Settings', { exact: false }).first().click();
  await page.getByText('Chat Wallpaper', { exact: true }).first().click();
  await page.locator('[data-bg-pattern]').first().waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
}

// Отмеченное на экране: рисунок, градиент и своя картинка
function readSelection(page) {
  return page.evaluate(() => ({
    patterns: [...document.querySelectorAll('[data-bg-pattern][data-bg-selected]')].map((el) => el.dataset.bgPattern),
    gradients: [...document.querySelectorAll('[data-bg-gradient][data-bg-selected]')]
      .map((el) => el.dataset.bgGradient),
    own: document.querySelectorAll('[data-bg-own] [data-bg-selected]').length,
  }));
}

async function waitSelectionWhere(page, check, what) {
  let last;
  for (let attempt = 0; attempt < 75; attempt++) {
    last = await readSelection(page);
    if (check(last)) return last;
    await page.waitForTimeout(200);
  }
  return assert.fail(`${what}: ${JSON.stringify(last)}`);
}

function waitSelection(page, expected, what) {
  const wanted = JSON.stringify(expected);
  return waitSelectionWhere(page, (selection) => JSON.stringify(selection) === wanted, `${what} (ждали ${wanted})`);
}

// Настройки темы пишутся на диск с задержкой; после неё — перезагрузка и вход
async function reloadAfterPersist(page) {
  await page.waitForTimeout(4000);
  await reloadPage(page);
  await relogin(page, PASSWORD).catch(() => undefined);
  await page.locator('#LeftColumn').waitFor({ state: 'visible', timeout: 60000 });
}

// Фон прежнего вида: до сочетаний идентификатор был жёсткой парой (`builtin-pattern-<id>`, `builtin-<id>`).
// Подменяем идентификатор в записи настроек тем — картинка в шифрованном хранилище остаётся как есть
function seedBackgroundSlug(page, slug) {
  return page.evaluate(async (value) => {
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open('tt-data');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const store = db.transaction('store', 'readwrite').objectStore('store');
    const themes = await new Promise((resolve, reject) => {
      const request = store.get('parvane-theme-settings');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    if (!themes) return false;
    let isChanged = false;
    Object.values(themes).forEach((theme) => {
      if (!theme?.background) return;
      theme.background = value;
      isChanged = true;
    });
    await new Promise((resolve, reject) => {
      const request = store.put(themes, 'parvane-theme-settings');
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
    db.close();
    return isChanged;
  }, slug);
}

try {
  const user = `bg-${Date.now().toString(36)}@local`;
  session = await preparePage(context, user, PASSWORD);
  const { page } = session;
  await dismissRecoveryKeyDialog(page).catch(() => undefined);

  await openBackgroundSettings(page);
  const blur = page.locator('.SettingsGeneralBackground input[type="checkbox"]');
  const ownTiles = page.locator('[data-bg-own] .WallpaperTile');
  assert.equal(await page.locator('[data-bg-pattern]').count(), PATTERN_COUNT, 'рисунков должно быть десять');
  assert.equal(await page.locator('[data-bg-gradient]').count(), GRADIENT_COUNT, 'градиентов должно быть восемнадцать');
  assert.deepEqual(await readSelection(page), { patterns: [], gradients: [], own: 0 }, 'до выбора ничего не отмечено');
  assert.equal(await page.locator('[data-bg-own]').count(), 0, 'без своей картинки блока «Свои» нет');
  assert.ok(await blur.isDisabled(), 'без своей картинки «Размытие» должно быть недоступно');
  assert.equal(await readBackground(page), undefined, 'до выбора — фон по умолчанию');
  console.log('OK: десять рисунков и восемнадцать градиентов, ничего не отмечено, «Размытие» недоступно');

  // Сначала только рисунок: он ложится на градиент темы
  await page.locator('[data-bg-pattern="cosmos"]').click();
  const first = await waitBackground(page, (bg) => bg.image.includes('blob:'), 'рисунок не применился');
  await waitSelectionWhere(
    page,
    (selection) => selection.patterns.join() === 'cosmos' && selection.gradients.length === 1 && !selection.own,
    'рисунок не отмечен или к нему не подставился градиент',
  );

  // Затем градиент: рисунок остаётся, фон — другая картинка, без размытия
  await page.locator('[data-bg-gradient="rose"]').click();
  await waitSelection(page, { patterns: ['cosmos'], gradients: ['rose'], own: 0 }, 'сочетание не отмечено');
  const combined = await waitBackground(
    page, (bg) => bg.image.includes('blob:') && bg.image !== first.image, 'сочетание не применилось',
  );
  assert.equal(combined.filter, 'none', 'встроенный фон не должен размываться');
  assert.ok(await blur.isDisabled(), 'для сочетания «Размытие» недоступно');
  if (process.env.PARVANE_E2E_SHOT_DIR) await page.screenshot({ path: `${process.env.PARVANE_E2E_SHOT_DIR}/chat-background-gallery.png` });

  // Меняется только градиент — рисунок прежний
  await page.locator('[data-bg-gradient="night"]').click();
  await waitSelection(page, { patterns: ['cosmos'], gradients: ['night'], own: 0 }, 'смена градиента сбила рисунок');
  await waitBackground(
    page, (bg) => bg.image.includes('blob:') && bg.image !== combined.image, 'новый градиент не применился',
  );
  console.log('OK: рисунок и градиент выбираются по отдельности, сочетание применено');

  await reloadAfterPersist(page);
  await waitBackground(page, (bg) => bg.image.includes('blob:'), 'сочетание не пережило перезагрузку');
  await openBackgroundSettings(page);
  await waitSelection(page, { patterns: ['cosmos'], gradients: ['night'], own: 0 }, 'сочетание не отмечено после перезагрузки');
  console.log('OK: сочетание применено и отмечено после перезагрузки');

  // Фон прежнего вида показан своей парой и меняется по частям, как любое сочетание
  // Отложенная запись настроек (если была) должна пройти до подмены
  await page.waitForTimeout(2000);
  assert.ok(await seedBackgroundSlug(page, 'builtin-pattern-plum'), 'запись настроек тем не найдена');
  await reloadPage(page);
  await relogin(page, PASSWORD).catch(() => undefined);
  await page.locator('#LeftColumn').waitFor({ state: 'visible', timeout: 60000 });
  await waitBackground(page, (bg) => bg.image.includes('blob:'), 'фон прежнего вида не показан');
  await openBackgroundSettings(page);
  await waitSelection(
    page, { patterns: ['programming'], gradients: ['plum'], own: 0 }, 'фон прежнего вида отмечен не своей парой',
  );
  await page.locator('[data-bg-gradient="sky"]').click();
  await waitSelection(
    page, { patterns: ['programming'], gradients: ['sky'], own: 0 }, 'от фона прежнего вида не сменился градиент',
  );
  console.log('OK: фон прежнего вида отмечен своей парой, градиент меняется, рисунок остаётся');

  // Своя картинка: заменяет сочетание, «Размытие» включается и выключается
  const chooser = page.waitForEvent('filechooser');
  await page.getByText('Upload Image', { exact: false }).first().click();
  await (await chooser).setFiles({ name: 'wall.png', mimeType: 'image/png', buffer: buildPngBuffer(256, [0x20, 0x80, 0xc0]) });
  await ownTiles.first().waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  // Пока картинка загружается, на её месте заглушка, а строка «Загрузить изображение» недоступна
  await page.waitForFunction(() => !document.querySelector('.SettingsGeneralBackground .ListItem.disabled'), undefined, {
    timeout: STEP_TIMEOUT_MS,
  });
  await ownTiles.first().click();
  for (let attempt = 0; attempt < 50 && await blur.isDisabled(); attempt++) await page.waitForTimeout(200);
  assert.equal(await blur.isDisabled(), false, 'для своей картинки «Размытие» доступно');
  await waitSelection(page, { patterns: [], gradients: [], own: 1 }, 'своя картинка не заменила сочетание');
  if (!(await blur.isChecked())) await blur.check({ force: true });
  await waitBackground(page, (bg) => /blur\(/.test(bg.filter), 'своя картинка не размыта при включённом «Размытии»');
  await blur.uncheck({ force: true });
  await waitBackground(page, (bg) => bg.filter === 'none', 'размытие не снялось');
  await blur.check({ force: true });
  await waitBackground(page, (bg) => /blur\(/.test(bg.filter), 'размытие не включилось снова');
  console.log('OK: своя картинка заменяет сочетание, «Размытие» включается и выключается');

  // После перезагрузки: фон размыт, плитка своей картинки в блоке «Свои» и отмечена
  await reloadAfterPersist(page);
  await waitBackground(page, (bg) => bg.image.includes('blob:') && /blur\(/.test(bg.filter), 'своя картинка или размытие не пережили перезагрузку');
  await openBackgroundSettings(page);
  await ownTiles.first().waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await waitSelection(page, { patterns: [], gradients: [], own: 1 }, 'плитка своей картинки не отмечена после перезагрузки');
  console.log('OK: своя картинка и размытие пережили перезагрузку, плитка в блоке «Свои»');

  // Сочетание поверх своей картинки: размытия нет, плитка остаётся в блоке «Свои» и после перезагрузки
  await page.locator('[data-bg-pattern="flight"]').click();
  await waitSelectionWhere(
    page,
    (selection) => selection.patterns.join() === 'flight' && selection.gradients.length === 1 && !selection.own,
    'рисунок поверх своей картинки не отмечен',
  );
  await waitBackground(page, (bg) => bg.image.includes('blob:') && bg.filter === 'none', 'сочетание после своей картинки размыто');
  assert.ok(await blur.isDisabled(), 'после возврата к сочетанию «Размытие» недоступно');
  await reloadAfterPersist(page);
  await waitBackground(page, (bg) => bg.image.includes('blob:') && bg.filter === 'none', 'сочетание после своей картинки не пережило перезагрузку');
  await openBackgroundSettings(page);
  await ownTiles.first().waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  assert.equal((await readSelection(page)).own, 0, 'своя картинка отмечена, хотя выбрано сочетание');
  console.log('OK: после выбора сочетания своя картинка осталась в блоке «Свои»');

  // «Сбросить»: фон по умолчанию, ничего не отмечено
  await page.locator('.SettingsGeneralBackground').getByText('Reset to default', { exact: false }).first().click();
  await waitSelection(page, { patterns: [], gradients: [], own: 0 }, 'после сброса что-то отмечено');
  for (let attempt = 0; attempt < 50 && await readBackground(page); attempt++) await page.waitForTimeout(200);
  assert.equal(await readBackground(page), undefined, 'после сброса остался свой фон');
  console.log('OK: «Сбросить» вернул фон по умолчанию');

  assert.deepEqual(session.errors || [], [], 'ошибки страницы');
  console.log('e2e_web_chat_background: OK');
} catch (error) {
  const dir = process.env.PARVANE_E2E_SHOT_DIR || process.env.PARVANE_E2E_BACKEND_LOG_DIR;
  if (dir) await session?.page.screenshot({ path: `${dir}/chat-background-failure.png` }).catch(() => {});
  throw error;
} finally {
  await browser.close();
}
