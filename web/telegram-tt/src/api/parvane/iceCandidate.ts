// CALL-1: ICE-кандидат в поле `candidate` сигнала звонка — JSON-строка.
// Канонические поля — `candidate`, `sdp_mid`, `sdp_mline_index`; рядом для уже
// выпущенных клиентов кладутся прежние имена web (`sdpMid`, `sdpMLineIndex`) и
// desktop (`sdp`, `mid`, `idx`). До 2 окт 2026 web и desktop писали каждый свой
// вид и чужих кандидатов не понимали — звонок между ними не соединялся.
// Тот же кодек в ядре: `desktop/parvane-core/include/parvane/call.h`

type RawIceCandidate = {
  candidate?: unknown;
  sdp?: unknown;
  sdp_mid?: unknown;
  sdpMid?: unknown;
  mid?: unknown;
  sdp_mline_index?: unknown;
  sdpMLineIndex?: unknown;
  idx?: unknown;
  usernameFragment?: unknown;
};

function pickString(...values: unknown[]) {
  return values.find((value): value is string => typeof value === 'string');
}

function pickInteger(...values: unknown[]) {
  return values.find((value): value is number => typeof value === 'number' && Number.isInteger(value));
}

export function encodeIceCandidate(candidate: RTCIceCandidateInit): string {
  const sdp = candidate.candidate || '';
  // eslint-disable-next-line no-null/no-null
  const mid = candidate.sdpMid === null ? undefined : candidate.sdpMid;
  // eslint-disable-next-line no-null/no-null
  const index = candidate.sdpMLineIndex === null ? undefined : candidate.sdpMLineIndex;
  return JSON.stringify({
    candidate: sdp,
    sdp_mid: mid,
    sdp_mline_index: index,
    sdpMid: mid,
    sdpMLineIndex: index,
    usernameFragment: candidate.usernameFragment || undefined,
    sdp,
    mid,
    idx: index,
  });
}

/** Любой из трёх видов → `RTCIceCandidateInit`; `undefined` — не объект или нет строки кандидата. */
export function decodeIceCandidate(raw: string): RTCIceCandidateInit | undefined {
  let parsed: RawIceCandidate;
  try {
    parsed = JSON.parse(raw) as RawIceCandidate;
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== 'object') return undefined;
  const candidate = pickString(parsed.candidate, parsed.sdp);
  if (!candidate) return undefined;
  return {
    candidate,
    sdpMid: pickString(parsed.sdp_mid, parsed.sdpMid, parsed.mid),
    sdpMLineIndex: pickInteger(parsed.sdp_mline_index, parsed.sdpMLineIndex, parsed.idx),
    usernameFragment: pickString(parsed.usernameFragment),
  };
}
