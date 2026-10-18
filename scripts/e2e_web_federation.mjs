// Федерация (spec 028) в браузере: Аня и Вера на сервере A, Борис на сервере B (одна сборка web, у каждого
// сервера свой gateway). Истории спеки в браузере:
//   1 — личный чат: Аня находит Бориса по полному адресу `ник@сервер`, переписка в обе стороны, история;
//   2 — группа на сервере A с участником с B: сообщения всех троих видят все;
//   3 — личный звонок A ↔ B и групповой звонок группы с участниками с обоих серверов;
//   4 — совместная папка облака на A, редактор с B: файлы с обоих серверов скачиваются обеими сторонами;
//   2б — ссылка-приглашение в группу сервера A: Борис (B) получает её в чате, нажимает и вступает.
// Запуск: scripts/run_web_federation_e2e.sh (поднимает оба сервера).
import assert from 'node:assert/strict';

import { chromium } from '../web/telegram-tt/node_modules/playwright/index.mjs';

import { CLOUD_STEP_TIMEOUT_MS, cloudDriver } from './e2e_web_cloud_lib.mjs';
import {
  dismissRecoveryKeyDialog, exchangeMessages, expectMediaFlowing, findMessage, findMessageContainer, preparePage,
  readInvitesScreen, sendText,
} from './e2e_web_helpers.mjs';

const PASSWORD = 'Parvane-federation-e2e-1';
const STEP_TIMEOUT_MS = 30000;
const SYNC_TIMEOUT_MS = 60000;
const gatewayB = process.env.PARVANE_E2E_GATEWAY_URL_B;
const domainA = process.env.PARVANE_E2E_DOMAIN_A;
const domainB = process.env.PARVANE_E2E_DOMAIN_B;
assert(gatewayB && domainA && domainB, 'нужны PARVANE_E2E_GATEWAY_URL_B, PARVANE_E2E_DOMAIN_A, PARVANE_E2E_DOMAIN_B');

const suffix = Date.now().toString(36);
const anya = `anya-${suffix}@${domainA}`;
const vera = `vera-${suffix}@${domainA}`;
const boris = `boris-${suffix}@${domainB}`;
const nick = (address) => address.split('@')[0];
const groupTitle = `Fed-${suffix.slice(-6)}`;
const linkGroupTitle = `FedLink-${suffix.slice(-6)}`;
const FOLDER = 'Общая папка двух серверов';
const FILE_A = 'с-сервера-a.txt';
const FILE_B = 'с-сервера-b.txt';
const CONTENT_A = 'Файл Ани, лежит на сервере A 5c1d';
const CONTENT_B = 'Файл Бориса, лежит на сервере B 7e2f';

/** Открыть чат по полному адресу (поиск находит пользователя другого сервера у его сервера). */
async function openByAddress(page, address) {
  const search = page.locator('#telegram-search-input');
  const pane = page.locator('.LeftSearch');
  for (let attempt = 0; attempt < 3; attempt++) {
    await search.click();
    if (await pane.waitFor({ state: 'visible', timeout: 3000 }).then(() => true).catch(() => false)) break;
    await search.evaluate((el) => el.blur());
  }
  await search.fill(address);
  const result = page.locator('.LeftSearch .search-result').filter({ hasText: nick(address) }).first();
  await result.waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await result.locator('.ListItem-button').click();
  await page.locator('#editable-message-text[contenteditable="true"]').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await page.locator('.MiddleHeader').getByText(nick(address)).first().waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
}

/** Чат из списка по названию (личный — по нику собеседника). */
async function openListed(page, title) {
  await page.locator('#FoldersSidebar').getByRole('tab', { name: 'Chats' }).click().catch(() => undefined);
  // По названию чата, а не по тексту строки: превью группы содержит ник автора
  const item = page.locator('#LeftColumn .ListItem')
    .filter({ has: page.locator('.fullName', { hasText: new RegExp(`^${title}$`) }) }).first();
  await item.waitFor({ state: 'visible', timeout: SYNC_TIMEOUT_MS });
  await item.locator('.ListItem-button').click();
  await page.locator('.MiddleHeader').getByText(title).first().waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  // Во время смены чата в DOM два композера — ждём композер активного слайда
  await page.locator('.Transition_slide-active #editable-message-text[contenteditable="true"]').last()
    .waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
}

async function selectPickerRow(page, name) {
  const row = page.locator('#LeftColumn .PeerPickerItem, #LeftColumn .ItemPickerItem').filter({ hasText: name }).first();
  await row.waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  for (let attempt = 0; attempt < 6; attempt++) {
    if (await row.locator('input[type="checkbox"]:checked').count()) return;
    if (attempt % 2 === 0) await row.press(' ').catch(() => {});
    else await row.click({ force: true }).catch(() => {});
    await page.waitForTimeout(500);
  }
  assert.fail(`строка выбора ${name} не отмечается`);
}

async function createGroup(page, members, title) {
  await page.mouse.move(800, 360);
  await page.waitForTimeout(200);
  await page.locator('#LeftColumn').hover();
  await page.getByRole('button', { name: 'New Message' }).click();
  await page.getByRole('menuitem', { name: 'New Group' }).click();
  const search = page.locator('#new-group-picker-search');
  await search.waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  for (const member of members) {
    await search.fill(nick(member));
    await selectPickerRow(page, nick(member));
  }
  await page.getByRole('button', { name: 'Continue To Group Info' }).click();
  const nameInput = page.getByLabel('Group name').locator('visible=true').first();
  await nameInput.waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  for (let attempt = 0; attempt < 5 && await nameInput.inputValue() !== title; attempt++) {
    await nameInput.fill(title);
    await page.waitForTimeout(300);
  }
  await page.getByRole('button', { name: 'Create Group' }).click();
  await page.locator('#editable-message-text').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
}

// «Печатает»: набор в композере `from` → индикатор в шапке чата у `to` (R14, через шард federation).
async function typingProbe(from, to, label) {
  const composer = from.locator('.Transition_slide-active #editable-message-text').last();
  await composer.pressSequentially('typing-probe', { delay: 60 });
  await to.locator('.MiddleHeader').getByText(/typing/i).first()
    .waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS })
    .catch(() => assert.fail(`${label}: «печатает» не показан`));
  await composer.fill('');
  console.log(`OK: ${label}`);
}

async function waitActivePeers(page, count, label) {
  await page.waitForFunction(
    (expected) => document.querySelectorAll('[data-peer-state="active"]').length === expected,
    count,
    { timeout: SYNC_TIMEOUT_MS },
  ).catch(() => assert.fail(`${label}: не дождались ${count} активных участников звонка`));
}

const browser = await chromium.launch({
  args: [
    '--use-fake-ui-for-media-stream',
    '--use-fake-device-for-media-stream',
    '--autoplay-policy=no-user-gesture-required',
    '--allow-loopback-in-peer-connection',
  ],
});
const newContext = () => browser.newContext({
  permissions: ['microphone', 'camera'], viewport: { width: 1440, height: 900 }, acceptDownloads: true,
});
const sessions = {};
try {
  sessions.anya = await preparePage(await newContext(), anya, PASSWORD);
  sessions.boris = await preparePage(await newContext(), boris, PASSWORD, { gatewayUrl: gatewayB });
  sessions.vera = await preparePage(await newContext(), vera, PASSWORD);
  const a = sessions.anya.page;
  const b = sessions.boris.page;
  const v = sessions.vera.page;
  for (const page of [a, b, v]) await dismissRecoveryKeyDialog(page).catch(() => undefined);

  // ── История 1: личный чат между серверами ───────────────────────────────
  await openByAddress(a, boris);
  console.log('OK: пользователь другого сервера найден по полному адресу');
  await sendText(a, 'привет с сервера A');
  await openListed(b, nick(anya));
  await findMessage(b, 'привет с сервера A').first().waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  console.log('OK: письмо дошло до сервера B');
  await sendText(b, 'ответ с сервера B');
  await findMessage(a, 'ответ с сервера B').first().waitFor({ state: 'visible', timeout: SYNC_TIMEOUT_MS });
  console.log('OK: ответ дошёл до сервера A');
  await a.reload({ waitUntil: 'domcontentloaded' });
  await openListed(a, nick(boris));
  await findMessage(a, 'ответ с сервера B').first().waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  console.log('OK: история переписки между серверами пережила перезагрузку');
  await typingProbe(b, a, '«печатает» Бориса (B) видит Аня (A)');
  await typingProbe(a, b, '«печатает» Ани (A) видит Борис (B)');

  // ── История 2: группа на A с участником с B ─────────────────────────────
  await exchangeMessages(a, anya, v, vera, `fed-${suffix}`);
  await createGroup(a, [boris, vera], groupTitle);
  await sendText(a, 'группа: Аня (A)');
  for (const [label, page] of [['Борис (B)', b], ['Вера (A)', v]]) {
    await openListed(page, groupTitle).catch(() => assert.fail(`${label}: группа не появилась`));
    await findMessage(page, 'группа: Аня (A)').first().waitFor({ state: 'visible', timeout: SYNC_TIMEOUT_MS });
  }
  await sendText(b, 'группа: Борис (B)');
  await sendText(v, 'группа: Вера (A)');
  for (const page of [a, v]) {
    await findMessage(page, 'группа: Борис (B)').first().waitFor({ state: 'visible', timeout: SYNC_TIMEOUT_MS });
  }
  for (const page of [a, b]) {
    await findMessage(page, 'группа: Вера (A)').first().waitFor({ state: 'visible', timeout: SYNC_TIMEOUT_MS });
  }
  console.log('OK: группа с участниками двух серверов — сообщения всех троих видят все');
  // Все трое в группе: Борис — запрос на сервер группы A, Аня — рассылка на B.
  await openListed(a, groupTitle);
  await typingProbe(b, a, '«печатает» Бориса (B) в группе сервера A видит Аня');
  await typingProbe(a, b, '«печатает» Ани в группе сервера A видит Борис (B)');

  // ── История 3: личный звонок A ↔ B ──────────────────────────────────────
  await openListed(a, nick(boris));
  await a.getByRole('button', { name: 'Call', exact: true }).click();
  await b.getByText('is calling you...', { exact: true }).waitFor({ state: 'visible', timeout: SYNC_TIMEOUT_MS });
  await b.getByRole('button', { name: 'Accept' }).click();
  for (const page of [a, b]) {
    await page.getByText(/^\d+:\d{2}$/).first().waitFor({ state: 'visible', timeout: SYNC_TIMEOUT_MS });
  }
  await expectMediaFlowing(a, { audio: true });
  await expectMediaFlowing(b, { audio: true });
  await a.getByRole('button', { name: 'End Call' }).click();
  await b.getByRole('button', { name: 'End Call' }).waitFor({ state: 'detached', timeout: STEP_TIMEOUT_MS });
  console.log('OK: личный звонок между серверами — звук в обе стороны');

  // Групповой звонок: Аня (A) зовёт, Борис (B) и Вера (A) принимают — пары A↔B и A↔A
  await openListed(a, groupTitle);
  await a.getByRole('button', { name: 'Call', exact: true }).click();
  await a.getByText('Group Call', { exact: true }).waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  for (const page of [b, v]) {
    await page.getByText(`${groupTitle}: group call`, { exact: true }).waitFor({ state: 'visible', timeout: SYNC_TIMEOUT_MS });
    await page.getByRole('button', { name: 'Accept' }).click();
  }
  await waitActivePeers(a, 2, 'Аня');
  await waitActivePeers(b, 2, 'Борис');
  await waitActivePeers(v, 2, 'Вера');
  for (const page of [a, b, v]) await expectMediaFlowing(page, { audio: true, minPeers: 2 });
  await a.getByRole('button', { name: 'End Call' }).click();
  await a.getByText('Group Call', { exact: true }).waitFor({ state: 'detached', timeout: STEP_TIMEOUT_MS });
  for (const page of [b, v]) {
    await page.getByRole('button', { name: 'End Call' }).click().catch(() => undefined);
  }
  console.log('OK: групповой звонок с участниками двух серверов — звук у всех троих');

  // ── История 4: совместная папка облака на A, редактор с B ───────────────
  const ac = cloudDriver(a);
  const bc = cloudDriver(b);
  const shareDialog = a.locator('.Modal .modal-dialog').filter({ hasText: 'Access to' }).filter({ hasText: FOLDER });
  await ac.open();
  await ac.add('New shared folder');
  await a.locator('#parvane-cloud-shared-name').fill(FOLDER);
  await a.getByRole('button', { name: 'Create', exact: true }).click();
  await shareDialog.waitFor({ state: 'visible', timeout: CLOUD_STEP_TIMEOUT_MS });
  await shareDialog.locator('select[data-new-role]').selectOption({ label: 'Editor' });
  await shareDialog.getByRole('button', { name: 'Add people', exact: true }).click();
  const picker = a.locator('.Modal').filter({ has: a.locator('.ChatOrUserPicker-item') });
  await picker.locator('.ChatOrUserPicker-item').filter({ hasText: nick(boris) }).first().click();
  await shareDialog.locator(`[data-member="${boris}"]`).waitFor({ state: 'visible', timeout: CLOUD_STEP_TIMEOUT_MS });
  await shareDialog.getByRole('button', { name: 'Close', exact: true }).last().click();
  await ac.folderRow(FOLDER).click();
  await ac.upload(FILE_A, CONTENT_A);
  console.log('OK: совместная папка на A, участник с B приглашён редактором');

  await bc.open();
  const inviteRow = bc.folderRow(FOLDER);
  await inviteRow.waitFor({ state: 'visible', timeout: SYNC_TIMEOUT_MS });
  await inviteRow.getByRole('button', { name: 'Accept', exact: true }).click();
  await bc.item(FILE_A).waitFor({ state: 'visible', timeout: SYNC_TIMEOUT_MS });
  assert.equal((await bc.download(FILE_A)).toString(), CONTENT_A, 'Борис (B) скачивает файл с сервера A');
  await bc.upload(FILE_B, CONTENT_B);
  console.log('OK: редактор с B принял папку, скачал файл с A и загрузил свой');

  await ac.item(FILE_B).waitFor({ state: 'visible', timeout: SYNC_TIMEOUT_MS });
  assert.equal((await ac.download(FILE_B)).toString(), CONTENT_B, 'Аня (A) скачивает файл с сервера B');
  console.log('OK: владелец с A скачал файл редактора с сервера B');

  // ── История 2б: ссылка-приглашение в группу другого сервера ────────────
  await ac.close();
  await bc.close();
  await createGroup(a, [vera], linkGroupTitle);
  const link = await readInvitesScreen(a, linkGroupTitle);
  assert.match(link, new RegExp(`^https://${domainA.replace(/\./g, '\\.')}/join/`), `ссылка с доменом сервера A: ${link}`);
  await openListed(a, nick(boris));
  await sendText(a, link);
  await openListed(b, nick(anya));
  const linkMessage = findMessageContainer(b, link.split('#')[0].replace(/^https:\/\//, ''));
  await linkMessage.waitFor({ state: 'visible', timeout: SYNC_TIMEOUT_MS });
  await linkMessage.locator('a[href*="/join/"]').first().click();
  const joinModal = b.locator('.Modal .modal-dialog').filter({ has: b.getByRole('button', { name: /join group/i }) }).first();
  await joinModal.waitFor({ state: 'visible', timeout: SYNC_TIMEOUT_MS });
  await joinModal.getByText(linkGroupTitle).first().waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await joinModal.getByRole('button', { name: /join group/i }).first().click();
  await b.locator('.MiddleHeader').getByText(linkGroupTitle).first().waitFor({ state: 'visible', timeout: SYNC_TIMEOUT_MS });
  // После вступления по ссылке на экране два композера (уходящий и новый слайд) — пишем в активный
  const composer = b.locator('.Transition_slide-active #editable-message-text').last();
  await composer.waitFor({ state: 'visible', timeout: SYNC_TIMEOUT_MS });
  await composer.fill('вступил по ссылке с сервера B');
  await composer.press('Enter');
  await openListed(v, linkGroupTitle);
  await findMessage(v, 'вступил по ссылке с сервера B').first().waitFor({ state: 'visible', timeout: SYNC_TIMEOUT_MS });
  await openListed(a, linkGroupTitle);
  await findMessage(a, 'вступил по ссылке с сервера B').first().waitFor({ state: 'visible', timeout: SYNC_TIMEOUT_MS });
  // Группа другого сервера — в списке чатов вступившего
  await openListed(b, linkGroupTitle);
  console.log('OK: участник с B вступил по ссылке в группу сервера A и пишет в неё');

  for (const s of Object.values(sessions)) assert.deepEqual(s.errors || [], [], 'ошибки страницы');
  console.log('OK');
} catch (error) {
  // Журналы провайдера всех сторон — для разбора
  for (const [who, s] of Object.entries(sessions)) {
    if (s?.logs) console.error(`--- журнал ${who} ---\n${s.logs.slice(-60).join('\n')}`);
  }
  const dir = process.env.PARVANE_E2E_BACKEND_LOG_DIR;
  if (dir) {
    const pages = browser.contexts().flatMap((context) => context.pages());
    for (const [i, page] of pages.entries()) {
      await page.screenshot({ path: `${dir}/fed-page-${i}.png` }).catch(() => undefined);
    }
  }
  throw error;
} finally {
  await browser.close();
}
