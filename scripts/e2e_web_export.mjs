// «Выгрузка данных»: Алиса и Боб переписываются (текст и фото), Алиса создаёт задачу в «Плане» и выгружает
// свои данные (Настройки → Конфиденциальность → «Export my data»). Архив собирается на устройстве и
// скачивается одним ZIP; сценарий распаковывает его и проверяет: в JSON чата с Бобом — сообщения обеих
// сторон и фото с файлом в `media/`, в «Плане» — задача, в корне — `index.html` и `contacts.json`.
// Отмена: вторая выгрузка с файлами облака отменяется кнопкой и показывает «отменено».
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { unzipSync } from '../web/telegram-tt/node_modules/fflate/esm/index.mjs';
import { chromium } from '../web/telegram-tt/node_modules/playwright/index.mjs';

import {
  assertNoPageErrors,
  exchangeMessages,
  findMessageContainers,
  LOGIN_TIMEOUT_MS,
  openPlannerScreen,
  openPrivateChatStrict,
  openSettingsScreen,
  preparePage,
  showChatList,
} from './e2e_web_helpers.mjs';

const PASSWORD = 'Parvane-export-e2e-password';
const EXPORT_TIMEOUT_MS = 120000;
// Маленькая картинка: 1×1 PNG
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

async function poll(read, isDone, message, timeout = LOGIN_TIMEOUT_MS) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    last = await read();
    if (isDone(last)) return last;
    await new Promise((resolve) => { setTimeout(resolve, 500); });
  }
  assert.fail(`${message}: ${JSON.stringify(last)?.slice(0, 400)}`);
}

async function attachPhoto(page, caption) {
  await page.getByRole('button', { name: 'Add an attachment' }).click();
  const fileChooserPromise = page.waitForEvent('filechooser');
  await page.getByRole('menuitem', { name: 'Photo or Video' }).click();
  const fileChooser = await fileChooserPromise;
  await fileChooser.setFiles({ name: 'export-e2e-photo.png', mimeType: 'image/png', buffer: PNG });
  const captionInput = page.locator('#editable-message-text-modal');
  await captionInput.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await captionInput.fill(caption);
  await captionInput.press('Enter');
  await captionInput.waitFor({ state: 'hidden', timeout: LOGIN_TIMEOUT_MS });
}

async function createPlannerTask(page, name) {
  const planner = await openPlannerScreen(page, 'calendar');
  await planner.getByRole('button', { name: '+ Entry', exact: true }).click();
  await page.locator('form[data-quick-kind]').getByRole('button', { name: 'More options' }).click();
  await page.locator('#planner-new-name').waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await page.locator('#planner-new-name').fill(name);
  await planner.getByLabel('Duration, min').fill('30');
  await planner.getByLabel('Start', { exact: true }).fill('10:00');
  await planner.getByRole('button', { name: 'Create', exact: true }).click();
  await planner.getByRole('heading', { name }).waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  // Задача дошла до движка «Плана» (выгрузка читает его состояние)
  await poll(
    () => page.evaluate(async () => {
      const state = await window.__parvaneDiagCallApi('parvanePlannerState');
      return state?.raw || '';
    }),
    (raw) => raw.includes(name),
    'задача в состоянии «Плана»',
  );
}

async function openExportDialog(page) {
  await showChatList(page);
  await openSettingsScreen(page, 'Privacy and Security');
  await page.locator('[data-export-open] .ListItem-button').click();
  const dialog = page.locator('[data-export-dialog]');
  await dialog.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  return dialog;
}

function isChecked(dialog, option) {
  return dialog.locator(`[data-export-option="${option}"] input[type="checkbox"]`).isChecked();
}

const browser = await chromium.launch();
const sessions = {};
const downloadDir = await mkdtemp(path.join(tmpdir(), 'parvane-export-e2e-'));

try {
  const suffix = `${Date.now()}-${process.pid}`;
  const tag = suffix.replace(/\D/g, '').slice(-8);
  const alice = `exp-a-${tag}@local`;
  const bob = `exp-b-${tag}@local`;
  const aliceNick = alice.split('@')[0];
  const bobNick = bob.split('@')[0];

  sessions.alice = await preparePage(await browser.newContext({ acceptDownloads: true }), alice, PASSWORD);
  sessions.bob = await preparePage(await browser.newContext(), bob, PASSWORD);
  const a = sessions.alice.page;
  const b = sessions.bob.page;

  // ── переписка: текст в обе стороны и фото от Боба ──
  await exchangeMessages(a, alice, b, bob, suffix);
  const caption = `export-photo-${suffix}`;
  await openPrivateChatStrict(b, alice);
  await attachPhoto(b, caption);
  await openPrivateChatStrict(a, bob);
  const photoBubble = findMessageContainers(a, caption).first();
  await photoBubble.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  console.log('OK: переписка с текстом и фото');

  // ── задача в «Плане» ──
  const taskName = `export-task-${tag}`;
  await createPlannerTask(a, taskName);
  console.log('OK: задача в «Плане»');

  // ── выгрузка ──
  const dialog = await openExportDialog(a);
  assert.equal(await isChecked(dialog, 'media'), true, 'медиа по умолчанию включены');
  assert.equal(await isChecked(dialog, 'cloud'), false, 'файлы облака по умолчанию выключены');
  const downloadPromise = a.waitForEvent('download', { timeout: EXPORT_TIMEOUT_MS });
  await dialog.locator('[data-export-start] button').click();
  const download = await downloadPromise;
  const doneBlock = dialog.locator('[data-export-done]');
  await doneBlock.waitFor({ state: 'visible', timeout: EXPORT_TIMEOUT_MS });
  const fileName = download.suggestedFilename();
  assert.match(fileName, new RegExp(`^parvane-export-${aliceNick}-\\d{4}-\\d{2}-\\d{2}\\.zip$`), `имя архива: ${fileName}`);
  assert.equal(await doneBlock.getAttribute('data-export-file-name'), fileName);
  assert.equal(await dialog.locator('[data-export-missing]').count(), 0, 'все вложения скачались');
  const zipPath = path.join(downloadDir, fileName);
  await download.saveAs(zipPath);
  console.log(`OK: архив скачан (${fileName})`);

  // ── содержимое архива ──
  const files = unzipSync(new Uint8Array(await readFile(zipPath)));
  const names = Object.keys(files);
  const text = (name) => new TextDecoder().decode(files[name]);
  assert.ok(files['index.html'], `нет index.html: ${names.join(', ')}`);
  assert.ok(files['contacts.json'], 'нет contacts.json');
  const contacts = JSON.parse(text('contacts.json')).contacts;
  assert.ok(contacts.some((c) => c.address.split('@')[0] === bobNick), `Боба нет в контактах: ${text('contacts.json')}`);

  const chatJsonName = names.find((name) => name.endsWith('/messages.json')
    && JSON.parse(text(name)).id.split('@')[0] === bobNick);
  assert.ok(chatJsonName, `нет JSON чата с Бобом: ${names.join(', ')}`);
  const chatDir = chatJsonName.slice(0, -'messages.json'.length);
  assert.ok(files[`${chatDir}messages.html`], 'нет HTML чата');
  const chatHref = `${chatDir}messages.html`.split('/').map((part) => encodeURIComponent(part)).join('/');
  assert.ok(text('index.html').includes(chatHref), `index.html не ссылается на чат ${chatHref}`);
  const chat = JSON.parse(text(chatJsonName));
  const texts = chat.messages.map((m) => m.text);
  assert.ok(texts.includes(`hello-from-a-${suffix}`), `нет сообщения Алисы: ${JSON.stringify(texts)}`);
  assert.ok(texts.includes(`hello-from-b-${suffix}`), `нет сообщения Боба: ${JSON.stringify(texts)}`);
  const photo = chat.messages.find((m) => m.text === caption);
  assert.ok(photo?.media, `нет фото с подписью: ${JSON.stringify(chat.messages)}`);
  assert.equal(photo.media.status, 'included', `фото не выгружено: ${JSON.stringify(photo.media)}`);
  assert.equal(photo.from_id.split('@')[0], bobNick, 'автор фото — Боб');
  const photoFile = files[`${chatDir}${photo.media.file}`];
  assert.ok(photoFile?.length > 0, `нет файла фото ${photo.media.file}`);
  const isImage = (photoFile[0] === 0x89 && photoFile[1] === 0x50) || (photoFile[0] === 0xff && photoFile[1] === 0xd8)
    || text(`${chatDir}${photo.media.file}`).startsWith('RIFF');
  assert.ok(isImage, 'файл фото — картинка (PNG/JPEG/WebP)');
  console.log('OK: в архиве чат с сообщениями и фото');

  assert.ok(files['planner/planner.json'], `нет «Плана»: ${names.join(', ')}`);
  assert.ok(text('planner/planner.json').includes(taskName), 'задачи нет в planner.json');
  console.log('OK: в архиве «План» с задачей');

  // ── отмена ── (диаг-сборка: задержка перед сбором данных, чтобы «Отмена» гарантированно пришлась на ход)
  await a.evaluate(() => localStorage.setItem('parvane:e2e:exportDelayMs', '8000'));
  await dialog.locator('[data-export-option="cloud"] label').click();
  assert.equal(await isChecked(dialog, 'cloud'), true, 'галочка облака включилась');
  await dialog.locator('[data-export-start] button').click();
  await dialog.locator('[data-export-progress]').waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await dialog.locator('[data-export-cancel] button').click();
  await dialog.locator('[data-export-error="canceled"]').waitFor({ state: 'visible', timeout: EXPORT_TIMEOUT_MS });
  assert.equal(await dialog.locator('[data-export-done]').count(), 0, 'отменённая выгрузка не скачивается');
  await a.evaluate(() => localStorage.removeItem('parvane:e2e:exportDelayMs'));
  console.log('OK: выгрузка отменяется');

  assertNoPageErrors(sessions);
  console.log('OK: сценарий выгрузки данных пройден');
} catch (error) {
  for (const [name, session] of Object.entries(sessions)) {
    console.log(`--- журнал ${name} ---\n${session.logs.slice(-60).join('\n')}`);
  }
  throw error;
} finally {
  await browser.close();
  await rm(downloadDir, { recursive: true, force: true });
}
