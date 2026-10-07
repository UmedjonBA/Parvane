import type { InterfaceStyle } from '../types';

// Parvane (spec 008): оформление интерфейса — «Панели» (плавающие скруглённые
// панели Web A 12.x) или «Классическое» (плоские колонки вплотную к краям окна).
// Настройка устройства: источник для запуска — localStorage (переживает выход и
// читается до первой отрисовки), реактивная копия — sharedState.settings
const STORAGE_KEY = 'parvane:interface-style';
const CLASSIC_CLASS = 'interface-classic';

export const DEFAULT_INTERFACE_STYLE: InterfaceStyle = 'panels';

export function readStoredInterfaceStyle(): InterfaceStyle {
  try {
    return localStorage.getItem(STORAGE_KEY) === 'classic' ? 'classic' : DEFAULT_INTERFACE_STYLE;
  } catch {
    // Хранилище недоступно (приватное окно) — оформление по умолчанию
    return DEFAULT_INTERFACE_STYLE;
  }
}

// Класс вешается на <html>: он есть ещё до появления <body>-классов и первой
// отрисовки приложения, стили «Классического» — `html.interface-classic …`
export function applyInterfaceStyle(style: InterfaceStyle, shouldStore = true) {
  document.documentElement.classList.toggle(CLASSIC_CLASS, style === 'classic');
  if (!shouldStore) return;
  try {
    localStorage.setItem(STORAGE_KEY, style);
  } catch {
    // Выбор действует до закрытия вкладки
  }
}
