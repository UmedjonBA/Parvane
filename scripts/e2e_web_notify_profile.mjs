// Уведомления и профильные поля кросс-девайс (web ↔ web):
//  1) alice(dev1) правит bio в Settings → Edit profile ДО первого резолва её
//     профиля у bob (профиль контакта кэшируется по TTL — PROFILE-1); bob
//     открывает профиль alice и видит bio (identity resolve);
//  2) alice(dev1) мутит чат с bob через контекстное меню списка чатов
//     («Mute…» → «навсегда») — блоб уходит в msg.chat.setnotify;
//  3) alice(dev2) — второе устройство того же аккаунта — после входа видит
//     чат с bob замученным (notify_settings из sync).
import assert from 'node:assert/strict';

import { chromium } from '../web/telegram-tt/node_modules/playwright/index.mjs';

import {
  LOGIN_TIMEOUT_MS,
  assertNoPageErrors,
  clickUntil,
  findMessage,
  openPrivateChatStrict,
  preparePage,
  relogin,
  sendText,
  linkSecondDevice,
} from './e2e_web_helpers.mjs';

const PASSWORD = 'Parvane-notify-e2e-password';
const SIBLING_SYNC_TIMEOUT_MS = 60000;

// Число замученных чатов по глобальному стейту tt (диаг-хук e2e-сборки)
async function mutedChatCount(page) {
  return page.evaluate(() => {
    const global = window.__parvaneGetGlobal?.();
    if (!global) return -1;
    const now = Math.floor(Date.now() / 1000);
    return Object.values(global.chats.notifyExceptionById || {})
      .filter((s) => s && s.mutedUntil && s.mutedUntil > now).length;
  });
}

function waitMuted(page, timeout) {
  return page.waitForFunction(() => {
    const global = window.__parvaneGetGlobal?.();
    const now = Math.floor(Date.now() / 1000);
    return Object.values(global?.chats.notifyExceptionById || {})
      .some((s) => s && s.mutedUntil && s.mutedUntil > now);
  }, undefined, { timeout });
}

async function muteChatForever(page, address) {
  const nick = address.split('@')[0];
  const item = page.locator('#LeftColumn .ListItem').filter({ hasText: nick }).first();
  await item.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await item.locator('.ListItem-button').click({ button: 'right' });
  await page.getByRole('menuitem', { name: /^Mute/ }).click();
  // Корень .Modal Playwright считает скрытым (opacity-transition) — ждём
  // содержимое: радио-группу длительности
  const modal = page.locator('.Modal.delete');
  const options = modal.locator('.dialog-checkbox-group');
  await options.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  // Последний вариант — «навсегда» (MuteDuration.Forever)
  await options.locator('label').last().click();
  await modal.locator('.confirm-dialog-button').first().click();
  await options.waitFor({ state: 'hidden', timeout: LOGIN_TIMEOUT_MS });
}

async function openEditProfile(page) {
  await page.getByRole('button', { name: 'Open menu' }).first().click();
  await page.getByRole('menuitem', { name: 'Settings' }).click();
  await page.getByRole('button', { name: 'Edit profile' }).click();
  await page.getByLabel('First name (required)').waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
}

// Из Edit profile — назад до списка чатов. После перехода кнопка «Go back»
// ещё видна в уходящем слайде (Transition_slide-to), а шапка списка чатов
// перехватывает клики — поэтому ориентируемся на «Open menu» и жмём назад
// только в активном слайде.
async function closeSettings(page) {
  const menu = page.getByRole('button', { name: 'Open menu' }).first();
  for (let i = 0; i < 6; i++) {
    if (await menu.isVisible().catch(() => false)) return;
    const back = page.locator('.Transition_slide-active').getByRole('button', { name: /Go back|Return to Chat List/ }).first();
    if (await back.isVisible().catch(() => false)) {
      await back.click({ timeout: 5000 }).catch(() => {});
    }
    await page.waitForTimeout(600);
  }
  await menu.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
}

async function saveProfileFab(page) {
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await page.waitForFunction(() => {
    const fab = document.querySelector('.FloatingActionButton');
    return !fab || !fab.classList.contains('revealed');
  }, undefined, { timeout: LOGIN_TIMEOUT_MS });
}

async function createGroupWith(page, member, title) {
  await page.mouse.move(800, 360);
  await page.locator('#LeftColumn').hover();
  await page.getByRole('button', { name: 'New Message' }).click();
  await page.getByRole('menuitem', { name: 'New Group' }).click();
  const search = page.locator('#new-group-picker-search');
  await search.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  const name = member.split('@')[0];
  await search.fill(name);
  const row = page.locator('#LeftColumn .PeerPickerItem, #LeftColumn .ItemPickerItem').filter({ hasText: name }).first();
  await row.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  for (let attempt = 0; attempt < 6; attempt++) {
    if (await row.locator('input[type="checkbox"]:checked').count()) break;
    if (attempt % 2 === 0) await row.press(' ').catch(() => {});
    else await row.click({ force: true }).catch(() => {});
    await page.waitForTimeout(500);
  }
  await page.getByRole('button', { name: 'Continue To Group Info' }).click();
  await page.getByLabel('Group name').fill(title);
  await page.getByRole('button', { name: 'Create Group' }).click();
  await page.locator('#editable-message-text').waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
}

// Профиль alice глазами bob: bio/телефон/канал в правой колонке, цвет — в сторе
async function readAliceProfile(page, aliceNick) {
  return page.evaluate((nick) => {
    const global = window.__parvaneGetGlobal?.();
    const user = Object.values(global?.users.byId || {})
      .find((candidate) => (candidate.usernames || []).some((entry) => entry.username === nick));
    const full = user ? global.users.fullInfoById?.[user.id] : undefined;
    return {
      color: user?.color?.color,
      phone: user?.phoneNumber,
      birthday: full?.birthday,
      personalChannelId: full?.personalChannelId,
      text: document.querySelector('#RightColumn')?.textContent || '',
    };
  }, aliceNick);
}

const browser = await chromium.launch();
const aliceDev1Context = await browser.newContext();
const aliceDev2Context = await browser.newContext();
const bobContext = await browser.newContext();

try {
  const suffix = `${Date.now()}-${process.pid}`;
  const alice = `np-alice-${suffix}@local`;
  const bob = `np-bob-${suffix}@local`;
  const hello = `np-hello-${suffix}`;
  const bio = `Bio from dev1 ${suffix}`;

  const aliceDev1 = await preparePage(aliceDev1Context, alice, PASSWORD);

  // ── dev1 правит bio ДО того, как bob впервые резолвит alice ───────────────
  await openEditProfile(aliceDev1.page);
  await aliceDev1.page.getByLabel('Bio').fill(bio);
  await aliceDev1.page.getByRole('button', { name: 'Save', exact: true }).click();
  // FAB прячется классом (не display) — ждём потерю класса revealed
  await aliceDev1.page.waitForFunction(() => {
    const fab = document.querySelector('.FloatingActionButton');
    return !fab || !fab.classList.contains('revealed');
  }, undefined, { timeout: LOGIN_TIMEOUT_MS });
  await closeSettings(aliceDev1.page);
  console.log('OK: dev1 сохранил bio');

  // ── Чат alice↔bob существует на обеих сторонах ────────────────────────────
  const bobSession = await preparePage(bobContext, bob, PASSWORD);
  await openPrivateChatStrict(aliceDev1.page, bob);
  await sendText(aliceDev1.page, hello);
  await openPrivateChatStrict(bobSession.page, alice);
  await findMessage(bobSession.page, hello).first().waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });

  // ── bob видит bio alice в профиле ─────────────────────────────────────────
  await bobSession.page.locator('.MiddleHeader .chat-info-wrapper').first().click();
  await bobSession.page.locator('#RightColumn').getByText(bio, { exact: true })
    .waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  console.log('OK: bob видит bio alice в профиле');

  // ── Username только для чтения, без ошибок ────────────────────────────────
  const aliceNick = alice.split('@')[0];
  await openEditProfile(aliceDev1.page);
  const usernameInput = aliceDev1.page.getByLabel('Username', { exact: true });
  await usernameInput.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  assert.equal(await usernameInput.inputValue(), `@${aliceNick}`, 'username shows the nick');
  assert(await usernameInput.evaluate((input) => input.readOnly), 'username must be read-only');
  await usernameInput.pressSequentially('zzz').catch(() => {});
  assert.equal(await usernameInput.inputValue(), `@${aliceNick}`, 'username must not change on typing');

  // ── Личный канал: группа alice с bob ──────────────────────────────────────
  await closeSettings(aliceDev1.page);
  const channelTitle = `NP-G-${suffix.slice(-6)}`;
  await createGroupWith(aliceDev1.page, bob, channelTitle);

  // ── Дата рождения (нативная модалка), цвет имени, телефон, личный канал ───
  await openEditProfile(aliceDev1.page);
  await aliceDev1.page.locator('.ListItem').filter({ hasText: 'Birthday' }).first().click();
  const modal = aliceDev1.page.locator('.modal-dialog').filter({ hasText: 'Date of Birth' });
  await modal.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await modal.getByLabel('Day').fill('15');
  await modal.getByLabel('Month').click();
  await aliceDev1.page.getByRole('menuitem', { name: 'March', exact: true }).click();
  await modal.getByLabel('Year').fill('1990');
  await modal.getByRole('button', { name: 'Save', exact: true }).click();
  await modal.waitFor({ state: 'hidden', timeout: LOGIN_TIMEOUT_MS });
  await aliceDev1.page.locator('.ListItem').filter({ hasText: 'Name color' }).first().click();
  // Цвет по умолчанию в Parvane — id % 7: выбираем заведомо другой, иначе
  // сброс неотличим от выбранного цвета
  const aliceDefaultColor = await bobSession.page.evaluate((nick) => {
    const global = window.__parvaneGetGlobal?.();
    const user = Object.values(global?.users.byId || {})
      .find((candidate) => (candidate.usernames || []).some((entry) => entry.username === nick));
    return Number(user.id) % 7;
  }, alice.split('@')[0]);
  // Палитра предлагает цвета 1..7 (ноль сервер трактует как «не задан»),
  // поэтому nth(i) — это цвет i + 1
  const chosenColor = ((aliceDefaultColor + 3) % 7) + 1;
  await aliceDev1.page.locator('.parvane-name-color-option').nth(chosenColor - 1).click();
  await aliceDev1.page.locator('.ListItem').filter({ hasText: 'Personal channel' }).first().click();
  const picker = aliceDev1.page.locator('.modal-dialog').filter({ has: aliceDev1.page.locator('.ChatOrUserPicker-item') });
  await picker.locator('.ChatOrUserPicker-item').filter({ hasText: channelTitle }).first().click();
  await picker.waitFor({ state: 'hidden', timeout: LOGIN_TIMEOUT_MS });
  const phone = `+7900${String(Date.now()).slice(-6)}`;
  await aliceDev1.page.getByLabel('Phone', { exact: true }).fill(phone);
  await saveProfileFab(aliceDev1.page);
  // SC-011: отсчёт от сохранения; живого пуша профиля в контракте нет — bob
  // видит поля, открыв профиль alice (fetchFullUser перечитывает identity)
  const profileSavedAt = Date.now();
  await closeSettings(aliceDev1.page);

  // ── bob видит публичные поля (и после reload); телефон — НЕ видит ─────────
  // P-19: телефон каталог отдаёт только владельцу. Дата рождения, цвет имени
  // и личный канал — публичная часть профиля
  const phoneDigits = phone.replace(/\D/g, '');
  const expectProfile = async (label) => {
    await bobSession.page.waitForFunction(({
      nick, title, color,
    }) => {
      const global = window.__parvaneGetGlobal?.();
      const user = Object.values(global?.users.byId || {})
        .find((candidate) => (candidate.usernames || []).some((entry) => entry.username === nick));
      const full = user ? global.users.fullInfoById?.[user.id] : undefined;
      const text = document.querySelector('#RightColumn')?.textContent || '';
      return user?.color?.color === color
        && full?.birthday?.day === 15 && full?.birthday?.month === 3 && full?.birthday?.year === 1990
        && text.includes(title);
    }, {
      nick: aliceNick, title: channelTitle, color: chosenColor,
    }, { timeout: LOGIN_TIMEOUT_MS })
      .catch(async (error) => {
        throw new Error(`${label}: ${error.message}; profile=${JSON.stringify(await readAliceProfile(bobSession.page, aliceNick))}`);
      });
    // Остальные поля уже доехали — значит, и телефон доехал бы, будь он отдан
    const seen = await readAliceProfile(bobSession.page, aliceNick);
    assert.equal(seen.phone || '', '', `${label}: bob получил телефон alice (P-19: только владельцу)`);
    assert(!seen.text.replace(/\D/g, '').includes(phoneDigits), `${label}: телефон alice показан в профиле у bob`);
  };
  // Телефон в форме своего профиля: значение приходит с сервера после reload.
  // Bio служит маркером «профиль перечитан» — иначе пустое поле телефона
  // неотличимо от ещё не загруженного
  const expectOwnPhone = async (page, expected, label) => {
    await relogin(page, PASSWORD);
    await openEditProfile(page);
    const bioInput = page.getByLabel('Bio');
    const phoneInput = page.getByLabel('Phone', { exact: true });
    const deadline = Date.now() + LOGIN_TIMEOUT_MS;
    for (;;) {
      const seen = { bio: await bioInput.inputValue(), phone: await phoneInput.inputValue() };
      if (seen.bio === bio && seen.phone === expected) break;
      assert(Date.now() < deadline, `${label}: form=${JSON.stringify(seen)}, expected phone "${expected}"`);
      await page.waitForTimeout(300);
    }
    await closeSettings(page);
  };
  await bobSession.page.keyboard.press('Escape');
  await openPrivateChatStrict(bobSession.page, alice);
  await bobSession.page.locator('.MiddleHeader .chat-info-wrapper').first().click();
  await expectProfile('bob live');
  const profileVisibleMs = Date.now() - profileSavedAt;
  console.log(`bob sees alice's profile fields ${profileVisibleMs} ms after save`);
  assert(profileVisibleMs <= 10000, `profile fields reached bob in ${profileVisibleMs} ms (SC-011: ≤ 10 s)`);
  // Заголовок секции личного канала переведён, а не сырой ключ (FR-003)
  await bobSession.page.locator('#RightColumn').getByText('Channel', { exact: true }).first()
    .waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  assert.equal(await bobSession.page.locator('#RightColumn').getByText('ProfileChannel').count(), 0,
    'personal channel section shows the raw lang key');
  await relogin(bobSession.page, PASSWORD);
  await openPrivateChatStrict(bobSession.page, alice);
  await bobSession.page.locator('.MiddleHeader .chat-info-wrapper').first().click();
  await expectProfile('bob after reload');
  console.log('OK: bob видит дату рождения, цвет имени и личный канал alice, телефон от него скрыт');
  await expectOwnPhone(aliceDev1.page, phone, 'alice own phone');
  console.log('OK: владелец видит свой телефон после reload');

  // ── Сброс даты рождения и цвета ───────────────────────────────────────────
  await openEditProfile(aliceDev1.page);
  const birthdayRow = aliceDev1.page.locator('.ListItem:visible').filter({ hasText: 'Birthday' }).first();
  await clickUntil(birthdayRow, () => modal.waitFor({ state: 'visible', timeout: 5000 }));
  await modal.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await modal.getByRole('button', { name: 'Remove from Profile' }).click();
  await modal.waitFor({ state: 'hidden', timeout: LOGIN_TIMEOUT_MS });
  await aliceDev1.page.locator('.ListItem').filter({ hasText: 'Name color' }).first().click();
  await aliceDev1.page.locator('.parvane-name-color-default').click();
  // FR-071 требует сброса ВСЕХ четырёх полей, не только даты и цвета.
  // Снятие канала — отдельный пункт под строкой «Personal channel»
  await aliceDev1.page.locator('.ListItem:visible')
    .filter({ hasText: 'Remove personal channel' }).first().click();
  await aliceDev1.page.getByLabel('Phone', { exact: true }).fill('');
  await saveProfileFab(aliceDev1.page);
  await closeSettings(aliceDev1.page);
  await relogin(bobSession.page, PASSWORD);
  await openPrivateChatStrict(bobSession.page, alice);
  await bobSession.page.locator('.MiddleHeader .chat-info-wrapper').first().click();
  await bobSession.page.waitForFunction((nick) => {
    const global = window.__parvaneGetGlobal?.();
    const user = Object.values(global?.users.byId || {})
      .find((candidate) => (candidate.usernames || []).some((entry) => entry.username === nick));
    const full = user ? global.users.fullInfoById?.[user.id] : undefined;
    // Сброшены публичные поля: дата, цвет и личный канал (FR-071). Телефон bob
    // не видит вовсе (P-19) — его сброс проверяется у владельца ниже
    return user && full && !full.birthday
      && user.color?.color === Number(user.id) % 7
      && !user.phoneNumber
      && !full.personalChannelId;
  }, aliceNick, { timeout: LOGIN_TIMEOUT_MS }).catch(async (error) => {
    const profile = await readAliceProfile(bobSession.page, aliceNick);
    throw new Error(`reset not visible to bob: ${error.message}; profile=${JSON.stringify({ ...profile, text: undefined })}`);
  });
  console.log('OK: сброс даты рождения, цвета и личного канала виден bob после reload');
  await expectOwnPhone(aliceDev1.page, '', 'alice own phone after reset');
  console.log('OK: телефон сброшен и у владельца');

  // ── dev1 мутит bob навсегда ───────────────────────────────────────────────
  assert.equal(await mutedChatCount(aliceDev1.page), 0, 'до мута замученных нет');
  await muteChatForever(aliceDev1.page, bob);
  await waitMuted(aliceDev1.page, LOGIN_TIMEOUT_MS);
  console.log('OK: dev1 замутил чат с bob');

  // ── dev2 (чистый контекст, тот же аккаунт) видит мут из sync ──────────────
  const aliceDev2 = await preparePage(aliceDev2Context, alice, PASSWORD);
  // v2 (по умолчанию, T135): мут едет журналом личного состояния — его ключ
  // второе устройство получает привязкой (LINK-1 v2)
  await linkSecondDevice(aliceDev1.page, aliceDev2.page);
  await waitMuted(aliceDev2.page, SIBLING_SYNC_TIMEOUT_MS);
  console.log('OK: dev2 получил мут с первого устройства');

  assertNoPageErrors({ aliceDev1, aliceDev2, bob: bobSession });
  console.log('OK: уведомления и профильные поля кросс-девайс (web)');
} catch (err) {
  const dir = new URL('../web/telegram-tt/test-results/', import.meta.url).pathname;
  for (const [index, context] of browser.contexts().entries()) {
    for (const [pageIndex, page] of context.pages().entries()) {
      await page.screenshot({ path: `${dir}notify-profile-${index}-${pageIndex}.png` }).catch(() => {});
    }
  }
  throw err;
} finally {
  await browser.close();
}
