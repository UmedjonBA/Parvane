import type { HealthBlockId } from '../../../util/parvaneModules';
import type { PlannerState } from './plannerModel';
import type { PlannerSearchShow } from './plannerTools';

import { createSignal } from '../../../util/signals';

// Слои календаря (доска `RpPlan`): события, задачи с днём, сон, еда и тренировки из «Здоровья». Настройка
// устройства. На телефоне события всегда видны (выключатель заблокирован), на компьютере их выключает колонка
// «Что показывать» (доска `ZdPlanX`). Слой «Здоровья» есть, только когда модуль и его блок включены

export type PlannerLayer = 'events' | 'tasks' | 'sleep' | 'food' | 'sport';
export type PlannerLayers = Record<PlannerLayer, boolean>;

export const PLANNER_LAYERS: PlannerLayer[] = ['events', 'tasks', 'sleep', 'food', 'sport'];
export const ALL_LAYERS: PlannerLayers = {
  events: true, tasks: true, sleep: true, food: true, sport: true,
};
// Блок «Здоровья», из которого берётся слой
export const LAYER_HEALTH_BLOCKS: Partial<Record<PlannerLayer, HealthBlockId>> = {
  sleep: 'sleep', food: 'food', sport: 'workouts',
};

const LAYERS_KEY = 'parvane:planner-layers';

/** Слои из строки хранилища: названия выключенных через запятую; незнакомое пропускается. */
export function parseLayers(saved: string | undefined): PlannerLayers {
  const hidden = (saved || '').split(',');
  return {
    events: !hidden.includes('events'),
    tasks: !hidden.includes('tasks'),
    sleep: !hidden.includes('sleep'),
    food: !hidden.includes('food'),
    sport: !hidden.includes('sport'),
  };
}

export function serializeLayers(layers: PlannerLayers) {
  return PLANNER_LAYERS.filter((layer) => !layers[layer]).join(',');
}

/** Слой «Здоровья» заблокирован: модуль или его блок выключен. */
export function getIsLayerLocked(layer: PlannerLayer, isHealthOn: boolean, healthBlocks: HealthBlockId[]) {
  const block = LAYER_HEALTH_BLOCKS[layer];
  return block !== undefined && (!isHealthOn || !healthBlocks.includes(block));
}

/** Слой показан: включён и не заблокирован выключенным «Здоровьем»; события на телефоне — всегда (`isNarrow`). */
export function getEffectiveLayers(
  layers: PlannerLayers, isHealthOn: boolean, healthBlocks: HealthBlockId[], isNarrow?: boolean,
): PlannerLayers {
  const shown = { ...layers, events: layers.events || Boolean(isNarrow) };
  PLANNER_LAYERS.forEach((layer) => {
    if (LAYER_HEALTH_BLOCKS[layer] && getIsLayerLocked(layer, isHealthOn, healthBlocks)) shown[layer] = false;
  });
  return shown;
}

/**
 * Состояние для видов календаря: без задач и событий выключенных слоёв, без записей выключенных групп
 * (`groupsOff`, '' — без группы; доска `ZdPlanX`), без сна, еды и тренировок выключенных слоёв.
 */
export function applyLayers(state: PlannerState, layers: PlannerLayers, groupsOff: string[]): PlannerState {
  if (PLANNER_LAYERS.every((layer) => layers[layer]) && !groupsOff.length) return state;
  const isGroupOn = (group: string | undefined) => !groupsOff.includes(group || '');
  return {
    ...state,
    tasks: state.tasks.filter((task) => isGroupOn(task.project)
      && (layers.tasks || (!task.day && !task.repeat && !task.due))),
    events: layers.events ? state.events.filter((event) => isGroupOn(event.project)) : [],
    health: state.health.filter((record) => (
      record.kind === 'sleep' ? layers.sleep : record.kind === 'workout' ? layers.sport : true
    )),
    nutrition: layers.food ? state.nutrition : {},
  };
}

// ── настройка устройства: слои, выключенные группы, «Что показывать» поиска ──

export type PlannerLayerPrefs = {
  layers: PlannerLayers;
  // Выключенные слои-группы (доска `ZdPlanX`): имена групп, '' — без группы
  groupsOff: string[];
  // «Что показывать» в поиске компьютера; по доске «Выполненное» выключено
  searchShow: PlannerSearchShow[];
};

const GROUPS_KEY = 'parvane:planner-groups-off';
const SHOW_KEY = 'parvane:planner-search-show';
const DEFAULT_SEARCH_SHOW: PlannerSearchShow[] = ['events', 'tasks', 'offers'];
const SEARCH_SHOW: PlannerSearchShow[] = ['events', 'tasks', 'done', 'offers'];

function readItem(key: string) {
  try {
    return localStorage.getItem(key) || undefined;
  } catch (err) {
    return undefined;
  }
}

function writeItem(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch (err) {
    // Выбор просто не запомнится
  }
}

function readGroupsOff(): string[] {
  try {
    const parsed: unknown = JSON.parse(readItem(GROUPS_KEY) || '[]');
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
  } catch (err) {
    return [];
  }
}

function readSearchShow(): PlannerSearchShow[] {
  const saved = readItem(SHOW_KEY);
  if (saved === undefined) return DEFAULT_SEARCH_SHOW;
  return SEARCH_SHOW.filter((item) => saved.split(',').includes(item));
}

const [getPlannerLayerPrefs, setPrefs] = createSignal<PlannerLayerPrefs>({
  layers: parseLayers(readItem(LAYERS_KEY)),
  groupsOff: readGroupsOff(),
  searchShow: readSearchShow(),
});

export { getPlannerLayerPrefs };

export function toggleLayer(layer: PlannerLayer) {
  const prefs = getPlannerLayerPrefs();
  const layers = { ...prefs.layers, [layer]: !prefs.layers[layer] };
  writeItem(LAYERS_KEY, serializeLayers(layers));
  setPrefs({ ...prefs, layers });
}

export function toggleGroupLayer(group: string) {
  const prefs = getPlannerLayerPrefs();
  const groupsOff = prefs.groupsOff.includes(group)
    ? prefs.groupsOff.filter((item) => item !== group) : [...prefs.groupsOff, group];
  writeItem(GROUPS_KEY, JSON.stringify(groupsOff));
  setPrefs({ ...prefs, groupsOff });
}

export function toggleSearchShow(item: PlannerSearchShow) {
  const prefs = getPlannerLayerPrefs();
  const searchShow = prefs.searchShow.includes(item)
    ? prefs.searchShow.filter((value) => value !== item) : SEARCH_SHOW.filter((value) => (
      value === item || prefs.searchShow.includes(value)
    ));
  writeItem(SHOW_KEY, searchShow.join(','));
  setPrefs({ ...prefs, searchShow });
}
