import { createSignal } from './signals';

// Parvane: шторка «Запись в здоровье» (доска `PlusModes`) — открывается «+» модуля «Здоровье» поверх его экрана.
// Запрос — сигнал: «+» ленты и панели его ставит, шторка (смонтирована в «Здоровье») забирает
export type HealthQuickRequest = { text?: string };

const [getHealthQuickRequest, setHealthQuickRequest] = createSignal<HealthQuickRequest | undefined>(undefined);

export { getHealthQuickRequest };

export function openHealthQuick(text?: string) {
  setHealthQuickRequest({ text });
}

export function closeHealthQuick() {
  setHealthQuickRequest(undefined);
}
