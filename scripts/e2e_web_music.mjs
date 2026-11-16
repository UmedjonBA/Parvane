// Модуль «Музыка» (spec 039, 041; правило MUSIC-1). Библиотека — поддельный Subsonic-сервер за шардом music
// (`scripts/fake_subsonic.mjs`): два альбома, пять треков, первый трек длится 4 секунды. Проверяется путь
// слушателя: главная, альбом, воспроизведение и переход на следующий трек, пауза, любимое, поиск и «играть
// следующим», плеер вне модуля, очередь после перезагрузки, полоса плеера на телефоне.
// Запуск: scripts/run_web_music_e2e.sh
import assert from 'node:assert/strict';

import { chromium } from '../web/telegram-tt/node_modules/playwright/index.mjs';

import {
  LOGIN_TIMEOUT_MS,
  assertNoPageErrors,
  dismissRecoveryKeyDialog,
  preparePage,
  reloadPage,
} from './e2e_web_helpers.mjs';

const PASSWORD = 'Parvane-music-e2e-1';
const WIDE = { width: 1600, height: 900 };
const PHONE = { width: 390, height: 800 };
const STEP_TIMEOUT_MS = 20000;

// Звук без жеста пользователя: сценарий нажимает кнопки сам, но автозапуск в безголовом режиме надёжнее разрешить
const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
let session;

async function openMusic(page) {
  const rail = page.locator('#FoldersSidebar');
  await rail.or(page.getByRole('navigation', { name: 'Modules' })).first()
    .waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  if (await rail.isVisible().catch(() => false)) await rail.getByRole('tab', { name: 'Music', exact: true }).click();
  else await page.getByRole('navigation', { name: 'Modules' }).getByRole('button', { name: 'Music' }).click();
  const music = page.locator('#ParvaneMusic');
  await page.locator('#ParvaneMusic[data-music-enabled="true"]').waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  return music;
}

try {
  const user = `music-${Date.now().toString(36)}@local`;
  const context = await browser.newContext({ viewport: WIDE });
  session = await preparePage(context, user, PASSWORD);
  const { page } = session;
  await dismissRecoveryKeyDialog(page).catch(() => undefined);

  // ── Главная: заглушка рекомендаций и новое на сервере ─────────────────────
  const music = await openMusic(page);
  const main = music.locator('[data-music-view]');
  // Плеер с очередью — колонка справа; тот же плеер отдельным видом есть только на узком экране
  const side = music.locator('aside');
  await music.locator('[data-music-mix]').getByText('Recommendations are coming soon').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  const albums = main.locator('[data-music-albums]');
  await albums.getByRole('button', { name: /Берег/ }).waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await albums.getByRole('button', { name: /Static Bloom/ }).waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await side.locator('[data-music-queue="empty"]').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  console.log('OK: главная — заглушка рекомендаций, альбомы сервера, плеер пуст');

  // ── Альбом: треки, воспроизведение, позиция идёт ──────────────────────────
  await albums.getByRole('button', { name: /Берег/ }).click();
  const tracks = main.locator('[data-music-tracks]');
  await tracks.locator('[data-track]').nth(2).waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  assert.equal(await tracks.locator('[data-track]').count(), 3, 'в альбоме три трека');
  await tracks.locator('[data-track="t1"]').getByRole('button').first().click();
  await side.locator('[data-music-now]').filter({ hasText: 'Северный ветер' }).waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await side.locator('[data-music-play="playing"]').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await side.locator('[data-music-queue="3"]').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await side.locator('[data-music-position]').filter({ hasText: /0:0[1-3]/ }).waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  console.log('OK: трек играет, очередь — альбом, позиция идёт');

  // ── Трек доигран сам — играет следующий по очереди ────────────────────────
  await side.locator('[data-music-now]').filter({ hasText: 'Harbor Lights' }).waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await side.locator('[data-music-play="playing"]').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await tracks.locator('[data-track="t2"]').getByText('playing').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  console.log('OK: после конца трека играет следующий');

  // ── Пауза, следующий вручную, повтор ──────────────────────────────────────
  await side.getByRole('button', { name: 'Pause' }).click();
  await side.locator('[data-music-play="paused"]').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await side.getByRole('button', { name: 'Next track' }).click();
  await side.locator('[data-music-now]').filter({ hasText: 'Соль' }).waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await side.getByRole('button', { name: 'Pause' }).click();
  await side.getByRole('button', { name: 'Repeat: off' }).click();
  await side.locator('[data-music-repeat="all"]').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  console.log('OK: пауза, следующий трек, повтор очереди');

  // ── Любимое: отметка из плеера видна в списке «Любимое» ───────────────────
  await side.getByRole('button', { name: 'Add to favourites' }).click();
  await side.getByRole('button', { name: 'Remove from favourites' }).waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  // Отметка уходит на сервер запросом: список «Любимое» читается после него
  await page.waitForTimeout(1000);
  await music.getByRole('navigation', { name: 'Music' }).getByRole('button', { name: 'Favourites' }).click();
  await music.locator('[data-music-view="starred"] [data-track="t3"]').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  assert.equal(await music.locator('[data-music-view="starred"] [data-track]').count(), 1, 'в любимом один трек');
  console.log('OK: трек отмечен любимым и виден в списке');

  // ── Поиск и «играть следующим» ────────────────────────────────────────────
  await music.getByRole('searchbox').fill('glass');
  const found = music.locator('[data-music-view="search"] [data-track="t4"]');
  await found.waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await found.getByRole('button', { name: 'Play next' }).click();
  await side.locator('[data-music-queue="4"]').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  // Очередь в порядке проигрывания: найденный трек — сразу после играющего
  const queueOrder = await side.locator('[data-track]').evaluateAll((rows) => rows.map((row) => row.dataset.track));
  assert.deepEqual(queueOrder, ['t1', 't2', 't3', 't4'], 'порядок очереди после «играть следующим»');
  await music.getByRole('searchbox').fill('нет такого');
  await music.locator('[data-music-empty]').getByText('Nothing found').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await music.getByRole('searchbox').fill('');
  console.log('OK: поиск, «играть следующим», пустой результат');

  // ── Плеер вне модуля: виджет в боковой панели ─────────────────────────────
  await page.locator('#FoldersSidebar').getByRole('tab', { name: 'Chats' }).click();
  const widget = page.locator('#FoldersSidebar [data-music-widget]');
  await widget.waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await widget.click();
  await music.waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  console.log('OK: виджет плеера в боковой панели открывает «Музыку»');

  // ── Перезагрузка: очередь возвращается на паузе с того же трека ───────────
  await reloadPage(page);
  const reloaded = await openMusic(page);
  const reloadedSide = reloaded.locator('aside');
  await reloadedSide.locator('[data-music-now]').filter({ hasText: 'Соль' }).waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await reloadedSide.locator('[data-music-queue="4"]').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await reloadedSide.locator('[data-music-play="paused"]').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await reloadedSide.locator('[data-music-repeat="all"]').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  console.log('OK: очередь, играющий трек и повтор пережили перезагрузку');

  // ── Телефон: плеер отдельным видом, полоса над лентой в других модулях ────
  await page.setViewportSize(PHONE);
  await page.waitForTimeout(800);
  const ribbon = page.getByRole('navigation', { name: 'Modules' });
  await ribbon.getByRole('button', { name: 'Chats' }).click();
  const mini = page.locator('[data-music-mini]');
  await mini.waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  const [miniBox, ribbonBox, addBox] = [await mini.boundingBox(), await ribbon.boundingBox(), await page.locator('[data-add-for="chats"]').boundingBox()];
  assert.ok(Math.abs(miniBox.y + miniBox.height - ribbonBox.y) <= 1, `полоса плеера не над лентой: ${JSON.stringify({ miniBox, ribbonBox })}`);
  assert.ok(addBox.y + addBox.height <= miniBox.y, `«+» перекрывает полосу плеера: ${JSON.stringify({ addBox, miniBox })}`);
  // «Open player» тоже содержит «Play» — имя кнопки точное
  await mini.getByRole('button', { name: 'Play', exact: true }).click();
  await page.locator('[data-music-mini="playing"]').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await mini.getByRole('button', { name: 'Open player' }).click();
  const phoneMusic = page.locator('#ParvaneMusic');
  await phoneMusic.waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await mini.waitFor({ state: 'detached', timeout: STEP_TIMEOUT_MS });
  await phoneMusic.getByRole('navigation', { name: 'Music' }).getByRole('button', { name: 'Player' }).click();
  await phoneMusic.locator('[data-music-view="queue"] [data-music-now]').filter({ hasText: 'Соль' })
    .waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  assert.ok(overflow <= 0, `горизонтальное переполнение на телефоне: ${overflow}`);
  console.log('OK: телефон — полоса плеера над лентой, плеер отдельным видом');

  assertNoPageErrors({ session });
  console.log('OK: модуль «Музыка»');
} catch (error) {
  const shotDir = process.env.PARVANE_E2E_SHOT_DIR || process.env.PARVANE_E2E_BACKEND_LOG_DIR;
  if (session) {
    if (shotDir) await session.page.screenshot({ path: `${shotDir}/music.png` }).catch(() => {});
    console.error(session.logs.slice(-50).join('\n'));
  }
  throw error;
} finally {
  await browser.close();
}
