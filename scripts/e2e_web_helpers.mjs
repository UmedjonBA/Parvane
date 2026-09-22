// Общие помощники двухбраузерных Web e2e сценариев (живой стек NATS+gateway).
// Скрипты-сценарии: e2e_web_sync_reconnect.mjs, e2e_web_media_ttl.mjs и другие.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

export const LOGIN_TIMEOUT_MS = 60000;
export const RECONNECT_TIMEOUT_MS = 30000;

// Полный выход из аккаунта (не reload): добирается до корня настроек из
// любого экрана левой колонки, затем «More actions» → «Log Out»
export async function logOut(page) {
  const deadline = Date.now() + LOGIN_TIMEOUT_MS;
  for (;;) {
    const visible = (locator) => locator.isVisible().catch(() => false);
    if (await visible(page.getByRole('button', { name: 'Edit profile' }).first())) break;
    const menu = page.getByRole('button', { name: 'Open menu' }).first();
    if (await visible(menu)) {
      await menu.click();
      await page.getByRole('menuitem', { name: 'Settings' }).click();
      await page.getByRole('button', { name: 'Edit profile' }).first()
        .waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
      break;
    }
    const back = page.getByRole('button', { name: /Go back|Return to Chat List/ }).first();
    if (await visible(back)) await back.click();
    assert(Date.now() < deadline, 'не нашёл ни «Open menu», ни «Go back» в левой колонке');
    await page.waitForTimeout(500);
  }
  await page.getByRole('button', { name: 'More actions' }).first()
    .waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await page.getByRole('button', { name: 'More actions' }).first().click();
  await page.getByRole('menuitem', { name: 'Log Out' }).click();
  await clickUntil(
    page.getByRole('button', { name: 'Log Out' }).last(),
    () => page.locator('.Transition_slide-active > #auth-phone-number-form')
      .waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS }),
    { settleMs: 15000 },
  );
}

// Клик, который под нагрузкой мог не дойти (перерисовка/анимация кнопки):
// обычный → force → dispatchEvent, после каждого ждём `isDone`
export async function clickUntil(locator, isDone, { attempts = 4, settleMs = 3000 } = {}) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      if (attempt === 0) await locator.click({ timeout: 5000 });
      else if (attempt === 1) await locator.click({ force: true, timeout: 5000 });
      else await locator.dispatchEvent('click');
    } catch {
      // кнопка перемонтировалась — проверим результат и попробуем снова
    }
    const done = await Promise.race([
      isDone().then(() => true).catch(() => false),
      new Promise((resolve) => { setTimeout(() => resolve(false), settleMs); }),
    ]);
    if (done) return;
  }
  await isDone();
}

export function requireEnv() {
  const baseUrl = process.env.PARVANE_E2E_BASE_URL;
  const gatewayUrl = process.env.PARVANE_E2E_GATEWAY_URL;
  assert(baseUrl, 'PARVANE_E2E_BASE_URL is required');
  assert(gatewayUrl, 'PARVANE_E2E_GATEWAY_URL is required');
  return { baseUrl, gatewayUrl };
}

export async function preparePage(context, user, password, { seedLocalStorage, startUrl, beforeLogin } = {}) {
  const { baseUrl, gatewayUrl } = requireEnv();
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (err) => errors.push(err.message));
  await page.addInitScript(({ gatewayUrl: url, seed }) => {
    localStorage.setItem('parvane:gateway', url);
    Object.entries(seed || {}).forEach(([key, value]) => {
      localStorage.setItem(key, value);
    });
    const NativeWebSocket = window.WebSocket;
    globalThis.__parvaneE2eSockets = { opened: 0, closed: 0, active: new Set() };
    globalThis.__parvaneE2eDisconnect = () => {
      for (const socket of globalThis.__parvaneE2eSockets.active) {
        socket.close(4001, 'e2e network interruption');
      }
    };
    // Звонки: движки держат RTCPeerConnection в приватных полях — запоминаем
    // все экземпляры, чтобы e2e читал getStats() (callMediaStats)
    const NativePeerConnection = window.RTCPeerConnection;
    globalThis.__parvaneE2ePeers = [];
    if (NativePeerConnection) {
      window.RTCPeerConnection = class TrackedPeerConnection extends NativePeerConnection {
        constructor(...args) {
          super(...args);
          globalThis.__parvaneE2ePeers.push(this);
        }
      };
    }
    // Учёт скачанного из облака (trackDownloadedBytes): id запроса → file_id
    globalThis.__parvaneE2eDownloads = { fileByRequest: {}, bytesByFile: {}, requests: [] };
    window.WebSocket = class TrackedWebSocket extends NativeWebSocket {
      constructor(url2, protocols) {
        super(url2, protocols);
        globalThis.__parvaneE2eSockets.active.add(this);
        const downloads = globalThis.__parvaneE2eDownloads;
        const nativeSend = this.send.bind(this);
        this.send = (data) => {
          try {
            const frame = JSON.parse(String(data));
            if (frame.op === 'reqmany' && frame.subject === 'file.download.request') {
              // payload запроса — WireEvent { id, from, token, payload: { file_id, … } }
              const event = JSON.parse(frame.payload || '{}');
              const body = event.payload || event;
              downloads.fileByRequest[frame.id] = body.file_id;
              downloads.requests.push({
                fileId: body.file_id, from: body.chunk_from, to: body.chunk_to, at: Date.now(),
              });
            }
          } catch {
            // не JSON-кадр
          }
          return nativeSend(data);
        };
        this.addEventListener('message', (event) => {
          try {
            const frame = JSON.parse(String(event.data));
            const fileId = frame.op === 'reply' && downloads.fileByRequest[frame.id];
            if (!fileId) return;
            const body = JSON.parse(frame.payload || '{}');
            if (!body.data) return;
            const padding = body.data.endsWith('==') ? 2 : body.data.endsWith('=') ? 1 : 0;
            downloads.bytesByFile[fileId] = (downloads.bytesByFile[fileId] || 0)
              + Math.floor((body.data.length * 3) / 4) - padding;
          } catch {
            // не JSON-кадр
          }
        });
        this.addEventListener('open', () => {
          globalThis.__parvaneE2eSockets.opened += 1;
        });
        this.addEventListener('close', () => {
          globalThis.__parvaneE2eSockets.active.delete(this);
          globalThis.__parvaneE2eSockets.closed += 1;
        });
      }
    };
  }, { gatewayUrl, seed: seedLocalStorage });
  await page.route(/https:\/\/(?:t\.me|telegram\.me|telegram\.dog)\/_websync_/, async (route) => {
    await route.fulfill({ contentType: 'application/javascript', body: '' });
  });
  await page.goto(startUrl || baseUrl, { waitUntil: 'domcontentloaded' });
  // Хук между открытием страницы и вводом ника (например, уйти на другой
  // адрес в той же вкладке, проверяя переживание sessionStorage)
  if (beforeLogin) await beforeLogin(page);

  await submitNick(page, user);

  const passwordScreen = page.locator('.Transition_slide-active > #auth-password-form');
  await passwordScreen.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await passwordScreen.locator('#sign-in-password').fill(password);
  await clickUntil(
    passwordScreen.getByRole('button', { name: 'Next' }),
    () => page.locator('#LeftColumn').waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS }),
    { settleMs: 15000 },
  );
  await page.waitForFunction(() => globalThis.__parvaneE2eSockets?.opened === 1);
  return { page, errors };
}

// Экран входа: ввести ник (или полный адрес) и нажать Next. Экран может
// перемонтироваться сразу после появления (провайдер повторно шлёт
// WaitPhoneNumber после чтения storage) и сбросить введённое — повторяем ввод,
// пока не появится кнопка
export async function submitNick(page, user) {
  const addressScreen = page.locator('.Transition_slide-active > #auth-phone-number-form');
  const addressInput = addressScreen.getByLabel('Nickname');
  await addressInput.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  const nextButton = addressScreen.getByRole('button', { name: 'Next' });
  const deadline = Date.now() + LOGIN_TIMEOUT_MS;
  for (;;) {
    await addressInput.fill(user);
    try {
      await nextButton.waitFor({ state: 'visible', timeout: 3000 });
      break;
    } catch (err) {
      if (Date.now() > deadline) throw err;
    }
  }
  // Под нагрузкой кнопка «Next» перерисовывается и обычный click не проходит
  // («element is not stable») — повторяем, пока экран ника не сменится
  await clickUntil(
    nextButton,
    () => addressScreen.waitFor({ state: 'hidden', timeout: LOGIN_TIMEOUT_MS }),
    { settleMs: 8000 },
  );
}

export async function openPrivateChat(page, address) {
  const search = page.locator('#telegram-search-input');
  const displayName = address.split('@')[0];
  const pane = page.locator('.LeftSearch');
  // Панель открывается по фокусу: если поле уже в фокусе (прошлый вызов),
  // клик её не откроет — снимаем фокус и кликаем снова
  for (let attempt = 0; attempt < 3; attempt++) {
    await search.click();
    const isOpen = await pane.waitFor({ state: 'visible', timeout: 3000 }).then(() => true).catch(() => false);
    if (isOpen) break;
    await search.evaluate((el) => el.blur());
    await page.waitForTimeout(300);
  }
  await pane.waitFor({ state: 'visible', timeout: 10000 });
  await page.waitForTimeout(250);
  await search.fill(displayName);
  const result = page.locator('.LeftSearch .search-result').filter({ hasText: displayName }).first();
  await result.waitFor({ state: 'visible', timeout: 15000 });
  await result.locator('.ListItem-button').click();
  // Пока история чата не подгружена (шапка «Updating»), tt рендерит композер
  // с contenteditable=false и placeholder «Text not allowed»: fill() падает
  // сразу, без ретраев. Ждём именно редактируемый композер
  await page.locator('#editable-message-text[contenteditable="true"]')
    .waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await closeLeftSearch(page);
}

// Панель поиска после клика по результату закрывается с анимацией; если чат
// уже был открыт, tt иногда оставляет её висеть поверх списка чатов (клик по
// чату в списке тогда падает «element is not visible»). Дожидаемся закрытия,
// иначе закрываем кнопкой «назад» в шапке. НЕ Escape: после открытия чата
// последним Esc-обработчиком становится MiddleColumn — он закрывает сам чат,
// и композер остаётся без объекта чата («Text not allowed»)
async function closeLeftSearch(page) {
  const search = page.locator('.LeftSearch');
  for (let attempt = 0; attempt < 3; attempt++) {
    const isHidden = await search.waitFor({ state: 'hidden', timeout: 2000 }).then(() => true).catch(() => false);
    if (isHidden) return;
    await page.locator('#LeftColumn').getByRole('button', { name: 'Return to chat list' }).first()
      .click({ timeout: 2000 }).catch(() => {});
  }
}

// Строгий вариант: проверяет заголовок чата и ретраит — нестрогий
// openPrivateChat мог оставить композер предыдущего чата (текст уходил не туда)
export async function openPrivateChatStrict(page, address) {
  const name = address.split('@')[0];
  for (let attempt = 0; attempt < 3; attempt++) {
    await openPrivateChat(page, address).catch(() => {});
    const isOpen = await page.locator('.MiddleHeader').getByText(name).first()
      .isVisible().catch(() => false);
    if (isOpen) return;
    await page.keyboard.press('Escape');
    await page.waitForTimeout(500);
  }
  throw new Error(`chat with ${address} did not open`);
}

export async function sendText(page, text) {
  // Только редактируемый композер: пока история открытого чата подгружается
  // (шапка «Updating»), tt кратко рендерит его с contenteditable=false и
  // placeholder «Text not allowed», а fill() на таком элементе падает сразу,
  // без авто-ожидания. Селектор с атрибутом заставляет Playwright дождаться
  const input = page.locator('#editable-message-text[contenteditable="true"]');
  await input.fill(text);
  await input.press('Enter');
  await page.waitForFunction(() => !document.querySelector('#editable-message-text')?.textContent);
}

export function findMessage(page, text) {
  return page
    .locator('.Transition_slide-active > .MessageList .Message .text-content')
    .filter({ hasText: text });
}

export function findMessageContainers(page, text) {
  return page
    .locator('.Transition_slide-active > .MessageList .Message')
    .filter({ hasText: text });
}

export function findMessageContainer(page, text) {
  return findMessageContainers(page, text).last();
}

export async function openMessageMenuOn(container) {
  const box = await container.boundingBox();
  assert(box, 'message is not visible');
  await container.click({
    button: 'right',
    position: { x: box.width / 2, y: box.height / 2 },
  });
}

export async function selectMessageActionOn(page, container, action) {
  await openMessageMenuOn(container);
  const item = page.locator('.MessageContextMenu').getByRole('menuitem', { name: action, exact: true });
  await item.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await item.click();
}

export async function openMessageMenu(page, text) {
  await openMessageMenuOn(findMessageContainer(page, text));
}

export async function selectMessageAction(page, text, action) {
  await selectMessageActionOn(page, findMessageContainer(page, text), action);
}

export async function addReaction(page, text, emoji) {
  await openMessageMenu(page, text);
  const reaction = page.locator('.MessageContextMenu .ReactionSelector')
    .getByRole('button', { name: emoji, exact: true });
  await reaction.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await reaction.click();
}

export async function pinMessage(page, text) {
  await selectMessageAction(page, text, 'Pin');
  const confirm = page.locator('.Modal.pin').getByRole('button', { name: 'Pin', exact: true });
  await confirm.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await confirm.click();
}

export async function pickForwardRecipientAndSend(page, address) {
  const displayName = address.split('@')[0];
  const picker = page.locator('.Modal').filter({ has: page.locator('.ChatOrUserPicker-item') });
  await picker.locator('.search-input').fill(displayName);
  const recipient = picker.locator('.Transition_slide-active .ChatOrUserPicker-item')
    .filter({ hasText: displayName }).last();
  await recipient.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await recipient.click();
  await recipient.locator('.picker-checkbox.selected').waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await picker.locator('.picker-footer-button').click();
  const embedded = page.locator('.Transition_slide-active .ComposerEmbeddedMessage');
  await embedded.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await page.locator('.Transition_slide-active .Composer')
    .getByRole('button', { name: 'Forward', exact: true }).click();
  await embedded.waitFor({ state: 'hidden', timeout: LOGIN_TIMEOUT_MS });
}

export async function forwardMessage(page, text, address) {
  await selectMessageAction(page, text, 'Forward');
  await pickForwardRecipientAndSend(page, address);
}

export async function editText(page, sourceText, editedText) {
  await selectMessageAction(page, sourceText, 'Edit');
  await page.locator('.ComposerEmbeddedMessage').filter({ hasText: sourceText })
    .waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  const input = page.locator('#editable-message-text');
  await input.fill(editedText);
  await input.press('Enter');
}

export async function deleteMessage(page, text) {
  await selectMessageAction(page, text, 'Delete');
  const confirm = page.locator('.Modal').getByRole('button', { name: 'Delete', exact: true });
  await confirm.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await confirm.click();
}

export async function waitForSocketCount(page, field, count) {
  await page.waitForFunction(
    ({ fieldName, expected }) => globalThis.__parvaneE2eSockets?.[fieldName] >= expected,
    { fieldName: field, expected: count },
    { timeout: RECONNECT_TIMEOUT_MS },
  );
}

export async function disconnectWhileOffline(context, page) {
  await context.setOffline(true);
  await page.evaluate(() => globalThis.__parvaneE2eDisconnect());
}

export function assertNoPageErrors(sessions) {
  for (const [name, session] of Object.entries(sessions)) {
    assert.deepEqual(session.errors, [], `${name} page errors: ${session.errors.join('; ')}`);
  }
}

// Reload + вход. keep-signed-in (92e73322): пароль сохранён и вход после
// reload автоматический; форма пароля появляется только без сохранённой сессии
export async function relogin(page, password) {
  await page.reload({ waitUntil: 'domcontentloaded' });
  const passwordScreen = page.locator('.Transition_slide-active > #auth-password-form');
  const leftColumn = page.locator('#LeftColumn');
  await Promise.race([
    passwordScreen.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS }),
    leftColumn.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS }),
  ]);
  if (await passwordScreen.isVisible()) {
    await passwordScreen.locator('#sign-in-password').fill(password);
    await clickUntil(
      passwordScreen.getByRole('button', { name: 'Next' }),
      () => leftColumn.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS }),
      { settleMs: 15000 },
    );
  }
  await leftColumn.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
}

const DIAG_STORAGE_KEY = 'parvane:diag:v2';

// Записи журнала клиента: { t, k, d?, n? }. Журнал пишется в localStorage с
// задержкой ~1.5 с — перед чтением свежих событий нужно подождать
export async function readDiagJournal(page) {
  return page.evaluate((key) => {
    try {
      return JSON.parse(localStorage.getItem(key) || '[]');
    } catch {
      return [];
    }
  }, DIAG_STORAGE_KEY);
}

// Журнал действий клиента (web util/parvaneDiag, localStorage parvane:diag:v2)
// — при падении сценария печатаем хвост: видно апдейты/ошибки провайдера
export async function dumpDiagJournal(page, label, limit = 40) {
  const lines = await page.evaluate(({ max, key }) => {
    try {
      const raw = localStorage.getItem(key);
      const entries = raw ? JSON.parse(raw) : [];
      return entries.slice(-max).map((e) => `${new Date(e.t).toISOString().slice(11, 23)} ${e.k}${e.n ? ` x${e.n}` : ''} ${(e.d || '').slice(0, 140)}`);
    } catch (e) { return [`diag unavailable: ${e}`]; }
  }, { max: limit, key: DIAG_STORAGE_KEY }).catch((e) => [`diag eval failed: ${e.message}`]);
  console.error(`--- diag ${label} ---\n${lines.join('\n')}`);
}

// Скачивание документа из пузыря: download приходит либо на странице, либо на
// попапе service worker. Возвращает { name, sha256 }
export async function sha256OfDownload(page, locator) {
  const context = page.context();
  const downloadFromPopup = context.waitForEvent('page', { timeout: LOGIN_TIMEOUT_MS })
    .then((popup) => popup.waitForEvent('download', { timeout: LOGIN_TIMEOUT_MS }));
  const downloadFromPage = page.waitForEvent('download', { timeout: LOGIN_TIMEOUT_MS });
  downloadFromPopup.catch(() => {});
  downloadFromPage.catch(() => {});
  await locator.click();
  const download = await Promise.race([downloadFromPage, downloadFromPopup]);
  const bytes = await readFile(await download.path());
  return {
    name: download.suggestedFilename(),
    sha256: createHash('sha256').update(bytes).digest('hex'),
  };
}

// Учёт скачанного из облака: запросы file.download.request (file_id,
// chunk_from/chunk_to) и байты data в ответах. Счётчики живут в странице
// (init-скрипт preparePage), поэтому видят и сокет, открытый до вызова
export function trackDownloadedBytes(page) {
  return {
    reset: () => page.evaluate(() => {
      globalThis.__parvaneE2eDownloads.bytesByFile = {};
      globalThis.__parvaneE2eDownloads.requests = [];
    }),
    bytesFor: (fileId) => page.evaluate((id) => {
      const { bytesByFile } = globalThis.__parvaneE2eDownloads;
      if (id) return bytesByFile[id] || 0;
      return Object.values(bytesByFile).reduce((sum, value) => sum + value, 0);
    }, fileId),
    requests: () => page.evaluate(() => globalThis.__parvaneE2eDownloads.requests.slice()),
  };
}

// Статистика медиа всех живых соединений звонка на странице. peer — адрес
// участника группового звонка (по совпадению id треков с parvaneCall.groupStreams),
// для 1-1 — 'peer'
export async function callMediaStats(page) {
  return page.evaluate(async () => {
    const call = window.parvaneCall || {};
    const trackOwner = new Map();
    Object.entries(call.groupStreams || {}).forEach(([address, stream]) => {
      stream?.getTracks?.().forEach((track) => trackOwner.set(track.id, address));
    });
    const peers = (globalThis.__parvaneE2ePeers || []).filter((pc) => pc.connectionState !== 'closed');
    const result = [];
    for (const pc of peers) {
      const trackIds = pc.getReceivers().map((receiver) => receiver.track?.id).filter(Boolean);
      const peer = trackIds.map((id) => trackOwner.get(id)).find(Boolean) || 'peer';
      const stats = await pc.getStats();
      const snapshot = {
        peer,
        connectionState: pc.connectionState,
        audio: { bytesReceived: 0, totalAudioEnergy: 0 },
        video: {
          framesDecoded: 0, frameWidth: 0, frameHeight: 0, framesPerSecond: 0,
        },
        candidateType: undefined,
      };
      let selectedPairId;
      stats.forEach((report) => {
        if (report.type === 'transport' && report.selectedCandidatePairId) selectedPairId = report.selectedCandidatePairId;
      });
      stats.forEach((report) => {
        if (report.type === 'inbound-rtp' && report.kind === 'audio') {
          snapshot.audio.bytesReceived += report.bytesReceived || 0;
          snapshot.audio.totalAudioEnergy += report.totalAudioEnergy || 0;
        }
        if (report.type === 'inbound-rtp' && report.kind === 'video') {
          snapshot.video.framesDecoded += report.framesDecoded || 0;
          snapshot.video.frameWidth = Math.max(snapshot.video.frameWidth, report.frameWidth || 0);
          snapshot.video.frameHeight = Math.max(snapshot.video.frameHeight, report.frameHeight || 0);
          snapshot.video.framesPerSecond = Math.max(snapshot.video.framesPerSecond, report.framesPerSecond || 0);
        }
        if (report.type === 'candidate-pair' && (report.id === selectedPairId || (!selectedPairId && report.nominated))) {
          const local = stats.get(report.localCandidateId);
          snapshot.candidateType = local?.candidateType;
        }
      });
      result.push(snapshot);
    }
    return result;
  });
}

// Средняя яркость и дисперсия удалённого видео (canvas 32×24): выключенная
// камера у собеседника даёт чёрные кадры (mean < 20, variance ≈ 0)
export async function remoteVideoLuma(page, selector) {
  return page.evaluate((sel) => {
    const video = document.querySelector(sel);
    if (!video || !video.videoWidth) return { mean: -1, variance: -1 };
    const canvas = document.createElement('canvas');
    canvas.width = 32;
    canvas.height = 24;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(video, 0, 0, 32, 24);
    const { data } = ctx.getImageData(0, 0, 32, 24);
    const values = [];
    for (let i = 0; i < data.length; i += 4) {
      values.push(0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]);
    }
    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    const variance = values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length;
    return { mean, variance };
  }, selector);
}

// Яркость удалённого видео 1-1 звонка: элемент, чей srcObject — удалённый поток
export async function remoteCallVideoLuma(page) {
  return page.evaluate(() => {
    const remote = window.parvaneCall?.remoteStream;
    const video = Array.from(document.querySelectorAll('video')).find((element) => element.srcObject === remote);
    if (!video || !video.videoWidth) return { mean: -1, variance: -1 };
    const canvas = document.createElement('canvas');
    canvas.width = 32;
    canvas.height = 24;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(video, 0, 0, 32, 24);
    const { data } = ctx.getImageData(0, 0, 32, 24);
    const values = [];
    for (let i = 0; i < data.length; i += 4) values.push(0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]);
    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    const variance = values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length;
    return { mean, variance };
  });
}

// Ждёт, пока предикат яркости выполнится `samples` замеров подряд
export async function waitLuma(readLuma, predicate, { samples = 2, intervalMs = 500, timeoutMs = 10000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let streak = 0;
  let last;
  while (Date.now() < deadline) {
    last = await readLuma();
    streak = predicate(last) ? streak + 1 : 0;
    if (streak >= samples) return last;
    await new Promise((resolve) => { setTimeout(resolve, intervalMs); });
  }
  throw new Error(`luma condition not met: ${JSON.stringify(last)}`);
}

// Ждёт роста счётчиков медиа за окно windowMs хотя бы у minPeers соединений
// sinceMs — точка отсчёта таймаута (например, момент соединения, SC-009):
// последнее окно замера должно закончиться до sinceMs + timeoutMs
export async function expectMediaFlowing(page, {
  audio = true, video = false, minPeers = 1, windowMs = 4000, timeoutMs = 30000, sinceMs = Date.now(),
} = {}) {
  const deadline = sinceMs + timeoutMs;
  let lastReport = [];
  let isFirstWindow = true;
  while (isFirstWindow || Date.now() + windowMs <= deadline) {
    isFirstWindow = false;
    const before = await callMediaStats(page);
    await page.waitForTimeout(windowMs);
    const after = await callMediaStats(page);
    // Сверяем по УЧАСТНИКУ, а не по позиции в массиве: если между замерами
    // список соединений изменился (кто-то подключился или вышел), сравнение
    // по индексу считало прирост по разным парам (FR-052)
    const beforeByPeer = new Map(before.map((snapshot) => [snapshot.peer, snapshot]));
    lastReport = after.map((snapshot) => {
      const prev = beforeByPeer.get(snapshot.peer);
      return {
        peer: snapshot.peer,
        audioGrowth: prev ? snapshot.audio.bytesReceived - prev.audio.bytesReceived : 0,
        framesGrowth: prev ? snapshot.video.framesDecoded - prev.video.framesDecoded : 0,
        frameWidth: snapshot.video.frameWidth,
        frameHeight: snapshot.video.frameHeight,
      };
    });
    const flowing = lastReport.filter((entry) => (
      (!audio || entry.audioGrowth > 0)
      && (!video || (entry.framesGrowth > 0 && entry.frameWidth > 0 && entry.frameHeight > 0))
    ));
    if (flowing.length >= minPeers && Date.now() <= deadline) return lastReport;
  }
  throw new Error(`media is not flowing within ${timeoutMs} ms: ${JSON.stringify(lastReport)}`);
}

// Миниатюра в пузыре: картинка ненулевого размера и не однотонная
export async function thumbnailStats(bubble, selector = 'img.thumbnail') {
  const img = bubble.locator(selector).first();
  await img.waitFor({ state: 'attached', timeout: LOGIN_TIMEOUT_MS });
  // Ожидание загрузки ограничено: картинка без src/битая держит naturalWidth=0
  // вечно, и без предела сценарий висел сутками (17 сен, video_stream)
  return img.evaluate((element) => new Promise((resolve) => {
    const deadline = Date.now() + 20000;
    const measure = () => {
      if (!element.complete || !element.naturalWidth) {
        if (Date.now() > deadline) {
          resolve({
            width: element.naturalWidth, height: element.naturalHeight, mean: 0, variance: 0, alpha: 0,
            src: (element.currentSrc || element.src || '').slice(0, 80), timedOut: true,
          });
          return;
        }
        setTimeout(measure, 100);
        return;
      }
      const canvas = document.createElement('canvas');
      canvas.width = 32;
      canvas.height = 24;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(element, 0, 0, 32, 24);
      const { data } = ctx.getImageData(0, 0, 32, 24);
      const values = [];
      for (let i = 0; i < data.length; i += 4) values.push(0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]);
      const mean = values.reduce((a, b) => a + b, 0) / values.length;
      const variance = values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length;
      resolve({
        width: element.naturalWidth, height: element.naturalHeight, mean, variance, alpha: data[3],
      });
    };
    measure();
  }));
}

// Группа из списка чатов по названию: ждём заголовок в шапке (композер может
// быть недоступен, пока история подгружается)
export async function openGroupChatByTitle(page, title) {
  const item = page.locator('#LeftColumn .ListItem').filter({ hasText: title }).first();
  await item.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await item.locator('.ListItem-button').click();
  await page.locator('.MiddleHeader').getByText(title).first()
    .waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
}

// Профиль группы → Edit → «Invite Links»: экран открывается, на нём ровно одна
// постоянная ссылка `…/#+<токен>`, нет «Создать»/«Отозвать»/«Отозванные»
// (сервер этого не умеет). Возвращает ссылку и закрывает правую колонку.
// Общий для сценариев инвайтов и мультидевайса: у каждого устройства одного
// аккаунта — своя ссылка (кэш по устройству, сервер не отдаёт уже созданную)
export async function readInvitesScreen(page, title) {
  await openGroupChatByTitle(page, title);
  await page.locator('.MiddleHeader .ChatInfo').click();
  const right = page.locator('#RightColumn');
  const invitesItem = right.locator('.ListItem').filter({ hasText: 'Invite Links' }).first();
  const editButton = right.getByRole('button', { name: 'Edit' });
  // После полного выхода и входа tt восстанавливает правую колонку сразу на
  // экране управления (там кнопки Edit нет) — в профиль заходим, только если
  // открылся он
  await Promise.race([
    invitesItem.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS }),
    editButton.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS }),
  ]);
  if (!(await invitesItem.isVisible())) await editButton.click();
  await invitesItem.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  // Вечное «Loading» (нет fetchExportedChatInvites) держало пункт disabled
  await right.locator('.ListItem').filter({ hasText: 'Invite Links' }).filter({ hasText: '1' }).first()
    .waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await invitesItem.click();
  const screen = right.locator('.ManageInvites');
  await screen.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  // Ссылка — значение readonly-поля LinkField (getByText его не видит)
  const linkInput = screen.locator('input[readonly]');
  await linkInput.first().waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await page.waitForFunction(
    () => /#\+[0-9a-f]{32}/.test(document.querySelector('.ManageInvites input[readonly]')?.value || ''),
    undefined,
    { timeout: LOGIN_TIMEOUT_MS },
  );
  const links = await linkInput.evaluateAll((inputs) => inputs.map((input) => input.value));
  assert.equal(links.length, 1, `expected one invite link field, got ${links}`);
  assert.match(links[0], /#\+[0-9a-f]{32}/, 'invite link field is empty');
  assert.equal(await screen.getByText(/FolderLinkScreen|LinkActionShare/).count(), 0, 'raw lang key on the share button');
  assert.equal(await screen.getByText('Create a New Link').count(), 0, 'Create a New Link must be hidden');
  assert.equal(await screen.getByText('Revoked links').count(), 0, 'revoked links section must be hidden');
  const menuButton = screen.getByRole('button', { name: /menu/i }).first();
  if (await menuButton.count()) {
    await menuButton.click();
    await page.waitForTimeout(400);
    assert.equal(await page.getByRole('menuitem', { name: 'Revoke' }).count(), 0, 'Revoke must be hidden');
    await page.keyboard.press('Escape');
  }
  const link = links[0].trim();
  // Назад к чату
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  return link.startsWith('http') ? link : `https://${link}`;
}
