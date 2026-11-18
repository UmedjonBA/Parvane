import { engineStatic } from '../../../api/parvane/v2/engine';

// Parvane, «Заметки» (spec 040, правило NOTES-1): раскладку графа заметок и «холста из графа» считает движок
// (`notesGraphLayout`, `notesGraphCanvas` — вызовы без состояния), здесь — только типы входа и выхода и сам
// вызов. Экран рисует по готовым координатам и ничего не раскладывает сам. Один вход (заметки, область, зерно)
// даёт одну раскладку на всех устройствах. Движок должен быть загружен (`loadProtocol`).

// Область графа: все заметки, папка с подпапками, заметка с соседями до глубины 1–3, метка с вложенными
export type NotesGraphScope =
  { kind: 'all' }
  | { kind: 'folder'; folder: string }
  | { kind: 'around'; note: string; depth: 1 | 2 | 3 }
  | { kind: 'tag'; tag: string };

export type NotesGraphNote = {
  id: string;
  title: string;
  // Путь папки через «/»; корень — пустая строка
  folder: string;
  // Названия заметок из ссылок `[[…]]`
  links: string[];
  tags?: string[];
  isDaily?: boolean;
};

export type NotesGraphRecord = { id: string; title: string; links: string[]; type?: string };

// Вход обоих вызовов. Размеры — в единицах поля (пиксели при масштабе 1); не заданы — значения движка
export type NotesGraphInput = {
  notes: NotesGraphNote[];
  records?: NotesGraphRecord[];
  scope?: NotesGraphScope;
  // Не показывать узлы без связей
  hideOrphans?: boolean;
  // Не показывать заметки, которых ещё нет
  hideMissing?: boolean;
  withDays?: boolean;
  withRecords?: boolean;
  // Зерно раскладки: то же зерно — та же раскладка
  seed?: number;
  // Отношение ширины поля к высоте, к которому стремится упаковка (по умолчанию 1,5)
  aspect?: number;
  // Граф: ширина знака подписи (7), наибольшая ширина (150) и высота (16) подписи
  charWidth?: number;
  labelMaxWidth?: number;
  labelHeight?: number;
  // Холст: размер карточки (250 × 140), просвет (60) и шаг сетки (10)
  cardWidth?: number;
  cardHeight?: number;
  gap?: number;
  grid?: number;
};

export type NotesGraphNodeKind = 'note' | 'missing' | 'day' | 'record';
export type NotesGraphSide = 'bottom' | 'top' | 'right' | 'left';

// Подпись узла: прямоугольник и сторона. `show: false` — места без наложений не нашлось (показывать по наведению)
export type NotesGraphLabel = {
  x: number; y: number; w: number; h: number; side: NotesGraphSide; show: boolean;
};

export type NotesGraphNode = {
  // Заметка, которой ещё нет, — `missing:<название в нижнем регистре>`
  id: string;
  title: string;
  kind: NotesGraphNodeKind;
  // Папка заметки либо тип записи — по нему выбирается цвет
  group?: string;
  degree: number;
  // Центр и радиус кружка
  x: number;
  y: number;
  r: number;
  label: NotesGraphLabel;
  // Номер блока в `blocks`
  block: number;
};

// Связь `from → to`; `mutual` — есть и обратная ссылка. Линия — квадратичная кривая от (x1, y1) до (x2, y2)
// (края кружков) с опорной точкой (cx, cy); `curved: false` — прямая
export type NotesGraphEdge = {
  from: string;
  to: string;
  mutual: boolean;
  x1: number; y1: number; cx: number; cy: number; x2: number; y2: number;
  curved: boolean;
};

// Блок упаковки: связная группа либо ряд одиночек
export type NotesGraphBlock = {
  kind: 'group' | 'singles'; x: number; y: number; w: number; h: number; nodes: number;
};
export type NotesGraphBounds = { x: number; y: number; w: number; h: number };
// Для выбора области: папки с обычными заметками и метки
export type NotesGraphFolder = { path: string; count: number };
export type NotesGraphTag = { tag: string; count: number };

export type NotesGraphLayout = {
  nodes: NotesGraphNode[];
  edges: NotesGraphEdge[];
  blocks: NotesGraphBlock[];
  bounds: NotesGraphBounds;
  folders: NotesGraphFolder[];
  tags: NotesGraphTag[];
};

// Карточка холста: левый верхний угол и размер; `level` — уровень от главной заметки группы
export type NotesGraphCard = {
  id: string;
  title: string;
  kind: NotesGraphNodeKind;
  folder: string;
  x: number;
  y: number;
  width: number;
  height: number;
  level: number;
  block: number;
};

export type NotesGraphCanvasEdge = {
  from: string; to: string; mutual: boolean; fromSide: NotesGraphSide; toSide: NotesGraphSide;
};

export type NotesGraphCanvasLayout = {
  cards: NotesGraphCard[];
  edges: NotesGraphCanvasEdge[];
  blocks: NotesGraphBlock[];
  bounds: NotesGraphBounds;
  folders: NotesGraphFolder[];
  tags: NotesGraphTag[];
};

export const NOTES_GRAPH_DEFAULT_SEED = 1;

/** Раскладка графа: узлы с подписями, линии связей, блоки и размер поля. */
export function layoutNotesGraph(input: NotesGraphInput) {
  return engineStatic<NotesGraphLayout>('notesGraphLayout', { ...input, seed: input.seed ?? NOTES_GRAPH_DEFAULT_SEED });
}

/** Раскладка «холста из графа»: карточки существующих заметок той же области и стрелки между ними. */
export function layoutNotesCanvas(input: NotesGraphInput) {
  return engineStatic<NotesGraphCanvasLayout>('notesGraphCanvas', input);
}

/** Путь линии связи для атрибута `d` элемента `<path>`. */
export function notesGraphEdgePath(edge: NotesGraphEdge) {
  return edge.curved
    ? `M${edge.x1} ${edge.y1}Q${edge.cx} ${edge.cy} ${edge.x2} ${edge.y2}`
    : `M${edge.x1} ${edge.y1}L${edge.x2} ${edge.y2}`;
}
