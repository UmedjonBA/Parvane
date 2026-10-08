import { createSignal } from './signals';

// Parvane (spec 009): раздел приложения, выбранный в нижней части боковой
// панели. Мессенджер остаётся смонтированным (звонки, синхронизация) — раздел
// только решает, что показано справа от панели
export type ParvaneSection = 'messenger' | 'planner';

const [getParvaneSection, setSignal] = createSignal<ParvaneSection>('messenger');

export { getParvaneSection };

export function setParvaneSection(section: ParvaneSection) {
  if (getParvaneSection() === section) return;
  setSignal(section);
}
