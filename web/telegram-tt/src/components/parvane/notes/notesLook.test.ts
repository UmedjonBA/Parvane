import { describe, expect, it } from 'vitest';

import { previewLines } from './notesLook';
import { dailyNoteTemplate } from './notesModel';

const DAY = '2026-10-13';

describe('заметки: начало текста для карточки', () => {
  it('шаблон заметки дня — пусто: заголовок с датой и пустой пункт не показываются', () => {
    expect(previewLines({ title: DAY, text: dailyNoteTemplate(DAY) }, 4)).toEqual({ lines: [], hasMore: false });
    expect(previewLines({ title: DAY, text: '' }, 4)).toEqual({ lines: [], hasMore: false });
  });

  it('строки идут по порядку: текст, пункты с галочками, списки, заголовки', () => {
    const text = [
      `# ${DAY}`, '', 'Выспался, **бодро**.', '', '- [ ] позвонить в банк до пт ^tab12c', '- [x] зарядка',
      '* купить `кофе`', '## Итоги', 'Всё по плану',
    ].join('\n');
    expect(previewLines({ title: DAY, text }, 10)).toEqual({
      lines: [
        { text: 'Выспался, бодро.' },
        { text: 'позвонить в банк до пт', mark: 'todo' },
        { text: 'зарядка', mark: 'done' },
        { text: 'купить кофе', mark: 'bullet' },
        { text: 'Итоги', mark: 'heading' },
        { text: 'Всё по плану' },
      ],
      hasMore: false,
    });
  });

  it('ссылка показывается подписью либо названием заметки', () => {
    const text = 'Созвон по [[Сервер X99|серверу]] и [[Курс ОГЭ]]';
    expect(previewLines({ title: DAY, text }, 4).lines).toEqual([{ text: 'Созвон по серверу и Курс ОГЭ' }]);
  });

  it('лишние строки отрезаются, о продолжении сообщается', () => {
    const text = ['один', 'два', 'три', 'четыре'].join('\n');
    expect(previewLines({ title: DAY, text }, 3)).toEqual({
      lines: [{ text: 'один' }, { text: 'два' }, { text: 'три' }], hasMore: true,
    });
    expect(previewLines({ title: DAY, text }, 4).hasMore).toBe(false);
  });

  it('блок свойств, код и пустые строки в начало текста не входят', () => {
    const text = [
      '---', 'настроение: 4', '---', `# ${DAY}`, '', '```', 'let a = 1', '```', '', '- [ ] ', 'Мысль',
    ].join('\n');
    expect(previewLines({ title: DAY, text }, 4).lines).toEqual([{ text: 'Мысль' }]);
  });

  it('длинная строка обрезается', () => {
    const [line] = previewLines({ title: DAY, text: 'я'.repeat(500) }, 4).lines;
    expect(line.text).toHaveLength(140);
  });
});

describe('заметки: разбор подписи без квадратичного времени', () => {
  it('строка из «[[» без закрытия', () => {
    const started = Date.now();
    previewLines({ title: 'x', text: '[['.repeat(40000) }, 4);
    previewLines({ title: 'x', text: '[[a|'.repeat(20000) }, 4);
    expect(Date.now() - started).toBeLessThan(1500);
  });
});
