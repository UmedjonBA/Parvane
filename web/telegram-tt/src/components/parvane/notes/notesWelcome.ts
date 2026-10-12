// Первая заметка хранилища «Знаний»: объясняет раздел и сама показывает то, о чём говорит. Это содержимое
// заметки (файл `.md` пользователя), а не строки интерфейса: разметка обязана совпадать с разбором
// `notesModel.ts` и `notesTasks.ts`, что проверяет тест рядом. Живых пунктов с датой в ней нет — такой пункт
// завёл бы настоящую задачу в «Плане»; запись с датой показана кодом (`…`), который разбор пропускает.

export type WelcomeLang = 'ru' | 'en';

export type WelcomeNote = {
  title: string;
  // Заметка, которой ещё нет: ссылка на неё в тексте создаёт её по нажатию
  linkedTitle: string;
  // Примеры пунктов с датой из текста (без `- [ ] `): каждый обязан разбираться как задача
  datedSamples: string[];
  text: string;
};

// Узлы первой заметки и её папки создаются с постоянными идентификаторами: если два устройства аккаунта
// создадут их одновременно, движок сведёт оба создания в один узел, а не в две папки и две заметки
export const WELCOME_VAULT_NODE_ID = '70617276616e652d6b6e6f776c656467';
export const WELCOME_NOTE_NODE_ID = '70617276616e652d77656c636f6d652d';

// Абзац заметки — одна строка файла: чтение рисует текст построчно
function line(...parts: string[]) {
  return parts.join(' ');
}

const NOTES: Record<WelcomeLang, Omit<WelcomeNote, 'text'> & { lines: string[] }> = {
  ru: {
    title: 'Как пользоваться Знаниями',
    linkedTitle: 'Моя первая заметка',
    datedSamples: ['оплатить счёт до пт', 'созвон завтра 16:00'],
    lines: [
      '# Как пользоваться Знаниями',
      '',
      line(
        'Заметки — обычные файлы `.md` в папке «Знания» вашего облака. Они шифруются на устройстве: сервер видит',
        'только зашифрованные блоки. #знакомство',
      ),
      '',
      '## Ссылки и связи',
      '- `[[Название]]` — ссылка на заметку: [[Моя первая заметка]]. Её ещё нет — нажмите, и она появится.',
      '- «Связи» под заметкой (на широком экране — справа) показывают, кто ссылается сюда.',
      line(
        '- Вкладка «Граф» рисует заметки и ссылки между ними. «Холст» — доска с карточками и стрелками;',
        '«Холст из графа» собирает её из ваших ссылок.',
      ),
      '',
      '## Теги и пункты',
      '- `#тег` в тексте — метка, по ней работает поиск: #пример',
      '- [ ] Пункт с галочкой — отметьте меня',
      '- [ ] Нажать «Изменить» и поправить этот текст',
      '',
      line(
        'Пункт с датой или сроком становится задачей «Плана», галочка ходит в обе стороны. Напишите, например,',
        '`- [ ] оплатить счёт до пт` или `- [ ] созвон завтра 16:00`.',
      ),
      '',
      '## Заметка дня',
      'Кнопка «Заметка дня» на экране «Сегодня» заводит заметку с датой в папке «Ежедневные».',
      '',
      'Эту заметку можно отправить в корзину — сама она не вернётся.',
      '',
    ],
  },
  en: {
    title: 'How to use Knowledge',
    linkedTitle: 'My first note',
    datedSamples: ['pay the invoice by fri', 'call tomorrow 16:00'],
    lines: [
      '# How to use Knowledge',
      '',
      line(
        'Notes are plain `.md` files in the «Knowledge» folder of your cloud. They are encrypted on this device:',
        'the server sees only encrypted blocks. #welcome',
      ),
      '',
      '## Links',
      '- `[[Title]]` links to a note: [[My first note]]. It does not exist yet — press it and it will be created.',
      '- «Links» under a note (on a wide screen — on the right) show who links here.',
      line(
        '- The «Graph» tab draws notes and the links between them. «Canvas» is a board with cards and arrows;',
        '«Canvas from graph» builds it from your links.',
      ),
      '',
      '## Tags and checklists',
      '- `#tag` in the text is a label you can search by: #example',
      '- [ ] A checklist item — tick me',
      '- [ ] Press «Edit» and change this text',
      '',
      line(
        'An item with a date or a deadline becomes a task in the planner, and the tick travels both ways. Write,',
        'for example, `- [ ] pay the invoice by fri` or `- [ ] call tomorrow 16:00`.',
      ),
      '',
      '## Daily note',
      'The «Daily note» button on the «Today» screen starts a dated note in the «Daily» folder.',
      '',
      'You can move this note to the trash — it will not come back by itself.',
      '',
    ],
  },
};

// Язык заметки по коду языка интерфейса
export function getWelcomeLang(code?: string): WelcomeLang {
  return code?.toLowerCase().startsWith('ru') ? 'ru' : 'en';
}

export function buildWelcomeNote(lang: WelcomeLang): WelcomeNote {
  const { lines, ...rest } = NOTES[lang];
  return { ...rest, text: lines.join('\n') };
}
