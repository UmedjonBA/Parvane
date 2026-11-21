// Галерея «экран против доски» (сверка с макетом `local-workdirs/design-2026-11-17/parvane-design`): снимает
// экраны приложения в размерах макета — телефон 360×800, компьютер 1120×700, русский язык, светлая тема — под
// именами кадров досок (`<Доска>-<номер>.png`, номера — как у `render_boards.mjs`). Ничего не утверждает, кроме
// того, что экраны открываются; шаг, который не удался, пишет WARN и снимок `<имя>-fail.png`. Данные — выдуманные.
// Запуск: PARVANE_E2E_SHOT_DIR=<каталог> [PARVANE_GALLERY=health,plan,…] scripts/run_web_gallery_e2e.sh
import { chromium } from '../web/telegram-tt/node_modules/playwright/index.mjs';

import {
  dismissRecoveryKeyDialog,
  LOGIN_TIMEOUT_MS,
  openHealthModule,
  openPlannerScreen,
  preparePage,
  reloadPage,
} from './e2e_web_helpers.mjs';

const PASSWORD = 'Parvane-gallery-e2e-1';
const PHONE = { width: 360, height: 800 };
const DESK = { width: 1120, height: 700 };
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
  const session = await preparePage(context, `gallery-${tag}-${Date.now().toString(36)}@local`, PASSWORD);
  await dismissRecoveryKeyDialog(session.page).catch(() => undefined);
  return session;
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

try {
  if (wants('health')) await galleryHealth();
  if (wants('plan')) await galleryPlan();
  console.log(`e2e_web_gallery: OK (не удалось шагов: ${failed})`);
} finally {
  await browser.close();
}
