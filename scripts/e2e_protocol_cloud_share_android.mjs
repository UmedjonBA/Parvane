// Совместные папки «Облака» web ↔ Telegram X (ревью 7 ноя 2026, B7): окно «Доступ» и ответ на приглашение на
// Android — нажатиями по экрану X (дерево uiautomator), а не e2e-хуком. Запускается из
// `android/tgx_protocol_web_flow.sh` после e2e_protocol_mixed_android.mjs (стек, эмулятор и vite preview подняты,
// X — alice). Web — новый аккаунт `wcs-<метка>`.
//   1) web создаёт совместную папку и зовёт alice читателем → у X строка приглашения, «Принять» → папка в «Доступных мне»;
//   2) X: «Новая общая папка» → окно «Доступ» → ник web → «Добавить» → web принимает приглашение;
//      X меняет права на «Правка» → у web появляется загрузка; X убирает участника → папка у web исчезает.
// Строки `ok …` / `FAIL …` в stdout разбирает раннер. Имена — выдуманные.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { chromium } from '../web/telegram-tt/node_modules/playwright/index.mjs';

import { cloudDriver } from './e2e_web_cloud_lib.mjs';
import {
  dismissRecoveryKeyDialog,
  findMessage,
  LOGIN_TIMEOUT_MS,
  openPrivateChatStrict,
  preparePage,
  sendText,
} from './e2e_web_helpers.mjs';

const PASSWORD = 'Parvane-cloud-share-android-1';
const OUT = process.env.PV_ANDROID_OUT;
const STAMP = (process.env.PV_STAMP || String(Date.now())).slice(-6);
const ALICE = 'alice@local';
const X_TIMEOUT_MS = 120000;
const SYNC_MS = 90000;
const PKG = 'org.parvane.tgx';

function adb(...args) {
  return execFileSync('adb', args, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, timeout: 60000 });
}
const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });

function xCommand(command) {
  const file = join(OUT, 'cmd-cloud');
  writeFileSync(file, JSON.stringify(command));
  adb('push', file, '/data/local/tmp/parvane-e2e-cmd');
  adb('shell', 'chmod', '644', '/data/local/tmp/parvane-e2e-cmd');
}

// Журнал X — файл, который пишет раннер (`adb logcat` в TGX_LOG, только растёт; кольцевой буфер `logcat -d`
// за длинную пару успевает провернуться). Отметка — длина файла
const TGX_LOG = process.env.TGX_LOG;
const xLog = () => { try { return readFileSync(TGX_LOG, 'utf8'); } catch { return ''; } };
let mark = 0;
function xMark() { mark = xLog().length; }
async function xWait(re, label, ms = X_TIMEOUT_MS) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    const lines = xLog().slice(mark).split('\n');
    if (lines.some((l) => re.test(l))) return;
    // eslint-disable-next-line no-await-in-loop
    await sleep(2000);
  }
  throw new Error(`${label}: нет в logcat X (${re})`);
}

// ── экран X по дереву uiautomator ───────────────────────────────────────────────
const unescapeXml = (v) => v.replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n))).replace(/&amp;/g, '&');
function uiNodes() {
  try {
    adb('shell', 'uiautomator', 'dump', '/sdcard/pv-ui-cloud.xml');
  } catch {
    return [];
  }
  const xml = adb('exec-out', 'cat', '/sdcard/pv-ui-cloud.xml');
  return [...xml.matchAll(/<node\b([^>]*)>/g)].map((m) => {
    const attrs = {};
    for (const a of m[1].matchAll(/([\w-]+)="([^"]*)"/g)) attrs[a[1]] = unescapeXml(a[2]);
    return attrs;
  });
}
function center(node) {
  const m = /\[(\d+),(\d+)\]\[(\d+),(\d+)\]/.exec(node.bounds || '');
  return m ? [Math.round((+m[1] + +m[3]) / 2), Math.round((+m[2] + +m[4]) / 2)] : undefined;
}
function uiFind(re, nodes = uiNodes()) {
  return nodes.find((n) => ['text', 'content-desc'].some((k) => re.test(n[k] || '')) && center(n));
}
async function uiWait(re, label, ms = 20000) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    const n = uiFind(re);
    if (n) return n;
    // eslint-disable-next-line no-await-in-loop
    await sleep(1000);
  }
  throw new Error(`${label}: нет на экране X (${re})`);
}
async function uiTap(re, label, ms) {
  const [x, y] = center(await uiWait(re, label, ms));
  adb('shell', 'input', 'tap', String(x), String(y));
  await sleep(1200);
}
async function uiType(text) {
  // `input text` — только ASCII без пробелов (имена сценария такие)
  adb('shell', 'input', 'text', text);
  await sleep(800);
}
async function uiTapField(label) {
  const field = uiNodes().find((n) => n.class === 'android.widget.EditText' && center(n));
  assert(field, `${label}: нет поля ввода на экране X`);
  const [x, y] = center(field);
  adb('shell', 'input', 'tap', String(x), String(y));
  await sleep(800);
}
// Клавиатура поднята (окно IME есть) — убрать её «Назад»: на эмуляторе без экрана окно IME не рисуется и лист не
// сдвигается, но нажатия в нижней части экрана забирает IME (fix9d/fix9e: «Создать» трижды мимо, лист остался)
async function hideKeyboard() {
  let shown = false;
  try {
    shown = /mInputShown=true/.test(adb('shell', 'dumpsys', 'input_method'));
  } catch {
    shown = false;
  }
  if (!shown) return;
  adb('shell', 'input', 'keyevent', '4');
  await sleep(1200);
}
// Кнопка листа под полем ввода: перед нажатием убрать клавиатуру; нажимать, пока в logcat нет ответа (до трёх раз).
// Лист бывает ужат вставкой IME, которой на эмуляторе без экрана не видно: кнопки в дереве нулевого размера
// (m14, 11 ноя: «Create» [0,0][0,0], нажатия мимо) — со второй попытки форма отправляется действием редактора
// (фокус в поле и Enter)
async function uiTapUntilLog(re, label, logRe) {
  for (let i = 0; i < 3; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await hideKeyboard();
    if (i === 0 && uiFind(re)) {
      // eslint-disable-next-line no-await-in-loop
      await uiTap(re, label);
    } else {
      // eslint-disable-next-line no-await-in-loop
      await uiTapField(label);
      adb('shell', 'input', 'keyevent', '66');
      // eslint-disable-next-line no-await-in-loop
      await sleep(1200);
    }
    const start = Date.now();
    while (Date.now() - start < 8000) {
      if (xLog().slice(mark).split('\n').some((l) => logRe.test(l))) return;
      // eslint-disable-next-line no-await-in-loop
      await sleep(1000);
    }
  }
}
// Экран «Файлы» X: панель разделов → «Знания» → вкладка «Файлы»
async function openXFiles() {
  adb('shell', 'am', 'start', '-n', `${PKG}/org.thunderdog.challegram.MainActivity`);
  await sleep(2500);
  await uiTap(/^(Знания|Knowledge)$/, 'вкладка «Знания»');
  await uiTap(/^(Файлы|Files)$/, 'вкладка «Файлы»');
  await sleep(1500);
  // «Файлы» помнят место: из принятой папки «Назад» ведёт в «Облако / Доступные мне», а не в корень (fix9c) —
  // в корень по первой части пути, если X не там
  const crumb = uiFind(/^(Облако|Cloud)$/);
  if (crumb && !uiFind(/^(Новая общая папка|New shared folder)$/)) {
    const [x, y] = center(crumb);
    adb('shell', 'input', 'tap', String(x), String(y));
    await sleep(1500);
  }
}

function ok(text) {
  console.log(`ok ${text}`);
}

const browser = await chromium.launch();
const context = await browser.newContext();
const logs = [];
context.on('page', (page) => {
  page.on('console', (m) => {
    const t = m.text();
    if (t.includes('[parvane] v2')) logs.push(t);
  });
});
try {
  assert(OUT, 'PV_ANDROID_OUT is required');
  assert(TGX_LOG, 'TGX_LOG is required');
  const web = `wcs-${STAMP}@local`;
  const webNick = web.split('@')[0];
  const { page } = await preparePage(context, web, PASSWORD);
  const start = Date.now();
  while (!logs.some((l) => l.includes('v2: готов'))) {
    assert(Date.now() - start < LOGIN_TIMEOUT_MS, `web: v2 не поднялся (${logs.join(' | ')})`);
    // eslint-disable-next-line no-await-in-loop
    await sleep(200);
  }
  await dismissRecoveryKeyDialog(page);
  // Переписка с alice — чтобы alice была в выборе собеседника web, а web — среди известных X
  await openPrivateChatStrict(page, ALICE);
  const hello = `cloud-share-hello-${STAMP}`;
  await sendText(page, hello);
  await findMessage(page, hello).waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  ok('web: новый аккаунт написал alice');
  xCommand({ op: 'sections', section: 'knowledge' });

  // 1) web → X: приглашение читателем, X принимает кнопкой
  const WF = `WebShare${STAMP}`;
  const cloud = cloudDriver(page);
  await cloud.open();
  await cloud.add('New shared folder');
  await page.locator('#parvane-cloud-shared-name').fill(WF);
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  const dialog = page.locator('.Modal .modal-dialog').filter({ hasText: 'Access to' }).filter({ hasText: WF });
  await dialog.waitFor({ state: 'visible', timeout: SYNC_MS });
  await dialog.locator('select[data-new-role]').selectOption({ label: 'Reader' });
  await dialog.getByRole('button', { name: 'Add people', exact: true }).click();
  await page.locator('.Modal .ChatOrUserPicker-item').filter({ hasText: 'alice' }).first().click();
  await dialog.locator(`[data-member="${ALICE}"]`).waitFor({ state: 'visible', timeout: SYNC_MS });
  await dialog.getByRole('button', { name: 'Close', exact: true }).last().click();
  ok('web: alice приглашена читателем');
  xMark();
  await xWait(new RegExp(`cloud: status=ready .*папки=\\[[^\\]]*${WF}:invite`), 'приглашение web у X');
  await openXFiles();
  await uiWait(new RegExp(`(приглашает в «${WF}»|invites you to “${WF}”)`), 'строка приглашения');
  ok('X: строка приглашения с «Принять» / «Отклонить» в «Облаке»');
  xMark();
  await uiTap(/^(Принять|Accept)$/, 'кнопка «Принять»');
  await xWait(/облако: доступ accept → ok/, 'ответ на приглашение');
  await xWait(new RegExp(`cloud: status=ready .*папки=\\[[^\\]]*${WF}:shared`), 'принятая папка у X');
  ok('X: приглашение принято кнопкой — папка web в «Доступных мне»');
  adb('shell', 'input', 'keyevent', '4'); // из принятой папки — в корень «Облака»
  await sleep(1500);

  // 2) X → web: новая общая папка, «Доступ», ник web, «Добавить»
  const XF = `XShare${STAMP}`;
  await openXFiles();
  xMark();
  await uiTap(/^(Новая общая папка|New shared folder)$/, 'чип «Новая общая папка»');
  await uiTapField('имя общей папки');
  await uiType(XF);
  await uiTapUntilLog(/^(Создать|Create)$/, 'кнопка «Создать»', /облако: доступ create →/);
  await xWait(/облако: доступ create → ok/, 'создание общей папки X');
  await uiWait(/^(Пока доступ только у вас|Only you have access so far)$/, 'окно «Доступ» новой папки', 60000);
  ok('X: общая папка создана, окно «Доступ» открылось');
  await uiTapField('ник участника');
  await uiType(webNick);
  xMark();
  await uiTapUntilLog(/^(Добавить|Add people)$/, 'кнопка «Добавить»', /облако: доступ share →/);
  await xWait(/облако: доступ share → ok/, 'приглашение из X');
  await uiWait(new RegExp(`^(Права|Role): `), 'строка участника в окне «Доступ»', 60000);
  ok('X: web добавлен читателем, строка участника в окне');
  await cloud.root();
  const invite = cloud.folderRow(XF);
  await invite.waitFor({ state: 'visible', timeout: SYNC_MS });
  assert.equal(await invite.getAttribute('data-container-kind'), 'invite', 'у web — приглашение');
  await invite.getByRole('button', { name: 'Accept', exact: true }).click();
  await cloud.cloud.locator('nav').getByRole('button', { name: XF, exact: true }).waitFor({ state: 'visible', timeout: SYNC_MS });
  assert.equal(await cloud.cloud.getByRole('button', { name: 'Upload', exact: true }).count(), 0, 'читатель не загружает');
  ok('web: приглашение X принято, папка открыта читателем');

  // Права «Правка»: у web появляется загрузка
  xMark();
  await uiTap(/^(Права|Role): /, 'права участника');
  await xWait(/облако: доступ role → ok/, 'смена прав из X');
  await cloud.cloud.getByRole('button', { name: 'Upload', exact: true }).waitFor({ state: 'visible', timeout: SYNC_MS });
  ok('X: права участника → «Правка», у web появилась загрузка');

  // Убрать участника: папка у web исчезает
  xMark();
  await uiTap(/^(Убрать|Remove): /, 'убрать участника');
  await xWait(/облако: доступ remove → ok/, 'удаление участника из X');
  await uiWait(/^(Пока доступ только у вас|Only you have access so far)$/, 'окно после удаления участника', 60000);
  await cloud.root();
  await cloud.openShared();
  await cloud.cloud.getByText('No one has shared a folder with you yet').waitFor({ state: 'visible', timeout: SYNC_MS });
  ok('X: участник убран — у web папки больше нет');
  adb('shell', 'input', 'keyevent', '4'); // закрыть окно «Доступ»
  console.log('e2e_protocol_cloud_share_android: OK');
} catch (error) {
  console.log(`FAIL ${String(error?.message || error).split('\n')[0]}`);
  await context.pages()[0]?.screenshot({ path: join(OUT || '.', 'web-cloud-share.png') }).catch(() => undefined);
  console.error(`v2 журнал web: ${logs.join('\n')}`);
  throw error;
} finally {
  await browser.close();
}
