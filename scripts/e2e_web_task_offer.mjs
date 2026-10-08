// Задание в чат (spec 011, US3, правило TASK-1). Личный чат: карточка задания у
// обоих, «Принять» на втором устройстве создаёт задачу в «Плане» и шлёт
// ответ-статус; привязанное второе устройство получателя видит задачу и
// «принято»; «Отклонить», затем «Принять»; группа из трёх — решения каждого на
// карточке автора; «В мой план» у автора; базы шардов без открытого текста
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
  if (!(await planner.count())) {
    await page.locator('#FoldersSidebar').getByRole('tab', { name: 'Planner' }).click();
  }
  await planner.waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  return planner;
}

async function closePlanner(page) {
  await page.locator('#FoldersSidebar').getByRole('tab', { name: 'Chats' }).click();
  await page.locator('#ParvanePlanner').waitFor({ state: 'detached', timeout: STEP_TIMEOUT_MS });
}

/** Задача есть в расписании сегодняшнего дня (панель дня). */
async function expectTaskInPlan(page, name, timeout = SYNC_TIMEOUT_MS) {
  const planner = await openPlanner(page);
  await planner.getByText('Calendar', { exact: true }).first().click();
  await planner.locator(`[data-day="${todayKey()}"]`).click({ position: { x: 10, y: 10 } });
  await planner.getByText('Schedule', { exact: true }).first().click();
  await planner.locator('aside').getByRole('button', { name, exact: false }).first()
    .waitFor({ state: 'visible', timeout })
    .catch(() => assert.fail(`${name}: ожидалось в расписании дня`));
  const rows = await planner.locator('aside').getByRole('button', { name, exact: false }).count();
  assert.equal(rows, 1, `${name}: задача должна быть в плане ровно один раз`);
  await closePlanner(page);
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
  await aliceCardA.getByRole('button', { name: 'To my plan' }).waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  const bobCardA = cardOf(sessions.bob.page, offerA);
  await bobCardA.waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  assert.match(await bobCardA.innerText(), new RegExp(stepText), 'шаги задания видны получателю');
  await bobCardA.getByRole('button', { name: 'Accept' }).click();
  await bobCardA.getByText('In your plan').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await findMessageContainers(sessions.bob.page, 'Принято: задание').first()
    .waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await aliceCardA.getByText(`Accepted: ${bobName}`).waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await findMessageContainers(sessions.alice.page, 'Принято: задание').first()
    .waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await expectTaskInPlan(sessions.bob.page, offerA);
  // Повторное принятие не делает второй задачи: кнопка уже заменена статусом
  assert.equal(await bobCardA.getByRole('button', { name: 'Accept' }).count(), 0);
  console.log('OK: задание в личном чате принято — задача в плане, решение у отправителя');

  // ── Второе устройство получателя: задача и «принято» после привязки ──────
  sessions.bob2 = await preparePage(bob2Context, bob, PASSWORD);
  await dismissRecoveryKeyDialog(sessions.bob2.page).catch(() => undefined);
  await linkSecondDevice(sessions.bob.page, sessions.bob2.page);
  await openPrivateChat(sessions.bob2.page, alice);
  const bob2CardA = cardOf(sessions.bob2.page, offerA);
  await bob2CardA.waitFor({ state: 'visible', timeout: SYNC_TIMEOUT_MS });
  await bob2CardA.getByText('In your plan').waitFor({ state: 'visible', timeout: SYNC_TIMEOUT_MS });
  await expectTaskInPlan(sessions.bob2.page, offerA);
  console.log('OK: второе устройство получателя видит задачу в плане и «принято»');

  // ── Отклонить, потом всё же принять ──────────────────────────────────────
  await openPrivateChat(sessions.alice.page, bob);
  const aliceCardB = await sendTaskOffer(sessions.alice.page, offerB, { day: today, start: '12:00', minutes: 30 });
  await openPrivateChat(sessions.bob.page, alice);
  const bobCardB = cardOf(sessions.bob.page, offerB);
  await bobCardB.waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await bobCardB.getByRole('button', { name: 'Decline' }).click();
  await bobCardB.getByText('Declined', { exact: true }).waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await aliceCardB.getByText(`Declined: ${bobName}`).waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await bobCardB.getByRole('button', { name: 'Accept' }).click();
  await bobCardB.getByText('In your plan').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await aliceCardB.getByText(`Accepted: ${bobName}`).waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await expectTaskInPlan(sessions.bob.page, offerB);
  console.log('OK: отклонённое задание можно принять позже');

  // ── Группа: каждый решает сам, автор видит решения; «В мой план» ─────────
  const groupTitle = `Tasks ${suffix}`;
  await createGroupViaUi(sessions.alice.page, groupTitle, [bobName, carolName]);
  await openGroupChatByTitle(sessions.alice.page, groupTitle);
  await openGroupChatByTitle(sessions.bob.page, groupTitle);
  await openGroupChatByTitle(sessions.carol.page, groupTitle);
  const aliceCardG = await sendTaskOffer(sessions.alice.page, offerG, { day: today, minutes: 45 });
  const bobCardG = cardOf(sessions.bob.page, offerG);
  await bobCardG.waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await bobCardG.getByRole('button', { name: 'Accept' }).click();
  const carolCardG = cardOf(sessions.carol.page, offerG);
  await carolCardG.waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await carolCardG.getByRole('button', { name: 'Decline' }).click();
  await aliceCardG.getByText(`Accepted: ${bobName}`).waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await aliceCardG.getByText(`Declined: ${carolName}`).waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await aliceCardG.getByRole('button', { name: 'To my plan' }).click();
  await sessions.alice.page.getByText('The task is in your plan').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await expectTaskInPlan(sessions.alice.page, offerG);
  await expectTaskInPlan(sessions.bob.page, offerG);
  console.log('OK: групповое задание — решения на карточке автора, «В мой план»');

  // ── SC-007: базы шардов без открытого текста задания ─────────────────────
  const leaks = plaintextLeaks([offerA, offerB, offerG, stepText]);
  assert.deepEqual(leaks, [], `открытый текст задания в базах: ${leaks.join(', ')}`);
  console.log('OK: базы шардов не содержат текста заданий');

  // ── Решения на месте после перезагрузки (кэш истории) ────────────────────
  await relogin(sessions.bob.page, PASSWORD).catch(() => undefined);
  await sessions.bob.page.locator('#FoldersSidebar').waitFor({ state: 'visible', timeout: 60000 });
  await openPrivateChat(sessions.bob.page, alice);
  await cardOf(sessions.bob.page, offerA).getByText('In your plan').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
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
