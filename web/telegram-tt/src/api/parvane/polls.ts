// Опросы: агрегация голосов на клиенте (сервер не видит — всё едет внутри E2E).
// kind=poll (uuid сообщения = pollId), голоса kind=poll_vote {poll,options:[idx]},
// закрытие kind=poll_close. Синтез ApiMessagePoll из накопленного состояния.
// Quiz: correct-индексы и solution едут в kind=poll и раскрываются клиентом
// только после собственного голоса или закрытия (как в Telegram).

import type { ApiMessagePoll } from '../types';

type PollEntry = {
  question: string;
  options: string[];
  chatId: string;
  closed: boolean;
  isPublic: boolean;
  isMultiple: boolean;
  isQuiz: boolean;
  correct: number[];
  solution?: string;
  votes: Map<string, number[]>; // адрес голосующего → выбранные индексы
};

const RECENT_VOTERS_LIMIT = 3;

export class PollStore {
  private byUuid = new Map<string, PollEntry>();

  private self = '';

  private resolvePeerId: (address: string) => string = (address) => address;

  setSelf(self: string) {
    this.self = self;
  }

  // Адрес → телеграм-подобный id (для recentVoterIds/списков голосовавших)
  setPeerIdResolver(resolve: (address: string) => string) {
    this.resolvePeerId = resolve;
  }

  register(uuid: string, chatId: string, question: string, options: string[], opts?: {
    isPublic?: boolean; isMultiple?: boolean; isQuiz?: boolean; correct?: number[]; solution?: string;
  }) {
    if (this.byUuid.has(uuid)) return;
    this.byUuid.set(uuid, {
      question,
      options,
      chatId,
      closed: false,
      isPublic: Boolean(opts?.isPublic),
      isMultiple: Boolean(opts?.isMultiple),
      isQuiz: Boolean(opts?.isQuiz),
      correct: opts?.correct || [],
      solution: opts?.solution,
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
    // Quiz: голос финален, отзыв и переголосование запрещены
    if (entry.isQuiz && entry.votes.has(voter)) return;
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

  // ApiMessagePoll из текущего агрегата (pollId = uuid сообщения)
  build(uuid: string): ApiMessagePoll | undefined {
    const entry = this.byUuid.get(uuid);
    if (!entry) return undefined;

    const countByOption = entry.options.map(() => 0);
    let totalVoters = 0;
    const recentVoterIds: string[] = [];
    const myChoices = entry.votes.get(this.self) || [];
    entry.votes.forEach((choices, voter) => {
      totalVoters += 1;
      if (recentVoterIds.length < RECENT_VOTERS_LIMIT) {
        recentVoterIds.push(this.resolvePeerId(voter));
      }
      choices.forEach((idx) => {
        if (countByOption[idx] !== undefined) countByOption[idx] += 1;
      });
    });

    // Правильные ответы и пояснение раскрываются только после собственного
    // голоса или закрытия — до того quiz выглядит как обычный опрос
    const isRevealed = entry.closed || myChoices.length > 0;

    const answers = entry.options.map((text, idx) => ({
      text: { text },
      option: String(idx),
    }));
    const resultByOption: Record<string, {
      option: string; votersCount: number; isChosen?: true; isCorrect?: true;
    }> = {};
    entry.options.forEach((_, idx) => {
      resultByOption[String(idx)] = {
        option: String(idx),
        votersCount: countByOption[idx],
        isChosen: myChoices.includes(idx) ? true : undefined,
        isCorrect: entry.isQuiz && isRevealed && entry.correct.includes(idx) ? true : undefined,
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
        isQuiz: entry.isQuiz ? true : undefined,
      },
      results: {
        totalVoters,
        resultByOption,
        recentVoterIds: entry.isPublic && recentVoterIds.length ? recentVoterIds : undefined,
        solution: entry.isQuiz && isRevealed ? entry.solution : undefined,
      },
    };
  }
}
