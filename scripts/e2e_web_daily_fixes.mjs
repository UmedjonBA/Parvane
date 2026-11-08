// Ревью UI 7 ноя 2026, раздел A («ежедневное сломано») — живьём между тремя пользователями:
// A1 уведомления по умолчанию со звуком и текстом; A2 предпросмотр ссылки над полем ввода и «убрать
// предпросмотр»; A3 пересылка «Скрыть имя отправителя» и «Скрыть подпись»; A4 «Отправить без звука» доходит до
// получателя; A5 «Перейти к дате»; A6 избранные и недавние стикеры; A7 вкладки типа глобального поиска без запроса
import assert from 'node:assert/strict';

import { chromium } from '../web/telegram-tt/node_modules/playwright/index.mjs';

import {
  LOGIN_TIMEOUT_MS,
  assertNoPageErrors,
  dumpDiagJournal,
  findMessageContainers,
  openPrivateChatStrict,
  preparePage,
  selectMessageAction,
  sendText,
} from './e2e_web_helpers.mjs';

const PASSWORD = 'Parvane-daily-fixes-e2e-password';
// 1×1 PNG
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

async function attachPhoto(page, caption) {
  await page.getByRole('button', { name: 'Add an attachment' }).click();
  const fileChooserPromise = page.waitForEvent('filechooser');
  await page.getByRole('menuitem', { name: 'Photo or Video' }).click();
  const fileChooser = await fileChooserPromise;
  await fileChooser.setFiles({ name: 'daily-photo.png', mimeType: 'image/png', buffer: PNG });
  const captionInput = page.locator('#editable-message-text-modal');
  await captionInput.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await captionInput.fill(caption);
  await captionInput.press('Enter');
  await captionInput.waitFor({ state: 'hidden', timeout: LOGIN_TIMEOUT_MS });
}

// Сообщения чата с собеседником в global tt (поля, которые проверяет сценарий)
function chatMessages(page, peerNick) {
  return page.evaluate((name) => {
    const g = window.__parvaneGetGlobal();
    const user = Object.values(g.users.byId)
      .find((candidate) => candidate.usernames?.some(({ username }) => username === name));
    if (!user) return [];
    return Object.values(g.messages.byChatId[user.id]?.byId || {}).map((m) => ({
      id: m.id,
      date: m.date,
      text: m.content?.text?.text,
      hasPhoto: Boolean(m.content?.photo),
      hasWebPage: Boolean(m.content?.webPage),
      isSilent: Boolean(m.isSilent),
      hasForward: Boolean(m.forwardInfo),
      isOutgoing: Boolean(m.isOutgoing),
    }));
  }, peerNick);
}

async function waitChatMessage(page, peerNick, predicate, what) {
  const deadline = Date.now() + LOGIN_TIMEOUT_MS;
  for (;;) {
    const found = (await chatMessages(page, peerNick)).find(predicate);
    if (found) return found;
    assert(Date.now() < deadline, `не дождались: ${what}`);
    await page.waitForTimeout(300);
  }
}

// Пересылка из открытого чата в чат с `address` с пунктом меню плашки пересылки (или без)
async function forwardWithOption(page, sourceText, address, optionName) {
  await selectMessageAction(page, sourceText, 'Forward');
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
  if (optionName) {
    await embedded.locator('.embedded-message, .EmbeddedMessage').first().click();
    await page.getByRole('menuitem', { name: optionName }).click();
    await page.locator('.forward-context-menu .bubble').waitFor({ state: 'hidden', timeout: LOGIN_TIMEOUT_MS })
      .catch(() => page.keyboard.press('Escape'));
  }
  await page.locator('.Transition_slide-active .Composer')
    .getByRole('button', { name: 'Forward', exact: true }).click();
  await embedded.waitFor({ state: 'hidden', timeout: LOGIN_TIMEOUT_MS });
}

const browser = await chromium.launch();
const contexts = [await browser.newContext(), await browser.newContext(), await browser.newContext()];
let sessions = [];

try {
  const suffix = `${Date.now()}-${process.pid}`;
  const [alice, bob, carol] = ['alice', 'bob', 'carol'].map((n) => `daily-${n}-${suffix}@local`);
  const nick = (address) => address.split('@')[0];
  sessions = await Promise.all([
    preparePage(contexts[0], alice, PASSWORD),
    preparePage(contexts[1], bob, PASSWORD),
    preparePage(contexts[2], carol, PASSWORD),
  ]);
  const [a, b, c] = sessions;

  // ── A1: умолчания уведомлений нового аккаунта — со звуком и текстом ─────────
  const defaults = await c.page.evaluate(() => window.__parvaneDiagCallApi('fetchNotifyDefaultSettings'));
  assert.equal(defaults?.users?.hasSound, true, `A1: звук по умолчанию выключен: ${JSON.stringify(defaults)}`);
  assert.equal(defaults?.users?.shouldShowPreviews, true, 'A1: текст сообщения в уведомлении по умолчанию скрыт');
  console.log('OK: A1 — уведомления по умолчанию со звуком и текстом');

  // ── Исходные сообщения: alice → bob текст и фото с подписью; carol знакомится с bob ──
  const plain = `daily-text-${suffix}`;
  const caption = `daily-caption-${suffix}`;
  await openPrivateChatStrict(a.page, bob);
  await sendText(a.page, plain);
  await attachPhoto(a.page, caption);
  await openPrivateChatStrict(c.page, bob);
  await sendText(c.page, `hi-${suffix}`);
  await openPrivateChatStrict(b.page, carol);
  await findMessageContainers(b.page, `hi-${suffix}`).first().waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await openPrivateChatStrict(b.page, alice);
  await findMessageContainers(b.page, caption).first().waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });

  // ── A3: «Скрыть имя отправителя» — у получателя копия без «Переслано от» ───
  await forwardWithOption(b.page, plain, carol, 'Hide Sender Name');
  const copy = await waitChatMessage(c.page, nick(bob), (m) => m.text === plain, 'A3: копия текста у carol');
  assert.equal(copy.hasForward, false, 'A3: «Скрыть имя отправителя» — у получателя заголовок пересылки');
  console.log('OK: A3 — пересылка без имени отправителя дошла копией');

  // ── A3: «Скрыть подпись» — фото без подписи и без автора ─────────────────
  const photosBefore = (await chatMessages(c.page, nick(bob))).filter((m) => m.hasPhoto).length;
  // После пересылки tt открывает чат получателя — назад к исходному
  await openPrivateChatStrict(b.page, alice);
  await forwardWithOption(b.page, caption, carol, 'Hide Caption');
  const bare = await waitChatMessage(
    c.page, nick(bob), (m) => m.hasPhoto && !m.isOutgoing, 'A3: фото без подписи у carol',
  );
  assert.equal(bare.text, undefined, `A3: «Скрыть подпись» — подпись дошла: ${bare.text}`);
  assert.equal(bare.hasForward, false, 'A3: «Скрыть подпись» — заголовок пересылки остался');
  assert.equal(photosBefore, 0, 'carol: фото от bob было ещё до пересылки');
  console.log('OK: A3 — пересылка без подписи дошла фото без текста');

  // ── A4: «Отправить без звука» — у получателя сообщение беззвучное ─────────
  await openPrivateChatStrict(b.page, carol);
  const quiet = `daily-quiet-${suffix}`;
  // Только композер активного чата: композер прежнего чата ещё живёт в DOM во время перехода
  const input = b.page.locator('.Transition_slide-active #editable-message-text[contenteditable="true"]').last();
  await input.fill(quiet);
  await b.page.locator('.Transition_slide-active .Composer .main-button').last().click({ button: 'right' });
  await b.page.getByRole('menuitem', { name: 'Send Without Sound' }).click();
  const silent = await waitChatMessage(c.page, nick(bob), (m) => m.text === quiet, 'A4: беззвучное у carol');
  assert.equal(silent.isSilent, true, 'A4: «Отправить без звука» дошло обычным сообщением');
  const loud = `daily-loud-${suffix}`;
  await input.fill(loud);
  await input.press('Enter');
  const normal = await waitChatMessage(c.page, nick(bob), (m) => m.text === loud, 'A4: обычное у carol');
  assert.equal(normal.isSilent, false, 'A4: обычное сообщение пришло беззвучным');
  console.log('OK: A4 — «Отправить без звука» доходит беззвучным, обычное — со звуком');

  // ── A2: предпросмотр ссылки над полем ввода; «Убрать предпросмотр» — без карточки ──
  const link = `https://example.org/daily-${suffix}`;
  await input.fill(`see ${link}`);
  const preview = b.page.locator('.Transition_slide-active .Composer').last().getByRole('button', { name: 'Remove Preview' });
  await preview.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await preview.click();
  await preview.waitFor({ state: 'hidden', timeout: LOGIN_TIMEOUT_MS });
  await input.press('Enter');
  const noCard = await waitChatMessage(c.page, nick(bob), (m) => m.text?.includes(link), 'A2: ссылка у carol');
  assert.equal(noCard.hasWebPage, false, 'A2: «Убрать предпросмотр» — карточка всё равно ушла');
  console.log('OK: A2 — предпросмотр ссылки над полем ввода, «Убрать предпросмотр» отключает карточку');

  // ── A7: вкладка «Медиа» глобального поиска без запроса — последние фото со всех чатов ──
  const media = await c.page.evaluate(() => window.__parvaneDiagCallApi('searchMessagesGlobal', {
    query: '', type: 'media', limit: 50,
  }));
  assert.ok(media?.messages?.some((m) => m.content?.photo), 'A7: «Медиа» без запроса пуста');
  const byName = await b.page.evaluate((text) => window.__parvaneDiagCallApi('searchMessagesGlobal', {
    query: text, type: 'media', limit: 50,
  }), caption);
  assert.ok(byName?.messages?.length, 'A7: «Медиа» с запросом не нашла фото по подписи');
  console.log('OK: A7 — вкладки типа глобального поиска без запроса и с запросом');

  // ── A5: «Перейти к дате» — первое сообщение не раньше даты ────────────────
  const history = (await chatMessages(c.page, nick(bob))).sort((x, y) => x.date - y.date || x.id - y.id);
  const target = history.find((m) => m.text === quiet);
  const jumped = await c.page.evaluate(async ({ name, ts }) => {
    const g = window.__parvaneGetGlobal();
    const chat = Object.values(g.chats.byId).find((candidate) => (
      Object.values(g.users.byId).some((u) => u.id === candidate.id
        && u.usernames?.some(({ username }) => username === name))
    ));
    return window.__parvaneDiagCallApi('findFirstMessageIdAfterDate', { chat, timestamp: ts });
  }, { name: nick(bob), ts: target.date });
  assert.ok(jumped, 'A5: «Перейти к дате» не нашло сообщение');
  const jumpedTo = history.find((m) => m.id === jumped);
  assert.ok(jumpedTo && jumpedTo.date >= target.date
    && !history.some((m) => m.date >= target.date && m.date < jumpedTo.date), 'A5: не первое сообщение даты');
  console.log('OK: A5 — «Перейти к дате» находит первое сообщение даты');

  // ── A6: стикеры — «В избранное», «Удалить из недавних», «Очистить недавние» ──
  const stickers = await c.page.evaluate(async () => {
    // Встроенный набор Parvane
    const set = await window.__parvaneDiagCallApi('fetchStickerSet', { stickerSetInfo: { id: 'parvane-builtin' } });
    const sticker = set.stickers[3];
    await window.__parvaneDiagCallApi('faveSticker', { sticker });
    const faves = await window.__parvaneDiagCallApi('fetchFavoriteStickers', {});
    const recentBefore = await window.__parvaneDiagCallApi('fetchRecentStickers', {});
    await window.__parvaneDiagCallApi('removeRecentSticker', { sticker: recentBefore.stickers[0] });
    const recentAfterRemove = await window.__parvaneDiagCallApi('fetchRecentStickers', {});
    await window.__parvaneDiagCallApi('clearRecentStickers');
    const recentCleared = await window.__parvaneDiagCallApi('fetchRecentStickers', {});
    await window.__parvaneDiagCallApi('faveSticker', { sticker, unfave: true });
    const favesAfter = await window.__parvaneDiagCallApi('fetchFavoriteStickers', {});
    return {
      faved: faves.stickers.map((s) => s.id),
      id: sticker.id,
      removed: recentBefore.stickers[0].id,
      afterRemove: recentAfterRemove.stickers.map((s) => s.id),
      cleared: recentCleared.stickers.length,
      favesAfter: favesAfter.stickers.length,
    };
  });
  assert.deepEqual(stickers.faved, [stickers.id], 'A6: стикер не попал в избранное');
  assert.ok(!stickers.afterRemove.includes(stickers.removed), 'A6: «Удалить из недавних» не удалило');
  assert.equal(stickers.cleared, 0, 'A6: «Очистить недавние» не очистило');
  assert.equal(stickers.favesAfter, 0, 'A6: «Убрать из избранного» не убрало');
  console.log('OK: A6 — избранные и недавние стикеры');

  assertNoPageErrors({ alice: a, bob: b, carol: c });
  console.log('OK: e2e_web_daily_fixes');
} catch (error) {
  const shotDir = process.env.PARVANE_E2E_SHOT_DIR;
  if (shotDir) {
    await Promise.all(sessions.map((s, i) => s?.page.screenshot({ path: `${shotDir}/daily-fixes-${i}.png` })
      .catch(() => {})));
  }
  for (const [i, s] of sessions.entries()) {
    if (s) await dumpDiagJournal(s.page, ['alice', 'bob', 'carol'][i]).catch(() => {});
  }
  throw error;
} finally {
  await browser.close();
}
