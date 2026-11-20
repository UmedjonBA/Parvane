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
  openEditProfile,
  openProfile,
  openSettingsScreen,
  preparePage,
  profileRow,
  waitForChatList,
} from './e2e_web_helpers.mjs';

const PASSWORD = 'Parvane-profile-e2e-password';
const WAIT_MS = 15_000;

const browser = await chromium.launch();
const sessions = {};

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

  await profileRow(page, 'Key backup').click();
  await shown(page.locator('[data-keys-action="save"]'));
  await shown(page.locator('[data-keys-action="restore"]'));
  await profileRow(page, 'About').click();
  await shown(page.locator('[data-about-version]').getByText(/^version \S+/));
  await profileRow(page, 'Devices and account').click();
  await shown(page.locator('.SettingsActiveSessions'));
  await shown(current('devices'));
  // spec 041 (`DkSettingsA`): карточки аккаунта и «Опасная зона»; удаление — экраном
  await shown(page.locator('[data-account-card] [data-account-row="nick"]').getByText(/^@profile-vera-/));
  await page.locator('[data-delete-account-open]:visible').click();
  await shown(page.locator('[data-delete-account-dialog]'));
  await shown(current('devices'));
  await back.click();
  await shown(page.locator('.SettingsActiveSessions'));
  await page.locator('[data-account-row="password"]').click();
  await shown(page.locator('[data-password-form]'));
  await profileRow(page, 'Devices and account').click();
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

  // spec 041: «Справка Parvane» и «Сообщить об ошибке» — экраны; «Формат» в «Языке»
  await profileRow(page, 'Parvane help').click();
  const help = page.locator('[data-settings-help]');
  await shown(help);
  assert.equal(await help.locator('[data-help-note]').count() >= 10, true, 'список заметок справки');
  await shown(help.locator('[data-help-restore]'));
  // Поиск по справке: слова запроса в названии либо тексте, найденная строка — под названием
  const helpCount = await help.locator('[data-help-note]').count();
  await help.locator('[data-help-search]').fill('Ctrl');
  await help.locator('[data-help-snippet]').first().waitFor({ state: 'visible', timeout: WAIT_MS });
  assert.ok(await help.locator('[data-help-note]').count() < helpCount, 'поиск по справке не сузил список');
  await help.locator('[data-help-search]').fill('несуществующееслово');
  await shown(help.locator('[data-help-nothing]'));
  await help.locator('[data-help-search]').fill('');
  await help.locator('[data-help-note]').nth(helpCount - 1).waitFor({ state: 'visible', timeout: WAIT_MS });
  await profileRow(page, 'Report a Bug').click();
  const bug = page.locator('[data-bug-report]');
  await shown(bug);
  assert.equal(await bug.locator('[data-bug-send]').isDisabled(), true, 'пустой отчёт не отправляется');
  await bug.locator('[data-area="notes"]').click();
  await shown(bug.locator('[data-area="notes"][aria-pressed="true"]'));
  await bug.locator('[data-bug-preview]').click();
  await shown(bug.getByText(/^Parvane \S+ · \S+ · \S+/));
  await profileRow(page, 'Language').click();
  await shown(page.locator('[data-language-time-format]'));
  console.log('OK: справка, отчёт об ошибке, формат времени');
  await profileRow(page, 'Log Out').click();
  const logOutButton = page.locator('.Modal').getByRole('button', { name: 'Log Out' }).last();
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
  await privacy.locator('[data-privacy-row="password"]').click();
  await shown(privacy.locator('[data-password-form] input[type="password"]').first());
  await shown(privacy.locator('[data-security-key]'));
  console.log('OK: «Конфиденциальность» — строки «кто может» с выбором в шторке, смена пароля, ключ');

  await profileRow(page, 'Devices and account').click();
  const devicesScreen = page.locator('.SettingsActiveSessions');
  await shown(devicesScreen.locator('[data-session-current]').getByText('this device'));
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

  await openEditProfile(page);
  await shown(back);
  await page.keyboard.press('Escape');
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
  // Значения строк: копии ключей с этого устройства ещё не было, объём данных — из оценки браузера
  await shown(list.locator('[data-profile-item="keys"]').getByText('none', { exact: true }));
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
  await openEditProfile(mobile);
  // spec 041 (`XpProfile`): «Мой профиль» с «Готово», ник своим блоком — смена ника видна только при новом нике
  await shown(mobile.locator('[data-profile-done]'));
  const nickInput = mobile.locator('#parvane-rename-nick');
  await nickInput.fill(`profile-free-${suffix.replace(/\D/g, '').slice(-8)}`);
  await shown(mobile.locator('[data-rename-nick-state="free"]'));
  await nickInput.fill('x');
  await shown(mobile.locator('[data-rename-nick-state="invalid"]'));
  await expectNoOverflow(mobile, '«Мой профиль»');
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
  const renewDialog = keysPage.locator('.Modal .modal-dialog').filter({ hasText: 'Enter your current recovery key' });
  const renewWith = async (key) => {
    await keysPage.locator('[data-keys-action="renew"]').click();
    await renewDialog.locator('input').fill(key);
    await renewDialog.getByRole('button', { name: 'Create new key' }).click();
    await hidden(renewDialog);
  };
  await renewWith(firstKey.replace(/.$/, (c) => (c === '2' ? '3' : '2')));
  await shown(keysPage.getByText('This recovery key does not match.').first());
  await renewWith(firstKey);
  const secondKey = keyOf(await dismissRecoveryKeyDialog(keysPage, 30_000));
  assert.ok(secondKey && secondKey !== firstKey, `новый ключ не показан: ${secondKey}`);
  await shown(keysPage.getByText('New recovery key created. Save it from the window.').first());
  // Копия ключей переписана под новым ключом (её открывает новый ключ копии); прежний ключ больше не подходит
  await openKeys();
  await renewWith(firstKey);
  await shown(keysPage.getByText('This recovery key does not match.').first());
  console.log('OK: «Копия ключей» — состав копии, новый ключ восстановления, прежний больше не подходит');

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
