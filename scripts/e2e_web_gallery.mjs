// Галерея «экран против доски» (сверка с макетом `local-workdirs/design-2026-11-17/parvane-design`): снимает
// экраны приложения в размерах макета — телефон 360×800, компьютер 1120×700, русский язык, светлая тема — под
// именами кадров досок (`<Доска>-<номер>.png`, номера — как у `render_boards.mjs`). Ничего не утверждает, кроме
// того, что экраны открываются; шаг, который не удался, пишет WARN и снимок `<имя>-fail.png`. Данные — выдуманные.
// Запуск: PARVANE_E2E_SHOT_DIR=<каталог> [PARVANE_GALLERY=health,plan,…] scripts/run_web_gallery_e2e.sh
import { chromium } from '../web/telegram-tt/node_modules/playwright/index.mjs';

import {
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

const browser = await chromium.launch();
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
async function openSession(tag) {
  const context = await browser.newContext({ viewport: DESK, colorScheme: 'light' });
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
  await page.evaluate(() => localStorage.setItem('parvane:language-system', '1'));
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
  await page.evaluate(() => localStorage.setItem('parvane:language-system', '1'));
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
      const back = health.locator('[data-health-side-back]:visible, header button[aria-label="Назад"]:visible').first();
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
  await plan.locator('button[aria-label="Назад"]:visible').first().click().catch(() => undefined);
  await step(page, 'RpPlan-01', () => more('agenda'));
  await step(page, 'RpPlan-02', async () => {
    await more('search');
    await plan.locator('[data-planner-search-input]').fill('зал');
  });
  await page.keyboard.press('Escape');
  await step(page, 'PhPlanMore-03', () => more('tasks'));
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
      await notes.getByRole('button', { name: 'К заметкам' }).first().click({ timeout: 5000 }).catch(() => undefined);
      await page.waitForTimeout(700);
    }
  };
  await step(page, 'PhNotesMore-02', async () => undefined);
  await step(page, 'PhNotesMore-03', async () => {
    await notes.getByRole('button', { name: 'Изменить' }).first().click({ timeout: STEP_TIMEOUT_MS });
  });
  await notes.getByRole('button', { name: 'Готово' }).first().click({ timeout: 5000 }).catch(() => undefined);
  await back();
  await step(page, 'PhNotesMore-01', async () => undefined);
  await step(page, 'XpNotes-01', async () => { await tab(1).click({ timeout: STEP_TIMEOUT_MS }); });
  await step(page, 'RpNotes-01', async () => { await tab(2).click({ timeout: STEP_TIMEOUT_MS }); });
  await page.context().close();
}

// ── «Файлы»: доски PhoneFiles, PhFilesMore, RpFiles, XpFiles, ZpFilesX, DeskFiles, DkFilesDialogs, RdFiles,
//    XdFiles, ZdFilesX ──
async function galleryFiles() {
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

  // Телефон
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
  await step(page, 'PhFilesMore-01', async () => { await fileAction('backup-2026-11.tar.zst', 'Ссылка для всех'); });
  await page.keyboard.press('Escape');
  await step(page, 'XpFiles-02', async () => { await fileAction('nftables.conf', 'Переместить'); });
  await page.keyboard.press('Escape');
  await step(page, 'PhFilesMore-03', async () => {
    await fileAction('parvane-android-arm64.apk', 'В корзину');
    await filesChip('Корзина').click({ timeout: STEP_TIMEOUT_MS });
  });
  // Корзина, «Мои ссылки» — страницы с «назад»: к вкладкам возвращает стрелка
  const filesBack = () => files2.locator('[data-cloud-back]:visible').first().click({ timeout: 3000 }).catch(() => undefined);
  await step(page, 'RpFiles-01', async () => {
    await filesBack();
    await filesChip('Мои ссылки').click({ timeout: STEP_TIMEOUT_MS });
  });
  await step(page, 'files-phone-owned', async () => {
    await filesBack();
    await filesChip('Общие папки').click({ timeout: STEP_TIMEOUT_MS });
  });
  await step(page, 'ZpFilesX-01', async () => {
    await page.getByRole('button', { name: /Новая общая папка|Создать общую папку/ }).first().click({ timeout: STEP_TIMEOUT_MS });
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
    await filesChip('Мой диск').click({ timeout: STEP_TIMEOUT_MS });
    await files2.getByRole('button', { name: 'Поиск по файлам' }).first().click({ timeout: STEP_TIMEOUT_MS });
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
      await page.locator('#Settings button[aria-label="Назад"]:visible, #Settings .Button.translucent:visible').first()
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
      await page.locator('#Settings button[aria-label="Назад"]:visible, #Settings .Button.translucent:visible').first()
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
    const context = await browser.newContext({ viewport: size, colorScheme: 'light' });
    await context.addInitScript((gatewayUrl) => {
      localStorage.setItem('parvane:gateway', gatewayUrl);
      localStorage.setItem('parvane:language-system', '1');
      Object.defineProperty(navigator, 'language', { get: () => 'ru-RU' });
      Object.defineProperty(navigator, 'languages', { get: () => ['ru-RU', 'ru'] });
    }, process.env.PARVANE_E2E_GATEWAY_URL);
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
  await page.locator('#MiddleColumn .MiddleHeader button[aria-label="Назад"]:visible').first()
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
const MUSIC_VIEWS = ['home', 'starred', 'artists', 'albums', 'offline'];

async function galleryMusic() {
  const { page } = await openSession('music');
  await toRussian(page);
  const music = await openModule(page, 'music', 'ParvaneMusic');
  await page.locator('#ParvaneMusic[data-music-enabled="true"]').waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await page.waitForTimeout(2000);
  const nav = (view) => music.locator(`[data-music-nav] [data-view="${view}"]:visible`).first();
  // Компьютер
  for (const view of MUSIC_VIEWS) {
    await step(page, `music-desk-${view}`, async () => { await nav(view).click({ timeout: STEP_TIMEOUT_MS }); });
  }
  await step(page, 'music-desk-playing', async () => {
    await nav('albums').click({ timeout: STEP_TIMEOUT_MS });
    await music.locator('[data-music-albums] button').first().click({ timeout: STEP_TIMEOUT_MS });
    await music.locator('[data-track]').first().getByRole('button').first().click({ timeout: STEP_TIMEOUT_MS });
    await nav('home').click({ timeout: STEP_TIMEOUT_MS });
    await page.waitForTimeout(1500);
  });
  // Телефон
  await resize(page, PHONE);
  // Телефон: три вкладки «Главная / Поиск / Библиотека» (доска `MusicHome`)
  const tab = (index) => music.locator('[role="tablist"]').first().locator('[role="tab"]').nth(index);
  await step(page, 'MusicHome-01', async () => { await tab(0).click({ timeout: STEP_TIMEOUT_MS }); });
  await step(page, 'MusicSearch-01', async () => { await tab(1).click({ timeout: STEP_TIMEOUT_MS }); });
  // Поиск на телефоне — страница без вкладок: к вкладкам возвращает «назад»
  await step(page, 'MusicLibrary-01', async () => {
    await music.locator('[data-music-back]:visible').first().click({ timeout: STEP_TIMEOUT_MS });
    await tab(2).click({ timeout: STEP_TIMEOUT_MS });
  });
  // Телефон: альбом, исполнители, плеер во весь экран (доски `RpMusicA`, `MusicPlayer`)
  const libraryRow = (kind) => music.locator(`[data-music-library] [data-view="${kind}"]:visible`).first();
  const musicBack = () => music.locator('[data-music-back]:visible').first().click({ timeout: 3000 }).catch(() => undefined);
  await step(page, 'music-phone-albums', async () => { await libraryRow('albums').click({ timeout: STEP_TIMEOUT_MS }); });
  await step(page, 'RpMusicA-01', async () => {
    await music.locator('[data-music-albums] button:visible').first().click({ timeout: STEP_TIMEOUT_MS });
    await page.waitForTimeout(1000);
  });
  await step(page, 'MusicPlayer-01', async () => {
    await page.locator('[data-music-mini]:visible').first().click({ timeout: STEP_TIMEOUT_MS });
    await page.waitForTimeout(1000);
  });
  await page.keyboard.press('Escape');
  await step(page, 'music-phone-artists', async () => {
    await musicBack();
    await musicBack();
    await libraryRow('artists').click({ timeout: STEP_TIMEOUT_MS });
    await page.waitForTimeout(800);
  });
  await step(page, 'music-phone-offline', async () => {
    await musicBack();
    await libraryRow('offline').click({ timeout: STEP_TIMEOUT_MS });
    await page.waitForTimeout(800);
  });
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
  // Телефон: «Новое сообщение», новая группа и новый канал (доска `ZpChat2`)
  const toChatList = async () => {
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
    await page.getByText('Новый канал', { exact: true }).first().click({ timeout: STEP_TIMEOUT_MS });
    await page.waitForTimeout(800);
  });
  await page.keyboard.press('Escape');
  await step(page, 'ZpChat2-02', async () => {
    await toChatList();
    await page.locator('[data-add-for="chats"]:visible').first().click({ timeout: STEP_TIMEOUT_MS });
    await page.getByText('Новая группа', { exact: true }).first().click({ timeout: STEP_TIMEOUT_MS });
    await page.waitForTimeout(800);
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
  console.log(`e2e_web_gallery: OK (не удалось шагов: ${failed})`);
} finally {
  await browser.close();
}
