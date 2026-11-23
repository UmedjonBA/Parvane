// Галерея «экран против доски» (сверка с макетом `local-workdirs/design-2026-11-17/parvane-design`): снимает
// экраны приложения в размерах макета — телефон 360×800, компьютер 1120×700, русский язык (`PARVANE_GALLERY_LANG=en` — английский), светлая тема — под
// именами кадров досок (`<Доска>-<номер>.png`, номера — как у `render_boards.mjs`). Ничего не утверждает, кроме
// того, что экраны открываются; шаг, который не удался, пишет WARN и снимок `<имя>-fail.png`. Данные — выдуманные.
// Запуск: PARVANE_E2E_SHOT_DIR=<каталог> [PARVANE_GALLERY=health,plan,…] scripts/run_web_gallery_e2e.sh
// Другая тема и схема: PARVANE_GALLERY_THEME=dark, PARVANE_GALLERY_SCHEME=nord (gruvbox, telegram, nord, catppuccin,
// solarized)
import { chromium } from '../web/telegram-tt/node_modules/playwright/index.mjs';

import {
  buildPngBuffer,
  createGroupViaUi,
  dismissRecoveryKeyDialog,
  LOGIN_TIMEOUT_MS,
  openHealthModule,
  openPlannerScreen,
  openPrivateChatStrict,
  openSavedMessages,
  preparePage,
  reloadPage,
  sendText,
} from './e2e_web_helpers.mjs';

const PASSWORD = 'Parvane-gallery-e2e-1';
const PHONE = { width: 360, height: 800 };
const DESK = { width: 1120, height: 700 };
const NARROW = { width: 540, height: 700 };
const STEP_TIMEOUT_MS = 15000;
const dir = process.env.PARVANE_E2E_SHOT_DIR;
const only = (process.env.PARVANE_GALLERY || '').split(',').filter(Boolean);
const wants = (name) => !only.length || only.includes(name);
// `PARVANE_GALLERY_LANG=en` — снимки на английском (основной язык продукта): переключение на русский пропускается,
// подписи для поиска элементов берутся английские
const IS_EN = process.env.PARVANE_GALLERY_LANG === 'en';
const t = (ru, en) => (IS_EN ? en : ru);

// Тема и цветовая схема снимков: по умолчанию светлая Gruvbox, как у досок макета
const THEME = process.env.PARVANE_GALLERY_THEME || 'light';
const SCHEME = process.env.PARVANE_GALLERY_SCHEME || '';

const browser = await chromium.launch();

async function newGalleryContext(options) {
  const context = await browser.newContext({ ...options, colorScheme: THEME });
  if (SCHEME) {
    await context.addInitScript((scheme) => {
      try { localStorage.setItem('parvane:color-scheme', scheme); } catch { /* хранилище недоступно */ }
    }, SCHEME);
  }
  return context;
}
let failed = 0;

async function snap(page, name) {
  await page.waitForTimeout(700);
  if (dir) await page.screenshot({ path: `${dir}/${name}.png` });
}

// Шаг галереи: действие, затем снимок под именем кадра доски
async function step(page, name, action) {
  try {
    await action();
    await snap(page, name);
  } catch (err) {
    failed += 1;
    console.log(`WARN: ${name}: ${String(err).split('\n').slice(0, 3).join(' | ')}`);
    await snap(page, `${name}-fail`).catch(() => undefined);
    await page.keyboard.press('Escape').catch(() => undefined);
  }
}

// Сессия заводится на английском (хелперы ищут английские подписи), затем ставится язык «как в системе» (язык
// браузера с этой меткой — русский) и страница перезагружается: снимки — на русском, переходы — по атрибутам `data-*`
async function openSession(tag, contextOptions = {}) {
  const context = await newGalleryContext({ viewport: DESK, ...contextOptions });
  // Язык браузера становится русским вместе с меткой «как в системе»: до неё вход идёт на английском
  await context.addInitScript(() => {
    if (localStorage.getItem('parvane:language-system') !== '1') return;
    Object.defineProperty(navigator, 'language', { get: () => 'ru-RU' });
    Object.defineProperty(navigator, 'languages', { get: () => ['ru-RU', 'ru'] });
  });
  const user = `gallery-${tag}-${Date.now().toString(36)}@local`;
  const session = await preparePage(context, user, PASSWORD);
  await dismissRecoveryKeyDialog(session.page).catch(() => undefined);
  return { ...session, user };
}

async function toRussian(page) {
  if (!IS_EN) await page.evaluate(() => localStorage.setItem('parvane:language-system', '1'));
  await reloadPage(page);
  await page.locator('#LeftColumn, #Main').first().waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await page.locator('html[lang="ru"]').waitFor({ state: 'attached', timeout: LOGIN_TIMEOUT_MS }).catch(() => undefined);
}

async function resize(page, size) {
  await page.setViewportSize(size);
  await page.waitForTimeout(800);
}

// Модуль по имени из панели компьютера либо ленты телефона — по `data-module`, без подписей
async function openModule(page, module, rootId) {
  await page.locator(`[data-module="${module}"]:visible`).first().click();
  const root = page.locator(`#${rootId}`);
  await root.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  return root;
}

// ── «Здоровье»: доски Health, HealthSleep, HealthWeight, RpHealth, XpHealth, ZpHealthX, DeskHealth,
//    DeskHealthDetail, RdHealth, XdHealth, ZdHealthX ───────────────────────────────────────────────
async function galleryHealth() {
  const { page } = await openSession('health');
  let health = await openHealthModule(page);
  await health.locator('[data-health-first]').waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  if (!IS_EN) await page.evaluate(() => localStorage.setItem('parvane:language-system', '1'));
  await reloadPage(page);
  health = await openModule(page, 'health', 'ParvaneHealth');
  await health.locator('[data-health-first]').waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await step(page, 'ZdHealthX-01', async () => undefined);
  await resize(page, PHONE);
  await step(page, 'ZpHealthX-01', async () => undefined);
  await resize(page, DESK);

  // Записи за несколько дней — строкой ввода, как это делает человек
  const input = health.locator('[data-health-quick] input');
  const lines = [
    'позавчера в 7:30 вес 72,6', 'вчера в 7:15 вес 72,3', 'в 7:20 вес 72',
    'позавчера спал с 0:05 до 7:10', 'вчера спал с 0:30 до 8:50', 'спал с 0:10 до 7:05',
    'позавчера давление 122 на 82 пульс 63', 'вчера вечером давление 120 на 80 пульс 72', 'пульс 64',
    'позавчера 8000 шагов', 'вчера 4300 шагов', '8400 шагов',
    'позавчера самочувствие 4', 'вчера самочувствие 2', 'самочувствие 3',
  ];
  for (const line of lines) {
    await input.fill(line);
    await health.locator('[data-health-preview] [data-kind]').first()
      .waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS }).catch(() => console.log(`WARN: не понято: ${line}`));
    await input.press('Enter');
    await page.waitForTimeout(500);
  }
  await health.locator('[data-health-card="weight"]').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });

  const card = (kind) => health.locator(`[data-health-card="${kind}"]`).first();
  // К сводке: на компьютере — «‹ Сводка» колонки, на телефоне — стрелка шапки, пока она есть
  const toSummary = async () => {
    for (let attempt = 0; attempt < 3; attempt++) {
      const back = health.locator(`[data-health-side-back]:visible, header button[aria-label="${t('Назад', 'Back')}"]:visible`).first();
      if (!(await back.isVisible().catch(() => false))) return;
      await back.click().catch(() => undefined);
      await page.waitForTimeout(500);
    }
  };
  const detail = async (name, kind) => {
    await toSummary();
    await step(page, name, async () => { await card(kind).click({ timeout: STEP_TIMEOUT_MS }); });
  };
  // Цель — окном по карандашу подробного экрана
  const setGoal = async (kind, values) => {
    try {
      await toSummary();
      await card('weight').click({ timeout: STEP_TIMEOUT_MS });
      await health.locator(`[data-health-side-item="${kind}"]`).click({ timeout: STEP_TIMEOUT_MS });
      await health.locator(`[data-health-goal-edit="${kind}"]:visible`).first().click({ timeout: STEP_TIMEOUT_MS });
      for (const [field, value] of Object.entries(values)) {
        await page.locator(`[data-health-sheet="goal"] [data-health-goal="${field}"]`).fill(value);
      }
      await page.locator('[data-health-goal-save]').click();
      await page.locator('[data-health-sheet="goal"]').waitFor({ state: 'hidden', timeout: STEP_TIMEOUT_MS });
    } catch (err) {
      console.log(`WARN: цель ${kind}: ${String(err).split('\n').slice(0, 4).join(' | ')}`);
      await page.keyboard.press('Escape').catch(() => undefined);
    }
  };
  await input.fill('');
  await page.waitForTimeout(1500);
  await setGoal('weight', { weight: '70' });
  await setGoal('steps', { steps: '10000' });
  await setGoal('sleep', { sleep_bed: '23:30', sleep_wake: '07:00' });
  await toSummary();

  // Компьютер: подробные экраны — пунктами левой колонки, период — «Месяц», как на досках
  await step(page, 'DeskHealth-01', async () => undefined);
  await card('weight').click({ timeout: STEP_TIMEOUT_MS }).catch(() => undefined);
  const side = async (name, kind, period) => {
    await step(page, name, async () => {
      await health.locator(`[data-health-side-item="${kind}"]`).click({ timeout: STEP_TIMEOUT_MS });
      if (period) await health.locator(`[data-health-period="${period}"]`).click({ timeout: STEP_TIMEOUT_MS });
    });
  };
  await side('DeskHealthDetail-01', 'sleep', 'month');
  await side('RdHealth-01', 'pressure', 'month');
  await side('RdHealth-02', 'steps', 'month');
  await side('health-desk-weight', 'weight', 'month');
  await side('health-desk-mood', 'mood');
  await health.locator('[data-health-period="week"]').click({ timeout: STEP_TIMEOUT_MS }).catch(() => undefined);
  await toSummary();

  // Телефон
  await resize(page, PHONE);
  await toSummary();
  await step(page, 'Health-01', async () => undefined);
  await detail('HealthSleep-01', 'sleep');
  await detail('HealthWeight-01', 'weight');
  await detail('RpHealth-01', 'pulse');
  await detail('RpHealth-02', 'steps');
  await detail('XpHealth-01', 'pressure');
  await detail('XpHealth-03', 'mood');
  await page.context().close();
}

// ── «План»: доски PhonePlan, PhPlanMore, RpPlan, XpPlan, ZpPlanX, DeskPlan, DkPlanMore, RdPlan, XdPlan, ZdPlanX ──
async function galleryPlan() {
  const { page } = await openSession('plan');
  const planner = await openPlannerScreen(page, 'calendar');
  const quick = page.locator('#planner-quick-input');
  const lines = [
    'План на неделю сегодня 10:00 1 ч', 'Зал сегодня 18:00 1 ч 30 мин каждую неделю', 'Ответить Алие про конфиг 30 мин',
    'Созвон с командой завтра 10:00 1 ч', 'Обновление сервера послезавтра 14:00 2 ч', 'Разобрать входящие 30 мин',
    'Продлить домен через 3 дня 9:00 1 ч', 'Обновить nftables 1 ч',
  ];
  for (const line of lines) {
    try {
      await planner.getByRole('button', { name: '+ Entry', exact: true }).click({ timeout: STEP_TIMEOUT_MS });
      await quick.waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
      await quick.fill(line);
      await page.waitForTimeout(600);
      await quick.press('Enter');
      await quick.waitFor({ state: 'hidden', timeout: STEP_TIMEOUT_MS });
    } catch (err) {
      console.log(`WARN: запись «${line}»: ${String(err).split('\n')[0]}`);
      await page.keyboard.press('Escape').catch(() => undefined);
    }
  }
  await toRussian(page);
  const plan = await openModule(page, 'plan', 'ParvanePlanner');
  const view = async (name, value) => {
    await step(page, name, async () => {
      await plan.locator(`button[data-value="${value}"]:visible`).first().click({ timeout: STEP_TIMEOUT_MS });
    });
  };
  // Компьютер
  for (const value of ['today', 'week', 'month', 'year', 'agenda']) await view(`plan-desk-${value}`, value);
  await step(page, 'plan-desk-tasks', async () => {
    await plan.locator('[data-planner-tasks-open]').click({ timeout: STEP_TIMEOUT_MS });
  });
  await page.keyboard.press('Escape');
  await step(page, 'plan-desk-search', async () => {
    await plan.locator('[data-planner-search-open]').click({ timeout: STEP_TIMEOUT_MS });
    await plan.locator('[data-planner-search-input]').fill('зал');
  });
  await page.keyboard.press('Escape');
  // Компьютер: редактор записи, импорт расписания текстом, настройки (доски `DkPlanMore`, `XdPlan`, `RdPlanSet`)
  await step(page, 'DkPlanMore-01', async () => {
    await plan.locator('button[data-value="today"]:visible').first().click({ timeout: STEP_TIMEOUT_MS });
    await plan.getByText('Зал', { exact: true }).first().click({ timeout: STEP_TIMEOUT_MS });
    await page.waitForTimeout(1000);
  });
  await plan.getByRole('button', { name: t('Закрыть', 'Close') }).first().click({ timeout: 3000 }).catch(() => undefined);
  // «Расписание на неделю» — пункт колонки разделов экрана «Задачи» (доска `XdPlan`)
  await step(page, 'XdPlan-02', async () => {
    await plan.locator('[data-planner-tasks-open]').click({ timeout: STEP_TIMEOUT_MS });
    await plan.locator('[data-planner-sections]').getByText(t('Расписание на неделю', 'Weekly schedule'), { exact: true })
      .click({ timeout: STEP_TIMEOUT_MS });
    await page.locator('[data-planner-import] textarea').fill([
      'пн 10:00-11:00 созвон с командой', 'вт 14:00-16:00 обновление сервера', 'ср 18:30-20:00 зал', 'чт вечер ???',
      'пт 11:00-12:00 созвон с командой', 'вс 18:00-19:30 зал', 'до 31 декабря',
    ].join('\n'));
    await page.waitForTimeout(1500);
  });
  await page.getByRole('button', { name: t('Отмена', 'Cancel') }).first().click({ timeout: 3000 }).catch(() => undefined);
  await page.keyboard.press('Escape');
  // Настройки — страница «Профиль → Модули / План» (шестерёнка «Плана»)
  await step(page, 'RdPlanSet-01', async () => {
    await plan.locator('button[data-value="today"]:visible').first().click({ timeout: 3000 }).catch(() => undefined);
    await plan.getByRole('button', { name: t('Настройки плана', 'Plan settings') }).first().click({ timeout: STEP_TIMEOUT_MS });
    await page.locator('[data-planner-settings]').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  });
  await openModule(page, 'plan', 'ParvanePlanner');

  // Телефон
  await resize(page, PHONE);
  await view('PhonePlan-01', 'today');
  await view('XpPlan-01', 'week');
  await view('PhPlanMore-01', 'month');
  // «Год», «Список», поиск и «Задачи» на телефоне — пункты меню «⋯» шапки
  const more = async (key) => {
    await plan.locator('[data-planner-more]').click({ timeout: STEP_TIMEOUT_MS });
    await page.locator(`[role="menuitem"][data-action="${key}"]`).click({ timeout: STEP_TIMEOUT_MS });
  };
  await step(page, 'XpPlan-02', () => more('year'));
  await plan.locator(`button[aria-label="${t('Назад', 'Back')}"]:visible`).first().click().catch(() => undefined);
  await step(page, 'RpPlan-01', () => more('agenda'));
  await step(page, 'RpPlan-02', async () => {
    await more('search');
    await plan.locator('[data-planner-search-input]').fill('зал');
  });
  await page.keyboard.press('Escape');
  await step(page, 'PhPlanMore-03', () => more('tasks'));
  await page.keyboard.press('Escape');
  await plan.locator(`button[aria-label="${t('Назад', 'Back')}"]:visible`).first().click({ timeout: 3000 }).catch(() => undefined);
  await step(page, 'RpPlan-03', async () => {
    await more('settings');
    await page.locator('[data-planner-settings]').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  });
  await page.context().close();
}

// ── «Заметки»: доски Notes, PhNotesMore, RpNotes, XpNotes, ZpNotesX, DeskNotes, XdNotes, ZdNotesX ──
// Новое хранилище само получает папку справки из связанных заметок — на ней и снимаются список, заметка и граф;
// язык ставится до первого открытия модуля, чтобы справка была русской
async function galleryNotes() {
  const { page } = await openSession('notes');
  await toRussian(page);
  const notes = await openModule(page, 'notes', 'ParvaneKnowledge');
  await notes.locator('[data-note-row]').first().waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await page.waitForTimeout(3000);
  const tab = (index) => notes.locator('[role="tablist"]').first().locator('[role="tab"]').nth(index);

  // Компьютер
  await step(page, 'notes-desk-list', async () => undefined);
  await step(page, 'notes-desk-graph', async () => { await tab(1).click({ timeout: STEP_TIMEOUT_MS }); });
  await step(page, 'notes-desk-canvas', async () => {
    await notes.locator('[data-notes-place="canvas"]').click({ timeout: STEP_TIMEOUT_MS });
  });
  await notes.locator('[data-notes-all]').click({ timeout: STEP_TIMEOUT_MS }).catch(() => undefined);
  await tab(0).click({ timeout: STEP_TIMEOUT_MS }).catch(() => undefined);
  await step(page, 'notes-desk-note', async () => {
    await notes.locator('[data-note-row]').first().click({ timeout: STEP_TIMEOUT_MS });
  });

  // Телефон
  await resize(page, PHONE);
  // К списку: стрелка «К заметкам», пока список папок не показан (первое нажатие может лишь закрыть правку)
  const back = async () => {
    for (let attempt = 0; attempt < 3; attempt++) {
      if (await notes.locator('[data-notes-folders]').first().isVisible().catch(() => false)) return;
      await notes.getByRole('button', { name: t('К заметкам', 'Back to notes') }).first().click({ timeout: 5000 }).catch(() => undefined);
      await page.waitForTimeout(700);
    }
  };
  await step(page, 'PhNotesMore-02', async () => undefined);
  await step(page, 'PhNotesMore-03', async () => {
    await notes.getByRole('button', { name: t('Изменить', 'Edit') }).first().click({ timeout: STEP_TIMEOUT_MS });
  });
  await notes.getByRole('button', { name: t('Готово', 'Save') }).first().click({ timeout: 5000 }).catch(() => undefined);
  // Меню заметки и «Перенести в папку» на телефоне (доска `ZpNotesX-02`)
  await step(page, 'notes-phone-note-menu', async () => {
    await notes.locator('[data-note-menu]:visible').first().click({ timeout: STEP_TIMEOUT_MS });
    await page.waitForTimeout(700);
  });
  await step(page, 'ZpNotesX-02', async () => {
    await page.locator(`[role="menu"] >> text=/^${t('Перенести', 'Move to')}/`).first().click({ timeout: STEP_TIMEOUT_MS });
    await page.waitForTimeout(1000);
  });
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  await back();
  await step(page, 'PhNotesMore-01', async () => undefined);
  await step(page, 'XpNotes-01', async () => { await tab(1).click({ timeout: STEP_TIMEOUT_MS }); });
  await step(page, 'RpNotes-01', async () => { await tab(2).click({ timeout: STEP_TIMEOUT_MS }); });
  await page.context().close();
}

// ── «Файлы»: доски PhoneFiles, PhFilesMore, RpFiles, XpFiles, ZpFilesX, DeskFiles, DkFilesDialogs, RdFiles,
//    XdFiles, ZdFilesX ──
async function galleryFiles() {
  // Гость — получатель приглашения в общую папку (доски `RpFiles-02`, `ZdFilesX-01`)
  const guest = await openSession('filesb');
  await toRussian(guest.page);
  const { page } = await openSession('files');
  const cloud = await openModule(page, 'files', 'ParvaneCloud');
  const item = (name) => cloud.locator(`[data-node-id][data-name="${name}"]`);
  await cloud.locator('input[type="file"]').waitFor({ state: 'attached', timeout: LOGIN_TIMEOUT_MS });
  for (const name of ['Конфиги', 'Резервные копии', 'Сборки']) {
    try {
      await cloud.getByRole('button', { name: 'New folder', exact: true }).click({ timeout: STEP_TIMEOUT_MS });
      await page.locator('#parvane-cloud-name').fill(name);
      await page.getByRole('button', { name: 'Create', exact: true }).click();
      await item(name).waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
    } catch (err) {
      console.log(`WARN: папка «${name}»: ${String(err).split('\n')[0]}`);
      await page.keyboard.press('Escape').catch(() => undefined);
    }
  }
  const files = [
    ['backup-2026-11.tar.zst', 300000], ['wg0.conf', 412], ['nftables.conf', 2100], ['parvane-android-arm64.apk', 48000],
  ].map(([name, size]) => ({ name, mimeType: 'application/octet-stream', buffer: Buffer.alloc(size, 7) }));
  files.push({ name: 'схема-сети.png', mimeType: 'image/png', buffer: buildPngBuffer(96, [0x2a, 0x2a, 0x2a]) });
  await cloud.locator('input[type="file"]').first().setInputFiles(files);
  await item('wg0.conf').waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS }).catch(() => console.log('WARN: файлы не загрузились'));
  await cloud.locator('[data-transfer-kind="upload"][data-transfer-state="active"]').first()
    .waitFor({ state: 'detached', timeout: LOGIN_TIMEOUT_MS }).catch(() => undefined);
  await toRussian(page);
  const files2 = await openModule(page, 'files', 'ParvaneCloud');
  await files2.locator('[data-node-id][data-name="wg0.conf"]').waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await page.waitForTimeout(1500);

  // Компьютер
  await step(page, 'files-desk-root', async () => undefined);
  await step(page, 'files-desk-file', async () => {
    await files2.locator('[data-node-id][data-name="wg0.conf"]').click({ timeout: STEP_TIMEOUT_MS });
  });
  await page.keyboard.press('Escape');
  const row = (name) => files2.locator(`[data-node-id][data-name="${name}"]`);
  const deskMenu = async (name, action) => {
    await row(name).click({ button: 'right', timeout: STEP_TIMEOUT_MS });
    await page.getByRole('menuitem', { name: action }).first().click({ timeout: STEP_TIMEOUT_MS });
    await page.waitForTimeout(800);
  };
  await step(page, 'ZdFilesX-03', async () => { await row('wg0.conf').click({ button: 'right', timeout: STEP_TIMEOUT_MS }); });
  await page.keyboard.press('Escape');
  await step(page, 'XdFiles-01', async () => {
    await row('схема-сети.png').dblclick({ timeout: STEP_TIMEOUT_MS });
    await page.locator('[data-preview-kind="photo"] img').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  });
  await page.keyboard.press('Escape');
  await step(page, 'XdFiles-02', async () => {
    for (const name of ['backup-2026-11.tar.zst', 'nftables.conf', 'wg0.conf']) {
      await row(name).hover();
      await row(name).getByRole('checkbox').click({ timeout: STEP_TIMEOUT_MS });
    }
  });
  await page.keyboard.press('Escape');
  await files2.getByRole('button', { name: t('Снять выделение', 'Clear selection') }).click({ timeout: 2000 }).catch(() => undefined);
  await step(page, 'ZdFilesX-05', async () => { await deskMenu('wg0.conf', IS_EN ? /^Move/ : /^Переместить/); });
  await page.keyboard.press('Escape');
  await step(page, 'ZdFilesX-04', async () => {
    // Выбранный файл снимается нажатием на место «Мой диск»: с открытой панелью файла «Новой папки» в шапке нет
    await files2.locator('[data-nav-place="drive"]').click({ timeout: STEP_TIMEOUT_MS });
    await files2.getByRole('button', { name: t('Новая папка', 'New folder'), exact: true }).click({ timeout: STEP_TIMEOUT_MS });
    await page.locator('#parvane-cloud-name').fill('Сборки');
    await page.locator('.Modal.open').getByRole('button', { name: t('Создать', 'Create'), exact: true }).click();
  });
  await page.keyboard.press('Escape');
  let linkUrl;
  await step(page, 'DkFilesDialogs-01', async () => {
    await deskMenu('backup-2026-11.tar.zst', IS_EN ? /^Link/ : /^Ссылка/);
    const url = page.locator('[data-cloud-link-sheet] [data-link-url]');
    await url.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
    linkUrl = await url.getAttribute('data-link-url');
  });
  await page.keyboard.press('Escape');
  // Страница получателя ссылки — в чистом браузере без аккаунта (доска `RpFiles-03`)
  if (linkUrl) {
    const visitor = await newGalleryContext({ viewport: PHONE, locale: t('ru-RU', 'en-US') });
    // Адрес gateway стенда: публичная страница читает его только в диагностической сборке
    await visitor.addInitScript((gatewayUrl) => {
      localStorage.setItem('parvane:gateway', gatewayUrl);
    }, process.env.PARVANE_E2E_GATEWAY_URL);
    const linkPage = await visitor.newPage();
    await step(linkPage, 'RpFiles-03', async () => {
      await linkPage.goto(linkUrl);
      await linkPage.locator('[data-link-page][data-state="ready"], [data-link-name]').first()
        .waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
    });
    await resize(linkPage, DESK);
    await step(linkPage, 'files-link-desk', async () => undefined);
    await visitor.close();
  }
  // Общая папка с приглашённым гостем: окно создания и окно доступа (доски `ZdFilesX`, `DkFilesDialogs-02`)
  await step(page, 'files-desk-new-shared', async () => {
    await files2.locator('[data-virtual="owned"]').click({ timeout: STEP_TIMEOUT_MS });
    await page.getByRole('button', { name: IS_EN ? /New shared folder/ : /Новая общая папка|Создать общую папку/ }).first().click({ timeout: STEP_TIMEOUT_MS });
    await page.locator('#parvane-cloud-shared-name').fill('Прошивки');
    await page.locator('[data-new-shared-nick] input').fill(`@${guest.user.split('@')[0]}`);
    await page.locator('[data-new-shared-nick] input').press('Enter');
    await page.locator('[data-new-invitee]').waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  });
  await step(page, 'DkFilesDialogs-02', async () => {
    await page.locator('[data-new-shared-create]').click({ timeout: STEP_TIMEOUT_MS });
    await page.locator('[data-invited]').first().waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  });
  await page.keyboard.press('Escape');
  await step(page, 'files-desk-owned', async () => undefined);
  await files2.locator('[data-nav-place="drive"]').click({ timeout: STEP_TIMEOUT_MS }).catch(() => undefined);
  // Гость: приглашение карточкой в «Доступных мне» на компьютере и телефоне
  const guestFiles = await openModule(guest.page, 'files', 'ParvaneCloud');
  await step(guest.page, 'ZdFilesX-01', async () => {
    await guestFiles.locator('[data-virtual="shared"]').click({ timeout: STEP_TIMEOUT_MS });
    await guestFiles.locator('[data-container-kind="invite"][data-name="Прошивки"]')
      .waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  });
  await resize(guest.page, PHONE);
  await step(guest.page, 'RpFiles-02', async () => undefined);
  await guest.page.context().close();

  // Идущая загрузка: строка передачи с полосой хода (доски `ZdFilesX`, `ZpFilesX`) — большой файл, кадр сразу
  const bigFile = (name) => ({ name, mimeType: 'application/octet-stream', buffer: Buffer.alloc(24_000_000, 5) });
  await step(page, 'files-desk-uploading', async () => {
    await files2.locator('input[type="file"]').first().setInputFiles([bigFile('видео-с-конференции.mkv')]);
    await files2.locator('[data-transfer-kind="upload"][data-transfer-state="active"]').first()
      .waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  });
  await files2.locator('[data-transfer-kind="upload"][data-transfer-state="active"]').first()
    .waitFor({ state: 'detached', timeout: LOGIN_TIMEOUT_MS }).catch(() => undefined);

  // Телефон
  await resize(page, PHONE);
  await step(page, 'files-phone-uploading', async () => {
    await files2.locator('input[type="file"]').first().setInputFiles([bigFile('сборка-ночная.tar')]);
    await files2.locator('[data-transfer-kind="upload"][data-transfer-state="active"]').first()
      .waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  });
  await files2.locator('[data-transfer-kind="upload"][data-transfer-state="active"]').first()
    .waitFor({ state: 'detached', timeout: LOGIN_TIMEOUT_MS }).catch(() => undefined);
  // С заниженным пределом диска (`PARVANE_E2E_CLOUD_DRIVE_QUOTA_BYTES`) вторая большая загрузка не помещается:
  // строка «не хватает … · Освободить место» (доски `ZdFilesX-02`, `ZpFilesX-03`)
  await step(page, 'files-phone-nospace', async () => { await page.waitForTimeout(1500); });
  await resize(page, DESK);
  await step(page, 'files-desk-nospace', async () => { await page.waitForTimeout(800); });
  await resize(page, PHONE);
  await step(page, 'PhoneFiles-01', async () => undefined);
  await step(page, 'files-phone-menu', async () => {
    await files2.locator('[data-node-id][data-name="wg0.conf"]').getByRole('button').last().click({ timeout: STEP_TIMEOUT_MS });
  });
  await page.keyboard.press('Escape');
  // Телефон: шторки и экраны (доски `PhFilesMore`, `RpFiles`, `XpFiles`, `ZpFilesX`) — пункт меню файла по названию
  const fileAction = async (name, action) => {
    await files2.locator(`[data-node-id][data-name="${name}"]`).getByRole('button').last().click({ timeout: STEP_TIMEOUT_MS });
    await page.getByText(action, { exact: true }).last().click({ timeout: STEP_TIMEOUT_MS });
    await page.waitForTimeout(800);
  };
  const filesChip = (label) => files2.getByText(label, { exact: true }).first();
  await step(page, 'PhFilesMore-01', async () => { await fileAction('backup-2026-11.tar.zst', t('Ссылка для всех', 'Link for everyone')); });
  await page.keyboard.press('Escape');
  await step(page, 'XpFiles-03', async () => {
    await row('схема-сети.png').click({ timeout: STEP_TIMEOUT_MS });
    await page.locator('[data-preview-kind="photo"] img').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  });
  await page.keyboard.press('Escape');
  await step(page, 'XpFiles-02', async () => { await fileAction('nftables.conf', t('Переместить', 'Move')); });
  await page.keyboard.press('Escape');
  await step(page, 'PhFilesMore-03', async () => {
    await fileAction('parvane-android-arm64.apk', t('В корзину', 'Move to trash'));
    await filesChip(t('Корзина', 'Trash')).click({ timeout: STEP_TIMEOUT_MS });
  });
  // Корзина, «Мои ссылки» — страницы с «назад»: к вкладкам возвращает стрелка
  const filesBack = () => files2.locator('[data-cloud-back]:visible').first().click({ timeout: 3000 }).catch(() => undefined);
  await step(page, 'RpFiles-01', async () => {
    await filesBack();
    await filesChip(t('Мои ссылки', 'My links')).click({ timeout: STEP_TIMEOUT_MS });
  });
  await step(page, 'files-phone-owned', async () => {
    await filesBack();
    await filesChip(t('Общие папки', 'Shared folders')).click({ timeout: STEP_TIMEOUT_MS });
  });
  await step(page, 'ZpFilesX-01', async () => {
    await page.getByRole('button', { name: IS_EN ? /New shared folder/ : /Новая общая папка|Создать общую папку/ }).first().click({ timeout: STEP_TIMEOUT_MS });
    await page.waitForTimeout(800);
  });
  // «Создать» создаёт папку и открывает её доступ (доска `PhFilesMore-02`)
  await step(page, 'PhFilesMore-02', async () => {
    await page.locator('#parvane-cloud-shared-name').fill('Сборки общие');
    await page.locator('[data-new-shared-create]').click({ timeout: STEP_TIMEOUT_MS });
    await page.waitForTimeout(2500);
  });
  await page.keyboard.press('Escape');
  await step(page, 'files-phone-owned-list', async () => { await page.waitForTimeout(500); });
  await step(page, 'ZpFilesX-02', async () => {
    await filesBack();
    await filesChip(t('Мой диск', 'My drive')).click({ timeout: STEP_TIMEOUT_MS });
    await files2.getByRole('button', { name: t('Поиск по файлам', 'Search files') }).first().click({ timeout: STEP_TIMEOUT_MS });
    await page.locator('#ParvaneCloud input[type="search"], #ParvaneCloud input[type="text"]').first().fill('conf');
  });
  await page.context().close();
}

// ── «Профиль» и настройки: доски PhoneProfile, PhProfileA/B, RpProfileA/B/C, XpProfile, ZdProfileX/Y,
//    DeskProfile, DkSettingsA/B, RdProfile, Modules ──
const PROFILE_ITEMS = [
  'overview', 'modules', 'appearance', 'notifications', 'language', 'devices', 'privacy', 'keys', 'data', 'export',
  'bug', 'about',
];

async function galleryProfile() {
  const { page } = await openSession('profile');
  await toRussian(page);
  const open = async () => {
    await page.locator('[data-module="profile"]:visible').first().click({ timeout: STEP_TIMEOUT_MS });
    await page.locator('[data-profile-item]:visible').first().waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  };
  await open();
  // Компьютер: разделы — пунктами левой колонки
  for (const id of PROFILE_ITEMS) {
    await step(page, `profile-desk-${id}`, async () => {
      await page.locator(`[data-profile-item="${id}"]:visible`).first().click({ timeout: STEP_TIMEOUT_MS });
    });
  }
  await page.locator('[data-profile-item="overview"]:visible').first().click({ timeout: 5000 }).catch(() => undefined);

  // Телефон: список разделов, каждый — своим экраном со стрелкой «назад»
  await resize(page, PHONE);
  await open().catch(() => undefined);
  await step(page, 'profile-phone-main', async () => undefined);
  for (const id of PROFILE_ITEMS.slice(1)) {
    await step(page, `profile-phone-${id}`, async () => {
      const item = page.locator(`[data-profile-item="${id}"]:visible`).first();
      await item.scrollIntoViewIfNeeded({ timeout: STEP_TIMEOUT_MS });
      await item.click({ timeout: STEP_TIMEOUT_MS });
    });
    for (let attempt = 0; attempt < 3; attempt++) {
      if (await page.locator('[data-profile-item="modules"]:visible').first().isVisible().catch(() => false)) break;
      await page.locator(`#Settings button[aria-label="${t('Назад', 'Back')}"]:visible, #Settings .Button.translucent:visible`).first()
        .click({ timeout: 3000 }).catch(() => undefined);
      await page.waitForTimeout(600);
    }
  }
  // Телефон: окна и экраны аккаунта (доски `XpProfile`, `RpProfileB`, `RpProfileC`)
  const backToList = async () => {
    for (let attempt = 0; attempt < 4; attempt++) {
      if (await page.locator('[data-profile-item="modules"]:visible').first().isVisible().catch(() => false)) break;
      await page.keyboard.press('Escape').catch(() => undefined);
      await page.waitForTimeout(500);
      if (await page.locator('[data-profile-item="modules"]:visible').first().isVisible().catch(() => false)) break;
      await page.locator(`#Settings button[aria-label="${t('Назад', 'Back')}"]:visible, #Settings .Button.translucent:visible`).first()
        .click({ timeout: 2000 }).catch(() => undefined);
      await page.waitForTimeout(600);
    }
  };
  const openItem = async (id) => {
    const item = page.locator(`[data-profile-item="${id}"]:visible`).first();
    await item.scrollIntoViewIfNeeded({ timeout: STEP_TIMEOUT_MS });
    await item.click({ timeout: STEP_TIMEOUT_MS });
  };
  await step(page, 'XpProfile-01', async () => {
    await page.locator('[data-profile-edit]:visible').first().click({ timeout: STEP_TIMEOUT_MS });
    await page.waitForTimeout(800);
  });
  await backToList();
  await step(page, 'RpProfileB-02', async () => {
    await openItem('devices');
    await page.locator('[data-account-row="password"]:visible').first().click({ timeout: STEP_TIMEOUT_MS });
    await page.waitForTimeout(800);
  });
  await page.keyboard.press('Escape');
  await step(page, 'XpProfile-02', async () => {
    const button = page.locator('[data-delete-account-open]:visible').first();
    await button.scrollIntoViewIfNeeded({ timeout: STEP_TIMEOUT_MS });
    await button.click({ timeout: STEP_TIMEOUT_MS });
    await page.waitForTimeout(800);
  });
  await backToList();
  await step(page, 'RpProfileC-01', async () => {
    await openItem('privacy');
    await page.locator('[data-privacy-row="key"]:visible').first().click({ timeout: STEP_TIMEOUT_MS });
    await page.waitForTimeout(800);
  });
  await page.context().close();
}

// ── Вход и регистрация: доски PhAuth, XpAuth, ZpAuthX, DkAuth, RdAuth, ZdAuthX — экраны до входа, без аккаунта ──
async function galleryAuth() {
  for (const [tag, size] of [['desk', DESK], ['phone', PHONE]]) {
    const context = await newGalleryContext({ viewport: size });
    await context.addInitScript(({ gatewayUrl, isEn }) => {
      localStorage.setItem('parvane:gateway', gatewayUrl);
      if (isEn) return;
      localStorage.setItem('parvane:language-system', '1');
      Object.defineProperty(navigator, 'language', { get: () => 'ru-RU' });
      Object.defineProperty(navigator, 'languages', { get: () => ['ru-RU', 'ru'] });
    }, { gatewayUrl: process.env.PARVANE_E2E_GATEWAY_URL, isEn: IS_EN });
    const page = await context.newPage();
    await page.goto(process.env.PARVANE_E2E_BASE_URL, { waitUntil: 'domcontentloaded' });
    await page.locator('[data-auth-submit]').first().waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
    await step(page, `auth-${tag}-login`, async () => undefined);
    await step(page, `auth-${tag}-register`, async () => {
      await page.locator('[data-auth-register]:visible').first().click({ timeout: STEP_TIMEOUT_MS });
    });
    await context.close();
  }
}

// ── Оболочка и чаты: доски Main, Ribbon, PlusModes, XpStart, DeskChats, Desktop, DeskOverlays, ZdNav ──
async function galleryShell() {
  const { page } = await openSession('shell');
  await openSavedMessages(page);
  await sendText(page, 'Пришли конфиг, гляну вечером');
  await toRussian(page);
  // Компьютер: список чатов без открытого чата, общий поиск, окно горячих клавиш
  await step(page, 'shell-desk-chats', async () => undefined);
  await step(page, 'shell-desk-palette', async () => {
    await page.keyboard.press('Control+k');
    await page.locator('[data-palette]').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
    await page.locator('[data-palette] input').first().fill('план');
  });
  await page.keyboard.press('Escape');
  await step(page, 'shell-desk-hotkeys', async () => {
    await page.keyboard.press('Control+/');
    await page.waitForTimeout(600);
  });
  await page.keyboard.press('Escape');
  await step(page, 'shell-desk-plus', async () => {
    await page.locator('[data-add-for="chats"]:visible').first().click({ timeout: STEP_TIMEOUT_MS });
  });
  await page.keyboard.press('Escape');

  // Телефон: лента, «+», общий поиск
  await resize(page, PHONE);
  // На телефоне открытый чат закрывает список — к списку стрелкой чата
  await page.locator(`#MiddleColumn .MiddleHeader button[aria-label="${t('Назад', 'Back')}"]:visible`).first()
    .click({ timeout: 5000 }).catch(() => undefined);
  await page.locator('#LeftMainHeader #telegram-search-input').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS })
    .catch(() => undefined);
  await step(page, 'Main-01', async () => undefined);
  await step(page, 'PlusModes-01', async () => {
    await page.locator('[data-add-for="chats"]:visible').first().click({ timeout: STEP_TIMEOUT_MS });
  });
  await page.locator('[data-add-for="chats"]:visible').first().click({ timeout: 5000 }).catch(() => undefined);
  await step(page, 'XpStart-01', async () => {
    await page.locator('#LeftMainHeader #telegram-search-input').click({ timeout: STEP_TIMEOUT_MS });
    await page.locator('[data-palette] input').first().fill('план');
  });
  await page.keyboard.press('Escape');
  // Узкое окно компьютера (доска `RdNarrow`, 540×700): список чатов, открытый чат, «Заметки»
  await resize(page, NARROW);
  await step(page, 'RdNarrow-01', async () => { await page.waitForTimeout(500); });
  await step(page, 'RdNarrow-02', async () => {
    await page.locator('.chat-list .ListItem').first().click({ timeout: STEP_TIMEOUT_MS });
    await page.waitForTimeout(800);
  });
  await step(page, 'RdNarrow-03', async () => {
    await page.locator('#MiddleColumn .MiddleHeader .back-button button:visible').first().click({ timeout: 3000 })
      .catch(() => undefined);
    await page.locator('[data-module="notes"]:visible').first().click({ timeout: STEP_TIMEOUT_MS });
    await page.waitForTimeout(1500);
  });
  await page.context().close();
}

// ── «Музыка»: доски MusicHome, MusicLibrary, MusicPlayer, MusicPlaylist, MusicSearch, RpMusicA/B, XpMusic, ZpMusicX,
//    DeskMusic, DeskMusicMore, RdMusic, XdMusic, ZdMusicX. Нужна библиотека сервера: раннер
//    `run_web_gallery_music_e2e.sh` поднимает поддельный сервер, как у сценария `music` ──
async function galleryMusic() {
  const { page } = await openSession('music');
  await toRussian(page);
  const music = await openModule(page, 'music', 'ParvaneMusic');
  await page.locator('#ParvaneMusic[data-music-enabled="true"]').waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await page.waitForTimeout(2000);
  const libraryItem = (key) => music.locator(`[data-music-nav] [data-item="${key}"]:visible`).first();
  const firstTrack = () => music.locator('[data-track]:visible').first();
  const playFirst = async () => {
    await firstTrack().getByRole('button').first().click({ timeout: STEP_TIMEOUT_MS });
    await page.locator('[data-music-desk-player], [data-music-mini]').first().waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  };
  // Компьютер (доска `DeskMusic`): трек играет — плеер внизу; главная с популярным
  await music.locator('[data-music-desk-search]').fill('harbor');
  await music.locator('[data-track]').first().waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await playFirst();
  await step(page, 'DeskMusic-02', async () => { await page.waitForTimeout(1500); });
  await step(page, 'DeskMusic-01', async () => {
    await music.locator('[data-music-desk-search]').fill('');
    await page.locator('[data-module="music"]:visible').first().click();
    await music.locator('[data-music-home]').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  });
  await step(page, 'XdMusic-02', async () => {
    await music.locator('[data-music-desk-player] button').first().click({ timeout: STEP_TIMEOUT_MS });
    await page.locator('[data-music-full]').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  });
  await page.keyboard.press('Escape');
  await step(page, 'XdMusic-01', async () => {
    await music.locator('[data-music-desk-queue]').click({ timeout: STEP_TIMEOUT_MS });
  });
  await step(page, 'music-desk-starred', async () => { await libraryItem('starred').click({ timeout: STEP_TIMEOUT_MS }); });
  await step(page, 'music-desk-dislikes', async () => {
    await music.locator('[data-music-library-more]').first().click({ timeout: STEP_TIMEOUT_MS });
    await page.locator('[data-action="dislikes"]').click({ timeout: STEP_TIMEOUT_MS });
  });
  await step(page, 'DeskMusicMore-02', async () => {
    await page.locator('[data-module="music"]:visible').first().click();
    await music.locator('[data-music-desk-search]').fill('glass');
    await firstTrack().click({ button: 'right', timeout: STEP_TIMEOUT_MS });
  });
  await page.keyboard.press('Escape');

  // Телефон: вкладки «Главная / Поиск / Медиатека» (доска `MusicHome`)
  await resize(page, PHONE);
  const tab = (view) => music.locator(`[role="tablist"] [data-view="${view}"]:visible`).first();
  const musicBack = () => music.locator('[data-music-back]:visible').first().click({ timeout: 3000 }).catch(() => undefined);
  await step(page, 'MusicHome-01', async () => {
    await musicBack();
    await tab('home').click({ timeout: STEP_TIMEOUT_MS });
  });
  await step(page, 'MusicHome-02', async () => {
    await music.locator('[data-music-popular]').scrollIntoViewIfNeeded({ timeout: STEP_TIMEOUT_MS });
  });
  await step(page, 'MusicSearch-01', async () => { await tab('search').click({ timeout: STEP_TIMEOUT_MS }); });
  await step(page, 'MusicSearch-02', async () => {
    await music.locator('[data-music-search] input[type="search"]:visible').first().fill('harbor');
    await music.locator('[data-track]:visible').first().waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  });
  await step(page, 'MusicSearch-04', async () => {
    await music.locator('[data-music-source-open]:visible').first().click({ timeout: STEP_TIMEOUT_MS });
  });
  await page.keyboard.press('Escape');
  await step(page, 'MusicSearch-03', async () => {
    await music.locator('[data-music-search] [data-filter="tracks"]:visible').first().click({ timeout: STEP_TIMEOUT_MS });
  });
  await step(page, 'MusicSearch-06', async () => {
    await music.locator('[data-music-search] input[type="search"]:visible').first().fill('qwzxharbr');
    await music.locator('[data-music-empty="search"]').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  });
  await music.locator('[data-music-search] input[type="search"]:visible').first().fill('harbor');
  await music.locator('[data-music-search] [data-filter="all"]:visible').first().click({ timeout: STEP_TIMEOUT_MS });
  await step(page, 'RpMusicA-02', async () => {
    await music.locator('[data-track]:visible [data-music-menu]').first().click({ timeout: STEP_TIMEOUT_MS });
  });
  await page.keyboard.press('Escape');
  await step(page, 'RpMusicA-03', async () => {
    await music.locator('[data-track]:visible [data-music-menu]').first().click({ timeout: STEP_TIMEOUT_MS });
    await page.locator('[data-action="file"]').click({ timeout: STEP_TIMEOUT_MS });
  });
  await step(page, 'ZpMusicX-02', async () => {
    await page.locator('[data-action="tags"]').click({ timeout: STEP_TIMEOUT_MS });
    await page.locator('[data-music-tag-editor]').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  });
  await page.keyboard.press('Escape');
  await step(page, 'ZpMusicX-06', async () => {
    await music.locator('[data-track]:visible [data-music-menu]').first().click({ timeout: STEP_TIMEOUT_MS });
    await page.locator('[data-action="file"]').click({ timeout: STEP_TIMEOUT_MS });
    await page.locator('[data-action="info"]').click({ timeout: STEP_TIMEOUT_MS });
    await page.waitForTimeout(1200);
  });
  await page.keyboard.press('Escape');
  await musicBack();
  await step(page, 'MusicLibrary-01', async () => { await tab('library').click({ timeout: STEP_TIMEOUT_MS }); });
  await step(page, 'MusicLibrary-02', async () => {
    await music.locator('[data-music-library] [data-tab="albums"]').click({ timeout: STEP_TIMEOUT_MS });
    await music.locator('[data-music-library-albums] button').first().waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  });
  await step(page, 'MusicLibrary-03', async () => {
    await music.locator('[data-music-library-more]:visible').first().click({ timeout: STEP_TIMEOUT_MS });
  });
  await page.keyboard.press('Escape');
  await step(page, 'MusicLibrary-05', async () => {
    await music.locator('[data-music-library] [data-tab="artists"]').click({ timeout: STEP_TIMEOUT_MS });
    await music.locator('[data-music-library-artists] button').first().waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  });
  await step(page, 'XpMusic-01', async () => {
    await music.locator('[data-music-library-artists] button').first().click({ timeout: STEP_TIMEOUT_MS });
    await page.waitForTimeout(800);
  });
  await musicBack();
  await step(page, 'XpMusic-03', async () => {
    await music.locator('[data-music-library] [data-tab="albums"]').click({ timeout: STEP_TIMEOUT_MS });
    await music.locator('[data-music-library-albums] button').first().click({ timeout: STEP_TIMEOUT_MS });
    await page.waitForTimeout(800);
  });
  await step(page, 'MusicPlayer-02', async () => {
    await page.locator('[data-music-mini]:visible').first().getByRole('button').first().click({ timeout: STEP_TIMEOUT_MS });
    await page.waitForTimeout(800);
  });
  await step(page, 'MusicPlayer-06', async () => {
    await page.locator('[data-music-open-queue]').click({ timeout: STEP_TIMEOUT_MS });
  });
  await page.keyboard.press('Escape');
  await musicBack();
  // «+ → Вставить ссылку» и «Загрузки на сервер» (доски `RpMusicB-01/02`)
  await step(page, 'RpMusicB-02', async () => {
    await page.locator('[data-add-for="music"]:visible').first().click({ timeout: STEP_TIMEOUT_MS });
    await page.locator('.MenuItem').nth(1).click({ timeout: STEP_TIMEOUT_MS });
    await page.locator('[data-music-link]:visible').first().fill('https://soundcloud.com/lampa/utro');
  });
  await step(page, 'RpMusicB-01', async () => {
    await page.locator('[data-music-link-add]:visible').first().click({ timeout: STEP_TIMEOUT_MS });
    await music.locator('[data-fetch-job]').first().waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
    await page.waitForTimeout(1500);
  });
  await musicBack();
  await step(page, 'MusicLibrary-10', async () => {
    await music.locator('[data-music-library-more]:visible').first().click({ timeout: STEP_TIMEOUT_MS });
    await page.locator('[data-action="trash"]').click({ timeout: STEP_TIMEOUT_MS });
    await music.locator('[data-music-view-trash]').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  });
  await musicBack();
  await step(page, 'MusicLibrary-04', async () => {
    await music.locator('[data-music-library] [data-tab="playlists"]').click({ timeout: STEP_TIMEOUT_MS });
    await music.locator('[data-music-library] [data-item="starred"]').click({ timeout: STEP_TIMEOUT_MS });
  });
  await page.context().close();
}

// ── Состояния: «нет связи» в модулях (доски `PhStates-02`, `ZpFilesX-03`, `ZdFilesX-02`), первый запуск (`XpStart-02`) ──
async function galleryStates() {
  const { page } = await openSession('states');
  await toRussian(page);
  const modules = [['plan', 'ParvanePlanner'], ['health', 'ParvaneHealth'], ['notes', 'ParvaneKnowledge'], ['files', 'ParvaneCloud']];
  // Каждый модуль открыт один раз со связью: без неё показывается сохранённое на устройстве
  for (const [module, rootId] of modules) {
    await openModule(page, module, rootId).catch((err) => console.log(`WARN: ${module}: ${String(err).split('\n')[0]}`));
    await page.waitForTimeout(1500);
  }
  // Файл тащат в окно (доска `ZdMisc-01`)
  await step(page, 'ZdMisc-01', async () => {
    await page.evaluate(() => {
      const data = new DataTransfer();
      data.items.add(new File(['x'], 'backup.tar.zst'));
      const target = document.querySelector('#ParvaneCloud');
      ['dragenter', 'dragover'].forEach((type) => {
        target.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: data }));
      });
    });
    await page.waitForTimeout(600);
  });
  await page.evaluate(() => {
    document.querySelector('#ParvaneCloud').dispatchEvent(new DragEvent('dragleave', { bubbles: true }));
    window.dispatchEvent(new DragEvent('dragend', { bubbles: true }));
  });
  await page.keyboard.press('Escape');
  // Открытое соединение браузер стенда не рвёт: обрыв клиент замечает по молчанию сервера, на это уходит время
  await page.context().setOffline(true);
  await page.waitForTimeout(50000);
  for (const [module, rootId] of modules) {
    await step(page, `states-desk-offline-${module}`, async () => {
      await openModule(page, module, rootId);
      await page.waitForTimeout(1500);
    });
  }
  // «Файлы»: загрузка без связи — строка файла с причиной и «Повторить» (доски `ZdFilesX-02`, `ZpFilesX-03`)
  await step(page, 'ZdFilesX-02', async () => {
    const cloud = await openModule(page, 'files', 'ParvaneCloud');
    await cloud.locator('input[type="file"]').first().setInputFiles([
      { name: 'схема-сети.png', mimeType: 'image/png', buffer: buildPngBuffer(96, [0x2a, 0x2a, 0x2a]) },
      { name: 'backup-2026-12.tar.zst', mimeType: 'application/octet-stream', buffer: Buffer.alloc(300000, 7) },
    ]);
    await page.waitForTimeout(8000);
  });
  await step(page, 'states-desk-offline-chats', async () => {
    await page.locator('[data-module="chats"]:visible').first().click({ timeout: STEP_TIMEOUT_MS });
    await page.waitForTimeout(1000);
  });
  await resize(page, PHONE);
  // «Здоровье» — последним: его страница первого открытия на телефоне без ленты модулей
  const phoneOrder = [...modules].sort((x, y) => Number(x[0] === 'health') - Number(y[0] === 'health')).reverse()
    .sort((x, y) => Number(x[0] === 'health') - Number(y[0] === 'health'));
  for (const [module, rootId] of phoneOrder) {
    await step(page, `states-phone-offline-${module}`, async () => {
      // Страница без ленты модулей (первое открытие «Здоровья») закрывается стрелкой «назад»
      await page.getByRole('button', { name: t('Назад', 'Back') }).first().click({ timeout: 1500 }).catch(() => undefined);
      await openModule(page, module, rootId);
      await page.waitForTimeout(1500);
    });
  }
  await page.context().setOffline(false);
  // Первый запуск «Что вам нужно?»: отметка показа снята, страница перезагружена
  await step(page, 'XpStart-02', async () => {
    await page.evaluate(() => localStorage.setItem('parvane:modules-first-run', ''));
    await reloadPage(page);
    await page.waitForTimeout(4000);
  });
  await resize(page, DESK);
  await step(page, 'states-desk-first-run', async () => { await page.waitForTimeout(800); });
  // «Нужно обновить приложение»: сервер требует новую версию (доска `XpAuth-03`). Первый запуск сначала пройден:
  // окно поверх него перехватило бы нажатия обработчика первого запуска из хелперов
  await page.evaluate(() => localStorage.setItem('parvane:modules-first-run', 'shown'));
  await reloadPage(page);
  await page.waitForTimeout(3000);
  for (const [name, size] of [['states-desk-upgrade', DESK], ['states-phone-upgrade', PHONE]]) {
    await resize(page, size);
    await step(page, name, async () => {
      await page.evaluate(() => window.dispatchEvent(new CustomEvent('parvane-upgrade-required')));
      await page.waitForTimeout(1500);
    });
    await page.evaluate(() => document.querySelector('[data-upgrade-later]')?.click());
    await page.waitForTimeout(500);
  }
  await page.context().close();
}

// ── Второе устройство до привязки (доски `ZdFilesX-02`, `ZpFilesX-03`: «Этот компьютер ещё не привязан») ──
async function galleryUnlinked() {
  const first = await openSession('unlinked');
  // На первом устройстве есть данные: папка «Файлов» и справка «Заметок»
  await openModule(first.page, 'notes', 'ParvaneKnowledge').catch(() => undefined);
  await first.page.waitForTimeout(4000);
  const context = await newGalleryContext({ viewport: DESK });
  await context.addInitScript(() => {
    if (localStorage.getItem('parvane:language-system') !== '1') return;
    Object.defineProperty(navigator, 'language', { get: () => 'ru-RU' });
    Object.defineProperty(navigator, 'languages', { get: () => ['ru-RU', 'ru'] });
  });
  const { page } = await preparePage(context, first.user, PASSWORD);
  await dismissRecoveryKeyDialog(page).catch(() => undefined);
  await toRussian(page);
  const modules = [['files', 'ParvaneCloud'], ['notes', 'ParvaneKnowledge'], ['plan', 'ParvanePlanner'], ['health', 'ParvaneHealth']];
  for (const [name, size] of [['desk', DESK], ['phone', PHONE]]) {
    await resize(page, size);
    for (const [module, rootId] of modules) {
      await step(page, `unlinked-${name}-${module}`, async () => {
        await page.getByRole('button', { name: t('Назад', 'Back') }).first().click({ timeout: 1000 }).catch(() => undefined);
        await openModule(page, module, rootId);
        await page.waitForTimeout(2500);
      });
    }
  }
  await step(page, 'unlinked-phone-chats', async () => {
    await page.locator('[data-module="chats"]:visible').first().click({ timeout: STEP_TIMEOUT_MS });
    await page.waitForTimeout(1500);
  });
  await context.close();
  await first.page.context().close();
}

// ── Заглушки загрузки (доски `ZpStates-01`, `ZdMisc-05`): модуль впервые открыт без связи — список не приходит ──
async function gallerySkeleton() {
  // Без сервис-воркера: он отдал бы код разделов из своего хранилища мимо перехвата запросов
  const { page } = await openSession('skeleton', { serviceWorkers: 'block' });
  // Код разделов (бандл `Parvane`) не приходит: на месте раздела — «Загрузка…», затем «Нет ответа от сервера»
  // Файлов с именем `parvane-*` два, один нужен на старте: обрываем только тот, где лежат сами разделы
  let isBlocking = true;
  await page.route(/\/assets\/parvane-[^/]*\.js$/, async (route) => {
    const response = await route.fetch();
    const body = await response.text();
    if (isBlocking && body.includes('data-cloud-nav')) await route.abort();
    else await route.fulfill({ response, body });
  });
  await toRussian(page);
  for (const [name, size] of [['desk', DESK], ['phone', PHONE]]) {
    await resize(page, size);
    await step(page, `module-loading-${name}`, async () => {
      await page.locator('[data-module="files"]:visible').first().click({ timeout: STEP_TIMEOUT_MS });
      await page.locator('[data-module-loading]:visible').first().waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
    });
    await step(page, `module-loading-${name}-12s`, async () => {
      await page.locator('[data-module-loading] [data-no-answer]:visible').first()
        .waitFor({ state: 'visible', timeout: 20000 });
    });
    await page.locator('[data-module="chats"]:visible').first().click({ timeout: 3000 }).catch(() => undefined);
  }
  await resize(page, DESK);
  isBlocking = false;
  await page.locator('[data-module="files"]:visible').first().click({ timeout: 3000 }).catch(() => undefined);
  await page.locator('[data-module-loading] [data-no-answer]:visible').first().waitFor({ state: 'visible', timeout: 20000 })
    .catch(() => undefined);
  // «Повторить» со связью: раздел подгружается и встаёт на место
  await step(page, 'module-loading-retry', async () => {
    await page.locator('[data-module-loading] button:visible').first().click({ timeout: STEP_TIMEOUT_MS });
    // Страница перечитывается; раздел после неё открывается заново
    await page.locator('#LeftColumn, #Main').first().waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
    await page.waitForTimeout(3000);
    await page.locator('[data-module="files"]:visible').first().click({ timeout: STEP_TIMEOUT_MS });
    await page.locator('#ParvaneCloud [data-cloud-nav]').waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  });
  // Заглушки списка (доски `ZpStates-01`, `ZdMisc-05`): сеть замедлена, раздел открыт сразу после перезагрузки —
  // пока движок и связь ещё поднимаются
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Network.enable');
  await cdp.send('Network.emulateNetworkConditions', {
    offline: false, latency: 1500, downloadThroughput: 60_000, uploadThroughput: 60_000,
  });
  await page.reload({ waitUntil: 'commit' });
  for (const [name, module, size] of [['desk', 'files', DESK], ['phone', 'notes', PHONE]]) {
    await resize(page, size);
    await page.locator(`[data-module="${module}"]:visible`).first().click({ timeout: LOGIN_TIMEOUT_MS }).catch(() => undefined);
    for (let shot = 0; shot < 4; shot++) {
      await step(page, `skeleton-slow-${name}-${shot}`, async () => { await page.waitForTimeout(shot ? 1500 : 100); });
    }
  }
  await cdp.send('Network.emulateNetworkConditions', {
    offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1,
  });
  await resize(page, DESK);
  await page.context().setOffline(true);
  for (const [name, module, rootId] of [['files', 'files', 'ParvaneCloud'], ['notes', 'notes', 'ParvaneKnowledge']]) {
    await step(page, `skeleton-desk-${name}`, async () => {
      await openModule(page, module, rootId);
      await page.waitForTimeout(800);
    });
    // Дольше трёх секунд — подпись «Загрузка…», дольше десяти — «Нет ответа от сервера» и «Повторить»
    await step(page, `skeleton-desk-${name}-4s`, async () => { await page.waitForTimeout(3500); });
    await step(page, `skeleton-desk-${name}-12s`, async () => { await page.waitForTimeout(8000); });
  }
  await resize(page, PHONE);
  await step(page, 'ZpStates-01', async () => { await page.waitForTimeout(800); });
  await page.context().setOffline(false);
  await page.context().close();
}

// ── Чаты: доски RpChat (профиль собеседника), ZpChat2 (сведения группы), XpChat, ZpChat — два аккаунта ──
async function galleryChat() {
  const bob = await openSession('chat-bob');
  const alice = await openSession('chat-alice');
  const { page } = alice;
  const peer = bob.user;
  try {
    await openPrivateChatStrict(page, peer);
    await sendText(page, 'Пришли конфиг, гляну вечером');
    await createGroupViaUi(page, 'Linux-чат', [peer.split('@')[0]]);
    await sendText(page, 'Собрал клиент под aarch64, выложу в «Файлы» вечером');
  } catch (err) {
    console.log(`WARN: чат: ${String(err).split('\n')[0]}`);
  }
  await toRussian(page);
  const header = page.locator('#MiddleColumn .MiddleHeader .chat-info-wrapper, #MiddleColumn .MiddleHeader .ChatInfo').first();
  // Компьютер: открытая группа и её сведения
  await step(page, 'chat-desk-group', async () => {
    await page.locator('.chat-list .ListItem').filter({ hasText: 'Linux-чат' }).first().click({ timeout: STEP_TIMEOUT_MS });
  });
  await step(page, 'chat-desk-group-info', async () => { await header.click({ timeout: STEP_TIMEOUT_MS }); });
  await step(page, 'chat-desk-group-edit', async () => {
    await page.locator('#RightColumn .pv-header-action').first().click({ timeout: STEP_TIMEOUT_MS });
    await page.locator('#RightColumn .Management').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
    await page.waitForTimeout(800);
  });
  // С экрана «Изменить» назад к сведениям и закрыть панель
  for (let attempt = 0; attempt < 2; attempt++) {
    await page.locator('#RightColumn .close-button:visible').first().click({ timeout: 2000 }).catch(() => undefined);
    await page.waitForTimeout(500);
  }
  await page.keyboard.press('Escape');
  await step(page, 'chat-desk-peer-info', async () => {
    await page.locator('.chat-list .ListItem').filter({ hasText: peer.split('@')[0] }).first().click({ timeout: STEP_TIMEOUT_MS });
    await header.click({ timeout: STEP_TIMEOUT_MS });
  });
  await page.keyboard.press('Escape');
  // Телефон: профиль собеседника (доска `RpChat`) и сведения группы (доска `ZpChat2`) — экранами поверх чата
  await resize(page, PHONE);
  const phoneInfo = async (name, title) => {
    await step(page, name, async () => {
      const row = page.locator('.chat-list .ListItem').filter({ hasText: title }).first();
      // К списку чатов: закрыть правую панель и открытый чат, пока строку чата нельзя нажать (на телефоне она
      // «видна» и под открытым чатом — проверяется пробным нажатием)
      const isReachable = () => row.click({ trial: true, timeout: 1500 }).then(() => true, () => false);
      for (let attempt = 0; attempt < 4 && !(await isReachable()); attempt++) {
        await page.locator('#RightColumn .close-button:visible, #MiddleColumn .MiddleHeader .back-button button:visible')
          .first().click({ timeout: 2000 }).catch(() => page.keyboard.press('Escape'));
        await page.waitForTimeout(600);
      }
      await row.click({ timeout: STEP_TIMEOUT_MS });
      await page.locator('#MiddleColumn .MiddleHeader .ChatInfo:visible').first().click({ timeout: STEP_TIMEOUT_MS });
      await page.waitForTimeout(800);
    });
    await page.keyboard.press('Escape');
    await page.waitForTimeout(500);
  };
  await phoneInfo('RpChat-02', peer.split('@')[0]);
  await phoneInfo('ZpChat2-04', 'Linux-чат');
  // К чату из любого места: закрыть панели, пока строку чата нельзя нажать
  const openChat = async (title) => {
    // «В план» и «В заметку» уводят в модуль — назад к чатам по ленте модулей
    await page.keyboard.press('Escape');
    await page.locator('[data-module="chats"]:visible').first().click({ timeout: 1500 }).catch(() => undefined);
    const row = page.locator('.chat-list .ListItem').filter({ hasText: title }).first();
    const isReachable = () => row.click({ trial: true, timeout: 1500 }).then(() => true, () => false);
    for (let attempt = 0; attempt < 4 && !(await isReachable()); attempt++) {
      await page.locator('#RightColumn .close-button:visible, #MiddleColumn .MiddleHeader .back-button button:visible')
        .first().click({ timeout: 2000 }).catch(() => page.keyboard.press('Escape'));
      await page.waitForTimeout(600);
    }
    await row.click({ timeout: STEP_TIMEOUT_MS });
    await page.waitForTimeout(800);
  };
  // Телефон: «Тип группы» из сведений группы (доска `XpChat-01`)
  await step(page, 'XpChat-01', async () => {
    await openChat('Linux-чат');
    await page.locator('#MiddleColumn .MiddleHeader .ChatInfo:visible').first().click({ timeout: STEP_TIMEOUT_MS });
    await page.locator('#RightColumn').getByText(t('Тип группы', 'Group type'), { exact: true }).first().click({ timeout: STEP_TIMEOUT_MS });
    await page.waitForTimeout(1000);
  });
  // Телефон: меню сообщения и его пункты (доски `ZpChat-02`, `RpPick-02`, `XpChat-02`) — в личном чате
  const lastMessage = page.locator('#MiddleColumn .Message .message-content:visible').last();
  const messageMenu = async () => {
    await openChat(peer.split('@')[0]);
    await lastMessage.click({ button: 'right', timeout: STEP_TIMEOUT_MS });
    await page.waitForTimeout(800);
  };
  await step(page, 'ZpChat-02', messageMenu);
  await page.keyboard.press('Escape');
  for (const [name, item] of [['RpPick-02', t('Переслать', 'Forward')], ['XpChat-02', t('В план', 'To plan')],
    ['chat-phone-to-note', t('В заметку', 'To a note')]]) {
    await step(page, name, async () => {
      await messageMenu();
      // Подпись пункта идёт с пояснением справа («В план · задача из текста») — ищем пункт по началу текста
      await page.locator('.MenuItem:visible, [role="menuitem"]:visible').filter({ hasText: item }).first()
        .click({ timeout: STEP_TIMEOUT_MS });
      await page.waitForTimeout(1200);
    });
    await page.keyboard.press('Escape');
    await page.waitForTimeout(500);
  }
  // Поиск по сообщениям (экран форка): телефон — Escape в списке чатов, компьютер — поле «Поиск» списка
  await step(page, 'chat-phone-search', async () => {
    await openChat(peer.split('@')[0]);
    await page.locator('#MiddleColumn .MiddleHeader .back-button button:visible').first().click({ timeout: STEP_TIMEOUT_MS });
    await page.waitForTimeout(600);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(800);
  });
  await step(page, 'chat-phone-search-query', async () => {
    await page.locator('#LeftColumn input[type="text"]:visible, #LeftColumn input[type="search"]:visible').first().fill('клиент');
    await page.waitForTimeout(2000);
  });
  await resize(page, DESK);
  await step(page, 'chat-desk-search-query', async () => { await page.waitForTimeout(1500); });
  await step(page, 'chat-desk-search-empty', async () => {
    await page.locator('#LeftColumn input[type="text"]:visible, #LeftColumn input[type="search"]:visible').first().fill('');
    await page.waitForTimeout(1000);
  });
  await page.keyboard.press('Escape');
  await resize(page, PHONE);
  // Телефон: «Новое сообщение», новая группа и новый канал (доска `ZpChat2`)
  const toChatList = async () => {
    await page.keyboard.press('Escape');
    await page.locator('[data-module="chats"]:visible').first().click({ timeout: 1500 }).catch(() => undefined);
    for (let attempt = 0; attempt < 4; attempt++) {
      if (await page.locator('[data-add-for="chats"]:visible').first().isVisible().catch(() => false)) break;
      await page.locator('#RightColumn .close-button:visible, #MiddleColumn .MiddleHeader .back-button button:visible')
        .first().click({ timeout: 2000 }).catch(() => page.keyboard.press('Escape'));
      await page.waitForTimeout(600);
    }
  };
  await step(page, 'ZpChat2-01', async () => {
    await toChatList();
    await page.locator('[data-add-for="chats"]:visible').first().click({ timeout: STEP_TIMEOUT_MS });
    await page.waitForTimeout(800);
  });
  await step(page, 'ZpChat2-03', async () => {
    await page.getByText(t('Новый канал', 'New channel'), { exact: true }).first().click({ timeout: STEP_TIMEOUT_MS });
    await page.waitForTimeout(800);
  });
  await page.keyboard.press('Escape');
  await step(page, 'ZpChat2-02', async () => {
    await toChatList();
    await page.locator('[data-add-for="chats"]:visible').first().click({ timeout: STEP_TIMEOUT_MS });
    await page.getByText(t('Новая группа', 'New group'), { exact: true }).first().click({ timeout: STEP_TIMEOUT_MS });
    await page.waitForTimeout(800);
  });
  // Шаг 2 новой группы: участник выбран, «Далее»
  await step(page, 'chat-phone-new-group-2', async () => {
    await page.locator('.pv-new-chat-item:visible').first().click({ timeout: STEP_TIMEOUT_MS });
    await page.getByText(t('Далее', 'Next'), { exact: true }).first().click({ timeout: STEP_TIMEOUT_MS });
    await page.waitForTimeout(1000);
  });
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  await step(page, 'ZpChat2-05', async () => {
    await toChatList();
    await page.locator('[data-add-for="chats"]:visible').first().click({ timeout: STEP_TIMEOUT_MS });
    await page.getByText(IS_EN ? /^(Contacts|New message)$/ : /^(Контакты|Новое сообщение)$/).first().click({ timeout: STEP_TIMEOUT_MS });
    await page.waitForTimeout(1000);
  });
  await page.context().close();
  await bob.page.context().close();
}

try {
  if (wants('health')) await galleryHealth();
  if (wants('chat')) await galleryChat();
  // «Музыка» — только с библиотекой сервера (раннер `run_web_gallery_music_e2e.sh`)
  if (wants('music') && process.env.PARVANE_E2E_MUSIC) await galleryMusic();
  if (wants('shell')) await galleryShell();
  if (wants('auth')) await galleryAuth();
  if (wants('profile')) await galleryProfile();
  if (wants('files')) await galleryFiles();
  if (wants('notes')) await galleryNotes();
  if (wants('plan')) await galleryPlan();
  if (wants('states')) await galleryStates();
  if (wants('skeleton')) await gallerySkeleton();
  if (wants('unlinked')) await galleryUnlinked();
  console.log(`e2e_web_gallery: OK (не удалось шагов: ${failed})`);
} finally {
  await browser.close();
}
