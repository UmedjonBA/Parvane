// Слои календаря: что показано в сетке и клетках — сон, еда, дела. Настройка устройства

export type PlannerLayer = 'sleep' | 'food' | 'work';
export type PlannerLayers = Record<PlannerLayer, boolean>;

export const PLANNER_LAYERS: PlannerLayer[] = ['sleep', 'food', 'work'];
export const ALL_LAYERS: PlannerLayers = { sleep: true, food: true, work: true };

const LAYERS_KEY = 'parvane:planner-layers';

/** Слои из строки хранилища: названия выключенных через запятую; незнакомое пропускается. */
export function parseLayers(saved: string | undefined): PlannerLayers {
  const hidden = (saved || '').split(',');
  return {
    sleep: !hidden.includes('sleep'),
    food: !hidden.includes('food'),
    work: !hidden.includes('work'),
  };
}

export function serializeLayers(layers: PlannerLayers) {
  return PLANNER_LAYERS.filter((layer) => !layers[layer]).join(',');
}

// Хранилище может быть недоступно — тогда показано всё
export function readLayers(): PlannerLayers {
  try {
    return parseLayers(localStorage.getItem(LAYERS_KEY) || undefined);
  } catch (err) {
    return ALL_LAYERS;
  }
}

export function saveLayers(layers: PlannerLayers) {
  try {
    localStorage.setItem(LAYERS_KEY, serializeLayers(layers));
  } catch (err) {
    // Выбор просто не запомнится
  }
}
