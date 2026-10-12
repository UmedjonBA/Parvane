import { describe, expect, it } from 'vitest';

import { addLinkToText, canLinkTitle, removeLinkFromText } from './notesLinkEdit';
import { parseNote } from './notesModel';

describe('связь на графе: ссылка дописывается в текст', () => {
  it('в конец заметки новой строкой после пустой', () => {
    expect(addLinkToText('# Сервер\n\nТекст о сервере.\n', 'Курс ОГЭ')).toEqual({
      status: 'added', text: '# Сервер\n\nТекст о сервере.\n\n[[Курс ОГЭ]]\n',
    });
  });

  it('заметка без перевода строки в конце кончается ссылкой', () => {
    expect(addLinkToText('Текст', 'Б').text).toBe('Текст\n\n[[Б]]');
  });

  it('пустая заметка и заметка из пустых строк', () => {
    expect(addLinkToText('', 'Б').text).toBe('[[Б]]\n');
    expect(addLinkToText('\n\n', 'Б').text).toBe('[[Б]]\n');
  });

  it('лишние пустые строки в конце не копятся', () => {
    expect(addLinkToText('Текст\n\n\n', 'Б').text).toBe('Текст\n\n[[Б]]\n');
  });

  it('блок ссылок в конце заметки продолжается, пункт списка — пунктом', () => {
    expect(addLinkToText('Текст\n\n[[А]]\n[[В]]\n', 'Б').text).toBe('Текст\n\n[[А]]\n[[В]]\n[[Б]]\n');
    expect(addLinkToText('Текст\n\n- [[А]]\n- [[В]]', 'Б').text).toBe('Текст\n\n- [[А]]\n- [[В]]\n- [[Б]]');
    expect(addLinkToText('[[А]], [[В]]\n', 'Б').text).toBe('[[А]], [[В]]\n[[Б]]\n');
  });

  it('пункт с галочкой блоком ссылок не считается', () => {
    expect(addLinkToText('- [ ] [[А]]\n', 'Б').text).toBe('- [ ] [[А]]\n\n[[Б]]\n');
  });

  it('раздел «См. также» и его родня принимают ссылку, даже если стоят не в конце', () => {
    expect(addLinkToText('# Т\n\n## См. также\n\n- [[А]]\n\n## Дальше\n\nтекст\n', 'Б').text)
      .toBe('# Т\n\n## См. также\n\n- [[А]]\n- [[Б]]\n\n## Дальше\n\nтекст\n');
    expect(addLinkToText('Текст\n\n## Links\n', 'B').text).toBe('Текст\n\n## Links\n\n[[B]]\n');
    expect(addLinkToText('Текст\n\n## Связи', 'Б').text).toBe('Текст\n\n## Связи\n\n[[Б]]');
    expect(addLinkToText('See also:\n[[A]]\n## Next\n', 'B').text).toBe('See also:\n[[A]]\n[[B]]\n\n## Next\n');
    expect(addLinkToText('**Ссылки**\nпояснение\n', 'Б').text).toBe('**Ссылки**\nпояснение\n[[Б]]\n');
  });

  it('заголовок раздела внутри кода и в свойствах не считается', () => {
    expect(addLinkToText('```\n## Links\n```\n', 'B').text).toBe('```\n## Links\n```\n\n[[B]]\n');
    expect(addLinkToText('---\nLinks:\n---\nТекст\n', 'B').text).toBe('---\nLinks:\n---\nТекст\n\n[[B]]\n');
  });

  it('ссылка, которая уже есть, второй раз не пишется', () => {
    const text = 'Смотри [[Курс ОГЭ|курс]] и дальше\n';
    expect(addLinkToText(text, ' курс огэ ')).toEqual({ status: 'exists', text });
    expect(addLinkToText('[[Б]]\n', 'Б').status).toBe('exists');
  });

  it('ссылка в коде не считается существующей', () => {
    expect(addLinkToText('`[[Б]]`\n', 'Б')).toEqual({ status: 'added', text: '`[[Б]]`\n\n[[Б]]\n' });
  });

  it('название, которое не записать в ссылку, — отказ', () => {
    ['', '   ', 'a]b', 'a[b', 'a|b', 'a\nb'].forEach((title) => {
      expect(canLinkTitle(title)).toBe(false);
      expect(addLinkToText('Текст\n', title)).toEqual({ status: 'refused', text: 'Текст\n' });
    });
    expect(canLinkTitle('Сервер X99: план (v2), «кавычки» #1')).toBe(true);
  });

  it('дописанную ссылку видит разбор заметки', () => {
    const { text } = addLinkToText('# А\n\nтекст\n', 'Сервер X99: план (v2)');
    expect(parseNote(text).links).toEqual(['Сервер X99: план (v2)']);
  });

  it('переводы строк CRLF сохраняются', () => {
    expect(addLinkToText('a\r\nb\r\n', 'Б').text).toBe('a\r\nb\r\n\r\n[[Б]]\r\n');
  });
});

describe('связь на графе: ссылка убирается из текста', () => {
  it('отдельная строка уходит вместе с пустой строкой перед ней', () => {
    expect(removeLinkFromText('# Сервер\n\nТекст.\n\n[[Курс ОГЭ]]\n', 'курс огэ')).toEqual({
      status: 'removed', text: '# Сервер\n\nТекст.\n',
    });
    expect(removeLinkFromText('Текст\n\n[[Б]]', 'Б').text).toBe('Текст');
    expect(removeLinkFromText('[[Б]]\n', 'Б').text).toBe('');
  });

  it('добавление и удаление возвращают прежний текст', () => {
    ['', 'Текст', 'Текст\n', '# Т\n\n- [ ] дело\n', 'Текст\n\n[[А]]\n', '## См. также\n\n- [[А]]\n\n## Дальше\n']
      .forEach((text) => {
        const added = addLinkToText(text, 'Б');
        expect(added.status).toBe('added');
        expect(removeLinkFromText(added.text, 'Б')).toEqual({ status: 'removed', text });
      });
  });

  it('строка между другими строками уходит, соседние не склеиваются лишним', () => {
    expect(removeLinkFromText('а\n[[Б]]\nв\n', 'Б').text).toBe('а\nв\n');
    expect(removeLinkFromText('а\n\n[[Б]]\n\nв\n', 'Б').text).toBe('а\n\nв\n');
    expect(removeLinkFromText('- [[А]]\n- [[Б|подпись]]\n- [[В]]\n', 'Б').text).toBe('- [[А]]\n- [[В]]\n');
  });

  it('из строки с несколькими ссылками уходит только одна', () => {
    expect(removeLinkFromText('[[А]], [[Б]], [[В]]\n', 'Б').text).toBe('[[А]], [[В]]\n');
    expect(removeLinkFromText('- [[А]] [[Б]]\n', 'Б').text).toBe('- [[А]]\n');
    expect(removeLinkFromText('[[Б]] · [[А]]\n', 'Б').text).toBe('[[А]]\n');
    expect(removeLinkFromText('[[Б]] [[Б]]\n\nтекст\n', 'Б').text).toBe('\nтекст\n');
  });

  it('ссылка внутри предложения не трогается — возвращается её место', () => {
    const text = '# Т\nСм. [[Курс ОГЭ]] перед экзаменом.\n';
    const result = removeLinkFromText(text, 'Курс ОГЭ');
    expect(result.status).toBe('inline');
    expect(result.text).toBe(text);
    if (result.status !== 'inline') throw new Error('ожидалось место ссылки');
    expect(text.slice(result.from, result.to)).toBe('[[Курс ОГЭ]]');
  });

  it('пункт с галочкой — тоже проза', () => {
    expect(removeLinkFromText('- [ ] прочитать [[Б]]\n', 'Б').status).toBe('inline');
    expect(removeLinkFromText('- [ ] [[Б]]\n', 'Б').status).toBe('inline');
  });

  it('есть и отдельная строка, и ссылка в прозе — текст не меняется вовсе', () => {
    const text = 'Про [[Б]] тут.\r\n\r\n[[Б]]\r\n';
    const result = removeLinkFromText(text, 'Б');
    expect(result.status).toBe('inline');
    expect(result.text).toBe(text);
    if (result.status !== 'inline') throw new Error('ожидалось место ссылки');
    expect(text.slice(result.from, result.to)).toBe('[[Б]]');
  });

  it('ссылки нет либо она только в коде — ничего не делается', () => {
    expect(removeLinkFromText('Текст [[А]]\n', 'Б')).toEqual({ status: 'none', text: 'Текст [[А]]\n' });
    expect(removeLinkFromText('```\n[[Б]]\n```\n', 'Б').status).toBe('none');
  });
});
