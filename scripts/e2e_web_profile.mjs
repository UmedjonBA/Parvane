// «Профиль» по макету (spec 041 E3 и хвосты: экраны выгрузки, справки, отчёта об ошибке, удаления, карточки аккаунта). Компьютер: «Профиль» занимает окно — колонка разделов слева, экран справа;
// «Обзор», «Оформление» (режим, размер текста, фон чатов), вложенные экраны возвращаются по карте возвратов,
// «Копия ключей», «О приложении», выгрузка и выход — пункты списка. Телефон: аккаунт с плитками, разделы списком,
// лента модулей только на главном экране, ничего не выходит за ширину экрана.
import assert from 'node:assert/strict';

import { chromium } from '../web/telegram-tt/node_modules/playwright/index.mjs';

import {
  LOGIN_TIMEOUT_MS,
  assertNoPageErrors,
  dismissRecoveryKeyDialog,
  linkSecondDevice,
  openDevicesScreen,
  openEditProfile,
  openProfile,
  openSettingsScreen,
  preparePage,
  profileRow,
  relogin,
  waitForChatList,
} from './e2e_web_helpers.mjs';

const PASSWORD = 'Parvane-profile-e2e-password';
const WAIT_MS = 15_000;

const browser = await chromium.launch();
const sessions = {};

// Снимки экранов по доскам — для сверки глазами (каталог результатов, не проверка)
const SHOTS_DIR = new URL('../web/telegram-tt/test-results/', import.meta.url).pathname;
const shot = (on, name) => on.screenshot({ path: `${SHOTS_DIR}profile-shot-${name}.png` }).catch(() => undefined);

const shown = (locator) => locator.waitFor({ state: 'visible', timeout: WAIT_MS });
const hidden = (locator) => locator.waitFor({ state: 'hidden', timeout: WAIT_MS });

async function expectNoOverflow(page, what) {
  // Экран въезжает слайдом: мерить можно только после перехода
  await page.waitForTimeout(600);
  const overflow = await page.evaluate(() => {
    const width = window.innerWidth;
    return [...document.querySelectorAll('#Settings .Transition_slide-active *')]
      .filter((el) => el.getBoundingClientRect().width > 0 && el.getBoundingClientRect().right > width + 1)
      .map((el) => `${el.tagName}.${String(el.className).slice(0, 40)}`).slice(0, 5);
  });
  assert.deepEqual(overflow, [], `${what}: выходит за ширину экрана`);
}

try {
  const suffix = `${Date.now()}-${process.pid}`;

  // ── Компьютер ─────────────────────────────────────────────────────────────
  const desktop = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  sessions.desktop = await preparePage(desktop, `profile-vera-${suffix}@local`, PASSWORD);
  const { page } = sessions.desktop;
  await dismissRecoveryKeyDialog(page).catch(() => undefined);

  const nav = page.locator('[data-profile-menu="nav"]');
  const overview = page.locator('[data-profile-overview]');
  const back = page.locator('#Settings .Transition_slide-active .left-header > .Button').first();
  const title = page.locator('#Settings .Transition_slide-active .left-header h3');
  const current = (id) => nav.locator(`[data-profile-item="${id}"][aria-current="page"]`);

  await openProfile(page);
  await shown(overview);
  await shown(current('overview'));
  await hidden(page.locator('#MiddleColumn'));
  const paneWidth = await page.locator('.pv-profile-pane').evaluate((el) => el.getBoundingClientRect().width);
  assert.ok(paneWidth > 900, `экран «Профиля» не занял окно: ${paneWidth}`);
  await shown(overview.locator('[data-profile-head="desk"]').getByText(/^@profile-vera-.+ · .+/));
  await shown(overview.locator('[data-overview-card="devices"]').getByText('this device, online now'));
  console.log('OK: компьютер — «Обзор» во всё окно, колонка разделов слева');

  // «Оформление»: корневой экран без стрелки, режим и размер текста действуют сразу
  await profileRow(page, 'Appearance').click();
  const appearance = page.locator('[data-settings-appearance]');
  await shown(appearance);
  await shown(current('appearance'));
  assert.equal(await title.innerText(), 'Appearance');
  assert.equal(await back.isVisible(), false, 'у экрана из колонки разделов есть стрелка «Назад»');
  const mode = appearance.getByRole('group', { name: 'Mode' });
  await mode.getByRole('button', { name: 'Dark', exact: true }).click();
  await page.waitForFunction(() => document.documentElement.classList.contains('theme-dark'), undefined, { timeout: WAIT_MS });
  await mode.getByRole('button', { name: 'Light', exact: true }).click();
  await page.waitForFunction(() => document.documentElement.classList.contains('theme-light'), undefined, { timeout: WAIT_MS });
  const sizeRow = appearance.locator('[data-text-size]');
  const size = Number(await sizeRow.getAttribute('data-text-size'));
  await sizeRow.getByRole('button', { name: 'Larger' }).click();
  await shown(appearance.locator(`[data-text-size="${size + 1}"]`));
  assert.equal(
    await page.evaluate(() => document.documentElement.style.getPropertyValue('--message-text-size')), `${size + 1}px`,
  );
  await sizeRow.getByRole('button', { name: 'Smaller' }).click();
  await shown(appearance.locator(`[data-text-size="${size}"]`));
  await overview.waitFor({ state: 'hidden', timeout: WAIT_MS });
  console.log('OK: «Оформление» — режим и размер текста');

  // spec 041 (`DkSettingsA`): схемы образцами «светлая | тёмная половина», плотный список чатов
  assert.equal(await appearance.locator('[data-scheme] > span:first-child > span').count() >= 10, true,
    'образец схемы — две половины');
  const dense = appearance.locator('[data-appearance-row="dense"]');
  await dense.click();
  await page.waitForFunction(() => document.documentElement.classList.contains('chat-list-dense'), undefined, { timeout: WAIT_MS });
  await dense.click();
  await page.waitForFunction(() => !document.documentElement.classList.contains('chat-list-dense'), undefined, { timeout: WAIT_MS });
  console.log('OK: схемы половинами, плотный список чатов');

  // Вложенный экран: стрелка есть, пункт колонки остаётся выбранным, Escape идёт по карте возвратов. «Фон чатов» —
  // переключатель: «Рисунок» открывает выбор рисунка
  await appearance.locator('[data-appearance-row="background"]').getByRole('button', { name: 'Pattern', exact: true })
    .click();
  await shown(page.locator('[data-bg-pattern]').first());
  await shown(back);
  await shown(current('appearance'));
  await page.keyboard.press('Escape');
  await shown(appearance);
  await appearance.locator('[data-appearance-row="performance"]').click();
  await shown(title.getByText('Animations and Performance'));
  await back.click();
  await shown(appearance);
  console.log('OK: фон чатов и анимации возвращаются в «Оформление»');

  await openSettingsScreen(page, 'Chat Folders');
  await shown(title.getByText('Chat Folders'));
  await shown(current('messenger'));
  await back.click();
  await shown(page.locator('[data-settings-general]'));
  await openSettingsScreen(page, 'Stickers and Emoji');
  await shown(current('messenger'));
  await page.keyboard.press('Escape');
  await shown(page.locator('[data-settings-general]'));
  console.log('OK: папки и стикеры — из «Настроек мессенджера» и обратно');

  // «Копия ключей» на компьютере (`ZdProfileX`): состояние копии ключей аккаунта, «Ключ восстановления»; файл копии —
  // на «Данных и памяти» (`DkSettingsB`)
  await profileRow(page, 'Key backup').click();
  await shown(page.locator('[data-keys-bundle-state]'));
  await shown(page.locator('[data-keys-action="renew"]'));
  assert.equal(await page.locator('[data-keys-file-form]').count(), 0, 'форма файла копии на экране компьютера');
  await shot(page, 'desk-keys');
  await profileRow(page, 'Data and Storage').click();
  const data = page.locator('[data-settings-data]');
  await shown(data);
  await shown(current('data'));
  for (const kind of ['media', 'music', 'cloud', 'other']) {
    await shown(data.locator(`[data-cache-row="${kind}"] [data-cache-size]`));
  }
  await data.locator('[data-storage-row="autoload"]').click();
  await page.locator('[role="radiogroup"] [data-choice="never"]').click();
  await shown(data.locator('[data-storage-row="autoload"] [data-storage-value="never"]'));
  assert.equal(await page.evaluate(() => localStorage.getItem('parvane:autoload')), 'never');
  await data.locator('[data-storage-row="autoload"]').click();
  await page.locator('[role="radiogroup"] [data-choice="always"]').click();
  await data.locator('[data-storage-row="keep"]').click();
  await page.locator('[role="radiogroup"] [data-choice="week"]').click();
  await shown(data.locator('[data-storage-row="keep"] [data-storage-value="week"]'));
  // Файл копии ключей: окно с паролем и повтором (вместо `window.prompt`), файл уходит в загрузки
  await shown(data.locator('[data-keys-file-card="none"]'));
  await data.locator('[data-keys-action="save"]').click();
  const keysForm = page.locator('.Modal [data-keys-file-form="save"]');
  await shown(keysForm);
  const keysSubmit = keysForm.locator('[data-keys-submit="save"]');
  await keysForm.locator('[data-keys-password]').fill('copy-pass-1');
  await keysForm.locator('[data-keys-password-repeat]').fill('copy-pass-2');
  await shown(keysForm.locator('[data-keys-error="mismatch"]'));
  assert.ok(await keysSubmit.isDisabled(), 'файл копии сохраняется при несовпадающих паролях');
  await keysForm.locator('[data-keys-password-repeat]').fill('copy-pass-1');
  const download = page.waitForEvent('download', { timeout: WAIT_MS });
  await keysSubmit.click();
  assert.equal((await download).suggestedFilename(), 'parvane-e2e-keys.json');
  await hidden(keysForm);
  await shown(data.locator('[data-keys-file-card="ok"]'));
  await shot(page, 'desk-data');
  console.log('OK: «Данные и память» — кэш по видам, автозагрузка и срок, файл копии ключей окном');

  await profileRow(page, 'About').click();
  // Компьютер (доска `ZdProfileX`): подзаголовок вместо логотипа, версия — строкой карточки
  await shown(page.locator('[data-about-version]').getByText('Parvane for desktop', { exact: true }));
  assert.match(await page.locator('[data-about-app-version]').innerText(), /^\d+\.\d+/, 'версия приложения');
  await page.waitForFunction(() => document.querySelector('[data-about-server-version]')
    ?.getAttribute('data-about-server-version'), undefined, { timeout: WAIT_MS });
  await shot(page, 'desk-about');
  await page.locator('[data-about-action="check"]').click();
  await shown(page.locator('[data-about-update]').getByText(/checked today at/));
  await shown(page.locator('[data-about-row="licenses"]'));
  await page.locator('[data-about-row="licenses"]').click();
  await shown(page.locator('.Modal [data-licenses]'));
  await page.keyboard.press('Escape');
  await hidden(page.locator('.Modal [data-licenses]'));
  await page.locator('[data-about-row="hotkeys"]').click();
  await shown(page.locator('[data-hotkeys-group]').first());
  await page.keyboard.press('Escape');
  await hidden(page.locator('[data-hotkeys-group]').first());
  await profileRow(page, 'Devices and account').click();
  await shown(page.locator('.SettingsActiveSessions'));
  await shown(current('devices'));
  // spec 041 (`DkSettingsA`): карточки аккаунта и «Опасная зона»; удаление — экраном
  await shown(page.locator('[data-account-card] [data-account-row="nick"]').getByText(/^@profile-vera-/));
  // «Удалить аккаунт» на компьютере — окно поверх «Профиля» (`RdProfile`): без подписи «Что произойдёт»
  await page.locator('[data-delete-account-open]:visible').click();
  const deleteWindow = page.locator('.Modal [data-delete-account-dialog]');
  await shown(deleteWindow);
  await shown(deleteWindow.locator('[data-delete-account-submit]').getByText('Delete in 7 days'));
  await shown(current('devices'));
  await page.keyboard.press('Escape');
  await hidden(deleteWindow);
  await shown(page.locator('.SettingsActiveSessions'));
  // «Сменить пароль» — окно поверх экрана (`ZdProfileX`): надёжность, «Пароли не совпадают»
  await page.locator('[data-account-row="password"]').click();
  const passwordForm = page.locator('.Modal [data-password-form]');
  await shown(passwordForm);
  await passwordForm.locator('[data-password-field="new"]').fill('short');
  await shown(passwordForm.locator('[data-password-strength="short"]'));
  await passwordForm.locator('[data-password-field="new"]').fill('example-pass-42');
  await shown(passwordForm.locator('[data-password-strength="strong"]').getByText(/^Strong: 15 characters/));
  await passwordForm.locator('[data-password-field="repeat"]').fill('example-pass-43');
  await shown(passwordForm.locator('[data-password-error="mismatch"]'));
  await shot(page, 'desk-password');
  await page.keyboard.press('Escape');
  await hidden(passwordForm);
  await shown(page.locator('.SettingsActiveSessions'));
  await profileRow(page, 'Privacy and Security').click();
  await shown(page.locator('#Settings').getByText('Blocked Users').first());
  assert.equal(await page.locator('#Settings').getByText(/E2E Keys/).count(), 0, 'копия ключей осталась в «Конфиденциальности»');
  console.log('OK: «Копия ключей», «О приложении», «Устройства и аккаунт», «Конфиденциальность»');

  await profileRow(page, 'Export my data').click();
  const exportDialog = page.locator('[data-export-dialog]');
  await shown(exportDialog);
  await shown(current('export'));
  await page.keyboard.press('Escape');
  await hidden(exportDialog);

  // «Справки Parvane» в колонке компьютера нет (`DkSettingsB`, `ZdProfileX`) — она в списке телефона
  assert.equal(await nav.locator('[data-profile-item="help"]').count(), 0, '«Справка» в колонке компьютера');
  // «Сообщить об ошибке» (`ZdProfileY`): две колонки, два поля, что приложим, сохранить в файл
  await profileRow(page, 'Report a Bug').click();
  const bug = page.locator('[data-bug-report]');
  await shown(bug);
  await shown(bug.locator('[data-bug-recipient]').getByText(/^The report goes to bugs@/));
  assert.equal(await bug.locator('[data-bug-send]').isDisabled(), true, 'пустой отчёт не отправляется');
  await bug.locator('[data-area="notes"]').click();
  await shown(bug.locator('[data-area="notes"][aria-pressed="true"]'));
  await shown(bug.locator('[data-bug-environment]').getByText(/^Parvane \S+ · \S+ · \S+/));
  await bug.locator('[data-bug-preview]').click();
  await shown(bug.locator('pre').getByText(/Parvane \S+ · \S+ · \S+/));
  await bug.locator('[data-bug-text]').fill('Плеер молчит');
  await bug.locator('[data-bug-steps]').fill('открыл музыку');
  const bugFile = page.waitForEvent('download', { timeout: WAIT_MS });
  await bug.locator('[data-bug-save]').click();
  const bugReport = JSON.parse(await (await (await bugFile).createReadStream()).toArray()
    .then((chunks) => Buffer.concat(chunks).toString('utf8')));
  assert.equal(bugReport.description, 'Плеер молчит');
  assert.equal(bugReport.steps, 'открыл музыку');
  assert.equal(bugReport.area, 'notes');
  assert.ok(Array.isArray(bugReport.log), 'журнал не приложен');
  await bug.locator('[data-bug-log]').click();
  await shown(bug.locator('[data-bug-log][aria-checked="false"]'));
  await shot(page, 'desk-bug');
  const columns = await bug.evaluate((el) => getComputedStyle(el.children[1]).gridTemplateColumns.split(' ').length);
  assert.equal(columns, 2, 'отчёт на компьютере — не в две колонки');
  // «Язык» (`ZdProfileX`): «Как в системе», формат времени, первый день недели, проверка орфографии
  await profileRow(page, 'Language').click();
  const language = page.locator('.settings-language');
  await shown(language.locator('[data-language-time-format]'));
  await shown(language.getByText('As in the system', { exact: true }));
  await shot(page, 'desk-language');
  await language.locator('[data-language-week-start]').click();
  await page.locator('[role="radiogroup"] [data-choice="0"]').click();
  await shown(language.locator('[data-language-week-start="0"]'));
  assert.equal(await page.evaluate(() => localStorage.getItem('parvane:first-weekday')), '0');
  await language.locator('[data-language-week-start]').click();
  await page.locator('[role="radiogroup"] [data-choice="1"]').click();
  await shown(language.locator('[data-language-week-start="1"]'));
  await language.locator('[data-language-spellcheck]').click();
  await page.waitForFunction(() => !document.documentElement.spellcheck, undefined, { timeout: WAIT_MS });
  await language.locator('[data-language-spellcheck]').click();
  await page.waitForFunction(() => document.documentElement.spellcheck, undefined, { timeout: WAIT_MS });
  console.log('OK: отчёт об ошибке, «Язык» — формат времени, первый день недели, орфография');
  await profileRow(page, 'Log Out').click();
  // Шторка выхода (доска `PhProfileB`): «Просто выйти», «Выйти и сменить ключи» (у аккаунта одно устройство — её нет)
  const logOutButton = page.locator('.Modal [data-sign-out-plain]').last();
  await shown(logOutButton);
  await page.locator('.Modal').getByRole('button', { name: 'Cancel' }).last().click();
  await hidden(logOutButton);
  console.log('OK: выгрузка и выход открываются из списка разделов');

  // ── «Уведомления», «Конфиденциальность», «Устройства» по доскам (хвосты E3) ──
  await profileRow(page, 'Notifications').click();
  const notify = page.locator('[data-settings-notifications]');
  await shown(notify);
  const chatsSwitch = notify.locator('[data-notify-module="chats"]');
  assert.equal(await chatsSwitch.getAttribute('aria-checked'), 'true', 'уведомления «Чатов» выключены по умолчанию');
  await chatsSwitch.click();
  await page.waitForFunction(() => JSON.parse(localStorage.getItem('parvane:notify-prefs') || '{}').off?.includes('chats'));
  // Копия настроек для service worker — в базе напоминаний
  const readWorkerPrefs = () => page.evaluate(() => new Promise((resolve) => {
    const request = indexedDB.open('parvane-reminders', 1);
    request.onerror = () => resolve(undefined);
    request.onsuccess = () => {
      const get = request.result.transaction('kv').objectStore('kv').get('notify-prefs');
      get.onsuccess = () => {
        request.result.close();
        resolve(get.result);
      };
    };
  }));
  assert.deepEqual((await readWorkerPrefs())?.off, ['chats'], 'service worker не получил выключенный модуль');
  await notify.locator('[data-notify-row="quiet"]').click();
  const quietFrom = notify.locator('[data-notify-quiet="from"]');
  await shown(quietFrom);
  assert.equal(await quietFrom.inputValue(), '23:30');
  await quietFrom.fill('22:15');
  await page.waitForFunction(() => JSON.parse(localStorage.getItem('parvane:notify-prefs') || '{}').quietFrom === 22 * 60 + 15);
  assert.equal((await readWorkerPrefs())?.isQuietOn, true, 'service worker не получил «Не беспокоить»');
  await chatsSwitch.click();
  await notify.locator('[data-notify-row="quiet"]').click();
  await hidden(quietFrom);
  assert.deepEqual((await readWorkerPrefs())?.off, []);
  // «Не беспокоить 1 час» (пункт меню трея доски `ZdMisc`): до какого часа — строкой, «Включить» снимает
  await notify.locator('[data-notify-mute="hour"]').click();
  await shown(notify.locator('[data-notify-mute="off"]').getByText(/Notifications are off until \d\d:\d\d/));
  await page.waitForFunction(() => JSON.parse(localStorage.getItem('parvane:notify-prefs') || '{}').muteUntil > Date.now());
  assert.ok(((await readWorkerPrefs())?.muteUntil || 0) > Date.now(), 'service worker не получил «Не беспокоить 1 час»');
  await notify.locator('[data-notify-mute="off"]').click();
  await shown(notify.locator('[data-notify-mute="morning"]'));
  await page.waitForFunction(() => JSON.parse(localStorage.getItem('parvane:notify-prefs') || '{}').muteUntil === 0);
  assert.equal((await readWorkerPrefs())?.muteUntil, 0);
  console.log('OK: «Уведомления» — модули и «Не беспокоить» сохраняются и доходят до service worker');

  await profileRow(page, 'Privacy and Security').click();
  const privacy = page.locator('[data-settings-privacy]');
  const groupsRow = privacy.locator('[data-privacy-row="groups"]');
  await shown(groupsRow.locator('[data-privacy-value="anyone"]'));
  await groupsRow.click();
  await page.locator('[role="radiogroup"] [data-choice="nobody"]').click();
  await shown(groupsRow.locator('[data-privacy-value="nobody"]'));
  const groupPolicy = () => page.evaluate(() => window.__parvaneDiagCallApi('parvaneGetGroupAddPolicy', {}));
  assert.equal((await groupPolicy())?.policy, 'nobody', '«Добавлять в группы» не сохранилось');
  await groupsRow.click();
  await page.locator('[role="radiogroup"] [data-choice="anyone"]').click();
  await shown(groupsRow.locator('[data-privacy-value="anyone"]'));
  await shown(privacy.locator('[data-pin-state="off"]').getByText('not set'));
  // «Звонить мне» — «Только контакты» (`DkSettingsB`)
  const callsRow = privacy.locator('[data-privacy-row="call"]');
  await callsRow.click();
  await page.locator('[role="radiogroup"] [data-choice="contacts"]').click();
  await shown(callsRow.locator('[data-privacy-value="contacts"]'));
  await callsRow.click();
  await page.locator('[role="radiogroup"] [data-choice="anyone"]').click();
  await shown(callsRow.locator('[data-privacy-value="anyone"]'));
  // «Показывать, что я в сети» — на сервере; «Звонки только через сервер» — настройка этого устройства
  const callPolicy = () => page.evaluate(() => window.__parvaneDiagCallApi('parvaneGetCallPresencePolicy', {}));
  const online = privacy.locator('[data-privacy-row="online"]');
  await online.click();
  await shown(privacy.locator('[data-privacy-row="online"][aria-checked="false"]'));
  assert.equal((await callPolicy())?.isPresenceShown, false, '«в сети» не сохранилось');
  await online.click();
  await shown(privacy.locator('[data-privacy-row="online"][aria-checked="true"]'));
  const relay = privacy.locator('[data-privacy-row="relay"]');
  const wasRelay = await relay.getAttribute('aria-checked');
  await relay.click();
  await page.waitForFunction(async (before) => {
    const policy = await window.__parvaneDiagCallApi('parvaneGetCallPresencePolicy', {});
    return String(Boolean(policy?.isRelayOnly)) !== before;
  }, wasRelay, { timeout: WAIT_MS });
  await relay.click();
  await shown(privacy.locator(`[data-privacy-row="relay"][aria-checked="${wasRelay}"]`));
  await privacy.locator('[data-privacy-row="password"]').click();
  await shown(page.locator('.Modal [data-password-form] input[type="password"]').first());
  await page.keyboard.press('Escape');
  await hidden(page.locator('.Modal [data-password-form]'));
  await shown(privacy.locator('[data-security-key]'));
  console.log('OK: «Конфиденциальность» — строки «кто может» с выбором в шторке, смена пароля, ключ');

  await profileRow(page, 'Devices and account').click();
  const devicesScreen = page.locator('.SettingsActiveSessions');
  // Это устройство: на компьютере «This computer · …» (`DkSettingsA`), на телефоне «this device»
  await shown(devicesScreen.locator('[data-session-current]').getByText(/this device|This computer/).first());
  assert.equal(await devicesScreen.locator('[data-confirm-sign-in]').count(), 0, 'единственное устройство просят подтвердить');
  await devicesScreen.locator('[data-link-new]').click();
  await shown(page.locator('.Modal').getByText(/sign in with your nick and password/));
  await page.keyboard.press('Escape');
  await hidden(page.locator('.Modal').getByText(/sign in with your nick and password/));
  console.log('OK: «Устройства» — это устройство, «Привязать новое устройство»');

  // Escape: экран → «Обзор» → список чатов
  await page.keyboard.press('Escape');
  await shown(overview);
  await page.keyboard.press('Escape');
  await waitForChatList(page, WAIT_MS);
  await shown(page.locator('#MiddleColumn'));
  await openProfile(page);
  await profileRow(page, 'Saved Messages').click();
  await shown(page.locator('#MiddleColumn').getByText('Saved Messages').first());
  await hidden(nav);
  console.log('OK: Escape ведёт к «Обзору» и к чатам, «Избранное» открывает чат');

  // «Мой профиль» на компьютере — окно поверх «Обзора» (`RdProfile`): «Отмена» не сохраняет
  await openEditProfile(page);
  const editWindow = page.locator('[data-edit-profile-window]');
  await shown(editWindow);
  await shown(editWindow.locator('[data-avatar-change]'));
  await shot(page, 'desk-edit-window');
  const firstName = editWindow.getByLabel('First name (required)');
  const savedName = await firstName.inputValue();
  await firstName.fill(`${savedName} changed`);
  await editWindow.locator('[data-profile-cancel]').click();
  await hidden(editWindow);
  await openEditProfile(page);
  assert.equal(await page.locator('[data-edit-profile-window]').getByLabel('First name (required)').inputValue(), savedName,
    '«Отмена» сохранила имя');
  await page.locator('[data-edit-profile-window] [data-profile-cancel]').click();
  await shown(overview);
  // «Обзор» (`DeskProfile`): строка «Копия ключей … · Открыть» ведёт на «Копию ключей»
  await overview.locator('[data-overview-keys-open]').click();
  await shown(page.locator('[data-keys-bundle-state]'));
  await profileRow(page, 'Overview').click();
  await shown(overview);
  assertNoPageErrors({ desktop: sessions.desktop });

  // ── Телефон ───────────────────────────────────────────────────────────────
  const phone = await browser.newContext({
    viewport: { width: 360, height: 800 }, hasTouch: true, isMobile: true,
  });
  sessions.phone = await preparePage(phone, `profile-gleb-${suffix}@local`, PASSWORD);
  const mobile = sessions.phone.page;
  await dismissRecoveryKeyDialog(mobile).catch(() => undefined);
  const ribbon = mobile.getByRole('navigation', { name: 'Modules' });
  const list = mobile.locator('[data-profile-menu="list"]');
  const mobileBack = mobile.locator('#Settings .Transition_slide-active .left-header > .Button').first();

  await openProfile(mobile);
  await shown(list.locator('[data-profile-head="phone"]'));
  await shown(ribbon);
  assert.equal(await mobile.locator('[data-profile-menu="nav"]').count(), 0, 'на телефоне есть колонка разделов');
  for (const id of ['saved', 'contacts', 'archive', 'modules', 'appearance', 'notifications', 'language', 'devices',
    'privacy', 'keys', 'data', 'export', 'messenger', 'help', 'bug', 'about', 'signOut']) {
    assert.equal(await list.locator(`[data-profile-item="${id}"]`).count(), 1, `нет пункта ${id}`);
  }
  assert.equal(await list.locator('[data-profile-item="overview"]').count(), 0, '«Обзор» — пункт только компьютера');
  await shown(list.locator('[data-profile-item="modules"]').getByText(/^\d+ of \d+$/));
  // Значения строк: копия ключей — «сохранена», когда копия ключей аккаунта на сервере включена (у нового аккаунта она
  // пишется вскоре после создания), иначе «нет»; уведомления — где работают
  await shown(list.locator('[data-profile-item="keys"]').getByText(/^(none|saved)$/));
  await shown(list.locator('[data-profile-item="notifications"]').getByText(/^(off|while open|in the background)$/));
  await shown(list.locator('[data-profile-item="help"]').getByText(/^\d+ notes$/));
  await expectNoOverflow(mobile, 'главный экран');
  console.log('OK: телефон — аккаунт с плитками и разделы списком');

  await list.locator('[data-profile-item="appearance"]').click();
  const mobileAppearance = mobile.locator('[data-settings-appearance]');
  await shown(mobileAppearance);
  await hidden(ribbon);
  await expectNoOverflow(mobile, '«Оформление»');
  const segment = await mobileAppearance.getByRole('group', { name: 'Mode' }).evaluate((el) => {
    const box = el.getBoundingClientRect();
    return { width: box.width, fits: [...el.querySelectorAll('button')].every((b) => b.scrollWidth <= b.clientWidth + 1) };
  });
  assert.ok(segment.width > 300 && segment.fits, `переключатель режима сжат: ${JSON.stringify(segment)}`);
  await mobileBack.click();
  await shown(list);
  await shown(ribbon);

  for (const id of ['notifications', 'devices', 'privacy', 'keys', 'data', 'export', 'messenger', 'help', 'bug',
    'about']) {
    await list.locator(`[data-profile-item="${id}"]`).click();
    await shown(mobileBack);
    await expectNoOverflow(mobile, `экран ${id}`);
    await mobileBack.click();
    await shown(list);
  }
  // «Справка Parvane» (`RpProfileA`): поиск — значком в шапке
  await list.locator('[data-profile-item="help"]').click();
  const help = mobile.locator('[data-settings-help]');
  await shown(help);
  assert.equal(await help.locator('[data-help-note]').count(), 12, 'в справке не 12 заметок');
  await shown(help.getByText(/^Help is 12 ordinary notes/));
  await shown(help.locator('[data-help-note]').getByText('Music', { exact: true }));
  await shown(help.locator('[data-help-restore]'));
  assert.equal(await help.locator('[data-help-search]').count(), 0, 'поле поиска показано без значка');
  await shot(mobile, 'phone-help');
  await mobile.locator('[data-help-search-open]').click();
  const helpCount = await help.locator('[data-help-note]').count();
  await help.locator('[data-help-search]').fill('Ctrl');
  await help.locator('[data-help-snippet]').first().waitFor({ state: 'visible', timeout: WAIT_MS });
  assert.ok(await help.locator('[data-help-note]').count() < helpCount, 'поиск по справке не сузил список');
  await help.locator('[data-help-search]').fill('несуществующееслово');
  await shown(help.locator('[data-help-nothing]'));
  await help.locator('[data-help-search]').fill('');
  await help.locator('[data-help-note]').nth(helpCount - 1).waitFor({ state: 'visible', timeout: WAIT_MS });
  await mobileBack.click();
  await shown(list);

  // «Оформление» телефона (`PhProfileA`): размер «− 15 +», фон строкой со шторкой
  await list.locator('[data-profile-item="appearance"]').click();
  await shown(mobileAppearance.locator('[data-text-size]').getByText(/^\d+$/));
  await shot(mobile, 'phone-appearance');
  await mobileAppearance.locator('[data-appearance-row="background"]').click();
  await shown(mobile.locator('[role="radiogroup"] [data-choice="default"]'));
  await mobile.locator('[role="radiogroup"] [data-choice="default"]').click();
  await mobileBack.click();
  await shown(list);

  await openEditProfile(mobile);
  // spec 041 (`XpProfile`): «Мой профиль» с «Готово», ник своим блоком — смена ника видна только при новом нике
  await shown(mobile.locator('[data-profile-done]'));
  await shown(mobile.locator('[data-avatar-change]'));
  assert.equal(await mobile.getByPlaceholder('a few words, optional').count(), 1, 'нет подсказки в «О себе»');
  const nickInput = mobile.locator('#parvane-rename-nick');
  const ownNick = await nickInput.inputValue();
  await nickInput.fill(`profile-free-${suffix.replace(/\D/g, '').slice(-8)}`);
  await shown(mobile.locator('[data-rename-nick-state="free"]'));
  await nickInput.fill('x');
  await shown(mobile.locator('[data-rename-nick-state="invalid"]'));
  await expectNoOverflow(mobile, '«Мой профиль»');
  await shot(mobile, 'phone-edit');
  // С неверным ником «Готово» не уходит с экрана; прежний ник — сохранять нечего, назад
  await mobile.locator('[data-profile-done]').click();
  await shown(mobile.locator('[data-rename-nick-state="invalid"]'));
  await nickInput.fill(ownNick);
  await mobile.locator('[data-profile-done]').click();
  await shown(list);
  console.log('OK: телефон — экраны открываются на весь экран и возвращаются в «Профиль»');

  // ── «Копия ключей»: что в копии ключей аккаунта и новый ключ восстановления (`ZdProfileX`) ──────────────────
  const keysContext = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  // Метка протокола в seed — диалог ключа сценарий закрывает сам и читает ключ
  sessions.keys = await preparePage(keysContext, `profile-keys-${suffix}@local`, PASSWORD, {
    seedLocalStorage: { 'parvane:proto': 'v2' },
  });
  const keysPage = sessions.keys.page;
  const keyOf = (text) => text?.match(/[0-9A-Z]{4}(?:-[0-9A-Z]{4}){9}/)?.[0];
  const firstKey = keyOf(await dismissRecoveryKeyDialog(keysPage, 30_000));
  assert.ok(firstKey, 'ключ восстановления не показан');
  const bundleWrites = () => sessions.keys.logs.filter((line) => line.includes('копия ключей аккаунта обновлена')).length;
  const waitBundleWrites = async (count) => {
    const deadline = Date.now() + 60_000;
    while (bundleWrites() < count && Date.now() < deadline) await keysPage.waitForTimeout(500);
    assert.ok(bundleWrites() >= count, `копия ключей аккаунта не записана (${bundleWrites()} < ${count})`);
  };
  await waitBundleWrites(1);
  const openKeys = async () => {
    await openProfile(keysPage);
    await profileRow(keysPage, 'About').click();
    await profileRow(keysPage, 'Key backup').click();
    await shown(keysPage.locator('[data-keys-bundle] [data-bundle-part="chats"]').getByText('yes'));
  };
  await openKeys();
  assert.equal(
    await keysPage.locator('[data-keys-bundle] [data-bundle-part]').count(), 6, 'строки «Что в копии»',
  );
  // Устройство-создатель держит корень аккаунта (RECOVER-1 п. 8): новый ключ — без прежнего, но с паролем аккаунта;
  // неверный пароль — ошибка в окне, ключ не выпускается
  const keylessDialog = (on) => on.locator('.Modal .modal-dialog').filter({ hasText: 'Create a new recovery key?' });
  const renewKeyless = async (on) => {
    await on.locator('[data-keys-action="renew"]').click();
    const dialog = keylessDialog(on);
    await shown(dialog);
    assert.equal(await dialog.locator('input').count(), 1, 'с корнем на устройстве — одно поле, пароль');
    const submit = dialog.getByRole('button', { name: 'Create new key' });
    assert.ok(await submit.isDisabled(), 'без пароля ключ не выпускается');
    const renewalsBefore = sessions.keys.logs.filter((line) => line.includes('ключ восстановления заменён новым')).length;
    await dialog.locator('[data-renew-password]').fill(`${PASSWORD}x`);
    await submit.click();
    await shown(dialog.locator('[data-renew-error="bad_password"]'));
    await shown(dialog);
    assert.equal(
      sessions.keys.logs.filter((line) => line.includes('ключ восстановления заменён новым')).length, renewalsBefore,
      'неверный пароль выпустил новый ключ',
    );
    await dialog.locator('[data-renew-password]').fill(PASSWORD);
    await submit.click();
    await hidden(dialog);
  };
  await renewKeyless(keysPage);
  const secondKey = keyOf(await dismissRecoveryKeyDialog(keysPage, 30_000));
  assert.ok(secondKey && secondKey !== firstKey, `новый ключ не показан: ${secondKey}`);
  await shown(keysPage.getByText('New recovery key created. Save it from the window.').first());
  console.log('OK: «Копия ключей» — новый ключ без прежнего на устройстве-создателе (пароль проверен, неверный отклонён)');

  // Привязанное грантом устройство корня не получает: ключ спрашивается; прежний больше не подходит
  const linkedContext = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  sessions.linked = await preparePage(linkedContext, `profile-keys-${suffix}@local`, PASSWORD, {
    seedLocalStorage: { 'parvane:proto': 'v2' },
  });
  const linkedPage = sessions.linked.page;
  await linkSecondDevice(keysPage, linkedPage);
  const openKeysOn = async (on) => {
    await openProfile(on);
    await profileRow(on, 'About').click();
    await profileRow(on, 'Key backup').click();
    await shown(on.locator('[data-keys-action="renew"]'));
  };
  await openKeysOn(linkedPage);
  const renewDialog = linkedPage.locator('.Modal .modal-dialog').filter({ hasText: 'Enter your current recovery key' });
  const renewWith = async (key) => {
    await linkedPage.locator('[data-keys-action="renew"]').click();
    await renewDialog.locator('input').fill(key);
    await renewDialog.getByRole('button', { name: 'Create new key' }).click();
    await hidden(renewDialog);
  };
  await renewWith(secondKey.replace(/.$/, (c) => (c === '2' ? '3' : '2')));
  await shown(linkedPage.getByText('This recovery key does not match.').first());
  await renewWith(firstKey);
  await shown(linkedPage.getByText('This recovery key does not match.').first());
  await renewWith(secondKey);
  const thirdKey = keyOf(await dismissRecoveryKeyDialog(linkedPage, 30_000));
  assert.ok(thirdKey && thirdKey !== secondKey, `новый ключ не показан на привязанном: ${thirdKey}`);
  // Ключ введён — корень запомнен: следующий новый ключ уже без прежнего
  await openKeysOn(linkedPage);
  await linkedPage.locator('[data-keys-action="renew"]').click();
  await shown(keylessDialog(linkedPage).locator('[data-renew-password]'));
  await linkedPage.keyboard.press('Escape');
  await hidden(keylessDialog(linkedPage));
  console.log('OK: «Копия ключей» — привязанное устройство: прежний ключ не подходит, нынешний — новый ключ, затем без ключа');

  // «Выключить копию» (`ZdProfileX`): пароль аккаунта, на сервере — пометка без ключей; после перезагрузки устройство
  // копию не переписывает; «Включить» возвращает ключи. Копию ведёт привязанное устройство (новый ключ — его)
  // Журнал страницы ограничен по длине — считаем строки после своей метки
  const markLogs = (label) => sessions.linked.logs.push(`--- ${label}`);
  const countSince = (label, text) => {
    const { logs } = sessions.linked;
    return logs.slice(logs.lastIndexOf(`--- ${label}`) + 1).filter((line) => line.includes(text)).length;
  };
  markLogs('off');
  const offLogs = () => countSince('off', 'копия ключей аккаунта выключена');
  await openKeysOn(linkedPage);
  await shown(linkedPage.locator('[data-keys-bundle] [data-bundle-part="chats"]').getByText('yes'));
  await linkedPage.locator('[data-keys-action="bundle-off"]').click();
  const offDialog = linkedPage.locator('.Modal .modal-dialog')
    .filter({ has: linkedPage.locator('[data-keys-off-dialog]') });
  await shown(offDialog);
  assert.equal(await offDialog.locator('[data-keys-off-dialog] li').count(), 3, 'последствия выключения');
  const offSubmit = offDialog.getByRole('button', { name: 'Turn off the copy' });
  assert.ok(await offSubmit.isDisabled(), 'без пароля копия не выключается');
  await offDialog.locator('[data-keys-off-password]').fill(`${PASSWORD}x`);
  await offSubmit.click();
  await shown(offDialog.locator('[data-keys-off-error="bad_password"]'));
  assert.equal(offLogs(), 0, 'неверный пароль выключил копию');
  await offDialog.locator('[data-keys-off-password]').fill(PASSWORD);
  await offSubmit.click();
  await hidden(offDialog);
  await shown(linkedPage.locator('[data-keys-bundle-off]'));
  assert.equal(offLogs(), 1, 'пометка «выключена» не записана');
  markLogs('reload');
  await relogin(linkedPage, PASSWORD);
  // Первая сверка копии после запуска — через 8 с; ключи на сервер не уходят
  await linkedPage.waitForTimeout(12_000);
  assert.equal(
    countSince('reload', 'копия ключей аккаунта обновлена'), 0, 'выключенную копию устройство переписало ключами',
  );
  // При выключенной копии новое устройство по ключу восстановления не входит (решение 20 ноя 2026): подсказка
  // «привяжите с другого устройства», прежние устройства не отзываются
  const strayContext = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  sessions.stray = await preparePage(strayContext, `profile-keys-${suffix}@local`, PASSWORD, {
    seedLocalStorage: { 'parvane:proto': 'v2' },
  });
  const strayPage = sessions.stray.page;
  const strayScreen = await openDevicesScreen(strayPage);
  await strayScreen.locator('[data-recover-key-input]').fill(thirdKey);
  await strayScreen.locator('[data-recover-key-submit]').click();
  await shown(strayPage.getByText('The account key copy is turned off').first());
  await shown(strayScreen.locator('[data-confirm-sign-in]'));
  assert.equal(
    sessions.stray.logs.filter((line) => line.includes('прежние устройства отозваны')).length, 0,
    'вход по ключу при выключенной копии отозвал прежние устройства',
  );
  await strayContext.close();
  delete sessions.stray;
  await openKeysOn(linkedPage);
  await shown(linkedPage.locator('[data-keys-bundle-off]'));
  await linkedPage.locator('[data-keys-action="bundle-on"]').click();
  await shown(linkedPage.locator('[data-keys-bundle] [data-bundle-part="chats"]').getByText('yes'));
  await shown(linkedPage.locator('[data-keys-action="bundle-off"]'));
  console.log('OK: «Копия ключей» — выключение с паролем, не переписывается после перезагрузки, вход по ключу отклонён, включение');

  assertNoPageErrors(sessions);

  console.log('OK: «Профиль» по макету — компьютер и телефон');
} catch (err) {
  const dir = new URL('../web/telegram-tt/test-results/', import.meta.url).pathname;
  for (const [name, session] of Object.entries(sessions)) {
    await session.page.screenshot({ path: `${dir}profile-${name}.png` }).catch(() => {});
  }
  throw err;
} finally {
  await browser.close();
}
