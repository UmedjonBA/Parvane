// Пара web2-android2 (spec 031, T040): web и Telegram X (alice, шов) — оба на протоколе v2. Запускается из
// `android/tgx_protocol_web_flow.sh` (стек, эмулятор и vite preview уже подняты).
// Проверяет: текст, фото и голосовое web → X (по маркеру входящего в logcat — текста сообщений там нет,
// P-46), ответ X → web через e2e-хук шва, группа v2 web → X (входящее в группу — чат с отрицательным id TDLib).
// Ревью 7 ноя 2026 (этап 2): голосовое и «кружок» X → web (путь рекордера X: PreliminaryUploadFile → InputFileId →
// FinishFileGeneration) — пузырь и воспроизведение; реакция web на сообщение X — X знает её и рисует значок;
// «Отправить без звука» web → X — уведомление X без звука; альбом X → web.
// Этап 4: MEDIA-2 (альбом одной группой в обе стороны, спойлер, подпись над медиа) и QUOTE-1 (ответ с цитатой) X → web.
// Строки `ok …` / `FAIL …` в stdout разбирает раннер.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { chromium } from '../web/telegram-tt/node_modules/playwright/index.mjs';

import {
  addReaction,
  buildPngBuffer,
  createGroupViaUi,
  dismissRecoveryKeyDialog,
  dumpDiagJournal,
  expectMediaFlowing,
  findMessage,
  findMessageContainer,
  LOGIN_TIMEOUT_MS,
  openGroupChatByTitle,
  openPrivateChatStrict,
  preparePage,
  sendText,
} from './e2e_web_helpers.mjs';

const PASSWORD = 'Parvane-v2-android-password';
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

async function waitCount(re, before, label) {
  const start = Date.now();
  while (Date.now() - start < X_TIMEOUT_MS) {
    if (incomingCount(re) > before) return;
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => { setTimeout(r, 2000); });
  }
  throw new Error(`${label}: нет в logcat X`);
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
// tt-плеер создаёт `new Audio()` вне DOM — считаем экземпляры (как e2e_protocol_mixed.mjs): голосовое реально играет
await context.addInitScript(() => {
  const NativeAudio = window.Audio;
  globalThis.__parvaneE2eAudios = [];
  window.Audio = class TrackedAudio extends NativeAudio {
    constructor(...args) {
      super(...args);
      globalThis.__parvaneE2eAudios.push(this);
    }
  };
});
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
  session = await preparePage(context, bob, PASSWORD);
  const { page } = session;
  const start = Date.now();
  while (!logs.some((l) => l.includes('v2: готов'))) {
    assert(Date.now() - start < LOGIN_TIMEOUT_MS, `web: v2 не поднялся (${logs.join(' | ')})`);
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => { setTimeout(r, 200); });
  }
  await dismissRecoveryKeyDialog(page);
  ok('web: bob на v2 (движок готов)');

  // web → X: текст
  await openPrivateChatStrict(page, ALICE);
  let before = incomingCount();
  const hello = `web-hello-${STAMP}`;
  await sendText(page, hello);
  await findMessage(page, hello).waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await waitIncoming(before, 'текст');
  ok('X: текст от web принят');

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

  // Звонки (T058, call-web2-android2): web → X (X принимает кнопкой — e2e-хук), затем X → web
  const X_INCOMING_CALL = /звонок: входящий/g;
  const X_CONNECTED = /ParvaneWebrtc.*соединение .*: (CONNECTED|COMPLETED)/g;
  await openPrivateChatStrict(page, ALICE);
  let callsBefore = incomingCount(X_INCOMING_CALL);
  let connectedBefore = incomingCount(X_CONNECTED);
  await page.getByRole('button', { name: 'Call', exact: true }).click();
  await waitCount(X_INCOMING_CALL, callsBefore, 'входящий звонок от web');
  xCommand({ op: 'call_accept', peer: bob });
  await waitCount(X_CONNECTED, connectedBefore, 'медиа звонка web → X');
  await page.getByText(/^\d+:\d{2}$/).first().waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await expectMediaFlowing(page, { audio: true });
  await page.getByRole('button', { name: 'End call' }).click();
  await page.getByRole('button', { name: 'End call' }).waitFor({ state: 'detached', timeout: LOGIN_TIMEOUT_MS });
  ok('звонок web → X соединился, звук идёт');
  connectedBefore = incomingCount(X_CONNECTED);
  xCommand({ op: 'call', peer: bob, video: false });
  await page.getByText('is calling you...', { exact: true }).waitFor({ state: 'visible', timeout: X_TIMEOUT_MS });
  await page.getByRole('button', { name: 'Accept' }).click();
  await waitCount(X_CONNECTED, connectedBefore, 'медиа звонка X → web');
  await page.getByText(/^\d+:\d{2}$/).first().waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await expectMediaFlowing(page, { audio: true });
  await page.getByRole('button', { name: 'End call' }).click();
  await page.getByRole('button', { name: 'End call' }).waitFor({ state: 'detached', timeout: LOGIN_TIMEOUT_MS });
  ok('звонок X → web соединился, звук идёт');

  // web → X: группа v2
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
  ok('X: групповое от web v2 пришло в чат группы');

  // Ревью 7 ноя (этап 2) — в конце, чтобы сбой новых шагов не скрыл прежние
  await openPrivateChatStrict(page, ALICE);
  // X → web: голосовое путём рекордера X (файл записи подменяет файл устройства, см. tgx_protocol_web_flow.sh)
  const voices = page.locator('.Transition_slide-active > .MessageList .Message .Audio');
  const voicesBefore = await voices.count();
  xCommand({ op: 'voice', peer: bob, path: '/data/local/tmp/pv-voice.ogg', duration: 2 });
  await voices.nth(voicesBefore).waitFor({ state: 'visible', timeout: X_TIMEOUT_MS });
  const voice = voices.last();
  await voice.locator('canvas').waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await page.evaluate(() => {
    globalThis.__parvaneE2eAudioMarks = (globalThis.__parvaneE2eAudios || []).map((audio) => audio.currentTime);
  });
  await voice.locator('.toggle-play').click();
  await page.waitForFunction(
    () => (globalThis.__parvaneE2eAudios || [])
      .some((audio, i) => audio.currentTime > (globalThis.__parvaneE2eAudioMarks[i] || 0) + 0.5),
    undefined,
    { timeout: LOGIN_TIMEOUT_MS },
  );
  await page.evaluate(() => (globalThis.__parvaneE2eAudios || []).forEach((audio) => audio.pause()));
  ok('web: голосовое из X пришло и играет');

  // X → web: «кружок» — видео расшифровано и читается браузером
  const rounds = page.locator('.Transition_slide-active > .MessageList .Message .RoundVideo');
  const roundsBefore = await rounds.count();
  xCommand({ op: 'video_note', peer: bob, path: '/data/local/tmp/pv-round.mp4', duration: 2 });
  await rounds.nth(roundsBefore).waitFor({ state: 'visible', timeout: X_TIMEOUT_MS });
  const roundVideo = rounds.last().locator('video');
  await roundVideo.waitFor({ state: 'attached', timeout: LOGIN_TIMEOUT_MS });
  await page.waitForFunction(
    () => [...document.querySelectorAll('.Transition_slide-active > .MessageList .Message .RoundVideo video')]
      .some((v) => v.readyState >= 1 && v.duration > 0.5),
    undefined,
    { timeout: LOGIN_TIMEOUT_MS },
  );
  ok('web: «кружок» из X пришёл и читается');

  // web → X: реакция на сообщение X — X знает её (мета сообщения) и даёт значок реакции
  await addReaction(page, reply, '👍');
  const reactStart = Date.now();
  let reactLine = '';
  while (Date.now() - reactStart < X_TIMEOUT_MS) {
    xCommand({ op: 'reactions', peer: bob, text: reply });
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => { setTimeout(r, 4000); });
    reactLine = (adb('logcat', '-d').match(/реакции сообщения: [^\n]*/g) || []).pop() || '';
    if (/1f44d=1 значок/.test(reactLine)) break;
  }
  assert.match(reactLine, /1f44d=1 значок/, `X: реакция web не видна (${reactLine})`);
  ok('X: реакция web на сообщение X видна, значок есть');

  // X → web: реакция из меню X (GetMessageAvailableReactions → AddMessageReaction) — web её показывает
  xCommand({ op: 'react', peer: bob, text: hello, emoji: '🔥' });
  await findMessageContainer(page, hello).locator('.message-reaction').filter({ hasText: '🔥' })
    .waitFor({ state: 'visible', timeout: X_TIMEOUT_MS });
  assert.match((adb('logcat', '-d').match(/реакции: меню [0-9]+, значок [^\n]*/g) || []).pop() || '', /меню 2[0-9], значок есть/);
  ok('web: реакция X видна; меню реакций X не пусто');

  // web → X: «Отправить без звука» (меню кнопки отправки) — у X уведомление без звука
  const silentBefore = incomingCount(/входящее без звука/g);
  const quiet = `web-quiet-${STAMP}`;
  const quietComposer = page.locator('.Transition_slide-active #editable-message-text[contenteditable="true"]').last();
  await quietComposer.fill(quiet);
  await page.getByRole('button', { name: 'Send Message', exact: true }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Send Without Sound' }).click();
  await findMessage(page, quiet).waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await waitCount(/входящее без звука/g, silentBefore, 'сообщение без звука');
  ok('X: сообщение web «без звука» — уведомление без звука');

  // X → web: альбом из двух фото (ответ — у первого), под спойлером и с подписью над медиа (MEDIA-2)
  const albumCaption = `x-album-${STAMP}`;
  xCommand({
    op: 'album', peer: bob, paths: ['/data/local/tmp/pv-a1.png', '/data/local/tmp/pv-a2.png'], caption: albumCaption, reply: hello,
    spoiler: true, above: true,
  });
  await findMessageContainer(page, albumCaption).waitFor({ state: 'visible', timeout: X_TIMEOUT_MS });
  await waitCount(/альбом: отправлено 2 из 2/g, 0, 'альбом X');
  ok('web: альбом X пришёл');
  // MEDIA-2: у web оба фото — одна группа (groupedId), под спойлером, подпись над медиа
  const fromAlice = () => page.evaluate(({ alice, caption }) => {
    const g = window.__parvaneGetGlobal();
    const user = Object.values(g.users.byId).find((u) => u.usernames?.some(({ username }) => username === alice.split('@')[0]));
    const byId = user && g.messages.byChatId[user.id]?.byId;
    if (!byId) return undefined;
    const all = Object.values(byId);
    const head = all.find((m) => m.content?.text?.text === caption);
    if (!head) return undefined;
    const group = head.groupedId ? all.filter((m) => m.groupedId === head.groupedId) : [head];
    return {
      size: group.length,
      spoilers: group.filter((m) => m.content?.photo?.isSpoiler).length,
      inverted: Boolean(head.isInvertedMedia),
    };
  }, { alice: ALICE, caption: albumCaption });
  let albumOnWeb;
  for (let i = 0; i < 20 && !(albumOnWeb?.size === 2); i++) {
    // eslint-disable-next-line no-await-in-loop
    albumOnWeb = await fromAlice();
    // eslint-disable-next-line no-await-in-loop
    if (albumOnWeb?.size !== 2) await page.waitForTimeout(1000);
  }
  assert.deepEqual(albumOnWeb, { size: 2, spoilers: 2, inverted: true }, `web: альбом X ${JSON.stringify(albumOnWeb)}`);
  ok('web: альбом X — одна группа, под спойлером, подпись над медиа (MEDIA-2)');

  // QUOTE-1: X отвечает цитатой на сообщение web → у web ответ с цитатой
  const quoted = `x-quote-${STAMP}`;
  xCommand({ op: 'quote_reply', peer: bob, to_text: hello, quote: 'web-hello', text: quoted });
  await findMessage(page, quoted).waitFor({ state: 'visible', timeout: X_TIMEOUT_MS });
  const quoteOnWeb = await page.evaluate(({ alice, text }) => {
    const g = window.__parvaneGetGlobal();
    const user = Object.values(g.users.byId).find((u) => u.usernames?.some(({ username }) => username === alice.split('@')[0]));
    const m = user && Object.values(g.messages.byChatId[user.id]?.byId || {}).find((x) => x.content?.text?.text === text);
    return m?.replyInfo?.quoteText?.text;
  }, { alice: ALICE, text: quoted });
  assert.equal(quoteOnWeb, 'web-hello', 'web: цитата ответа X');
  ok('web: ответ X с цитатой (QUOTE-1)');

  // web → X: альбом из двух фото — у X одна группа (media_album_id)
  const webAlbum = `web-album-${STAMP}`;
  await page.getByRole('button', { name: 'Add an attachment' }).click();
  const albumChooser = page.waitForEvent('filechooser');
  await page.getByRole('menuitem', { name: 'Photo or Video' }).click();
  await (await albumChooser).setFiles([
    { name: 'a1.png', mimeType: 'image/png', buffer: buildPngBuffer(80) },
    { name: 'a2.png', mimeType: 'image/png', buffer: buildPngBuffer(88) },
  ]);
  const albumInput = page.locator('#editable-message-text-modal');
  await albumInput.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await albumInput.fill(webAlbum);
  await albumInput.press('Enter');
  await findMessageContainer(page, webAlbum).waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  let grouped = false;
  for (let i = 0; i < 12 && !grouped; i++) {
    const n = incomingCount(/альбом-проверка: в группе 2/g);
    xCommand({ op: 'album_check', peer: bob, caption: webAlbum });
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => { setTimeout(r, 5000); });
    grouped = incomingCount(/альбом-проверка: в группе 2/g) > n;
  }
  assert.ok(grouped, 'X: альбом web не собран в одну группу');
  ok('X: альбом web — одна группа (MEDIA-2)');

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
