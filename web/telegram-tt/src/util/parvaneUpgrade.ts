import { createSignal } from './signals';

// Parvane (доска `ZdNav`, «Нужно обновить приложение»): сервер больше не принимает эту версию. Окно открыто
// (`dialog`) либо отложено «Позже» (`readOnly`): переписку можно читать, отправка закрыта плашкой над полем ввода,
// черновики остаются в поле
export type UpgradeState = 'none' | 'dialog' | 'readOnly';

const [getUpgradeState, setUpgradeState] = createSignal<UpgradeState>('none');

export { getUpgradeState };

export function getIsSendBlockedByUpgrade() {
  return getUpgradeState() !== 'none';
}

export function openUpgradeDialog() {
  setUpgradeState('dialog');
}

export function postponeUpgrade() {
  setUpgradeState('readOnly');
}

export type UpgradeProgress = { kind: 'ready' } | { kind: 'downloading'; percent: number } | { kind: 'checking' }
  | { kind: 'missing' };

/**
 * Что сказать о новой сборке: готова (оболочка новой сборки в кэше), скачивается (ход сервис-воркера), новой
 * версии на сервере ещё нет (в кэше целиком текущая) либо ещё неизвестно.
 */
export function describeUpgradeProgress(
  currentBuild: string,
  cachedBuild: string | undefined,
  progress: { done: number; total: number } | undefined,
  isUpdateAvailable: boolean,
): UpgradeProgress {
  if (isUpdateAvailable || (cachedBuild && cachedBuild !== currentBuild)) return { kind: 'ready' };
  if (progress && progress.total > 0 && progress.done < progress.total) {
    return { kind: 'downloading', percent: Math.floor((progress.done / progress.total) * 100) };
  }
  if (cachedBuild === currentBuild) return { kind: 'missing' };
  return { kind: 'checking' };
}
