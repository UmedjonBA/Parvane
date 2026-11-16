import { engineStatic, isProtocolLoaded, loadProtocol } from '../api/parvane/v2/engine';
import { createSignal } from './signals';

// Parvane: модули приложения — один плоский список. Состав, порядок и блоки «Здоровья» у каждого устройства
// свои (не синхронизируются); модуль, выключенный администратором сервера, прячется на всех устройствах
// (правило MODULES-1). Правила списка — в движке (`modules*`, общий образец `conformance/modules/cases.json`):
// здесь только хранение настроек устройства и последнего готового списка, чтобы навигация рисовалась до
// загрузки движка
export type ParvaneModuleId = 'chats' | 'plan' | 'health' | 'notes' | 'files' | 'music' | 'profile';
export type HealthBlockId = 'sleep' | 'body' | 'food' | 'water' | 'workouts';

export const HEALTH_BLOCK_IDS: HealthBlockId[] = ['sleep', 'body', 'food', 'water', 'workouts'];
// Модули, экраны которых есть в web: «Музыка» появится со своими экранами
const AVAILABLE_MODULES: ParvaneModuleId[] = ['chats', 'plan', 'health', 'notes', 'files', 'profile'];

const PREFS_KEY = 'parvane:modules';
const SERVER_KEY = 'parvane:modules-server-off';
const VIEW_KEY = 'parvane:modules-view';

export type ParvaneModulePrefs = {
  order: ParvaneModuleId[];
  off: ParvaneModuleId[];
  healthBlocks: HealthBlockId[];
};

export type ParvaneModuleState = {
  id: ParvaneModuleId;
  isOn: boolean;
  isLocked: boolean;
  // Выключен администратором сервера либо экранов ещё нет: выключатель не действует
  isServerOff: boolean;
  isUnavailable: boolean;
};

export type ParvaneModulesView = {
  prefs: ParvaneModulePrefs;
  modules: ParvaneModuleState[];
  enabled: ParvaneModuleId[];
};

// До первого ответа движка на новом устройстве: только то, что есть всегда
const FALLBACK_VIEW: ParvaneModulesView = {
  prefs: { order: ['chats', 'profile'], off: [], healthBlocks: [] },
  modules: [],
  enabled: ['chats', 'profile'],
};

function readJson<T>(key: string): T | undefined {
  try {
    const saved = localStorage.getItem(key);
    return saved ? JSON.parse(saved) as T : undefined;
  } catch {
    return undefined;
  }
}

function writeJson(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Настройка действует до перезагрузки
  }
}

function readSavedView(): ParvaneModulesView {
  const saved = readJson<ParvaneModulesView>(VIEW_KEY);
  return saved && Array.isArray(saved.enabled) && Array.isArray(saved.modules) && saved.prefs ? saved : FALLBACK_VIEW;
}

const [getModulesView, setModulesView] = createSignal<ParvaneModulesView>(readSavedView());

export { getModulesView };

// Сохранённое устройством (как записал движок) и ответ сервера в его словаре — движок приводит оба сам
let savedPrefs = readJson<unknown>(PREFS_KEY);
let serverOff = readJson<unknown>(SERVER_KEY) ?? [];

function refreshView() {
  if (!isProtocolLoaded()) return;
  const view = engineStatic<ParvaneModulesView>('modulesView', {
    prefs: savedPrefs, serverOff, available: AVAILABLE_MODULES,
  });
  setModulesView(view);
  writeJson(VIEW_KEY, view);
}

function applyPrefs(call: string, args: Record<string, unknown>) {
  void loadProtocol().then(() => {
    savedPrefs = engineStatic<ParvaneModulePrefs>(call, { ...args, prefs: savedPrefs });
    writeJson(PREFS_KEY, savedPrefs);
    refreshView();
  });
}

export function getIsModuleOn(id: ParvaneModuleId) {
  return getModulesView().enabled.includes(id);
}

export function getIsHealthBlockOn(block: HealthBlockId) {
  return getModulesView().prefs.healthBlocks.includes(block);
}

export function setModuleOn(id: ParvaneModuleId, isOn: boolean) {
  applyPrefs('modulesSetOn', { id, on: isOn });
}

/** Переставить модуль на место с этим номером (перетаскивание в списке, кнопки «выше / ниже»). */
export function moveModule(id: ParvaneModuleId, toIndex: number) {
  applyPrefs('modulesMove', { id, to: toIndex });
}

export function setHealthBlockOn(block: HealthBlockId, isOn: boolean) {
  applyPrefs('modulesSetBlock', { block, on: isOn });
}

/** Список выключенного сервером (в словаре сервера): приходит после входа и помнится до следующего ответа. */
export function setServerOffModules(raw: unknown) {
  serverOff = Array.isArray(raw) ? raw : [];
  writeJson(SERVER_KEY, serverOff);
  void loadProtocol().then(refreshView);
}

void loadProtocol().then(refreshView).catch(() => undefined);
