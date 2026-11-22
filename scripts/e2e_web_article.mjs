// Статья (ARTICLE-1, замена «Статьи» Telegram): заметка «Знаний» уходит в чат пунктом «Статья» меню вложений,
// картинка и видео, вставленные в заметку («Вставить файл» → облако рядом с заметкой, `![[имя]]`), показываются в
// заметке и после перезагрузки, едут в статье вложениями и сохраняются в облако получателя (этап 6 плана 15 окт);
// у обоих — карточка с началом текста, «Читать» открывает окно чтения с разметкой (заголовок, список, жирный,
// ссылка), «Сохранить в заметки» кладёт копию в «Знания» получателя; пересылка — тоже статья; карточка переживает
// перезагрузку; открытого текста статьи нет в базах шардов.
// Запуск: scripts/run_web_article_e2e.sh
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { chromium } from '../web/telegram-tt/node_modules/playwright/index.mjs';

import {
  buildPngBuffer,
  dismissRecoveryKeyDialog,
  exchangeMessages,
  forwardMessage,
  openPrivateChatStrict,
  preparePage,
  relogin,
  showChatList,
} from './e2e_web_helpers.mjs';

const PASSWORD = 'Parvane-article-e2e-1';
const WIDE = { width: 1440, height: 900 };
const STEP_TIMEOUT_MS = 30000;
const BACKEND_DIR = process.env.PARVANE_E2E_BACKEND_LOG_DIR;
const SHOT_DIR = process.env.PARVANE_E2E_SHOT_DIR;

// Снимок для просмотра глазами — только при заданном каталоге
async function shoot(page, name) {
  if (!SHOT_DIR) return;
  // Окна и карточки появляются с анимацией — снимок после неё
  await page.waitForTimeout(600);
  await page.screenshot({ path: `${SHOT_DIR}/article-${name}.png` });
}
assert(BACKEND_DIR, 'PARVANE_E2E_BACKEND_LOG_DIR is required');

function plaintextLeaks(words) {
  const leaks = new Set();
  for (const file of readdirSync(BACKEND_DIR)) {
    if (!/\.db(-wal)?$/.test(file)) continue;
    const text = readFileSync(join(BACKEND_DIR, file)).toString('utf8');
    for (const word of words) if (text.includes(word)) leaks.add(`${file}:${word}`);
  }
  return [...leaks];
}

// Короткое видео VP9 в WebM: Chromium Playwright без H.264
function makeWebm() {
  const path = join(mkdtempSync(join(tmpdir(), 'pv-article-')), 'clip.webm');
  execFileSync('ffmpeg', [
    '-y', '-f', 'lavfi', '-i', 'testsrc=duration=2:size=320x240:rate=15',
    '-c:v', 'libvpx-vp9', '-b:v', '120k', '-pix_fmt', 'yuv420p', path,
  ], { stdio: 'ignore' });
  return readFileSync(path);
}

// Встроенный файл показан: картинка — `<img>` с декодированным изображением, видео — проигрыватель по нажатию
async function expectImageEmbed(root, name) {
  const image = root.locator(`[data-md-embed="${name}"] [data-embed-state="image"] img`);
  await image.waitFor({ state: 'visible', timeout: 60000 });
  await root.page().waitForFunction((el) => el.complete && el.naturalWidth > 0, await image.elementHandle(), {
    timeout: STEP_TIMEOUT_MS,
  });
}

async function expectVideoEmbed(root, name) {
  const embed = root.locator(`[data-md-embed="${name}"]`);
  await embed.getByRole('button', { name: /Play/ }).click();
  const video = embed.locator('[data-embed-state="player"] video');
  await video.waitFor({ state: 'attached', timeout: 60000 });
  await root.page().waitForFunction((el) => el.readyState >= 1 && el.videoWidth > 0, await video.elementHandle(), {
    timeout: STEP_TIMEOUT_MS,
  });
}

const browser = await chromium.launch();
const aliceContext = await browser.newContext({ viewport: WIDE });
const bobContext = await browser.newContext({ viewport: WIDE });
const sessions = {};

try {
  const suffix = `${Date.now().toString(36)}-${process.pid}`;
  const alice = `article-alice-${suffix}@local`;
  const bob = `article-bob-${suffix}@local`;
  const title = `Поход-${suffix}`;
  const secret = `костёр-${suffix}`;
  const markdown = [
    `# ${title}`, '', '## Вещи', '- палатка', '- **спальник**', '', `Сбор у [вокзала](https://example.org/map) — ${secret}`,
    '', '> не опаздывать', '', '| Что | Сколько |', '|---|---:|', '| вода | 2 л |',
  ].join('\n');

  sessions.alice = await preparePage(aliceContext, alice, PASSWORD);
  sessions.bob = await preparePage(bobContext, bob, PASSWORD);
  for (const s of Object.values(sessions)) await dismissRecoveryKeyDialog(s.page).catch(() => undefined);
  await exchangeMessages(sessions.alice.page, alice, sessions.bob.page, bob, suffix);

  // ── Заметка у Алисы ────────────────────────────────────────────────────────
  const { page } = sessions.alice;
  const knowledge = page.locator('#ParvaneKnowledge');
  const note = knowledge.locator('[data-note-id]');
  await page.locator('#FoldersSidebar').getByRole('tab', { name: 'Notes' }).click();
  // Справка нового хранилища пишется сама — заметку создаём после неё, чтобы «Обзор» её не перебил
  await knowledge.locator('[data-note-row="Overview"]').first().waitFor({ state: 'visible', timeout: 60000 });
  await page.locator('#FoldersSidebar [data-add-for="notes"]').click();
  await note.first().waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await page.waitForTimeout(400);
  await note.getByLabel('Note title').fill(title);
  await note.getByLabel('Note title').blur();
  await knowledge.locator(`[data-note-row="${title}"]`).first().waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await note.getByRole('button', { name: 'Edit' }).first().click();
  const editor = page.locator('#knowledge-note-editor');
  await editor.fill(markdown);
  // Картинка и видео — «Вставить файл»: файлы ложатся в облако рядом с заметкой, в текст — `![[имя]]`
  await editor.evaluate((el) => el.setSelectionRange(el.value.length, el.value.length));
  await note.locator('[data-note-insert-input]').setInputFiles([
    { name: 'карта.png', mimeType: 'image/png', buffer: buildPngBuffer(96, [200, 120, 40]) },
    { name: 'клип.webm', mimeType: 'video/webm', buffer: makeWebm() },
  ]);
  await page.waitForFunction(() => {
    const value = document.querySelector('#knowledge-note-editor')?.value || '';
    return value.includes('![[карта.png]]') && value.includes('![[клип.webm]]');
  }, undefined, { timeout: 60000 }).catch(() => assert.fail('файлы не вставились в текст заметки'));
  await note.getByRole('button', { name: 'Save' }).first().click();
  await knowledge.locator(`[data-note-row="${title}"]`).getByText('Вещи').first()
    .waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  const noteBody = note.locator('[data-note-body]');
  await expectImageEmbed(noteBody, 'карта.png');
  // Картинка открывается на весь экран просмотром «Файлов» (доска `ZpNotesX`)
  await noteBody.locator('[data-md-embed="карта.png"] [data-embed-open]').click();
  await page.locator('[data-preview-kind="photo"]').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS })
    .catch(() => assert.fail('картинка заметки не открылась на весь экран'));
  await shoot(page, 'note-image-open');
  await page.keyboard.press('Escape');
  await page.locator('[data-preview-kind]').waitFor({ state: 'hidden', timeout: STEP_TIMEOUT_MS })
    .catch(() => assert.fail('просмотр картинки не закрылся'));
  // Длительность небольшого видео — на кадре до воспроизведения
  await noteBody.locator('[data-md-embed="клип.webm"] [data-embed-duration]').filter({ hasText: '0:02' })
    .waitFor({ state: 'visible', timeout: 60000 }).catch(() => assert.fail('нет длительности видео на кадре'));
  await expectVideoEmbed(noteBody, 'клип.webm');
  assert.equal(await noteBody.locator('table td').filter({ hasText: '2 л' }).count(), 1, 'таблица в заметке');
  await shoot(page, 'note-media');
  // Перезагрузка: файлы берутся из облака заново. Раздел переживает перезагрузку — хелпер ждёт список чатов
  await page.locator('#FoldersSidebar').getByRole('tab', { name: 'Chats' }).click();
  // Диагностика зависшей перезагрузки: диалог ухода со страницы и неотправленные сообщения
  page.on('dialog', (dialog) => console.log(`диалог ${dialog.type()}: ${dialog.message()}`));
  const pending = await page.evaluate(() => {
    const g = window.__parvaneGetGlobal?.();
    if (!g) return 'нет global';
    return Object.values(g.messages.byChatId).flatMap((c) => Object.values(c.byId || {}))
      .filter((m) => m.sendingState).map((m) => `${m.id}:${m.sendingState}`);
  }).catch((e) => String(e));
  console.log(`перед перезагрузкой: неотправленные ${JSON.stringify(pending)}`);
  await relogin(page, PASSWORD);
  await page.locator('#FoldersSidebar').getByRole('tab', { name: 'Notes' }).click();
  await knowledge.locator(`[data-note-row="${title}"]`).first().click();
  await expectImageEmbed(note.locator('[data-note-body]'), 'карта.png');
  console.log('OK: заметка с картинкой, видео и таблицей; картинка после перезагрузки');

  // ── «Статья» в меню вложений: выбор заметки → карточка у обоих ─────────────
  await page.locator('#FoldersSidebar').getByRole('tab', { name: 'Chats' }).click();
  await showChatList(page);
  await openPrivateChatStrict(page, bob);
  await page.getByRole('button', { name: 'Add an attachment' }).click();
  if (SHOT_DIR) {
    await page.getByRole('menuitem', { name: 'Location', exact: true }).waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
    await shoot(page, 'attach-menu');
  }
  await page.getByRole('menuitem', { name: 'Article', exact: true }).click();
  const picker = page.getByRole('dialog');
  await picker.locator('[data-article-search]').fill(title.slice(0, 8));
  await shoot(page, 'picker');
  // «Отправить заметку» (доска `RpPick`): заметка с галочкой, «Статьёй», кнопка «Отправить «название»»
  await picker.locator(`[data-article-note="${title}"]`).click();
  await picker.locator('[data-article-send]').click();
  await picker.waitFor({ state: 'hidden', timeout: STEP_TIMEOUT_MS });
  const aliceCard = page.locator(`.Transition_slide-active [data-article-card="${title}"]`).first();
  await aliceCard.waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  const bobPage = sessions.bob.page;
  const bobCard = bobPage.locator(`.Transition_slide-active [data-article-card="${title}"]`).first();
  await bobCard.waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  assert.match(await bobCard.innerText(), /палатка/, 'начало текста на карточке');
  await shoot(bobPage, 'card');
  console.log('OK: статья отправлена, карточка у обоих');

  // ── То же из меню заметки: «Отправить статьёй в чат» → выбор чата ─────────
  await page.locator('#FoldersSidebar').getByRole('tab', { name: 'Notes' }).click();
  await knowledge.locator(`[data-note-row="${title}"]`).first().click();
  await note.locator('[data-note-menu]').first().click();
  await page.locator('[data-note-menu-list] [data-note-action="article"]').click();
  const recipients = page.locator('.Modal').filter({ has: page.locator('.ChatOrUserPicker-item') });
  await recipients.locator('.ChatOrUserPicker-item').filter({ hasText: bob.split('@')[0] }).first().click();
  await page.getByText('Sent to chat as article').first().waitFor({ state: 'visible', timeout: 60000 })
    .catch(() => assert.fail('статья из меню заметки не ушла'));
  await bobPage.waitForFunction((wanted) => (
    document.querySelectorAll(`.Transition_slide-active [data-article-card="${wanted}"]`).length >= 2
  ), title, { timeout: 60000 }).catch(() => assert.fail('вторая статья (из меню заметки) не дошла до Боба'));
  await page.locator('#FoldersSidebar').getByRole('tab', { name: 'Chats' }).click();
  console.log('OK: статья из меню заметки');

  // ── Окно чтения: разметка, картинка подписью, «Сохранить в заметки» ───────
  await bobCard.locator('[data-article-read] button').click();
  const viewer = bobPage.locator('[data-article-viewer]');
  await viewer.waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  const articleBody = viewer.locator('[data-article-body]');
  await articleBody.getByRole('heading', { name: 'Вещи' }).waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  assert.equal(await articleBody.locator('li').count(), 2, 'два пункта списка');
  assert.equal(await articleBody.locator('strong').filter({ hasText: 'спальник' }).count(), 1, 'жирный');
  assert.equal(await articleBody.locator('a[href="https://example.org/map"]').count(), 1, 'ссылка');
  // C7-4: подпись «вокзала» не совпадает с адресом — переход только через окно с настоящим адресом, вкладка сама
  // не открывается
  let popups = 0;
  const onPopup = () => {
    popups += 1;
  };
  bobPage.context().on('page', onPopup);
  await articleBody.locator('a[href="https://example.org/map"]').click();
  // Окно SafeLinkModal (новый Modal Web A, без класса `.Modal`) — по тексту с настоящим адресом
  const safeLink = bobPage.getByText('Do you want to open https://example.org/map', { exact: false });
  await safeLink.waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS }).catch(async (e) => {
    const modals = await bobPage.locator('[role="dialog"]').allInnerTexts().catch(() => []);
    console.log(`C7-4: окна ${JSON.stringify(modals).slice(0, 2000)}, вкладок открыто ${popups}`);
    if (SHOT_DIR) await bobPage.screenshot({ path: `${SHOT_DIR}/article-safelink-fail.png` });
    throw e;
  });
  await bobPage.waitForTimeout(500);
  assert.equal(popups, 0, 'ссылка с другой подписью не открылась без подтверждения');
  await bobPage.getByRole('button', { name: 'Cancel', exact: true }).last().click();
  await safeLink.waitFor({ state: 'hidden', timeout: STEP_TIMEOUT_MS });
  bobPage.context().off('page', onPopup);
  await viewer.waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  console.log('OK: ссылка статьи с другой подписью — через окно подтверждения (C7-4)');
  assert.equal(await articleBody.locator('blockquote').count(), 1, 'цитата');
  await expectImageEmbed(articleBody, 'карта.png');
  await expectVideoEmbed(articleBody, 'клип.webm');
  assert.equal(await articleBody.locator('table td').filter({ hasText: '2 л' }).count(), 1, 'таблица в статье');
  assert.equal(await articleBody.getByRole('heading', { name: title }).count(), 0, 'заголовок-название не повторяется');
  await shoot(bobPage, 'viewer');
  await bobPage.locator('[data-article-save] button').click();
  await bobPage.getByText(`Saved to notes: «${title}»`).first().waitFor({ state: 'visible', timeout: 60000 });
  // Статья — экран на весь экран (доска `XpChat`): «Переслать» внизу, закрывается стрелкой «Назад»
  // (Escape забирает висящее уведомление «Сохранено»)
  await bobPage.locator('[data-article-forward]').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  // «Ещё» в шапке статьи (доска `XpChat`): сохранить, переслать, скопировать текст, показать в чате
  await bobPage.locator('[data-article-more]').click();
  for (const action of ['save', 'forward', 'copy', 'chat']) {
    await bobPage.locator(`[data-note-action="${action}"]`).waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  }
  await bobPage.locator('[data-note-action="copy"]').click();
  await bobPage.getByText('Article text copied').first().waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await bobPage.locator('.Modal').filter({ has: viewer }).getByRole('button', { name: 'Back' }).click();
  await viewer.waitFor({ state: 'hidden', timeout: STEP_TIMEOUT_MS });
  await bobPage.locator('#FoldersSidebar').getByRole('tab', { name: 'Notes' }).click();
  const bobRow = bobPage.locator(`#ParvaneKnowledge [data-note-row="${title}"]`).first();
  await bobRow.waitFor({ state: 'visible', timeout: 60000 });
  await bobRow.click();
  await bobPage.locator('#ParvaneKnowledge [data-note-body]').getByText(secret, { exact: false }).first()
    .waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  // Файлы статьи — в облаке получателя: картинка заметки читается с его диска
  await expectImageEmbed(bobPage.locator('#ParvaneKnowledge [data-note-body]'), 'карта.png');
  console.log('OK: окно чтения с разметкой и файлами, статья с файлами сохранена в заметки получателя');

  // ── Пересылка: статья уходит статьёй, а не пропадает (третья карточка: вторая — из меню заметки) ──
  await forwardMessage(page, title, bob);
  await bobPage.locator('#FoldersSidebar').getByRole('tab', { name: 'Chats' }).click();
  await showChatList(bobPage);
  await openPrivateChatStrict(bobPage, alice);
  await bobPage.waitForFunction((t) => document.querySelectorAll(
    `.Transition_slide-active [data-article-card="${t}"]`,
  ).length === 3, title, { timeout: STEP_TIMEOUT_MS }).catch(() => assert.fail('пересланная статья не дошла'));
  console.log('OK: пересланная статья — карточка статьи');

  // ── Перезагрузка: карточка на месте; открытого текста в базах нет ─────────
  await relogin(bobPage, PASSWORD);
  await showChatList(bobPage);
  await openPrivateChatStrict(bobPage, alice);
  await bobPage.locator(`.Transition_slide-active [data-article-card="${title}"]`).first()
    .waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  assert.deepEqual(plaintextLeaks([secret]), [], 'текст статьи в базах шардов');

  // «Заметки» выключены на устройстве: «В заметки» в окне чтения на месте и ведёт в лист «Модуль выключен» (E6)
  await bobPage.evaluate(() => {
    const prefs = {
      order: ['chats', 'profile'], off: [], healthBlocks: [], ...JSON.parse(localStorage.getItem('parvane:modules') || '{}'),
    };
    localStorage.setItem('parvane:modules', JSON.stringify({ ...prefs, off: [...prefs.off, 'notes'] }));
  });
  await relogin(bobPage, PASSWORD);
  await showChatList(bobPage);
  await openPrivateChatStrict(bobPage, alice);
  const offCard = bobPage.locator(`.Transition_slide-active [data-article-card="${title}"]`).first();
  await offCard.waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await offCard.locator('[data-article-read] button').click();
  await bobPage.locator('[data-article-save] button').click();
  const notesOff = bobPage.locator('[data-module-off="notes"]');
  await notesOff.waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await notesOff.getByRole('button', { name: 'Not now' }).click();
  await notesOff.waitFor({ state: 'hidden', timeout: STEP_TIMEOUT_MS });
  await viewer.waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  console.log('OK: окно чтения при выключенных «Заметках» — лист «Модуль выключен»');

  // ── Пропавший файл в заметке: «файл не найден — удалён или перемещён» и «Выбрать заново» (доска `ZpNotesX`) ──
  await page.locator('#FoldersSidebar').getByRole('tab', { name: 'Notes' }).click();
  await knowledge.locator(`[data-note-row="${title}"]`).first().click();
  await note.getByRole('button', { name: 'Edit' }).first().click();
  await editor.waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  // Обычный файл — карточкой «файл с диска · размер» и текстовой «Скачать» (доска `PhNotesMore`)
  await editor.evaluate((el) => el.setSelectionRange(el.value.length, el.value.length));
  await note.locator('[data-note-insert-input]').setInputFiles([
    { name: 'список.txt', mimeType: 'text/plain', buffer: Buffer.from('палатка\nспальник\n') },
  ]);
  await page.waitForFunction(() => (document.querySelector('#knowledge-note-editor')?.value || '').includes('![[список.txt]]'),
    undefined, { timeout: 60000 }).catch(() => assert.fail('текстовый файл не вставился в заметку'));
  await editor.fill(`${await editor.inputValue()}\n\n![[старая-карта.png|схема]]\n`);
  await note.getByRole('button', { name: 'Save' }).first().click();
  const fileCard = noteBody.locator('[data-md-embed="список.txt"] [data-embed-state="file"]');
  await fileCard.waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS }).catch(() => assert.fail('нет карточки файла'));
  assert.match(await fileCard.locator('[data-embed-meta]').innerText(), /^file from the drive · \d/, 'подпись карточки файла');
  assert.equal(await fileCard.locator('[data-embed-download]').innerText(), 'Download', '«Скачать» текстом');
  const missing = noteBody.locator('[data-md-embed="старая-карта.png"] [data-embed-state="missing"]');
  await missing.waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS })
    .catch(() => assert.fail('нет карточки пропавшего файла'));
  assert.ok((await missing.innerText()).includes('file not found — deleted or moved'), 'текст пропавшего файла');
  await shoot(page, 'note-file-missing');
  // Те же вложения на телефоне (доска `ZpNotesX-03`)
  if (SHOT_DIR) {
    const size = page.viewportSize();
    await page.setViewportSize({ width: 360, height: 800 });
    await page.waitForTimeout(1500);
    await missing.scrollIntoViewIfNeeded().catch(() => undefined);
    await shoot(page, 'note-media-phone');
    await page.setViewportSize(size);
    await page.waitForTimeout(1500);
  }
  await missing.locator('[data-embed-repick]').click();
  const fileRow = page.locator('[data-canvas-file-row="карта.png"]');
  // Файл лежит рядом с заметкой — в папке хранилища заметок: открыть папки по пути
  for (let depth = 0; depth < 3 && !(await fileRow.count()); depth++) {
    await page.locator('[data-canvas-file-row]').first().click();
    await page.waitForTimeout(300);
  }
  await fileRow.click();
  await page.waitForFunction(() => {
    const body = document.querySelector('#ParvaneKnowledge [data-note-body]');
    return body && !body.querySelector('[data-embed-state="missing"]')
      && [...body.querySelectorAll('[data-md-embed]')].some((item) => item.getAttribute('data-md-embed')?.endsWith('/карта.png'));
  }, undefined, { timeout: STEP_TIMEOUT_MS }).catch(() => assert.fail('«Выбрать заново» не заменило файл в заметке'));
  console.log('OK: картинка на весь экран, длительность видео, «Выбрать заново» у пропавшего файла');

  for (const [name, s] of Object.entries(sessions)) {
    assert.deepEqual(s.errors, [], `${name} page errors: ${s.errors.join('; ')}`);
  }
  console.log('OK: статья переживает перезагрузку, сервер видит только шифртекст');
} catch (err) {
  const dir = process.env.PARVANE_E2E_BACKEND_LOG_DIR || '.';
  for (const [name, s] of Object.entries(sessions)) {
    await s.page.screenshot({ path: `${dir}/article-${name}.png` }).catch(() => {});
    console.log(`--- ${name} (журнал провайдера) ---\n${(s.logs || []).slice(-80).join('\n')}`);
  }
  throw err;
} finally {
  await browser.close();
}
