import type { TaskOfferKind } from '../../../api/parvane/taskOffers';
import type { PlannerEvent, PlannerState, PlannerTask } from '../planner/plannerModel';

import { getStateCache } from '../planner/plannerModel';

// Parvane (spec 011): запись плана, созданная из карточки задания, — для карточек в чате. Карточек в ленте
// много, а состояние плана меняется часто (эхо движка, синк): ответ даётся строкой-ключом по индексу
// состояния, чтобы производное состояние карточки не менялось, пока запись та же, и карточка не
// перерисовывалась. Правило поиска — то же, что у `findOfferInPlan`: задача по `source.opId` (hex uuid без
// дефисов), иначе событие с id карточки

export type OfferInPlan = { kind: TaskOfferKind; id: string; day?: string };

const SEPARATOR = '\u0001';

type OfferIndex = { tasksByOpId: Map<string, PlannerTask>; eventsById: Map<string, PlannerEvent> };

function offerIndexOf(state: PlannerState): OfferIndex {
  return getStateCache(state, 'offers', () => {
    const tasksByOpId = new Map<string, PlannerTask>();
    state.tasks.forEach((task) => {
      const opId = task.source?.opId;
      // Первая запись по порядку данных — как `find`
      if (opId && !tasksByOpId.has(opId)) tasksByOpId.set(opId, task);
    });
    const eventsById = new Map<string, PlannerEvent>();
    state.events.forEach((event) => {
      if (!eventsById.has(event.id)) eventsById.set(event.id, event);
    });
    return { tasksByOpId, eventsById };
  });
}

/** Ключ записи плана по карточке: строка (вид, id, день) либо `undefined` — записи нет. */
export function offerInPlanKey(state: PlannerState | undefined, uuid: string): string | undefined {
  if (!state) return undefined;
  const index = offerIndexOf(state);
  const task = index.tasksByOpId.get(uuid.replace(/-/g, ''));
  if (task) return ['task', task.id, task.day || ''].join(SEPARATOR);
  const event = index.eventsById.get(uuid);
  if (event) return ['event', uuid, event.day || ''].join(SEPARATOR);
  return undefined;
}

/** Запись плана из ключа `offerInPlanKey`. */
export function parseOfferInPlanKey(key: string | undefined): OfferInPlan | undefined {
  if (!key) return undefined;
  const [kind, id, day] = key.split(SEPARATOR);
  return { kind: kind as TaskOfferKind, id, day: day || undefined };
}
