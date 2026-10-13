// Задание в чат (spec 011, US3, правило TASK-1). Личный чат: карточка «Задание» у
// обоих, «В план» на втором устройстве создаёт задачу в «Плане» и шлёт
// ответ-статус, карточка показывает «В плане · открыть», и «открыть» ведёт в
// «План» на день задачи; привязанное второе устройство получателя видит задачу и
// «в плане»; карточка со временем начала — «Событие»: «Отклонить», затем
// «В календарь» создаёт событие календаря; группа из трёх — решения каждого на
// карточке автора; «В план» у автора; базы шардов без открытого текста
// задания; решения на месте после перезагрузки.
// Запуск: scripts/run_web_task_offer_e2e.sh
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { chromium } from '../web/telegram-tt/node_modules/playwright/index.mjs';

import {
  createGroupViaUi,
  dismissRecoveryKeyDialog,
  findMessageContainers,
  linkSecondDevice,
  LOGIN_TIMEOUT_MS,
  openGroupChatByTitle,
  openPrivateChat,
  preparePage,
  relogin,
  sendText,
  openPlannerScreen,
} from './e2e_web_helpers.mjs';

const PASSWORD = 'Parvane-task-offer-e2e-1';
const WIDE = { width: 1440, height: 900 };
const STEP_TIMEOUT_MS = 20000;
// Синк контейнера планировщика: опрос раз в 8 с + пакет 1,5 с + запас
const SYNC_TIMEOUT_MS = 45000;
const BACKEND_DIR = process.env.PARVANE_E2E_BACKEND_LOG_DIR;
assert(BACKEND_DIR, 'PARVANE_E2E_BACKEND_LOG_DIR is required');

function todayKey() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

async function sendTaskOffer(page, name, { day, start, minutes, steps } = {}) {
  await page.getByRole('button', { name: 'Add an attachment' }).click();
  await page.getByRole('menuitem', { name: 'Task', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.locator('#task-offer-name').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await dialog.locator('#task-offer-name').fill(name);
  if (day) await dialog.getByLabel('Work date').fill(day);
  if (start) await dialog.getByLabel('Start', { exact: true }).fill(start);
  if (minutes) await dialog.getByLabel('Duration, min').fill(String(minutes));
  if (steps) await dialog.getByLabel('Steps, one per line').fill(steps.join('\n'));
  await dialog.getByRole('button', { name: 'Send', exact: true }).click();
  await dialog.waitFor({ state: 'detached', timeout: STEP_TIMEOUT_MS });
  const card = findMessageContainers(page, name).locator('[data-task-offer]').first();
  await card.waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  return card;
}

function cardOf(page, name) {
  return findMessageContainers(page, name).locator('[data-task-offer]').first();
}

async function openPlanner(page) {
  const planner = page.locator('#ParvanePlanner');
  // «План» после первого показа остаётся в DOM скрытым (E1) — решаем по видимости, не по наличию
  if (!(await planner.isVisible().catch(() => false))) {
    await openPlannerScreen(page, 'calendar');
  }
  await planner.waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  return planner;
}

async function closePlanner(page) {
  await page.locator('#FoldersSidebar').getByRole('tab', { name: 'Chats' }).click();
  // «План» после первого показа остаётся смонтированным и скрывается (E1), поэтому ждём `hidden`, не `detached`
  await page.locator('#ParvanePlanner').waitFor({ state: 'hidden', timeout: STEP_TIMEOUT_MS });
}

/** Задача есть в расписании сегодняшнего дня (панель дня). */
async function expectTaskInPlan(page, name, timeout = SYNC_TIMEOUT_MS) {
  const planner = await openPlanner(page);
  await openPlannerScreen(planner.page(), 'calendar');
  await planner.locator(`[role="gridcell"][data-day="${todayKey()}"]`).click({ position: { x: 10, y: 10 } });
  await planner.locator('[data-planner-day]').getByRole('button', { name, exact: false }).first()
    .waitFor({ state: 'visible', timeout })
    .catch(() => assert.fail(`${name}: ожидалось в расписании дня`));
  const rows = await planner.locator('[data-planner-day]').getByRole('button', { name, exact: false }).count();
  assert.equal(rows, 1, `${name}: задача должна быть в плане ровно один раз`);
  await closePlanner(page);
}

/**
 * «В плане · открыть» на карточке: раздел «План» на дне записи — задание на экране
 * «Сегодня», событие в «Календаре» (в расписании дня — блоком события с id карточки).
 */
async function openPlanFromCard(page, card, name, kind) {
  const offerId = await card.getAttribute('data-task-offer');
  await card.getByRole('button', { name: 'In plan · open' }).click();
  const planner = page.locator('#ParvanePlanner');
  await planner.waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  if (kind === 'event') {
    await planner.locator(`[data-planner-day="${todayKey()}"] button[data-kind="event"][data-id="${offerId}"]`)
      .waitFor({ state: 'visible', timeout: SYNC_TIMEOUT_MS })
      .catch(() => assert.fail(`${name}: «открыть» должно показать событие в расписании его дня`));
    assert.equal(await planner.locator('[data-planner-today]').count(), 0, 'событие открывается в «Календаре»');
  } else {
    const today = planner.locator(`[data-planner-today="${todayKey()}"]`);
    await today.waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS })
      .catch(() => assert.fail(`${name}: «открыть» должно показать экран «Сегодня» на дне задачи`));
    await today.getByText(name).first().waitFor({ state: 'visible', timeout: SYNC_TIMEOUT_MS })
      .catch(() => assert.fail(`${name}: задача должна быть на экране «Сегодня»`));
  }
  await closePlanner(page);
}

function inPlanButton(card) {
  return card.getByRole('button', { name: 'In plan · open' });
}

function plaintextLeaks(words) {
  const leaks = new Set();
  for (const file of readdirSync(BACKEND_DIR)) {
    if (!/\.db(-wal)?$/.test(file)) continue;
    const bytes = readFileSync(join(BACKEND_DIR, file));
    const text = bytes.toString('utf8');
    for (const word of words) {
      if (text.includes(word)) leaks.add(`${file}:${word}`);
    }
  }
  return [...leaks];
}

const browser = await chromium.launch();
const aliceContext = await browser.newContext({ viewport: WIDE });
const bobContext = await browser.newContext({ viewport: WIDE });
const bob2Context = await browser.newContext({ viewport: WIDE });
const carolContext = await browser.newContext({ viewport: WIDE });
const sessions = {};

try {
  const suffix = `${Date.now().toString(36)}-${process.pid}`;
  const alice = `toffer-alice-${suffix}@local`;
  const bob = `toffer-bob-${suffix}@local`;
  const carol = `toffer-carol-${suffix}@local`;
  const bobName = bob.split('@')[0];
  const carolName = carol.split('@')[0];
  const today = todayKey();
  const offerA = `Отчёт-${suffix}`;
  const offerB = `Второе-${suffix}`;
  const offerG = `Групповое-${suffix}`;
  const stepText = `шаг-${suffix}`;

  sessions.alice = await preparePage(aliceContext, alice, PASSWORD);
  sessions.bob = await preparePage(bobContext, bob, PASSWORD);
  sessions.carol = await preparePage(carolContext, carol, PASSWORD);
  for (const s of Object.values(sessions)) await dismissRecoveryKeyDialog(s.page).catch(() => undefined);

  // Переписка — чтобы у сторон были ключи и собеседники в поиске
  await openPrivateChat(sessions.alice.page, bob);
  await sendText(sessions.alice.page, `hello-bob-${suffix}`);
  await openPrivateChat(sessions.alice.page, carol);
  await sendText(sessions.alice.page, `hello-carol-${suffix}`);
  await openPrivateChat(sessions.bob.page, alice);
  await findMessageContainers(sessions.bob.page, `hello-bob-${suffix}`).first()
    .waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await openPrivateChat(sessions.carol.page, alice);
  await findMessageContainers(sessions.carol.page, `hello-carol-${suffix}`).first()
    .waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });

  // ── Личный чат: карточка у обоих, Боб принимает ──────────────────────────
  await openPrivateChat(sessions.alice.page, bob);
  const aliceCardA = await sendTaskOffer(sessions.alice.page, offerA, {
    day: today, start: '10:00', minutes: 60, steps: [stepText, 'второй шаг'],
  });
  // Шаги есть только у задачи: карточка со временем и шагами остаётся «Заданием»
  assert.equal(await aliceCardA.getAttribute('data-kind'), 'task');
  await aliceCardA.getByText('Task', { exact: true }).waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await aliceCardA.getByRole('button', { name: 'To plan' }).waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  const bobCardA = cardOf(sessions.bob.page, offerA);
  await bobCardA.waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  assert.match(await bobCardA.innerText(), new RegExp(stepText), 'шаги задания видны получателю');
  await bobCardA.getByRole('button', { name: 'To plan' }).click();
  await inPlanButton(bobCardA).waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await findMessageContainers(sessions.bob.page, 'Принято: задание').first()
    .waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await aliceCardA.getByText(`Accepted: ${bobName}`).waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await findMessageContainers(sessions.alice.page, 'Принято: задание').first()
    .waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await expectTaskInPlan(sessions.bob.page, offerA);
  // Повторное добавление не делает второй задачи: кнопка уже заменена на «В плане · открыть»
  assert.equal(await bobCardA.getByRole('button', { name: 'To plan' }).count(), 0);
  assert.equal(await bobCardA.getByRole('button', { name: 'Decline' }).count(), 0);
  console.log('OK: задание в личном чате добавлено — задача в плане, решение у отправителя');

  // ── «В плане · открыть» ведёт в «План» на день задачи ────────────────────
  await openPlanFromCard(sessions.bob.page, bobCardA, offerA, 'task');
  await bobCardA.waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  console.log('OK: «В плане · открыть» открывает «Сегодня» с задачей');

  // ── Второе устройство получателя: задача и «принято» после привязки ──────
  sessions.bob2 = await preparePage(bob2Context, bob, PASSWORD);
  await dismissRecoveryKeyDialog(sessions.bob2.page).catch(() => undefined);
  await linkSecondDevice(sessions.bob.page, sessions.bob2.page);
  await openPrivateChat(sessions.bob2.page, alice);
  const bob2CardA = cardOf(sessions.bob2.page, offerA);
  await bob2CardA.waitFor({ state: 'visible', timeout: SYNC_TIMEOUT_MS });
  await inPlanButton(bob2CardA).waitFor({ state: 'visible', timeout: SYNC_TIMEOUT_MS });
  await expectTaskInPlan(sessions.bob2.page, offerA);
  console.log('OK: второе устройство получателя видит задачу в плане и «В плане»');

  // ── Карточка со временем начала — «Событие»: отклонить, потом в календарь ─
  await openPrivateChat(sessions.alice.page, bob);
  const aliceCardB = await sendTaskOffer(sessions.alice.page, offerB, { day: today, start: '12:00', minutes: 30 });
  await openPrivateChat(sessions.bob.page, alice);
  const bobCardB = cardOf(sessions.bob.page, offerB);
  await bobCardB.waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  assert.equal(await bobCardB.getAttribute('data-kind'), 'event');
  await bobCardB.getByText('Event', { exact: true }).waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  assert.equal(await bobCardB.getByRole('button', { name: 'To plan' }).count(), 0, 'у события кнопка «В календарь»');
  await bobCardB.getByRole('button', { name: 'To calendar' }).waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await bobCardB.getByRole('button', { name: 'Decline' }).click();
  await bobCardB.getByText('Declined', { exact: true }).waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await aliceCardB.getByText(`Declined: ${bobName}`).waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await bobCardB.getByRole('button', { name: 'To calendar' }).click();
  await inPlanButton(bobCardB).waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await aliceCardB.getByText(`Accepted: ${bobName}`).waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await findMessageContainers(sessions.bob.page, 'Принято: событие').first()
    .waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await expectTaskInPlan(sessions.bob.page, offerB);
  // В плане — событие календаря, а не задача
  await openPlanFromCard(sessions.bob.page, bobCardB, offerB, 'event');
  console.log('OK: отклонённое событие можно добавить позже — событие в календаре, «открыть» ведёт к нему');

  // ── Группа: каждый решает сам, автор видит решения; «В мой план» ─────────
  const groupTitle = `Tasks ${suffix}`;
  await createGroupViaUi(sessions.alice.page, groupTitle, [bobName, carolName]);
  await openGroupChatByTitle(sessions.alice.page, groupTitle);
  await openGroupChatByTitle(sessions.bob.page, groupTitle);
  await openGroupChatByTitle(sessions.carol.page, groupTitle);
  const aliceCardG = await sendTaskOffer(sessions.alice.page, offerG, { day: today, minutes: 45 });
  const bobCardG = cardOf(sessions.bob.page, offerG);
  await bobCardG.waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await bobCardG.getByRole('button', { name: 'To plan' }).click();
  const carolCardG = cardOf(sessions.carol.page, offerG);
  await carolCardG.waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await carolCardG.getByRole('button', { name: 'Decline' }).click();
  await aliceCardG.getByText(`Accepted: ${bobName}`).waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await aliceCardG.getByText(`Declined: ${carolName}`).waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await aliceCardG.getByRole('button', { name: 'To plan' }).click();
  await sessions.alice.page.getByText('The task is in your plan').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await inPlanButton(aliceCardG).waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await expectTaskInPlan(sessions.alice.page, offerG);
  await expectTaskInPlan(sessions.bob.page, offerG);
  console.log('OK: групповое задание — решения на карточке автора, «В план» у автора');

  // ── SC-007: базы шардов без открытого текста задания ─────────────────────
  const leaks = plaintextLeaks([offerA, offerB, offerG, stepText]);
  assert.deepEqual(leaks, [], `открытый текст задания в базах: ${leaks.join(', ')}`);
  console.log('OK: базы шардов не содержат текста заданий');

  // ── Решения на месте после перезагрузки (кэш истории) ────────────────────
  await relogin(sessions.bob.page, PASSWORD).catch(() => undefined);
  await sessions.bob.page.locator('#FoldersSidebar').waitFor({ state: 'visible', timeout: 60000 });
  await openPrivateChat(sessions.bob.page, alice);
  await inPlanButton(cardOf(sessions.bob.page, offerA)).waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await inPlanButton(cardOf(sessions.bob.page, offerB)).waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await relogin(sessions.alice.page, PASSWORD).catch(() => undefined);
  await sessions.alice.page.locator('#FoldersSidebar').waitFor({ state: 'visible', timeout: 60000 });
  await openGroupChatByTitle(sessions.alice.page, groupTitle);
  await cardOf(sessions.alice.page, offerG).getByText(`Accepted: ${bobName}`)
    .waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  console.log('OK: решения по заданиям пережили перезагрузку');

  console.log('e2e_web_task_offer: OK');
} catch (error) {
  const dir = process.env.PARVANE_E2E_SHOT_DIR || process.env.PARVANE_E2E_BACKEND_LOG_DIR;
  if (dir) {
    for (const [name, s] of Object.entries(sessions)) {
      try {
        await s.page?.screenshot({ path: `${dir}/task-offer-${name}.png` });
        const dump = await s.page?.evaluate(() => {
          const modals = [...document.querySelectorAll('.Modal')].map((m) => {
            const dialog = m.querySelector('.modal-dialog');
            const button = [...m.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Send');
            const rect = button?.getBoundingClientRect();
            const hit = rect ? document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2) : undefined;
            const chain = [];
            for (let el = button; el && el !== m; el = el.parentElement) {
              const r = el.getBoundingClientRect();
              chain.push(`${el.tagName}.${String(el.className).slice(0, 40)}@${Math.round(r.x)},${Math.round(r.y)}:${Math.round(r.width)}`);
            }
            return {
              className: m.className,
              dialog: dialog ? JSON.stringify(dialog.getBoundingClientRect()) : undefined,
              dialogClass: dialog?.className,
              button: rect ? JSON.stringify(rect) : undefined,
              hit: hit ? `${hit.tagName}.${hit.className}` : undefined,
              chain,
            };
          });
          return JSON.stringify({ modals, portals: document.getElementById('portals')?.children.length });
        });
        console.log(`--- модальные окна ${name}: ${dump}`);
      } catch (dumpError) {
        console.log(`--- дамп ${name} не удался: ${String(dumpError)}`);
      }
      console.log(`--- журнал ${name} ---\n${(s.logs || []).slice(-40).join('\n')}`);
    }
  }
  throw error;
} finally {
  await browser.close();
}
