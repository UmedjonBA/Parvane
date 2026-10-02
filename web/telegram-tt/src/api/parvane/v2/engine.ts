// Протокол v2 (spec 007, E2): загрузка WASM-движка `parvane-protocol`.
// Модуль собирается `backend/protocol/wasm/build.sh` в src/lib/parvane-protocol.

import init, * as pv from '../../../lib/parvane-protocol/parvane_protocol';
import wasmUrl from '../../../lib/parvane-protocol/parvane_protocol_bg.wasm?url';

export type Protocol = typeof pv;
export type {
  PvClient, PvMegolmInbound, PvMegolmOutbound, PvOlmAccount, PvOlmSession, PvState,
} from '../../../lib/parvane-protocol/parvane_protocol';

let loading: Promise<Protocol> | undefined;

/** Загрузить и инициализировать движок (один раз на страницу). */
export function loadProtocol(): Promise<Protocol> {
  if (!loading) {
    loading = init({ module_or_path: wasmUrl }).then(() => pv).catch((error: unknown) => {
      loading = undefined;
      throw error;
    });
  }
  return loading;
}

/** Включён ли протокол v2 (флаг сборки или localStorage для тестов). */
export function isV2Enabled(): boolean {
  if (import.meta.env.VITE_PARVANE_PROTO_V2 === '1') return true;
  try {
    return localStorage.getItem('parvane:proto') === 'v2';
  } catch {
    return false;
  }
}

/** Ошибка движка: {need} (добрать данные) или {error} (вид ProtoError). */
export type EngineError =
  | { need: { kind: string; user?: string; after?: number; group?: string; epoch?: number } }
  | { error: string };

export function parseEngineError(e: unknown): EngineError {
  try {
    return JSON.parse(String(e)) as EngineError;
  } catch {
    return { error: String(e) };
  }
}
