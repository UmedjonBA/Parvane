import type { TaskOfferKind } from '../../../api/parvane/taskOffers';

import { openPlannerView } from '../../../util/parvaneSection';
import { createSignal } from '../../../util/signals';

// Parvane: «В плане · открыть» на карточке в чате. Раздел и экран «Плана»
// переключаются сразу; день записи лежит запросом, который «План» забирает
// и ставит выбранным днём (как запрос «новая запись» нижней панели)
const [getPlannerDayRequest, setPlannerDayRequest] = createSignal<string | undefined>();

export { getPlannerDayRequest };

export function consumePlannerDayRequest() {
  setPlannerDayRequest(undefined);
}

/** Задание — экран «Сегодня» на дне задачи, событие — «Календарь» на его дне. */
export function openOfferInPlan(kind: TaskOfferKind, day?: string) {
  setPlannerDayRequest(day);
  openPlannerView(kind === 'event' ? 'calendar' : 'today');
}
