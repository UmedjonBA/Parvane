// Справка Parvane: папка заметок о продукте в хранилище «Знаний». Тексты — данные на двух языках
// (`ru.ts`, `en.ts`), это содержимое файлов `.md` пользователя, а не строки интерфейса.

export type GuideLang = 'ru' | 'en';

// Постоянное имя заметки справки: по нему совпадают языки, проверяются ссылки и строится идентификатор узла
export type GuideKey = 'overview' | 'chats' | 'calendar' | 'input' | 'health' | 'notes' | 'boards' | 'files'
  | 'connections' | 'security' | 'appearance' | 'shortcuts';

export type GuideSource = {
  key: GuideKey;
  // Номер заметки в идентификаторе узла: не меняется при перестановке и переводе
  slot: number;
  title: string;
  // Абзац заметки — одна строка файла: чтение рисует текст построчно
  lines: string[];
};

// Пример строки для окна ввода текстом, стоящий в справке кодом, и то, чем он обязан стать
export type GuideQuickSample = { text: string; kind: string };

export type GuideSet = {
  folderName: string;
  notes: GuideSource[];
  // Примеры пунктов с датой (без `- [ ] `): в тексте стоят кодом, каждый обязан разбираться как задача
  datedSamples: string[];
  quickSamples: GuideQuickSample[];
};

export function p(...parts: string[]) {
  return parts.join(' ');
}
