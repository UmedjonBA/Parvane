import type { PaletteRecordKind } from './paletteRecords';

import { openPlannerView } from '../../../util/parvaneSection';
import { createSignal } from '../../../util/signals';

// Parvane: общий поиск (палитра) — открыт ли он. Открывают Ctrl+K и кнопка «Поиск» боковой панели;
// лупа в шапке «Плана» открывает её только по записям плана
const [getIsPaletteOpen, setIsPaletteOpen] = createSignal(false);
// Что ищет открытая палитра: всё либо только записи «Плана» (лупа в шапке «Плана» ищет по разделу)
export type PaletteScope = 'all' | 'plan';
const [getPaletteScope, setPaletteScope] = createSignal<PaletteScope>('all');

export { getIsPaletteOpen, getPaletteScope };

export function openPalette() {
  setPaletteScope('all');
  setIsPaletteOpen(true);
}

export function openPlanSearch() {
  setPaletteScope('plan');
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

/** Запись с датой — «Календарь» на её дне, тренировка — «Здоровье», задача без даты — «Сегодня». */
export function openRecordInPlan(request: PlannerRecordRequest) {
  setPlannerRecordRequest(request);
  openPlannerView(request.kind === 'workout' ? 'health' : request.day ? 'calendar' : 'today');
}
