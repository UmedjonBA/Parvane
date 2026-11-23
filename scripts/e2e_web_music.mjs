// Модуль «Музыка» по макету 23 ноя (`local-workdirs/design-music-2026-11-23/`). Библиотека — поддельный
// Subsonic-сервер за шардом music (`scripts/fake_subsonic.mjs`): два альбома, пять треков, первый трек длится 4
// секунды; каталог и скачивание — поддельный сервис `scripts/fake_music_fetch.mjs` (лимит раннера — три трека в
// сутки). Проверяется путь слушателя: компьютер — медиатека слева, главная («Для вас», «Новое на сервере»), «Микс
// дня», страница альбома, меню трека у курсора, плеер внизу (пауза, следующий, повтор, ♥), плеер во весь экран,
// «Любимое», поиск (сервер и каталог, чипы, «В очередь», «Добавлено вами» в очереди), виджет в чатах, очередь после
// перезагрузки; телефон — вкладки «Главная / Поиск / Медиатека», страницы исполнителя и альбома со своей шапкой,
// мини-плеер, плеер и очередь шторкой, поиск, звонок, шторка меню трека; «Найти и скачать» из каталога (уверенное
// совпадение, выбор файла в «Загрузках на сервер», лимит); «Добавлено мной» и удаление в корзину; плейлисты (окно
// «Новый плейлист», подменю «В плейлист ›», выбор плейлиста на телефоне, порядок, меню «Ещё»); трек и плейлист в
// чат; «Загруженное» группами (трек, альбом, плейлист следует за составом, без сети); длинные списки страницами,
// исполнитель и его выпуски; пустая библиотека.
// Запуск: scripts/run_web_music_e2e.sh
import assert from 'node:assert/strict';

import { chromium } from '../web/telegram-tt/node_modules/playwright/index.mjs';

import { checkMinimizedCallStrip, saveCallState } from './e2e_web_call_media.mjs';

import {
  LOGIN_TIMEOUT_MS,
  assertNoPageErrors,
  dismissRecoveryKeyDialog,
  dumpDiagJournal,
  preparePage,
  reloadPage,
} from './e2e_web_helpers.mjs';

const PASSWORD = 'Parvane-music-e2e-1';
const WIDE = { width: 1600, height: 900 };
const PHONE = { width: 390, height: 800 };
const STEP_TIMEOUT_MS = 20000;
const LIBRARY_URL = `http://127.0.0.1:${process.env.PARVANE_E2E_MUSIC_LIBRARY_PORT || 19431}/__e2e/library`;
// Треки поддельного каталога (`fake_music_fetch.mjs`): ссылка — `dz:<100 + номер>`
const CATALOG_BUS = 'dz:101';
const CATALOG_LOUD = 'dz:102';
const CATALOG_MORNING = 'dz:104';
const CATALOG_SLOW = 'dz:105';

// Звук без жеста пользователя: сценарий нажимает кнопки сам, но автозапуск в безголовом режиме надёжнее разрешить
const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
let session;

const visible = (locator, timeout = STEP_TIMEOUT_MS) => locator.waitFor({ state: 'visible', timeout });
const gone = (locator, timeout = STEP_TIMEOUT_MS) => locator.waitFor({ state: 'detached', timeout });

// Меню закрылось: на экране нет ни одного меню (закрытые меню чатов остаются в разметке скрытыми)
async function menuGone(page) {
  await page.waitForFunction(() => ![...document.querySelectorAll('[role="menu"]')]
    .some((menu) => menu.getClientRects().length), undefined, { timeout: STEP_TIMEOUT_MS });
}

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

// Меню трека (доска `RpMusicA`): «⋯» строки (либо правая кнопка, если «⋯» в строке нет) и пункт
async function openTrackMenu(row) {
  const dots = row.locator('[data-music-menu]');
  if (await dots.isVisible().catch(() => false)) await dots.click();
  else await row.click({ button: 'right' });
}

async function pickTrackAction(page, row, action) {
  await openTrackMenu(row);
  const menu = page.getByRole('menu').first();
  await menu.getByRole('menuitem', { name: action, exact: true }).click();
  await menuGone(page);
}

// Компьютер: «В плейлист ›» — подменю у курсора
async function addToPlaylist(page, row, playlistName) {
  await openTrackMenu(row);
  await page.getByRole('menuitem', { name: 'Add to a playlist', exact: true }).hover();
  const sub = page.locator('[data-music-submenu]');
  await sub.getByRole('menuitem', { name: playlistName, exact: true }).click();
  await gone(sub);
}

async function waitRows(page, list, expected) {
  await page.waitForFunction(([root, want]) => [...root.querySelectorAll('[data-track]')]
    .map((row) => row.dataset.track).join() === want, [await list.elementHandle(), expected.join()],
  { timeout: STEP_TIMEOUT_MS });
}

// Вход в «Музыку» с панели модулей (компьютер) либо с ленты (телефон) — открывается главная
async function openMusic(page) {
  const rail = page.locator('#FoldersSidebar');
  await rail.or(page.getByRole('navigation', { name: 'Modules' })).first()
    .waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  if (await rail.isVisible().catch(() => false)) await rail.getByRole('tab', { name: 'Music', exact: true }).click();
  else await page.getByRole('navigation', { name: 'Modules' }).getByRole('button', { name: 'Music' }).click();
  const music = page.locator('#ParvaneMusic');
  await visible(page.locator('#ParvaneMusic[data-music-enabled="true"]'), LOGIN_TIMEOUT_MS);
  return music;
}

// Что играет: плеер внизу «Музыки» (компьютер), виджет панели модулей (компьютер, другой модуль) либо мини-плеер
// (телефон) — смотрится тот, что на экране
async function waitPlaying(page, title, state) {
  await page.waitForFunction(([want, wantState]) => {
    const shown = ['[data-music-desk-player]', '#FoldersSidebar [data-music-widget]', '[data-music-mini]']
      .map((selector) => document.querySelector(selector))
      .find((element) => element && element.getClientRects().length);
    if (!shown) return false;
    const text = `${shown.textContent} ${shown.getAttribute('aria-label') || ''}`;
    const current = shown.dataset.musicDeskPlayer || shown.dataset.musicWidget || shown.dataset.musicMini;
    return text.includes(want) && (!wantState || current === wantState);
  }, [title, state], { timeout: STEP_TIMEOUT_MS });
}

// Пауза тем плеером, что на экране. Трек, только что выбранный на паузе, может заиграть чуть позже — тогда ещё раз
async function pause(page) {
  for (let attempt = 0; attempt < 3; attempt++) {
    await pauseOnce(page);
    await page.waitForTimeout(700);
    if (await isPaused(page)) return;
  }
  await waitPlaying(page, '', 'paused');
}

async function isPaused(page) {
  return page.evaluate(() => {
    const shown = ['[data-music-desk-player]', '#FoldersSidebar [data-music-widget]', '[data-music-mini]']
      .map((selector) => document.querySelector(selector))
      .find((element) => element && element.getClientRects().length);
    const current = shown && (shown.dataset.musicDeskPlayer || shown.dataset.musicWidget || shown.dataset.musicMini);
    return current === 'paused';
  });
}

async function pauseOnce(page) {
  const desk = page.locator('[data-music-desk-player]');
  if (await desk.isVisible().catch(() => false)) {
    if (await desk.getAttribute('data-music-desk-player') === 'playing') await desk.locator('[data-music-desk-play]').click();
  } else if (await page.locator('[data-music-mini]').isVisible().catch(() => false)) {
    const button = page.locator('[data-music-mini]').getByRole('button', { name: 'Pause', exact: true });
    if (await button.isVisible().catch(() => false)) await button.click();
  } else {
    const widget = page.locator('#FoldersSidebar [data-music-widget]');
    if (await widget.getAttribute('data-music-widget') === 'playing') {
      await widget.click();
      await page.locator('[data-music-popup-play]').click();
      await page.keyboard.press('Escape');
    }
  }
}

// Компьютер: альбом через поиск медиатеки (строка поиска главной)
async function openAlbumBySearch(music, text, albumId) {
  const field = music.locator('[data-music-desk-search]');
  if (!await field.isVisible().catch(() => false)) {
    await music.locator('[data-music-nav] [data-view="search"]').click();
  }
  await field.fill(text);
  await music.locator(`[data-music-albums] [data-id="${albumId}"]`).click();
  const album = music.locator('[data-music-album-page]');
  await visible(album.locator('[data-track]').first());
  return album;
}

try {
  const user = `music-${Date.now().toString(36)}@local`;
  const context = await browser.newContext({ viewport: WIDE });
  session = await preparePage(context, user, PASSWORD);
  const { page } = session;
  await dismissRecoveryKeyDialog(page).catch(() => undefined);

  // ── Главная компьютера: медиатека слева, «Для вас», «Новое на сервере», плеера ещё нет ─────
  let music = await openMusic(page);
  const navBar = music.locator('[data-music-nav]');
  const nav = (view) => navBar.locator(`[data-view="${view}"]`).first().click();
  await visible(music.locator('[data-music-mix="pick"]').getByText('Pick favorite artists'));
  await visible(music.locator('[data-music-fresh] [data-album="al-1"]'));
  await visible(music.locator('[data-music-fresh] [data-album="al-2"]'));
  for (const view of ['starred', 'offline', 'added']) await visible(navBar.locator(`[data-view="${view}"]`));
  await visible(music.locator('[data-music-desk-search]'));
  assert.equal(await page.locator('[data-music-desk-player]').count(), 0, 'пока ничего не играло, плеера внизу нет');
  assert.equal(await music.locator('h1').count(), 0, 'на компьютере у модуля нет своей шапки');
  assert.equal(await page.locator('#FoldersSidebar [data-music-widget]').count(), 0, 'виджета плеера в «Музыке» нет');
  console.log('OK: главная — медиатека слева, «Для вас», «Новое на сервере», поиск сверху');

  // ── «Микс дня»: выбрать исполнителей → микс из библиотеки и похожих из каталога ─────
  await music.locator('[data-music-mix]').click();
  const picker = music.locator('[data-music-mix-artists]');
  await picker.locator('[data-music-mix-artist="Kora Mesh"]').click();
  await visible(picker.getByText('Chosen 1 of 20'));
  await picker.locator('[data-music-mix-artists-done]').click();
  music = await openMusic(page);
  await visible(music.locator('[data-music-mix="ready"]'), STEP_TIMEOUT_MS * 2);
  await music.locator('[data-music-mix]').click();
  const mixView = music.locator('[data-music-mix-view="ready"]');
  await visible(mixView);
  await visible(mixView.locator('[data-music-mix-catalog]').filter({ hasText: 'like Kora Mesh' }).first());
  assert(await mixView.locator('[data-music-mix-play]').isEnabled(), '«Слушать» — есть треки библиотеки');
  console.log('OK: «Микс дня» — выбор исполнителей, микс из библиотеки и похожих из каталога');

  // ── Альбом: страница, меню трека у курсора, воспроизведение ──────────────
  music = await openMusic(page);
  await music.locator('[data-music-fresh] [data-album="al-1"]').click();
  const album = music.locator('[data-music-album-page]');
  await visible(album.getByRole('heading', { name: 'Берег' }));
  const tracks = album.locator('[data-music-tracks]');
  await visible(tracks.locator('[data-track]').nth(2));
  assert.equal(await tracks.locator('[data-track]').count(), 3, 'в альбоме три трека');
  await visible(album.getByRole('button', { name: /Тихий порт/ }).first());
  // Правая кнопка — меню у курсора: сначала быстрые действия (доска `RpMusicA`), потом остальное
  await tracks.locator('[data-track="t2"]').click({ button: 'right' });
  const deskMenu = page.getByRole('menu').first();
  await visible(deskMenu.getByRole('menuitem', { name: 'Download to this computer' }));
  const deskItems = await deskMenu.getByRole('menuitem').evaluateAll((items) => items.map((item) => item.getAttribute('aria-label')));
  assert.deepEqual(deskItems, ['To favorites', 'Add to a playlist', 'Add to queue', 'Share', 'Send to chat…',
    'Go to artist', 'Go to album', 'Download to this computer', "Don't like", 'File…'],
  `меню у курсора по доске RpMusicA: ${deskItems}`);
  await page.keyboard.press('Escape');
  await menuGone(page);
  await tracks.locator('[data-track="t1"]').getByRole('button').first().click();
  await waitPlaying(page, 'Северный ветер', 'playing');
  console.log('OK: альбом — страница, исполнитель ссылкой, меню у курсора, трек играет в плеере внизу');

  // ── Трек доигран сам — играет следующий по очереди ────────────────────────
  await waitPlaying(page, 'Harbor Lights', 'playing');
  await visible(tracks.locator('[data-track="t2"][data-music-current]'));
  console.log('OK: после конца трека играет следующий');

  // ── Плеер внизу: пауза, следующий, повтор, ♥; плеер во весь экран ────────
  const deskPlayer = page.locator('[data-music-desk-player]');
  await deskPlayer.getByRole('button', { name: 'Pause', exact: true }).click();
  await visible(page.locator('[data-music-desk-player="paused"]'));
  await deskPlayer.getByRole('button', { name: 'Next track' }).click();
  await waitPlaying(page, 'Соль');
  await pause(page);
  await deskPlayer.getByRole('button', { name: 'Repeat: off' }).click();
  await visible(deskPlayer.locator('[data-music-repeat="all"]'));
  await deskPlayer.getByRole('button', { name: 'Add to favorites' }).click();
  await visible(deskPlayer.getByRole('button', { name: 'Remove from favorites' }));
  await deskPlayer.getByRole('button', { name: 'Open player' }).click();
  const full = page.locator('[data-music-full]');
  await visible(full.getByRole('heading', { name: 'Соль' }));
  await visible(full.locator('[data-music-source="album"]').getByText('Playing from an album'));
  await full.getByRole('button', { name: 'Collapse player' }).click();
  await gone(full);
  console.log('OK: плеер внизу — пауза, следующий, повтор, «В любимое»; плеер во весь экран с источником');

  // ── Любимое ───────────────────────────────────────────────────────────────
  await page.waitForTimeout(1000);
  await nav('starred');
  await visible(music.locator('[data-music-view="starred"] [data-track="t3"]'));
  assert.equal(await music.locator('[data-music-view="starred"] [data-track]').count(), 1, 'в любимом один трек');
  await visible(music.getByPlaceholder('Find in favorites'));
  await visible(music.locator('[data-music-starred-note]'));
  console.log('OK: любимое — трек, поиск по любимому, подсказка');

  // ── Поиск: сервер и каталог, чипы, «В очередь», к альбому, пустой результат ─
  await nav('search');
  const deskSearch = music.locator('[data-music-desk-search]');
  await deskSearch.fill('glass');
  const searchView = music.locator('[data-music-view="search"]');
  const found = searchView.locator('[data-music-tracks] [data-track="t4"]');
  await visible(found);
  await pickTrackAction(page, found, 'Add to queue');
  await visible(page.getByText('“Glass Harbor” plays next').first());
  await searchView.locator('[data-filter="albums"]').click();
  await gone(searchView.locator('[data-music-tracks]'));
  await searchView.locator('[data-filter="all"]').click();
  await pickTrackAction(page, found, 'Go to album');
  await visible(music.locator('[data-music-album-page] [data-track="t4"]'));
  await nav('search');
  await deskSearch.fill('нет такого');
  await visible(music.locator('[data-music-empty="search"]').getByText('Nothing found for “нет такого”'));
  await deskSearch.fill('');
  // Очередь (кнопка плеера внизу): «Сейчас играет», «Добавлено вами» и остаток альбома
  await deskPlayer.locator('[data-music-desk-queue]').click();
  const queue = music.locator('[data-music-view="queue"]');
  await visible(queue.locator('[data-music-queue-added="1"] [data-track="t4"]'));
  await visible(queue.locator('[data-track="t3"][data-music-current]'));
  assert.deepEqual(await queue.locator('[data-track]').evaluateAll((rows) => rows.map((row) => row.dataset.track)),
    ['t3', 't4'], 'очередь: играющий, затем добавленный');
  console.log('OK: поиск — сервер и каталог, чипы, «В очередь», к альбому, пустой результат; очередь');

  // ── «Очистить» добавленное: очередь возвращается к альбому ───────────────
  await queue.locator('[data-music-queue-clear]').click();
  await gone(queue.locator('[data-music-queue-added]'));
  await deskPlayer.locator('[data-music-desk-queue]').click();
  await gone(queue);
  console.log('OK: очередь — «Очистить» убирает добавленное вами');

  // ── «+» модуля: «Найти в каталоге», «Новый плейлист» ──────────────────────
  const plus = page.locator('#FoldersSidebar [data-add-for="music"]');
  await plus.click();
  await page.getByRole('menuitem', { name: /Find in the catalog/ }).click();
  await visible(music.locator('[data-music-view="search"]'));
  // «Найти в каталоге» ставит курсор в поле
  await page.waitForFunction(() => document.activeElement?.matches('[data-music-desk-search]'), undefined,
    { timeout: STEP_TIMEOUT_MS });
  await plus.click();
  await page.getByRole('menuitem', { name: /New playlist/ }).click();
  const newPlaylist = page.locator('[data-music-new-playlist-form]');
  await visible(newPlaylist);
  await newPlaylist.getByRole('button', { name: 'Cancel' }).click();
  await gone(newPlaylist);
  console.log('OK: «+» в «Музыке» — «Найти в каталоге» и «Новый плейлист»');

  // ── Плеер вне модуля: виджет в боковой панели ─────────────────────────────
  await page.locator('#FoldersSidebar').getByRole('tab', { name: 'Chats' }).click();
  const widget = page.locator('#FoldersSidebar [data-music-widget]');
  // Нажатие на виджет — окошко плеера рядом: трек, управление, «Очередь», «Открыть «Музыку»»; Escape его закрывает
  await widget.click();
  const popup = page.locator('[data-music-popup]');
  await visible(popup.getByText('Соль').first());
  await visible(popup.locator('[data-music-popup-open]'));
  await page.keyboard.press('Escape');
  await gone(popup);
  // «Очередь» окошка открывает «Музыку» с плеером во весь экран
  await widget.click();
  await popup.locator('[data-music-popup-queue]').click();
  await gone(popup);
  await visible(full.getByRole('heading', { name: 'Соль' }));
  // Кнопка «Играть / Пауза» плеера во весь экран: два нажатия возвращают прежнее состояние
  const playState = await full.locator('[data-music-play]').getAttribute('data-music-play');
  const otherState = playState === 'playing' ? 'paused' : 'playing';
  await full.locator('[data-music-play]').click();
  await visible(full.locator(`[data-music-play="${otherState}"]`));
  await full.locator('[data-music-play]').click();
  await visible(full.locator(`[data-music-play="${playState}"]`));
  await pause(page);
  await full.locator('[data-music-player-menu]').click();
  await page.getByRole('menuitem', { name: 'Send to chat…', exact: true }).click();
  // «Кому отправить» (доска `RpPick`): карточка «название · исполнитель · трек», чаты с галочками
  const sendScreen = page.locator('.Modal').filter({ has: page.locator('[data-send-picker]') });
  await visible(sendScreen.locator('[data-send-preview]').getByText('Соль'));
  await visible(sendScreen.locator('[data-send-row]').filter({ hasText: 'Saved Messages' }).first());
  await page.keyboard.press('Escape');
  await sendScreen.waitFor({ state: 'hidden' });
  const slider = full.getByRole('slider');
  await slider.press('Home');
  await slider.press('ArrowRight');
  await visible(full.locator('[data-music-position]').filter({ hasText: /^0:01$/ }));
  await full.getByRole('button', { name: 'Collapse player' }).click();
  await gone(full);
  await visible(music.locator('[data-music-nav]'));
  console.log('OK: виджет — окошко плеера, «Очередь» открывает плеер, пауза, перемотка, «в чат»');

  // ── Перезагрузка: очередь возвращается на паузе с того же трека ───────────
  await reloadPage(page);
  music = await openMusic(page);
  await waitPlaying(page, 'Соль', 'paused');
  await visible(page.locator('[data-music-desk-player] [data-music-repeat="all"]'));
  await page.locator('[data-music-desk-player] [data-music-desk-queue]').click();
  await visible(music.locator('[data-music-view="queue"] [data-track="t3"][data-music-current]'));
  await page.locator('[data-music-desk-player] [data-music-desk-queue]').click();
  console.log('OK: очередь, играющий трек и повтор пережили перезагрузку');

  // ── Телефон: вкладки, медиатека, страницы исполнителя и альбома, мини-плеер ─
  await page.setViewportSize(PHONE);
  await page.waitForTimeout(800);
  const ribbon = page.getByRole('navigation', { name: 'Modules' });
  const phone = await openMusic(page);
  const mini = page.locator('[data-music-mini]');
  await visible(mini);
  await page.locator('[data-add-for="music"]').click();
  await visible(page.getByRole('menuitem', { name: /Find in the catalog/ }));
  await visible(page.getByRole('menuitem', { name: /New playlist/ }));
  await page.keyboard.press('Escape');
  const tab = (value) => phone.locator(`[role="tab"][data-view="${value}"]`);
  for (const value of ['home', 'search', 'library']) await visible(tab(value));
  await visible(phone.locator('[data-music-quick]'));
  await tab('library').click();
  const library = phone.locator('[data-music-library]');
  for (const row of ['starred', 'offline', 'added', 'mix']) await visible(library.locator(`[data-view="${row}"]`));
  await library.locator('[data-tab="artists"]').click();
  await library.locator('[data-music-library-artists] [data-artist="ar-1"]').click();
  // Страница поверх ленты: своя шапка с «назад», лента модулей скрыта, мини-плеер внизу
  const artistPage = phone.locator('[data-music-artist-page]');
  await visible(artistPage.getByRole('heading', { name: 'Тихий порт' }));
  await visible(phone.locator('[data-music-back]'));
  await gone(ribbon);
  await visible(mini);
  await artistPage.locator('[data-music-albums] [data-id="al-1"]').click();
  const phoneAlbum = phone.locator('[data-music-album-page] [data-music-tracks]');
  await phoneAlbum.locator('[data-track="t1"]').getByRole('button').first().click();
  // Первый трек короткий (4 с): пауза сразу, чтобы очередь стояла на нём
  await mini.getByRole('button', { name: 'Pause', exact: true }).click();
  await visible(page.locator('[data-music-mini="paused"]'));
  // Плеер телефона: «Играет из альбома», «Далее» и очередь шторкой
  await mini.getByRole('button', { name: 'Open player' }).click();
  await visible(full.getByRole('heading', { name: 'Северный ветер' }));
  await visible(full.locator('[data-music-source="album"]').getByText('Playing from an album'));
  await full.locator('[data-music-open-queue]').click();
  const queueSheet = full.locator('[data-music-queue-sheet]');
  await waitRows(page, queueSheet, ['t1', 't2', 't3']);
  await queueSheet.getByRole('button', { name: 'Close' }).click();
  await gone(queueSheet);
  await full.getByRole('button', { name: 'Collapse player' }).click();
  await gone(full);
  console.log('OK: телефон — медиатека, исполнитель, альбом, мини-плеер, плеер и очередь шторкой');
  await phone.locator('[data-music-back]').click();
  await phone.locator('[data-music-back]').click();
  await visible(ribbon);
  // «Поиск»: поле, сервер, чипы, каталог
  await tab('search').click();
  const phoneField = phone.locator('[data-music-search]').getByRole('searchbox');
  await phoneField.fill('harbor');
  await visible(phone.locator('[data-music-tracks] [data-track="t2"]'));
  await visible(phone.locator('[data-music-tracks] [data-track="t4"]'));
  await phone.locator('[data-filter="albums"]').click();
  await gone(phone.locator('[data-music-tracks]'));
  await phone.locator('[data-filter="all"]').click();
  // Трек каталога, которого нет на сервере; чип «Исполнители» ищет по исполнителю — трека там нет
  await phoneField.fill('медленный берег');
  const slowRow = phone.locator(`[data-catalog-track="${CATALOG_SLOW}"]`);
  await visible(slowRow);
  await phone.locator('[data-filter="artists"]').click();
  await gone(slowRow);
  await phone.locator('[data-filter="all"]').click();
  const phoneOverflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  assert.ok(phoneOverflow <= 0, `горизонтальное переполнение поиска на телефоне: ${phoneOverflow}`);
  await phoneField.fill('');
  await tab('home').click();
  console.log('OK: телефон — вкладки, поиск по серверу и каталогу, чипы');

  await ribbon.getByRole('button', { name: 'Chats' }).click();
  await visible(mini);
  const [miniBox, ribbonBox, addBox] = [await mini.boundingBox(), await ribbon.boundingBox(),
    await page.locator('[data-add-for="chats"]').boundingBox()];
  // Мини-плеер — карточка над лентой с небольшим зазором (доска `MusicHome`)
  const isAbove = (box, below) => box.y + box.height <= below.y && below.y - box.y - box.height <= 12;
  assert.ok(isAbove(miniBox, ribbonBox), `мини-плеер не над лентой: ${JSON.stringify({ miniBox, ribbonBox })}`);
  assert.ok(addBox.y + addBox.height <= miniBox.y, `«+» перекрывает полосу плеера: ${JSON.stringify({ addBox, miniBox })}`);
  // «Open player» тоже содержит «Play» — имя кнопки точное
  const playOrPause = mini.getByRole('button', { name: 'Play', exact: true });
  if (await playOrPause.isVisible().catch(() => false)) await playOrPause.click();
  await visible(page.locator('[data-music-mini="playing"]'));
  // Состояние звонка подаём через тот же вход, что у контроллера. Сам плеер воспроизводит тестовый трек
  await page.evaluate(() => {
    window.parvaneCall = { state: 'active', peerName: 'Лена' };
    window.dispatchEvent(new Event('parvane-call'));
  });
  const minimize = page.getByRole('button', { name: 'Minimize call', exact: true });
  await visible(minimize);
  // Музыка встаёт на паузу с началом разговора, а не при сворачивании
  await page.waitForFunction(() => document.querySelector('[data-music-mini]')?.getAttribute('data-music-mini')
    === 'paused', undefined, { timeout: STEP_TIMEOUT_MS });
  await minimize.click();
  const strip = await checkMinimizedCallStrip(page);
  await visible(page.locator('[data-music-mini="paused"]'));
  const [stripBox, pausedBox, currentRibbonBox] = await Promise.all([
    strip.boundingBox(), mini.boundingBox(), ribbon.boundingBox(),
  ]);
  assert.ok(stripBox.y + stripBox.height < pausedBox.y, 'Плашка звонка должна оставаться вверху');
  assert.ok(isAbove(pausedBox, currentRibbonBox), 'Мини-плеер должен быть над лентой');
  await saveCallState(page, 'minimized-music');
  await strip.click();
  await visible(minimize);
  assert.equal(await mini.getAttribute('data-music-mini'), 'paused', 'Возврат к звонку не возобновляет музыку сам');
  await page.evaluate(() => {
    window.parvaneCall = { state: 'ended' };
    window.dispatchEvent(new Event('parvane-call'));
  });
  await gone(minimize);
  console.log('OK: звонок ставит музыку на паузу, плашка звонка вверху, мини-плеер над лентой');

  await mini.getByRole('button', { name: 'Open player' }).click();
  await visible(full.locator('h2').first());
  await gone(ribbon);
  await full.getByRole('button', { name: 'Collapse player' }).click();
  await gone(full);
  await visible(ribbon);
  await visible(mini);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  assert.ok(overflow <= 0, `горизонтальное переполнение на телефоне: ${overflow}`);
  console.log('OK: телефон — плеер поверх ленты и возврат ленты');

  // Телефон: меню трека — шторка снизу с обложкой, быстрые действия кругами (доска `RpMusicA`)
  const phoneMusic = await openMusic(page);
  await phoneMusic.locator('[data-music-fresh] [data-album="al-1"]').click();
  const phoneRow = phoneMusic.locator('[data-music-album-page] [data-track="t2"]');
  await phoneRow.locator('[data-music-menu]').click();
  const sheetMenu = page.locator('.Modal [role="menu"]');
  await visible(sheetMenu.getByRole('menuitem', { name: 'Go to artist', exact: true }));
  const sheetItems = await sheetMenu.getByRole('menuitem').evaluateAll((items) => items.map((item) => item.getAttribute('aria-label')));
  assert.deepEqual(sheetItems, ['Send to chat', 'Go to artist', 'Go to album', 'Download to phone', "Don't like", 'File…'],
    `пункты шторки по доске RpMusicA: ${sheetItems}`);
  const quickActions = await page.locator('.Modal [role="group"] [data-action]').evaluateAll((items) => items.map((item) => item.dataset.action));
  assert.deepEqual(quickActions, ['star', 'playlist', 'next', 'share'], `быстрые действия шторки: ${quickActions}`);
  if (process.env.PARVANE_E2E_SHOT_DIR) {
    await page.screenshot({ path: `${process.env.PARVANE_E2E_SHOT_DIR}/music-track-menu-phone.png` });
  }
  const sheetOverflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  assert.ok(sheetOverflow <= 0, `горизонтальное переполнение со шторкой меню: ${sheetOverflow}`);
  assert.equal(await page.locator('.Modal').getByRole('button', { name: 'Close' }).count(), 0, 'у шторки трека крестика нет');
  await page.keyboard.press('Escape');
  await gone(sheetMenu);
  console.log('OK: телефон — меню трека шторкой по доске');

  // ── «Найти и скачать» из каталога: уверенное совпадение качается само ─────
  await page.setViewportSize(WIDE);
  await page.waitForTimeout(800);
  const wide = await openMusic(page);
  const wideNav = (view) => wide.locator(`[data-music-nav] [data-view="${view}"]`).first().click();
  await pause(page).catch(() => undefined);
  const searchCatalog = async (text, ref) => {
    await wideNav('search');
    await wide.locator('[data-music-desk-search]').fill(text);
    const row = wide.locator(`[data-catalog-track="${ref}"]`);
    await visible(row);
    return row;
  };
  const bus = await searchCatalog('автобус', CATALOG_BUS);
  await bus.locator('[data-catalog-add]').click();
  // Скачанное перечитывает поиск: трек — уже строкой сервера
  const busTrack = wide.locator('[data-music-tracks] [data-track]').filter({ hasText: 'Ночной автобус' });
  await visible(busTrack, STEP_TIMEOUT_MS * 2);
  await gone(bus);
  await busTrack.getByRole('button').first().click();
  await waitPlaying(page, 'Ночной автобус', 'playing');
  await pause(page);
  console.log('OK: трек каталога добавлен на сервер без вопросов и играет');

  // ── Трек, который уже есть в библиотеке, в каталоге не повторяется ────────
  await wide.locator('[data-music-desk-search]').fill('glass');
  await visible(wide.locator('[data-music-tracks] [data-track="t4"]'));
  await page.waitForTimeout(1000);
  assert.equal(await wide.locator('[data-catalog-track]').filter({ hasText: 'Glass Harbor' }).count(), 0,
    'трек библиотеки не предлагается из каталога');
  console.log('OK: трек библиотеки не повторяется строкой каталога');

  // ── Спорное совпадение: нужна версия без цензуры, известной нет — выбор файла в «Загрузках» ─
  const loud = await searchCatalog('громкая', CATALOG_LOUD);
  await loud.locator('[data-catalog-add]').click();
  await visible(wide.locator(`[data-catalog-track="${CATALOG_LOUD}"][data-catalog-state="choice"]`), STEP_TIMEOUT_MS * 2);
  await loud.locator('[data-catalog-choose]').click();
  const candidates = wide.locator('[data-music-uploads] [data-fetch-candidates]');
  await visible(candidates);
  assert.equal(await candidates.getByRole('button', { name: 'This one' }).count(), 2, 'в списке два файла');
  await candidates.getByRole('button', { name: 'This one' }).first().click();
  await gone(candidates, STEP_TIMEOUT_MS * 2);
  console.log('OK: спорное совпадение скачано после выбора файла в «Загрузках на сервер»');

  // ── Лимит: три трека в сутки ──────────────────────────────────────────────
  const morning = await searchCatalog('утро', CATALOG_MORNING);
  await morning.locator('[data-catalog-add]').click();
  await visible(wide.locator('[data-music-tracks] [data-track]').filter({ hasText: 'Утро' }), STEP_TIMEOUT_MS * 2);
  await wide.locator('[data-music-desk-search]').fill('');
  console.log('OK: три трека за сутки скачаны');

  // ── «Добавлено мной»: свои треки, расход, удаление в корзину ─────────────
  await wideNav('added');
  const mine = wide.locator('[data-music-added="mine"]');
  await visible(mine.locator('[data-track]').nth(2));
  await visible(wide.locator('[data-music-usage]').getByText(/Today 3 of 3/));
  await openTrackMenu(mine.locator('[data-track]').filter({ hasText: 'Утро' }));
  await page.getByRole('menuitem', { name: 'File…', exact: true }).hover();
  await page.locator('[data-music-submenu]').getByRole('menuitem', { name: 'Delete from server', exact: true }).click();
  await page.getByRole('button', { name: 'Move to trash', exact: true }).click();
  await visible(page.getByText('In the trash — you can restore it for 30 days').first());
  await gone(mine.locator('[data-track]').nth(2));
  console.log('OK: «Добавлено мной» — расход за сутки, удаление в корзину');

  // ── Плейлисты: окно «Новый плейлист», подменю «В плейлист ›» ──────────────
  const playlistsNav = wide.locator('[data-music-nav] [data-view="playlist"]');
  await plus.click();
  await page.getByRole('menuitem', { name: /New playlist/ }).click();
  const createForm = page.locator('[data-music-new-playlist-form]');
  await createForm.getByPlaceholder('for example: For the road').fill('Дорога');
  // Играющий трек предлагается добавить сразу — здесь плейлист создаётся пустым
  await createForm.locator('[data-music-add-current][aria-checked="true"]').click();
  await visible(createForm.locator('[data-music-add-current][aria-checked="false"]'));
  await createForm.getByRole('button', { name: 'Create', exact: true }).click();
  const opened = wide.locator('[data-music-playlist]');
  await visible(opened.locator('[data-music-empty]'));
  const roadAlbum = await openAlbumBySearch(wide, 'Берег', 'al-1');
  const albumRow = (id) => roadAlbum.locator(`[data-track="${id}"]`);
  await addToPlaylist(page, albumRow('t1'), 'Дорога');
  await visible(page.getByText('Added to “Дорога”').first());
  await addToPlaylist(page, albumRow('t3'), 'Дорога');
  await addToPlaylist(page, albumRow('t1'), 'Дорога');
  await visible(page.getByText('This track is already in the playlist').first());
  // Новый плейлист из подменю — окно с «Сразу добавить «трек»»
  await addToPlaylist(page, albumRow('t2'), 'New…');
  await visible(createForm.locator('[data-music-add-current][aria-checked="true"]'));
  await createForm.getByPlaceholder('for example: For the road').fill('Вечер');
  await createForm.getByRole('button', { name: 'Create', exact: true }).click();
  await visible(page.getByText('Playlist “Вечер” created').first());
  // Телефон: «В плейлист» быстрым действием шторки — выбор плейлиста; где трек уже есть — помечено
  await page.setViewportSize(PHONE);
  await albumRow('t1').locator('[data-music-menu]').click();
  await page.locator('.Modal [role="group"] [data-action="playlist"]').click();
  const pickSheet = page.locator('[data-playlist-picker]');
  await visible(pickSheet);
  await pickSheet.locator('[data-playlist]').filter({ hasText: 'Вечер' }).click();
  await pickSheet.locator('[data-picker-done]').click();
  await gone(pickSheet);
  await page.setViewportSize(WIDE);
  await visible(playlistsNav.filter({ hasText: 'Дорога' }).filter({ hasText: /\b2\b/ }));
  await visible(playlistsNav.filter({ hasText: 'Вечер' }).filter({ hasText: /\b2\b/ }));
  console.log('OK: плейлисты — окно «Новый плейлист», подменю, выбор на телефоне, плейлисты в медиатеке');

  // ── Страница плейлиста: порядок, «Играть», убрать, переименовать ─────────
  await playlistsNav.filter({ hasText: 'Дорога' }).click();
  const waitOrder = async (expected) => {
    await page.waitForFunction((want) => {
      const rows = [...document.querySelectorAll('#ParvaneMusic [data-music-playlist] [data-track]')];
      return rows.map((row) => row.dataset.track).join() === want;
    }, expected.join(), { timeout: STEP_TIMEOUT_MS });
  };
  await waitOrder(['t1', 't3']);
  await dragRow(page, opened, 't1', 't3');
  await waitOrder(['t3', 't1']);
  await opened.locator('[data-music-play-all]').click();
  await waitPlaying(page, 'Соль', 'playing');
  await pause(page);
  await pickTrackAction(page, opened.locator('[data-track="t3"]'), 'Remove from the playlist');
  await waitOrder(['t1']);
  await opened.locator('[data-music-playlist-menu]').click();
  await page.getByRole('menuitem', { name: 'Rename', exact: true }).click();
  await page.locator('[data-music-playlist-name]').fill('В дорогу');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await visible(playlistsNav.filter({ hasText: 'В дорогу' }));
  console.log('OK: страница плейлиста — порядок, «Играть», «Убрать из плейлиста», «Переименовать»');

  // ── Перезагрузка: плейлисты на месте; удаление плейлиста с вопросом ───────
  await page.waitForTimeout(3000);
  await reloadPage(page);
  const again = await openMusic(page);
  const lists = again.locator('[data-music-nav] [data-view="playlist"]');
  await visible(lists.filter({ hasText: 'В дорогу' }), LOGIN_TIMEOUT_MS);
  await lists.filter({ hasText: 'Вечер' }).click();
  await visible(again.locator('[data-music-playlist] [data-track="t2"]'));
  await again.locator('[data-music-playlist-menu]').click();
  await page.getByRole('menuitem', { name: 'Delete playlist', exact: true }).click();
  await page.locator('[data-playlist-delete="confirm"]').click();
  await gone(lists.filter({ hasText: 'Вечер' }));
  assert.equal(await lists.count(), 1, 'после удаления остался один плейлист');
  console.log('OK: плейлисты пережили перезагрузку, плейлист удалён');

  // ── Трек в чат: карточка в «Избранном», из неё трек играет ────────────────
  const chatAlbum = await openAlbumBySearch(await openMusic(page), 'Берег', 'al-1');
  await pickTrackAction(page, chatAlbum.locator('[data-track="t2"]'), 'Send to chat…');
  const trackSend = page.locator('.Modal').filter({ has: page.locator('[data-send-picker]') });
  await trackSend.locator('[data-send-row]').filter({ hasText: 'Saved Messages' }).first()
    .locator('input[type="checkbox"]').check();
  await trackSend.locator('[data-send-submit]').click();
  await visible(page.getByText('Track sent'));
  await page.locator('#FoldersSidebar').getByRole('tab', { name: 'Chats' }).click();
  await page.locator('#LeftColumn .chat-list').getByText('Saved Messages').first().click();
  const card = page.locator('[data-music-track-card="t2"]');
  await visible(card.getByText('Harbor Lights'));
  await visible(card.getByText('Server music'));
  // Телефон: карточка трека во всю ширину ленты, без переполнения (доска `MusicChat`)
  await page.setViewportSize(PHONE);
  await visible(card);
  const cardOverflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  assert.ok(cardOverflow <= 0, `карточка трека переполняет телефон: ${cardOverflow}`);
  if (process.env.PARVANE_E2E_SHOT_DIR) {
    await page.waitForTimeout(600);
    await page.screenshot({ path: `${process.env.PARVANE_E2E_SHOT_DIR}/music-chat-track-phone.png` });
  }
  await page.setViewportSize(WIDE);
  await visible(page.locator('#LeftColumn .chat-list').getByText(/Track: .*Harbor Lights/).first());
  await card.getByRole('button', { name: 'Play track', exact: true }).click();
  await waitPlaying(page, 'Harbor Lights', 'playing');
  console.log('OK: трек отправлен в чат карточкой и играет из неё');

  // ── Плейлист в чат: карточка, «Открыть», «Сохранить к себе», «Слушать» ────
  const backInMusic = await openMusic(page);
  await pause(page);
  await backInMusic.locator('[data-music-nav] [data-view="playlist"]').filter({ hasText: 'В дорогу' }).click();
  await backInMusic.locator('[data-music-playlist] [data-music-playlist-to-chat]').first().click();
  const playlistSend = page.locator('.Modal').filter({ has: page.locator('[data-send-picker]') });
  await playlistSend.locator('[data-send-row]').filter({ hasText: 'Saved Messages' }).first()
    .locator('input[type="checkbox"]').check();
  await playlistSend.locator('[data-send-submit]').click();
  await visible(page.getByText('Playlist sent'));
  await page.locator('#FoldersSidebar').getByRole('tab', { name: 'Chats' }).click();
  await page.locator('#LeftColumn .chat-list').getByText('Saved Messages').first().click();
  const playlistCard = page.locator('[data-music-playlist-card="В дорогу"]');
  await visible(playlistCard.getByText('Северный ветер'));
  await visible(playlistCard.getByText(/^1 track/));
  if (process.env.PARVANE_E2E_SHOT_DIR) {
    await page.setViewportSize(PHONE);
    await page.waitForTimeout(800);
    await page.screenshot({ path: `${process.env.PARVANE_E2E_SHOT_DIR}/music-chat-cards-phone.png` });
    await page.setViewportSize(WIDE);
    await page.waitForTimeout(800);
  }
  await playlistCard.getByRole('button', { name: 'Open', exact: true }).click();
  const sharedSheet = page.locator('[data-music-playlist-sheet]');
  await visible(sharedSheet.locator('[data-track="t1"]').getByText('Северный ветер'));
  await sharedSheet.getByRole('button', { name: 'Save to my playlists' }).click();
  await visible(page.getByText('Playlist saved to your playlists'));
  await gone(sharedSheet);
  await playlistCard.getByRole('button', { name: 'Listen', exact: true }).click();
  await waitPlaying(page, 'Северный ветер');
  await openMusic(page);
  await pause(page).catch(() => undefined);
  await visible(backInMusic.locator('[data-music-nav] [data-view="playlist"]').filter({ hasText: 'В дорогу' }).nth(1));
  console.log('OK: плейлист отправлен в чат карточкой, открыт, сохранён к себе и играет');

  // ── «Загруженное»: группы, один трек и альбом на устройстве, без сети ─────
  const offNav = (view) => backInMusic.locator(`[data-music-nav] [data-view="${view}"]`).first().click();
  await offNav('offline');
  await visible(backInMusic.locator('[data-music-offline="0"] [data-music-empty]'));
  let offAlbum = await openAlbumBySearch(await openMusic(page), 'Берег', 'al-1');
  await visible(offAlbum.locator('[data-track="t2"][data-music-offline-track="none"]'));
  if (process.env.PARVANE_E2E_SHOT_DIR) {
    await offAlbum.locator('[data-track="t2"] [data-music-menu]').click();
    await visible(page.getByRole('menu').first());
    await page.screenshot({ path: `${process.env.PARVANE_E2E_SHOT_DIR}/music-track-menu-desk.png` });
    await page.keyboard.press('Escape');
    await menuGone(page);
  }
  await pickTrackAction(page, offAlbum.locator('[data-track="t2"]'), 'Download to this computer');
  await visible(offAlbum.locator('[data-track="t2"][data-music-offline-track="saved"]'), STEP_TIMEOUT_MS * 2);
  await offNav('offline');
  await visible(backInMusic.locator('[data-music-offline="1"] [data-offline-group="tracks:"]'));
  console.log('OK: один трек загружен на устройство из меню трека — «Отдельные треки»');
  offAlbum = await openAlbumBySearch(await openMusic(page), 'Берег', 'al-1');
  await offAlbum.getByRole('button', { name: 'More', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Download to this computer', exact: true }).click();
  await offNav('offline');
  await visible(backInMusic.locator('[data-music-offline="3"]'), STEP_TIMEOUT_MS * 2);
  await visible(backInMusic.locator('[data-offline-usage]').getByText(/3 tracks · .* of 1 GB on this device/));
  const albumGroup = backInMusic.locator('[data-offline-group="album:al-1"]');
  await visible(albumGroup.getByText('album · 3 tracks'));
  await albumGroup.locator('[data-group]').first().click();
  // Оболочка приложения в кэше сервис-воркера целиком — для перезагрузки без сети ниже (PWA)
  await page.locator('html[data-app-shell]').waitFor({ state: 'attached', timeout: STEP_TIMEOUT_MS * 6 });
  await context.setOffline(true);
  await visible(backInMusic.locator('[data-offline-bar]'));
  await albumGroup.locator('[data-track="t3"]').getByRole('button').first().click();
  await waitPlaying(page, 'Соль', 'playing');
  await pause(page);
  console.log('OK: альбом загружен на устройство одной группой и играет без сети');

  // ── Приложение запущено без сети: «Загруженное» на месте и играет ─────────
  await reloadPage(page);
  const offlineMusic = await openMusic(page);
  await offlineMusic.locator('[data-music-nav] [data-view="offline"]').click();
  await visible(offlineMusic.locator('[data-music-offline="3"]'));
  const offlineGroup = offlineMusic.locator('[data-offline-group="album:al-1"]');
  await offlineGroup.locator('[data-group]').first().click();
  await offlineGroup.locator('[data-track="t1"]').getByRole('button').first().click();
  await waitPlaying(page, 'Северный ветер', 'playing');
  await pause(page);
  await context.setOffline(false);
  await gone(offlineMusic.locator('[data-offline-bar]'), STEP_TIMEOUT_MS * 3);
  console.log('OK: запуск без сети — «Загруженное» открывается и играет');
  await pickTrackAction(page, offlineGroup.locator('[data-track="t3"]'), 'Remove from this device');
  await visible(offlineMusic.locator('[data-music-offline="2"]'));
  await offlineMusic.locator('[data-offline-clear="ask"]').click();
  await offlineMusic.locator('[data-offline-clear="confirm"]').click();
  await visible(offlineMusic.locator('[data-music-offline="0"]'));
  console.log('OK: загруженное убирается по одному и целиком');

  // ── Загруженный плейлист следует за составом: новое докачивается, убранное стирается ─
  let plAlbum = await openAlbumBySearch(await openMusic(page), 'Берег', 'al-1');
  await addToPlaylist(page, plAlbum.locator('[data-track="t3"]'), 'New…');
  await createForm.getByPlaceholder('for example: For the road').fill('Офлайн');
  await createForm.getByRole('button', { name: 'Create', exact: true }).click();
  await gone(createForm);
  const toastsAfterCreate = await page.locator('.Notification').allInnerTexts().catch(() => []);
  const offList = offlineMusic.locator('[data-music-playlist]');
  // Под нагрузкой плейлист однажды не появился в медиатеке после закрытия окна: тогда — состояние плейлистов,
  // уведомление и журнал диагностики, чтобы было видно, создан ли он
  const offlineListNav = offlineMusic.locator('[data-music-nav] [data-view="playlist"]').filter({ hasText: 'Офлайн' });
  await visible(offlineListNav).catch(async () => {
    const reply = await page.evaluate(() => window.__parvaneDiagCallApi('parvaneMusicPlaylists')).catch(String);
    const names = reply?.view ? JSON.parse(reply.view).playlists.map((list) => list.name) : reply;
    const toasts = await page.locator('.Notification').allInnerTexts().catch(() => []);
    await dumpDiagJournal(page, 'плейлист «Офлайн»', 80);
    assert.fail(`плейлиста «Офлайн» нет в медиатеке: ${JSON.stringify({
      status: reply?.status, names, toastsAfterCreate, toasts,
    })}`);
  });
  await offlineListNav.click();
  await visible(offList.locator('[data-track="t3"]'));
  await offList.locator('[data-music-playlist-menu]').click();
  await page.getByRole('menuitem', { name: 'Download the playlist for offline', exact: true }).click();
  await visible(offList.locator('[data-track="t3"][data-music-offline-track="saved"]'), STEP_TIMEOUT_MS * 2);
  await visible(offList.getByText('downloaded for offline'));
  plAlbum = await openAlbumBySearch(await openMusic(page), 'Берег', 'al-1');
  await addToPlaylist(page, plAlbum.locator('[data-track="t2"]'), 'Офлайн');
  await visible(plAlbum.locator('[data-track="t2"][data-music-offline-track="saved"]'), STEP_TIMEOUT_MS * 2);
  await offlineListNav.click();
  await pickTrackAction(page, offList.locator('[data-track="t3"]'), 'Remove from the playlist');
  await offlineMusic.locator('[data-music-nav] [data-view="offline"]').click();
  const playlistGroup = offlineMusic.locator('[data-music-offline="1"] [data-offline-group^="playlist:"]');
  await visible(playlistGroup.getByText('Офлайн'), STEP_TIMEOUT_MS * 2);
  await visible(playlistGroup.getByText('playlist · 1 track'));
  console.log('OK: загруженный плейлист — новый трек докачан, убранный стёрт с устройства, группа плейлиста');

  // ── Длинные списки страницами, исполнитель и его выпуски ─────────────────
  await fetch(`${LIBRARY_URL}?extra=60`);
  await page.waitForTimeout(1500);
  await reloadPage(page);
  const big = await openMusic(page);
  // «Обзор» поиска: «Исполнители» — весь список сервера
  await big.locator('[data-music-nav] [data-view="search"]').click();
  await big.locator('[data-music-search]').getByRole('button', { name: /^Artists/ }).click();
  await visible(big.locator('[data-music-title]').getByText('Artists'));
  // В библиотеке — 2 исполнителя сценария, добавленные «Найти и скачать» и 60 сингловых: больше одной страницы
  await visible(big.getByText(/\d+ in the server library/));
  const artistRows = big.locator('[data-music-artists] [data-id]');
  await visible(artistRows.nth(49));
  await big.locator('[data-music-more]').scrollIntoViewIfNeeded();
  await page.waitForFunction(() => document.querySelectorAll('#ParvaneMusic [data-music-artists] [data-id]').length >= 62,
    undefined, { timeout: STEP_TIMEOUT_MS });
  console.log('OK: исполнители — шапка с числом, подгрузка второй страницы при прокрутке');
  await big.getByRole('button', { name: 'By tracks', exact: true }).click();
  await visible(big.locator('[data-music-artists] [data-id]').first().getByText('Тихий порт'));
  await big.getByPlaceholder('Find an artist').fill('тихий');
  await page.waitForFunction(() => document.querySelectorAll('#ParvaneMusic [data-music-artists] [data-id]').length === 1,
    undefined, { timeout: STEP_TIMEOUT_MS });
  await visible(big.locator('[data-music-artist-panel="ar-1"]').getByText('Берег'));
  await big.locator('[data-music-artists] [data-id="ar-1"]').dblclick();
  const bigArtist = big.locator('[data-music-artist-page]');
  await visible(bigArtist.getByRole('heading', { name: 'Тихий порт' }));
  await visible(bigArtist.locator('[data-music-tracks] [data-track]').first());
  await visible(bigArtist.locator('[data-music-albums] [data-id="al-1"]'));
  await bigArtist.locator('[data-music-play-all]').click();
  await waitPlaying(page, 'Тихий порт', 'playing');
  await pause(page);
  console.log('OK: исполнитель — страница, «Популярное», выпуски, «Играть»');
  // Сингл исполнителя — среди его выпусков
  await big.locator('[data-music-nav] [data-view="search"]').click();
  await big.locator('[data-music-desk-search]').fill('Echo 07');
  await big.locator('[data-music-artists] [data-id="ar-x07"]').click();
  await bigArtist.locator('[data-music-albums] [data-id]').first().click();
  await visible(big.locator('[data-music-album-page] [data-track="x07"]'));
  await big.locator('[data-music-nav] [data-view="search"]').click();
  await big.locator('[data-music-desk-search]').fill('');
  await big.locator('[data-music-search]').getByRole('button', { name: /^New on the server/ }).click();
  await visible(big.locator('[data-music-title]').getByText(/Albums · \d+/));
  await page.waitForFunction(() => document.querySelectorAll('#ParvaneMusic [data-music-albums] [data-id]').length >= 50,
    undefined, { timeout: STEP_TIMEOUT_MS });
  await big.locator('[data-music-more]').scrollIntoViewIfNeeded();
  await page.waitForFunction(() => document.querySelectorAll('#ParvaneMusic [data-music-albums] [data-id]').length >= 62,
    undefined, { timeout: STEP_TIMEOUT_MS });
  await big.getByRole('button', { name: 'Newest', exact: true }).click();
  await visible(big.locator('[data-music-albums] [data-id]').first().getByText('Echo 60 — сингл'));
  console.log('OK: сингл среди выпусков, альбомы — подгрузка страниц, «Новые»');

  // ── Пустая библиотека: главная по доске ───────────────────────────────────
  await fetch(`${LIBRARY_URL}?empty=1`);
  await page.waitForTimeout(1500);
  await reloadPage(page);
  const emptyMusic = await openMusic(page);
  const empty = emptyMusic.locator('[data-music-empty="library"]');
  await visible(empty.getByText('No music on the server yet'));
  await visible(empty.locator('[data-music-empty-find]'));
  await page.setViewportSize(PHONE);
  await visible(empty.getByText('No music on the server yet'));
  if (process.env.PARVANE_E2E_SHOT_DIR) {
    await page.waitForTimeout(2000);
    await page.screenshot({ path: `${process.env.PARVANE_E2E_SHOT_DIR}/music-empty-phone.png` });
  }
  await page.setViewportSize(WIDE);
  if (process.env.PARVANE_E2E_SHOT_DIR) {
    await page.waitForTimeout(600);
    await page.screenshot({ path: `${process.env.PARVANE_E2E_SHOT_DIR}/music-empty-desk.png` });
  }
  console.log('OK: пустая библиотека — компьютер и телефон по доске');

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
