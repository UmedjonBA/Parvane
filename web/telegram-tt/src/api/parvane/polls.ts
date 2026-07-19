// Опросы: агрегация голосов на клиенте (сервер не видит — всё едет внутри E2E).
// kind=poll (uuid сообщения = pollId), голоса kind=poll_vote {poll,options:[idx]},
// закрытие kind=poll_close. Синтез ApiMessagePoll из накопленного состояния.

import type { ApiMessagePoll } from '../types';

type PollEntry = {
  question: string;
  options: string[];
  chatId: string;
  closed: boolean;
  isPublic: boolean;
  isMultiple: boolean;
  votes: Map<string, number[]>; // адрес голосующего → выбранные индексы
};

export class PollStore {
  private byUuid = new Map<string, PollEntry>();

  private self = '';

  setSelf(self: string) {
    this.self = self;
  }

  register(uuid: string, chatId: string, question: string, options: string[], opts?: {
    isPublic?: boolean; isMultiple?: boolean;
  }) {
    if (this.byUuid.has(uuid)) return;
    this.byUuid.set(uuid, {
      question,
      options,
      chatId,
      closed: false,
      isPublic: Boolean(opts?.isPublic),
      isMultiple: Boolean(opts?.isMultiple),
      votes: new Map(),
    });
  }

  has(uuid: string) {
    return this.byUuid.has(uuid);
  }

  getChatId(uuid: string) {
    return this.byUuid.get(uuid)?.chatId;
  }

  applyVote(uuid: string, voter: string, options: number[]) {
    const entry = this.byUuid.get(uuid);
    if (!entry || entry.closed) return;
    if (options.length) entry.votes.set(voter, options);
    else entry.votes.delete(voter); // пустой = отзыв голоса
  }

  close(uuid: string) {
    const entry = this.byUuid.get(uuid);
    if (entry) entry.closed = true;
  }

  // Адреса проголосовавших за конкретный вариант (для «кто голосовал»)
  getVoters(uuid: string, optionIndex: number): string[] {
    const entry = this.byUuid.get(uuid);
    if (!entry) return [];
    const voters: string[] = [];
    entry.votes.forEach((choices, voter) => {
      if (choices.includes(optionIndex)) voters.push(voter);
    });
    return voters;
  }

  // ApiMessagePoll из текущего агрегата (pollId = FNV(uuid) как число-строка)
  build(uuid: string): ApiMessagePoll | undefined {
    const entry = this.byUuid.get(uuid);
    if (!entry) return undefined;

    const countByOption = entry.options.map(() => 0);
    let totalVoters = 0;
    const myChoices = entry.votes.get(this.self) || [];
    entry.votes.forEach((choices) => {
      totalVoters += 1;
      choices.forEach((idx) => { if (countByOption[idx] !== undefined) countByOption[idx] += 1; });
    });

    const answers = entry.options.map((text, idx) => ({
      text: { text },
      option: String(idx),
    }));
    const resultByOption: Record<string, {
      option: string; votersCount: number; isChosen?: true;
    }> = {};
    entry.options.forEach((_, idx) => {
      resultByOption[String(idx)] = {
        option: String(idx),
        votersCount: countByOption[idx],
        isChosen: myChoices.includes(idx) ? true : undefined,
      };
    });

    return {
      mediaType: 'poll',
      summary: {
        id: uuid,
        hash: '0',
        question: { text: entry.question },
        answers,
        isClosed: entry.closed ? true : undefined,
        isPublic: entry.isPublic ? true : undefined,
        isMultipleChoice: entry.isMultiple ? true : undefined,
      },
      results: {
        totalVoters,
        resultByOption,
      },
    };
  }
}
