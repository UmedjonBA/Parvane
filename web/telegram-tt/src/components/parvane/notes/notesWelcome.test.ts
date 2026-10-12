import { describe, expect, it } from 'vitest';

import { parseNote } from './notesModel';
import { planNoteTasks } from './notesTasks';
import {
  buildWelcomeNote, getWelcomeLang, WELCOME_NOTE_NODE_ID, WELCOME_VAULT_NODE_ID, type WelcomeLang,
} from './notesWelcome';

// Понедельник, 12 октября 2026
const CTX = {
  today: '2026-10-12', nowMinutes: 9 * 60, dayStart: 8 * 60, dayEnd: 22 * 60,
};
const LANGS: WelcomeLang[] = ['ru', 'en'];

describe('notesWelcome', () => {
  it('выбирает язык заметки по языку интерфейса', () => {
    expect(getWelcomeLang('ru')).toBe('ru');
    expect(getWelcomeLang('ru-RU')).toBe('ru');
    expect(getWelcomeLang('en')).toBe('en');
    expect(getWelcomeLang('de')).toBe('en');
    expect(getWelcomeLang(undefined)).toBe('en');
  });

  it('идентификаторы узлов — по 16 байт шестнадцатеричными цифрами и разные', () => {
    expect(WELCOME_VAULT_NODE_ID).toMatch(/^[0-9a-f]{32}$/);
    expect(WELCOME_NOTE_NODE_ID).toMatch(/^[0-9a-f]{32}$/);
    expect(WELCOME_NOTE_NODE_ID).not.toBe(WELCOME_VAULT_NODE_ID);
  });

  LANGS.forEach((lang) => {
    describe(lang, () => {
      const note = buildWelcomeNote(lang);
      const parsed = parseNote(note.text);

      it('начинается заголовком с названием и умещается на экран', () => {
        expect(note.text.split('\n')[0]).toBe(`# ${note.title}`);
        expect(note.text.split('\n').length).toBeLessThanOrEqual(26);
        expect(/[\\/:*?"<>|]/.test(note.title)).toBe(false);
      });

      it('ссылается только на заметку, которой ещё нет', () => {
        expect(parsed.links).toEqual([note.linkedTitle]);
      });

      it('несёт теги и два пункта без меток', () => {
        expect(parsed.tags.length).toBe(2);
        expect(parsed.tasks.length).toBe(2);
        expect(parsed.tasks.every((task) => !task.isDone && !task.marker)).toBe(true);
      });

      it('не заводит задач в «Плане»: сохранение текста ничего не планирует и не меняет', () => {
        const planned = planNoteTasks(note.text, CTX);
        expect(planned.tasks).toEqual([]);
        expect(planned.text).toBe(note.text);
      });

      it('примеры пунктов с датой стоят в тексте кодом и разбираются как задачи', () => {
        note.datedSamples.forEach((sample) => {
          expect(note.text).toContain(`\`- [ ] ${sample}\``);
          const planned = planNoteTasks(`- [ ] ${sample}`, CTX, () => 'abcde');
          expect(planned.tasks.length).toBe(1);
          expect(planned.tasks[0].day || planned.tasks[0].due).toBeTruthy();
        });
      });
    });
  });
});
