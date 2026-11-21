// Модули (spec 041, этап A; MODULES-1). Стек сценария объявляет «Заметки» и «Музыку» выключенными администратором.
// Компьютер: панель строится из списка модулей, экран «Профиль → Модули» выключает модуль — он пропадает из
// панели и общего поиска и не возвращается после перезагрузки; модуль, выключенный сервером, включить нельзя;
// порядок меняется (стрелки на ручке, перетаскивание мышью и касанием — лента и панель меняются по ходу); вид экрана
// на компьютере — по доске `Desktop` (подпись через «·», чипы блоков и настроек модуля). Телефон: лента до пяти
// модулей делит ширину, «+» над лентой, открытое меню закрывает «×», в «Профиле» кнопки нет.
// Часть `PARVANE_E2E_MODULES_PART=all` (раннер `run_web_modules_all_e2e.sh`, сервер ничего не выключает): лента
// из семи модулей со стрелками, «+» «Плана», узкое окно компьютера 540 px (доска `RdNarrow`).
import assert from 'node:assert/strict';

import { chromium } from '../web/telegram-tt/node_modules/playwright/index.mjs';

import {
  LOGIN_TIMEOUT_MS,
  assertNoPageErrors,
  findMessageContainers,
  openSavedMessages,
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
  // Открытое меню «+» закрывает сама кнопка («×», доска `PlusModes`)
  const closeButton = page.getByRole('button', { name: 'Close menu' });
  if (await closeButton.count()) await closeButton.first().click({ timeout: 2000 }).catch(() => {});
  if (await isClosed()) return;
  await page.keyboard.press('Escape');
  await page.waitForTimeout(400);
  // Нажимаем саму подложку: нажатие в точку экрана попадало в чат, если меню успевало закрыться само
  if (!(await isClosed())) await backdrop.first().click({ position: { x: 5, y: 5 }, timeout: 2000 }).catch(() => {});
  await page.waitForFunction(() => !document.querySelector('.Menu .backdrop'), undefined, { timeout: WAIT_MS });
}

// Перетаскивание касанием: события касания CDP — Chromium превращает их в события указателя (`pointerType=touch`)
async function touchDrag(page, from, to, onMove) {
  const cdp = await page.context().newCDPSession(page);
  const point = (x, y) => [{ x: Math.round(x), y: Math.round(y) }];
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: point(from.x, from.y) });
  const STEPS = 8;
  for (let step = 1; step <= STEPS; step++) {
    const y = from.y + ((to.y - from.y) * step) / STEPS;
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: point(from.x, y) });
    await page.waitForTimeout(60);
  }
  if (onMove) await onMove();
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await cdp.detach();
}

function centerOf(box) {
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

async function openModulesScreen(page, root) {
  await page.locator(`${root} [data-module="profile"]`).click();
  await page.getByText('Modules', { exact: true }).first().click();
  await page.locator('[role="switch"][data-module="chats"]').waitFor({ state: 'visible', timeout: WAIT_MS });
}

async function runServerOffPart(suffix) {

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

  // В «Профиле» на компьютере «+» нет (как на телефоне): меню «Чатов» из «Профиля» не открывается
  assert.equal(await page.locator(`${SIDE} [data-add-for]`).count(), 0, 'в «Профиле» у панели есть «+»');
  // Кнопка общего поиска — значок 44 × 44 с именем по доске `DeskChats`
  const searchButton = page.locator(SIDE).getByRole('button', { name: 'Global search, Ctrl+K' });
  const searchBox = await searchButton.boundingBox();
  assert.ok(Math.abs(searchBox.width - 44) <= 1 && Math.abs(searchBox.height - 44) <= 1, `кнопка поиска ${JSON.stringify(searchBox)}`);
  console.log('OK: в «Профиле» панели «+» нет, общий поиск — значок «Global search, Ctrl+K»');

  // Вид компьютера (доска `Desktop`): подпись за названием через «·», пояснение под заголовком, ручки с именем
  await page.getByText('The order is shared by the side panel and the phone ribbon', { exact: false })
    .waitFor({ state: 'visible', timeout: WAIT_MS });
  await page.locator('[data-module-row="chats"]').getByText('· always on').waitFor({ state: 'visible', timeout: WAIT_MS });
  assert.equal(await page.getByRole('button', { name: /^Move (up|down):/ }).count(), 0, 'кнопки ↑/↓ остались');
  await page.locator('[data-module-row="plan"] [data-module-settings="plan"]').waitFor({ state: 'visible', timeout: WAIT_MS });
  await page.locator('[data-module-row="health"] [data-module-settings="health"]').getByText('Goals', { exact: true })
    .waitFor({ state: 'visible', timeout: WAIT_MS });

  await page.locator('[role="switch"][data-module="files"]').click();
  await expectModules(page, SIDE, ['chats', 'plan', 'health', 'profile'], '«Файлы» остались в панели');
  await page.getByText('· hidden, data is kept').waitFor({ state: 'visible', timeout: WAIT_MS });
  console.log('OK: выключенный модуль пропал из панели');

  // Блоки «Здоровья» на компьютере — чипы `aria-pressed`: сон и показатели тела включены, остальные нет
  const blockState = (block) => page.locator(`button[data-block="${block}"]`).getAttribute('aria-pressed');
  assert.deepEqual(
    [await blockState('sleep'), await blockState('body'), await blockState('food'), await blockState('water')],
    ['true', 'true', 'false', 'false'],
  );
  await page.locator('button[data-block="water"]').click();
  await page.locator('button[data-block="water"][aria-pressed="true"]').waitFor({ state: 'visible', timeout: WAIT_MS });
  await page.getByText('· sleep, body metrics, water').waitFor({ state: 'visible', timeout: WAIT_MS });
  console.log('OK: блоки «Здоровья» переключаются чипами');

  // Порядок: «Здоровье» выше «Плана» — перетаскиванием мышью за ручку. Пока строка в пути, панель уже в новом
  // порядке, на прежнем месте след «было здесь», сама строка — «отпустите здесь»
  const healthHandle = page.getByRole('button', { name: 'Drag: Health' });
  const from = centerOf(await healthHandle.boundingBox());
  const planBox = await page.locator('[data-module-row="plan"] > [data-module="plan"]').boundingBox();
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x, planBox.y + 6, { steps: 8 });
  await expectModules(page, SIDE, ['chats', 'health', 'plan', 'profile'], 'панель не меняется во время перетаскивания');
  await page.locator('[data-module-trace]').getByText('was here').waitFor({ state: 'visible', timeout: WAIT_MS });
  await page.locator('[data-dragging]').getByText('drop here').waitFor({ state: 'visible', timeout: WAIT_MS });
  await page.mouse.up();
  await page.locator('[data-module-trace]').waitFor({ state: 'detached', timeout: WAIT_MS });
  await expectModules(page, SIDE, ['chats', 'health', 'plan', 'profile'], 'порядок не изменился');
  // Стрелки на ручке: вниз и обратно вверх, фокус остаётся на ручке
  await healthHandle.focus();
  await page.keyboard.press('ArrowDown');
  await expectModules(page, SIDE, ['chats', 'plan', 'health', 'profile'], 'стрелка вниз не переставила');
  await page.waitForFunction(() => document.activeElement?.dataset?.dragHandle === 'health', undefined, { timeout: WAIT_MS });
  await page.keyboard.press('ArrowUp');
  await expectModules(page, SIDE, ['chats', 'health', 'plan', 'profile'], 'стрелка вверх не переставила');
  console.log('OK: порядок модулей меняется перетаскиванием и стрелками');

  // Общий поиск: команды выключенных модулей нет, включённого — есть
  // Корень модального окна Playwright видимым не считает — ждём само поле поиска
  await page.keyboard.press('Control+K');
  const search = page.locator('[name="parvane-palette-search"]');
  await search.waitFor({ state: 'visible', timeout: WAIT_MS });
  // Строка «Искать «…» в чатах и сообщениях» есть при любом запросе — это «Чаты», не модуль запроса
  const commandCount = (name) => page.locator('[data-palette-group="command"] [data-palette-item]:not([data-palette-item="chat-search"])')
    .filter({ hasText: name }).count();
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

  // Карточка модуля, выключенного на устройстве (spec 041 E6): действие ведёт в лист «Модуль выключен»,
  // «Не сейчас» ничего не меняет, «Включить» возвращает модуль и выполняет действие
  const offerName = `Задание-${suffix}`;
  await openSavedMessages(page);
  await page.getByRole('button', { name: 'Add an attachment' }).click();
  await page.getByRole('menuitem', { name: 'Suggest for plan', exact: true }).click();
  const offerDialog = page.getByRole('dialog');
  await offerDialog.locator('#task-offer-name').waitFor({ state: 'visible', timeout: WAIT_MS });
  await offerDialog.locator('#task-offer-name').fill(offerName);
  await offerDialog.getByRole('button', { name: 'Send', exact: true }).click();
  const offerCard = findMessageContainers(page, offerName).locator('[data-task-offer]').first();
  await offerCard.waitFor({ state: 'visible', timeout: WAIT_MS });
  await openModulesScreen(page, SIDE);
  await page.locator('[role="switch"][data-module="plan"]').click();
  await expectModules(page, SIDE, ['chats', 'health', 'profile'], '«План» остался в панели');
  // «Профиль» на компьютере занимает всё окно — возвращаемся в чат
  await openSavedMessages(page);
  const toPlan = offerCard.getByRole('button', { name: 'To plan' });
  const moduleOff = page.locator('[data-module-off="plan"]');
  await toPlan.click();
  await moduleOff.getByText('The task will go to your plan once the module is on')
    .waitFor({ state: 'visible', timeout: WAIT_MS });
  await page.getByText('Plan is turned off', { exact: true }).waitFor({ state: 'visible', timeout: WAIT_MS });
  await moduleOff.getByRole('button', { name: 'Not now' }).click();
  await moduleOff.waitFor({ state: 'hidden', timeout: WAIT_MS });
  await page.waitForTimeout(500);
  assert.equal(await page.locator(`${SIDE} [data-module="plan"]`).count(), 0, '«Не сейчас» включило модуль');
  assert.equal(await offerCard.getAttribute('data-in-plan'), 'false', '«Не сейчас» добавило задание в план');
  await toPlan.click();
  await moduleOff.getByRole('button', { name: 'Turn on Planner' }).click();
  await page.locator(`${SIDE} [data-module="plan"]`).waitFor({ state: 'visible', timeout: WAIT_MS });
  await page.locator(`[data-task-offer][data-in-plan="true"]`).filter({ hasText: offerName })
    .waitFor({ state: 'visible', timeout: WAIT_MS * 2 });
  await moduleOff.waitFor({ state: 'hidden', timeout: WAIT_MS });
  console.log('OK: карточка выключенного модуля — лист «Модуль выключен», «Включить» выполняет действие');

  // ── Телефон ───────────────────────────────────────────────────────────────
  const phone = await browser.newContext({ viewport: { width: 390, height: 800 }, hasTouch: true, isMobile: true });
  sessions.phone = await preparePage(phone, `modules-bob-${suffix}@local`, PASSWORD);
  const mobile = sessions.phone.page;
  const RIBBON = 'body';
  const ribbon = mobile.locator('nav[data-modules]');
  await ribbon.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await expectModules(mobile, RIBBON, ['chats', 'plan', 'health', 'files', 'profile'], 'состав ленты');
  // Пять модулей: лента не прокручивается, стрелок нет, значки делят ширину
  assert.equal(await ribbon.getByRole('button', { name: 'Scroll right' }).count(), 0, 'у пяти модулей есть стрелки');
  const widths = await ribbon.locator('[data-module]').evaluateAll((items) => items.map((item) => Math.round(item.getBoundingClientRect().width)));
  assert(Math.max(...widths) - Math.min(...widths) <= 1, `значки разной ширины: ${widths}`);
  assert(Math.abs(widths.reduce((sum, width) => sum + width, 0) - 390) <= 2, `лента не во всю ширину: ${widths}`);
  console.log('OK: лента из пяти модулей делит ширину');

  const add = mobile.locator('[data-add-for]');
  assert.equal(await add.getAttribute('data-add-for'), 'chats');
  const addBox = await add.boundingBox();
  const ribbonBox = await ribbon.boundingBox();
  assert(addBox.y + addBox.height <= ribbonBox.y, '«+» перекрывает ленту');
  assert.equal(await add.getAttribute('aria-label'), 'Add record');
  await add.click();
  await mobile.getByRole('menuitem', { name: 'New Group' }).waitFor({ state: 'visible', timeout: WAIT_MS });
  // Открытое меню: на кнопке «×» «Close menu», нажатие закрывает меню
  await mobile.getByRole('button', { name: 'Close menu' }).click();
  await mobile.waitForFunction(() => !document.querySelector('.Menu .backdrop'), undefined, { timeout: WAIT_MS });
  assert.equal(await add.getAttribute('aria-label'), 'Add record', '«×» не вернулась в «+»');
  console.log('OK: «+» над лентой, в «Чатах» — меню, «×» его закрывает');

  await ribbon.locator('[data-module="files"]').click();
  await mobile.locator('[data-add-for="files"]').click();
  await mobile.getByRole('menuitem', { name: 'New folder' }).waitFor({ state: 'visible', timeout: WAIT_MS });
  await closeAddMenu(mobile);
  await ribbon.locator('[data-module="profile"]').click();
  await mobile.locator('[data-add-for]').waitFor({ state: 'detached', timeout: WAIT_MS });
  console.log('OK: в «Файлах» своё меню, в «Профиле» кнопки нет');

  // Перетаскивание касанием (доска `XpStart`): «Файлы» за ручку выше «Плана» — лента меняется по ходу
  await mobile.getByText('Modules', { exact: true }).first().click();
  await mobile.getByText('Hold the handle and drag. The ribbon below changes at once.')
    .waitFor({ state: 'visible', timeout: WAIT_MS });
  const filesHandle = mobile.getByRole('button', { name: 'Drag: Files' });
  const touchFrom = centerOf(await filesHandle.boundingBox());
  const phonePlanBox = await mobile.locator('[data-module-row="plan"] > [data-module="plan"]').boundingBox();
  await touchDrag(mobile, touchFrom, { x: touchFrom.x, y: phonePlanBox.y + 6 }, async () => {
    await expectModules(mobile, RIBBON, ['chats', 'files', 'plan', 'health', 'profile'], 'лента не меняется по ходу касания');
    await mobile.locator('[data-module-trace]').waitFor({ state: 'visible', timeout: WAIT_MS });
  });
  await mobile.locator('[data-module-trace]').waitFor({ state: 'detached', timeout: WAIT_MS });
  await expectModules(mobile, RIBBON, ['chats', 'files', 'plan', 'health', 'profile'], 'касание не переставило модуль');
  console.log('OK: модуль перетаскивается касанием, лента меняется сразу');

}

// Часть «всё включено»: семь модулей, стрелки ленты, «+» «Плана», узкое окно компьютера (доски `Main`, `Ribbon`,
// `PlusModes`, `RdNarrow`)
async function runAllPart(suffix) {
  // ── Телефон: лента из семи модулей прокручивается, стрелки в полях, у края — приглушённая ───────────────
  const phone = await browser.newContext({ viewport: { width: 390, height: 800 }, hasTouch: true, isMobile: true });
  sessions.phone = await preparePage(phone, `modules-all-carol-${suffix}@local`, PASSWORD);
  const mobile = sessions.phone.page;
  const ribbon = mobile.locator('nav[data-modules]');
  await ribbon.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await expectModules(mobile, 'body', ['chats', 'plan', 'health', 'notes', 'files', 'music', 'profile'], 'семь модулей');
  const back = ribbon.getByRole('button', { name: 'Scroll left' });
  const forward = ribbon.getByRole('button', { name: 'Scroll right' });
  assert.equal(await back.isDisabled(), true, 'у левого края стрелка назад активна');
  assert.equal(await forward.isDisabled(), false, 'стрелки вперёд нет');
  const itemWidth = Math.round((await ribbon.locator('[data-module="chats"]').boundingBox()).width);
  assert.equal(itemWidth, 60, `ширина значка прокручиваемой ленты ${itemWidth}`);
  // Подпись открытого модуля — `--pv-at`, значок — `--pv-accent` (доска `Main`)
  const colors = await mobile.evaluate(() => {
    const item = document.querySelector('nav[data-modules] [aria-current="page"]');
    const probe = (name) => {
      const el = document.createElement('span');
      el.style.color = `var(${name})`;
      item.appendChild(el);
      const value = getComputedStyle(el).color;
      el.remove();
      return value;
    };
    return {
      text: getComputedStyle(item.querySelector('span')).color,
      icon: getComputedStyle(item.querySelector('svg')).color,
      at: probe('--pv-at'),
      accent: probe('--pv-accent'),
    };
  });
  assert.equal(colors.text, colors.at, `подпись открытого модуля ${JSON.stringify(colors)}`);
  assert.equal(colors.icon, colors.accent, `значок открытого модуля ${JSON.stringify(colors)}`);
  await forward.click();
  await back.waitFor({ state: 'visible', timeout: WAIT_MS });
  await mobile.waitForFunction(() => !document.querySelector('nav[data-modules] button[aria-label="Scroll left"]').disabled,
    undefined, { timeout: WAIT_MS });
  // Открытый модуль всегда виден: «Профиль» с края ленты прокручивает её к себе
  await ribbon.locator('[data-module="profile"]').click();
  await mobile.waitForFunction(() => {
    const nav = document.querySelector('nav[data-modules]').getBoundingClientRect();
    const item = document.querySelector('nav[data-modules] [data-module="profile"]').getBoundingClientRect();
    return item.left >= nav.left && item.right <= nav.right + 1;
  }, undefined, { timeout: WAIT_MS });
  console.log('OK: лента из семи модулей — стрелки «Scroll left/right», приглушённая у края, открытый модуль виден');

  // «+» «Плана» на телефоне — окно ввода текстом
  await ribbon.locator('[data-module="plan"]').click();
  await mobile.locator('[data-add-for="plan"]').click();
  await mobile.locator('#planner-quick-input').waitFor({ state: 'visible', timeout: WAIT_MS });
  await mobile.keyboard.press('Escape');
  await mobile.locator('#planner-quick-input').waitFor({ state: 'hidden', timeout: WAIT_MS });
  console.log('OK: «+» «Плана» на телефоне открывает ввод записи');

  // ── Компьютер: «Запись в план» из меню «+» «Чатов»; узкое окно 540 px — панель значков, одна колонка ─────
  const desktop = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  sessions.desktop = await preparePage(desktop, `modules-all-dan-${suffix}@local`, PASSWORD);
  const { page } = sessions.desktop;
  const SIDE = '#FoldersSidebar';
  await expectModules(page, SIDE, ['chats', 'plan', 'health', 'notes', 'files', 'music', 'profile'], 'семь модулей в панели');
  await page.locator(`${SIDE} [data-add-for="chats"]`).click();
  await page.getByRole('menuitem', { name: 'Planner entry' }).click();
  await page.locator('#planner-quick-input').waitFor({ state: 'visible', timeout: WAIT_MS });
  await page.keyboard.press('Escape');
  await page.locator('#planner-quick-input').waitFor({ state: 'hidden', timeout: WAIT_MS });
  console.log('OK: «Запись в план» из меню «+» открывает ввод записи');

  // Чат «Избранное» с сообщением — чтобы в списке узкого окна было что открыть
  await openSavedMessages(page);
  await page.locator('#editable-message-text').click();
  await page.keyboard.type(`узкое окно ${suffix}`);
  await page.keyboard.press('Enter');
  await findMessageContainers(page, `узкое окно ${suffix}`).first().waitFor({ state: 'visible', timeout: WAIT_MS });

  await page.setViewportSize({ width: 540, height: 700 });
  const rail = page.locator(SIDE);
  await page.waitForFunction(() => {
    const box = document.querySelector('#FoldersSidebar')?.getBoundingClientRect();
    return box && Math.abs(box.width - 56) <= 1 && box.left === 0;
  }, undefined, { timeout: WAIT_MS });
  assert.equal(await page.locator('nav[data-modules]').count(), 0, 'в узком окне осталась нижняя лента');
  assert.equal(await rail.getByRole('tab', { name: 'Notes' }).getAttribute('title'), 'Notes', 'у значка нет подсказки');
  const tabBox = await rail.getByRole('tab', { name: 'Notes' }).boundingBox();
  assert.ok(Math.abs(tabBox.width - 44) <= 1 && Math.abs(tabBox.height - 44) <= 1, `значок узкой панели ${JSON.stringify(tabBox)}`);
  const plusBox = await rail.locator('[data-add-for]').boundingBox();
  assert.ok(Math.abs(plusBox.width - 44) <= 1 && Math.abs(plusBox.height - 40) <= 1, `«+» узкой панели ${JSON.stringify(plusBox)}`);
  const inViewport = (selector) => page.evaluate((sel) => {
    const box = document.querySelector(sel)?.getBoundingClientRect();
    return Boolean(box) && box.width > 0 && box.left >= 55 && box.left < window.innerWidth - 10;
  }, selector);
  await rail.getByRole('tab', { name: 'Chats' }).click();
  await page.waitForFunction(() => {
    const box = document.querySelector('#LeftColumn')?.getBoundingClientRect();
    return box && Math.abs(box.left - 56) <= 1 && Math.abs(box.right - window.innerWidth) <= 1;
  }, undefined, { timeout: WAIT_MS });
  // Список → чат во всю ширину → «Назад» к списку
  await page.locator('#LeftColumn .chat-list .ListItem').first().click();
  await page.waitForFunction(() => {
    const box = document.querySelector('#MiddleColumn')?.getBoundingClientRect();
    return box && Math.abs(box.left - 56) <= 1 && Math.abs(box.right - window.innerWidth) <= 1;
  }, undefined, { timeout: WAIT_MS });
  await page.locator('#MiddleColumn .MiddleHeader').getByRole('button', { name: 'Back' }).click();
  await page.waitForFunction(() => {
    const box = document.querySelector('#LeftColumn')?.getBoundingClientRect();
    return box && Math.abs(box.left - 56) <= 1;
  }, undefined, { timeout: WAIT_MS });
  // «Заметки»: список → заметка во всю ширину → «Назад» к списку
  await rail.getByRole('tab', { name: 'Notes' }).click();
  const knowledge = page.locator('#ParvaneKnowledge');
  await knowledge.locator('[data-note-row]').first().waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  assert.ok(await inViewport('#ParvaneKnowledge'), 'модуль заходит под узкую панель');
  await knowledge.locator('[data-note-row]').first().click();
  const backToNotes = knowledge.getByRole('button', { name: 'Back to notes' });
  await backToNotes.waitFor({ state: 'visible', timeout: WAIT_MS });
  await backToNotes.click();
  await knowledge.locator('[data-note-row]').first().waitFor({ state: 'visible', timeout: WAIT_MS });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  assert.ok(overflow <= 1, `узкое окно шире экрана на ${overflow}px`);
  if (process.env.PARVANE_E2E_SHOT_DIR) await page.screenshot({ path: `${process.env.PARVANE_E2E_SHOT_DIR}/modules-narrow.png` });
  console.log('OK: узкое окно 540 px — панель 56 px значками, список → чат / заметка → «Назад»');
}

try {
  const suffix = `${Date.now()}-${process.pid}`;
  if (process.env.PARVANE_E2E_MODULES_PART === 'all') await runAllPart(suffix);
  else await runServerOffPart(suffix);

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
