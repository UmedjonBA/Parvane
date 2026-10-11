// Общие шаги сценариев раздела «Облако» (spec 016): вход в раздел, строки
// дерева, меню действий, загрузка, скачивание.
import { readFileSync } from 'node:fs';

export const CLOUD_STEP_TIMEOUT_MS = 20000;

export function cloudDriver(page) {
  const cloud = page.locator('#ParvaneCloud');
  const item = (name) => cloud.locator(`[data-node-id][data-name="${name}"]`);
  const folderRow = (name) => cloud.locator(`[data-container-id][data-name="${name}"]`);
  const tab = (title) => cloud.locator('header').getByText(title, { exact: true }).first();
  const api = {
    cloud,
    item,
    folderRow,
    tab,
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
      await cloud.waitFor({ state: 'detached', timeout: CLOUD_STEP_TIMEOUT_MS });
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
      await page.getByRole('menuitem', { name: 'Open', exact: true }).waitFor({ state: 'visible', timeout: CLOUD_STEP_TIMEOUT_MS });
      const found = await page.getByRole('menuitem', { name: action, exact: true }).count();
      // Меню закрывается нажатием мимо него
      await page.mouse.click(700, 600);
      await cloud.locator('.bubble.open').waitFor({ state: 'detached', timeout: CLOUD_STEP_TIMEOUT_MS });
      // Нажатие мимо меню не должно открывать файл
      await page.waitForTimeout(400);
      if (await page.locator('.Modal.open').count()) throw new Error('нажатие мимо меню открыло просмотр файла');
      return found > 0;
    },
    add: async (action) => {
      await cloud.getByRole('button', { name: 'Upload', exact: true }).click();
      await page.getByRole('menuitem', { name: action, exact: true }).click();
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
