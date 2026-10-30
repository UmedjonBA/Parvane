/* eslint-disable no-null/no-null -- JSON движка планировщика: null = «не задано» */
import { describe, expect, it } from 'vitest';

import { v2Class, v2ToWire, wireToV2 } from './v2/contentMap';
import {
  buildOfferEvent, findOfferInPlan, getOfferEventEnd, getTaskOfferKind, TaskOfferStore, taskOfferText,
  taskResponseText,
} from './taskOffers';

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

  it('вид карточки: событие — день и время начала без шагов и срока, иначе задание', () => {
    expect(getTaskOfferKind({ day: '2026-10-20', start: '10:00', minutes: 60 })).toBe('event');
    expect(getTaskOfferKind({ day: '2026-10-20', start: '10:00', steps: [] })).toBe('event');
    expect(getTaskOfferKind({ day: '2026-10-20', minutes: 60 })).toBe('task');
    expect(getTaskOfferKind({})).toBe('task');
    // Поля, которые есть только у задачи, оставляют карточку заданием — они не теряются
    expect(getTaskOfferKind({ day: '2026-10-20', start: '10:00', steps: ['цифры'] })).toBe('task');
    expect(getTaskOfferKind({ day: '2026-10-20', start: '10:00', due: '2026-10-21' })).toBe('task');
    // Чужой клиент мог прислать что угодно: негодные день и время движок отверг бы
    expect(getTaskOfferKind({ start: '10:00' })).toBe('task');
    expect(getTaskOfferKind({ day: '2026-13-01', start: '10:00' })).toBe('task');
    expect(getTaskOfferKind({ day: '2026-10-20', start: '24:00' })).toBe('task');
    expect(getTaskOfferKind({ day: '2026-10-20', start: '9:00' })).toBe('task');
  });

  it('событие для плана: id карточки, конец по длительности, час по умолчанию, не позже конца суток', () => {
    const uuid = '0192f0e4-1a2b-7c3d-8e4f-001122334455';
    expect(buildOfferEvent(uuid, { name: 'Созвон', day: '2026-10-20', start: '10:00', minutes: 45 })).toEqual({
      id: uuid,
      name: 'Созвон',
      start: '10:00',
      end: '10:45',
      weekdays: null,
      day: '2026-10-20',
      repeat: null,
      occurrences: [],
      origin: null,
      allDay: false,
      isHoliday: false,
      color: 0,
    });
    expect(buildOfferEvent(uuid, { name: 'Отчёт', day: '2026-10-20', minutes: 60 })).toBeUndefined();
    expect(buildOfferEvent(uuid, { name: 'Отчёт', day: '2026-10-20', start: '10:00', steps: ['а'] })).toBeUndefined();
    expect(getOfferEventEnd('09:30')).toBe('10:30');
    expect(getOfferEventEnd('09:30', 0)).toBe('10:30');
    expect(getOfferEventEnd('23:30', 120)).toBe('23:59');
  });

  it('запись плана из карточки: задача по source без дефисов, событие по id; прежняя задача важнее', () => {
    const uuid = '0192f0e4-1a2b-7c3d-8e4f-001122334455';
    const opId = '0192f0e41a2b7c3d8e4f001122334455';
    expect(findOfferInPlan(undefined, uuid)).toBeUndefined();
    expect(findOfferInPlan({ tasks: [], events: [] }, uuid)).toBeUndefined();
    expect(findOfferInPlan({ tasks: [{ id: 't0' }, { id: 't1', day: '2026-10-20', source: { opId } }] }, uuid))
      .toEqual({ kind: 'task', id: 't1', day: '2026-10-20' });
    // JSON движка: пустая строка и null — «не задано»
    expect(findOfferInPlan({ tasks: [{ id: 't1', day: '', source: { opId } }, { id: 't2', source: null }] }, uuid))
      .toEqual({ kind: 'task', id: 't1', day: undefined });
    expect(findOfferInPlan({ events: [{ id: 'other' }, { id: uuid, day: '2026-10-21' }] }, uuid))
      .toEqual({ kind: 'event', id: uuid, day: '2026-10-21' });
    // Карточка со временем, принятая задачей до появления «События», второй записи не получает
    expect(findOfferInPlan({ tasks: [{ id: 't1', source: { opId } }], events: [{ id: uuid }] }, uuid)?.kind)
      .toBe('task');
  });

  it('текст карточки-события и ответа на неё', () => {
    expect(taskOfferText({ name: 'Созвон', day: '2026-10-20', start: '10:00', minutes: 30 }))
      .toBe('📅 Событие: Созвон · 2026-10-20 10:00 · 30 мин');
    expect(taskResponseText('Созвон', true, 'event')).toBe('✅ Принято: событие «Созвон»');
    expect(taskResponseText('Созвон', false, 'event')).toBe('❌ Отклонено: событие «Созвон»');
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

describe('день чужой карточки', () => {
  it('негодный day отбрасывается при регистрации', () => {
    const store = new TaskOfferStore();
    store.setSelf('bob@local');
    store.setPeerIdResolver((address) => `id:${address}`);
    store.register('u2', 'chat', { kind: 'task_offer', name: 'Х', day: 'не-дата' }, 'alice@local');
    expect(store.build('u2')!.day).toBeUndefined();
  });
});

describe('решения по заданию (A0036-2)', () => {
  it('решение из чужого чата не принимается, ожидающие решения ограничены', () => {
    const store = new TaskOfferStore();
    store.setSelf('bob@local');
    store.setPeerIdResolver((address) => `id:${address}`);
    store.register('u3', 'chat-a', { kind: 'task_offer', name: 'Х' }, 'alice@local');
    store.applyResponse('u3', 'mallory@local', true, 10, 'chat-b');
    expect(store.build('u3')!.responses).toEqual([]);
    store.applyResponse('u3', 'carol@local', true, 10, 'chat-a');
    expect(store.build('u3')!.responses).toHaveLength(1);
    // Поток решений по неизвестным карточкам не копится без предела
    for (let i = 0; i < 1000; i++) store.applyResponse(`flood${i}`, 'mallory@local', true, 1);
    store.register('flood0', 'chat-a', { kind: 'task_offer', name: 'Х' }, 'alice@local');
    expect(store.build('flood0')!.responses).toEqual([]);
    store.register('flood999', 'chat-a', { kind: 'task_offer', name: 'Х' }, 'alice@local');
    expect(store.build('flood999')!.responses).toHaveLength(1);
  });
});
