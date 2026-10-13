// Общие шаги сценариев раздела «Облако» (spec 016): вход в раздел, строки
// дерева, путь, строки-папки корня («Доступные мне», «Корзина»), шторка
// действий «⋯», загрузка, скачивание.
import { readFileSync } from 'node:fs';

export const CLOUD_STEP_TIMEOUT_MS = 20000;

export function cloudDriver(page) {
  const cloud = page.locator('#ParvaneCloud');
  const item = (name) => cloud.locator(`[data-node-id][data-name="${name}"]`);
  const folderRow = (name) => cloud.locator(`[data-container-id][data-name="${name}"]`);
  // Строки-папки в конце корня: 'shared' — «Доступные мне», 'trash' — «Корзина»
  const virtual = (view) => cloud.locator(`[data-virtual="${view}"]`);
  const openVirtual = async (view) => {
    await virtual(view).click();
    await page.locator(`#ParvaneCloud[data-place="${view}"]`).waitFor({ state: 'visible', timeout: CLOUD_STEP_TIMEOUT_MS });
  };
  const api = {
    cloud,
    item,
    folderRow,
    virtual,
    // Путь сверху списка
    crumbs: () => cloud.locator('nav span > button').allInnerTexts(),
    root: async () => {
      await cloud.locator('nav').getByRole('button', { name: 'Cloud', exact: true }).click();
      await virtual('trash').waitFor({ state: 'visible', timeout: CLOUD_STEP_TIMEOUT_MS });
    },
    openShared: () => openVirtual('shared'),
    openTrash: () => openVirtual('trash'),
    open: async () => {
      if (!(await cloud.isVisible().catch(() => false))) {
        await page.locator('#FoldersSidebar').getByRole('tab', { name: 'Cloud' }).click();
      }
      await cloud.waitFor({ state: 'visible', timeout: CLOUD_STEP_TIMEOUT_MS });
      await page.waitForFunction(
        () => document.querySelector('#ParvaneCloud')?.dataset.loaded === '1', undefined, { timeout: CLOUD_STEP_TIMEOUT_MS },
      );
    },
    close: async () => {
      await page.locator('#FoldersSidebar').getByRole('tab', { name: 'Chats' }).click();
      // Раздел после первого показа остаётся смонтированным и скрывается (E1): ждём `hidden`, не `detached`
      await cloud.waitFor({ state: 'hidden', timeout: CLOUD_STEP_TIMEOUT_MS });
    },
    names: () => cloud.locator('[data-node-id]').evaluateAll((els) => els.map((el) => el.dataset.name).sort()),
    menu: async (name, action) => {
      await item(name).hover();
      await item(name).getByRole('button', { name: 'Actions' }).click();
      await page.getByRole('menuitem', { name: action, exact: true }).click();
    },
    hasMenuAction: async (name, action) => {
      await item(name).hover();
      await item(name).getByRole('button', { name: 'Actions' }).click();
      await page.getByRole('menuitem', { name: /^(Open|View)$/ }).waitFor({ state: 'visible', timeout: CLOUD_STEP_TIMEOUT_MS });
      const found = await page.getByRole('menuitem', { name: action, exact: true }).count();
      // Шторка действий закрывается нажатием мимо неё (по затемнению в углу экрана)
      await page.mouse.click(8, 8);
      await page.getByRole('menuitem').first().waitFor({ state: 'detached', timeout: CLOUD_STEP_TIMEOUT_MS });
      // Нажатие мимо шторки не должно открывать файл
      await page.waitForTimeout(400);
      if (await page.locator('.Modal.open').count()) throw new Error('нажатие мимо меню открыло просмотр файла');
      return found > 0;
    },
    // Шторка «⋯» строки совместной папки (своей в корне, чужой в «Доступных мне»)
    folderMenu: async (name, action) => {
      await folderRow(name).getByRole('button', { name: 'Actions' }).click();
      await page.getByRole('menuitem', { name: action, exact: true }).click();
    },
    hasFolderMenuAction: async (name, action) => {
      await folderRow(name).getByRole('button', { name: 'Actions' }).click();
      await page.getByRole('menuitem', { name: 'Open', exact: true }).waitFor({ state: 'visible', timeout: CLOUD_STEP_TIMEOUT_MS });
      const found = await page.getByRole('menuitem', { name: action, exact: true }).count();
      await page.mouse.click(8, 8);
      await page.getByRole('menuitem').first().waitFor({ state: 'detached', timeout: CLOUD_STEP_TIMEOUT_MS });
      return found > 0;
    },
    // Кнопки шапки: 'New folder', 'New shared folder' (загрузка идёт через поле выбора файлов)
    add: async (action) => {
      await cloud.getByRole('button', { name: action, exact: true }).click();
    },
    upload: async (name, content, mimeType = 'text/plain') => {
      await cloud.locator('input[type="file"]').setInputFiles([{ name, mimeType, buffer: Buffer.from(content) }]);
      await item(name).waitFor({ state: 'visible', timeout: 60000 });
    },
    download: async (name) => {
      const [download] = await Promise.all([
        page.waitForEvent('download', { timeout: CLOUD_STEP_TIMEOUT_MS }),
        api.menu(name, 'Download'),
      ]);
      return readFileSync(await download.path());
    },
  };
  return api;
}
