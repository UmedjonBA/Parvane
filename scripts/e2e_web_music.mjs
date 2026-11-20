// Модуль «Музыка» (spec 039, 041; правило MUSIC-1). Библиотека — поддельный Subsonic-сервер за шардом music
// (`scripts/fake_subsonic.mjs`): два альбома, пять треков, первый трек длится 4 секунды. Проверяется путь
// слушателя: главная, альбом, воспроизведение и переход на следующий трек, пауза, любимое, поиск и «играть
// следующим», плеер вне модуля, очередь после перезагрузки, полоса плеера на телефоне; «Найти и скачать»
// (поддельный сервис скачивания `scripts/fake_music_fetch.mjs`, лимит раннера — три трека в сутки): уверенное
// совпадение качается само, спорное — выбором файла, ничего не нашлось, лимит, «Загруженное» и удаление;
// плейлисты (личный контейнер): создать, добавить, порядок перетаскиванием, играть, переименовать, перезагрузка,
// удалить; порядок очереди перетаскиванием за ручку (компьютер и телефон); трек и плейлист в чат карточкой
// (плейлист — «Открыть», «Сохранить к себе», «Слушать»); «Загруженное» — один трек и альбом на устройстве играют
// без сети.
// Запуск: scripts/run_web_music_e2e.sh
import assert from 'node:assert/strict';

import { chromium } from '../web/telegram-tt/node_modules/playwright/index.mjs';

import { checkMinimizedCallStrip, saveCallState } from './e2e_web_call_media.mjs';

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

// Перетащить строку за ручку на место строки `toId`: мышь — те же события указателя, что и палец
async function dragRow(page, list, fromId, toId) {
  const handle = await list.locator(`[data-track="${fromId}"] [data-music-drag]`).boundingBox();
  const target = await list.locator(`[data-track="${toId}"]`).boundingBox();
  const x = handle.x + handle.width / 2;
  await page.mouse.move(x, handle.y + handle.height / 2);
  await page.mouse.down();
  await page.mouse.move(x, target.y + target.height / 2, { steps: 8 });
  await page.mouse.up();
}

// Меню трека (доски `XpMusic`, `ZdMusicX`): «⋯» строки и пункт по названию. На компьютере меню — у курсора
// (вне раздела, через портал), на телефоне — шторка; в обоих случаях это `role="menu"`
async function pickTrackAction(page, row, action) {
  await row.locator('[data-music-menu]').click();
  const menu = page.getByRole('menu');
  await menu.getByRole('menuitem', { name: action, exact: true }).click();
  await menu.waitFor({ state: 'detached', timeout: STEP_TIMEOUT_MS });
}

async function waitRows(page, list, expected) {
  await list.locator('[data-track]').first().waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await page.waitForFunction(([root, want]) => [...root.querySelectorAll('[data-track]')]
    .map((row) => row.dataset.track).join() === want, [await list.elementHandle(), expected.join()],
  { timeout: STEP_TIMEOUT_MS });
}

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
  assert.equal(await found.getByRole('button', { name: 'Play next' }).count(), 0, 'действия трека — в меню, не в строке');
  await pickTrackAction(page, found, 'Play next');
  await side.locator('[data-music-queue="4"]').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  // Очередь в порядке проигрывания: найденный трек — сразу после играющего
  const queueOrder = await side.locator('[data-track]').evaluateAll((rows) => rows.map((row) => row.dataset.track));
  assert.deepEqual(queueOrder, ['t1', 't2', 't3', 't4'], 'порядок очереди после «играть следующим»');
  // Переход из меню трека: «К альбому» открывает альбом, поиск очищается
  await pickTrackAction(page, found, 'Go to album');
  await music.locator('[data-music-view="album"] [data-track="t4"]').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  assert.equal(await music.getByRole('searchbox').inputValue(), '', 'поиск очищен переходом');
  await music.getByRole('searchbox').fill('нет такого');
  await music.locator('[data-music-empty]').getByText('Nothing found').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await music.getByRole('searchbox').fill('');
  console.log('OK: поиск, «играть следующим», пустой результат');

  // ── Очередь: порядок перетаскиванием за ручку, играющий трек не меняется ─
  await dragRow(page, side.locator('[data-music-queue]'), 't1', 't2');
  await waitRows(page, side.locator('[data-music-queue]'), ['t2', 't1', 't3', 't4']);
  await side.locator('[data-music-now]').filter({ hasText: 'Соль' }).waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  console.log('OK: очередь переставлена перетаскиванием');

  // ── Плеер вне модуля: виджет в боковой панели ─────────────────────────────
  await page.locator('#FoldersSidebar').getByRole('tab', { name: 'Chats' }).click();
  const widget = page.locator('#FoldersSidebar [data-music-widget]');
  await widget.waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await widget.click();
  const full = page.locator('[data-music-full]');
  await full.getByRole('heading', { name: 'Соль' }).waitFor();
  await full.getByRole('button', { name: 'Play', exact: true }).click();
  await full.getByRole('button', { name: 'Pause', exact: true }).click();
  await full.getByRole('button', { name: 'Add to a playlist' }).click();
  const fullPicker = page.locator('.Modal [data-playlist-picker]');
  await fullPicker.getByRole('button', { name: 'Close' }).click();
  await full.getByRole('button', { name: 'Send to a chat' }).click();
  await page.locator('.Modal .modal-dialog').getByText('Saved Messages').first().waitFor();
  await page.keyboard.press('Escape');
  const slider = full.getByRole('slider');
  await slider.press('Home');
  await slider.press('ArrowRight');
  await full.locator('[data-music-position]').filter({ hasText: /^0:01$/ }).waitFor();
  await page.keyboard.press('Escape');
  await full.waitFor({ state: 'detached' });
  await widget.waitFor();
  assert.equal(await music.isVisible(), false);
  console.log('OK: виджет — полный плеер, пауза, продолжение, перемотка, Escape возвращает в чаты');

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
  // Состояние звонка подаём через тот же вход, что у контроллера. Сам плеер воспроизводит тестовый трек
  await page.evaluate(() => {
    window.parvaneCall = { state: 'active', peerName: 'Лена' };
    window.dispatchEvent(new Event('parvane-call'));
  });
  const minimize = page.getByRole('button', { name: 'Minimize call', exact: true });
  await minimize.waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  // Музыка встаёт на паузу с началом разговора, а не при сворачивании
  await page.waitForFunction(() => document.querySelector('[data-music-mini]')?.getAttribute('data-music-mini')
    === 'paused', undefined, { timeout: STEP_TIMEOUT_MS });
  await minimize.click();
  const strip = await checkMinimizedCallStrip(page);
  await page.locator('[data-music-mini="paused"]').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  const [stripBox, pausedBox, currentRibbonBox] = await Promise.all([
    strip.boundingBox(), mini.boundingBox(), ribbon.boundingBox(),
  ]);
  assert.ok(stripBox.y + stripBox.height < pausedBox.y, 'Плашка звонка должна оставаться вверху');
  assert.ok(Math.abs(pausedBox.y + pausedBox.height - currentRibbonBox.y) <= 1, 'Мини-плеер должен быть над лентой');
  await saveCallState(page, 'minimized-music');
  await strip.click();
  await minimize.waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  assert.equal(await mini.getAttribute('data-music-mini'), 'paused', 'Возврат к звонку не возобновляет музыку сам');
  await page.evaluate(() => {
    window.parvaneCall = { state: 'ended' };
    window.dispatchEvent(new Event('parvane-call'));
  });
  await minimize.waitFor({ state: 'detached', timeout: STEP_TIMEOUT_MS });
  await mini.getByRole('button', { name: 'Play', exact: true }).click();
  await page.locator('[data-music-mini="playing"]').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  console.log('OK: звонок ставит музыку на паузу, плашка звонка вверху, мини-плеер над лентой');

  await mini.getByRole('button', { name: 'Open player' }).click();
  await full.getByRole('heading', { name: 'Соль' }).waitFor();
  await ribbon.waitFor({ state: 'detached' });
  await full.getByRole('button', { name: 'Next track' }).click();
  await full.getByRole('heading', { name: 'Glass Harbor' }).waitFor();
  await full.getByRole('button', { name: /^Queue/ }).click();
  await full.locator('[aria-expanded="true"]').waitFor();
  // Телефон: та же ручка в очереди полного плеера
  await dragRow(page, full, 't1', 't2');
  await waitRows(page, full, ['t1', 't2', 't3', 't4']);
  await full.getByRole('button', { name: 'Collapse' }).click();
  await full.waitFor({ state: 'detached' });
  await ribbon.waitFor();
  await mini.waitFor();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  assert.ok(overflow <= 0, `горизонтальное переполнение на телефоне: ${overflow}`);
  console.log('OK: телефон — полный плеер из полосы, следующий трек, очередь перетаскиванием и возврат ленты');

  // ── «Найти и скачать»: уверенное совпадение качается само ─────────────────
  // Телефон: меню трека — шторка снизу
  const phoneMusic = await openMusic(page);
  await phoneMusic.locator('[data-view="albums"]').click();
  await phoneMusic.locator('[data-music-albums]').getByRole('button', { name: /Берег/ }).click();
  const phoneRow = phoneMusic.locator('[data-music-tracks] [data-track="t2"]');
  await phoneRow.locator('[data-music-menu]').click();
  const sheetMenu = page.locator('.Modal [role="menu"]');
  await sheetMenu.getByRole('menuitem', { name: 'Go to artist', exact: true }).waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  for (const item of ['Play next', 'Add to queue', 'Add to favourites', 'Send to a chat', 'Download for offline']) {
    await sheetMenu.getByRole('menuitem', { name: item, exact: true }).waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  }
  // «В плейлист» на телефоне — чипы внизу шторки (доска `XpMusic`)
  await page.locator('.Modal [data-playlist-chips] [data-playlist-chip-new]').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  if (process.env.PARVANE_E2E_SHOT_DIR) {
    await page.screenshot({ path: `${process.env.PARVANE_E2E_SHOT_DIR}/music-track-menu-phone.png` });
  }
  const sheetOverflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  assert.ok(sheetOverflow <= 0, `горизонтальное переполнение со шторкой меню: ${sheetOverflow}`);
  await page.locator('.Modal').getByRole('button', { name: 'Close' }).click();
  await sheetMenu.waitFor({ state: 'detached', timeout: STEP_TIMEOUT_MS });
  console.log('OK: телефон — меню трека шторкой');

  await page.setViewportSize(WIDE);
  await page.waitForTimeout(800);
  const wide = await openMusic(page);
  const wideSide = wide.locator('aside');
  // Вид «Плеер» есть только на телефоне: на широком экране возвращаемся на главную, где есть строка поиска
  await wide.locator('[data-view="home"]').click();
  const fetchRow = (title) => wide.locator(`[data-music-fetch] [data-fetch-track="${title}"]`);
  const searchFor = async (text, title) => {
    await wide.getByRole('searchbox').fill(text);
    await fetchRow(title).waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
    return fetchRow(title);
  };
  const bus = await searchFor('автобус', 'Ночной автобус');
  await wide.locator('[data-music-empty]').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await bus.locator('[data-fetch-download]').click();
  await bus.locator('[data-fetch-play]').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS * 2 });
  assert.equal(await bus.locator('[data-fetch-candidates]').count(), 0, 'уверенное совпадение не спрашивает выбора');
  await bus.locator('[data-fetch-play]').click();
  await wideSide.locator('[data-music-now]').filter({ hasText: 'Ночной автобус' }).waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await wideSide.getByRole('button', { name: 'Pause' }).click();
  console.log('OK: трек найден в сети, скачан без вопросов и играет');

  // ── Трек, который уже есть в библиотеке, скачивать не предлагается ────────
  const glass = await searchFor('glass', 'Glass Harbor');
  await glass.locator('[data-fetch-play]').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  assert.equal(await glass.locator('[data-fetch-download]').count(), 0, 'трек из библиотеки не скачивается заново');
  console.log('OK: трек из библиотеки отмечен в каталоге');

  // ── Спорное совпадение: нужна версия без цензуры, известной нет — выбор файла ─
  const loud = await searchFor('громкая', 'Громкая песня');
  await loud.locator('[data-fetch-download]').click();
  const candidates = loud.locator('[data-fetch-candidates]');
  await candidates.waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS * 2 });
  // Студийная копия — первой, концертная запись — ниже; у каждой источник и дата загрузки
  assert.equal(await candidates.getByRole('button', { name: 'This one' }).count(), 2, 'в списке два файла');
  const offered = await candidates.locator('li').filter({ has: page.getByRole('button', { name: 'This one' }) }).allInnerTexts();
  assert.match(offered[0], /YouTube · Полдень · 0:30 · 2026-06-01/, `первой — студийная копия: ${offered[0]}`);
  assert.match(offered[1], /live/, `концертная запись — ниже: ${offered[1]}`);
  assert.equal(await candidates.locator('[data-fetch-trusted]').count(), 0, 'новые копии не помечены «без цензуры»');
  await candidates.getByRole('button', { name: 'This one' }).first().click();
  await loud.locator('[data-fetch-play]').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS * 2 });
  console.log('OK: спорное совпадение скачано после выбора файла');

  // ── Ничего подходящего в источниках ───────────────────────────────────────
  const empty = await searchFor('пустой', 'Пустой трек');
  await empty.locator('[data-fetch-download]').click();
  await empty.locator('[data-fetch-state="failed"]').getByText('No suitable file was found').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS * 2 });
  console.log('OK: файла нет в источниках — задача честно не удалась');

  // ── Лимит: три трека в сутки ──────────────────────────────────────────────
  const morning = await searchFor('утро', 'Утро');
  await morning.locator('[data-fetch-download]').click();
  await morning.locator('[data-fetch-play]').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS * 2 });
  const again = await searchFor('пустой', 'Пустой трек');
  await again.getByRole('button', { name: 'Try again' }).click();
  await wide.locator('[data-fetch-notice="limit"]').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await wide.getByRole('searchbox').fill('');
  console.log('OK: четвёртый трек за сутки не принят — лимит');

  // ── «Загруженное»: свои треки, расход, удаление ───────────────────────────
  await wide.locator('[data-view="added"]').click();
  const mine = wide.locator('[data-music-added="mine"]');
  await mine.locator('[data-track]').nth(2).waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await wide.locator('[data-music-usage]').getByText('Today 3 of 3').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await pickTrackAction(page, mine.locator('[data-track]').filter({ hasText: 'Утро' }), 'Remove from the server library');
  await wide.locator('[data-music-usage]').getByText('Today 2 of 3').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  // Список перечитывается отдельным запросом — после расхода
  await mine.locator('[data-track]').nth(2).waitFor({ state: 'detached', timeout: STEP_TIMEOUT_MS });
  assert.equal(await mine.locator('[data-track]').count(), 2, 'после удаления в «Загруженном» два трека');
  // «Новое на сервере» на главной: добавленное с тем, кто добавил
  await wide.locator('[data-view="home"]').click();
  const everyone = wide.locator('[data-music-added="all"]');
  await everyone.getByText(`added by ${user.split('@')[0]}`).first().waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  assert.equal(await everyone.locator('[data-track]').count(), 2, 'на главной два добавленных трека');
  console.log('OK: «Загруженное» — расход, удаление; «Новое на сервере» — кто добавил');

  // ── Плейлисты: создать, добавить треки, порядок, повтор не добавляется ────
  const nav = (view) => wide.locator(`[data-view="${view}"]`).click();
  await nav('playlists');
  await wide.locator('[data-music-empty]').getByText('No playlists yet').waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await wide.getByPlaceholder('New playlist name').fill('Дорога');
  await wide.getByRole('button', { name: 'Create', exact: true }).click();
  const opened = wide.locator('[data-music-playlist]');
  await opened.locator('[data-music-empty]').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await nav('albums');
  await wide.locator('[data-music-albums]').getByRole('button', { name: /Берег/ }).click();
  const albumRow = (id) => wide.locator(`[data-music-tracks] [data-track="${id}"]`);
  const picker = wide.locator('[data-playlist-picker]');
  const addToPlaylist = async (trackId, playlistName, expected) => {
    await pickTrackAction(page, albumRow(trackId), 'Add to a playlist');
    await picker.getByRole('button', { name: playlistName, exact: true }).click();
    await wide.locator(`[data-playlist-picker="${expected}"]`).waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
    await picker.getByRole('button', { name: 'Close' }).click();
    await picker.waitFor({ state: 'detached', timeout: STEP_TIMEOUT_MS });
  };
  await albumRow('t1').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await addToPlaylist('t1', 'Дорога', 'added');
  await addToPlaylist('t3', 'Дорога', 'added');
  await addToPlaylist('t1', 'Дорога', 'present');
  // Новый плейлист прямо из выбора — сразу с треком
  await pickTrackAction(page, albumRow('t2'), 'Add to a playlist');
  await picker.getByPlaceholder('New playlist name').fill('Вечер');
  await picker.getByRole('button', { name: 'Create and add' }).click();
  await wide.locator('[data-playlist-picker="added"]').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await picker.getByRole('button', { name: 'Close' }).click();
  // Телефон (доска `XpMusic`): в шторке трека плейлисты — чипами внизу; где трек уже есть — чип выделен
  await page.setViewportSize(PHONE);
  await albumRow('t1').locator('[data-music-menu]').click();
  const chips = page.locator('[data-playlist-chips]');
  await chips.waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  assert.equal(await page.getByRole('menu').getByRole('menuitem', { name: 'Add to a playlist', exact: true }).count(), 0,
    'на телефоне пункт «В плейлист» заменён чипами');
  assert.equal(await chips.getByRole('button', { name: 'Дорога', exact: true }).getAttribute('aria-pressed'), 'true');
  await chips.getByRole('button', { name: 'Вечер', exact: true }).click();
  await chips.waitFor({ state: 'detached', timeout: STEP_TIMEOUT_MS });
  await page.setViewportSize(WIDE);
  console.log('OK: чипы плейлистов в шторке трека на телефоне');
  await nav('playlists');
  const lists = wide.locator('[data-music-playlists]');
  await lists.getByRole('button', { name: /Дорога.*2 tracks/ }).waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await lists.getByRole('button', { name: /Вечер.*2 tracks/ }).waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  console.log('OK: плейлисты созданы, треки добавлены, повтор трека не добавляется');

  // ── Страница плейлиста: порядок, воспроизведение, убрать трек, переименовать ─
  await lists.getByRole('button', { name: /Дорога/ }).click();
  const order = () => opened.locator('[data-track]').evaluateAll((rows) => rows.map((row) => row.dataset.track));
  const waitOrder = async (expected) => {
    await page.waitForFunction((want) => {
      const rows = [...document.querySelectorAll('#ParvaneMusic [data-music-playlist] [data-track]')];
      return rows.map((row) => row.dataset.track).join() === want;
    }, expected.join(), { timeout: STEP_TIMEOUT_MS });
  };
  await waitOrder(['t1', 't3']);
  await dragRow(page, opened, 't1', 't3');
  await waitOrder(['t3', 't1']);
  await opened.getByRole('button', { name: 'Play', exact: true }).click();
  await wideSide.locator('[data-music-now]').filter({ hasText: 'Соль' }).waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await wideSide.locator('[data-music-queue="2"]').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await wideSide.getByRole('button', { name: 'Pause' }).click();
  await opened.getByRole('button', { name: 'Remove from the playlist: Соль' }).click();
  await waitOrder(['t1']);
  await opened.getByLabel('Playlist name').fill('В дорогу');
  await opened.getByLabel('Playlist name').press('Enter');
  await opened.getByRole('button', { name: 'All playlists' }).click();
  await lists.getByRole('button', { name: /В дорогу.*1 track/ }).waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  assert.deepEqual(await order(), [], 'страница плейлиста закрыта');
  console.log('OK: порядок треков, воспроизведение плейлиста, удаление трека, переименование');

  // ── Перезагрузка: плейлисты на месте; удаление плейлиста в два нажатия ────
  // Правки уходят на сервер пакетом: до перезагрузки дожидаемся записи
  await page.waitForTimeout(3000);
  await reloadPage(page);
  const again2 = await openMusic(page);
  await again2.locator('[data-view="playlists"]').click();
  const lists2 = again2.locator('[data-music-playlists]');
  await lists2.getByRole('button', { name: /В дорогу.*1 track/ }).waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await lists2.getByRole('button', { name: /Вечер/ }).click();
  await again2.locator('[data-music-playlist] [data-track="t2"]').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await again2.locator('[data-playlist-delete="ask"]').click();
  await again2.locator('[data-playlist-delete="confirm"]').click();
  await lists2.getByRole('button', { name: /В дорогу/ }).waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  assert.equal(await lists2.getByRole('button').count(), 1, 'после удаления остался один плейлист');
  console.log('OK: плейлисты пережили перезагрузку, плейлист удалён');

  // ── Трек в чат: карточка в «Избранном», из неё трек играет ────────────────
  await again2.locator('[data-view="albums"]').click();
  await again2.locator('[data-music-albums]').getByRole('button', { name: /Берег/ }).click();
  await pickTrackAction(page, again2.locator('[data-music-tracks] [data-track="t2"]'), 'Send to a chat');
  await page.locator('.Modal .modal-dialog').getByText('Saved Messages').first().click();
  await page.getByText('Track sent').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await page.locator('#FoldersSidebar').getByRole('tab', { name: 'Chats' }).click();
  await page.locator('#LeftColumn .chat-list').getByText('Saved Messages').first().click();
  const card = page.locator('[data-music-track-card="t2"]');
  await card.getByText('Harbor Lights').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  // В списке чатов — сводка «Трек: …», а не пустая строка
  await page.locator('#LeftColumn .chat-list').getByText(/Track: .*Harbor Lights/).first()
    .waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await card.getByRole('button', { name: 'Play', exact: true }).click();
  const backInMusic = await openMusic(page);
  await backInMusic.locator('aside [data-music-now]').filter({ hasText: 'Harbor Lights' })
    .waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await backInMusic.locator('aside [data-music-play="playing"]').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  console.log('OK: трек отправлен в чат карточкой и играет из неё');

  // ── Плейлист в чат: карточка, «Открыть», «Сохранить к себе», «Слушать» ────
  const backSide = backInMusic.locator('aside');
  await backSide.getByRole('button', { name: 'Pause' }).click();
  await backInMusic.locator('[data-view="playlists"]').click();
  await backInMusic.locator('[data-music-playlists]').getByRole('button', { name: /В дорогу/ }).click();
  await backInMusic.locator('[data-music-playlist] [data-music-playlist-to-chat]').click();
  await page.locator('.Modal .modal-dialog').getByText('Saved Messages').first().click();
  await page.getByText('Playlist sent').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await page.locator('#FoldersSidebar').getByRole('tab', { name: 'Chats' }).click();
  await page.locator('#LeftColumn .chat-list').getByText('Saved Messages').first().click();
  const playlistCard = page.locator('[data-music-playlist-card="В дорогу"]');
  await playlistCard.getByText('Северный ветер').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await playlistCard.getByText(/^1 track/).waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await page.locator('#LeftColumn .chat-list').getByText('Playlist: В дорогу').first()
    .waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await playlistCard.getByRole('button', { name: 'Open', exact: true }).click();
  const sharedSheet = page.locator('[data-music-playlist-sheet]');
  await sharedSheet.locator('[data-track="t1"]').getByText('Северный ветер').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await sharedSheet.getByRole('button', { name: 'Save to my playlists' }).click();
  await page.getByText('Playlist saved to your playlists').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await sharedSheet.waitFor({ state: 'detached', timeout: STEP_TIMEOUT_MS });
  await playlistCard.getByRole('button', { name: 'Listen', exact: true }).click();
  await openMusic(page);
  await backSide.locator('[data-music-now]').filter({ hasText: 'Северный ветер' }).waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  // Первый трек короткий (4 с): к этому моменту он может уже доиграть
  const pauseAfterListen = backSide.getByRole('button', { name: 'Pause' });
  if (await pauseAfterListen.isVisible()) await pauseAfterListen.click();
  await backInMusic.locator('[data-view="playlists"]').click();
  await backInMusic.locator('[data-music-playlists]').getByRole('button', { name: /В дорогу.*1 track/ }).nth(1)
    .waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  console.log('OK: плейлист отправлен в чат карточкой, открыт, сохранён к себе и играет');

  // ── «Загруженное»: один трек и альбом на устройстве играют без сети ───────
  await backInMusic.locator('[data-view="offline"]').click();
  await backInMusic.locator('[data-music-offline="0"] [data-music-empty]').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await backInMusic.locator('[data-view="albums"]').click();
  await backInMusic.locator('[data-music-albums]').getByRole('button', { name: /Берег/ }).click();
  const albumTracks = backInMusic.locator('[data-music-tracks]');
  await albumTracks.locator('[data-track="t2"][data-music-offline-track="none"]').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  if (process.env.PARVANE_E2E_SHOT_DIR) {
    await albumTracks.locator('[data-track="t2"] [data-music-menu]').click();
    await page.getByRole('menu').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
    await page.screenshot({ path: `${process.env.PARVANE_E2E_SHOT_DIR}/music-track-menu-desk.png` });
    await page.keyboard.press('Escape');
    await page.getByRole('menu').waitFor({ state: 'detached', timeout: STEP_TIMEOUT_MS });
  }
  await pickTrackAction(page, albumTracks.locator('[data-track="t2"]'), 'Download for offline');
  await albumTracks.locator('[data-track="t2"][data-music-offline-track="saved"]').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS * 2 });
  await backInMusic.locator('[data-view="offline"]').click();
  await backInMusic.locator('[data-music-offline="1"]').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  console.log('OK: один трек загружен на устройство из меню трека');
  await backInMusic.locator('[data-view="albums"]').click();
  await backInMusic.locator('[data-music-albums]').getByRole('button', { name: /Берег/ }).click();
  await backInMusic.locator('[data-music-save-offline]').click();
  await backInMusic.locator('[data-view="offline"]').click();
  await backInMusic.locator('[data-music-offline="3"]').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS * 2 });
  await backInMusic.locator('[data-offline-usage]').getByText(/3 tracks · .* of 1 GB on this device/)
    .waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  // Оболочка приложения в кэше сервис-воркера целиком — для перезагрузки без сети ниже (PWA, spec 041 F1)
  await page.locator('html[data-app-shell]').waitFor({ state: 'attached', timeout: STEP_TIMEOUT_MS * 6 });
  await context.setOffline(true);
  await backInMusic.locator('[data-offline-bar]').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await backInMusic.locator('[data-music-offline] [data-track="t3"]').getByRole('button').first().click();
  await backSide.locator('[data-music-now]').filter({ hasText: 'Соль' }).waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await backSide.locator('[data-music-play="playing"]').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await backSide.locator('[data-music-position]').filter({ hasText: /0:0[1-9]/ }).waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await backSide.getByRole('button', { name: 'Pause' }).click();
  console.log('OK: альбом загружен на устройство и играет без сети');

  // ── Приложение запущено без сети: «Загруженное» на месте и играет ─────────
  await page.goto(process.env.PARVANE_E2E_BASE_URL, { waitUntil: 'domcontentloaded' });
  const offlineMusic = await openMusic(page);
  await offlineMusic.locator('[data-view="offline"]').click();
  await offlineMusic.locator('[data-music-offline="3"]').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await offlineMusic.locator('[data-music-offline] [data-track="t1"]').getByRole('button').first().click();
  await offlineMusic.locator('aside [data-music-play="playing"]').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await offlineMusic.locator('aside [data-music-position]').filter({ hasText: /0:0[1-9]/ })
    .waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await offlineMusic.locator('aside').getByRole('button', { name: 'Pause' }).click();
  await context.setOffline(false);
  await offlineMusic.locator('[data-offline-bar]').waitFor({ state: 'detached', timeout: STEP_TIMEOUT_MS * 3 });
  console.log('OK: запуск без сети — «Загруженное» открывается и играет');
  await backInMusic.getByRole('button', { name: 'Remove from this device: Соль' }).click();
  await backInMusic.locator('[data-music-offline="2"]').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await backInMusic.locator('[data-offline-clear="ask"]').click();
  await backInMusic.locator('[data-offline-clear="confirm"]').click();
  await backInMusic.locator('[data-music-offline="0"]').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  console.log('OK: загруженное убирается по одному и целиком');

  // ── Загруженный плейлист следует за составом: новое докачивается, убранное стирается ─
  await backInMusic.locator('[data-view="albums"]').click();
  await backInMusic.locator('[data-music-albums]').getByRole('button', { name: /Берег/ }).click();
  const offAlbum = backInMusic.locator('[data-music-tracks]');
  await pickTrackAction(page, offAlbum.locator('[data-track="t3"]'), 'Add to a playlist');
  const offPicker = backInMusic.locator('[data-playlist-picker]');
  await offPicker.getByPlaceholder('New playlist name').fill('Офлайн');
  await offPicker.getByRole('button', { name: 'Create and add' }).click();
  await backInMusic.locator('[data-playlist-picker="added"]').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await offPicker.getByRole('button', { name: 'Close' }).click();
  await backInMusic.locator('[data-view="playlists"]').click();
  await backInMusic.locator('[data-music-playlists]').getByRole('button', { name: /Офлайн/ }).click();
  const offList = backInMusic.locator('[data-music-playlist]');
  await offList.locator('[data-track="t3"]').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await offList.locator('[data-music-save-offline]').click();
  await offList.locator('[data-track="t3"][data-music-offline-track="saved"]').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS * 2 });
  await backInMusic.locator('[data-view="albums"]').click();
  await backInMusic.locator('[data-music-albums]').getByRole('button', { name: /Берег/ }).click();
  await pickTrackAction(page, offAlbum.locator('[data-track="t2"]'), 'Add to a playlist');
  await offPicker.getByRole('button', { name: 'Офлайн', exact: true }).click();
  await backInMusic.locator('[data-playlist-picker="added"]').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await offPicker.getByRole('button', { name: 'Close' }).click();
  await offAlbum.locator('[data-track="t2"][data-music-offline-track="saved"]').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS * 2 });
  await backInMusic.locator('[data-view="playlists"]').click();
  await backInMusic.locator('[data-music-playlists]').getByRole('button', { name: /Офлайн/ }).click();
  await offList.getByRole('button', { name: 'Remove from the playlist: Соль' }).click();
  await backInMusic.locator('[data-view="offline"]').click();
  await backInMusic.locator('[data-music-offline="1"] [data-track="t2"]').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS * 2 });
  assert.equal(await backInMusic.locator('[data-music-offline] [data-track="t3"]').count(), 0, 'убранный из плейлиста трек стёрт');
  console.log('OK: загруженный плейлист — новый трек докачан, убранный стёрт с устройства');

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
