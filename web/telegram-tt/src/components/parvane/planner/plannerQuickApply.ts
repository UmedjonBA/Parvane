import type { PlannerState } from './plannerModel';
import type { QuickDraft } from './plannerQuick';

import {
  ALL_DAY_END, ALL_DAY_START, ensureList, newId,
} from './plannerModel';
import { quickDescription } from './plannerQuick';

/**
 * Записать черновик ввода текстом в состояние: задача либо событие; с ошибкой — ничего. Событие без своего
 * «напомнить» берёт напоминание по умолчанию из настроек (`eventRemind`, доска `RdPlanSet`).
 */
export function applyQuickDraft(state: PlannerState, draft: QuickDraft) {
  if (draft.error) return;
  const { repeat } = draft;
  const project = getQuickGroup(state, draft.list);
  if (draft.kind === 'event') {
    state.events.push({
      id: newId(),
      name: draft.name,
      project: project || undefined,
      description: quickDescription(draft),
      remind: draft.remind ?? state.settings.eventRemind,
      start: draft.isAllDay ? ALL_DAY_START : draft.start!,
      end: draft.isAllDay ? ALL_DAY_END : draft.end!,
      day: repeat ? undefined : draft.day,
      repeat,
      isAllDay: draft.isAllDay,
    });
    return;
  }
  state.tasks.push({
    id: newId(),
    name: draft.name,
    description: quickDescription(draft) || '',
    steps: [],
    // Метка «!» — задача сразу «В работе»
    status: draft.isImportant ? 'active' : 'queue',
    project,
    minutes: draft.minutes,
    remind: draft.remind,
    day: repeat ? undefined : draft.day,
    start: draft.start,
    due: draft.due,
    repeat,
    // Новая задача — первой в очереди
    rank: Math.min(0, ...state.tasks.map(({ rank }) => rank)) - 1,
  });
}

// Группа из метки `#…`: существующая — по названию без учёта регистра, иначе новая — тем же путём, что у полной формы
function getQuickGroup(state: PlannerState, list?: string) {
  const listName = list?.trim().toLowerCase();
  const known = listName ? state.lists.find(({ name }) => name.toLowerCase() === listName) : undefined;
  return known?.name || ensureList(state, list?.trim() || '')?.name || '';
}
