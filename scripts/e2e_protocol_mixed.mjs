// Протокол v2 (spec 007, T040): переписка двух web-клиентов на v2 (WASM-движок,
// sealed-доставка). Пара задаётся PARVANE_E2E_PAIR (web2-web2 — оба на v2;
// web2-web1 — второй на v1: v2-клиент обязан говорить с ним по v1).
// Проверяет: текст в обе стороны, ответ, реакцию, правку, закреп, удаление;
// что v2-путь действительно использован (журнал провайдера «v2: готов» и
// отсутствие v1-отправки для v2-собеседника), фото и голосовое в обе стороны.
// Пара web2-web2 — ещё и режим чата «усиленная приватность» (L2, FR-036,
// правило L2-1). Пара web2-web1 — группа из v2- и v1-участника (идёт по v1) и
// переход второго клиента на v2: история до перехода читается (SC-002).
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import zlib from 'node:zlib';

import { chromium } from '../web/telegram-tt/node_modules/playwright/index.mjs';

import {
  dismissRecoveryKeyDialog,
  LOGIN_TIMEOUT_MS,
  addReaction,
  createGroupViaUi,
  deleteMessage,
  expectMediaFlowing,
  dumpDiagJournal,
  editText,
  findMessage,
  findMessageContainer,
  openGroupChatByTitle,
  openPrivateChatStrict,
  pinMessage,
  preparePage,
  reloadPage,
  sendText,
} from './e2e_web_helpers.mjs';

const PASSWORD = 'Parvane-v2-e2e-password';
const PAIR = process.env.PARVANE_E2E_PAIR || 'web2-web2';
const V2_SEED = { 'parvane:proto': 'v2' };

// Фото (T040): те же помощники, что в e2e_web_media_ttl.mjs
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

// Голосовое (T040): запись через fake-микрофон, как в e2e_web_voice.mjs
const VOICE_RECORD_MS = 2500;

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
// tt-плеер создаёт `new Audio()` вне DOM — считаем экземпляры, чтобы проверить
// настоящее воспроизведение расшифрованного блоба, а не только пузырь
for (const context of [aliceContext, bobContext]) {
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
}
const logs = { alice: [], bob: [] };
const consoleTail = { alice: [], bob: [] };
// Эфемерные публикации в v1-шину (typing/presence) — для правила L2-1
const ephemeralSent = { alice: [], bob: [] };
// Сигналы звонков, ушедшие v1-путём (call.signal): у пары v2 их быть не должно
const callSignalsV1 = { alice: [], bob: [] };

// Консоль слушаем с создания страницы (до входа): иначе ошибки входа не видны
function trackContext(context, who) {
  context.on('page', (page) => {
    page.on('console', (m) => {
      const t = m.text();
      if (t.includes('[parvane] v2')) logs[who].push(t);
      consoleTail[who].push(`${m.type()}: ${t.slice(0, 300)}`);
      if (consoleTail[who].length > 80) consoleTail[who].shift();
    });
    page.on('pageerror', (e) => consoleTail[who].push(`pageerror: ${String(e).slice(0, 500)}`));
    page.on('websocket', (ws) => ws.on('framesent', ({ payload }) => {
      if (typeof payload !== 'string') return;
      try {
        const frame = JSON.parse(payload);
        if (frame.op === 'pub' && /^(msg\.typing\.|presence\.)/.test(frame.subject || '')) {
          ephemeralSent[who].push(frame.subject);
        }
        if (frame.op === 'pub' && frame.subject === 'call.signal') callSignalsV1[who].push(frame.subject);
      } catch {
        // не JSON-кадр v1 — не наш случай
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
  throw new Error(`${who}: нет записи «${needle}» (журнал v2: ${logs[who].join(' | ')})`);
}

function voiceBubbles(page) {
  return page.locator('.Transition_slide-active > .MessageList .Message .Audio');
}

// Отправитель записывает голосовое; у получателя появляется новый voice-пузырь
// с waveform и длительностью, блоб расшифровывается и реально играет
async function sendVoiceAndCheck(senderPage, receiverPage, label) {
  const before = await voiceBubbles(receiverPage).count();
  await senderPage.getByRole('button', { name: 'Record voice message' }).click();
  const sendButton = senderPage.getByRole('button', { name: 'Send Message', exact: true });
  await sendButton.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await senderPage.waitForTimeout(VOICE_RECORD_MS);
  await sendButton.click();
  await voiceBubbles(receiverPage).nth(before).waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  const bubble = voiceBubbles(receiverPage).last();
  await bubble.locator('canvas').waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  const durationText = await bubble.locator('.voice-duration').innerText();
  assert.match(durationText, /0:0[1-9]/, `${label}: длительность голосового (${durationText})`);
  // Плеер создаёт Audio при отрисовке пузыря (до клика) — сверяем продвижение
  // позиции относительно снимка, а не «новые экземпляры после клика»
  await receiverPage.evaluate(() => {
    globalThis.__parvaneE2eAudioMarks = (globalThis.__parvaneE2eAudios || []).map((audio) => audio.currentTime);
  });
  await bubble.locator('.toggle-play').click();
  await receiverPage.waitForFunction(
    () => (globalThis.__parvaneE2eAudios || [])
      .some((audio, i) => audio.currentTime > (globalThis.__parvaneE2eAudioMarks[i] || 0) + 0.5),
    undefined,
    { timeout: LOGIN_TIMEOUT_MS },
  );
  // Дальше по сценарию звук не нужен; пауза — чтобы следующий снимок был стабилен
  await receiverPage.evaluate(() => (globalThis.__parvaneE2eAudios || []).forEach((audio) => audio.pause()));
}

// Звонок между v2-клиентами (T089): сигналинг — запечатанными конвертами по
// анонимному каналу (D-08), на v1-шину `call.signal` не уходит ничего. Звонок
// соединяется, звук идёт в обе стороны, SAS совпадает
async function runV2CallScenario(alicePage, bobPage) {
  const before = { alice: callSignalsV1.alice.length, bob: callSignalsV1.bob.length };
  await alicePage.getByRole('button', { name: 'Call', exact: true }).click();
  await bobPage.getByText('is calling you...', { exact: true }).waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await bobPage.getByRole('button', { name: 'Accept' }).click();
  const aliceSas = alicePage.locator('[title*="fully secure"]');
  const bobSas = bobPage.locator('[title*="fully secure"]');
  await aliceSas.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await bobSas.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await expectMediaFlowing(alicePage, { audio: true });
  await expectMediaFlowing(bobPage, { audio: true });
  assert.equal((await aliceSas.innerText()).trim(), (await bobSas.innerText()).trim(), 'SAS звонка не совпал');
  await alicePage.getByRole('button', { name: 'End Call' }).click();
  await alicePage.getByRole('button', { name: 'End Call' }).waitFor({ state: 'detached', timeout: LOGIN_TIMEOUT_MS });
  await bobPage.getByRole('button', { name: 'End Call' }).waitFor({ state: 'detached', timeout: LOGIN_TIMEOUT_MS });
  assert.deepEqual(callSignalsV1.alice.slice(before.alice), [], 'alice: сигналы звонка ушли v1-путём');
  assert.deepEqual(callSignalsV1.bob.slice(before.bob), [], 'bob: сигналы звонка ушли v1-путём');
  // История: сервер v2-звонки не записывает (D-08) — запись делает сам клиент
  // и кладёт в журнал личного состояния
  await callEntry(alicePage, 'Outgoing Call').waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await callEntry(bobPage, 'Incoming Call').waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
}

function callEntry(page, text) {
  return page.locator('.Transition_slide-active > .MessageList .Message').filter({ hasText: text }).first();
}

// Композер открытого чата (после перехода между чатами в DOM их два)
async function sendInActiveChat(page, text) {
  const composer = page.locator('.Transition_slide-active #editable-message-text[contenteditable="true"]').last();
  await composer.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await composer.fill(text);
  await composer.press('Enter');
}

// ── режим «усиленная приватность» (L2) ──────────────────────────────────────

const TYPING_SETTLE_MS = 4000;

function serviceMessage(page, text) {
  return page.locator('.Transition_slide-active > .MessageList .ActionMessage').filter({ hasText: text });
}

function l2Row(page) {
  return page.locator('#RightColumn .ListItem').filter({ hasText: 'Enhanced privacy' });
}

async function openChatProfile(page) {
  if (!(await l2Row(page).isVisible().catch(() => false))) {
    await page.locator('.MiddleHeader .ChatInfo').first().click();
  }
  await l2Row(page).waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
}

async function typeDraft(page, text) {
  const input = page.locator('#editable-message-text[contenteditable="true"]');
  await input.click();
  await input.pressSequentially(text, { delay: 120 });
}

async function clearDraft(page) {
  await page.locator('#editable-message-text[contenteditable="true"]').fill('');
}

function typingStatus(page) {
  return page.locator('.MiddleHeader .typing-status');
}

// A включает режим в профиле чата → служебное сообщение у обоих → B видит
// «включена собеседником» → A печатает, у B нет «печатает», в шину не уходит
// ни typing, ни presence → A выключает → служебное сообщение у обоих
async function runL2Scenario(alicePage, bobPage) {
  // Контроль: без режима «печатает» доходит (иначе проверка ниже ничего не значит)
  await typeDraft(alicePage, 'typing-before-l2');
  await typingStatus(bobPage).waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await clearDraft(alicePage);
  await typingStatus(bobPage).waitFor({ state: 'hidden', timeout: LOGIN_TIMEOUT_MS });

  await openChatProfile(alicePage);
  await l2Row(alicePage).locator('.ListItem-button').click();
  await serviceMessage(alicePage, 'You enabled enhanced privacy')
    .waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await serviceMessage(bobPage, 'enabled enhanced privacy')
    .waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  assert.equal(await l2Row(alicePage).locator('input[type="checkbox"]').isChecked(), true,
    'alice: переключатель показывает своё предпочтение');

  // У B режим активен из-за собеседника: подпись есть, свой переключатель выключен
  await openChatProfile(bobPage);
  await l2Row(bobPage).getByText('Turned on by the other participant')
    .waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  assert.equal(await l2Row(bobPage).locator('input[type="checkbox"]').isChecked(), false,
    'bob: своё предпочтение не включено');

  // L2-1: typing не уходит и не показывается, присутствие не публикуется.
  // Окно короче периода presence (30 с): здесь ловится в основном typing,
  // запрет публикации presence покрыт юнит-тестом `l2.test.ts`
  const sentBefore = { alice: ephemeralSent.alice.length, bob: ephemeralSent.bob.length };
  await typeDraft(alicePage, 'typing-under-l2');
  await typeDraft(bobPage, 'typing-under-l2');
  await alicePage.waitForTimeout(TYPING_SETTLE_MS);
  assert.equal(await typingStatus(bobPage).count(), 0, 'bob: «печатает» в L2-чате не показывается');
  assert.equal(await typingStatus(alicePage).count(), 0, 'alice: «печатает» в L2-чате не показывается');
  assert.deepEqual(ephemeralSent.alice.slice(sentBefore.alice), [], 'alice: typing/presence ушли в шину при L2');
  assert.deepEqual(ephemeralSent.bob.slice(sentBefore.bob), [], 'bob: typing/presence ушли в шину при L2');
  await clearDraft(alicePage);
  await clearDraft(bobPage);

  // Сообщения в режиме по-прежнему ходят
  const underL2 = `v2-under-l2-${Date.now()}`;
  await sendText(alicePage, underL2);
  await findMessage(bobPage, underL2).waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });

  // A выключает: служебное сообщение у обоих, подпись у B пропадает
  await openChatProfile(alicePage);
  await l2Row(alicePage).locator('.ListItem-button').click();
  await serviceMessage(alicePage, 'You disabled enhanced privacy')
    .waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await serviceMessage(bobPage, 'disabled enhanced privacy')
    .waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await l2Row(bobPage).getByText('Turned on by the other participant')
    .waitFor({ state: 'hidden', timeout: LOGIN_TIMEOUT_MS });

  // Режим снят — «печатает» снова доходит
  await typeDraft(alicePage, 'typing-after-l2');
  await typingStatus(bobPage).waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await clearDraft(alicePage);

  // T127: в v2-чате «печатает» идёт эфемерным каналом v2 — кадров v1 с открытыми
  // `{from, to}` нет ни у кого
  for (const who of ['alice', 'bob']) {
    assert.deepEqual(ephemeralSent[who].filter((subject) => subject.startsWith('msg.typing.')), [],
      `${who}: «печатает» ушло v1-кадром`);
  }
}

let aliceSession;
let bobSession;
try {
  const suffix = `${Date.now()}-${process.pid}`;
  const alice = `v2a-${suffix}@local`;
  const bob = `v2b-${suffix}@local`;
  const bobIsV2 = PAIR === 'web2-web2';

  aliceSession = await preparePage(aliceContext, alice, PASSWORD, { seedLocalStorage: V2_SEED });
  bobSession = await preparePage(bobContext, bob, PASSWORD, { seedLocalStorage: bobIsV2 ? V2_SEED : {} });
  await waitLog('alice', 'v2: готов');
  if (bobIsV2) await waitLog('bob', 'v2: готов');
  const aliceRecovery = await dismissRecoveryKeyDialog(aliceSession.page);
  assert.ok(aliceRecovery, 'alice: не показан ключ восстановления нового корня v2');
  if (bobIsV2) await dismissRecoveryKeyDialog(bobSession.page);

  await openPrivateChatStrict(aliceSession.page, bob);
  await openPrivateChatStrict(bobSession.page, alice);

  // Текст в обе стороны.
  const hello = `v2-hello-${suffix}`;
  await sendText(aliceSession.page, hello);
  await findMessage(bobSession.page, hello).waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  const answer = `v2-answer-${suffix}`;
  await sendText(bobSession.page, answer);
  await findMessage(aliceSession.page, answer).waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });

  // Реакция, закреп, правка, удаление — E2E-содержимое (FR-035).
  await addReaction(bobSession.page, hello, '👍');
  await findMessageContainer(aliceSession.page, hello).locator('.message-reaction').filter({ hasText: '👍' })
    .waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await pinMessage(aliceSession.page, hello);
  await bobSession.page.locator('.HeaderPinnedMessageWrapper').filter({ hasText: hello })
    .waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  const edited = `v2-edited-${suffix}`;
  await editText(aliceSession.page, hello, edited);
  await findMessage(bobSession.page, edited).waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await deleteMessage(bobSession.page, answer);
  await findMessage(aliceSession.page, answer).waitFor({ state: 'detached', timeout: LOGIN_TIMEOUT_MS });

  // Фото по v2: блоб в cloud (E2E-ключ внутри sealed-конверта), у получателя
  // картинка расшифрована
  const photoCaption = `v2-photo-${suffix}`;
  await attachFile(aliceSession.page, 'Photo or Video', {
    name: 'picture.png', mimeType: 'image/png', buffer: makeSolidPng(96, [30, 120, 210]),
  }, photoCaption);
  const bobPhoto = findMessageContainer(bobSession.page, photoCaption);
  await bobPhoto.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await bobPhoto.locator('img[src^="blob:"]').first().waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });

  // Голосовое в обе стороны: блоб в cloud, у получателя расшифрован и играет
  await sendVoiceAndCheck(aliceSession.page, bobSession.page, 'alice → bob');
  await sendVoiceAndCheck(bobSession.page, aliceSession.page, 'bob → alice');

  // T131 (FR-062): блобы v2-чата грузятся без per-recipient гранта — секрет
  // скачивания внутри E2E, получатель качает анонимным каналом. В cloud нет
  // записей «файл → получатель»; у пары с v1-участником гранты остаются
  const backendDir = process.env.PARVANE_E2E_BACKEND_LOG_DIR;
  if (backendDir) {
    const count = (sql) => Number(execFileSync('sqlite3', [join(backendDir, 'cloud.db'), sql]).toString().trim());
    const files = count('SELECT COUNT(*) FROM files');
    const grants = count('SELECT COUNT(*) FROM file_grants');
    assert.ok(files >= 3, `в cloud меньше трёх блобов (${files})`);
    if (bobIsV2) assert.equal(grants, 0, `cloud хранит гранты получателям для блобов v2-чата (${grants})`);
    else assert.ok(grants >= 1, 'пара с v1-участником: блоб без гранта получателю');
  }

  if (bobIsV2) await runL2Scenario(aliceSession.page, bobSession.page);
  if (bobIsV2) await runV2CallScenario(aliceSession.page, bobSession.page);

  // Группа из v2- и v1-участника: журнала устройств v2 у bob нет, группа обязана
  // создаться по v1 (Megolm) и работать в обе стороны
  const groupTitle = `GM-${suffix.slice(-6)}`;
  const groupFromAlice = `v2-group-a-${suffix}`;
  const groupFromBob = `v2-group-b-${suffix}`;
  if (!bobIsV2) {
    await createGroupViaUi(aliceSession.page, groupTitle, [bob.split('@')[0]]);
    // Композер лички ещё в DOM, пока открывается группа — без явного открытия
    // сообщение уходило в личный чат
    await openGroupChatByTitle(aliceSession.page, groupTitle);
    await sendInActiveChat(aliceSession.page, groupFromAlice);
    await openGroupChatByTitle(bobSession.page, groupTitle);
    await findMessage(bobSession.page, groupFromAlice).waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
    await sendInActiveChat(bobSession.page, groupFromBob);
    await findMessage(aliceSession.page, groupFromBob).waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
    assert.ok(!logs.alice.some((l) => l.includes('v2: группа создана')),
      'alice: группа с v1-участником создана по v2');
    await openPrivateChatStrict(bobSession.page, alice);
  }

  // История после перезагрузки (состояние движка в шифрованном IDB).
  await aliceSession.page.reload();
  await openPrivateChatStrict(aliceSession.page, bob).catch(() => undefined);
  await findMessage(aliceSession.page, edited).waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  // Запись о звонке по v2 возвращается из журнала личного состояния
  if (bobIsV2) await callEntry(aliceSession.page, 'Outgoing Call').waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  // Свои служебные сообщения о режиме переживают перезагрузку
  if (bobIsV2) {
    await serviceMessage(aliceSession.page, 'You enabled enhanced privacy')
      .waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
    await serviceMessage(aliceSession.page, 'You disabled enhanced privacy')
      .waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  }

  // Переход bob на v2 на том же устройстве: история, созданная до перехода
  // (личка и группа v1), читается; переписка после перехода идёт в обе стороны
  if (!bobIsV2) {
    const bobPage = bobSession.page;
    await bobPage.evaluate(() => localStorage.setItem('parvane:proto', 'v2'));
    await reloadPage(bobPage);
    await waitLog('bob', 'v2: готов');
    await dismissRecoveryKeyDialog(bobPage);
    await openPrivateChatStrict(bobPage, alice);
    await findMessage(bobPage, edited).waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
    await findMessageContainer(bobPage, photoCaption).waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
    assert.ok(await voiceBubbles(bobPage).count() >= 2, 'bob: голосовые до перехода пропали');
    const afterUpgrade = `v2-after-upgrade-${suffix}`;
    await sendInActiveChat(bobPage, afterUpgrade);
    await openPrivateChatStrict(aliceSession.page, bob);
    await findMessage(aliceSession.page, afterUpgrade).waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
    const afterUpgradeBack = `v2-after-upgrade-back-${suffix}`;
    await sendInActiveChat(aliceSession.page, afterUpgradeBack);
    await findMessage(bobPage, afterUpgradeBack).waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
    await openGroupChatByTitle(bobPage, groupTitle);
    await findMessage(bobPage, groupFromAlice).waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
    await findMessage(bobPage, groupFromBob).waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
    assert.ok(!logs.bob.some((l) => l.includes('запуск не удался')), `bob: ${logs.bob.join(' | ')}`);
  }

  assert.ok(!logs.alice.some((l) => l.includes('запуск не удался')), `alice: ${logs.alice.join(' | ')}`);
  console.log(`e2e_protocol_mixed (${PAIR}): OK`);
} catch (error) {
  const shotDir = process.env.PARVANE_E2E_SHOT_DIR || 'web/telegram-tt/test-results';
  for (const [who, session] of [['alice', aliceSession], ['bob', bobSession]]) {
    if (!session) continue;
    await session.page.screenshot({ path: `${shotDir}/protocol-mixed-${who}.png` }).catch(() => undefined);
    const state = await session.page.evaluate(() => {
      const g = globalThis.__parvaneGetGlobal?.();
      return g ? {
        chats: Object.keys(g.chats.byId).length,
        listIds: g.chats.listIds?.active?.length,
        messagesByChat: Object.fromEntries(Object.entries(g.messages.byChatId)
          .map(([id, m]) => [id, Object.keys(m.byId || {}).length])),
      } : 'нет хука';
    }).catch((e) => String(e));
    console.error(`${who} состояние: ${JSON.stringify(state)}`);
  }
  if (aliceSession) await dumpDiagJournal(aliceSession.page, 'alice');
  if (bobSession) await dumpDiagJournal(bobSession.page, 'bob');
  console.error(`консоль alice:\n${consoleTail.alice.join('\n')}\nконсоль bob:\n${consoleTail.bob.join('\n')}`);
  console.error(`v2 журнал alice: ${logs.alice.join('\n')}\nbob: ${logs.bob.join('\n')}`);
  throw error;
} finally {
  await browser.close();
}
