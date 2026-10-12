// Ввод текстом: выбор лучшего набора кандидатов. Каждый распознаватель предлагает участки строки с
// оценкой; кандидаты могут пересекаться («с 10:00 до 11:30» — диапазон и два отдельных времени, «до пт» —
// срок и день). Набор без пересечений с наибольшей суммой оценок ищется взвешенным расписанием
// интервалов (динамика по правым концам).
//
// Оценка: `rank * RANK_STEP + длина совпадения`. Ранг — насколько распознаватель точен: составное
// значение старше своих частей (диапазон старше одного времени, длительность «1 ч 30 мин» старше «30 мин»,
// срок «до пт» старше дня «пт»). Суммы сравниваются по рангам сверху вниз: один кандидат старшего ранга
// сильнее любого числа младших; при равенстве старших — больше кандидатов следующего ранга, затем длиннее
// совпадения («в 7 вечера» сильнее «в 7»). Поэтому результат не зависит от того, сколько мелких
// совпадений попало внутрь крупного.
//
// Слот (`slot`) — значение, которое в записи одно (время, день, срок…): из выбранных кандидатов слота
// остаётся старший по рангу, при равенстве — стоящий левее; остальные уходят из набора, а их место
// достаётся другим.

export const RANK_STEP = 1000;

export type PickItem = { from: number; to: number; score: number; slot?: string };

export function candidateScore(rank: number, from: number, to: number) {
  return rank * RANK_STEP + Math.min(Math.max(to - from, 0), RANK_STEP - 1);
}

function rankOf(item: PickItem) {
  return Math.floor(item.score / RANK_STEP);
}

function isAbove(a: number[], b: number[]) {
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return a[i] > b[i];
  }
  return false;
}

// Лучший набор без пересечений; слоты не учитываются
function schedule<T extends PickItem>(items: T[]): T[] {
  const sorted = [...items].sort((a, b) => a.to - b.to || a.from - b.from);
  // Места рангов в сумме: старший — первым
  const ranks = [...new Set(sorted.map(rankOf))].sort((a, b) => b - a);
  const place = new Map(ranks.map((rank, index) => [rank, index]));
  const empty = ranks.map(() => 0);
  // totals[i] — лучшая сумма среди первых i кандидатов; picks[i] — взят ли кандидат i - 1
  const totals: number[][] = [empty];
  const isTaken: boolean[] = [false];
  const before: number[] = [0];
  sorted.forEach((item, index) => {
    // Сколько кандидатов кончается не позже начала этого
    let free = index;
    while (free > 0 && sorted[free - 1].to > item.from) free--;
    const withItem = [...totals[free]];
    withItem[place.get(rankOf(item))!] += RANK_STEP + (item.score % RANK_STEP);
    // При равенстве остаётся набор без этого кандидата: он стоит левее
    const isBetter = isAbove(withItem, totals[index]);
    totals.push(isBetter ? withItem : totals[index]);
    isTaken.push(isBetter);
    before.push(free);
  });
  const chosen: T[] = [];
  let index = sorted.length;
  while (index > 0) {
    if (isTaken[index]) {
      chosen.push(sorted[index - 1]);
      index = before[index];
    } else {
      index -= 1;
    }
  }
  return chosen.reverse();
}

/** Лучший набор кандидатов без пересечений, не больше одного на слот; порядок — по месту в строке. */
export function pickCandidates<T extends PickItem>(items: T[]): T[] {
  let pool = items.filter((item) => item.to > item.from);
  for (;;) {
    const chosen = schedule(pool);
    const winners = new Map<string, T>();
    const losers = new Set<T>();
    chosen.forEach((item) => {
      if (!item.slot) return;
      const winner = winners.get(item.slot);
      // Набор идёт слева направо: при равном ранге остаётся первый
      if (!winner || rankOf(item) > rankOf(winner)) {
        if (winner) losers.add(winner);
        winners.set(item.slot, item);
      } else {
        losers.add(item);
      }
    });
    if (!losers.size) return chosen;
    pool = pool.filter((item) => !losers.has(item));
  }
}
