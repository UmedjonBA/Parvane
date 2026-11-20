import { CHAT_HEIGHT_PX } from '../config';
import { createSignal } from './signals';

// Parvane (spec 041, доска `DkSettingsA`): «Плотный список чатов» — настройка устройства (не синхронизируется):
// строка списка 56 px вместо 72 px, аватар меньше, на экране больше чатов. Класс `chat-list-dense` на `<html>`
// меняет вид (`components/left/main/Chat.scss`), высоту строки для расстановки списка берёт `getChatRowHeight`

const STORAGE_KEY = 'parvane:chat-list-dense';
const DENSE_CLASS = 'chat-list-dense';
const DENSE_CHAT_HEIGHT_PX = 56;

const [getIsChatListDense, setIsDenseSignal] = createSignal(readStored());

// Вид списка ставится при первом же подключении модуля (его подключает список чатов)
applyChatListDensity();

export { getIsChatListDense };

export function setChatListDense(isDense: boolean) {
  try {
    if (isDense) localStorage.setItem(STORAGE_KEY, '1');
    else localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Настройка останется до перезагрузки
  }
  setIsDenseSignal(isDense);
  applyChatListDensity();
}

/** Высота строки списка чатов в пикселях (расстановка и анимация перестановки). */
export function getChatRowHeight(isDense = getIsChatListDense()) {
  return isDense ? DENSE_CHAT_HEIGHT_PX : CHAT_HEIGHT_PX;
}

function applyChatListDensity() {
  if (typeof document === 'undefined') return;
  document.documentElement.classList.toggle(DENSE_CLASS, getIsChatListDense());
}

function readStored() {
  try {
    return localStorage.getItem(STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}
