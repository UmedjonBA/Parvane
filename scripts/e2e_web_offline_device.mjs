// Conformance SYNC-1/SYNC-2: устройство ОТСУТСТВОВАЛО, пока ему писали.
// Прежние сценарии держали оба клиента онлайн, поэтому потеря сообщений за
// курсором синка не ловилась ни разу. Здесь у получателя закрывается страница
// (ни одного соединения, как у выключенного компьютера), а хранилище
// устройства — ключи и курсор в контексте браузера — сохраняется; отправитель
// шлёт несколько сообщений, и ТО ЖЕ устройство обязано догнать ВСЁ после
// возвращения — включая перезагрузку. Уничтожать контекст нельзя: это было бы
// НОВОЕ устройство, которому sealed-копии для старого нечитаемы по дизайну
// E2E (см. e2e_web_multidevice.mjs), — прежняя версия сценария делала именно
// так и «проходила» только потому, что ничего не ждала.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { chromium } from '../web/telegram-tt/node_modules/playwright/index.mjs';

import {
  LOGIN_TIMEOUT_MS,
  assertNoPageErrors,
  clickUntil,
  dumpDiagJournal,
  findMessage,
  findMessageContainers,
  openPrivateChatStrict,
  preparePage as preparePageShared,
  readDiagJournal,
  relogin,
  requireEnv,
  sendText,
} from './e2e_web_helpers.mjs';

async function attachVideo(page, path, caption) {
  await page.getByRole('button', { name: 'Add an attachment' }).click();
  const fileChooserPromise = page.waitForEvent('filechooser');
  await page.getByRole('menuitem', { name: 'Photo or Video' }).click();
  (await fileChooserPromise).setFiles(path);
  const captionInput = page.locator('#editable-message-text-modal');
  await captionInput.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await captionInput.fill(caption);
  await captionInput.press('Enter');
  await captionInput.waitFor({ state: 'hidden', timeout: LOGIN_TIMEOUT_MS });
}

async function setOwnBio(page, bio) {
  await page.getByRole('button', { name: 'Open menu' }).first().click();
  await page.getByRole('menuitem', { name: 'Settings' }).click();
  await page.getByRole('button', { name: 'Edit profile' }).click();
  await page.getByLabel('First name (required)').waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  // Форма подставляет поля из fullInfo асинхронно и затирает уже введённое
  // (в c35 ушло `updateProfile {bio:len=0}`) — перепроверяем значение перед Save
  const bioInput = page.getByLabel('Bio');
  for (let attempt = 0; attempt < 6; attempt++) {
    await bioInput.fill(bio);
    await page.waitForTimeout(700);
    if (await bioInput.inputValue() === bio) break;
  }
  assert.equal(await bioInput.inputValue(), bio, 'bio field was reset before saving');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  // FAB прячется классом (не display) — ждём потерю класса revealed
  await page.waitForFunction(() => {
    const fab = document.querySelector('.FloatingActionButton');
    return !fab || !fab.classList.contains('revealed');
  }, undefined, { timeout: LOGIN_TIMEOUT_MS });
  const menu = page.getByRole('button', { name: 'Open menu' }).first();
  for (let i = 0; i < 6; i++) {
    if (await menu.isVisible().catch(() => false)) return;
    const back = page.locator('.Transition_slide-active')
      .getByRole('button', { name: /Go back|Return to Chat List/ }).first();
    if (await back.isVisible().catch(() => false)) await back.click({ timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(500);
  }
}

const PASSWORD = 'Parvane-offline-device-password';
const preparePage = (context, user) => preparePageShared(context, user, PASSWORD);

// Возвращение того же устройства: новая страница в сохранённом контексте.
// Адрес запомнен — tt показывает форму пароля либо входит сам (keep-signed-in)
async function reopenDevice(context) {
  const { baseUrl } = requireEnv();
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (err) => errors.push(err.message));
  await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
  const passwordScreen = page.locator('.Transition_slide-active > #auth-password-form');
  const leftColumn = page.locator('#LeftColumn');
  await Promise.race([
    passwordScreen.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS }),
    leftColumn.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS }),
  ]);
  if (await passwordScreen.isVisible()) {
    await passwordScreen.locator('#sign-in-password').fill(PASSWORD);
    await clickUntil(
      passwordScreen.getByRole('button', { name: 'Next' }),
      () => leftColumn.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS }),
      { settleMs: 15000 },
    );
  }
  await leftColumn.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  return { page, errors };
}

const browser = await chromium.launch();
const aliceContext = await browser.newContext();
const bobContext = await browser.newContext();
let fixtureDir;

try {
  const suffix = `${Date.now()}-${process.pid}`;
  const alice = `off-alice-${suffix}@local`;
  const bob = `off-bob-${suffix}@local`;
  const texts = [`offline-1-${suffix}`, `offline-2-${suffix}`, `offline-3-${suffix}`];

  // 1. Оба поднимаются: bob регистрирует устройство и публикует прекеи.
  const aliceSession = await preparePage(aliceContext, alice);
  const bobSession = await preparePage(bobContext, bob);
  await openPrivateChatStrict(bobSession.page, alice);
  await openPrivateChatStrict(aliceSession.page, bob);
  await sendText(aliceSession.page, `warmup-${suffix}`);
  await findMessage(bobSession.page, `warmup-${suffix}`);

  // 2. bob исчезает: страница закрыта (ни соединений, ни синка), хранилище
  // устройства в контексте остаётся — как выключенный компьютер.
  await bobSession.page.close();

  // 3. alice пишет в его отсутствие.
  for (const text of texts) {
    // eslint-disable-next-line no-await-in-loop
    await sendText(aliceSession.page, text);
  }

  // 3b. Граничный случай спеки перечисляет не только текст: в отсутствие
  // устройства уезжают также видео и изменённый профиль. Кастом-эмодзи и
  // пропущенный звонок здесь не проверяются — им нужен собранный десктоп
  // (пак) и третий участник; они покрыты онлайн-сценариями cross_emoji и
  // calls
  fixtureDir = mkdtempSync(join(tmpdir(), 'pv-offline-'));
  const videoPath = join(fixtureDir, 'clip.mp4');
  execFileSync('ffmpeg', [
    '-y', '-f', 'lavfi', '-i', 'testsrc2=size=320x240:rate=15:duration=2',
    '-c:v', 'libvpx-vp9', '-deadline', 'realtime', '-cpu-used', '8',
    '-b:v', '600k', '-pix_fmt', 'yuv420p', videoPath,
  ], { stdio: 'ignore' });
  const videoCaption = `offline-video-${suffix}`;
  await attachVideo(aliceSession.page, videoPath, videoCaption);
  // Отправка у alice завершена (пузырь с видео, без часов и без ошибки) —
  // иначе провал на стороне получателя нельзя отличить от несостоявшейся
  // отправки
  const sentVideo = findMessageContainers(aliceSession.page, videoCaption).first();
  await sentVideo.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await sentVideo.locator('.icon-message-pending').first()
    .waitFor({ state: 'hidden', timeout: LOGIN_TIMEOUT_MS });
  assert.equal(await sentVideo.locator('.icon-message-failed').count(), 0, 'alice: видео не отправилось');

  const newBio = `offline-bio-${suffix}`;
  await setOwnBio(aliceSession.page, newBio);

  // 4. bob возвращается на ТОМ ЖЕ устройстве и обязан догнать всё.
  const bobBack = await reopenDevice(bobContext);
  await openPrivateChatStrict(bobBack.page, alice);
  for (const text of texts) {
    // eslint-disable-next-line no-await-in-loop
    await findMessage(bobBack.page, text).first().waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  }

  // Видео догнало синк и пришло именно видео-пузырём, а не файлом
  const videoBubble = findMessageContainers(bobBack.page, videoCaption).first();
  await videoBubble.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await videoBubble.locator('video').first()
    .waitFor({ state: 'attached', timeout: LOGIN_TIMEOUT_MS });

  // Профиль, изменённый в отсутствие устройства, виден после синка. Полную
  // инфу tt перечитывает из шапки чата (`PrivateChatInfo withFullInfo`, при
  // `isSynced`) — открываем профиль alice из шапки и ждём bio
  await bobBack.page.locator('.MiddleHeader .ChatInfo').first().click();
  await bobBack.page.locator('#RightColumn').getByText(newBio, { exact: true })
    .waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS })
    .catch(async (err) => {
      // Диагностика: состояние синка, полная инфа alice в global и журнал по
      // ключам профиля — иначе не отличить «не перечитал» от «не дошло»
      const state = await bobBack.page.evaluate((name) => {
        const global = window.__parvaneGetGlobal?.();
        const user = global && Object.values(global.users.byId)
          .find((candidate) => candidate.usernames?.some(({ username }) => username === name));
        return {
          isSynced: global?.isSynced,
          fullInfo: user && global.users.fullInfoById?.[user.id],
        };
      }, alice.split('@')[0]).catch((e) => `eval failed: ${e.message}`);
      console.error('offline-device: profile state', JSON.stringify(state));
      const entries = await readDiagJournal(bobBack.page).catch(() => []);
      console.error(entries
        .filter((entry) => /FullUser|updateUser|ConnectionState|resolve|sync/i.test(`${entry.k} ${entry.d || ''}`))
        .map((entry) => `${new Date(entry.t).toISOString().slice(11, 23)} ${entry.k} ${(entry.d || '').slice(0, 120)}`)
        .join('\n'));
      throw err;
    });

  // 5. И переживает перезагрузку: курсор не должен был уехать за пропущенное.
  await relogin(bobBack.page, PASSWORD);
  await openPrivateChatStrict(bobBack.page, alice);
  for (const text of texts) {
    // eslint-disable-next-line no-await-in-loop
    await findMessage(bobBack.page, text).first().waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  }

  assertNoPageErrors({ alice: aliceSession, bob: bobBack });
  assert.ok(true, 'все сообщения, присланные в отсутствие устройства, доехали');
  // eslint-disable-next-line no-console
  console.log('offline-device: OK');
} catch (error) {
  const dir = new URL('../web/telegram-tt/test-results/', import.meta.url).pathname;
  for (const [name, context] of [['alice', aliceContext], ['bob', bobContext]]) {
    const page = context?.pages()[0];
    if (!page) continue;
    await page.screenshot({ path: `${dir}offline-device-${name}.png` }).catch(() => {});
    await dumpDiagJournal(page, name).catch(() => {});
  }
  throw error;
} finally {
  if (fixtureDir) rmSync(fixtureDir, { recursive: true, force: true });
  await browser.close();
}
