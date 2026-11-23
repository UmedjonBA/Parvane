// «Музыка», spec 041 (правило MUSIC-3 и «Найти и скачать» до макета): общий плейлист двух аккаунтов и задачи сервера.
// Общий плейлист: alice создаёт его окном «Новый плейлист» с «Кто видит: Выбранные люди», зовёт bob по нику
// («Позвать», роль «Добавляет»), bob видит приглашение в списке и открывает плейлист (отметка снимается), alice
// видит «добавил(а) …» у трека bob, меняет его роль на «Слушает» — сервер больше не даёт bob править; alice убирает
// bob и шлёт плейлист в чат карточкой — bob вступает «Открыть» по ключу из карточки и снова «Добавляет»; «Закрыть
// для всех» делает плейлист личным. Трек каталога на сервер: ход в процентах в «Загрузках на сервер» и «Отменить»,
// отказ сервиса с причиной словами сервера, «Недавние запросы». «Загрузить свои файлы»: свой MP3 с тегами уходит на
// сервер, второй раз — «уже есть в библиотеке».
// Запуск: scripts/run_web_music_shared_e2e.sh
import assert from 'node:assert/strict';

import { chromium } from '../web/telegram-tt/node_modules/playwright/index.mjs';

import {
  LOGIN_TIMEOUT_MS,
  assertNoPageErrors,
  createGroupViaUi,
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

// Открыть общий плейлист из медиатеки слева
async function openShared(music, id) {
  const item = music.locator(`[data-music-nav] [data-item="shared:${id}"]`);
  await item.waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS * 2 });
  await item.click();
  const page = music.locator(`[data-music-shared="${id}"]`);
  await page.waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  return page;
}

// Поиск «Музыки» (строка поиска компьютера): строка трека каталога
async function searchCatalog(music, query, ref) {
  await music.locator('[data-music-nav] [data-view="search"]').click();
  await music.locator('[data-music-desk-search]').fill(query);
  const row = music.locator(`[data-catalog-track="${ref}"]`);
  await row.waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  return row;
}

// «Загрузки на сервер» — через «+ → Вставить ссылку» (поле ссылки там же)
async function openUploads(page, music) {
  await page.locator('#FoldersSidebar [data-add-for="music"]').click();
  await page.getByRole('menuitem', { name: /Paste a link/ }).click();
  const uploads = music.locator('[data-music-uploads]');
  await uploads.waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  return uploads;
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
  await a.page.locator('#FoldersSidebar [data-add-for="music"]').click();
  await a.page.getByRole('menuitem', { name: /New playlist/ }).click();
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
  // Приглашение — в медиатеке слева
  await bMusic.locator(`[data-music-nav] [data-item="shared:${sharedId}"]`)
    .waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS * 2 });
  await bMusic.locator(`[data-music-nav] [data-item="shared:${sharedId}"]`).click();
  const bPage = bMusic.locator(`[data-music-shared="${sharedId}"][data-role="editor"]`);
  await bPage.waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  const t4 = { trackId: 't4', title: 'Glass Harbor', artist: 'Kora Mesh', durationSecs: 30 };
  const added = await callApi(b.page, 'parvaneMusicSharedItems', { id: sharedId, add: [t4, t1] });
  assert.equal(added.result?.skipped, 1, `повтор трека пропущен: ${JSON.stringify(added)}`);
  await bPage.locator('[data-music-shared-tracks] [data-track="t4"]').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS * 2 });
  await aPage.locator('[data-music-shared-tracks] [data-track="t4"]').getByText(`added by ${bobNick}`)
    .waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS * 2 });
  await aPage.locator('[data-music-shared-recent]').getByText('Glass Harbor').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  // Кадры общего плейлиста и окна участников для сверки с досками `RpMusicB-02`, `ZdMusicX-04`
  if (process.env.PARVANE_E2E_SHOT_DIR) await a.page.screenshot({ path: `${process.env.PARVANE_E2E_SHOT_DIR}/music-shared-page.png` });
  await aPage.locator('[data-music-members-open]').click();
  await bobRow.getByText('Added 1 track').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS * 2 });
  if (process.env.PARVANE_E2E_SHOT_DIR) await a.page.screenshot({ path: `${process.env.PARVANE_E2E_SHOT_DIR}/music-shared-members.png` });
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

  // ── Трек каталога на сервер: ход в процентах в «Загрузках на сервер», отмена ──
  const slowRow = await searchCatalog(aMusic, 'медленный берег', 'dz:105');
  await slowRow.locator('[data-catalog-add]').click();
  await aMusic.locator('[data-catalog-track="dz:105"][data-catalog-state="adding"]')
    .waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS * 2 });
  // Идущее скачивание — чип «Добавляем N» сверху; он открывает «Загрузки на сервер»
  await aMusic.locator('[data-music-uploading="1"]').click();
  const uploads = aMusic.locator('[data-music-uploads]');
  // Строка «Сейчас»: «исполнитель · NN%» (доска `MusicUploads`)
  const slowJob = uploads.locator('[data-fetch-job="downloading"]').filter({ hasText: 'Медленный берег' });
  await slowJob.getByText(/Тихий порт · \d+%/).waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS * 2 });
  // Кадр «Загрузок на сервер» с задачей для сверки с доской `MusicUploads`
  if (process.env.PARVANE_E2E_SHOT_DIR) await a.page.screenshot({ path: `${process.env.PARVANE_E2E_SHOT_DIR}/music-uploads-jobs.png` });
  await slowJob.getByRole('button', { name: 'Cancel download' }).click();
  await slowJob.waitFor({ state: 'detached', timeout: STEP_TIMEOUT_MS });
  console.log('OK: трек каталога на сервер — ход в процентах в «Загрузках на сервер», отмена');

  // ── Отказ сервиса с причиной словами сервера ──
  const refusedRow = await searchCatalog(aMusic, 'закрытый берег', 'dz:106');
  await refusedRow.locator('[data-catalog-add]').click();
  await aMusic.locator('[data-catalog-track="dz:106"][data-catalog-state="failed"]')
    .waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS * 2 });
  await aMusic.locator('[data-music-desk-search]').press('Enter');
  await openUploads(a.page, aMusic);
  const failedJob = uploads.locator('[data-fetch-job="failed"]');
  await failedJob.getByText('Тихий порт · источник закрыт администратором')
    .waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await failedJob.getByRole('button', { name: 'Remove' }).click();
  await failedJob.waitFor({ state: 'detached', timeout: STEP_TIMEOUT_MS });
  console.log('OK: причина отказа — словами сервера; «Убрать»');

  // ── «Недавние запросы»: запросы, по которым что-то сделали ──
  await aMusic.locator('[data-music-nav] [data-view="search"]').click();
  await aMusic.locator('[data-music-desk-search]').fill('');
  const recent = aMusic.locator('[data-music-history]');
  await recent.locator('[data-query="закрытый берег"]').first().waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await recent.locator('[data-query="медленный берег"]').first().waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  console.log('OK: «Недавние запросы»');

  // ── «Загрузить свои файлы»: MP3 с тегами; тот же файл второй раз — «уже есть» ──
  await openUploads(a.page, aMusic);
  const mp3 = buildMp3('Своя песня', 'Тихий порт');
  await uploads.locator('[data-music-upload-input]').setInputFiles({ name: 'своя.mp3', mimeType: 'audio/mpeg', buffer: mp3 });
  const ownJob = uploads.locator('[data-fetch-job="done"]').filter({ hasText: 'своя.mp3' });
  await ownJob.waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS * 3 });
  await ownJob.getByRole('button', { name: 'Listen' }).waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await uploads.locator('[data-music-upload-input]').setInputFiles({ name: 'копия.mp3', mimeType: 'audio/mpeg', buffer: mp3 });
  await uploads.locator('[data-fetch-job="failed"][data-fetch-failure="duplicate"]').filter({ hasText: 'копия.mp3' })
    .waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS * 2 });
  console.log('OK: свой файл загружен на сервер, повтор — «уже есть в библиотеке»');

  // ── «Общее в группе» (доска `ZpChat2`): общий плейлист, привязанный к группе записью её журнала ──
  const GROUP_PLAYLIST = 'Группа: общее';
  const groupTitle = `Радиочат ${suffix.slice(-4)}`;
  const created = await callApi(a.page, 'parvaneMusicSharedCreate', { name: GROUP_PLAYLIST, access: 'members', tracks: [t1] });
  const groupPlaylistId = created.result?.id;
  assert.ok(groupPlaylistId, `общий плейлист для группы не создан: ${JSON.stringify(created)}`);
  const openGroupInfo = async (page) => {
    await page.locator('#FoldersSidebar').getByRole('tab', { name: 'Chats' }).click();
    const item = page.locator('#LeftColumn .ListItem').filter({ has: page.locator('.fullName', { hasText: groupTitle }) }).first();
    await item.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
    await item.locator('.ListItem-button').click();
    const right = page.locator('#RightColumn');
    // Панель могла ещё открываться либо закрываться после прежнего шага: щёлкаем по шапке, пока сведения не
    // простоят открытыми полсекунды
    const media = right.locator('[data-group-media]');
    for (let attempt = 0; attempt < 6; attempt++) {
      if (!(await media.isVisible().catch(() => false))) {
        await page.locator('.MiddleHeader .ChatInfo').click();
        await media.waitFor({ state: 'visible', timeout: 5000 }).catch(() => undefined);
      }
      await page.waitForTimeout(600);
      if (await media.isVisible().catch(() => false)) return right;
    }
    await media.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
    return right;
  };
  await a.page.locator('#FoldersSidebar').getByRole('tab', { name: 'Chats' }).click();
  await createGroupViaUi(a.page, groupTitle, [bobNick]);
  const aInfo = await openGroupInfo(a.page);
  await aInfo.locator('[data-group-shared="playlist"][data-group-shared-state="none"]').click();
  const picker = a.page.locator('[data-group-shared-picker="playlist"]');
  await picker.getByText(GROUP_PLAYLIST, { exact: true }).click();
  const aRow = aInfo.locator('[data-group-shared="playlist"][data-group-shared-state="open"]');
  await aRow.getByText(`Playlist “${GROUP_PLAYLIST}”`).waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS * 2 });
  assert.equal(await aRow.locator('[data-group-shared-count]').innerText(), '1');
  // Боб в плейлисте не состоит: до вступления сервер названия ему не отдаёт — строка без названия; нажатие —
  // вступление по ключу из журнала группы и переход в «Музыку»; после него строка с названием и числом треков
  const bInfo = await openGroupInfo(b.page);
  const bRow = bInfo.locator('[data-group-shared="playlist"][data-group-shared-state="open"]');
  await bRow.getByText('Shared playlist', { exact: true }).waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS * 2 });
  await bRow.getByText('shared playlist in Music').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  assert.equal(await bRow.locator('[data-group-shared-change]').count(), 0, 'участник привязку не меняет');
  await bRow.click();
  await b.page.locator(`#ParvaneMusic [data-music-shared="${groupPlaylistId}"]`)
    .waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS * 2 });
  const bInfo2 = await openGroupInfo(b.page);
  const bJoined = bInfo2.locator('[data-group-shared="playlist"][data-group-shared-state="open"]');
  await bJoined.getByText(`Playlist “${GROUP_PLAYLIST}”`).waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS * 2 });
  assert.equal(await bJoined.locator('[data-group-shared-count]').innerText(), '1');
  console.log('OK: общий плейлист группы — привязка владельцем, участник входит из сведений группы');

  sessions.forEach((session) => assertNoPageErrors({ session }));
  console.log('OK: общие плейлисты, трек каталога на сервер и свои файлы');
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
