import { describe, expect, it } from 'vitest';

// POLL-1: анонимный опрос группы — участники видят только итоги автора, адресов голосующих у них нет.
import { PollStore } from './polls';

const UUID = 'poll-1';
const ALICE = 'alice@local';
const BOB = 'bob@local';
const CAROL = 'carol@local';

function make(self: string, opts?: { isPublic?: boolean; isGroup?: boolean }) {
  const store = new PollStore();
  store.setSelf(self);
  store.register(UUID, 'chat1', 'Куда идём?', ['кино', 'парк', 'дом'], {
    author: ALICE, isGroup: opts?.isGroup ?? true, isPublic: opts?.isPublic,
  });
  return store;
}

describe('POLL-1 анонимный опрос группы', () => {
  it('признаётся анонимным только в группе и без is_public', () => {
    expect(make(BOB).isAnonymousGroup(UUID)).toBe(true);
    expect(make(BOB, { isPublic: true }).isAnonymousGroup(UUID)).toBe(false);
    expect(make(BOB, { isGroup: false }).isAnonymousGroup(UUID)).toBe(false);
  });

  it('участник считает только итоги автора и не хранит чужие голоса', () => {
    const bob = make(BOB);
    expect(bob.isTallyOnly(UUID)).toBe(true);
    bob.applyVote(UUID, BOB, [1]);
    expect(bob.applyTally(UUID, ALICE, [2, 3, 0], 5)).toBe(true);
    const built = bob.build(UUID)!;
    expect(built.results.totalVoters).toBe(5);
    expect(built.results.resultByOption!['1'].votersCount).toBe(3);
    expect(built.results.resultByOption!['1'].isChosen).toBe(true);
    expect(built.results.recentVoterIds).toBeUndefined();
    expect(bob.getVoters(UUID, 1)).toEqual([]);
  });

  it('итоги принимаются только от автора опроса', () => {
    const bob = make(BOB);
    expect(bob.applyTally(UUID, CAROL, [9, 9, 9], 27)).toBe(false);
    expect(bob.build(UUID)!.results.totalVoters).toBe(0);
  });

  it('счётчики итогов приводятся к числу вариантов и ограничиваются', () => {
    const bob = make(BOB);
    bob.applyTally(UUID, ALICE, [-4, 1.5, 99_999_999_999, 7], -1);
    const built = bob.build(UUID)!;
    expect(built.results.resultByOption!['0'].votersCount).toBe(0);
    expect(built.results.resultByOption!['1'].votersCount).toBe(0);
    expect(built.results.resultByOption!['2'].votersCount).toBe(10_000_000);
    expect(built.results.totalVoters).toBe(0);
  });

  it('автор считает голоса сам и публикует итоги без адресов, повтор того же не шлётся', () => {
    const alice = make(ALICE);
    expect(alice.isTallyOnly(UUID)).toBe(false);
    alice.applyVote(UUID, BOB, [0]);
    alice.applyVote(UUID, CAROL, [0]);
    alice.applyVote(UUID, ALICE, [2]);
    const tally = alice.buildTallyToPublish(UUID)!;
    expect(tally).toEqual({ counts: [2, 0, 1], voters: 3 });
    expect(JSON.stringify(tally)).not.toContain('@');
    expect(alice.buildTallyToPublish(UUID)).toBeUndefined();
    alice.applyVote(UUID, BOB, []); // отзыв голоса
    expect(alice.buildTallyToPublish(UUID)).toEqual({ counts: [1, 0, 1], voters: 2 });
  });

  it('публичный опрос и опрос 1-1 итогов не публикуют', () => {
    const pub = make(ALICE, { isPublic: true });
    pub.applyVote(UUID, BOB, [0]);
    expect(pub.buildTallyToPublish(UUID)).toBeUndefined();
    expect(pub.getVoters(UUID, 0)).toEqual([BOB]);
  });
});
