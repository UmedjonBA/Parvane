import { describe, expect, it } from 'vitest';

import { v2Class, v2ToWire, wireToV2 } from './v2/contentMap';
import { TaskOfferStore, taskOfferText, taskResponseText } from './taskOffers';

describe('задание в чат (spec 011, TASK-1)', () => {
  it('карточка и решения: регистрация, ответы по участникам, поздний ответ побеждает, своё решение', () => {
    const store = new TaskOfferStore();
    store.setSelf('bob@local');
    store.setPeerIdResolver((address) => `id:${address}`);
    // Ответ раньше карточки — ждёт её появления
    store.applyResponse('u1', 'carol@local', false, 10);
    store.register('u1', 'chat', {
      kind: 'task_offer',
      name: 'Отчёт',
      description: 'за неделю',
      steps: ['цифры'],
      day: '2026-10-20',
      start: '10:00',
      minutes: 60,
    }, 'alice@local');
    store.applyResponse('u1', 'bob@local', true, 12);
    store.applyResponse('u1', 'carol@local', true, 11);
    // Старый ответ не перекрывает новый
    store.applyResponse('u1', 'bob@local', false, 5);
    const built = store.build('u1')!;
    expect(built).toMatchObject({
      mediaType: 'taskOffer', id: 'u1', name: 'Отчёт', day: '2026-10-20', minutes: 60, isOwn: false, myDecision: true,
    });
    expect(built.responses).toEqual([
      { userId: 'id:carol@local', isAccepted: true }, { userId: 'id:bob@local', isAccepted: true },
    ]);
    store.setSelf('alice@local');
    expect(store.build('u1')!.isOwn).toBe(true);
    expect(store.build('u1')!.myDecision).toBeUndefined();
    expect(store.getChatId('u1')).toBe('chat');
    expect(store.build('nope')).toBeUndefined();
  });

  it('текст для клиентов без планировщика и ответа', () => {
    expect(taskOfferText({ name: 'Отчёт', day: '2026-10-20', start: '10:00', minutes: 60, due: '2026-10-21' }))
      .toBe('📋 Задание: Отчёт · 2026-10-20 10:00 · 60 мин · до 2026-10-21');
    expect(taskOfferText({ name: 'Без даты' })).toBe('📋 Задание: Без даты');
    expect(taskResponseText('Отчёт', true)).toBe('✅ Принято: задание «Отчёт»');
    expect(taskResponseText('Отчёт', false)).toBe('❌ Отклонено: задание «Отчёт»');
  });

  it('содержимое v2 ↔ wire: задание и решение — видимые сообщения', () => {
    const offer = wireToV2({
      kind: 'task_offer', name: 'Отчёт', steps: ['а', 'б'], day: '2026-10-20', minutes: 60, text: '📋 Задание: Отчёт',
    });
    expect(offer).toEqual({
      task_offer: {
        name: 'Отчёт', steps: [{ text: 'а' }, { text: 'б' }], day: '2026-10-20', minutes: 60, text: '📋 Задание: Отчёт',
      },
    });
    expect(v2Class(offer)).toBe('message');
    expect(v2ToWire(offer)).toEqual({
      kind: 'task_offer', name: 'Отчёт', steps: ['а', 'б'], day: '2026-10-20', minutes: 60, text: '📋 Задание: Отчёт',
    });
    const uuid = '0192f0e4-1a2b-7c3d-8e4f-001122334455';
    const response = wireToV2({ kind: 'task_response', offer: uuid, accepted: false, text: '❌' });
    expect(response.task_response).toMatchObject({ decision: 'TASK_DECISION_DECLINED', text: '❌' });
    expect(v2ToWire(response)).toEqual({ kind: 'task_response', offer: uuid, accepted: false, text: '❌' });
    expect(v2Class(response)).toBe('message');
  });
});
