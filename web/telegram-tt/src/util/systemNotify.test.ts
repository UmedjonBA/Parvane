import { describe, expect, it } from 'vitest';

import {
  buildMessageNotifyBody, buildMuteUntil, buildNotifyButtons, buildNotifyTitle, DEFAULT_NOTIFY_PREFS,
  getIsNotifyAllowed, getIsQuietMinute, getReminderNotifyModule, getWorkerNotifyTexts, parseReminderKey, readNotifyData,
  readNotifyPrefs, resolveNotifyClick,
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
    expect(buildMessageNotifyBody({ ...BODY, isLocked: true, lockedHint: 'Разблокируйте, чтобы прочитать' }))
      .toBe('Новое сообщение\nРазблокируйте, чтобы прочитать');
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
  it('настройки уведомлений: выключенный модуль молчит, «Не беспокоить» — через полночь и внутри дня', () => {
    const at = (hours: number, minutes: number) => new Date(2026, 10, 19, hours, minutes);
    const prefs = { ...DEFAULT_NOTIFY_PREFS, off: ['plan' as const] };
    expect(getIsNotifyAllowed(prefs, 'plan', at(12, 0))).toBe(false);
    expect(getIsNotifyAllowed(prefs, 'chats', at(12, 0))).toBe(true);
    const night = { ...DEFAULT_NOTIFY_PREFS, isQuietOn: true };
    expect(getIsNotifyAllowed(night, 'chats', at(23, 30))).toBe(false);
    expect(getIsNotifyAllowed(night, 'chats', at(3, 0))).toBe(false);
    expect(getIsNotifyAllowed(night, 'chats', at(7, 0))).toBe(true);
    expect(getIsNotifyAllowed(night, 'chats', at(23, 29))).toBe(true);
    const day = { ...night, quietFrom: 13 * 60, quietTo: 14 * 60 };
    expect(getIsQuietMinute(day, 13 * 60 + 59)).toBe(true);
    expect(getIsQuietMinute(day, 14 * 60)).toBe(false);
    expect(getIsQuietMinute({ ...day, quietTo: 13 * 60 }, 13 * 60)).toBe(false);
    expect(getIsQuietMinute({ ...night, isQuietOn: false }, 0)).toBe(false);
  });

  it('сохранённые настройки уведомлений: неизвестное и испорченное — по умолчанию', () => {
    expect(readNotifyPrefs(undefined)).toEqual(DEFAULT_NOTIFY_PREFS);
    expect(readNotifyPrefs({ off: ['chats', 'evil', 3], isQuietOn: 'yes', quietFrom: 1440, quietTo: 60 })).toEqual({
      ...DEFAULT_NOTIFY_PREFS, off: ['chats'], quietTo: 60,
    });
  });

  it('«Не беспокоить» на время: час и до утра (ночью — сегодня, днём — завтра); «Трек скачан» — «Слушать»', () => {
    const at = (day: number, hours: number) => new Date(2026, 10, day, hours, 0);
    expect(buildMuteUntil('hour', DEFAULT_NOTIFY_PREFS, at(19, 14))).toBe(at(19, 15).getTime());
    expect(buildMuteUntil('morning', DEFAULT_NOTIFY_PREFS, at(19, 2))).toBe(at(19, 7).getTime());
    expect(buildMuteUntil('morning', DEFAULT_NOTIFY_PREFS, at(19, 14))).toBe(at(20, 7).getTime());
    const muted = { ...DEFAULT_NOTIFY_PREFS, muteUntil: at(19, 15).getTime() };
    expect(getIsNotifyAllowed(muted, 'chats', at(19, 14))).toBe(false);
    expect(getIsNotifyAllowed(muted, 'chats', at(19, 15))).toBe(true);
    expect(readNotifyPrefs({ muteUntil: 'soon' }).muteUntil).toBe(0);
    expect(readNotifyPrefs({ off: ['music'], muteUntil: 5 }))
      .toEqual({ ...DEFAULT_NOTIFY_PREFS, off: ['music'], muteUntil: 5 });
    expect(buildNotifyButtons('music', (action) => action).map(({ action }) => action)).toEqual(['listen']);
    expect(resolveNotifyClick({ kind: 'music', trackId: 't1' }, 'listen')).toEqual({
      command: { kind: 'music', trackId: 't1', action: 'listen' }, shouldFocus: true,
    });
  });

  it('отбой — модуль «Здоровье», записи — «План»; модули «Здоровье» и «Файлы» выключаются отдельно', () => {
    expect(getReminderNotifyModule('bedtime@2026-11-21@0')).toBe('health');
    expect(getReminderNotifyModule('task1@2026-11-21@15')).toBe('plan');
    const prefs = readNotifyPrefs({ off: ['health', 'files'], isQuietCustom: true });
    expect(prefs.off).toEqual(['health', 'files']);
    expect(prefs.isQuietCustom).toBe(true);
    const noon = new Date(2026, 10, 21, 12, 0);
    expect(getIsNotifyAllowed(prefs, 'health', noon)).toBe(false);
    expect(getIsNotifyAllowed(prefs, 'plan', noon)).toBe(true);
  });
});
