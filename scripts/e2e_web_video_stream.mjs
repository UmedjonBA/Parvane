// Длинное E2E-видео: настоящая миниатюра, перемотка без полной загрузки,
// целостность потокового медиа (подмена фрагмента в облаке — в середине и в
// хвосте файла, подмена ответа в пути), отсутствие открытых данных в Cache
// Storage. Spec 002 US2, FR-020…FR-024, SC-003…SC-006.
//
// Модель целостности — PVB2 (правило BLOB-1, P-24): блоб в облаке — чанковый
// AEAD, у каждого чанка свой тег, и плеер получает окно только из чанков,
// прошедших проверку. Фоновой докачки файла ради проверки тега больше нет:
// подмена ловится в момент, когда подменённое окно запрошено, а не «когда-то
// потом». Поэтому сценарий (1) убеждается, что в облаке лежит именно PVB2,
// (2) что чистый файл проигрывается с перемотками без единого отказа и без
// скрытой докачки при закрытом просмотрщике, (3) что подменённое окно до
// декодера не доходит: уведомление, отметка ошибки на пузыре, повтор без сети.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  mkdtempSync, readFileSync, rmSync, statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { chromium } from '../web/telegram-tt/node_modules/playwright/index.mjs';

import {
  dumpDiagJournal,
  findMessageContainers,
  LOGIN_TIMEOUT_MS,
  openPrivateChatStrict,
  preparePage,
  readDiagJournal,
  relogin,
  selectMessageActionOn,
  sendText,
  sha256OfDownload,
  thumbnailStats,
  trackDownloadedBytes,
} from './e2e_web_helpers.mjs';

const PASSWORD = 'Parvane-video-stream-e2e-password';
const BACKEND_DIR = process.env.PARVANE_E2E_BACKEND_LOG_DIR;
const GATEWAY_URL = process.env.PARVANE_E2E_GATEWAY_URL;
assert(BACKEND_DIR, 'PARVANE_E2E_BACKEND_LOG_DIR is required');
assert(GATEWAY_URL, 'PARVANE_E2E_GATEWAY_URL is required');
const TAMPER_TOAST = /damaged or was tampered with/;
// Запись журнала (diag kind "media") об отказе проверки тега: «файл <id>
// отброшен: тег чанка не сошёлся…» / «…GCM-тег целого файла не сошёлся»
const INTEGRITY_FAILURE = /отброшен|не сошёлся/;
// Сколько ждём «ничего не происходит»: прежняя фоновая проверка стартовала
// через 5 с после начала воспроизведения
const NO_BACKGROUND_FETCH_WAIT_MS = 12000;
// Видео активного слайда: соседние медиа чата просмотрщик рендерит в
// неактивных слайдах, и их <video> не грузится
const VIEWER_VIDEO = '#MediaViewer .MediaViewerSlide--active video';

// Уведомление живёт ~3 с и может исчезнуть, пока сценарий ещё открывает
// просмотрщик: страница сама копит тексты всех показанных уведомлений
async function recordToasts(page) {
  await page.evaluate(() => {
    if (globalThis.__parvaneE2eToasts) return;
    globalThis.__parvaneE2eToasts = [];
    // Каждое появление уведомления — отдельная запись (тексты повторяются)
    const seen = new WeakSet();
    new MutationObserver(() => {
      document.querySelectorAll('.Notification-container').forEach((node) => {
        const text = node.textContent || '';
        if (!text || seen.has(node)) return;
        seen.add(node);
        globalThis.__parvaneE2eToasts.push({ text, t: Date.now() });
      });
    }).observe(document.body, { childList: true, subtree: true, characterData: true });
  });
}

function tamperToasts(page) {
  return page.evaluate((source) => globalThis.__parvaneE2eToasts
    .filter(({ text }) => new RegExp(source).test(text)), TAMPER_TOAST.source);
}

async function toastCount(page) {
  return (await tamperToasts(page)).length;
}

// Тост о подмене появился не позже 5 с после того, как проверка тега
// зафиксировала провал для этого файла (SC-006)
async function assertToastSoonAfterFailure(page, log, fileId, toastsBefore) {
  const started = Date.now();
  let failure;
  while (!(failure = log.entries().find((entry) => entry.d.includes(fileId) && INTEGRITY_FAILURE.test(entry.d)))) {
    assert(Date.now() - started < 10000, `no integrity failure in the journal for ${fileId}`);
    await page.waitForTimeout(500);
  }
  const toast = (await tamperToasts(page))[toastsBefore];
  const delay = toast.t - failure.t;
  console.log(`${fileId}: toast ${delay} ms after the integrity failure`);
  assert(delay <= 5000, `tamper toast came ${delay} ms after the integrity failure`);
}

// Сколько раз провайдер получил вызов метода с момента sinceMs (журнал diag,
// повторы схлопнуты в поле n)
async function apiCallCount(page, method, sinceMs) {
  await page.waitForTimeout(2000); // журнал пишется с задержкой ~1.5 с
  const entries = await readDiagJournal(page);
  return entries.filter((entry) => entry.k === `api:${method}` && entry.t >= sinceMs)
    .reduce((sum, entry) => sum + (entry.n || 1), 0);
}

// Состояние поиска медиа чата (сегменты просмотрщика) — для диагностики цикла
function chatMediaSearchState(page) {
  return page.evaluate(() => {
    const global = window.__parvaneGetGlobal?.();
    return Object.values(global?.byTabId || {}).map((tab) => {
      const chatId = tab.mediaViewer?.chatId;
      const byId = (chatId && global.messages.byChatId[chatId]?.byId) || {};
      return {
        viewer: tab.mediaViewer && { chatId, messageId: tab.mediaViewer.messageId },
        messageList: tab.messageLists?.[tab.messageLists.length - 1],
        media: Object.values(byId).filter((message) => message.content?.video || message.content?.photo)
          .map((message) => ({ id: message.id, round: message.content.video?.isRound, gif: message.content.video?.isGif })),
        search: tab.chatMediaSearch?.byChatThreadKey,
      };
    });
  });
}

// Открытый просмотрщик не крутит поиск медиа чата (T090, FR-022): при обычном
// открытии запросов 3–4
async function assertNoMediaSearchLoop(page, sinceMs, label) {
  const count = await apiCallCount(page, 'searchMessagesInChat', sinceMs);
  if (count > 5) console.error(`${label}: chat media search state:`, JSON.stringify(await chatMediaSearchState(page)));
  assert(count <= 5, `${label}: media viewer searched chat media ${count} times`);
}

// Ждём НОВОЕ уведомление о подмене (больше, чем было до шага)
async function waitTamperToast(page, before, timeoutMs = 180000) {
  await page.waitForFunction(({ source, count }) => globalThis.__parvaneE2eToasts
    .filter(({ text }) => new RegExp(source).test(text)).length > count,
  { source: TAMPER_TOAST.source, count: before }, { timeout: timeoutMs });
}
const BIG_VIDEO_MIN_BYTES = 40 * 1024 * 1024;

// Строки проверки целостности (diag kind "media") из журнала страницы: журнал
// — кольцевой буфер, поэтому собираем по ходу сценария и печатаем при падении
function watchIntegrityLog(page) {
  const seen = new Map();
  const timer = setInterval(() => {
    readDiagJournal(page).then((entries) => {
      entries.filter((entry) => entry.k === 'media').forEach((entry) => seen.set(`${entry.t}|${entry.d}`, entry));
    }).catch(() => {});
  }, 1000);
  return {
    stop: () => clearInterval(timer),
    entries: () => [...seen.values()].sort((a, b) => a.t - b.t),
    lines: () => [...seen.values()].sort((a, b) => a.t - b.t)
      .map((entry) => `${new Date(entry.t).toISOString().slice(11, 23)} ${entry.d}`),
  };
}

// Playwright-Chromium без H.264 — VP9-in-MP4. testsrc2 + высокий битрейт даёт
// крупный файл быстро; faststart переносит moov в начало
function makeVideo(dir, name, { seconds, bitrate, faststart }) {
  const path = join(dir, name);
  execFileSync('ffmpeg', [
    '-y', '-f', 'lavfi', '-i', `testsrc2=size=1280x720:rate=30:duration=${seconds}`,
    '-c:v', 'libvpx-vp9', '-deadline', 'realtime', '-cpu-used', '8', '-row-mt', '1',
    '-b:v', bitrate, '-minrate', bitrate, '-maxrate', bitrate, '-pix_fmt', 'yuv420p',
    ...(faststart ? ['-movflags', '+faststart'] : []),
    path,
  ], { stdio: 'ignore' });
  return { path, size: statSync(path).size };
}

function sqlite(query) {
  // Шард держит БД открытой (WAL) — ждём снятия блокировки, а не падаем
  return execFileSync('sqlite3', ['-cmd', '.timeout 10000', join(BACKEND_DIR, 'cloud.db'), query], { encoding: 'utf8' }).trim();
}

// Кадр-миниатюра в пузыре: не 1×1, не однотонная, появилась ≤ 3 с после пузыря
async function expectFrameThumbnail(page, bubble, label, maxMs = 3000) {
  await bubble.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  const started = Date.now();
  let stats;
  for (;;) {
    stats = await thumbnailStats(bubble);
    if (stats.width > 1 && stats.variance > 50) break;
    if (Date.now() - started > 15000) break;
    await page.waitForTimeout(300);
  }
  assert(stats.width > 1 && stats.height > 1, `${label}: thumbnail is a placeholder ${JSON.stringify(stats)}`);
  assert(stats.variance > 50, `${label}: thumbnail is uniform ${JSON.stringify(stats)}`);
  const elapsed = Date.now() - started;
  console.log(`${label}: thumbnail ${stats.width}x${stats.height} in ${elapsed} ms`);
  assert(elapsed <= maxMs, `${label}: thumbnail appeared ${elapsed} ms after the bubble (limit ${maxMs} ms)`);
}

function cloudFileIds() {
  return new Set(sqlite('SELECT id FROM files').split('\n').filter(Boolean));
}

// Новый файл в облаке, у которого загружены все фрагменты
function completeNewFileId(before) {
  const rows = sqlite('SELECT f.id FROM files f WHERE f.total_chunks = '
    + '(SELECT count(*) FROM chunks c WHERE c.file_id = f.id) ORDER BY f.created_at DESC, f.rowid DESC');
  return rows.split('\n').filter(Boolean).find((id) => !before.has(id));
}

// Меняет один байт фрагмента в облаке (шифртекст): окна видео при этом
// расшифровываются без ошибок — поймать можно только проверкой тега
function flipCloudByte(fileId, chunkIndex, offset = 100) {
  const hex = sqlite(`SELECT hex(substr(data, ${offset + 1}, 1)) FROM chunks WHERE file_id = '${fileId}' AND chunk_index = ${chunkIndex}`);
  assert(hex, `chunk ${chunkIndex} of ${fileId} not found`);
  const flipped = (parseInt(hex, 16) ^ 0x5a).toString(16).padStart(2, '0');
  const lengthBefore = sqlite(`SELECT length(data) FROM chunks WHERE file_id = '${fileId}' AND chunk_index = ${chunkIndex}`);
  sqlite(`UPDATE chunks SET data = CAST(substr(data, 1, ${offset}) || x'${flipped}' || substr(data, ${offset + 2}) AS BLOB) WHERE file_id = '${fileId}' AND chunk_index = ${chunkIndex}`);
  const lengthAfter = sqlite(`SELECT length(data) FROM chunks WHERE file_id = '${fileId}' AND chunk_index = ${chunkIndex}`);
  assert.equal(lengthAfter, lengthBefore, 'cloud chunk length changed while flipping a byte');
  const after = sqlite(`SELECT hex(substr(data, ${offset + 1}, 1)) FROM chunks WHERE file_id = '${fileId}' AND chunk_index = ${chunkIndex}`);
  assert.notEqual(after, hex, 'cloud chunk byte was not changed');
}

function chunkCount(fileId) {
  return Number(sqlite(`SELECT count(*) FROM chunks WHERE file_id = '${fileId}'`));
}

// Блоб в облаке — PVB2: магия «PVB2» и размер чанка в заголовке (BLOB-1)
function assertPvb2InCloud(fileId, label) {
  const head = sqlite(`SELECT hex(substr(data, 1, 8)) FROM chunks WHERE file_id = '${fileId}' AND chunk_index = 0`);
  assert.equal(head.slice(0, 8), '50564232', `${label}: cloud blob is not PVB2 (header ${head})`);
  const blobChunk = parseInt(head.slice(8), 16);
  assert(blobChunk >= 1024 && blobChunk <= 8 * 1024 * 1024, `${label}: PVB2 chunk size ${blobChunk}`);
}

// Доля файла (по байтам шифртекста), на которую приходится байт `offset`
// фрагмента `chunkIndex` — куда перемотать, чтобы плеер запросил это окно
function cloudByteFraction(fileId, chunkIndex, offset) {
  const before = Number(sqlite(
    `SELECT coalesce(sum(length(data)), 0) FROM chunks WHERE file_id = '${fileId}' AND chunk_index < ${chunkIndex}`,
  ));
  const total = Number(sqlite(`SELECT sum(length(data)) FROM chunks WHERE file_id = '${fileId}'`));
  return (before + offset) / total;
}

// Сколько шифртекста файла скачано к моменту, когда загрузка затихла (два
// одинаковых замера подряд): хвост уже отправленных запросов дожидаемся
async function settledBytes(page, tracker, fileId) {
  const deadline = Date.now() + LOGIN_TIMEOUT_MS;
  let previous = -1;
  for (;;) {
    const current = await tracker.bytesFor(fileId);
    if (current === previous) return current;
    assert(Date.now() < deadline, `download of ${fileId} never settled`);
    previous = current;
    await page.waitForTimeout(2000);
  }
}

// Подменённый файл: кликаем по пузырю, пока не появится уведомление. Первый
// клик tt может потратить на «разрешить загрузку»; просмотрщик на подменённом
// файле открывается без <video>, поэтому `openViewer` здесь не годится
async function openUntilTamperToast(page, bubble, toastsBefore, timeoutMs = 120000) {
  for (let attempt = 0; attempt < 4 && (await toastCount(page)) === toastsBefore; attempt++) {
    await bubble.locator('.media-inner').first().click({ timeout: 3000 }).catch(() => {});
    await waitTamperToast(page, toastsBefore, 10000).catch(() => {});
  }
  await waitTamperToast(page, toastsBefore, timeoutMs);
}

async function attachVideo(page, path, caption) {
  await page.getByRole('button', { name: 'Add an attachment' }).click();
  const fileChooserPromise = page.waitForEvent('filechooser');
  await page.getByRole('menuitem', { name: 'Photo or Video' }).click();
  const fileChooser = await fileChooserPromise;
  await fileChooser.setFiles(path);
  const captionInput = page.locator('#editable-message-text-modal');
  await captionInput.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await captionInput.fill(caption);
  await captionInput.press('Enter');
  await captionInput.waitFor({ state: 'hidden', timeout: LOGIN_TIMEOUT_MS });
}

// Ждём, пока отправитель дозальёт файл в облако: новый файл со всеми
// фрагментами и исходящий пузырь без прогресса. Индикатор прогресса может ещё
// не появиться к первой проверке, поэтому опора — облако. Возвращает file_id
async function waitUploaded(page, caption, before, timeoutMs = 240000) {
  const bubble = findMessageContainers(page, caption).first();
  await bubble.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  const started = Date.now();
  let fileId;
  while (!(fileId = completeNewFileId(before))) {
    assert(Date.now() - started < timeoutMs, `upload of ${caption} did not complete`);
    await page.waitForTimeout(500);
  }
  await bubble.locator('.message-transfer-progress').waitFor({ state: 'detached', timeout: timeoutMs });
  return fileId;
}

// Незагруженное видео (больше лимита автозагрузки): первый клик tt может
// потратить на «разрешить загрузку» — кликаем, пока не откроется просмотрщик
async function openViewer(page, bubble) {
  const video = page.locator(VIEWER_VIDEO).first();
  for (let attempt = 0; attempt < 4; attempt++) {
    await bubble.locator('.media-inner').first().click();
    const isOpen = await video.waitFor({ state: 'attached', timeout: 8000 }).then(() => true).catch(() => false);
    if (isOpen) return video;
  }
  await video.waitFor({ state: 'attached', timeout: LOGIN_TIMEOUT_MS });
  return video;
}

async function closeViewer(page) {
  await page.keyboard.press('Escape');
  await page.locator(VIEWER_VIDEO).first()
    .waitFor({ state: 'detached', timeout: LOGIN_TIMEOUT_MS }).catch(() => {});
}

async function waitPlaying(video, { minTime, timeoutMs }) {
  return video.evaluate((element, { min, timeout }) => new Promise((resolve, reject) => {
    const started = performance.now();
    element.muted = true;
    element.play().catch(() => {});
    const timer = setInterval(() => {
      if (element.currentTime > min && !element.paused && element.readyState >= 3) {
        clearInterval(timer);
        resolve(performance.now() - started);
      } else if (performance.now() - started > timeout) {
        clearInterval(timer);
        reject(new Error(`video did not play past ${min}s (at ${element.currentTime}, readyState ${element.readyState})`));
      }
    }, 100);
  }), { min: minTime, timeout: timeoutMs });
}

const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
const aliceContext = await browser.newContext();
const bobContext = await browser.newContext();
const eveContext = await browser.newContext();
const fixtureDir = mkdtempSync(join(tmpdir(), 'parvane-video-stream-'));
const sessions = {};
let integrityLog;
let eveIntegrityLog;
let seenChunkReplies;

try {
  const suffix = `${Date.now()}-${process.pid}`;
  const alice = `vs-alice-${suffix}@local`;
  const bob = `vs-bob-${suffix}@local`;
  const eve = `vs-eve-${suffix}@local`;

  // ── Фикстуры: ≥ 40 МБ с moov в конце и с faststart, ~20 МБ для атаки на тег
  const bigVideo = makeVideo(fixtureDir, 'big-moov-end.mp4', { seconds: 30, bitrate: '24M', faststart: false });
  const bigFaststart = makeVideo(fixtureDir, 'big-faststart.mp4', { seconds: 30, bitrate: '24M', faststart: true });
  const midVideo = makeVideo(fixtureDir, 'mid.mp4', { seconds: 10, bitrate: '18M', faststart: true });
  assert(bigVideo.size >= BIG_VIDEO_MIN_BYTES, `fixture too small: ${bigVideo.size}`);
  assert(bigFaststart.size >= BIG_VIDEO_MIN_BYTES, `faststart fixture too small: ${bigFaststart.size}`);

  sessions.alice = await preparePage(aliceContext, alice, PASSWORD);
  sessions.bob = await preparePage(bobContext, bob, PASSWORD);
  const bobBytes = trackDownloadedBytes(sessions.bob.page);
  integrityLog = watchIntegrityLog(sessions.bob.page);
  await recordToasts(sessions.bob.page);
  await openPrivateChatStrict(sessions.alice.page, bob);
  await sendText(sessions.alice.page, `hi-bob-${suffix}`);
  await openPrivateChatStrict(sessions.bob.page, alice);

  // PARVANE_E2E_VS_ONLY_TAMPER=1 — отладка: пропустить миниатюру и перемотку
  const seekFixtures = process.env.PARVANE_E2E_VS_ONLY_TAMPER ? [] : [['moov-end', bigVideo], ['faststart', bigFaststart]];
  for (const [label, fixture] of seekFixtures) {
    const caption = `vs-${label}-${suffix}`;
    const filesBefore = cloudFileIds();
    await attachVideo(sessions.alice.page, fixture.path, caption);
    const seekFileId = await waitUploaded(sessions.alice.page, caption, filesBefore);
    assertPvb2InCloud(seekFileId, label);
    const cleanToastsBefore = await toastCount(sessions.bob.page);

    // ── Миниатюра: кадр видео, не 1×1 и не однотонная, ≤ 3 с (SC-004) ──────
    const bubble = findMessageContainers(sessions.bob.page, caption).first();
    await expectFrameThumbnail(sessions.bob.page, bubble, `${label} (bob)`);

    // ── Миниатюра у отправителя после relogin (FR-020) ─────────────────────
    if (label === 'moov-end') {
      await relogin(sessions.alice.page, PASSWORD);
      await openPrivateChatStrict(sessions.alice.page, bob);
      await expectFrameThumbnail(sessions.alice.page, findMessageContainers(sessions.alice.page, caption).first(),
        `${label} (alice after relogin)`, 15000);
    }

    // ── Перемотка на середину сразу после открытия (SC-003) ──────────────────
    await bobBytes.reset();
    const video = await openViewer(sessions.bob.page, bubble);
    await video.evaluate((element) => new Promise((resolve) => {
      if (element.readyState >= 1) resolve(undefined);
      else element.addEventListener('loadedmetadata', () => resolve(undefined), { once: true });
      setTimeout(() => resolve(undefined), 15000);
    }));
    const duration = await video.evaluate((element) => element.duration);
    assert(duration > 10, `${label}: duration ${duration}`);
    await video.evaluate((element) => { element.currentTime = element.duration / 2; });
    const seekMs = await waitPlaying(video, { minTime: duration / 2 + 0.3, timeoutMs: 5000 });
    const downloadedAtStart = await bobBytes.bytesFor();
    const requestLog = (await bobBytes.requests()).map((request) => `${request.from}-${request.to}`).join(' ');
    console.log(`${label}: requests before playing: ${requestLog}`);
    console.log(`${label}: seek to middle played in ${Math.round(seekMs)} ms, downloaded ${downloadedAtStart} of ${fixture.size}`);
    // Смысл проверки — файл не качается целиком. Доля зависит от скорости
    // канала: блобы v2 идут двоичными кадрами и за время до перемотки плеер
    // успевает добуферить больше, чем по v1 (base64 в JSON)
    assert(downloadedAtStart <= fixture.size * 0.4, `${label}: downloaded ${downloadedAtStart} > 40% before playing`);

    // ── Многократная перемотка без зависаний ──────────────────────────────────
    for (const fraction of [0.1, 0.8, 0.3, 0.9, 0.05]) {
      await video.evaluate((element, f) => { element.currentTime = element.duration * f; }, fraction);
      await waitPlaying(video, { minTime: duration * fraction + 0.2, timeoutMs: 10000 });
    }
    await closeViewer(sessions.bob.page);

    // ── Целостность — по окнам, без фоновой докачки (FR-022, BLOB-1) ─────────
    // Каждое окно всех перемоток прошло проверку тега: ни отказа в журнале, ни
    // уведомления. Когда ни один плеер не играет, файл больше НЕ качается —
    // проверять «в фоне» нечего, непроверенные байты плееру не отдавались.
    // После закрытия просмотрщика встроенный плеер пузыря возобновляет своё
    // воспроизведение и тянет окна дальше — ставим все <video> на паузу
    await sessions.bob.page.evaluate(() => document.querySelectorAll('video').forEach((element) => element.pause()));
    const downloadedAtClose = await settledBytes(sessions.bob.page, bobBytes, seekFileId);
    await sessions.bob.page.waitForTimeout(NO_BACKGROUND_FETCH_WAIT_MS);
    const downloadedAfterIdle = await bobBytes.bytesFor(seekFileId);
    assert.equal(downloadedAfterIdle, downloadedAtClose,
      `${label}: the file keeps downloading with no player running (${downloadedAtClose} → ${downloadedAfterIdle})`);
    const cleanFailures = integrityLog.lines().filter((line) => line.includes(seekFileId) && INTEGRITY_FAILURE.test(line));
    assert.deepEqual(cleanFailures, [], `${label}: integrity failure on an untouched file`);
    assert.equal(await toastCount(sessions.bob.page), cleanToastsBefore, `${label}: tamper toast on an untouched file`);
    console.log(`${label}: every window verified, ${downloadedAfterIdle} of ${fixture.size} bytes fetched, `
      + 'nothing downloads while no player runs');

    // ── Повторное открытие: видео продолжает играть ───────────────────────────
    const replay = await openViewer(sessions.bob.page, bubble);
    await replay.evaluate((element) => { element.currentTime = 0; });
    await waitPlaying(replay, { minTime: 0.5, timeoutMs: 10000 });
    console.log(`${label}: plays from the start after reopening`);
    await closeViewer(sessions.bob.page);
  }

  // ── Подмена фрагмента в середине файла (SC-006) ─────────────────────────────
  const tamperCaption = `vs-tamper-mid-${suffix}`;
  const beforeTamperedFile = cloudFileIds();
  const midToastsBefore = await toastCount(sessions.bob.page);
  await attachVideo(sessions.alice.page, bigVideo.path, tamperCaption);
  const tamperedFile = await waitUploaded(sessions.alice.page, tamperCaption, beforeTamperedFile);
  const tamperedChunk = Math.floor(chunkCount(tamperedFile) / 2);
  flipCloudByte(tamperedFile, tamperedChunk);
  const tamperedAt = cloudByteFraction(tamperedFile, tamperedChunk, 100);
  const tamperBubble = findMessageContainers(sessions.bob.page, tamperCaption).first();
  await tamperBubble.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  let tamperVideo = await openViewer(sessions.bob.page, tamperBubble);
  // Начало файла не тронуто: его окна проходят проверку и играют. Уведомление
  // раньше воспроизведения возможно, только если плеер уже добуферил до
  // подменённого окна
  const firstEvent = await Promise.race([
    waitPlaying(tamperVideo, { minTime: 0.3, timeoutMs: 20000 }).then(() => 'playing'),
    waitTamperToast(sessions.bob.page, midToastsBefore, 20000).then(() => 'toast'),
  ]);
  const tamperRequests = (await bobBytes.requests()).filter((request) => request.fileId === tamperedFile);
  assert(tamperRequests.length > 0, 'viewer did not request the tampered file');
  if (firstEvent === 'playing' && (await toastCount(sessions.bob.page)) === midToastsBefore) {
    // Подмена ловится, когда запрошено подменённое окно, — перематываем к нему
    await tamperVideo.evaluate((element, fraction) => {
      element.currentTime = Math.max(0, element.duration * fraction - 0.5);
      element.play().catch(() => {});
    }, tamperedAt).catch(() => {});
  }
  console.log(`tamper-mid: ${firstEvent} first, tampered byte at ${(tamperedAt * 100).toFixed(1)}% of the file`);
  await waitTamperToast(sessions.bob.page, midToastsBefore, 60000);
  await assertToastSoonAfterFailure(sessions.bob.page, integrityLog, tamperedFile, midToastsBefore);
  await closeViewer(sessions.bob.page);
  await tamperBubble.locator('.icon-message-failed').first().waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  // Повторный запуск — ошибка без новых запросов файла
  const requestsBefore = (await bobBytes.requests()).filter((request) => request.fileId === tamperedFile).length;
  // Один клик: подменённое видео открывается без плеера, повторные клики по
  // пузырю под открытым просмотрщиком не нужны
  const replayStartedAt = await sessions.bob.page.evaluate(() => Date.now());
  await tamperBubble.locator('.media-inner').first().click();
  await sessions.bob.page.locator('.MediaViewer, #MediaViewer').first()
    .waitFor({ state: 'attached', timeout: LOGIN_TIMEOUT_MS });
  tamperVideo = await sessions.bob.page.locator(VIEWER_VIDEO).first()
    .waitFor({ state: 'attached', timeout: 3000 })
    .then(() => sessions.bob.page.locator(VIEWER_VIDEO).first())
    .catch(() => undefined);
  // tt восстанавливает запомненную позицию (currentTime ≠ 0) — проверяем, что
  // время не идёт и плеер стоит на паузе
  const readPlayback = () => tamperVideo?.evaluate((element) => ({ time: element.currentTime, paused: element.paused }))
    .catch(() => undefined);
  // Восстановление позиции — асинхронный скачок currentTime; базовый замер
  // берём после того, как позиция перестала меняться, иначе скачок выглядит
  // как воспроизведение
  let playbackBefore = await readPlayback();
  for (let attempt = 0; attempt < 10 && playbackBefore; attempt++) {
    await sessions.bob.page.waitForTimeout(500);
    const next = await readPlayback();
    if (next && next.time === playbackBefore.time) break;
    playbackBefore = next;
  }
  await sessions.bob.page.waitForTimeout(3000);
  const playbackAfter = await readPlayback();
  if (playbackBefore && playbackAfter) {
    assert(playbackAfter.paused && playbackAfter.time - playbackBefore.time < 0.2,
      `tampered video plays again: ${JSON.stringify({ playbackBefore, playbackAfter })}`);
  }
  // Просмотрщик на подменённом видео не крутит поиск медиа чата (FR-022, T090)
  await assertNoMediaSearchLoop(sessions.bob.page, replayStartedAt, 'replay of the tampered video');

  // Просмотрщик мог открыться и без <video> (подменённый файл) — закрываем всегда
  await closeViewer(sessions.bob.page);
  await sessions.bob.page.locator('.MediaViewer, #MediaViewer').first()
    .waitFor({ state: 'detached', timeout: LOGIN_TIMEOUT_MS }).catch(() => {});
  const requestsAfter = (await bobBytes.requests()).filter((request) => request.fileId === tamperedFile).length;
  assert.equal(requestsAfter, requestsBefore, 'tampered file was requested from the network again');

  // ── Подмена в хвосте (последний фрагмент облака): средний файл загружается
  // целиком — подмену ловит тег последнего чанка при расшифровке всего файла
  const tagCaption = `vs-tamper-tag-${suffix}`;
  const beforeTagFile = cloudFileIds();
  const tagToastsBefore = await toastCount(sessions.bob.page);
  await attachVideo(sessions.alice.page, midVideo.path, tagCaption);
  const tagFile = await waitUploaded(sessions.alice.page, tagCaption, beforeTagFile);
  assertPvb2InCloud(tagFile, 'tamper-tag');
  flipCloudByte(tagFile, chunkCount(tagFile) - 1, 0);
  const tagBubble = findMessageContainers(sessions.bob.page, tagCaption).first();
  await tagBubble.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  const tagOpenedAt = await sessions.bob.page.evaluate(() => Date.now());
  await openUntilTamperToast(sessions.bob.page, tagBubble, tagToastsBefore);
  await assertToastSoonAfterFailure(sessions.bob.page, integrityLog, tagFile, tagToastsBefore);
  await sessions.bob.page.waitForTimeout(3000);
  await assertNoMediaSearchLoop(sessions.bob.page, tagOpenedAt, 'tag-tampered video in the viewer');
  await closeViewer(sessions.bob.page);

  // ── Подмена в пути: облако цело, подменён ответ gateway на фрагмент ─────────
  // Раньше плеер и фоновая проверка качали файл порознь, и подмену одному из
  // них ловило сравнение двух экземпляров. В PVB2 потребитель один: каждый
  // полученный фрагмент проверяется тегом своего чанка до декодера, поэтому
  // достаточно подменить первый же ответ — второго «чистого» экземпляра,
  // которому можно было бы поверить, нет
  let targetFile;
  const beforeTransit = cloudFileIds();
  // Цель — новый файл, загруженный после снимка облака (id ещё неизвестен,
  // когда получатель уже может тянуть первые фрагменты ради миниатюры)
  const isTargetFile = (fileId) => (targetFile ? fileId === targetFile : !beforeTransit.has(fileId));
  const TAMPERED_CHUNK = 3;
  const seenByIndex = new Map();
  seenChunkReplies = seenByIndex;
  const V2_CHUNK_FRAME_MIN_BYTES = 100000;
  let v2ChunkFrames = 0;
  await eveContext.routeWebSocket(/.*/, (ws) => {
    const server = ws.connectToServer();
    ws.onMessage((message) => server.send(message));
    server.onMessage((message) => {
      // Протокол v2: блоб по capability едет двоичными кадрами (схема, не JSON).
      // Кадр с чанком узнаётся по размеру; eve — новый пользователь и качает
      // только целевой файл. Байт в середине кадра лежит внутри данных чанка
      if (typeof message !== 'string' && message.length > V2_CHUNK_FRAME_MIN_BYTES) {
        v2ChunkFrames += 1;
        if (v2ChunkFrames === TAMPERED_CHUNK + 1) {
          seenByIndex.set(TAMPERED_CHUNK, 1);
          const bytes = Buffer.from(message);
          bytes[Math.floor(bytes.length / 2)] ^= 0xff;
          ws.send(bytes);
          return;
        }
        ws.send(message);
        return;
      }
      try {
        const frame = JSON.parse(String(message));
        if (frame.op === 'reply' && frame.payload) {
          const body = JSON.parse(frame.payload);
          if (body.file_id && isTargetFile(body.file_id) && body.chunk_index === TAMPERED_CHUNK && body.data) {
            const seen = (seenByIndex.get(TAMPERED_CHUNK) || 0) + 1;
            seenByIndex.set(TAMPERED_CHUNK, seen);
            if (seen === 1) {
              const bytes = Buffer.from(body.data, 'base64');
              bytes[10] ^= 0xff;
              body.data = bytes.toString('base64');
              frame.payload = JSON.stringify(body);
              ws.send(JSON.stringify(frame));
              return;
            }
          }
        }
      } catch {
        // не JSON
      }
      ws.send(message);
    });
  });
  sessions.eve = await preparePage(eveContext, eve, PASSWORD);
  await recordToasts(sessions.eve.page);
  eveIntegrityLog = watchIntegrityLog(sessions.eve.page);
  const eveBytes = trackDownloadedBytes(sessions.eve.page);
  await openPrivateChatStrict(sessions.alice.page, eve);
  const transitCaption = `vs-transit-${suffix}`;
  const eveToastsBefore = await toastCount(sessions.eve.page);
  // Большой файл: он стримится окнами, фрагмент 3 лежит в начале файла
  await attachVideo(sessions.alice.page, bigFaststart.path, transitCaption);
  targetFile = await waitUploaded(sessions.alice.page, transitCaption, beforeTransit);
  await openPrivateChatStrict(sessions.eve.page, alice);
  const transitBubble = findMessageContainers(sessions.eve.page, transitCaption).first();
  await transitBubble.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await openUntilTamperToast(sessions.eve.page, transitBubble, eveToastsBefore);
  await assertToastSoonAfterFailure(sessions.eve.page, eveIntegrityLog, targetFile, eveToastsBefore);
  assert(seenByIndex.get(TAMPERED_CHUNK) >= 1, 'the tampered chunk was never requested');
  await closeViewer(sessions.eve.page);
  await transitBubble.locator('.icon-message-failed').first().waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  // Файл помечен до конца сессии: повторное открытие в сеть не ходит (иначе
  // второй, уже чистый ответ «вылечил» бы подменённый файл)
  const transitRequests = async () => (await eveBytes.requests()).filter((request) => request.fileId === targetFile).length;
  const transitRequestsBefore = await transitRequests();
  // Escape из `closeViewer` иногда доходит уже после закрытия просмотрщика и
  // закрывает сам чат — тогда пузыря нет и клик ниже уходит в пустоту
  await sessions.eve.page.waitForTimeout(500);
  if (!(await transitBubble.isVisible().catch(() => false))) {
    await openPrivateChatStrict(sessions.eve.page, alice);
    await transitBubble.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  }
  await transitBubble.locator('.media-inner').first().click();
  await sessions.eve.page.locator('.MediaViewer, #MediaViewer').first()
    .waitFor({ state: 'attached', timeout: LOGIN_TIMEOUT_MS });
  await sessions.eve.page.waitForTimeout(3000);
  await closeViewer(sessions.eve.page);
  assert.equal(await transitRequests(), transitRequestsBefore, 'file tampered in transit was requested again');

  // ── Кодек, который браузер не умеет декодировать ───────────────────────────
  // Граничный случай спеки: «миниатюра — нейтральная заглушка с длительностью,
  // файл можно скачать». MPEG-4 Visual в MP4 Chromium не декодирует. Через
  // композер такой файл уходит ДОКУМЕНТОМ (отправитель тем же декодером не
  // читает метаданные), поэтому путь получателя «кадр снять не с чего →
  // заглушка (buildThumbPlaceholder)» так не проверить. Видео-сообщение с
  // метаданными (как с десктопа/другого клиента) отправляем через диаг-хук
  // провайдера: длительность рисует нативный оверлей из метаданных, заглушка
  // непрозрачная, файл скачивается побайтно
  {
    const undecodable = join(fixtureDir, 'undecodable.mp4');
    execFileSync('ffmpeg', [
      '-y', '-f', 'lavfi', '-i', 'testsrc2=size=320x240:rate=15:duration=3',
      '-c:v', 'mpeg4', '-b:v', '600k', '-pix_fmt', 'yuv420p', undecodable,
    ], { stdio: 'ignore' });
    const caption = `vs-undecodable-${suffix}`;
    await openPrivateChatStrict(sessions.alice.page, bob);
    await sessions.alice.page.waitForFunction(
      () => typeof window.__parvaneDiagCallApi === 'function',
      undefined,
      { timeout: LOGIN_TIMEOUT_MS },
    );
    const sendResult = await sessions.alice.page.evaluate(async ({ b64, text, peerName, quick, filename }) => {
      const global = window.__parvaneGetGlobal();
      const user = Object.values(global.users.byId)
        .find((candidate) => candidate.usernames?.some(({ username }) => username === peerName));
      const chat = user && global.chats.byId[user.id];
      if (!chat) return `chat for ${peerName} not found`;
      const bin = atob(b64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const blob = new Blob([bytes], { type: 'video/mp4' });
      // Промис отправки НЕ ждём: у page.evaluate нет таймаута, а sendMessage
      // провайдера с вложением может не разрешиться (17 сен сценарий висел на
      // этом сутки). Факт отправки проверяется пузырём у получателя ниже
      void window.__parvaneDiagCallApi('sendMessage', {
        chat,
        text,
        attachment: {
          blob, blobUrl: URL.createObjectURL(blob), filename, mimeType: 'video/mp4', size: blob.size, quick,
        },
      }).catch(() => undefined);
      return 'ok';
    }, {
      b64: readFileSync(undecodable).toString('base64'),
      text: caption,
      peerName: bob.split('@')[0],
      quick: { width: 320, height: 240, duration: 3 },
      filename: 'undecodable.mp4',
    });
    assert.equal(sendResult, 'ok', `provider send failed: ${sendResult}`);
    // Шаги с подменой закрывают просмотрщик по Escape — лишний Escape закрывает
    // и чат; открываем его явно (сообщение приходило, но в список чатов)
    await openPrivateChatStrict(sessions.bob.page, alice);
    const bubble = findMessageContainers(sessions.bob.page, caption).first();
    await bubble.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
    // Пришло видео (не документ): оверлей длительности из метаданных
    await bubble.getByText('0:03', { exact: true }).first().waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
    // Заглушка приходит как previewBlobUrl → `img.thumbnail` (Video.tsx);
    // широкий селектор ловил первым `canvas.blurred-bg`/`img.full-media` без
    // src, у которых naturalWidth не появляется никогда. Непрозрачная и не 1×1
    // — пузырь не «пустой прямоугольник»
    const stats = await thumbnailStats(bubble);
    assert(!stats.timedOut, `undecodable video: placeholder never loaded (${JSON.stringify(stats)})`);
    // Заглушка (PLACEHOLDER_PNG_BASE64) — 1×1 непрозрачный пиксель, растянутый
    // CSS до размеров пузыря из метаданных: проверяем непрозрачность и
    // отрисованный бокс, а не naturalWidth
    assert(stats.alpha === 255, `undecodable video: placeholder is transparent (alpha=${stats.alpha})`);
    const placeholderBox = await bubble.locator('img.thumbnail').first().boundingBox();
    assert(placeholderBox && placeholderBox.width > 40 && placeholderBox.height > 40,
      `undecodable video: placeholder box is ${JSON.stringify(placeholderBox)}`);
    // Файл всё равно скачивается побайтно (через меню сообщения — клик по
    // пузырю открывает просмотрщик)
    const downloadEvent = sessions.bob.page.waitForEvent('download', { timeout: LOGIN_TIMEOUT_MS });
    await selectMessageActionOn(sessions.bob.page, bubble, 'Download');
    const download = await downloadEvent;
    const downloaded = readFileSync(await download.path());
    assert.equal(
      createHash('sha256').update(downloaded).digest('hex'),
      createHash('sha256').update(readFileSync(undecodable)).digest('hex'),
      'undecodable video did not download byte-identical',
    );
    console.log('OK: недекодируемый кодек — видео с длительностью, непрозрачная заглушка, файл скачивается');
  }

  // ── Открытых медиа-данных в Cache Storage нет (SC-005) ─────────────────────
  const storageProbe = await sessions.bob.page.evaluate(async () => {
    // Кэши с открытым медиа: потоковые окна и свой фон чата (FR-023)
    const names = await caches.keys();
    const caches_ = {};
    for (const name of names.filter((n) => n.startsWith('tt-media') || n.startsWith('tt-custom-bg'))) {
      const cache = await caches.open(name);
      caches_[name] = (await cache.keys()).length;
    }
    // IndexedDB: ни одна база не должна нести открытые байты медиа. Ищем
    // значения, похожие на медиа (Blob/ArrayBuffer заметного размера)
    const databases = (await indexedDB.databases?.() || []).map(({ name }) => name).filter(Boolean);
    const plaintextBlobs = [];
    await Promise.all(databases.map((dbName) => new Promise((resolve) => {
      const request = indexedDB.open(dbName);
      request.onerror = () => resolve(undefined);
      request.onsuccess = () => {
        const db = request.result;
        const stores = Array.from(db.objectStoreNames);
        if (!stores.length) { db.close(); resolve(undefined); return; }
        const tx = db.transaction(stores, 'readonly');
        let pending = stores.length;
        const done = () => { if (--pending === 0) { db.close(); resolve(undefined); } };
        stores.forEach((store) => {
          const all = tx.objectStore(store).getAll();
          all.onerror = done;
          all.onsuccess = () => {
            all.result.forEach((value) => {
              const size = value instanceof Blob ? value.size
                : value instanceof ArrayBuffer ? value.byteLength : 0;
              if (size > 64 * 1024) plaintextBlobs.push(`${dbName}/${store}:${size}`);
            });
            done();
          };
        });
      };
    })));
    return { caches: caches_, plaintextBlobs };
  });
  Object.entries(storageProbe.caches).forEach(([name, count]) => {
    assert.equal(count, 0, `plaintext media cache ${name} has ${count} entries`);
  });
  assert.deepEqual(storageProbe.plaintextBlobs, [],
    `plaintext media-sized values in IndexedDB: ${storageProbe.plaintextBlobs.join(', ')}`);

  Object.entries(sessions).forEach(([name, session]) => {
    assert.deepEqual(session.errors, [], `${name} page errors: ${session.errors.join('; ')}`);
  });
  console.log('OK: длинное видео — миниатюра, перемотка без полной загрузки, PVB2 в облаке, подмена фрагмента '
    + '(середина, хвост, ответ в пути) ловится тегом чанка до декодера, открытых данных в Cache Storage нет');
} catch (err) {
  const dir = new URL('../web/telegram-tt/test-results/', import.meta.url).pathname;
  for (const [name, session] of Object.entries(sessions)) {
    await session.page.screenshot({ path: `${dir}video-stream-${name}.png` }).catch(() => {});
    await dumpDiagJournal(session.page, name);
  }
  if (integrityLog) console.error(`--- integrity bob ---\n${integrityLog.lines().join('\n')}`);
  if (eveIntegrityLog) console.error(`--- integrity eve ---\n${eveIntegrityLog.lines().join('\n')}`);
  if (seenChunkReplies) console.error(`--- eve chunk replies ---\n${JSON.stringify([...seenChunkReplies])}`);
  throw err;
} finally {
  integrityLog?.stop();
  eveIntegrityLog?.stop();
  await browser.close();
  rmSync(fixtureDir, { recursive: true, force: true });
}
