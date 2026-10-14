// Parvane: ширина боковых панелей наших разделов («Знания», «План») на широком экране — её меняет
// пользователь ручкой на границе панели. Настройка устройства: хранится в localStorage, на страницу ложится
// переменными CSS `--pv-panel-<имя>` (нет переменной — ширина из стилей).

export type ParvanePanel = 'notes-list' | 'notes-links' | 'graph-note' | 'planner-side' | 'planner-today';

const STORAGE_KEY = 'parvane:panel-widths';
// Панель не занимает больше этой доли окна, какой бы предел ей ни задали
const MAX_VIEWPORT_SHARE = 0.6;

type Widths = Partial<Record<ParvanePanel, number>>;

/** Ширина в пределах панели и окна. */
export function clampPanelWidth(width: number, min: number, max: number, viewportWidth: number) {
  const top = Math.max(min, Math.min(max, Math.floor(viewportWidth * MAX_VIEWPORT_SHARE)));
  return Math.round(Math.max(min, Math.min(top, width)));
}

export function parsePanelWidths(raw: string | null | undefined): Widths {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const widths: Widths = {};
    Object.entries(parsed).forEach(([name, value]) => {
      if (typeof value === 'number' && Number.isFinite(value) && value > 0) widths[name as ParvanePanel] = value;
    });
    return widths;
  } catch {
    return {};
  }
}

function readWidths(): Widths {
  try {
    return parsePanelWidths(localStorage.getItem(STORAGE_KEY));
  } catch {
    return {};
  }
}

function cssName(panel: ParvanePanel) {
  return `--pv-panel-${panel}`;
}

/** Показать ширину на странице, не запоминая (во время перетаскивания). */
export function showPanelWidth(panel: ParvanePanel, width?: number) {
  const { style } = document.documentElement;
  if (width) style.setProperty(cssName(panel), `${width}px`);
  else style.removeProperty(cssName(panel));
}

/** Запомнить ширину панели; без ширины — вернуть ширину из стилей. */
export function savePanelWidth(panel: ParvanePanel, width?: number) {
  showPanelWidth(panel, width);
  const widths = readWidths();
  if (width) widths[panel] = width;
  else delete widths[panel];
  try {
    if (Object.keys(widths).length) localStorage.setItem(STORAGE_KEY, JSON.stringify(widths));
    else localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Ширина просто не запомнится
  }
}

/** Сохранённые ширины — на страницу (один раз при загрузке раздела). */
export function applyPanelWidths() {
  Object.entries(readWidths()).forEach(([panel, width]) => showPanelWidth(panel as ParvanePanel, width));
}
