import type { PaletteRecordKind } from './paletteRecords';
import type { PaletteFilter } from './paletteSearch';

import { openPlannerView } from '../../../util/parvaneSection';
import { createSignal } from '../../../util/signals';

// Parvane: общий поиск (палитра) — открыт ли он и чем сужена выдача. Открывают Ctrl+K, «/», кнопка «Общий поиск»
// боковой панели и значок поиска в шапке «Чатов» на телефоне
const [getIsPaletteOpen, setIsPaletteOpen] = createSignal(false);
// Чип выдачи: «Всё» либо модуль (чипы на телефоне, Tab на компьютере)
const [getPaletteFilter, setPaletteFilter] = createSignal<PaletteFilter>('all');

export { getIsPaletteOpen, getPaletteFilter, setPaletteFilter };

/** Открыть общий поиск; без фильтра — «Всё». Годится и как обработчик нажатия (событие не читается). */
export function openPalette(filter?: unknown) {
  setPaletteFilter(typeof filter === 'string' ? filter as PaletteFilter : 'all');
  setIsPaletteOpen(true);
}

export function closePalette() {
  setIsPaletteOpen(false);
}

// Запись «Плана», выбранная в палитре: раздел и экран переключаются сразу, а день и карточку записи
// «План» открывает сам, когда его данные готовы (как запрос дня у карточки задания в чате)
export type PlannerRecordRequest = { kind: PaletteRecordKind; id: string; day?: string };

const [getPlannerRecordRequest, setPlannerRecordRequest] = createSignal<PlannerRecordRequest | undefined>();

export { getPlannerRecordRequest };

export function consumePlannerRecordRequest() {
  setPlannerRecordRequest(undefined);
}

/** Запись с датой — «Календарь» на её дне, задача без даты — «Сегодня». */
export function openRecordInPlan(request: PlannerRecordRequest) {
  setPlannerRecordRequest(request);
  openPlannerView(request.day ? 'calendar' : 'today');
}
