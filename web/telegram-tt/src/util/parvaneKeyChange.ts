import { createSignal } from './signals';

// Parvane (доска `ZpChat`): ключ безопасности собеседника сменился — плашка в его чате «Сверить» до сверки.
// Список чатов с несверенной сменой — память устройства (`parvane:*` стирается выходом)

const STORAGE_KEY = 'parvane:key-changed';

const [getKeyChangedChats, setKeyChangedChats] = createSignal<string[]>(readStored());

export { getKeyChangedChats };

export function markKeyChanged(chatId: string) {
  if (getKeyChangedChats().includes(chatId)) return;
  store([...getKeyChangedChats(), chatId]);
}

export function clearKeyChanged(chatId: string) {
  if (!getKeyChangedChats().includes(chatId)) return;
  store(getKeyChangedChats().filter((id) => id !== chatId));
}

function store(list: string[]) {
  setKeyChangedChats(list);
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
  } catch {
    // Память устройства недоступна — плашка живёт до перезагрузки
  }
}

function readStored(): string[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : [];
  } catch {
    return [];
  }
}
