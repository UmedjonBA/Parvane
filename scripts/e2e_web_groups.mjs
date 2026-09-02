// Трёхбраузерный групповой сценарий: создание группы через UI, добавление
// участника, доставка группового текста и зашифрованного фото, удаление
// участника с изоляцией от последующих сообщений.
import assert from 'node:assert/strict';
import zlib from 'node:zlib';

import { chromium } from '../web/telegram-tt/node_modules/playwright/index.mjs';

import {
  dumpDiagJournal,
  openMessageMenu,
  LOGIN_TIMEOUT_MS,
  findMessage,
  findMessageContainers,
  openPrivateChat,
  preparePage,
  selectMessageActionOn,
  sendText,
} from './e2e_web_helpers.mjs';

const PASSWORD = 'Parvane-groups-e2e-password';

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

// Клик по строке пикера иногда не отмечает участника (анимации/перемонтаж):
// повторяем, пока чекбокс строки не станет отмеченным
async function selectPickerRow(page, containerSelector, name) {
  const row = page.locator(`${containerSelector} .PeerPickerItem, ${containerSelector} .ItemPickerItem`)
    .filter({ hasText: name })
    .first();
  await row.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  // Только чекбоксы строк пикера: в контейнере могут быть посторонние
  // включённые тумблеры (например, Notifications в профиле позади)
  const checkedRows = `${containerSelector} .PeerPickerItem input[type="checkbox"]:checked, `
    + `${containerSelector} .ItemPickerItem input[type="checkbox"]:checked`;
  for (let attempt = 0; attempt < 6; attempt++) {
    const checked = await page.locator(checkedRows).count();
    if (checked > 0) return;
    // Пробел — штатная клавиатурная активация PickerItem (role=button):
    // надёжнее кликов, которые перехватывают анимации переходов
    if (attempt % 2 === 0) {
      await row.press(' ').catch(() => {});
    } else {
      await row.click({ force: true }).catch(() => {});
    }
    await page.waitForTimeout(500);
  }
  assert.fail(`picker row for ${name} is never selected in ${containerSelector}`);
}

async function voteInPoll(poll, optionText) {
  const option = poll.getByText(optionText, { exact: true }).first();
  await option.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await option.click();
  // Режим с чекбоксами требует подтверждения кнопкой Vote
  const voteButton = poll.getByText('Vote', { exact: true });
  if (await voteButton.count()) await voteButton.first().click();
}

async function openGroupChat(page, title) {
  const item = page.locator('#LeftColumn .ListItem').filter({ hasText: title }).first();
  await item.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await item.locator('.ListItem-button').click();
  await page.locator('#editable-message-text').waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
}

async function attachPhoto(page, caption) {
  await page.getByRole('button', { name: 'Add an attachment' }).click();
  const fileChooserPromise = page.waitForEvent('filechooser');
  await page.getByRole('menuitem', { name: 'Photo or Video' }).click();
  const fileChooser = await fileChooserPromise;
  await fileChooser.setFiles({
    name: 'group-photo.png',
    mimeType: 'image/png',
    buffer: makeSolidPng(96, [180, 60, 150]),
  });
  const captionInput = page.locator('#editable-message-text-modal');
  await captionInput.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await captionInput.fill(caption);
  await captionInput.press('Enter');
  await captionInput.waitFor({ state: 'hidden', timeout: LOGIN_TIMEOUT_MS });
}

const browser = await chromium.launch();
const aliceContext = await browser.newContext();
const bobContext = await browser.newContext();
const charlieContext = await browser.newContext();

try {
  const suffix = `${Date.now()}-${process.pid}`;
  const alice = `group-alice-${suffix}@local`;
  const bob = `group-bob-${suffix}@local`;
  const charlie = `group-charlie-${suffix}@local`;
  const bobName = bob.split('@')[0];
  const charlieName = charlie.split('@')[0];
  const groupTitle = `Group ${suffix}`;
  const helloBob = `hello-bob-${suffix}`;
  const helloCharlie = `hello-charlie-${suffix}`;
  const groupMessage = `group-msg-${suffix}`;
  const photoCaption = `group-photo-${suffix}`;
  const afterRemoval = `after-removal-${suffix}`;

  const aliceSession = await preparePage(aliceContext, alice, PASSWORD);
  const bobSession = await preparePage(bobContext, bob, PASSWORD);
  const charlieSession = await preparePage(charlieContext, charlie, PASSWORD);

  // Знакомство: Alice должна знать Bob и Charlie, чтобы выбрать их в пикере
  await openPrivateChat(aliceSession.page, bob);
  await sendText(aliceSession.page, helloBob);
  await openPrivateChat(aliceSession.page, charlie);
  await sendText(aliceSession.page, helloCharlie);

  // ── Создание группы через UI (участник при создании: Bob) ──────────────────
  // Кнопка нового чата появляется по mouseenter на список чатов: уводим
  // курсор в центр окна и возвращаем, чтобы событие гарантированно сработало
  await aliceSession.page.mouse.move(800, 360);
  await aliceSession.page.waitForTimeout(200);
  await aliceSession.page.locator('#LeftColumn').hover();
  await aliceSession.page.getByRole('button', { name: 'New Message' }).click();
  await aliceSession.page.getByRole('menuitem', { name: 'New Group' }).click();
  const memberSearch = aliceSession.page.locator('#new-group-picker-search');
  await memberSearch.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await memberSearch.fill(bobName);
  await selectPickerRow(aliceSession.page, '#LeftColumn', bobName);
  await aliceSession.page.getByRole('button', { name: 'Continue To Group Info' }).click();
  const nameInput = aliceSession.page.getByLabel('Group name');
  await nameInput.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await nameInput.fill(groupTitle);
  await aliceSession.page.getByRole('button', { name: 'Create Group' }).click();
  await aliceSession.page.locator('#editable-message-text').waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });

  // ── Добавление Charlie через профиль группы ────────────────────────────────
  // Создание не всегда переключает активный чат — открываем группу явно
  await openGroupChat(aliceSession.page, groupTitle);
  await aliceSession.page.locator('.MiddleHeader .ChatInfo').click();
  const addMembersButton = aliceSession.page.getByRole('button', { name: 'Add members' });
  await addMembersButton.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await addMembersButton.click();
  const addSearch = aliceSession.page.locator('#new-members-picker-search');
  await addSearch.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await addSearch.fill(charlieName);
  await selectPickerRow(aliceSession.page, '#RightColumn', charlieName);
  await aliceSession.page.locator('#RightColumn').getByRole('button', { name: 'Add members' }).click();
  // Участник появился в списке членов группы
  await aliceSession.page.locator('#RightColumn .ListItem').filter({ hasText: charlieName }).first()
    .waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });

  // ── Групповой текст доходит обоим участникам ───────────────────────────────
  await openGroupChat(aliceSession.page, groupTitle);
  await sendText(aliceSession.page, groupMessage);
  await openGroupChat(bobSession.page, groupTitle);
  await findMessage(bobSession.page, groupMessage).first()
    .waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await openGroupChat(charlieSession.page, groupTitle);
  await findMessage(charlieSession.page, groupMessage).first()
    .waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });

  // ── «Seen by»: у автора в меню сообщения — кто прочитал (msg.chat.readers) ─
  // Receipts bob/charlie доезжают до alice delta-синком (✓✓), потом меню
  // грузит список прочитавших; ждём, пока в подписи не появится счётчик/имя
  {
    if (process.env.PARVANE_E2E_DEBUG_READ) {
      for (const [who, session] of [['bob', bobSession], ['charlie', charlieSession], ['alice', aliceSession]]) {
        const st = await session.page.evaluate(() => {
          const g = window.__parvaneGetGlobal?.();
          const tab = Object.values(g.byTabId || {})[0];
          const chatId = tab?.messageLists?.[0]?.chatId;
          const th = g.messages?.byChatId?.[chatId]?.threadsById?.['-1'] || {};
          const byId = g.messages?.byChatId?.[chatId]?.byId || {};
          return { chatId, readState: th.readState, listed: th.localState?.listedIds, ids: Object.keys(byId), unread: g.chats?.byId?.[chatId]?.unreadCount };
        });
        console.error(`[debug-read] ${who}: ${JSON.stringify(st)}`);
      }
    }
    const seenLabel = aliceSession.page.locator('.MessageContextMenu--seen-by-label');
    const readSeenModal = () => aliceSession.page.evaluate(() => {
      const modal = Array.from(document.querySelectorAll('.Modal'))
        .find((el) => (el.textContent || '').includes('Seen by'));
      return modal ? { title: modal.querySelector('.modal-title')?.textContent || '', text: modal.textContent || '' } : undefined;
    });
    let seenModal;
    for (let attempt = 0; attempt < 12 && !seenModal?.title.startsWith('Seen by 2'); attempt++) {
      await openMessageMenu(aliceSession.page, groupMessage);
      await seenLabel.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
      await aliceSession.page.waitForTimeout(1500);
      await seenLabel.click();
      // Модалка — async-чанк; опрашиваем DOM (локаторы .Modal здесь нестабильны)
      for (let tick = 0; tick < 30; tick++) {
        await aliceSession.page.waitForTimeout(500);
        seenModal = await readSeenModal();
        if (seenModal) break;
      }
      if (seenModal?.title.startsWith('Seen by 2')) break;
      await aliceSession.page.keyboard.press('Escape');
      await aliceSession.page.waitForTimeout(4000);
    }
    assert.ok(seenModal?.title.startsWith('Seen by 2'), `seen-by modal must list 2 readers, got: ${seenModal?.title}`);
    // Имена в списке усечены (…), матчим по префиксу
    assert.ok(seenModal.text.includes(bobName.slice(0, 18)), 'seen-by list must include bob');
    assert.ok(seenModal.text.includes(charlieName.slice(0, 18)), 'seen-by list must include charlie');
    await aliceSession.page.keyboard.press('Escape');
    await aliceSession.page.waitForTimeout(500);
  }

  // ── Зашифрованное фото в группе ────────────────────────────────────────────
  await attachPhoto(aliceSession.page, photoCaption);
  for (const session of [bobSession, charlieSession]) {
    const container = findMessageContainers(session.page, photoCaption).first();
    await container.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
    await container.locator('img[src^="blob:"]').first()
      .waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  }

  // ── Опрос: создание, голосование, публичные голосовавшие, закрытие ─────────
  const pollQuestion = `poll-${suffix}`;
  await aliceSession.page.getByRole('button', { name: 'Add an attachment' }).click();
  await aliceSession.page.getByRole('menuitem', { name: 'Poll' }).click();
  const questionInput = aliceSession.page.getByLabel('Ask a Question');
  await questionInput.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await questionInput.fill(pollQuestion);
  // Заполненная add-row превращается в option-row асинхронно: дожидаемся
  // конверсии, иначе второй fill затирает первый вариант
  await aliceSession.page.getByPlaceholder('Add an Option').fill('Da');
  await aliceSession.page.waitForFunction(() => Array.from(document.querySelectorAll('input'))
    .some((input) => input.placeholder === 'Option' && input.value === 'Da'));
  await aliceSession.page.getByPlaceholder('Add an Option').fill('Net');
  await aliceSession.page.waitForFunction(() => Array.from(document.querySelectorAll('input'))
    .some((input) => input.placeholder === 'Option' && input.value === 'Net'));
  await aliceSession.page.getByRole('dialog').getByRole('button', { name: 'Send', exact: true }).click();
  const alicePoll = findMessageContainers(aliceSession.page, pollQuestion).first();
  await alicePoll.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });

  const bobPoll = findMessageContainers(bobSession.page, pollQuestion).first();
  await bobPoll.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await voteInPoll(bobPoll, 'Da');
  // Публичный опрос: проголосовавший видит просмотр результатов
  await bobPoll.getByText('View Results', { exact: true }).first()
    .waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  // Alice голосует за второй вариант; наличие View Results подтверждает,
  // что голос Bob дошёл (results доступны обоим)
  await voteInPoll(alicePoll, 'Net');
  await alicePoll.getByText('View Results', { exact: true }).first()
    .waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });

  await selectMessageActionOn(aliceSession.page, alicePoll, 'Stop poll');
  await aliceSession.page.locator('.Modal').getByRole('button', { name: 'Stop poll' })
    .click({ timeout: LOGIN_TIMEOUT_MS });
  await bobPoll.getByText(/Final results/i).first()
    .waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });

  // ── Удаление Charlie из группы через UI ────────────────────────────────────
  await aliceSession.page.locator('.MiddleHeader .ChatInfo').click();
  const charlieItem = aliceSession.page.locator('#RightColumn .ListItem')
    .filter({ hasText: charlieName }).first();
  await charlieItem.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await charlieItem.click({ button: 'right' });
  await aliceSession.page.getByRole('menuitem', { name: 'Remove from group' })
    .click({ timeout: LOGIN_TIMEOUT_MS });
  await aliceSession.page.locator('.Modal').getByRole('button', { name: 'Remove', exact: true })
    .click({ timeout: LOGIN_TIMEOUT_MS });
  await charlieItem.waitFor({ state: 'detached', timeout: LOGIN_TIMEOUT_MS });

  // ── Изоляция удалённого участника от последующих сообщений ─────────────────
  await openGroupChat(aliceSession.page, groupTitle);
  await sendText(aliceSession.page, afterRemoval);
  await findMessage(bobSession.page, afterRemoval).first()
    .waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await charlieSession.page.waitForTimeout(5000);
  assert.equal(
    await findMessage(charlieSession.page, afterRemoval).count(),
    0,
    'removed member still receives new group messages',
  );

  assert.deepEqual(aliceSession.errors, [], `Alice page errors: ${aliceSession.errors.join('; ')}`);
  assert.deepEqual(bobSession.errors, [], `Bob page errors: ${bobSession.errors.join('; ')}`);
  assert.deepEqual(charlieSession.errors, [], `Charlie page errors: ${charlieSession.errors.join('; ')}`);

  console.log('OK: group create/add/remove via UI, encrypted group text and photo, removed-member isolation');
} catch (err) {
  const dir = new URL('../web/telegram-tt/test-results/', import.meta.url).pathname;
  for (const [name, context] of [['alice', aliceContext], ['bob', bobContext], ['charlie', charlieContext]]) {
    const page = context.pages()[0];
    if (page) {
      await page.screenshot({ path: `${dir}groups-${name}.png` }).catch(() => {});
      await dumpDiagJournal(page, name, 80);
    }
  }
  throw err;
} finally {
  await aliceContext.close();
  await bobContext.close();
  await charlieContext.close();
  await browser.close();
}
