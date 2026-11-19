import { describe, expect, it } from 'vitest';

import {
  buildMessageNotifyBody, buildNotifyButtons, buildNotifyTitle, getWorkerNotifyTexts, parseReminderKey,
  readNotifyData, resolveNotifyClick,
} from './systemNotify';

const BODY = {
  chatTitle: 'Алия', summary: 'Пришли конфиг', isTextShown: true, isLocked: false, hiddenText: 'Новое сообщение',
};

describe('системные уведомления', () => {
  it('заголовок — «Parvane · модуль»', () => {
    expect(buildNotifyTitle('Parvane', 'Чаты')).toBe('Parvane · Чаты');
  });

  it('текст сообщения — только при включённом показе, иначе «Новое сообщение»; под PIN — без чата', () => {
    expect(buildMessageNotifyBody(BODY)).toBe('Алия\nПришли конфиг');
    expect(buildMessageNotifyBody({ ...BODY, chatTitle: 'Linux-чат', senderName: 'Тимур' }))
      .toBe('Linux-чат\nТимур: Пришли конфиг');
    expect(buildMessageNotifyBody({ ...BODY, senderName: 'Алия' })).toBe('Алия\nПришли конфиг');
    expect(buildMessageNotifyBody({ ...BODY, isTextShown: false })).toBe('Алия\nНовое сообщение');
    expect(buildMessageNotifyBody({ ...BODY, isLocked: true })).toBe('Новое сообщение');
  });

  it('кнопки по виду уведомления; у пробуждения сервера кнопок нет', () => {
    const label = (action: string) => action.toUpperCase();
    expect(buildNotifyButtons('message', label).map(({ action }) => action)).toEqual(['reply', 'read']);
    expect(buildNotifyButtons('call', label).map(({ action }) => action)).toEqual(['answer', 'decline']);
    expect(buildNotifyButtons('reminder', label)).toEqual([
      { action: 'done', title: 'DONE' }, { action: 'snooze', title: 'SNOOZE' },
    ]);
    expect(buildNotifyButtons('wake', label)).toEqual([]);
  });

  it('нажатие: открыть — с показом окна, фоновые действия — без', () => {
    const message = { kind: 'message', chatId: '42', messageId: 7 };
    expect(resolveNotifyClick(message, '')).toEqual({
      command: {
        kind: 'message', chatId: '42', messageId: 7, action: '',
        callId: undefined, reminderKey: undefined, reminderTitle: undefined,
      },
      shouldFocus: true,
    });
    expect(resolveNotifyClick(message, 'read').shouldFocus).toBe(false);
    expect(resolveNotifyClick(message, 'reply').shouldFocus).toBe(true);
    expect(resolveNotifyClick({ kind: 'call', callId: 'c' }, 'answer').shouldFocus).toBe(true);
    expect(resolveNotifyClick({ kind: 'call', callId: 'c' }, 'decline').shouldFocus).toBe(false);
    expect(resolveNotifyClick({ kind: 'reminder', reminderKey: 'k' }, 'snooze').shouldFocus).toBe(false);
  });

  it('чужая кнопка или кнопка не своего вида — как нажатие на уведомление', () => {
    expect(resolveNotifyClick({ kind: 'message', chatId: '1' }, 'snooze').command.action).toBe('');
    expect(resolveNotifyClick({ kind: 'wake' }, 'read').command.action).toBe('');
    expect(resolveNotifyClick({ kind: 'call' }, 'rm -rf').command.action).toBe('');
  });

  it('данные прежних уведомлений: с чатом — сообщение, без — пробуждение', () => {
    expect(readNotifyData({ chatId: '5', messageId: 3 }).kind).toBe('message');
    expect(readNotifyData({ count: 1 }).kind).toBe('wake');
    expect(readNotifyData(undefined).kind).toBe('wake');
    expect(readNotifyData({ kind: 'evil', chatId: '' }).kind).toBe('wake');
  });

  it('ключ напоминания: запись и день, в том числе у отложенного', () => {
    expect(parseReminderKey('t1@2026-10-20@15')).toEqual({ id: 't1', day: '2026-10-20' });
    expect(parseReminderKey('a@b@2026-10-20@15~1800000000000')).toEqual({ id: 'a@b', day: '2026-10-20' });
    expect(parseReminderKey('t1@сегодня@15')).toBeUndefined();
    expect(parseReminderKey('t1')).toBeUndefined();
  });

  it('тексты service worker — русский по языку системы, иначе английский', () => {
    expect(getWorkerNotifyTexts('ru-RU').snooze).toBe('Через 10 мин');
    expect(getWorkerNotifyTexts('de-DE').newMessage).toBe('New message');
  });
});
