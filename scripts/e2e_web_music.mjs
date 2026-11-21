// Модуль «Музыка» (spec 039, 041; правила MUSIC-1, MUSIC-4). Библиотека — поддельный Subsonic-сервер за шардом
// music (`scripts/fake_subsonic.mjs`): два альбома, пять треков, первый трек длится 4 секунды. Проверяется путь
// слушателя по доскам макета: навигация компьютера (группы, счётчики, плейлисты, «+» модуля), главная (очередь
// справа), альбом, воспроизведение и переход на следующий трек, полный плеер (пауза, повтор, чипы, источник очереди),
// любимое, поиск одним списком и «играть следующим», очередь после перезагрузки; телефон — вкладки «Главная / Поиск /
// Библиотека», страницы со своей шапкой, мини-плеер и «+» в «Музыке», шторка меню трека, «Далее в очереди»;
// «Найти и скачать» (поддельный сервис `scripts/fake_music_fetch.mjs`, лимит раннера — три трека в сутки);
// «Добавлено мной»; плейлисты (окно «Новый плейлист», подменю «В плейлист ›», порядок перетаскиванием, меню «Ещё»);
// трек и плейлист в чат; «Загруженное» группами (трек, альбом, плейлист следует за составом, без сети); подгрузка
// длинных списков страницами, исполнители, «Популярное на сервере», синглы; пустая библиотека.
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
const LIBRARY_URL = `http://127.0.0.1:${process.env.PARVANE_E2E_MUSIC_LIBRARY_PORT || 19431}/__e2e/library`;

// Звук без жеста пользователя: сценарий нажимает кнопки сам, но автозапуск в безголовом режиме надёжнее разрешить
const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
let session;

// Перетащить строку за ручку на место строки `toId`: мышь — те же события указателя, что и палец. На компьютере
// ручка видна по наведению — указатель сперва на строку
async function dragRow(page, list, fromId, toId) {
  await list.locator(`[data-track="${fromId}"]`).hover();
  const handle = await list.locator(`[data-track="${fromId}"] [data-music-drag]`).boundingBox();
  const target = await list.locator(`[data-track="${toId}"]`).boundingBox();
  const x = handle.x + handle.width / 2;
  await page.mouse.move(x, handle.y + handle.height / 2);
  await page.mouse.down();
  await page.mouse.move(x, target.y + target.height / 2, { steps: 8 });
  await page.mouse.up();
}

// Меню трека (доски `XpMusic`, `ZdMusicX`): «⋯» строки (либо правая кнопка, если «⋯» в строке нет) и пункт
async function openTrackMenu(row) {
  const dots = row.locator('[data-music-menu]');
  if (await dots.isVisible().catch(() => false)) await dots.click();
  else await row.click({ button: 'right' });
}

async function pickTrackAction(page, row, action) {
  await openTrackMenu(row);
  const menu = page.getByRole('menu').first();
  await menu.getByRole('menuitem', { name: action, exact: true }).click();
  await page.getByRole('menu').first().waitFor({ state: 'detached', timeout: STEP_TIMEOUT_MS });
}

// Компьютер: «В плейлист ›» — подменю у курсора
async function addToPlaylist(page, row, playlistName) {
  await openTrackMenu(row);
  await page.getByRole('menuitem', { name: 'Add to a playlist', exact: true }).click();
  const sub = page.locator('[data-music-submenu]');
  await sub.getByRole('menuitem', { name: playlistName, exact: true }).click();
  await sub.waitFor({ state: 'detached', timeout: STEP_TIMEOUT_MS });
}

async function waitRows(page, list, expected) {
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

// Компьютер: что играет — виджет плеера в боковой панели (доска `DeskMusic`)
async function waitPlaying(page, title, state) {
  await page.waitForFunction(([want, wantState]) => {
    const widget = document.querySelector('#FoldersSidebar [data-music-widget]');
    return widget?.getAttribute('aria-label')?.includes(want)
      && (!wantState || widget.getAttribute('data-music-widget') === wantState);
  }, [title, state], { timeout: STEP_TIMEOUT_MS });
}

// Компьютер: управление — в полном плеере из виджета
async function withFullPlayer(page, action) {
  await page.locator('#FoldersSidebar [data-music-widget]').click();
  const full = page.locator('[data-music-full]');
  await full.waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await action(full);
  await page.keyboard.press('Escape');
  await full.waitFor({ state: 'detached', timeout: STEP_TIMEOUT_MS });
}

async function pause(page) {
  await withFullPlayer(page, async (full) => {
    const button = full.getByRole('button', { name: 'Pause', exact: true });
    if (await button.isVisible().catch(() => false)) await button.click();
    await full.locator('[data-music-play="paused"]').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  });
}

try {
  const user = `music-${Date.now().toString(36)}@local`;
  const context = await browser.newContext({ viewport: WIDE });
  session = await preparePage(context, user, PASSWORD);
  const { page } = session;
  await dismissRecoveryKeyDialog(page).catch(() => undefined);

  // ── Главная: навигация с группами и счётчиками, микс, очередь справа ─────
  const music = await openMusic(page);
  const navBar = music.locator('[data-music-nav]');
  const nav = (view) => navBar.locator(`[data-view="${view}"]`).click();
  const main = music.locator('[data-music-view]');
  const side = music.locator('aside');
  await music.locator('[data-music-mix]').getByText('Recommendations are coming soon').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await music.locator('[data-music-total]').getByText('5 tracks').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await navBar.getByText('Library', { exact: true }).waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await navBar.locator('[data-view="artists"]').getByText('2', { exact: true }).waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await navBar.locator('[data-view="albums"]').getByText('2', { exact: true }).waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await side.locator('[data-music-queue="empty"]').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  assert.equal(await music.locator('h1').count(), 0, 'на компьютере у модуля нет своей шапки');
  console.log('OK: главная — навигация с группами и счётчиками, число треков сервера, очередь справа пуста');

  // ── Альбомы: шапка с числом, альбом, воспроизведение ──────────────────────
  await nav('albums');
  await main.locator('[data-music-title]').getByText('Albums · 2').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  const albums = main.locator('[data-music-albums]');
  await albums.getByRole('button', { name: /Берег/ }).click();
  const tracks = main.locator('[data-music-tracks]');
  await tracks.locator('[data-track]').nth(2).waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  assert.equal(await tracks.locator('[data-track]').count(), 3, 'в альбоме три трека');
  assert.equal(await navBar.locator('[data-view="albums"][aria-current="page"]').count(), 1, 'альбом подсвечивает «Альбомы»');
  await main.locator('[data-music-artist-link]').getByText('Тихий порт').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  // Правая кнопка — то же меню у курсора; черта перед опасным пунктом — только у добавленных (ниже)
  await tracks.locator('[data-track="t2"]').click({ button: 'right' });
  const deskMenu = page.getByRole('menu').first();
  await deskMenu.getByRole('menuitem', { name: 'Download to this computer' }).waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  const deskItems = await deskMenu.getByRole('menuitem').allInnerTexts();
  assert.deepEqual(deskItems.map((text) => text.replace('›', '').trim()), ['Play next', 'Add to queue', 'Add to a playlist',
    'Add to favourites', 'Go to artist', 'Go to album', 'Send to a chat…', 'Download to this computer'],
  `меню у курсора по доске ZdMusicX: ${deskItems}`);
  await page.keyboard.press('Escape');
  await page.getByRole('menu').first().waitFor({ state: 'detached', timeout: STEP_TIMEOUT_MS });
  await tracks.locator('[data-track="t1"]').getByRole('button').first().click();
  await waitPlaying(page, 'Северный ветер', 'playing');
  console.log('OK: альбом — шапка, исполнитель ссылкой, трек играет (виджет панели)');

  // ── Трек доигран сам — играет следующий по очереди ────────────────────────
  await waitPlaying(page, 'Harbor Lights', 'playing');
  // Играющий отмечен и в таблице альбома (на компьютере подпись «играет» — у очереди, в таблице — цветом)
  await tracks.locator('[data-track="t2"][data-music-current]').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  console.log('OK: после конца трека играет следующий');

  // ── Полный плеер: пауза, следующий, повтор, источник, «В любимое» ────────
  await withFullPlayer(page, async (full) => {
    await full.locator('[data-music-position]').filter({ hasText: /0:0\d/ }).waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
    await full.getByRole('button', { name: 'Pause', exact: true }).click();
    await full.locator('[data-music-play="paused"]').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
    await full.getByRole('button', { name: 'Next track' }).click();
    await full.getByRole('heading', { name: 'Соль' }).waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
    await full.getByRole('button', { name: 'Pause', exact: true }).click();
    await full.getByRole('button', { name: 'Repeat: off' }).click();
    await full.locator('[data-music-repeat="all"]').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
    await full.locator('[data-music-queue-note]').getByText('Source: album «Берег».').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
    await full.getByRole('button', { name: 'Add to favourites' }).click();
    await full.getByRole('button', { name: 'Remove from favourites' }).waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  });
  console.log('OK: полный плеер — пауза, следующий, повтор, источник очереди, «В любимое»');

  // ── Любимое: шапка с числом, «Слушать», строка ────────────────────────────
  await page.waitForTimeout(1000);
  await nav('starred');
  await music.locator('[data-music-view="starred"] [data-track="t3"]').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  assert.equal(await music.locator('[data-music-view="starred"] [data-track]').count(), 1, 'в любимом один трек');
  await main.getByRole('button', { name: 'Listen' }).waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await main.getByPlaceholder('Find in favourites').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await main.locator('[data-music-starred-note]').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await navBar.locator('[data-view="starred"]').getByText('1', { exact: true }).waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  console.log('OK: любимое — шапка, «Слушать», поиск по любимому, счётчик в навигации');

  // ── Поиск одним списком и «играть следующим» ──────────────────────────────
  await nav('search');
  await music.locator('[data-music-search]').getByRole('searchbox').fill('glass');
  const found = music.locator('[data-music-view="search"] [data-track="t4"]');
  await found.waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await found.getByText('Track · Kora Mesh').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await music.locator('[data-music-found]').getByText('On the server · 1').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await pickTrackAction(page, found, 'Play next');
  await music.getByRole('button', { name: 'Albums', exact: true }).click();
  await music.locator('[data-music-found="0"]').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await music.getByRole('button', { name: 'All', exact: true }).click();
  await pickTrackAction(page, found, 'Go to album');
  await music.locator('[data-music-view="album"] [data-track="t4"]').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await nav('search');
  await music.locator('[data-music-search]').getByRole('searchbox').fill('нет такого');
  await music.locator('[data-music-empty="search"]').getByText('Nothing found on the server.').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await music.locator('[data-music-search]').getByRole('searchbox').fill('');
  // Очередь в порядке проигрывания: найденный трек — сразу после играющего (колонка главной)
  await nav('home');
  await side.locator('[data-music-queue="4"]').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  const queueOrder = await side.locator('[data-track]').evaluateAll((rows) => rows.map((row) => row.dataset.track));
  assert.deepEqual(queueOrder, ['t1', 't2', 't3', 't4'], 'порядок очереди после «играть следующим»');
  await side.locator('[data-track="t3"][data-music-current]').getByText('playing').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  console.log('OK: поиск — «На сервере · N», чипы, «играть следующим», к альбому, пустой результат');

  // ── Очередь: порядок перетаскиванием за ручку, играющий трек не меняется ─
  await dragRow(page, side.locator('[data-music-queue]'), 't1', 't2');
  await waitRows(page, side.locator('[data-music-queue]'), ['t2', 't1', 't3', 't4']);
  await waitPlaying(page, 'Соль');
  console.log('OK: очередь переставлена перетаскиванием');

  // ── «+» модуля: «Найти и скачать» и «Новый плейлист» ──────────────────────
  const plus = page.locator('#FoldersSidebar [data-add-for="music"]');
  await plus.click();
  await page.getByRole('menuitem', { name: 'Find and download' }).click();
  await music.locator('[data-music-view="search"]').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  assert.equal(await music.locator('[data-music-search]').getByRole('searchbox').evaluate((input) => input === document.activeElement), true,
    '«Найти и скачать» ставит курсор в поле');
  await plus.click();
  await page.getByRole('menuitem', { name: 'New playlist' }).click();
  const newPlaylist = page.locator('[data-music-new-playlist-form]');
  await newPlaylist.waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await newPlaylist.getByRole('button', { name: 'Cancel' }).click();
  await newPlaylist.waitFor({ state: 'detached', timeout: STEP_TIMEOUT_MS });
  console.log('OK: «+» в «Музыке» — «Найти и скачать» и «Новый плейлист»');

  // ── Плеер вне модуля: виджет в боковой панели ─────────────────────────────
  await page.locator('#FoldersSidebar').getByRole('tab', { name: 'Chats' }).click();
  const widget = page.locator('#FoldersSidebar [data-music-widget]');
  await widget.click();
  const full = page.locator('[data-music-full]');
  await full.getByRole('heading', { name: 'Соль' }).waitFor();
  await full.getByRole('button', { name: 'Play', exact: true }).click();
  await full.getByRole('button', { name: 'Pause', exact: true }).click();
  await full.getByRole('button', { name: 'Add to a playlist', exact: true }).click();
  const fullPicker = page.locator('.Modal [data-playlist-picker]');
  await fullPicker.getByRole('button', { name: 'Close' }).click();
  await full.getByRole('button', { name: 'Send to a chat' }).click();
  // «Кому отправить» (доска `RpPick`): карточка «название · исполнитель · трек», чаты с галочками
  const sendScreen = page.locator('.Modal').filter({ has: page.locator('[data-send-picker]') });
  await sendScreen.locator('[data-send-preview]').getByText('Соль').waitFor();
  await sendScreen.locator('[data-send-row]').filter({ hasText: 'Saved Messages' }).first().waitFor();
  await page.keyboard.press('Escape');
  await sendScreen.waitFor({ state: 'hidden' });
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
  await reloadedSide.locator('[data-music-queue="4"]').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await waitPlaying(page, 'Соль', 'paused');
  await withFullPlayer(page, async (opened) => {
    await opened.locator('[data-music-repeat="all"]').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
    // Источник на компьютере — в сноске под очередью (подпись сверху — только на телефоне)
    await opened.locator('[data-music-queue-note]').getByText('Source: album «Берег».').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  });
  console.log('OK: очередь, играющий трек, повтор и источник пережили перезагрузку');

  // ── Телефон: вкладки, страницы, мини-плеер и «+» в «Музыке» ───────────────
  await page.setViewportSize(PHONE);
  await page.waitForTimeout(800);
  const ribbon = page.getByRole('navigation', { name: 'Modules' });
  const phone = await openMusic(page);
  const mini = page.locator('[data-music-mini]');
  await mini.waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await page.locator('[data-add-for="music"]').click();
  await page.getByRole('menuitem', { name: 'Find and download' }).waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await page.getByRole('menuitem', { name: 'New playlist' }).waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await page.keyboard.press('Escape');
  const tabs = phone.getByRole('tablist', { name: 'Music' });
  for (const tab of ['Home', 'Search', 'Library']) {
    await tabs.getByRole('tab', { name: tab }).waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  }
  await tabs.getByRole('tab', { name: 'Library' }).click();
  const library = phone.locator('[data-music-library]');
  for (const row of ['starred', 'playlists', 'artists', 'albums', 'offline']) {
    await library.locator(`[data-view="${row}"]`).waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  }
  await library.locator('[data-view="artists"]').getByText('The whole server library').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await library.locator('[data-view="artists"]').click();
  // Страница поверх ленты: своя шапка с «назад», лента модулей скрыта, мини-плеер внизу
  await phone.locator('[data-music-back]').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await ribbon.waitFor({ state: 'detached', timeout: STEP_TIMEOUT_MS });
  await mini.waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await phone.locator('section[data-letter="K"]').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await phone.locator('section[data-letter="Т"]').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await phone.getByRole('navigation', { name: 'Alphabet' }).getByRole('button', { name: 'Т', exact: true }).click();
  await phone.getByRole('tab', { name: /Albums · 2/ }).click();
  await phone.locator('[data-music-albums]').getByRole('button', { name: /Берег/ }).click();
  const phoneAlbum = phone.locator('[data-music-tracks]');
  await phoneAlbum.locator('[data-track="t1"]').getByRole('button').first().click();
  // Первый трек короткий (4 с): пауза сразу, чтобы очередь стояла на нём
  await mini.getByRole('button', { name: 'Pause', exact: true }).click();
  await page.locator('[data-music-mini="paused"]').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  // Полный плеер телефона: «Играет из альбома», «Далее в очереди» — только после играющего
  await mini.getByRole('button', { name: 'Open player' }).click();
  await full.getByRole('heading', { name: 'Северный ветер' }).waitFor();
  await full.locator('[data-music-source="album"]').getByText('Playing from an album').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await full.locator('[data-music-queue] [aria-expanded]').click();
  await full.locator('[aria-expanded="true"]').waitFor();
  await waitRows(page, full, ['t2', 't3']);
  await dragRow(page, full, 't3', 't2');
  await waitRows(page, full, ['t3', 't2']);
  await full.getByRole('button', { name: 'Collapse player' }).click();
  await full.waitFor({ state: 'detached' });
  console.log('OK: телефон — полный плеер, источник, «Далее в очереди» перетаскиванием');
  await phone.locator('[data-music-back]').click();
  await phone.locator('[data-music-back]').click();
  await ribbon.waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  // «Поиск» — страница «‹ Музыка · поиск» с полем и чипами
  await tabs.getByRole('tab', { name: 'Search' }).click();
  await phone.locator('[data-music-search]').getByText('Music · search').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await phone.locator('[data-music-search]').getByRole('searchbox').fill('harbor');
  await phone.locator('[data-music-found="2"]').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await phone.getByRole('button', { name: 'Albums', exact: true }).click();
  await phone.locator('[data-music-found="0"]').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await phone.getByRole('button', { name: 'All', exact: true }).click();
  // «Нет на сервере» на телефоне: ход загрузки в процентах и отмена (блок «Найти и скачать»)
  await phone.locator('[data-music-search]').getByRole('searchbox').fill('медленный берег');
  const phoneFetch = phone.locator('[data-music-fetch]');
  await phoneFetch.locator('[data-fetch-track="Медленный берег"] [data-fetch-download]').click();
  const slowJob = phoneFetch.locator('[data-fetch-job][data-fetch-state="downloading"]').first();
  await slowJob.locator('[data-fetch-percent]').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS * 2 });
  await slowJob.locator('[data-fetch-cancel]').click();
  await slowJob.waitFor({ state: 'detached', timeout: STEP_TIMEOUT_MS });
  const phoneOverflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  assert.ok(phoneOverflow <= 0, `горизонтальное переполнение поиска на телефоне: ${phoneOverflow}`);
  await phone.locator('[data-music-search]').getByRole('searchbox').fill('');
  await phone.locator('[data-music-back]').click();
  await ribbon.waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  console.log('OK: телефон — вкладки, «Библиотека» строками, страницы с «назад», мини-плеер и «+» в «Музыке»');

  await ribbon.getByRole('button', { name: 'Chats' }).click();
  await mini.waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  const [miniBox, ribbonBox, addBox] = [await mini.boundingBox(), await ribbon.boundingBox(), await page.locator('[data-add-for="chats"]').boundingBox()];
  assert.ok(Math.abs(miniBox.y + miniBox.height - ribbonBox.y) <= 1, `полоса плеера не над лентой: ${JSON.stringify({ miniBox, ribbonBox })}`);
  assert.ok(addBox.y + addBox.height <= miniBox.y, `«+» перекрывает полосу плеера: ${JSON.stringify({ addBox, miniBox })}`);
  // «Open player» тоже содержит «Play» — имя кнопки точное
  const playOrPause = mini.getByRole('button', { name: 'Play', exact: true });
  if (await playOrPause.isVisible().catch(() => false)) await playOrPause.click();
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
  console.log('OK: звонок ставит музыку на паузу, плашка звонка вверху, мини-плеер над лентой');

  await mini.getByRole('button', { name: 'Open player' }).click();
  await full.locator('h2').first().waitFor();
  await ribbon.waitFor({ state: 'detached' });
  await full.getByRole('button', { name: 'Collapse player' }).click();
  await full.waitFor({ state: 'detached' });
  await ribbon.waitFor();
  await mini.waitFor();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  assert.ok(overflow <= 0, `горизонтальное переполнение на телефоне: ${overflow}`);
  console.log('OK: телефон — полный плеер поверх ленты и возврат ленты');

  // Телефон: меню трека — шторка снизу с обложкой и чипами плейлистов
  const phoneMusic = await openMusic(page);
  await phoneMusic.getByRole('tablist', { name: 'Music' }).getByRole('tab', { name: 'Library' }).click();
  await phoneMusic.locator('[data-music-library] [data-view="albums"]').click();
  await phoneMusic.locator('[data-music-albums]').getByRole('button', { name: /Берег/ }).click();
  const phoneRow = phoneMusic.locator('[data-music-tracks] [data-track="t2"]');
  await phoneRow.locator('[data-music-menu]').click();
  const sheetMenu = page.locator('.Modal [role="menu"]');
  await sheetMenu.getByRole('menuitem', { name: 'Go to artist', exact: true }).waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  const sheetItems = await sheetMenu.getByRole('menuitem').allInnerTexts();
  assert.deepEqual(sheetItems.map((text) => text.trim()),
    ['Play next', 'Add to queue', 'Add to favourites', 'Download for offline', 'Send to a chat', 'Go to artist', 'Go to album'],
    `порядок пунктов шторки по доске XpMusic: ${sheetItems}`);
  await page.locator('.Modal [data-playlist-chips] [data-playlist-chip-new]').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  if (process.env.PARVANE_E2E_SHOT_DIR) {
    await page.screenshot({ path: `${process.env.PARVANE_E2E_SHOT_DIR}/music-track-menu-phone.png` });
  }
  const sheetOverflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  assert.ok(sheetOverflow <= 0, `горизонтальное переполнение со шторкой меню: ${sheetOverflow}`);
  await page.locator('.Modal').getByRole('button', { name: 'Close' }).click();
  await sheetMenu.waitFor({ state: 'detached', timeout: STEP_TIMEOUT_MS });
  console.log('OK: телефон — меню трека шторкой по доске');

  // ── «Найти и скачать»: уверенное совпадение качается само ─────────────────
  await page.setViewportSize(WIDE);
  await page.waitForTimeout(800);
  const wide = await openMusic(page);
  const wideNav = (view) => wide.locator(`[data-music-nav] [data-view="${view}"]`).click();
  await pause(page).catch(() => undefined);
  const fetchRow = (title) => wide.locator(`[data-music-fetch] [data-fetch-track="${title}"]`);
  const searchFor = async (text, title) => {
    await wideNav('search');
    await wide.locator('[data-music-search]').getByRole('searchbox').fill(text);
    await fetchRow(title).waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
    return fetchRow(title);
  };
  const bus = await searchFor('автобус', 'Ночной автобус');
  await wide.locator('[data-music-empty="search"]').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await bus.locator('[data-fetch-download]').click();
  await bus.locator('[data-fetch-play]').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS * 2 });
  assert.equal(await bus.locator('[data-fetch-candidates]').count(), 0, 'уверенное совпадение не спрашивает выбора');
  await bus.locator('[data-fetch-play]').click();
  await waitPlaying(page, 'Ночной автобус', 'playing');
  await pause(page);
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
  assert.equal(await candidates.getByRole('button', { name: 'This one' }).count(), 2, 'в списке два файла');
  await candidates.getByRole('button', { name: 'This one' }).first().click();
  await loud.locator('[data-fetch-play]').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS * 2 });
  console.log('OK: спорное совпадение скачано после выбора файла');

  // ── Лимит: три трека в сутки ──────────────────────────────────────────────
  const morning = await searchFor('утро', 'Утро');
  await morning.locator('[data-fetch-download]').click();
  await morning.locator('[data-fetch-play]').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS * 2 });
  await wide.locator('[data-music-search]').getByRole('searchbox').fill('');
  console.log('OK: три трека за сутки скачаны');

  // ── «Добавлено мной»: свои треки, расход, удаление; «добавил я» на главной ─
  await wideNav('added');
  const mine = wide.locator('[data-music-added="mine"]');
  await mine.locator('[data-track]').nth(2).waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await wide.locator('[data-music-usage]').getByText('Today 3 of 3').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await pickTrackAction(page, mine.locator('[data-track]').filter({ hasText: 'Утро' }), 'Remove from the server library');
  await wide.locator('[data-music-usage]').getByText('Today 2 of 3').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await mine.locator('[data-track]').nth(2).waitFor({ state: 'detached', timeout: STEP_TIMEOUT_MS });
  await wideNav('home');
  const everyone = wide.locator('[data-music-added="all"]');
  await everyone.getByText('added by me').first().waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  assert.equal(await everyone.locator('[data-track]').count(), 2, 'на главной два добавленных трека');
  await everyone.locator('[data-track]').first().locator('[data-music-offline-track="none"]').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  console.log('OK: «Добавлено мной» — расход, удаление; «Новое на сервере» — «добавил я», ↓ в строке');

  // ── Плейлисты: окно «Новый плейлист», подменю «В плейлист ›» ──────────────
  const playlistsNav = wide.locator('[data-music-nav] [data-playlist]');
  await wide.locator('[data-music-nav] [data-music-new-playlist]').click();
  const createForm = page.locator('[data-music-new-playlist-form]');
  await createForm.getByPlaceholder('for example: For the road').fill('Дорога');
  // Играющий трек предлагается добавить сразу (доска `ZdMusicX`) — здесь плейлист создаётся пустым
  await createForm.locator('[data-music-add-current][aria-checked="true"]').click();
  await createForm.locator('[data-music-add-current][aria-checked="false"]').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await createForm.getByRole('button', { name: 'Create', exact: true }).click();
  const opened = wide.locator('[data-music-playlist]');
  await opened.locator('[data-music-empty]').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await opened.getByText('My playlist').first().waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await wideNav('albums');
  await wide.locator('[data-music-albums]').getByRole('button', { name: /Берег/ }).click();
  const albumRow = (id) => wide.locator(`[data-music-tracks] [data-track="${id}"]`);
  await albumRow('t1').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await addToPlaylist(page, albumRow('t1'), 'Дорога');
  await page.getByText('Added to «Дорога»').first().waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await addToPlaylist(page, albumRow('t3'), 'Дорога');
  await addToPlaylist(page, albumRow('t1'), 'Дорога');
  await page.getByText('This track is already in the playlist').first().waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  // Новый плейлист из подменю — окно с «Сразу добавить «трек»»
  await addToPlaylist(page, albumRow('t2'), 'New…');
  await createForm.locator('[data-music-add-current][aria-checked="true"]').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await createForm.getByPlaceholder('for example: For the road').fill('Вечер');
  await createForm.getByRole('button', { name: 'Create', exact: true }).click();
  await page.getByText('Playlist «Вечер» created').first().waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  // Телефон (доска `XpMusic`): в шторке трека плейлисты — чипами внизу; где трек уже есть — чип выделен
  await page.setViewportSize(PHONE);
  await albumRow('t1').locator('[data-music-menu]').click();
  const chips = page.locator('[data-playlist-chips]');
  await chips.waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  assert.equal(await chips.getByRole('button', { name: 'Дорога', exact: true }).getAttribute('aria-pressed'), 'true');
  await chips.getByRole('button', { name: 'Вечер', exact: true }).click();
  await chips.waitFor({ state: 'detached', timeout: STEP_TIMEOUT_MS });
  await page.setViewportSize(WIDE);
  await playlistsNav.filter({ hasText: 'Дорога' }).getByText('2', { exact: true }).waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await playlistsNav.filter({ hasText: 'Вечер' }).getByText('2', { exact: true }).waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  console.log('OK: плейлисты — окно «Новый плейлист», подменю, чипы на телефоне, плейлисты в навигации');

  // ── Страница плейлиста: таблица, порядок, «Играть», убрать, переименовать ─
  await playlistsNav.filter({ hasText: 'Дорога' }).click();
  const waitOrder = async (expected) => {
    await page.waitForFunction((want) => {
      const rows = [...document.querySelectorAll('#ParvaneMusic [data-music-playlist] [data-track]')];
      return rows.map((row) => row.dataset.track).join() === want;
    }, expected.join(), { timeout: STEP_TIMEOUT_MS });
  };
  await waitOrder(['t1', 't3']);
  await opened.getByText('2 tracks', { exact: false }).first().waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await dragRow(page, opened, 't1', 't3');
  await waitOrder(['t3', 't1']);
  await opened.getByRole('button', { name: 'Play', exact: true }).click();
  await waitPlaying(page, 'Соль', 'playing');
  await pause(page);
  await pickTrackAction(page, opened.locator('[data-track="t3"]'), 'Remove from the playlist');
  await waitOrder(['t1']);
  await opened.locator('[data-music-playlist-menu]').click();
  await page.getByRole('menuitem', { name: 'Rename', exact: true }).click();
  await page.locator('[data-music-playlist-name]').fill('В дорогу');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await playlistsNav.filter({ hasText: 'В дорогу' }).getByText('1', { exact: true }).waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  console.log('OK: страница плейлиста — порядок, «Играть», «Убрать из плейлиста», «Переименовать»');

  // ── Перезагрузка: плейлисты на месте; удаление плейлиста с вопросом ───────
  await page.waitForTimeout(3000);
  await reloadPage(page);
  const again2 = await openMusic(page);
  const lists2 = again2.locator('[data-music-nav] [data-playlist]');
  await lists2.filter({ hasText: 'В дорогу' }).waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await lists2.filter({ hasText: 'Вечер' }).click();
  await again2.locator('[data-music-playlist] [data-track="t2"]').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await again2.locator('[data-music-playlist-menu]').click();
  await page.getByRole('menuitem', { name: 'Delete playlist', exact: true }).click();
  await page.locator('[data-playlist-delete="confirm"]').click();
  await lists2.filter({ hasText: 'Вечер' }).waitFor({ state: 'detached', timeout: STEP_TIMEOUT_MS });
  assert.equal(await lists2.count(), 1, 'после удаления остался один плейлист');
  console.log('OK: плейлисты пережили перезагрузку, плейлист удалён');

  // ── Трек в чат: карточка в «Избранном», из неё трек играет ────────────────
  const wide2 = (view) => again2.locator(`[data-music-nav] [data-view="${view}"]`).click();
  await wide2('albums');
  await again2.locator('[data-music-albums]').getByRole('button', { name: /Берег/ }).click();
  await pickTrackAction(page, again2.locator('[data-music-tracks] [data-track="t2"]'), 'Send to a chat…');
  const trackSend = page.locator('.Modal').filter({ has: page.locator('[data-send-picker]') });
  await trackSend.locator('[data-send-row]').filter({ hasText: 'Saved Messages' }).first()
    .locator('input[type="checkbox"]').check();
  await trackSend.locator('[data-send-submit]').click();
  await page.getByText('Track sent').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await page.locator('#FoldersSidebar').getByRole('tab', { name: 'Chats' }).click();
  await page.locator('#LeftColumn .chat-list').getByText('Saved Messages').first().click();
  const card = page.locator('[data-music-track-card="t2"]');
  await card.getByText('Harbor Lights').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await card.getByText('Server music').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  // Телефон: карточка трека во всю ширину ленты, без переполнения (доска `MusicChat`)
  await page.setViewportSize(PHONE);
  await card.waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  const cardOverflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  assert.ok(cardOverflow <= 0, `карточка трека переполняет телефон: ${cardOverflow}`);
  await page.setViewportSize(WIDE);
  await page.locator('#LeftColumn .chat-list').getByText(/Track: .*Harbor Lights/).first()
    .waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await card.getByRole('button', { name: 'Play track', exact: true }).click();
  await waitPlaying(page, 'Harbor Lights', 'playing');
  console.log('OK: трек отправлен в чат карточкой и играет из неё');

  // ── Плейлист в чат: карточка, «Открыть», «Сохранить к себе», «Слушать» ────
  const backInMusic = await openMusic(page);
  await pause(page);
  await backInMusic.locator('[data-music-nav] [data-playlist]').filter({ hasText: 'В дорогу' }).click();
  await backInMusic.locator('[data-music-playlist] [data-music-playlist-to-chat]').click();
  const playlistSend = page.locator('.Modal').filter({ has: page.locator('[data-send-picker]') });
  await playlistSend.locator('[data-send-row]').filter({ hasText: 'Saved Messages' }).first()
    .locator('input[type="checkbox"]').check();
  await playlistSend.locator('[data-send-submit]').click();
  await page.getByText('Playlist sent').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await page.locator('#FoldersSidebar').getByRole('tab', { name: 'Chats' }).click();
  await page.locator('#LeftColumn .chat-list').getByText('Saved Messages').first().click();
  const playlistCard = page.locator('[data-music-playlist-card="В дорогу"]');
  await playlistCard.getByText('Северный ветер').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await playlistCard.getByText(/^1 track/).waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await playlistCard.getByRole('button', { name: 'Open', exact: true }).click();
  const sharedSheet = page.locator('[data-music-playlist-sheet]');
  await sharedSheet.locator('[data-track="t1"]').getByText('Северный ветер').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await sharedSheet.getByRole('button', { name: 'Save to my playlists' }).click();
  await page.getByText('Playlist saved to your playlists').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await sharedSheet.waitFor({ state: 'detached', timeout: STEP_TIMEOUT_MS });
  await playlistCard.getByRole('button', { name: 'Listen', exact: true }).click();
  await waitPlaying(page, 'Северный ветер');
  await openMusic(page);
  await pause(page).catch(() => undefined);
  await backInMusic.locator('[data-music-nav] [data-playlist]').filter({ hasText: 'В дорогу' }).nth(1)
    .waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  console.log('OK: плейлист отправлен в чат карточкой, открыт, сохранён к себе и играет');

  // ── «Загруженное»: группы, один трек и альбом на устройстве, без сети ─────
  const offNav = (view) => backInMusic.locator(`[data-music-nav] [data-view="${view}"]`).click();
  await offNav('offline');
  await backInMusic.locator('[data-music-offline="0"] [data-music-empty]').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await backInMusic.getByRole('switch', { name: /Download new tracks/ }).waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await backInMusic.locator('[data-music-offline-quality]').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await offNav('albums');
  await backInMusic.locator('[data-music-albums]').getByRole('button', { name: /Берег/ }).click();
  const albumTracks = backInMusic.locator('[data-music-tracks]');
  await albumTracks.locator('[data-track="t2"][data-music-offline-track="none"]').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  if (process.env.PARVANE_E2E_SHOT_DIR) {
    await albumTracks.locator('[data-track="t2"] [data-music-menu]').click();
    await page.getByRole('menu').first().waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
    await page.screenshot({ path: `${process.env.PARVANE_E2E_SHOT_DIR}/music-track-menu-desk.png` });
    await page.keyboard.press('Escape');
    await page.getByRole('menu').first().waitFor({ state: 'detached', timeout: STEP_TIMEOUT_MS });
  }
  await pickTrackAction(page, albumTracks.locator('[data-track="t2"]'), 'Download to this computer');
  await albumTracks.locator('[data-track="t2"][data-music-offline-track="saved"]').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS * 2 });
  await offNav('offline');
  await backInMusic.locator('[data-music-offline="1"] [data-offline-group="tracks:"]').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  console.log('OK: один трек загружен на устройство из меню трека — «Отдельные треки»');
  await offNav('albums');
  await backInMusic.locator('[data-music-albums]').getByRole('button', { name: /Берег/ }).click();
  await backInMusic.locator('[data-music-save-offline]').click();
  await offNav('offline');
  await backInMusic.locator('[data-music-offline="3"]').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS * 2 });
  await backInMusic.locator('[data-offline-usage]').getByText(/3 tracks · .* of 1 GB on this device/)
    .waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  const albumGroup = backInMusic.locator('[data-offline-group="album:al-1"]');
  await albumGroup.getByText('album · 3 tracks').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await albumGroup.locator('[data-group]').first().click();
  // Оболочка приложения в кэше сервис-воркера целиком — для перезагрузки без сети ниже (PWA, spec 041 F1)
  await page.locator('html[data-app-shell]').waitFor({ state: 'attached', timeout: STEP_TIMEOUT_MS * 6 });
  await context.setOffline(true);
  await backInMusic.locator('[data-offline-bar]').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await albumGroup.locator('[data-track="t3"]').getByRole('button').first().click();
  await waitPlaying(page, 'Соль', 'playing');
  await pause(page);
  console.log('OK: альбом загружен на устройство одной группой и играет без сети');

  // ── Приложение запущено без сети: «Загруженное» на месте и играет ─────────
  // `reloadPage`, а не `goto`: закрытие полного плеера в `pause` снимает запись истории отложенным переходом, и
  // выданная в этот момент навигация обрывалась `net::ERR_ABORTED`
  await reloadPage(page);
  const offlineMusic = await openMusic(page);
  await offlineMusic.locator('[data-music-nav] [data-view="offline"]').click();
  await offlineMusic.locator('[data-music-offline="3"]').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  const offlineGroup = offlineMusic.locator('[data-offline-group="album:al-1"]');
  await offlineGroup.locator('[data-group]').first().click();
  await offlineGroup.locator('[data-track="t1"]').getByRole('button').first().click();
  await waitPlaying(page, 'Северный ветер', 'playing');
  await pause(page);
  await context.setOffline(false);
  await offlineMusic.locator('[data-offline-bar]').waitFor({ state: 'detached', timeout: STEP_TIMEOUT_MS * 3 });
  console.log('OK: запуск без сети — «Загруженное» открывается и играет');
  await pickTrackAction(page, offlineGroup.locator('[data-track="t3"]'), 'Remove from this device');
  await offlineMusic.locator('[data-music-offline="2"]').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await offlineMusic.locator('[data-offline-clear="ask"]').click();
  await offlineMusic.locator('[data-offline-clear="confirm"]').click();
  await offlineMusic.locator('[data-music-offline="0"]').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  console.log('OK: загруженное убирается по одному и целиком');

  // ── Загруженный плейлист следует за составом: новое докачивается, убранное стирается ─
  const plNav = (view) => offlineMusic.locator(`[data-music-nav] [data-view="${view}"]`).click();
  await plNav('albums');
  await offlineMusic.locator('[data-music-albums]').getByRole('button', { name: /Берег/ }).click();
  const offAlbum = offlineMusic.locator('[data-music-tracks]');
  await addToPlaylist(page, offAlbum.locator('[data-track="t3"]'), 'New…');
  await createForm.getByPlaceholder('for example: For the road').fill('Офлайн');
  await createForm.getByRole('button', { name: 'Create', exact: true }).click();
  await createForm.waitFor({ state: 'detached', timeout: STEP_TIMEOUT_MS });
  const offList = offlineMusic.locator('[data-music-playlist]');
  await offlineMusic.locator('[data-music-nav] [data-playlist]').filter({ hasText: 'Офлайн' }).click();
  await offList.locator('[data-track="t3"]').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await offList.locator('[data-music-playlist-menu]').click();
  await page.getByRole('menuitem', { name: 'Download the playlist for offline', exact: true }).click();
  await offList.locator('[data-track="t3"][data-music-offline-track="saved"]').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS * 2 });
  await offList.getByText('downloaded for offline').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await plNav('albums');
  await offlineMusic.locator('[data-music-albums]').getByRole('button', { name: /Берег/ }).click();
  await addToPlaylist(page, offAlbum.locator('[data-track="t2"]'), 'Офлайн');
  await offAlbum.locator('[data-track="t2"][data-music-offline-track="saved"]').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS * 2 });
  await offlineMusic.locator('[data-music-nav] [data-playlist]').filter({ hasText: 'Офлайн' }).click();
  await pickTrackAction(page, offList.locator('[data-track="t3"]'), 'Remove from the playlist');
  await plNav('offline');
  const playlistGroup = offlineMusic.locator('[data-music-offline="1"] [data-offline-group^="playlist:"]');
  await playlistGroup.getByText('Офлайн').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS * 2 });
  await playlistGroup.getByText('playlist · 1 track').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  console.log('OK: загруженный плейлист — новый трек докачан, убранный стёрт с устройства, группа плейлиста');

  // ── Длинные списки страницами, исполнители, «Популярное», синглы ──────────
  await fetch(`${LIBRARY_URL}?extra=60`);
  await page.waitForTimeout(1500);
  await reloadPage(page);
  const big = await openMusic(page);
  const bigNav = (view) => big.locator(`[data-music-nav] [data-view="${view}"]`).click();
  await bigNav('artists');
  await big.locator('[data-music-title]').getByText('Artists').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  // В библиотеке — 2 исполнителя сценария, добавленные «Найти и скачать» и 60 сингловых: больше одной страницы
  await big.getByText(/\d+ in the server library/).waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  const artistRows = big.locator('[data-music-artists] [data-id]');
  await artistRows.nth(49).waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await big.locator('[data-music-more]').scrollIntoViewIfNeeded();
  await page.waitForFunction(() => document.querySelectorAll('#ParvaneMusic [data-music-artists] [data-id]').length >= 62,
    undefined, { timeout: STEP_TIMEOUT_MS });
  console.log('OK: исполнители — шапка с числом, подгрузка второй страницы при прокрутке');
  await big.getByRole('button', { name: 'By tracks', exact: true }).click();
  await big.locator('[data-music-artists] [data-id]').first().getByText('Тихий порт').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await big.getByPlaceholder('Find an artist').fill('тихий');
  await page.waitForFunction(() => document.querySelectorAll('#ParvaneMusic [data-music-artists] [data-id]').length === 1,
    undefined, { timeout: STEP_TIMEOUT_MS });
  await big.locator('[data-music-artist-panel="ar-1"]').getByText('Берег').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await big.locator('[data-music-artists] [data-id="ar-1"]').dblclick();
  const artistPage = big.locator('[data-music-artist="ar-1"]');
  await artistPage.getByText('1 album · 3 tracks on the server').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await artistPage.locator('[data-music-popular] [data-track]').first().waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await artistPage.getByRole('button', { name: 'Play all' }).click();
  await waitPlaying(page, 'Северный ветер', 'playing');
  await pause(page);
  assert.equal(await big.locator('[data-music-nav] [data-view="artists"][aria-current="page"]').count(), 1, 'исполнитель подсвечивает «Исполнители»');
  console.log('OK: исполнитель — шапка, «Играть всё», «Популярное на сервере»');
  // Сингл исполнителя — плиткой «Синглы»
  await bigNav('artists');
  await big.getByPlaceholder('Find an artist').fill('Echo 07');
  await big.locator('[data-music-artists] [data-id="ar-x07"]').dblclick();
  await big.locator('[data-music-artist="ar-x07"] [data-singles="ar-x07"]').click();
  await big.locator('[data-music-album="ar-x07"] [data-track="x07"]').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await bigNav('albums');
  await big.locator('[data-music-title]').getByText(/Albums · \d+/).waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await page.waitForFunction(() => document.querySelectorAll('#ParvaneMusic [data-music-albums] [data-id]').length >= 50,
    undefined, { timeout: STEP_TIMEOUT_MS });
  await big.locator('[data-music-more]').scrollIntoViewIfNeeded();
  await page.waitForFunction(() => document.querySelectorAll('#ParvaneMusic [data-music-albums] [data-id]').length >= 62,
    undefined, { timeout: STEP_TIMEOUT_MS });
  await big.getByRole('button', { name: 'Newest', exact: true }).click();
  await big.locator('[data-music-albums] [data-id]').first().getByText('Echo 60 — сингл').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  console.log('OK: синглы плиткой, альбомы — подгрузка страниц, «Новые»');

  // ── Пустая библиотека: главная по доске ───────────────────────────────────
  await fetch(`${LIBRARY_URL}?empty=1`);
  await page.waitForTimeout(1500);
  await reloadPage(page);
  const emptyMusic = await openMusic(page);
  await emptyMusic.locator('[data-music-empty="library"]').getByText('Find and download to the server')
    .waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await emptyMusic.locator('[data-music-empty="library"]').getByText(/The player appears in the side panel/)
    .waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await page.setViewportSize(PHONE);
  await emptyMusic.locator('[data-music-empty="library"]').getByText('No music on the server yet')
    .waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await page.setViewportSize(WIDE);
  console.log('OK: пустая библиотека — компьютер и телефон по доскам');

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
