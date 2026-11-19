import type { ParvaneModuleId } from './parvaneModules';

// Адрес запуска `?open=<куда>`: ярлыки установленного приложения (`shortcuts` манифеста), «Поделиться в Parvane»
// (`share_target` → service worker → `?open=share`) и прежние ярлыки. Здесь только разбор; переход делает
// `parvaneSection.ts applyLaunchTarget`
export type LaunchTarget =
  | 'chats' | 'compose' | 'share'
  | 'today' | 'calendar' | 'entry'
  | 'health' | 'notes' | 'newNote' | 'files' | 'music';

export const LAUNCH_PARAM = 'open';

// Таблицей `Map`, а не объектом: `?open=constructor` не должен находить свойства прототипа
const TARGETS = new Map<string, LaunchTarget>([
  ['chats', 'chats'],
  ['compose', 'compose'],
  ['share', 'share'],
  ['today', 'today'],
  ['calendar', 'calendar'],
  ['entry', 'entry'],
  ['health', 'health'],
  ['notes', 'notes'],
  ['new-note', 'newNote'],
  ['files', 'files'],
  ['music', 'music'],
]);

const TARGET_MODULES: Record<LaunchTarget, ParvaneModuleId> = {
  chats: 'chats',
  compose: 'chats',
  share: 'chats',
  today: 'plan',
  calendar: 'plan',
  entry: 'plan',
  health: 'health',
  notes: 'notes',
  newNote: 'notes',
  files: 'files',
  music: 'music',
};

/**
 * Куда ведёт адрес запуска. Неизвестное значение — никуда (обычный экран); ярлык в модуль, выключенный на
 * устройстве или сервером, ведёт к чатам: ярлыки манифеста одни для всех, а модули у каждого устройства свои.
 */
export function parseLaunchTarget(
  search: string, isModuleOn: (id: ParvaneModuleId) => boolean,
): LaunchTarget | undefined {
  const value = new URLSearchParams(search).get(LAUNCH_PARAM);
  const target = value ? TARGETS.get(value) : undefined;
  if (!target) return undefined;
  return isModuleOn(TARGET_MODULES[target]) ? target : 'chats';
}

/** Адрес без параметра запуска: перезагрузка не повторяет переход. */
export function stripLaunchParam(href: string) {
  const url = new URL(href);
  url.searchParams.delete(LAUNCH_PARAM);
  return `${url.pathname}${url.search}${url.hash}`;
}
