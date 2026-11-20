// Жалобы у админа группы (spec 041, доски `RpChat`, `XpChat`; правило REPORT-2). Нового серверного хранилища нет:
// список собирается из полученных карточек `mod_report` этой группы (личные сообщения пожаловавшихся, уже сверенные
// со своей историей в `store.ts`), закрытые — объекты `REPORT_CLOSED` личного состояния. Свести жалобы по сообщениям,
// посчитать пожаловавшихся и выбрать причину — дело движка (`reportInbox`); здесь — только сбор и показ.

import type { ApiMessage, ApiModReport } from '../types';
import type { ParvaneStore } from './store';
import type { WireStoredMessage } from './wire';

import { engineStatic } from './v2/engine';

/** Строка списка жалоб (одно сообщение группы). */
export type ParvaneReportItem = {
  uuid: string;
  authorId: string;
  text: string;
  /** Время сообщения, с. */
  date: number;
  /** Время последней жалобы, с. */
  lastDate: number;
  /** Самая частая причина (`spam` | `fraud` | `insult` | `illegal` | `other`). */
  reason: string;
  /** Сколько человек пожаловались. */
  count: number;
  comments: { reporterId: string; text: string }[];
  /** Сообщение есть в своей истории группы — можно открыть. */
  messageId?: number;
};

// Начало `text` карточки `mod_report` (см. `messages.ts reportMessages`)
const FALLBACK_MARK = '⚠️';

export type ParvaneReportInbox = { items: ParvaneReportItem[]; open: number };

type EngineItem = {
  uuid: string; author: string; text: string; ts: number; lastTs: number; reason: string; count: number;
  comments: { reporter: string; text: string }[];
};

export type ModReportsDeps = {
  getStore: () => ParvaneStore;
  /** Все чаты целиком в памяти (жалобы лежат в личных чатах с пожаловавшимися). */
  ensureAllLoaded: () => Promise<void>;
  closedOps: (address: string) => string[];
  /** Строка истории по id сообщения (сырой `mod_report` карточки, показанной текстом). */
  findRow?: (uuid: string) => Promise<WireStoredMessage | undefined>;
  /** Пересобранная карточка — в стор и на экран (иначе в чате она так и осталась бы текстом). */
  onCardRebuilt?: (message: ApiMessage) => void;
  close: (address: string, opIds: string[]) => Promise<boolean>;
};

export function createModReports(deps: ModReportsDeps) {
  async function reportsOf(groupChatId: string) {
    const store = deps.getStore();
    const candidates = store.getChatIds()
      .flatMap((id) => store.getMessages(id))
      .filter((m) => !m.isOutgoing && (m.content.modReport || isFallbackCard(m)));
    const found = await Promise.all(candidates.map(async (m) => {
      const report = m.content.modReport || await rebuildCard(m);
      return report?.groupChatId === groupChatId ? { m, report } : undefined;
    }));
    return found.filter((x): x is { m: ApiMessage; report: ApiModReport } => Boolean(x)).map(({ m, report }) => ({
      id: `${m.chatId}:${m.id}`,
      reporter: (m.senderId && store.getAddressForId(m.senderId)) || '',
      ts: m.date,
      reason: report.reason,
      comment: report.comment || '',
      messages: report.messages.map((x) => ({
        uuid: x.uuid, author: x.authorId, text: x.text, ts: x.date,
      })),
    }));
  }

  // Карточка, собранная до загрузки движка либо до своей истории группы, показана текстом (`text` жалобы) и сама
  // не пересобирается; список жалоб собирает её заново из строки истории
  async function rebuildCard(m: ApiMessage): Promise<ApiModReport | undefined> {
    const store = deps.getStore();
    const uuid = store.getUuidForMessage(m.chatId, m.id);
    const row = uuid ? await deps.findRow?.(uuid) : undefined;
    if (row?.content.kind !== 'mod_report') return undefined;
    const modReport = store.buildApiMessage(row).content.modReport;
    if (modReport) deps.onCardRebuilt?.({ ...m, content: { modReport } });
    return modReport;
  }

  async function inbox(groupChatId: string): Promise<ParvaneReportInbox | undefined> {
    const store = deps.getStore();
    const address = store.getAddressForId(groupChatId);
    if (!address) return undefined;
    await deps.ensureAllLoaded();
    const result = engineStatic<{ items: EngineItem[]; open: number }>('reportInbox', {
      reports: await reportsOf(groupChatId), closed: deps.closedOps(address),
    });
    const items = result.items.map((i): ParvaneReportItem => {
      const local = store.getMessageByUuid(i.uuid);
      return {
        uuid: i.uuid,
        // В карточке автор уже id пользователя (сверен со своей историей)
        authorId: i.author,
        text: i.text,
        date: i.ts,
        lastDate: i.lastTs,
        reason: i.reason,
        count: i.count,
        comments: i.comments.map((c) => ({
          reporterId: c.reporter ? store.getIdForAddress(c.reporter, 'user') : '', text: c.text,
        })),
        messageId: local && local.chatId === groupChatId ? local.id : undefined,
      };
    });
    return { items, open: result.open };
  }

  return {
    /** Список жалоб группы (только незакрытые). */
    async parvaneReportInbox({ chatId }: { chatId: string }) {
      return inbox(chatId);
    },
    /** Закрыть жалобы на сообщения («Отклонить», а также после удаления и блокировки). */
    async parvaneReportClose({ chatId, uuids }: { chatId: string; uuids: string[] }) {
      const address = deps.getStore().getAddressForId(chatId);
      if (!address || !uuids.length) return false;
      return deps.close(address, uuids);
    },
  };
}

function isFallbackCard(message: ApiMessage) {
  return Boolean(message.content.text?.text.startsWith(FALLBACK_MARK));
}
