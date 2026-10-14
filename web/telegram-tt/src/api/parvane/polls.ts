// Опросы: агрегация голосов на клиенте (сервер не видит — всё едет внутри E2E).
// kind=poll (uuid сообщения = pollId), голоса kind=poll_vote {poll,options:[idx]},
// закрытие kind=poll_close. Синтез ApiMessagePoll из накопленного состояния.
// Quiz: correct-индексы и solution едут в kind=poll и раскрываются клиентом
// только после собственного голоса или закрытия (как в Telegram).
// Срок (`close_ms`), запрет переголосования, перемешивание и скрытые до срока
// итоги тоже едут в kind=poll и соблюдаются клиентами.

import type { ApiMessagePoll } from '../types';

type PollEntry = {
  author?: string;
  question: string;
  options: string[];
  chatId: string;
  closed: boolean;
  isPublic: boolean;
  isMultiple: boolean;
  isQuiz: boolean;
  correct: number[];
  solution?: string;
  // Срок опроса (мс) и момент создания (мс) — для кольца оставшегося времени
  closeAt?: number;
  createdAt?: number;
  noRevote: boolean;
  shuffle: boolean;
  hideResults: boolean;
  votes: Map<string, number[]>; // адрес голосующего → выбранные индексы
};

type PollOptions = {
  isPublic?: boolean; isMultiple?: boolean; isQuiz?: boolean; correct?: number[]; solution?: string;
  // P-44: автор опроса — только он может закрыть
  author?: string;
  closeAt?: number; createdAt?: number; noRevote?: boolean; shuffle?: boolean; hideResults?: boolean;
};

const RECENT_VOTERS_LIMIT = 3;
// Голос, отправленный чуть позже срока (расхождение часов), ещё принимается
const CLOSE_GRACE_MS = 60_000;
// setTimeout не ждёт дольше ~24,8 суток — дальний срок досматривается повторно
const MAX_TIMER_MS = 2_147_000_000;

export class PollStore {
  private byUuid = new Map<string, PollEntry>();

  private self = '';

  private resolvePeerId: (address: string) => string = (address) => address;

  private onExpire?: (uuid: string) => void;

  private timers = new Map<string, number>();

  reset() {
    this.byUuid.clear();
    this.timers.forEach((timer) => clearTimeout(timer));
    this.timers.clear();
  }

  // Опрос со сроком перерисовывается в момент закрытия
  setExpireHandler(handler: (uuid: string) => void) {
    this.onExpire = handler;
  }

  setSelf(self: string) {
    this.self = self;
  }

  // Адрес → телеграм-подобный id (для recentVoterIds/списков голосовавших)
  setPeerIdResolver(resolve: (address: string) => string) {
    this.resolvePeerId = resolve;
  }

  register(uuid: string, chatId: string, question: string, options: string[], opts?: PollOptions) {
    if (this.byUuid.has(uuid)) return;
    this.byUuid.set(uuid, {
      question,
      options,
      chatId,
      author: opts?.author,
      closed: false,
      isPublic: Boolean(opts?.isPublic),
      isMultiple: Boolean(opts?.isMultiple),
      isQuiz: Boolean(opts?.isQuiz),
      correct: opts?.correct || [],
      solution: opts?.solution,
      closeAt: opts?.closeAt || undefined,
      createdAt: opts?.createdAt,
      noRevote: Boolean(opts?.noRevote),
      shuffle: Boolean(opts?.shuffle),
      hideResults: Boolean(opts?.hideResults),
      votes: new Map(),
    });
    this.scheduleExpire(uuid);
  }

  has(uuid: string) {
    return this.byUuid.has(uuid);
  }

  getChatId(uuid: string) {
    return this.byUuid.get(uuid)?.chatId;
  }

  // P-44: закрыть опрос может только его автор
  canClose(uuid: string, actor: string) {
    const entry = this.byUuid.get(uuid);
    return Boolean(entry && entry.author && entry.author === actor);
  }

  // P-44: голос принимается только из того чата, где опубликован опрос
  isInChat(uuid: string, chatId: string) {
    const entry = this.byUuid.get(uuid);
    return Boolean(entry && entry.chatId === chatId);
  }

  // `atMs` — время голоса (у истории — время отправки), чтобы срок не отбрасывал старые голоса после reload
  applyVote(uuid: string, voter: string, options: number[], atMs = Date.now()) {
    const entry = this.byUuid.get(uuid);
    if (!entry || entry.closed) return;
    if (entry.closeAt && atMs > entry.closeAt + CLOSE_GRACE_MS) return;
    // Quiz и опрос без переголосования: голос финален
    if ((entry.isQuiz || entry.noRevote) && entry.votes.has(voter)) return;
    if (options.length) entry.votes.set(voter, options);
    else entry.votes.delete(voter); // пустой = отзыв голоса
  }

  close(uuid: string) {
    const entry = this.byUuid.get(uuid);
    if (entry) entry.closed = true;
  }

  private isClosed(entry: PollEntry) {
    return entry.closed || Boolean(entry.closeAt && Date.now() >= entry.closeAt);
  }

  private scheduleExpire(uuid: string) {
    const entry = this.byUuid.get(uuid);
    if (!entry?.closeAt || this.timers.has(uuid)) return;
    const delay = entry.closeAt - Date.now();
    if (delay <= 0) return;
    this.timers.set(uuid, window.setTimeout(() => {
      this.timers.delete(uuid);
      if (delay > MAX_TIMER_MS) {
        this.scheduleExpire(uuid);
        return;
      }
      this.onExpire?.(uuid);
    }, Math.min(delay, MAX_TIMER_MS)));
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
    const isClosed = this.isClosed(entry);
    const isRevealed = isClosed || myChoices.length > 0;

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
        isClosed: isClosed ? true : undefined,
        isPublic: entry.isPublic ? true : undefined,
        isMultipleChoice: entry.isMultiple ? true : undefined,
        isQuiz: entry.isQuiz ? true : undefined,
        isCreator: entry.author && entry.author === this.self ? true : undefined,
        isRevoteDisabled: entry.noRevote ? true : undefined,
        shouldShuffleAnswers: entry.shuffle ? true : undefined,
        shouldHideResultsUntilClose: entry.hideResults ? true : undefined,
        closeDate: entry.closeAt ? Math.floor(entry.closeAt / 1000) : undefined,
        closePeriod: entry.closeAt && entry.createdAt
          ? Math.max(1, Math.round((entry.closeAt - entry.createdAt) / 1000)) : undefined,
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

// spec 005: desktop исторически пишет answers/public/multiple/quiz, web —
// options/is_public/is_multiple/is_quiz. Читаем оба набора (android пишет оба).
export function readPollFields(content: Record<string, unknown>) {
  const list = (
    Array.isArray(content.options) ? content.options
      : Array.isArray(content.answers) ? content.answers
        : []
  ) as unknown[];
  const flag = (web: string, desk: string) => Boolean(content[web] ?? content[desk]);
  return {
    question: typeof content.question === 'string' ? content.question : '',
    options: list.map(String),
    isPublic: flag('is_public', 'public'),
    isMultiple: flag('is_multiple', 'multiple'),
    isQuiz: flag('is_quiz', 'quiz'),
    correct: Array.isArray(content.correct) ? (content.correct as number[]) : undefined,
    solution: typeof content.solution === 'string' ? content.solution : undefined,
    closeAt: Number(content.close_ms) || undefined,
    noRevote: Boolean(content.no_revote),
    shuffle: Boolean(content.shuffle),
    hideResults: Boolean(content.hide_results),
  };
}
