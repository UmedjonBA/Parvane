// Задания в чат (spec 011, TASK-1): карточка задания — сообщение вида
// `task_offer` (uuid сообщения = id задания), решения участников — сообщения
// `task_response` со ссылкой на карточку. Всё едет внутри E2E, сервер не видит.
// Хранилище восстанавливается из кэша истории: строки обоих видов проходят
// обычным конвейером сообщений и индексируются здесь (в отличие от опросов,
// чьи голоса живут только в памяти).

import type { ApiTaskOffer } from '../types';
import type { WireMessageContent } from './wire';

type OfferEntry = {
  chatId: string;
  author?: string;
  name: string;
  description: string;
  steps: string[];
  day?: string;
  start?: string;
  minutes?: number;
  due?: string;
  // адрес участника → решение и время (поздний ответ побеждает)
  responses: Map<string, { isAccepted: boolean; ts: number }>;
};

export class TaskOfferStore {
  private byUuid = new Map<string, OfferEntry>();

  // Ответы, пришедшие раньше карточки (порядок доставки), — до её появления
  private pendingResponses = new Map<string, Map<string, { isAccepted: boolean; ts: number }>>();

  private self = '';

  private resolvePeerId: (address: string) => string = (address) => address;

  reset() {
    this.byUuid.clear();
    this.pendingResponses.clear();
  }

  setSelf(self: string) {
    this.self = self;
  }

  setPeerIdResolver(resolve: (address: string) => string) {
    this.resolvePeerId = resolve;
  }

  register(uuid: string, chatId: string, content: WireMessageContent, author?: string) {
    if (this.byUuid.has(uuid)) return;
    const entry: OfferEntry = {
      chatId,
      author,
      name: content.name || '',
      description: content.description || '',
      steps: content.steps || [],
      day: content.day || undefined,
      start: content.start || undefined,
      minutes: content.minutes || undefined,
      due: content.due || undefined,
      responses: this.pendingResponses.get(uuid) || new Map(),
    };
    this.pendingResponses.delete(uuid);
    this.byUuid.set(uuid, entry);
  }

  has(uuid: string) {
    return this.byUuid.has(uuid);
  }

  getChatId(uuid: string) {
    return this.byUuid.get(uuid)?.chatId;
  }

  get(uuid: string) {
    return this.byUuid.get(uuid);
  }

  applyResponse(uuid: string, from: string, isAccepted: boolean, ts: number) {
    const entry = this.byUuid.get(uuid);
    const responses = entry?.responses || this.pendingResponses.get(uuid) || new Map();
    if (!entry && !this.pendingResponses.has(uuid)) this.pendingResponses.set(uuid, responses);
    const previous = responses.get(from);
    if (previous && previous.ts > ts) return;
    responses.set(from, { isAccepted, ts });
  }

  getDecision(uuid: string, address: string) {
    return this.byUuid.get(uuid)?.responses.get(address)?.isAccepted;
  }

  // Содержимое карточки для нативного UI (как `PollStore.build`)
  build(uuid: string): ApiTaskOffer | undefined {
    const entry = this.byUuid.get(uuid);
    if (!entry) return undefined;
    const responses = [...entry.responses]
      .sort((a, b) => a[1].ts - b[1].ts)
      .map(([address, response]) => ({ userId: this.resolvePeerId(address), isAccepted: response.isAccepted }));
    return {
      mediaType: 'taskOffer',
      id: uuid,
      name: entry.name,
      description: entry.description,
      steps: entry.steps,
      day: entry.day,
      start: entry.start,
      minutes: entry.minutes,
      due: entry.due,
      isOwn: Boolean(entry.author && entry.author === this.self),
      responses,
      myDecision: entry.responses.get(this.self)?.isAccepted,
    };
  }
}

/** Текстовое представление задания для клиентов без планировщика (TASK-1). */
export function taskOfferText(offer: {
  name: string; day?: string; start?: string; minutes?: number; due?: string;
}) {
  const parts = [`📋 Задание: ${offer.name}`];
  if (offer.day) parts.push(`${offer.day}${offer.start ? ` ${offer.start}` : ''}`);
  if (offer.minutes) parts.push(`${offer.minutes} мин`);
  if (offer.due) parts.push(`до ${offer.due}`);
  return parts.join(' · ').slice(0, 600);
}

export function taskResponseText(name: string, isAccepted: boolean) {
  return `${isAccepted ? '✅ Принято' : '❌ Отклонено'}: задание «${name}»`.slice(0, 300);
}
