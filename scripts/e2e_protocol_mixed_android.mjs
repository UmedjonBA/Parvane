// Протокол v2 (spec 007, T039): пара web2-android1. Web (bob) на v2, Telegram X
// (alice, шов) на v1 в эмуляторе — у alice нет журнала устройств v2, поэтому web
// обязан говорить с ней по v1 (D-13). Запускается из
// `android/tgx_protocol_web_flow.sh` (стек, эмулятор и vite preview уже подняты).
// Проверяет: текст и фото web → X (по маркеру входящего в logcat — текста
// сообщений там нет, P-46), ответ X → web через e2e-хук шва. T139: голосовое
// web → X и группа web → X (web обязан собрать группу v1 — у alice нет v2;
// входящее в группу — чат с отрицательным id TDLib).
// Строки `ok …` / `FAIL …` в stdout разбирает раннер.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { chromium } from '../web/telegram-tt/node_modules/playwright/index.mjs';

import {
  buildPngBuffer,
  createGroupViaUi,
  dismissRecoveryKeyDialog,
  dumpDiagJournal,
  findMessage,
  findMessageContainer,
  LOGIN_TIMEOUT_MS,
  openGroupChatByTitle,
  openPrivateChatStrict,
  preparePage,
  sendText,
} from './e2e_web_helpers.mjs';

const PASSWORD = 'Parvane-v2-android-password';
const V2_SEED = { 'parvane:proto': 'v2' };
const OUT = process.env.PV_ANDROID_OUT;
const STAMP = process.env.PV_STAMP || String(Date.now());
const ALICE = 'alice@local';
const INCOMING = /сообщение [0-9a-f-]{36} → чат [0-9-]+ \(вх\)/g;
const GROUP_INCOMING = /сообщение [0-9a-f-]{36} → чат -[0-9]+ \(вх\)/g;
const VOICE_RECORD_MS = 2500;
const X_TIMEOUT_MS = 90000;

function adb(...args) {
  return execFileSync('adb', args, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, timeout: 60000 });
}

function incomingCount(re = INCOMING) {
  return (adb('logcat', '-d').match(re) || []).length;
}

async function waitIncoming(before, label, re = INCOMING) {
  const start = Date.now();
  while (Date.now() - start < X_TIMEOUT_MS) {
    if (incomingCount(re) > before) return;
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => { setTimeout(r, 3000); });
  }
  throw new Error(`${label}: входящее не дошло до чата X`);
}

// Команда e2e-хука шва: файл читается раз в 3 с
function xCommand(command) {
  const file = join(OUT, 'cmd');
  writeFileSync(file, JSON.stringify(command));
  adb('push', file, '/data/local/tmp/parvane-e2e-cmd');
  adb('shell', 'chmod', '644', '/data/local/tmp/parvane-e2e-cmd');
}

function ok(text) {
  console.log(`ok ${text}`);
}

const browser = await chromium.launch({
  args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
});
const context = await browser.newContext({ permissions: ['microphone'] });
const logs = [];
const consoleTail = [];
context.on('page', (page) => {
  page.on('console', (m) => {
    const t = m.text();
    if (t.includes('[parvane] v2')) logs.push(t);
    consoleTail.push(`${m.type()}: ${t.slice(0, 300)}`);
    if (consoleTail.length > 60) consoleTail.shift();
  });
  page.on('pageerror', (e) => consoleTail.push(`pageerror: ${String(e).slice(0, 300)}`));
});
let session;
try {
  assert(OUT, 'PV_ANDROID_OUT is required');
  const bob = `wab-${STAMP}@local`;
  session = await preparePage(context, bob, PASSWORD, { seedLocalStorage: V2_SEED });
  const { page } = session;
  const start = Date.now();
  while (!logs.some((l) => l.includes('v2: готов'))) {
    assert(Date.now() - start < LOGIN_TIMEOUT_MS, `web: v2 не поднялся (${logs.join(' | ')})`);
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => { setTimeout(r, 200); });
  }
  await dismissRecoveryKeyDialog(page);
  ok('web: bob на v2 (движок готов)');

  // web → X: текст (по v1 — журнала v2 у alice нет)
  await openPrivateChatStrict(page, ALICE);
  let before = incomingCount();
  const hello = `web-hello-${STAMP}`;
  await sendText(page, hello);
  await findMessage(page, hello).waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await waitIncoming(before, 'текст');
  ok('X: текст от web v2 принят (v1-путь, D-13)');

  // X → web: ответ через e2e-хук шва (штатный SendMessage)
  const reply = `x-reply-${STAMP}`;
  xCommand({ op: 'send', peer: bob, text: reply });
  await findMessage(page, reply).waitFor({ state: 'visible', timeout: X_TIMEOUT_MS });
  ok('web: ответ из X получен и расшифрован');

  // web → X: фото (E2E-блоб в cloud)
  before = incomingCount();
  const caption = `web-photo-${STAMP}`;
  await page.getByRole('button', { name: 'Add an attachment' }).click();
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('menuitem', { name: 'Photo or Video' }).click();
  await (await chooser).setFiles({ name: 'picture.png', mimeType: 'image/png', buffer: buildPngBuffer(96) });
  const captionInput = page.locator('#editable-message-text-modal');
  await captionInput.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await captionInput.fill(caption);
  await captionInput.press('Enter');
  await findMessageContainer(page, caption).waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await waitIncoming(before, 'фото');
  ok('X: фото от web v2 принято');

  // web → X: голосовое (fake-микрофон; E2E-блоб в cloud)
  before = incomingCount();
  await page.getByRole('button', { name: 'Record voice message' }).click();
  const sendButton = page.getByRole('button', { name: 'Send Message', exact: true });
  await sendButton.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await page.waitForTimeout(VOICE_RECORD_MS);
  await sendButton.click();
  await waitIncoming(before, 'голосовое');
  ok('X: голосовое от web v2 принято');

  // web → X: группа (v1 — у alice нет журнала устройств v2, D-13)
  const title = `WX-${STAMP.slice(-6)}`;
  await createGroupViaUi(page, title, ['alice']);
  await openGroupChatByTitle(page, title);
  before = incomingCount(GROUP_INCOMING);
  const groupText = `web-group-${STAMP}`;
  const composer = page.locator('.Transition_slide-active #editable-message-text[contenteditable="true"]').last();
  await composer.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await composer.fill(groupText);
  await composer.press('Enter');
  await waitIncoming(before, 'группа', GROUP_INCOMING);
  assert.ok(!logs.some((l) => l.includes('v2: группа создана')), 'web создал группу v2 с участником на v1');
  ok('X: групповое от web v2 пришло в чат группы');

  assert.ok(!logs.some((l) => l.includes('запуск не удался')), `web: ${logs.join(' | ')}`);
  console.log('e2e_protocol_mixed_android: OK');
} catch (error) {
  console.log(`FAIL ${String(error?.message || error).split('\n')[0]}`);
  if (session) {
    await session.page.screenshot({ path: join(OUT || '.', 'web-bob.png') }).catch(() => undefined);
    await dumpDiagJournal(session.page, 'bob');
  }
  await context.pages()[0]?.screenshot({ path: join(OUT || '.', 'web-bob.png') }).catch(() => undefined);
  console.error(`консоль bob:\n${consoleTail.join('\n')}`);
  console.error(`v2 журнал bob: ${logs.join('\n')}`);
  throw error;
} finally {
  await browser.close();
}
