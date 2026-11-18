// Настройки модуля «Заметки» на этом устройстве: «справку уже показывали», область графа и ручная
// расстановка его точек, качество картинок на холсте

import type { CanvasImageQuality } from './notesCanvasImages';
import type { GraphFilter, GraphPlaces } from './notesGraphView';

import { GRAPH_ALL, parseGraphFilter } from './notesGraphView';

const GUIDE_SEEN_KEY = 'parvane:knowledge-guide-seen';
const GRAPH_FILTER_KEY = 'parvane:knowledge-graph-filter';
const GRAPH_PLACES_KEY = 'parvane:knowledge-graph-places';
const CANVAS_IMAGES_KEY = 'parvane:knowledge-canvas-images';
// Сколько точек одной области и сколько областей помнит расстановка
const GRAPH_PLACES_MAX = 2000;
const GRAPH_PLACE_SCOPES_MAX = 40;

function read(key: string) {
  try {
    return localStorage.getItem(key) || undefined;
  } catch (err) {
    return undefined;
  }
}

function write(key: string, value?: string) {
  try {
    if (value === undefined) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch (err) {
    // Хранилище недоступно (закрытый режим) — настройка живёт до перезагрузки
  }
}

/** Что показывает граф на этом устройстве: область и скрытие узлов. */
export function readGraphFilter(): GraphFilter {
  try {
    return parseGraphFilter(JSON.parse(read(GRAPH_FILTER_KEY) || 'null'));
  } catch (err) {
    return GRAPH_ALL;
  }
}

export function writeGraphFilter(filter: GraphFilter) {
  const isDefault = filter.scope.kind === 'all' && !filter.hideOrphans && !filter.hideMissing;
  write(GRAPH_FILTER_KEY, isDefault ? undefined : JSON.stringify(filter));
}

/** Ручная расстановка точек графа: по ключу области — места точек, которые человек поставил сам. */
export function readGraphPlaces(scope: string): GraphPlaces {
  const places = readAllPlaces()[scope];
  if (!places || typeof places !== 'object') return {};
  const result: GraphPlaces = {};
  Object.entries(places).forEach(([id, point]) => {
    const { x, y } = (point || {}) as { x?: unknown; y?: unknown };
    if (typeof x === 'number' && typeof y === 'number' && Number.isFinite(x) && Number.isFinite(y)) {
      result[id] = { x, y };
    }
  });
  return result;
}

export function writeGraphPlaces(scope: string, places: GraphPlaces) {
  const all = readAllPlaces();
  const ids = Object.keys(places).slice(-GRAPH_PLACES_MAX);
  if (ids.length) all[scope] = Object.fromEntries(ids.map((id) => [id, places[id]]));
  else delete all[scope];
  const scopes = Object.keys(all).slice(-GRAPH_PLACE_SCOPES_MAX);
  write(GRAPH_PLACES_KEY, scopes.length
    ? JSON.stringify(Object.fromEntries(scopes.map((key) => [key, all[key]]))) : undefined);
}

function readAllPlaces(): Record<string, GraphPlaces> {
  try {
    const value: unknown = JSON.parse(read(GRAPH_PLACES_KEY) || 'null');
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, GraphPlaces> : {};
  } catch (err) {
    return {};
  }
}

/** Сообщение о появившейся справке на этом устройстве уже показано (либо справку открывали). */
export function isGuideSeen(userId?: string) {
  return read(`${GUIDE_SEEN_KEY}:${userId || ''}`) === '1';
}

export function markGuideSeen(userId?: string) {
  write(`${GUIDE_SEEN_KEY}:${userId || ''}`, '1');
}

/** Картинки карточек холста: сам файл (по умолчанию) либо миниатюра облака — экономия трафика на телефоне. */
export function readCanvasImageQuality(): CanvasImageQuality {
  return read(CANVAS_IMAGES_KEY) === 'thumb' ? 'thumb' : 'full';
}

export function writeCanvasImageQuality(quality: CanvasImageQuality) {
  write(CANVAS_IMAGES_KEY, quality);
}
