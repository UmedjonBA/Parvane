// Через сервер ли идёт звонок (доски `PhCalls`, `DkCalls`: «Звонок идёт через сервер · шифрование включено»):
// выбранная пара ICE, у которой хотя бы одна сторона — relay (TURN)

export type CallRoute = 'relay' | 'direct';

type StatsEntry = {
  id: string;
  type: string;
  state?: string;
  nominated?: boolean;
  selected?: boolean;
  selectedCandidatePairId?: string;
  localCandidateId?: string;
  remoteCandidateId?: string;
  candidateType?: string;
};

/** Маршрут по отчёту `getStats`; `undefined` — пара ещё не выбрана. */
export function pickCallRoute(entries: StatsEntry[]): CallRoute | undefined {
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const transport = entries.find((entry) => entry.type === 'transport' && entry.selectedCandidatePairId);
  const pair = (transport && byId.get(transport.selectedCandidatePairId!))
    || entries.find((entry) => entry.type === 'candidate-pair' && entry.selected)
    || entries.find((entry) => entry.type === 'candidate-pair' && entry.nominated && entry.state === 'succeeded');
  if (!pair) return undefined;
  const local = byId.get(pair.localCandidateId || '');
  const remote = byId.get(pair.remoteCandidateId || '');
  if (!local && !remote) return undefined;
  return local?.candidateType === 'relay' || remote?.candidateType === 'relay' ? 'relay' : 'direct';
}

export async function readCallRoute(pc?: RTCPeerConnection) {
  if (!pc) return undefined;
  try {
    const report = await pc.getStats();
    const entries: StatsEntry[] = [];
    report.forEach((entry) => entries.push(entry as StatsEntry));
    return pickCallRoute(entries);
  } catch {
    return undefined;
  }
}
