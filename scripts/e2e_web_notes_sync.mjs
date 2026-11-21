// «Заметки» на двух устройствах одного аккаунта (spec 041 хвосты D, spec 040 T9): текст, сохранённый без связи,
// ждёт в очереди устройства с пометкой «не отправлено», переживает перезагрузку и уходит при появлении связи;
// одна строка, изменённая на двух устройствах, — экран расхождения (доски `RpNotes`, `ZdNotesX`): выбор в каждом
// месте, «Сохранить объединённую заметку», копия «… (конфликт …)» уходит в корзину; холст, правленный на обоих почти
// одновременно, сводится по карточкам (NOTES-3). Снимки — компьютер и телефон.
// Запуск: scripts/run_web_notes_sync_e2e.sh
import assert from 'node:assert/strict';

import { chromium } from '../web/telegram-tt/node_modules/playwright/index.mjs';

import {
  dismissRecoveryKeyDialog,
  linkSecondDevice,
  openNotesView,
  preparePage,
} from './e2e_web_helpers.mjs';

const PASSWORD = 'Parvane-notes-sync-1';
const DESK = { width: 1280, height: 800 };
const PHONE = { width: 360, height: 800 };
const STEP_TIMEOUT_MS = 20000;
const SYNC_TIMEOUT_MS = 45000;
const BASE_URL = process.env.PARVANE_E2E_BASE_URL;
const SHOT_DIR = process.env.PARVANE_E2E_SHOT_DIR || process.env.PARVANE_E2E_BACKEND_LOG_DIR || '';
const NOTE = 'Туннель';
const START = `# ${NOTE}\n\nПорт = 51820\nХост = сервер\nКлюч = общий\n`;

function driver(page) {
  const knowledge = page.locator('#ParvaneKnowledge');
  const note = knowledge.locator('[data-note-id]');
  const body = note.locator('[data-note-body]');
  const row = (title) => knowledge.locator(`[data-note-row="${title}"]`);
  const visible = (locator, what, timeout = STEP_TIMEOUT_MS) => locator.first()
    .waitFor({ state: 'visible', timeout }).catch(() => assert.fail(`не появилось: ${what}`));
  const api = {
    page,
    knowledge,
    note,
    body,
    row,
    visible,
    open: async () => {
      if (!(await knowledge.isVisible().catch(() => false))) {
        await page.locator('#FoldersSidebar').getByRole('tab', { name: 'Notes' }).click();
      }
      await visible(knowledge, 'модуль «Заметки»');
    },
    close: async () => {
      await page.locator('#FoldersSidebar').getByRole('tab', { name: 'Chats' }).click();
      await knowledge.waitFor({ state: 'hidden', timeout: STEP_TIMEOUT_MS });
    },
    pick: async (title) => {
      await visible(row(title), `строка «${title}»`, SYNC_TIMEOUT_MS);
      await row(title).first().click();
      await visible(knowledge.locator(`[data-note-title="${title}"]`), `заметка «${title}» открыта`);
    },
    // Правка текстом: «Правка», весь текст, «Готово»; ждём закрытия редактора (сохранено либо в очереди)
    write: async (text) => {
      await note.locator('[data-note-bar]').getByRole('button', { name: 'Edit', exact: true }).click();
      const editor = page.locator('#knowledge-note-editor');
      await visible(editor, 'редактор');
      for (let attempt = 0; ; attempt++) {
        try { await editor.fill(text, { timeout: 5000 }); break; } catch (error) {
          if (attempt >= 4) throw error;
          await page.waitForTimeout(500);
        }
      }
      await note.locator('[data-note-bar] [data-note-bar-edit]').click();
      await editor.waitFor({ state: 'detached', timeout: SYNC_TIMEOUT_MS })
        .catch(() => assert.fail('правка не закрылась после «Готово»'));
    },
    // Текст открытой заметки дошёл до экрана
    expectText: async (fragment, what) => {
      await page.waitForFunction((wanted) => (
        document.querySelector('#ParvaneKnowledge [data-note-body]')?.textContent?.includes(wanted)
      ), fragment, { timeout: SYNC_TIMEOUT_MS }).catch(() => assert.fail(what));
    },
    shot: async (name) => {
      if (!SHOT_DIR) return;
      await page.waitForTimeout(400);
      for (const scheme of ['light', 'dark']) {
        await page.emulateMedia({ colorScheme: scheme });
        await page.screenshot({ path: `${SHOT_DIR}/notes-sync-${name}-${scheme}.png` }).catch(() => undefined);
      }
      await page.emulateMedia({ colorScheme: 'light' });
    },
  };
  return api;
}

const browser = await chromium.launch();
const sessions = {};

try {
  const user = `nsync-${Date.now().toString(36)}@local`;
  const context1 = await browser.newContext({ viewport: DESK });
  sessions.one = await preparePage(context1, user, PASSWORD);
  await dismissRecoveryKeyDialog(sessions.one.page).catch(() => undefined);
  const context2 = await browser.newContext({ viewport: DESK });
  sessions.two = await preparePage(context2, user, PASSWORD);
  await sessions.two.page.waitForTimeout(3000);
  await linkSecondDevice(sessions.one.page, sessions.two.page);
  let a = driver(sessions.one.page);
  const b = driver(sessions.two.page);

  // ── Заметка с первого устройства видна на втором ──────────────────────────
  await a.open();
  await a.visible(a.row('Overview'), 'справка нового хранилища', SYNC_TIMEOUT_MS);
  await a.page.locator('#FoldersSidebar [data-add-for="notes"]').click();
  await a.visible(a.knowledge.locator('[data-note-title="New note"]'), 'новая заметка');
  await a.page.waitForTimeout(400);
  await a.note.getByLabel('Note title').fill(NOTE);
  await a.note.getByLabel('Note title').blur();
  await a.visible(a.row(NOTE), 'строка заметки');
  await a.write(START);
  await b.open();
  await b.pick(NOTE);
  await b.expectText('Ключ = общий', 'второе устройство не получило заметку');
  console.log('OK: заметка с первого устройства видна на втором');

  // ── Без связи: текст ждёт в очереди с пометкой, переживает перезагрузку ───
  await context1.setOffline(true);
  await a.pick(NOTE);
  await a.write(START.replace('Хост = сервер', 'Хост = без связи'));
  await a.visible(a.note.locator('[data-unsent]'), 'пометка «не отправлено» у заметки');
  await a.visible(a.row(NOTE).locator('[data-unsent]'), 'пометка «не отправлено» в списке');
  assert.match(await a.note.locator('[data-unsent]').first().innerText(), /not sent/, 'текст пометки');
  await a.expectText('Хост = без связи', 'текст без связи не показан на этом устройстве');
  await a.shot('desk-unsent');
  // Запись очереди ложится на устройство в фоне; вкладка закрывается без связи — отправить она не успела бы
  await a.page.waitForTimeout(2000);
  await a.page.close();
  await context1.setOffline(false);
  const reopened = await context1.newPage();
  const reopenedLogs = [];
  reopened.on('console', (message) => reopenedLogs.push(message.text().slice(0, 300)));
  sessions.reopened = { page: reopened, logs: reopenedLogs };
  await reopened.goto(BASE_URL);
  await reopened.locator('#LeftColumn').waitFor({ state: 'visible', timeout: 60000 })
    .catch(() => assert.fail('устройство не вошло само после перезагрузки'));
  a = driver(reopened);
  await a.open();
  await b.expectText('Хост = без связи', 'текст из очереди не дошёл до второго устройства после перезагрузки');
  await a.pick(NOTE);
  await a.note.locator('[data-unsent]').waitFor({ state: 'detached', timeout: SYNC_TIMEOUT_MS })
    .catch(() => assert.fail('пометка «не отправлено» осталась после отправки'));
  console.log('OK: без связи — пометка «не отправлено», очередь пережила перезагрузку и ушла при появлении связи');

  // ── Одна строка на двух устройствах: экран расхождения ────────────────────
  const base = START.replace('Хост = сервер', 'Хост = без связи');
  await context1.setOffline(true);
  await a.write(base.replace('Порт = 51820', 'Порт = 51821'));
  await a.visible(a.note.locator('[data-unsent]'), 'пометка у правки без связи');
  await b.write(base.replace('Порт = 51820', 'Порт = 51822').replace('Ключ = общий', 'Ключ = новый'));
  // Под нагрузкой запись второго устройства может лечь в его очередь (облако молчит дольше 8 с) — дождаться отправки
  await b.note.locator('[data-unsent]').waitFor({ state: 'detached', timeout: SYNC_TIMEOUT_MS })
    .catch(() => assert.fail('правка второго устройства не ушла'));
  await context1.setOffline(false);
  await a.visible(a.note.locator('[data-note-conflict]'), 'полоса «Заметку изменили на двух устройствах»', 60000);
  await a.shot('desk-conflict-bar');
  await a.note.locator('[data-note-conflict-open]').click();
  const view = a.note.locator('[data-note-conflict-view]');
  await a.visible(view, 'экран расхождения');
  // Компьютер (`ZdNotesX`): две версии целиком, устройство и время у каждой, «Оставить эту» / «Оставить обе»
  assert.equal(await view.getAttribute('data-note-conflict-view'), 'columns', 'на компьютере не две колонки');
  const mineColumn = view.locator('[data-conflict-version="mine"]');
  const theirColumn = view.locator('[data-conflict-version="theirs"]');
  assert.match(await mineColumn.innerText(), /This computer · [\s\S]*Порт = 51821/i, 'моя версия с устройством');
  await a.page.waitForFunction(() => /Computer · /i.test(
    document.querySelector('[data-conflict-version="theirs"]')?.textContent || '',
  ), undefined, { timeout: STEP_TIMEOUT_MS }).catch(() => assert.fail('у чужой версии нет устройства и времени'));
  assert.match(await theirColumn.innerText(), /Порт = 51822[\s\S]*Ключ = новый/, 'чужая версия целиком');
  assert.match(await view.locator('[data-conflict-diff]').innerText(), /Differences: line \d+/, 'строка «Отличия»');
  await a.visible(view.locator('[data-conflict-keep]').filter({ hasText: 'Keep both' }), '«Оставить обе»');
  assert.equal(await a.note.locator('[data-note-bar]').count(), 0, 'шапка заметки над экраном двух версий');
  await a.shot('desk-conflict');
  // Смена ширины перерисовывает заметку (колонка ↔ весь экран) — экран расхождения открывается снова
  const reopenConflict = async () => {
    await a.page.waitForTimeout(800);
    if (!(await view.isVisible().catch(() => false))) await a.note.locator('[data-note-conflict-open]').click();
    await a.visible(view, 'экран расхождения после смены ширины');
  };
  await a.page.setViewportSize(PHONE);
  await reopenConflict();
  // Телефон (`RpNotes`): место за местом, пояснение сверху, в шапке только «назад» и название
  assert.equal(await view.getAttribute('data-note-conflict-view'), 'places', 'на телефоне не место за местом');
  assert.equal(await view.locator('[data-conflict-place]').count(), 1, 'расхождение не одно');
  assert.match(await view.locator('[data-conflict-choice="mine"]').innerText(), /This computer · [\s\S]*Порт = 51821/i, 'моя строка');
  // Название чужого устройства подставляется, когда дочитан список своих устройств (до того — «Other device»)
  await view.locator('[data-conflict-choice="theirs"]').filter({ hasText: /Computer · / })
    .waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS }).catch(() => undefined);
  assert.match(await view.locator('[data-conflict-choice="theirs"]').innerText(), /Computer · [\s\S]*Порт = 51822/i, 'их строка');
  await a.visible(view.getByText('This note was changed on two devices.'), 'пояснение на экране расхождения');
  const phoneBar = a.note.locator('[data-note-bar]');
  assert.equal(await phoneBar.locator('[data-note-bar-edit], [data-note-menu]').count(), 0, '«Изменить» и «⋮» над расхождением');
  await a.visible(phoneBar.getByRole('heading', { name: NOTE }), 'название заметки в шапке расхождения');
  await a.shot('phone-conflict');
  // Системное «назад» закрывает экран расхождения, заметка остаётся
  await a.page.waitForTimeout(300);
  await a.page.evaluate(() => window.history.back());
  await view.waitFor({ state: 'detached', timeout: STEP_TIMEOUT_MS }).catch(() => assert.fail('«назад» не закрыл расхождение'));
  await a.visible(a.note.locator('[data-note-conflict]'), 'заметка с полосой после «назад»');
  await a.page.setViewportSize(DESK);
  await reopenConflict();
  // «Оставить эту» у чужой версии: заметка — она целиком, своя — в истории заметки
  await theirColumn.locator('[data-conflict-keep-version="theirs"]').click();
  await view.waitFor({ state: 'detached', timeout: SYNC_TIMEOUT_MS }).catch(() => assert.fail('экран расхождения не закрылся'));
  await a.expectText('Порт = 51822', 'выбранная строка не легла в заметку');
  await a.expectText('Ключ = новый', 'сведённая сама правка второго устройства потерялась');
  assert.equal(await a.note.locator('[data-note-conflict]').count(), 0, 'полоса расхождения осталась');
  await a.knowledge.locator('[data-note-row*="(conflict"]').waitFor({ state: 'detached', timeout: SYNC_TIMEOUT_MS })
    .catch(() => assert.fail('копия «(conflict …)» осталась в списке'));
  await b.expectText('Хост = без связи', 'второе устройство потеряло правку первого');
  assert.equal(
    await b.body.innerText().then((text) => text.includes('Порт = 51821')), false, 'на втором устройстве — отвергнутая строка',
  );
  await a.note.locator('[data-note-menu]').click();
  await a.page.locator('[data-note-menu-list] [data-note-action="versions"]').click();
  await a.page.waitForFunction(() => document.querySelectorAll('[data-cloud-versions] [data-version]').length >= 3,
    undefined, { timeout: STEP_TIMEOUT_MS }).catch(() => assert.fail('своя версия не осталась в истории'));
  await a.page.keyboard.press('Escape');
  console.log('OK: расхождение правок — две версии с устройствами на компьютере, место за местом на телефоне, «назад»; копия убрана');

  // ── Холст на двух устройствах: карточки, добавленные почти одновременно, есть на обоих (NOTES-3) ─────
  const canvasCard = (d, text) => d.knowledge.locator('[data-canvas-board] [data-canvas-type="text"]').filter({ hasText: text });
  const addTextCard = async (d, text) => {
    await d.knowledge.locator('[data-canvas-tool="text"]').click();
    const field = d.knowledge.locator('textarea[data-canvas-inline]');
    await d.visible(field, 'поле текста карточки');
    await field.fill(text);
    await field.press('Enter');
    await d.visible(canvasCard(d, text), `карточка «${text}»`);
  };
  await openNotesView(a.knowledge, 'Canvas');
  await a.knowledge.locator('[data-canvas-list] [data-canvas-new]').first().click();
  await a.visible(a.knowledge.locator('[data-canvas-chip="Canvas 1"]'), 'новый холст');
  await addTextCard(a, 'Север');
  await openNotesView(b.knowledge, 'Canvas');
  const tile = b.knowledge.locator('[data-canvas-tile="Canvas 1"][data-canvas-id], [data-canvas-tile="Canvas 1"] [data-canvas-id]');
  await b.visible(tile, 'холст первого устройства в списке второго', SYNC_TIMEOUT_MS);
  await tile.first().click();
  await b.visible(canvasCard(b, 'Север'), 'карточка первого устройства на втором', SYNC_TIMEOUT_MS);
  // Обе правки — в окне отложенной записи друг друга: запись второго натыкается на чужую версию и сводится
  await Promise.all([addTextCard(a, 'Юг'), addTextCard(b, 'Запад')]);
  for (const [d, name] of [[a, 'первом'], [b, 'втором']]) {
    for (const text of ['Север', 'Юг', 'Запад']) {
      await d.visible(canvasCard(d, text), `на ${name} устройстве нет карточки «${text}» после сведения`, SYNC_TIMEOUT_MS);
    }
  }
  await a.shot('canvas-merged');
  console.log('OK: холст на двух устройствах — одновременные правки сведены, на обоих все карточки');

  console.log('e2e_web_notes_sync: OK');
} catch (error) {
  for (const [name, session] of Object.entries(sessions)) {
    const page = session.page.isClosed() ? session.page.context().pages()[0] : session.page;
    if (SHOT_DIR) await page?.screenshot({ path: `${SHOT_DIR}/notes-sync-failure-${name}.png` }).catch(() => {});
    console.log(`--- ${name}: раздел при сбое ---\n${await page?.locator('#ParvaneKnowledge').innerText().catch(() => '')}`);
    console.log(`--- ${name}: журнал провайдера ---\n${(session.logs || []).slice(-30).join('\n')}`);
  }
  throw error;
} finally {
  await browser.close();
}
