// Статья (ARTICLE-1, замена «Статьи» Telegram): заметка «Знаний» уходит в чат пунктом «Статья» меню вложений,
// у обоих — карточка с началом текста, «Читать» открывает окно чтения с разметкой (заголовок, список, жирный,
// ссылка), «Сохранить в заметки» кладёт копию в «Знания» получателя; пересылка — тоже статья; карточка переживает
// перезагрузку; открытого текста статьи нет в базах шардов.
// Запуск: scripts/run_web_article_e2e.sh
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { chromium } from '../web/telegram-tt/node_modules/playwright/index.mjs';

import {
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
    '', '> не опаздывать', '', '![[карта.png]]',
  ].join('\n');

  sessions.alice = await preparePage(aliceContext, alice, PASSWORD);
  sessions.bob = await preparePage(bobContext, bob, PASSWORD);
  for (const s of Object.values(sessions)) await dismissRecoveryKeyDialog(s.page).catch(() => undefined);
  await exchangeMessages(sessions.alice.page, alice, sessions.bob.page, bob, suffix);

  // ── Заметка у Алисы ────────────────────────────────────────────────────────
  const { page } = sessions.alice;
  const knowledge = page.locator('#ParvaneKnowledge');
  const note = knowledge.locator('[data-note-id]');
  await page.locator('#FoldersSidebar').getByRole('tab', { name: 'Knowledge' }).click();
  // Справка нового хранилища пишется сама — заметку создаём после неё, чтобы «Обзор» её не перебил
  await knowledge.locator('[data-note-row="Overview"]').first().waitFor({ state: 'visible', timeout: 60000 });
  await knowledge.getByRole('button', { name: 'New note' }).click();
  await note.first().waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await page.waitForTimeout(400);
  await note.getByLabel('Note title').fill(title);
  await note.getByLabel('Note title').blur();
  await knowledge.locator(`[data-note-row="${title}"]`).first().waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await note.getByRole('button', { name: 'Edit' }).click();
  await page.locator('#knowledge-note-editor').fill(markdown);
  await note.getByRole('button', { name: 'Save' }).click();
  await knowledge.locator(`[data-note-row="${title}"]`).getByText('Вещи').first()
    .waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  console.log('OK: заметка для статьи создана');

  // ── «Статья» в меню вложений: выбор заметки → карточка у обоих ─────────────
  await page.locator('#FoldersSidebar').getByRole('tab', { name: 'Chats' }).click();
  await showChatList(page);
  await openPrivateChatStrict(page, bob);
  await page.getByRole('button', { name: 'Add an attachment' }).click();
  if (SHOT_DIR) {
    await page.getByRole('menuitem', { name: 'Location', exact: true }).hover();
    await page.getByRole('menuitem', { name: 'Current location' }).waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
    await shoot(page, 'attach-menu');
  }
  await page.getByRole('menuitem', { name: 'Article', exact: true }).click();
  const picker = page.getByRole('dialog');
  await picker.locator('[data-article-search]').fill(title.slice(0, 8));
  await shoot(page, 'picker');
  await picker.locator(`[data-article-note="${title}"]`).click();
  await picker.waitFor({ state: 'hidden', timeout: STEP_TIMEOUT_MS });
  const aliceCard = page.locator(`.Transition_slide-active [data-article-card="${title}"]`).first();
  await aliceCard.waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  const bobPage = sessions.bob.page;
  const bobCard = bobPage.locator(`.Transition_slide-active [data-article-card="${title}"]`).first();
  await bobCard.waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  assert.match(await bobCard.innerText(), /палатка/, 'начало текста на карточке');
  await shoot(bobPage, 'card');
  console.log('OK: статья отправлена, карточка у обоих');

  // ── Окно чтения: разметка, картинка подписью, «Сохранить в заметки» ───────
  await bobCard.locator('[data-article-read] button').click();
  const viewer = bobPage.locator('[data-article-viewer]');
  await viewer.waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  const articleBody = viewer.locator('[data-article-body]');
  await articleBody.getByRole('heading', { name: 'Вещи' }).waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  assert.equal(await articleBody.locator('li').count(), 2, 'два пункта списка');
  assert.equal(await articleBody.locator('strong').filter({ hasText: 'спальник' }).count(), 1, 'жирный');
  assert.equal(await articleBody.locator('a[href="https://example.org/map"]').count(), 1, 'ссылка');
  assert.equal(await articleBody.locator('blockquote').count(), 1, 'цитата');
  assert.match(await articleBody.innerText(), /карта\.png/, 'картинка — подписью');
  assert.equal(await articleBody.getByRole('heading', { name: title }).count(), 0, 'заголовок-название не повторяется');
  await shoot(bobPage, 'viewer');
  await viewer.locator('[data-article-save] button').click();
  await bobPage.getByText(`Saved to notes: «${title}»`).first().waitFor({ state: 'visible', timeout: 60000 });
  // Escape забирает висящее уведомление «Сохранено» — окно закрывается крестиком
  await bobPage.locator('.Modal').filter({ has: viewer }).getByRole('button', { name: 'Close' }).click();
  await viewer.waitFor({ state: 'hidden', timeout: STEP_TIMEOUT_MS });
  await bobPage.locator('#FoldersSidebar').getByRole('tab', { name: 'Knowledge' }).click();
  const bobRow = bobPage.locator(`#ParvaneKnowledge [data-note-row="${title}"]`).first();
  await bobRow.waitFor({ state: 'visible', timeout: 60000 });
  await bobRow.click();
  await bobPage.locator('#ParvaneKnowledge [data-note-body]').getByText(secret, { exact: false }).first()
    .waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  console.log('OK: окно чтения с разметкой, статья сохранена в заметки получателя');

  // ── Пересылка: статья уходит статьёй, а не пропадает ─────────────────────
  await forwardMessage(page, title, bob);
  await bobPage.locator('#FoldersSidebar').getByRole('tab', { name: 'Chats' }).click();
  await showChatList(bobPage);
  await openPrivateChatStrict(bobPage, alice);
  await bobPage.waitForFunction((t) => document.querySelectorAll(
    `.Transition_slide-active [data-article-card="${t}"]`,
  ).length === 2, title, { timeout: STEP_TIMEOUT_MS }).catch(() => assert.fail('пересланная статья не дошла'));
  console.log('OK: пересланная статья — карточка статьи');

  // ── Перезагрузка: карточка на месте; открытого текста в базах нет ─────────
  await relogin(bobPage, PASSWORD);
  await showChatList(bobPage);
  await openPrivateChatStrict(bobPage, alice);
  await bobPage.locator(`.Transition_slide-active [data-article-card="${title}"]`).first()
    .waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  assert.deepEqual(plaintextLeaks([secret]), [], 'текст статьи в базах шардов');

  for (const [name, s] of Object.entries(sessions)) {
    assert.deepEqual(s.errors, [], `${name} page errors: ${s.errors.join('; ')}`);
  }
  console.log('OK: статья переживает перезагрузку, сервер видит только шифртекст');
} catch (err) {
  const dir = process.env.PARVANE_E2E_BACKEND_LOG_DIR || '.';
  for (const [name, s] of Object.entries(sessions)) {
    await s.page.screenshot({ path: `${dir}/article-${name}.png` }).catch(() => {});
  }
  throw err;
} finally {
  await browser.close();
}
