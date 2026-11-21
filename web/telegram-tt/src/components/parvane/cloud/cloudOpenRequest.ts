import { openFiles } from '../../../util/parvaneSection';
import { createSignal } from '../../../util/signals';

// Parvane: файл либо папка «Файлов», выбранные в общем поиске. Модуль открывается сразу, а папку и файл
// «Файлы» показывают сами, когда дерево готово (как запрос записи «Плана» из палитры)
export type CloudOpenRequest = { container: string; node: string };

const [getCloudOpenRequest, setCloudOpenRequest] = createSignal<CloudOpenRequest | undefined>(undefined);

export { getCloudOpenRequest };

export function requestCloudOpen(request: CloudOpenRequest) {
  setCloudOpenRequest(request);
  openFiles();
}

export function consumeCloudOpenRequest() {
  setCloudOpenRequest(undefined);
}
