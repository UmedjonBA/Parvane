// Этап 4 ревью UI 7 ноя 2026 (MEDIA-2, QUOTE-1) — живьём между двумя пользователями:
// альбом из трёх фото под спойлером (одна группа у получателя, порядок, размытие), подпись над медиа у одиночного
// фото, «Ответить с цитатой» (цитата у получателя), отложенное «без звука» и «Отправить, когда будет в сети»
import assert from 'node:assert/strict';

import { chromium } from '../web/telegram-tt/node_modules/playwright/index.mjs';

import {
  LOGIN_TIMEOUT_MS,
  assertNoPageErrors,
  buildPngBuffer,
  dumpDiagJournal,
  findMessage,
  findMessageContainers,
  openPrivateChatStrict,
  preparePage,
  sendText,
} from './e2e_web_helpers.mjs';

const PASSWORD = 'Parvane-album-spoiler-e2e-password';
const SCHEDULED_WHEN_ONLINE = 0x7FFFFFFE;
const COLORS = [[0xd0, 0x30, 0x30], [0x30, 0xd0, 0x30], [0x30, 0x30, 0xd0]];

// Окно отправки вложений: выбрать файлы, подпись, пункты меню ⋮, отправить
async function sendAttachments(page, files, caption, menuItems = []) {
  await page.getByRole('button', { name: 'Add an attachment' }).click();
  const fileChooserPromise = page.waitForEvent('filechooser');
  await page.getByRole('menuitem', { name: 'Photo or Video' }).click();
  await (await fileChooserPromise).setFiles(files);
  const captionInput = page.locator('#editable-message-text-modal');
  await captionInput.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  for (const item of menuItems) {
    // Кнопка ⋮ самого окна отправки (у шапки чата под окном — своя «More actions»)
    await page.locator('.modal-dialog').getByRole('button', { name: 'More actions' }).click();
    const menuItem = page.getByRole('menuitem', { name: item });
    await menuItem.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
    await menuItem.click();
    await menuItem.waitFor({ state: 'hidden', timeout: LOGIN_TIMEOUT_MS }).catch(() => page.keyboard.press('Escape'));
  }
  await captionInput.fill(caption);
  await captionInput.press('Enter');
  await captionInput.waitFor({ state: 'hidden', timeout: LOGIN_TIMEOUT_MS });
}

// Сообщения чата с собеседником в global tt — поля, которые проверяет сценарий
function chatMessages(page, peerNick) {
  return page.evaluate((name) => {
    const g = window.__parvaneGetGlobal();
    const user = Object.values(g.users.byId)
      .find((candidate) => candidate.usernames?.some(({ username }) => username === name));
    if (!user) return [];
    return Object.values(g.messages.byChatId[user.id]?.byId || {}).map((m) => ({
      id: m.id,
      text: m.content?.text?.text,
      hasPhoto: Boolean(m.content?.photo),
      isSpoiler: Boolean(m.content?.photo?.isSpoiler || m.content?.video?.isSpoiler),
      groupedId: m.groupedId,
      isInAlbum: Boolean(m.isInAlbum),
      isInvertedMedia: Boolean(m.isInvertedMedia),
      isSilent: Boolean(m.isSilent),
      quote: m.replyInfo?.quoteText?.text,
      isOutgoing: Boolean(m.isOutgoing),
    })).sort((a, b) => a.id - b.id);
  }, peerNick);
}

async function waitFor(check, what) {
  const deadline = Date.now() + LOGIN_TIMEOUT_MS;
  for (;;) {
    const found = await check();
    if (found) return found;
    assert(Date.now() < deadline, `не дождались: ${what}`);
    await new Promise((resolve) => {
      setTimeout(resolve, 300);
    });
  }
}

// Выделить `fragment` в тексте сообщения и открыть контекстное меню на выделении
async function selectFragmentAndOpenMenu(page, text, fragment) {
  const target = findMessage(page, text).last();
  await target.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  const rect = await target.evaluate((element, part) => {
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const index = node.textContent.indexOf(part);
      if (index < 0) continue;
      const range = document.createRange();
      range.setStart(node, index);
      range.setEnd(node, index + part.length);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      const box = range.getBoundingClientRect();
      return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    }
    return undefined;
  }, fragment);
  assert(rect, 'фрагмент для цитаты не найден в тексте');
  await page.mouse.click(rect.x, rect.y, { button: 'right' });
}

const browser = await chromium.launch();
const contexts = [await browser.newContext(), await browser.newContext()];
let sessions = [];

try {
  const suffix = `${Date.now()}-${process.pid}`;
  const [alice, bob] = ['alice', 'bob'].map((n) => `album-${n}-${suffix}@local`);
  const nick = (address) => address.split('@')[0];
  sessions = await Promise.all([
    preparePage(contexts[0], alice, PASSWORD),
    preparePage(contexts[1], bob, PASSWORD),
  ]);
  const [a, b] = sessions;

  // Переписка в обе стороны (ключи доступа v2) и присутствие друг друга
  await openPrivateChatStrict(a.page, bob);
  await sendText(a.page, `hello-${suffix}`);
  await openPrivateChatStrict(b.page, alice);
  await findMessageContainers(b.page, `hello-${suffix}`).first()
    .waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await sendText(b.page, `hi-${suffix}`);
  await findMessageContainers(a.page, `hi-${suffix}`).first()
    .waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });

  // ── MEDIA-2: альбом из трёх фото под спойлером ──────────────────────────────
  const albumCaption = `album-caption-${suffix}`;
  await sendAttachments(a.page, COLORS.map((rgb, index) => ({
    name: `album-${index}.png`, mimeType: 'image/png', buffer: buildPngBuffer(48 + index * 8, rgb),
  })), albumCaption, ['Enable Spoiler']);
  const album = await waitFor(async () => {
    const photos = (await chatMessages(b.page, nick(alice))).filter((m) => m.hasPhoto);
    return photos.length >= 3 ? photos : undefined;
  }, 'MEDIA-2: три фото альбома у получателя');
  assert.equal(new Set(album.map((m) => m.groupedId)).size, 1, `MEDIA-2: альбом разбит: ${JSON.stringify(album)}`);
  assert(album[0].groupedId, 'MEDIA-2: у фото альбома нет groupedId');
  assert(album.every((m) => m.isInAlbum), 'MEDIA-2: фото не помечены isInAlbum');
  assert(album.every((m) => m.isSpoiler), `MEDIA-2: спойлер не дошёл: ${JSON.stringify(album)}`);
  assert.equal(album.filter((m) => m.text === albumCaption).length, 1, 'MEDIA-2: подпись альбома не на одном фото');
  await b.page.locator('.Transition_slide-active > .MessageList .Album').first()
    .waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  // У отправителя — тот же альбом (локальное эхо)
  const own = (await chatMessages(a.page, nick(bob))).filter((m) => m.hasPhoto && m.isOutgoing);
  assert.equal(new Set(own.map((m) => m.groupedId)).size, 1, 'MEDIA-2: у отправителя альбом разбит');
  console.log('OK: MEDIA-2 — альбом из трёх фото одной группой, под спойлером');

  // ── MEDIA-2: подпись над медиа у одиночного фото ────────────────────────────
  const upCaption = `caption-up-${suffix}`;
  await sendAttachments(a.page, [{
    name: 'single.png', mimeType: 'image/png', buffer: buildPngBuffer(40, [0xee, 0xaa, 0x22]),
  }], upCaption, ['Move Caption Up']);
  const inverted = await waitFor(async () => (await chatMessages(b.page, nick(alice)))
    .find((m) => m.text === upCaption), 'MEDIA-2: фото с подписью над медиа');
  assert.equal(inverted.isInvertedMedia, true, 'MEDIA-2: «подпись над медиа» не дошла');
  assert.equal(inverted.groupedId, undefined, 'MEDIA-2: одиночное фото попало в альбом');
  console.log('OK: MEDIA-2 — подпись над медиа дошла до получателя');

  // ── QUOTE-1: «Ответить с цитатой» ───────────────────────────────────────────
  const source = `quote-source alpha beta gamma ${suffix}`;
  await sendText(a.page, source);
  await findMessageContainers(b.page, source).first().waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await selectFragmentAndOpenMenu(b.page, source, 'beta gamma');
  const quoteItem = b.page.locator('.MessageContextMenu').getByRole('menuitem', { name: 'Reply with Quote' });
  await quoteItem.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await quoteItem.click();
  const answer = `quote-answer-${suffix}`;
  await sendText(b.page, answer);
  const quoted = await waitFor(async () => (await chatMessages(a.page, nick(bob)))
    .find((m) => m.text === answer), 'QUOTE-1: ответ с цитатой у автора');
  assert.equal(quoted.quote, 'beta gamma', `QUOTE-1: цитата не дошла: ${JSON.stringify(quoted)}`);
  console.log('OK: QUOTE-1 — цитата в ответе дошла до получателя');

  // ── Отложенное «без звука» и «Отправить, когда будет в сети» ────────────────
  const silentText = `scheduled-silent-${suffix}`;
  const onlineText = `when-online-${suffix}`;
  await a.page.evaluate(async ({ peer, silent, online, marker }) => {
    const g = window.__parvaneGetGlobal();
    const user = Object.values(g.users.byId)
      .find((candidate) => candidate.usernames?.some(({ username }) => username === peer));
    const chat = g.chats.byId[user.id];
    const now = Math.floor(Date.now() / 1000);
    await window.__parvaneDiagCallApi('sendMessage', {
      chat, text: silent, isSilent: true, scheduledAt: now + 3,
    });
    await window.__parvaneDiagCallApi('sendMessage', { chat, text: online, scheduledAt: marker });
  }, {
    peer: nick(bob), silent: silentText, online: onlineText, marker: SCHEDULED_WHEN_ONLINE,
  });
  const silent = await waitFor(async () => (await chatMessages(b.page, nick(alice)))
    .find((m) => m.text === silentText), 'отложенное «без звука» у получателя');
  assert.equal(silent.isSilent, true, 'отложенный текст «без звука» ушёл со звуком');
  console.log('OK: отложенный текст «без звука» дошёл без звука');
  // Боб в сети (вкладка открыта, присутствие идёт) — «когда будет в сети» уходит
  await waitFor(async () => (await chatMessages(b.page, nick(alice)))
    .find((m) => m.text === onlineText), '«Отправить, когда будет в сети» при собеседнике в сети');
  console.log('OK: «Отправить, когда будет в сети» ушло, когда собеседник в сети');

  assertNoPageErrors(sessions);
  console.log('OK: e2e_web_album_spoiler — все шаги');
} catch (error) {
  const shotDir = process.env.PARVANE_E2E_SHOT_DIR;
  for (const [index, session] of sessions.entries()) {
    if (shotDir) await session.page.screenshot({ path: `${shotDir}/album-spoiler-${index}.png` }).catch(() => {});
    await dumpDiagJournal(session.page, `album-spoiler-${index}`).catch(() => undefined);
  }
  throw error;
} finally {
  await browser.close();
}
