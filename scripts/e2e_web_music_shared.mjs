// «Музыка», spec 041 (правило MUSIC-3 и «Найти и скачать» до макета): общий плейлист двух аккаунтов и задачи сервера.
// Общий плейлист: alice создаёт его окном «Новый плейлист» с «Кто видит: Выбранные люди», зовёт bob по нику
// («Позвать», роль «Добавляет»), bob видит приглашение в списке и открывает плейлист (отметка снимается), alice
// видит «добавил(а) …» у трека bob, меняет его роль на «Слушает» — сервер больше не даёт bob править; alice убирает
// bob и шлёт плейлист в чат карточкой — bob вступает «Открыть» по ключу из карточки и снова «Добавляет»; «Закрыть
// для всех» делает плейлист личным. «Найти и скачать»: кнопка по запросу (эталон берёт сервер), ход в процентах и
// «Отменить», отказ сервиса с причиной словами сервера, «Недавние запросы», экран «Загрузки на сервер». «Загрузить
// свои файлы»: свой MP3 с тегами уходит на сервер, второй раз — «уже есть в библиотеке».
// Запуск: scripts/run_web_music_shared_e2e.sh
import assert from 'node:assert/strict';

import { chromium } from '../web/telegram-tt/node_modules/playwright/index.mjs';

import {
  LOGIN_TIMEOUT_MS,
  assertNoPageErrors,
  dismissRecoveryKeyDialog,
  exchangeMessages,
  preparePage,
} from './e2e_web_helpers.mjs';

const PASSWORD = 'Parvane-music-e2e-1';
const WIDE = { width: 1600, height: 900 };
const STEP_TIMEOUT_MS = 20000;
const SHARED_NAME = 'Linux-чат: общее';

const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
const sessions = [];

async function openMusic(page) {
  const rail = page.locator('#FoldersSidebar');
  await rail.or(page.getByRole('navigation', { name: 'Modules' })).first()
    .waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  if (await rail.isVisible().catch(() => false)) await rail.getByRole('tab', { name: 'Music', exact: true }).click();
  else await page.getByRole('navigation', { name: 'Modules' }).getByRole('button', { name: 'Music' }).click();
  const music = page.locator('#ParvaneMusic');
  await page.locator('#ParvaneMusic[data-music-enabled="true"]').waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  return music;
}

async function openChats(page) {
  await page.locator('#FoldersSidebar').getByRole('tab', { name: 'Chats' }).click();
}

// Метод провайдера из диагностической сборки: проверка прав сервера мимо экрана
function callApi(page, name, args) {
  return page.evaluate(async ([method, payload]) => {
    try {
      return { result: await window.__parvaneDiagCallApi(method, payload) };
    } catch (err) {
      return { error: String(err) };
    }
  }, [name, args]);
}

// Открыть общий плейлист из навигации (группа «Плейлисты»)
async function openShared(music, id) {
  const item = music.locator(`[data-music-nav] [data-shared="${id}"]`);
  await item.waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS * 2 });
  await item.click();
  const page = music.locator(`[data-music-shared="${id}"]`);
  await page.waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  return page;
}

// Поиск «Музыки» с запросом
async function search(music, query) {
  await music.locator('[data-music-nav] [data-view="search"]').click();
  const input = music.locator('[data-music-search] input[type="search"]');
  await input.fill(query);
  // Блок перерисовывается после задержки поиска: ждём кнопку именно этого запроса
  const block = music.locator('[data-music-fetch]');
  await block.locator('[data-fetch-by-query]').filter({ hasText: query })
    .or(block.locator('[data-fetch-job]').filter({ hasText: query }))
    .first().waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  return block;
}

// Небольшой MP3 с тегами ID3v2.3 (название, исполнитель) и кадром звука
function buildMp3(title, artist) {
  const frame = (id, text) => {
    const body = Buffer.concat([Buffer.from([3]), Buffer.from(text, 'utf8')]);
    const head = Buffer.alloc(10);
    head.write(id, 0, 'latin1');
    head.writeUInt32BE(body.length, 4);
    return Buffer.concat([head, body]);
  };
  const frames = Buffer.concat([frame('TIT2', title), frame('TPE1', artist)]);
  const n = frames.length;
  const header = Buffer.from([0x49, 0x44, 0x33, 3, 0, 0, (n >> 21) & 0x7f, (n >> 14) & 0x7f, (n >> 7) & 0x7f, n & 0x7f]);
  return Buffer.concat([header, frames, Buffer.from([0xff, 0xfb, 0x90, 0x00]), Buffer.alloc(6000, 0x55)]);
}

try {
  const suffix = Date.now().toString(36);
  const alice = `ma-${suffix}@local`;
  const bob = `mb-${suffix}@local`;
  const bobNick = bob.split('@')[0];
  const aliceContext = await browser.newContext({ viewport: WIDE });
  const bobContext = await browser.newContext({ viewport: WIDE });
  const a = await preparePage(aliceContext, alice, PASSWORD);
  sessions.push(a);
  const b = await preparePage(bobContext, bob, PASSWORD);
  sessions.push(b);
  await dismissRecoveryKeyDialog(a.page).catch(() => undefined);
  await dismissRecoveryKeyDialog(b.page).catch(() => undefined);
  // Карточка плейлиста идёт в личный чат: переписка в обе стороны
  await exchangeMessages(a.page, alice, b.page, bob, suffix);

  // ── Общий плейлист: окно «Новый плейлист», «Кто видит: Выбранные люди» ──
  const aMusic = await openMusic(a.page);
  await aMusic.locator('[data-music-nav] [data-music-new-playlist]').click();
  const form = a.page.locator('[data-music-new-playlist-form]');
  await form.getByRole('textbox', { name: 'Name' }).fill(SHARED_NAME);
  await form.locator('[data-music-access]').getByRole('button', { name: 'Selected people' }).click();
  await form.locator('[data-music-access="members"]').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await form.locator('button[type="submit"]').click();
  const aPage = aMusic.locator('[data-music-shared][data-role="owner"]');
  await aPage.waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  const sharedId = await aPage.getAttribute('data-music-shared');
  await aPage.getByText('Shared playlist').first().waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  // Трек владельца — тем же методом, что и меню трека
  const t1 = { trackId: 't1', title: 'Северный ветер', artist: 'Тихий порт', durationSecs: 4 };
  assert.ok(!(await callApi(a.page, 'parvaneMusicSharedItems', { id: sharedId, add: [t1] })).error, 'владелец добавил трек');
  await aPage.locator('[data-music-shared-tracks] [data-track="t1"]').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS * 2 });
  console.log('OK: общий плейлист создан окном «Новый плейлист» («Выбранные люди»)');

  // ── Позвать по нику: неизвестный ник — отказ, bob — «Добавляет» ──
  await aPage.locator('[data-music-members-open]').click();
  const members = a.page.locator('[data-music-members]');
  await members.locator('[data-music-invite-nick]').fill('nobody-here-zz');
  await members.getByRole('button', { name: 'Invite', exact: true }).click();
  await members.locator('[data-music-invite-error="unknown"]').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await members.locator('[data-music-invite-nick]').fill(`@${bobNick}`);
  await members.getByRole('button', { name: 'Invite', exact: true }).click();
  const bobRow = members.locator(`[data-music-member="${bob}"]`);
  await bobRow.getByText('Invited, has not opened it yet').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await a.page.keyboard.press('Escape');
  console.log('OK: позван по нику; неизвестный ник отклонён');

  // ── bob: приглашение в списке, открыл — отметка снята, добавил трек ──
  const bMusic = await openMusic(b.page);
  // Приглашение — в группе «Плейлисты» навигации с отметкой «позван»
  await bMusic.locator(`[data-music-nav] [data-shared="${sharedId}"][data-shared-invited]`)
    .waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS * 2 });
  await bMusic.locator(`[data-music-nav] [data-shared="${sharedId}"]`).click();
  const bPage = bMusic.locator(`[data-music-shared="${sharedId}"][data-role="editor"]`);
  await bPage.waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  const t4 = { trackId: 't4', title: 'Glass Harbor', artist: 'Kora Mesh', durationSecs: 30 };
  const added = await callApi(b.page, 'parvaneMusicSharedItems', { id: sharedId, add: [t4, t1] });
  assert.equal(added.result?.skipped, 1, `повтор трека пропущен: ${JSON.stringify(added)}`);
  await bPage.locator('[data-music-shared-tracks] [data-track="t4"]').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS * 2 });
  await aPage.locator('[data-music-shared-tracks] [data-track="t4"]').getByText(`added by ${bobNick}`)
    .waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS * 2 });
  await aPage.locator('[data-music-shared-recent]').getByText('Glass Harbor').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await aPage.locator('[data-music-members-open]').click();
  await bobRow.getByText('Added 1 track').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS * 2 });
  console.log('OK: bob открыл приглашение и добавил трек; у alice — «добавил(а)» и «Последние добавления»');

  // ── Роль «Слушает»: сервер не даёт править ──
  await bobRow.locator('select').selectOption('listener');
  await members.locator(`[data-music-member="${bob}"][data-role="listener"]`).waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  const refused = await callApi(b.page, 'parvaneMusicSharedItems', { id: sharedId, add: [{ ...t4, trackId: 't5' }] });
  assert.match(String(refused.error), /FORBIDDEN/, `слушающий не правит: ${JSON.stringify(refused)}`);
  console.log('OK: «Слушает» — правка отклонена сервером');

  // ── Убрать bob; плейлист в чат — bob вступает «Открыть» по ключу из карточки ──
  await bobRow.locator('[data-music-member-remove]').click();
  await bobRow.waitFor({ state: 'detached', timeout: STEP_TIMEOUT_MS });
  await a.page.keyboard.press('Escape');
  const gone = await callApi(b.page, 'parvaneMusicSharedGet', { id: sharedId });
  assert.match(String(gone.error), /NOT_FOUND/, 'убранному частный плейлист не виден');
  await aPage.locator('[data-music-shared-to-chat]').click();
  await a.page.locator('.Modal .modal-dialog').getByText(bobNick).first().click();
  await a.page.getByText('Playlist sent').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await openChats(b.page);
  await b.page.locator('#LeftColumn .chat-list').getByText(alice.split('@')[0]).first().click();
  const card = b.page.locator(`[data-music-shared-card="${sharedId}"]`);
  await card.getByText('Shared playlist').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS * 2 });
  await card.getByRole('button', { name: 'Open', exact: true }).click();
  await b.page.locator(`#ParvaneMusic [data-music-shared="${sharedId}"][data-role="editor"]`)
    .waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS * 2 });
  console.log('OK: плейлист чата — bob вступил по карточке и снова «Добавляет»');

  // ── «Закрыть для всех»: плейлист становится личным у alice ──
  await aPage.locator('[data-music-members-open]').click();
  await members.locator('[data-music-make-personal]').click();
  await aMusic.locator('[data-music-playlist]').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS * 2 });
  await aMusic.locator('[data-music-playlist] [data-track="t4"]').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS * 2 });
  const closed = await callApi(b.page, 'parvaneMusicSharedGet', { id: sharedId });
  assert.match(String(closed.error), /NOT_FOUND/, 'общий плейлист удалён у всех');
  console.log('OK: «Закрыть для всех» — треки в личном плейлисте, общий удалён');

  // ── «Найти и скачать «запрос»»: ход в процентах и отмена ──
  let fetchBlock = await search(aMusic, 'медленный берег');
  await fetchBlock.getByText('Not on the server').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await fetchBlock.locator('[data-fetch-by-query]').click();
  const slowJob = fetchBlock.locator('[data-fetch-job][data-fetch-state="downloading"]').first();
  await slowJob.locator('[data-fetch-percent]').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS * 2 });
  await slowJob.getByText(/The server is downloading · [\d.,]+ of 8[.,]0 MB/).waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await slowJob.locator('[data-fetch-cancel]').click();
  await fetchBlock.locator('[data-fetch-by-query]').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  console.log('OK: «Найти и скачать» по запросу — ход в процентах, отмена');

  // ── Отказ сервиса с причиной словами сервера ──
  fetchBlock = await search(aMusic, 'закрытый берег');
  await fetchBlock.locator('[data-fetch-by-query]').click();
  await fetchBlock.getByText('The server cannot download: источник закрыт администратором')
    .waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS * 2 });
  console.log('OK: причина отказа — словами сервера');

  // ── «Недавние запросы» и «Загрузки на сервер» ──
  await aMusic.locator('[data-music-search] input[type="search"]').fill('');
  const recent = aMusic.locator('[data-music-recent]');
  await recent.getByRole('button', { name: 'закрытый берег', exact: true }).waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await recent.getByRole('button', { name: 'медленный берег', exact: true }).waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await aMusic.locator('[data-fetch-uploads]').first().click();
  const uploads = aMusic.locator('[data-music-uploads]');
  await uploads.locator('[data-fetch-job][data-fetch-state="failed"]').getByText(/The server cannot download/)
    .waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await uploads.locator('[data-fetch-job][data-fetch-state="failed"] [data-fetch-remove]').click();
  await uploads.locator('[data-music-empty="uploads"]').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  console.log('OK: «Недавние запросы» и «Загрузки на сервер» («Убрать»)');

  // ── «Загрузить свои файлы»: MP3 с тегами; тот же файл второй раз — «уже есть» ──
  const mp3 = buildMp3('Своя песня', 'Тихий порт');
  await uploads.locator('[data-music-upload-input]').setInputFiles({ name: 'своя.mp3', mimeType: 'audio/mpeg', buffer: mp3 });
  const ownJob = uploads.locator('[data-fetch-job][data-fetch-state="done"]').filter({ hasText: 'своя.mp3' });
  await ownJob.waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS * 3 });
  await ownJob.locator('[data-fetch-play]').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await uploads.locator('[data-music-upload-input]').setInputFiles({ name: 'копия.mp3', mimeType: 'audio/mpeg', buffer: mp3 });
  await uploads.locator('[data-fetch-job][data-fetch-failure="duplicate"]').filter({ hasText: 'копия.mp3' })
    .waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS * 2 });
  console.log('OK: свой файл загружен на сервер, повтор — «уже есть в библиотеке»');

  sessions.forEach((session) => assertNoPageErrors({ session }));
  console.log('OK: общие плейлисты, «Найти и скачать» и свои файлы');
} catch (error) {
  const shotDir = process.env.PARVANE_E2E_SHOT_DIR || process.env.PARVANE_E2E_BACKEND_LOG_DIR;
  for (const [index, session] of sessions.entries()) {
    if (shotDir) await session.page.screenshot({ path: `${shotDir}/music-shared-${index}.png` }).catch(() => {});
    console.error(session.logs.slice(-40).join('\n'));
  }
  throw error;
} finally {
  await browser.close();
}
