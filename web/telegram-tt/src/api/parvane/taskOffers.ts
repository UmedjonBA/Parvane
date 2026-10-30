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

const DAY_RE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

const PENDING_RESPONSES_LIMIT = 200;
const RESPONSES_PER_OFFER_LIMIT = 500;

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
      // День из чужой карточки — только настоящая дата: иначе «План» выбрал бы несуществующий день
      day: content.day && DAY_RE.test(content.day) ? content.day : undefined,
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

  // `chatId` — чат, откуда пришло решение: для известной карточки оно принимается только из её чата.
  // Решения до самой карточки копятся ограниченно (иначе поток чужих uuid раздувал бы память)
  applyResponse(uuid: string, from: string, isAccepted: boolean, ts: number, chatId?: string) {
    const entry = this.byUuid.get(uuid);
    if (entry && chatId !== undefined && entry.chatId !== chatId) return;
    if (!entry && !this.pendingResponses.has(uuid)) {
      if (this.pendingResponses.size >= PENDING_RESPONSES_LIMIT) {
        const oldest = this.pendingResponses.keys().next().value;
        if (oldest !== undefined) this.pendingResponses.delete(oldest);
      }
      this.pendingResponses.set(uuid, new Map());
    }
    const responses = entry?.responses || this.pendingResponses.get(uuid)!;
    const previous = responses.get(from);
    if (previous && previous.ts > ts) return;
    if (!previous && responses.size >= RESPONSES_PER_OFFER_LIMIT) return;
    responses.set(from, { isAccepted, ts });
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

// ── Вид карточки: «Задание» либо «Событие» ──────────────────────────────────
// Отдельного вида содержимого у события нет: это то же `task_offer`. Событие —
// карточка с днём и временем начала и без полей, которые есть только у задачи
// (шаги, срок): такое предложение — встреча, а не работа, и в план оно идёт
// событием календаря. Всё остальное — задание.

export type TaskOfferKind = 'task' | 'event';

type OfferFields = {
  name: string; steps?: string[]; day?: string; start?: string; minutes?: number; due?: string;
};

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const DEFAULT_EVENT_MINUTES = 60;
const LAST_MINUTE = 1439;

export function getTaskOfferKind(offer: Omit<OfferFields, 'name'>): TaskOfferKind {
  const isTimed = Boolean(offer.day && offer.start && DAY_RE.test(offer.day) && TIME_RE.test(offer.start));
  return isTimed && !offer.steps?.length && !offer.due ? 'event' : 'task';
}

function toClock(minutes: number) {
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
}

/** Конец события: начало + длительность (час, если её нет), не позже конца суток. */
export function getOfferEventEnd(start: string, minutes?: number) {
  const startMinutes = Number(start.slice(0, 2)) * 60 + Number(start.slice(3, 5));
  const length = minutes && minutes > 0 ? minutes : DEFAULT_EVENT_MINUTES;
  return toClock(Math.min(startMinutes + length, LAST_MINUTE));
}

/**
 * Правка движка планировщика для карточки-события. У события в домене нет поля
 * `source`, поэтому его id — uuid карточки: повторное добавление ложится в тот же объект.
 */
export function buildOfferEvent(uuid: string, offer: OfferFields) {
  if (getTaskOfferKind(offer) !== 'event') return undefined;
  /* eslint-disable no-null/no-null -- JSON движка: null = «не задано» */
  return {
    id: uuid,
    name: offer.name,
    start: offer.start!,
    end: getOfferEventEnd(offer.start!, offer.minutes),
    weekdays: null,
    day: offer.day!,
    repeat: null,
    occurrences: [],
    origin: null,
    allDay: false,
    isHoliday: false,
    color: 0,
  };
  /* eslint-enable no-null/no-null */
}

type PlanState = {
  tasks?: { id?: string; day?: string; source?: { opId?: string } | null }[];
  events?: { id?: string; day?: string }[];
};

/**
 * Запись плана, созданная из карточки: задача по `source.opId` (hex uuid без
 * дефисов — иное движок отвергает) либо событие с id карточки. Подходит и JSON
 * движка, и состояние экранов.
 */
export function findOfferInPlan(
  state: PlanState | undefined, uuid: string,
): { kind: TaskOfferKind; id: string; day?: string } | undefined {
  const opId = uuid.replace(/-/g, '');
  const task = state?.tasks?.find((candidate) => candidate.source?.opId === opId);
  if (task) return { kind: 'task', id: task.id || '', day: task.day || undefined };
  const event = state?.events?.find((candidate) => candidate.id === uuid);
  if (event) return { kind: 'event', id: uuid, day: event.day || undefined };
  return undefined;
}

/** Текстовое представление задания для клиентов без планировщика (TASK-1). */
export function taskOfferText(offer: OfferFields) {
  const parts = [getTaskOfferKind(offer) === 'event' ? `📅 Событие: ${offer.name}` : `📋 Задание: ${offer.name}`];
  if (offer.day) parts.push(`${offer.day}${offer.start ? ` ${offer.start}` : ''}`);
  if (offer.minutes) parts.push(`${offer.minutes} мин`);
  if (offer.due) parts.push(`до ${offer.due}`);
  return parts.join(' · ').slice(0, 600);
}

export function taskResponseText(name: string, isAccepted: boolean, kind: TaskOfferKind = 'task') {
  const subject = kind === 'event' ? 'событие' : 'задание';
  return `${isAccepted ? '✅ Принято' : '❌ Отклонено'}: ${subject} «${name}»`.slice(0, 300);
}
