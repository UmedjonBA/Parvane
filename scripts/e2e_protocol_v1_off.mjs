// Протокол v2 (spec 007, T134/T167, FR-056 — этап E6): сервер с ОТКЛЮЧЁННЫМ v1
// (gateway PARVANE_V1_MODE=disabled). JSON-соединение v1 получает
// `upgrade_required` и закрывается, поэтому всё, что делает клиент, идёт
// методами v2: регистрация и вход, поиск собеседника, профиль, текст и фото в
// обе стороны, возобновление сессии после перезагрузки, превью ссылки (шард
// preview), звонок (ICE-серверы и запечатанные сигналы), группа v2 и её фото
// (открытый блоб). Клиент при этом НЕ показывает «обновите приложение» — он
// работоспособен.
// Запуск: scripts/run_protocol_mixed_e2e.sh v1-off
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import zlib from 'node:zlib';

import { chromium } from '../web/telegram-tt/node_modules/playwright/index.mjs';

import {
  closeRightColumn,
  createGroupViaUi,
  dismissRecoveryKeyDialog,
  dumpDiagJournal,
  expectMediaFlowing,
  findMessage,
  findMessageContainer,
  LOGIN_TIMEOUT_MS,
  openGroupChatByTitle,
  openGroupManagement,
  openPrivateChatStrict,
  preparePage,
  reloadPage,
  sendText,
} from './e2e_web_helpers.mjs';

const PASSWORD = 'Parvane-v2-e2e-password';
const V2_SEED = { 'parvane:proto': 'v2' };

function crc32(bytes) {
  let crc = ~0;
  for (let i = 0; i < bytes.length; i++) {
    crc ^= bytes[i];
    for (let bit = 0; bit < 8; bit++) {
      crc = (crc >>> 1) ^ (0xEDB88320 & -(crc & 1));
    }
  }
  return ~crc >>> 0;
}

function pngChunk(type, data) {
  const body = Buffer.concat([Buffer.from(type, 'ascii'), Buffer.from(data)]);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

function makeSolidPng(size, [r, g, b]) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(size * 3)]);
  for (let x = 0; x < size; x++) {
    row[1 + x * 3] = r;
    row[2 + x * 3] = g;
    row[3 + x * 3] = b;
  }
  const raw = Buffer.concat(Array.from({ length: size }, () => row));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw)),
    pngChunk('IEND', new Uint8Array(0)),
  ]);
}

async function attachFile(page, menuItemName, file, caption) {
  await page.getByRole('button', { name: 'Add an attachment' }).click();
  const fileChooserPromise = page.waitForEvent('filechooser');
  await page.getByRole('menuitem', { name: menuItemName }).click();
  const fileChooser = await fileChooserPromise;
  await fileChooser.setFiles(file);
  const captionInput = page.locator('#editable-message-text-modal');
  await captionInput.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await captionInput.fill(caption);
  await captionInput.press('Enter');
  await captionInput.waitFor({ state: 'hidden', timeout: LOGIN_TIMEOUT_MS });
}

// Композер открытого чата (после создания группы в DOM два чата — переход)
async function sendInActiveChat(page, text) {
  const composer = page.locator('.Transition_slide-active #editable-message-text').last();
  await composer.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await composer.fill(text);
  await composer.press('Enter');
}

// Фото группы — открытый блоб (без capability): в v2 его кладёт и отдаёт
// метод v2, грантов v1 нет
async function setGroupPhoto(page, title, file) {
  const right = await openGroupManagement(page, title);
  const input = right.locator('.AvatarEditable input[type="file"]');
  await input.waitFor({ state: 'attached', timeout: LOGIN_TIMEOUT_MS });
  await input.setInputFiles(file);
  const cropDialog = page.locator('.Modal.CropModal .modal-dialog');
  await cropDialog.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await cropDialog.locator('button').last().click();
  await cropDialog.waitFor({ state: 'hidden', timeout: LOGIN_TIMEOUT_MS });
  await right.getByRole('button', { name: 'Save', exact: true }).last().click();
  await page.waitForFunction(() => {
    const fab = document.querySelector('#RightColumn .FloatingActionButton');
    return !fab || !fab.classList.contains('revealed');
  }, undefined, { timeout: LOGIN_TIMEOUT_MS });
  await closeRightColumn(page);
}

const browser = await chromium.launch({
  args: [
    '--use-fake-ui-for-media-stream',
    '--use-fake-device-for-media-stream',
    '--autoplay-policy=no-user-gesture-required',
    // Звонок между двумя вкладками: без флага Chromium с выданным mic-разрешением
    // фильтрует loopback-кандидаты
    '--allow-loopback-in-peer-connection',
  ],
});
const aliceContext = await browser.newContext({ permissions: ['microphone'] });
const bobContext = await browser.newContext({ permissions: ['microphone'] });
const logs = { alice: [], bob: [] };
const consoleTail = { alice: [], bob: [] };
// Кадры, ушедшие JSON-соединением v1 (op + subject): при отключённом v1 клиент
// не должен слать по нему ничего, кроме попытки авторизации
const v1Frames = { alice: [], bob: [] };

function trackContext(context, who) {
  context.on('page', (page) => {
    page.on('console', (m) => {
      const t = m.text();
      if (t.includes('[parvane]')) logs[who].push(t.slice(0, 300));
      consoleTail[who].push(`${m.type()}: ${t.slice(0, 300)}`);
      if (consoleTail[who].length > 80) consoleTail[who].shift();
    });
    page.on('pageerror', (e) => consoleTail[who].push(`pageerror: ${String(e).slice(0, 500)}`));
    page.on('websocket', (ws) => ws.on('framesent', ({ payload }) => {
      if (typeof payload !== 'string') return;
      try {
        const frame = JSON.parse(payload);
        if (frame.op) v1Frames[who].push(`${frame.op}${frame.subject ? ` ${frame.subject}` : ''}`);
      } catch {
        // не JSON-кадр v1
      }
    }));
  });
}
trackContext(aliceContext, 'alice');
trackContext(bobContext, 'bob');

async function waitLog(who, needle, timeout = LOGIN_TIMEOUT_MS) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (logs[who].some((l) => l.includes(needle))) return;
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => { setTimeout(r, 200); });
  }
  throw new Error(`${who}: нет записи «${needle}» (журнал: ${logs[who].slice(-40).join(' | ')})`);
}

let aliceSession;
let bobSession;
try {
  const suffix = `${Date.now()}-${process.pid}`;
  const alice = `off-a-${suffix}@local`;
  const bob = `off-b-${suffix}@local`;

  // Регистрация и вход — методами v2 до авторизации (канал PRE)
  aliceSession = await preparePage(aliceContext, alice, PASSWORD, { seedLocalStorage: V2_SEED });
  bobSession = await preparePage(bobContext, bob, PASSWORD, { seedLocalStorage: V2_SEED });
  await waitLog('alice', 'v2: готов');
  await waitLog('bob', 'v2: готов');
  await waitLog('alice', 'соединения v1 нет');
  await dismissRecoveryKeyDialog(aliceSession.page);
  await dismissRecoveryKeyDialog(bobSession.page);

  // Поиск собеседника (identity.directory.search) и профиль (identity.profile.resolve)
  await openPrivateChatStrict(aliceSession.page, bob);
  await openPrivateChatStrict(bobSession.page, alice);

  const hello = `off-hello-${suffix}`;
  await sendText(aliceSession.page, hello);
  await findMessage(bobSession.page, hello).waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  const answer = `off-answer-${suffix}`;
  await sendText(bobSession.page, answer);
  await findMessage(aliceSession.page, answer).waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });

  // Фото: блоб по секрету capability, v1-гранты не нужны
  const photoCaption = `off-photo-${suffix}`;
  await attachFile(aliceSession.page, 'Photo or Video', {
    name: 'off.png', mimeType: 'image/png', buffer: makeSolidPng(96, [40, 160, 90]),
  }, photoCaption);
  const photo = findMessageContainer(bobSession.page, photoCaption);
  await photo.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await photo.locator('img.full-media').waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });

  // Возобновление сессии после перезагрузки: история на месте, переписка идёт
  await reloadPage(aliceSession.page);
  await waitLog('alice', 'v2: готов');
  await openPrivateChatStrict(aliceSession.page, bob).catch(() => undefined);
  await findMessage(aliceSession.page, answer).waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  const afterReload = `off-after-reload-${suffix}`;
  await sendText(bobSession.page, afterReload);
  await findMessage(aliceSession.page, afterReload).waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });

  // Превью ссылки: запрос к шарду preview идёт методом v2 (машине нужен
  // интернет). Первое сообщение прогревает кэш шарда, как в content_ux
  await sendText(aliceSession.page, 'warm https://example.com first');
  await aliceSession.page.waitForTimeout(3000);
  await sendText(aliceSession.page, 'see https://example.com now');
  const bobWebPage = bobSession.page.locator('.Transition_slide-active > .MessageList .Message .WebPage').last();
  await bobWebPage.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  assert.match(await bobWebPage.locator('.site-name').innerText(), /example\.com/, 'превью ссылки без имени сайта');

  // Звонок: ICE-серверы — методом v2, сигналы — запечатанными конвертами;
  // соединяется, звук идёт в обе стороны, SAS совпадает
  await aliceSession.page.getByRole('button', { name: 'Call', exact: true }).click();
  await bobSession.page.getByText('is calling you...', { exact: true })
    .waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await bobSession.page.getByRole('button', { name: 'Accept' }).click();
  const aliceSas = aliceSession.page.locator('[title*="fully secure"]');
  const bobSas = bobSession.page.locator('[title*="fully secure"]');
  await aliceSas.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await bobSas.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await expectMediaFlowing(aliceSession.page, { audio: true });
  await expectMediaFlowing(bobSession.page, { audio: true });
  assert.equal((await aliceSas.innerText()).trim(), (await bobSas.innerText()).trim(), 'SAS звонка не совпал');
  await aliceSession.page.getByRole('button', { name: 'End Call' }).click();
  for (const session of [aliceSession, bobSession]) {
    await session.page.getByRole('button', { name: 'End Call' })
      .waitFor({ state: 'detached', timeout: LOGIN_TIMEOUT_MS });
  }

  // Группа v2: создание, сообщения в обе стороны, фото группы
  const title = `Off-${suffix.slice(-6)}`;
  await createGroupViaUi(aliceSession.page, title, [bob.split('@')[0]]);
  await waitLog('alice', 'v2: группа создана');
  await openGroupChatByTitle(bobSession.page, title);
  await openGroupChatByTitle(aliceSession.page, title);
  const groupHello = `off-group-${suffix}`;
  await sendText(aliceSession.page, groupHello);
  await findMessage(bobSession.page, groupHello).waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  const groupAnswer = `off-group-answer-${suffix}`;
  await sendInActiveChat(bobSession.page, groupAnswer);
  await findMessage(aliceSession.page, groupAnswer).waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await setGroupPhoto(aliceSession.page, title, {
    name: 'group.png', mimeType: 'image/png', buffer: makeSolidPng(96, [200, 80, 40]),
  });
  await bobSession.page.waitForFunction(() => {
    const img = document.querySelector('.MiddleHeader .ChatInfo .Avatar img');
    return Boolean(img && img.getAttribute('src'));
  }, undefined, { timeout: LOGIN_TIMEOUT_MS });

  // По проводу v1 не ушло ничего, кроме попытки авторизации
  for (const who of ['alice', 'bob']) {
    const extra = v1Frames[who].filter((frame) => !frame.startsWith('auth'));
    assert.deepEqual(extra, [], `${who}: по соединению v1 ушли кадры`);
  }
  // Диалога «обновите приложение» нет
  for (const [who, session] of [['alice', aliceSession], ['bob', bobSession]]) {
    assert.equal(await session.page.getByText(/update the app|обновите приложение/i).count(), 0,
      `${who}: показан диалог обновления`);
  }
  // Сервер: в таблице сообщений v1 пусто, по v1 никто не авторизовался
  const backendDir = process.env.PARVANE_E2E_BACKEND_LOG_DIR;
  if (backendDir) {
    const v1Messages = Number(execFileSync('sqlite3', [join(backendDir, 'messenger.db'), 'SELECT COUNT(*) FROM messages'])
      .toString().trim());
    assert.equal(v1Messages, 0, `в таблице сообщений v1 есть строки (${v1Messages})`);
  }
  for (const who of ['alice', 'bob']) {
    assert.ok(!logs[who].some((l) => l.includes('запуск не удался')), `${who}: ${logs[who].slice(-20).join(' | ')}`);
  }
  console.log('e2e_protocol_v1_off: OK');
} catch (error) {
  const shotDir = process.env.PARVANE_E2E_SHOT_DIR || 'web/telegram-tt/test-results';
  for (const [who, session] of [['alice', aliceSession], ['bob', bobSession]]) {
    if (!session) continue;
    await session.page.screenshot({ path: `${shotDir}/protocol-v1-off-${who}.png` }).catch(() => undefined);
    await dumpDiagJournal(session.page, who);
  }
  console.error(`консоль alice:\n${consoleTail.alice.join('\n')}\nконсоль bob:\n${consoleTail.bob.join('\n')}`);
  console.error(`кадры v1 alice: ${v1Frames.alice.join(', ')}\nbob: ${v1Frames.bob.join(', ')}`);
  console.error(`журнал alice: ${logs.alice.slice(-60).join('\n')}\nbob: ${logs.bob.slice(-60).join('\n')}`);
  throw error;
} finally {
  await browser.close();
}
