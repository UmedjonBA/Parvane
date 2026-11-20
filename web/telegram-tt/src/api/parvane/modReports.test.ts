import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  beforeAll, describe, expect, it,
} from 'vitest';

import type { ApiMessage } from '../types';
import type { ParvaneStore } from './store';

import { engineStatic, loadProtocol } from './v2/engine';
import { createModReports } from './modReports';

type Case = { name: string; call: string; args: unknown; expect: unknown };

const SAMPLE = JSON.parse(
  readFileSync(resolve(__dirname, '../../../../../conformance/reports/cases.json'), 'utf8'),
) as { cases: Case[] };

const GROUP_CHAT = '-100';
const OP = '0192a0b0c0d0e0f00112233445566778';

function reportMessage(id: number, chatId: string, senderId: string, reason: string): ApiMessage {
  return {
    id,
    chatId,
    senderId,
    date: 1000 + id,
    isOutgoing: false,
    content: {
      modReport: {
        mediaType: 'modReport',
        groupChatId: GROUP_CHAT,
        reason,
        messages: [{
          uuid: OP, authorId: 'u-spammer', text: 'Купите вентилятор', date: 900,
        }],
      },
    },
  };
}

describe('Жалобы (REPORT-2)', () => {
  beforeAll(async () => {
    await loadProtocol();
  });

  it('движок web отвечает по общему образцу', () => {
    expect(SAMPLE.cases.length).toBeGreaterThanOrEqual(6);
    SAMPLE.cases.forEach((item) => {
      expect(engineStatic(item.call, item.args), item.name).toEqual(item.expect);
    });
  });

  it('список собирается из карточек группы, закрытые не входят', async () => {
    const messages: Record<string, ApiMessage[]> = {
      'u-ann': [reportMessage(1, 'u-ann', 'u-ann', 'spam')],
      'u-bob': [reportMessage(2, 'u-bob', 'u-bob', 'fraud')],
      [GROUP_CHAT]: [{ id: 5, chatId: GROUP_CHAT, date: 900, content: { text: { text: 'x' } } } as ApiMessage],
    };
    const addresses: Record<string, string> = {
      'u-ann': 'ann@demo.test', 'u-bob': 'bob@demo.test', [GROUP_CHAT]: 'v2g:0a0b',
    };
    const store = {
      getChatIds: () => Object.keys(messages),
      getMessages: (id: string) => messages[id],
      getAddressForId: (id: string) => addresses[id],
      getIdForAddress: (address: string) => Object.keys(addresses).find((id) => addresses[id] === address) || '',
      getMessageByUuid: () => messages[GROUP_CHAT][0],
    } as unknown as ParvaneStore;
    let closed: string[] = [];
    const reports = createModReports({
      getStore: () => store,
      ensureAllLoaded: () => Promise.resolve(),
      closedOps: () => closed,
      close: (address, ops) => {
        closed = [...closed, ...ops];
        return Promise.resolve(true);
      },
    });

    const inbox = await reports.parvaneReportInbox({ chatId: GROUP_CHAT });
    expect(inbox?.open).toBe(1);
    expect(inbox?.items[0]).toMatchObject({
      uuid: OP, authorId: 'u-spammer', count: 2, lastDate: 1002, messageId: 5,
    });

    expect(await reports.parvaneReportClose({ chatId: GROUP_CHAT, uuids: [OP] })).toBe(true);
    expect((await reports.parvaneReportInbox({ chatId: GROUP_CHAT }))?.items).toEqual([]);
  });
});
