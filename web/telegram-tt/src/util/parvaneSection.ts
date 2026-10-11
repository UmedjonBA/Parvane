import { createSignal } from './signals';

// Parvane (spec 009): раздел приложения, выбранный в нижней части боковой
// панели. Мессенджер остаётся смонтированным (звонки, синхронизация) — раздел
// только решает, что показано справа от панели
export type ParvaneSection = 'messenger' | 'planner' | 'cloud';

const [getParvaneSection, setSignal] = createSignal<ParvaneSection>('messenger');
// Запрос «новая запись» из нижней панели телефона: «План» открывает форму и сбрасывает запрос
const [getPlannerAddRequest, setPlannerAddRequest] = createSignal(false);

export { getParvaneSection, getPlannerAddRequest };

export function setParvaneSection(section: ParvaneSection) {
  if (getParvaneSection() === section) return;
  setSignal(section);
}

export function requestPlannerAdd() {
  setParvaneSection('planner');
  setPlannerAddRequest(true);
}

export function consumePlannerAddRequest() {
  setPlannerAddRequest(false);
}
