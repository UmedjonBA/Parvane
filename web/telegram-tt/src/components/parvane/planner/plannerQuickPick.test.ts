import { describe, expect, it } from 'vitest';

import type { PickItem } from './plannerQuickPick';

import { candidateScore, pickCandidates, RANK_STEP } from './plannerQuickPick';

type Item = PickItem & { name: string };

function item(name: string, rank: number, from: number, to: number, slot?: string): Item {
  return {
    name, from, to, slot, score: candidateScore(rank, from, to),
  };
}

function names(items: Item[]) {
  return pickCandidates(items).map(({ name }) => name);
}

// Сумма оценок набора: по рангам сверху вниз — число кандидатов и длина совпадений
function total(items: Item[]) {
  const ranks: Record<number, number> = {};
  items.forEach(({ score }) => {
    const rank = Math.floor(score / RANK_STEP);
    ranks[rank] = (ranks[rank] || 0) + RANK_STEP + (score % RANK_STEP);
  });
  return ranks;
}

function isAbove(a: Record<number, number>, b: Record<number, number>) {
  const ranks = [...new Set([...Object.keys(a), ...Object.keys(b)].map(Number))].sort((x, y) => y - x);
  for (const rank of ranks) {
    if ((a[rank] || 0) !== (b[rank] || 0)) return (a[rank] || 0) > (b[rank] || 0);
  }
  return false;
}

// Полный перебор: лучший набор без пересечений (слоты не учитываются)
function bruteForce(items: Item[]) {
  let best: Item[] = [];
  for (let mask = 0; mask < 2 ** items.length; mask++) {
    const subset = items.filter((_, index) => mask & (1 << index));
    const isClash = subset.some((a, i) => subset.some((b, j) => i < j && a.from < b.to && b.from < a.to));
    if (!isClash && isAbove(total(subset), total(best))) best = subset;
  }
  return best;
}

function seeded(seed: number) {
  let state = seed;
  return () => {
    state = (state * 1664525 + 1013904223) % 4294967296;
    return state / 4294967296;
  };
}

describe('выбор кандидатов', () => {
  it('пустой набор и кандидаты без пересечений', () => {
    expect(names([])).toEqual([]);
    expect(names([item('b', 1, 6, 9), item('a', 1, 0, 5)])).toEqual(['a', 'b']);
    // Соседние участки не пересекаются; пустой участок не кандидат
    expect(names([item('a', 1, 0, 5), item('b', 1, 5, 9), item('empty', 9, 3, 3)])).toEqual(['a', 'b']);
  });

  it('составное старше своих частей: диапазон сильнее двух времён', () => {
    // «с 10:00 до 11:30»: диапазон и два отдельных времени внутри него
    const range = item('range', 30, 0, 16);
    expect(names([item('from', 29, 2, 7), item('to', 29, 11, 16), range])).toEqual(['range']);
    // Сколько бы младших ни попало внутрь старшего
    const inner = Array.from({ length: 12 }, (_, index) => item(`inner${index}`, 29, index, index + 1));
    expect(names([...inner, range])).toEqual(['range']);
  });

  it('срок «до пт» сильнее дня «пт», длительность «1 ч 30 мин» — «30 мин»', () => {
    expect(names([item('day', 10, 3, 5), item('due', 12, 0, 5)])).toEqual(['due']);
    expect(names([item('minutes', 32, 4, 10), item('hours', 33, 0, 10)])).toEqual(['hours']);
  });

  it('при равном ранге сильнее длинное совпадение: «в 7 вечера» против «в 7»', () => {
    expect(names([item('short', 28, 0, 3), item('long', 28, 0, 10)])).toEqual(['long']);
    expect(names([item('long', 28, 0, 10), item('short', 28, 0, 3)])).toEqual(['long']);
    // Равные совпадения: остаётся стоящее левее
    expect(names([item('right', 28, 2, 6), item('left', 28, 0, 4)])).toEqual(['left']);
  });

  it('старший кандидат освобождает место, которое занял бы младший', () => {
    // b (старший) пересекает a и c; без b были бы взяты a и c
    const a = item('a', 5, 0, 4);
    const b = item('b', 9, 3, 7);
    const c = item('c', 5, 6, 10);
    expect(names([a, c])).toEqual(['a', 'c']);
    expect(names([a, b, c])).toEqual(['b']);
    // Цепочка: старший d вытесняет b, и a с c возвращаются
    expect(names([a, b, c, item('d', 12, 4, 6)])).toEqual(['a', 'd', 'c']);
  });

  it('слот: одно значение — старшее по рангу, при равенстве левое', () => {
    expect(names([item('second', 29, 10, 15, 'time'), item('first', 29, 0, 5, 'time')])).toEqual(['first']);
    expect(names([item('clock', 29, 0, 5, 'time'), item('range', 30, 10, 21, 'time')])).toEqual(['range']);
    expect(names([item('time', 29, 0, 5, 'time'), item('day', 10, 6, 9, 'day')])).toEqual(['time', 'day']);
    // Проигравший в слоте освобождает место младшему кандидату другого слота
    expect(names([
      item('first', 29, 0, 5, 'time'), item('second', 29, 10, 15, 'time'), item('day', 10, 9, 14, 'day'),
    ])).toEqual(['first', 'day']);
    // …и следующему кандидату того же слота, который тоже отпадает
    expect(names([
      item('first', 29, 0, 5, 'time'), item('second', 29, 10, 15, 'time'), item('third', 28, 12, 18, 'time'),
      item('day', 10, 16, 20, 'day'),
    ])).toEqual(['first', 'day']);
  });

  it('оценка: ранг и длина совпадения', () => {
    expect(candidateScore(30, 0, 16)).toBe(30016);
    expect(candidateScore(30, 5, 5)).toBe(30000);
    // Длина не переливается в ранг
    expect(candidateScore(30, 0, 50000)).toBe(30999);
  });

  it('набор лучший из возможных: сверка с полным перебором', () => {
    const random = seeded(20261012);
    for (let round = 0; round < 400; round++) {
      const count = 1 + Math.floor(random() * 11);
      const items = Array.from({ length: count }, (_, index) => {
        const from = Math.floor(random() * 30);
        return item(`c${index}`, 1 + Math.floor(random() * 5), from, from + 1 + Math.floor(random() * 10));
      });
      const picked = pickCandidates(items);
      const isClash = picked.some((a, i) => picked.some((b, j) => i < j && a.from < b.to && b.from < a.to));
      expect(isClash, JSON.stringify(items)).toBe(false);
      expect(total(picked), JSON.stringify(items)).toEqual(total(bruteForce(items)));
      // Порядок — по месту в строке
      expect(picked.map(({ from }) => from)).toEqual(picked.map(({ from }) => from).sort((a, b) => a - b));
    }
  });

  it('много кандидатов выбираются быстро', () => {
    const random = seeded(3);
    const items = Array.from({ length: 2000 }, (_, index) => {
      const from = Math.floor(random() * 20000);
      const to = from + 1 + Math.floor(random() * 12);
      return item(`c${index}`, 1 + Math.floor(random() * 30), from, to, `s${index % 400}`);
    });
    const started = performance.now();
    const picked = pickCandidates(items);
    expect(picked.length).toBeGreaterThan(0);
    expect(new Set(picked.map(({ slot }) => slot)).size).toBe(picked.length);
    expect(performance.now() - started).toBeLessThan(5000);
  });
});
