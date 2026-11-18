// Модули (spec 041, этап A; MODULES-1). Стек сценария объявляет «Заметки» и «Музыку» выключенными администратором.
// Компьютер: панель строится из списка модулей, экран «Профиль → Модули» выключает модуль — он пропадает из
// панели и общего поиска и не возвращается после перезагрузки; модуль, выключенный сервером, включить нельзя;
// порядок меняется. Телефон: лента до пяти модулей делит ширину, «+» над лентой, в «Профиле» кнопки нет.
import assert from 'node:assert/strict';

import { chromium } from '../web/telegram-tt/node_modules/playwright/index.mjs';

import {
  LOGIN_TIMEOUT_MS,
  assertNoPageErrors,
  preparePage,
} from './e2e_web_helpers.mjs';

const PASSWORD = 'Parvane-modules-e2e-password';
const WAIT_MS = 15_000;

const browser = await chromium.launch();
const sessions = {};

async function modulesOf(page, root) {
  return (await page.locator(`${root} [data-modules]`).getAttribute('data-modules')).split(' ');
}

async function expectModules(page, root, expected, message) {
  await page.waitForFunction(([selector, value]) => (
    document.querySelector(`${selector} [data-modules]`)?.getAttribute('data-modules') === value
  ), [root, expected.join(' ')], { timeout: WAIT_MS }).catch(async () => {
    assert.deepEqual(await modulesOf(page, root), expected, message);
  });
}

// Закрыть меню «+». Пункты закрытого меню остаются в разметке, поэтому признак закрытия — подложка меню: она
// есть, только пока меню открыто, и перехватывает нажатия. Escape, а если фокус ушёл — нажатие мимо меню
async function closeAddMenu(page) {
  const backdrop = page.locator('.Menu .backdrop');
  const isClosed = () => backdrop.count().then((count) => count === 0);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(400);
  // Нажимаем саму подложку: нажатие в точку экрана попадало в чат, если меню успевало закрыться само
  if (!(await isClosed())) await backdrop.first().click({ position: { x: 5, y: 5 }, timeout: 2000 }).catch(() => {});
  await page.waitForFunction(() => !document.querySelector('.Menu .backdrop'), undefined, { timeout: WAIT_MS });
}

async function openModulesScreen(page, root) {
  await page.locator(`${root} [data-module="profile"]`).click();
  await page.getByText('Modules', { exact: true }).first().click();
  await page.locator('[role="switch"][data-module="chats"]').waitFor({ state: 'visible', timeout: WAIT_MS });
}

try {
  const suffix = `${Date.now()}-${process.pid}`;

  // ── Компьютер ─────────────────────────────────────────────────────────────
  const desktop = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  sessions.desktop = await preparePage(desktop, `modules-alice-${suffix}@local`, PASSWORD);
  const { page } = sessions.desktop;
  const SIDE = '#FoldersSidebar';

  // «Заметки» и «Музыка» выключены сервером
  await expectModules(page, SIDE, ['chats', 'plan', 'health', 'files', 'profile'], 'состав панели при входе');
  console.log('OK: панель — модули устройства без выключенного сервером');

  await openModulesScreen(page, SIDE);
  const notesSwitch = page.locator('[role="switch"][data-module="notes"]');
  assert.equal(await notesSwitch.isDisabled(), true, 'модуль, выключенный сервером, включается');
  assert.equal(await notesSwitch.getAttribute('aria-checked'), 'false');
  // Сервер выключил два модуля — подпись стоит у обоих
  await page.getByText('Turned off by the server administrator').first().waitFor({ state: 'visible', timeout: WAIT_MS });
  assert.equal(await page.locator('[role="switch"][data-module="music"]').isDisabled(), true, '«Музыка», выключенная сервером, включается');
  assert.equal(await page.locator('[role="switch"][data-module="chats"]').isDisabled(), true, '«Чаты» выключаются');
  assert.equal(await page.locator('[role="switch"][data-module="profile"]').isDisabled(), true);
  console.log('OK: «Чаты» и «Профиль» заперты, модуль сервера не включить');

  await page.locator('[role="switch"][data-module="files"]').click();
  await expectModules(page, SIDE, ['chats', 'plan', 'health', 'profile'], '«Файлы» остались в панели');
  await page.getByText('Hidden · data is kept').waitFor({ state: 'visible', timeout: WAIT_MS });
  console.log('OK: выключенный модуль пропал из панели');

  // Блоки «Здоровья»: сон и показатели тела включены, остальные нет
  const blockState = (block) => page.locator(`[role="switch"][data-block="${block}"]`).getAttribute('aria-checked');
  assert.deepEqual(
    [await blockState('sleep'), await blockState('body'), await blockState('food'), await blockState('water')],
    ['true', 'true', 'false', 'false'],
  );
  await page.locator('[role="switch"][data-block="water"]').click();
  await page.getByText('Blocks on: 3 of 5').waitFor({ state: 'visible', timeout: WAIT_MS });
  console.log('OK: блоки «Здоровья» переключаются');

  // Порядок: «Здоровье» выше «Плана»
  await page.getByRole('button', { name: 'Move up: Health' }).click();
  await expectModules(page, SIDE, ['chats', 'health', 'plan', 'profile'], 'порядок не изменился');
  console.log('OK: порядок модулей меняется');

  // Общий поиск: команды выключенных модулей нет, включённого — есть
  // Корень модального окна Playwright видимым не считает — ждём само поле поиска
  await page.keyboard.press('Control+K');
  const search = page.locator('[name="parvane-palette-search"]');
  await search.waitFor({ state: 'visible', timeout: WAIT_MS });
  const commandCount = (name) => page.locator('[data-palette-group="command"]').getByRole('option', { name }).count();
  await search.fill('Health');
  await page.locator('[data-palette-group="command"]').getByRole('option', { name: /Health/ }).first()
    .waitFor({ state: 'visible', timeout: WAIT_MS });
  await search.fill('Files');
  await page.waitForTimeout(800);
  assert.equal(await commandCount(/^Files/), 0, 'поиск ведёт в выключенные «Файлы»');
  await search.fill('Notes');
  await page.waitForTimeout(800);
  assert.equal(await commandCount(/Notes|New note/i), 0, 'поиск ведёт в «Заметки», выключенные сервером');
  await page.keyboard.press('Escape');
  await search.waitFor({ state: 'hidden', timeout: WAIT_MS });
  console.log('OK: поиск не показывает выключенный модуль');

  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.locator(SIDE).waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await expectModules(page, SIDE, ['chats', 'health', 'plan', 'profile'], 'настройка не пережила перезагрузку');
  console.log('OK: состав и порядок пережили перезагрузку');

  await openModulesScreen(page, SIDE);
  await page.locator('[role="switch"][data-module="files"]').click();
  await expectModules(page, SIDE, ['chats', 'health', 'plan', 'files', 'profile'], '«Файлы» не вернулись');
  await page.locator(`${SIDE} [data-module="files"]`).click();
  await page.locator('#ParvaneCloud').waitFor({ state: 'visible', timeout: WAIT_MS });
  // Открытый модуль выключают — приложение возвращается в «Чаты»
  await page.evaluate(() => {
    const prefs = JSON.parse(localStorage.getItem('parvane:modules'));
    localStorage.setItem('parvane:modules', JSON.stringify({ ...prefs, off: ['files'] }));
    sessionStorage.setItem('parvane:section', 'files');
  });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.locator(SIDE).waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await page.locator(`${SIDE} [data-module="chats"][aria-selected="true"]`).waitFor({ state: 'visible', timeout: WAIT_MS });
  console.log('OK: сохранённый раздел выключенного модуля открывает «Чаты»');

  // ── Телефон ───────────────────────────────────────────────────────────────
  const phone = await browser.newContext({ viewport: { width: 390, height: 800 }, hasTouch: true, isMobile: true });
  sessions.phone = await preparePage(phone, `modules-bob-${suffix}@local`, PASSWORD);
  const mobile = sessions.phone.page;
  const RIBBON = 'body';
  const ribbon = mobile.locator('nav[data-modules]');
  await ribbon.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await expectModules(mobile, RIBBON, ['chats', 'plan', 'health', 'files', 'profile'], 'состав ленты');
  // Пять модулей: лента не прокручивается, стрелок нет, значки делят ширину
  assert.equal(await ribbon.getByRole('button', { name: 'More modules' }).count(), 0, 'у пяти модулей есть стрелки');
  const widths = await ribbon.locator('[data-module]').evaluateAll((items) => items.map((item) => Math.round(item.getBoundingClientRect().width)));
  assert(Math.max(...widths) - Math.min(...widths) <= 1, `значки разной ширины: ${widths}`);
  assert(Math.abs(widths.reduce((sum, width) => sum + width, 0) - 390) <= 2, `лента не во всю ширину: ${widths}`);
  console.log('OK: лента из пяти модулей делит ширину');

  const add = mobile.locator('[data-add-for]');
  assert.equal(await add.getAttribute('data-add-for'), 'chats');
  const addBox = await add.boundingBox();
  const ribbonBox = await ribbon.boundingBox();
  assert(addBox.y + addBox.height <= ribbonBox.y, '«+» перекрывает ленту');
  await add.click();
  await mobile.getByRole('menuitem', { name: 'New Group' }).waitFor({ state: 'visible', timeout: WAIT_MS });
  await closeAddMenu(mobile);
  console.log('OK: «+» над лентой, в «Чатах» — меню');

  await ribbon.locator('[data-module="files"]').click();
  await mobile.locator('[data-add-for="files"]').click();
  await mobile.getByRole('menuitem', { name: 'New folder' }).waitFor({ state: 'visible', timeout: WAIT_MS });
  await closeAddMenu(mobile);
  await ribbon.locator('[data-module="profile"]').click();
  await mobile.locator('[data-add-for]').waitFor({ state: 'detached', timeout: WAIT_MS });
  console.log('OK: в «Файлах» своё меню, в «Профиле» кнопки нет');

  assertNoPageErrors(sessions);
  console.log('OK: модули — панель, лента, экран «Модули», поиск, список сервера');
} catch (error) {
  const shotDir = process.env.PARVANE_E2E_SHOT_DIR;
  for (const [name, session] of Object.entries(sessions)) {
    if (shotDir) await session.page.screenshot({ path: `${shotDir}/modules-${name}.png` }).catch(() => {});
    console.error(`--- ${name} ---\n${session.logs.slice(-40).join('\n')}`);
  }
  throw error;
} finally {
  await browser.close();
}
