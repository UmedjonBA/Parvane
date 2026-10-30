// Протокол v2 (spec 007, E2): загрузка WASM-движка `parvane-protocol`.
// Модуль собирается `backend/protocol/wasm/build.sh` в src/lib/parvane-protocol.

import init, * as pv from '../../../lib/parvane-protocol/parvane_protocol';
import wasmUrl from '../../../lib/parvane-protocol/parvane_protocol_bg.wasm?url';
import { base64ToBytes } from './base64';

export type Protocol = typeof pv;
export type {
  PvClient, PvHistory, PvState,
} from '../../../lib/parvane-protocol/parvane_protocol';

let loading: Promise<Protocol> | undefined;
let loaded: Protocol | undefined;

/** Загрузить и инициализировать движок (один раз на страницу). */
export function loadProtocol(): Promise<Protocol> {
  if (!loading) {
    loading = init({ module_or_path: wasmUrl }).then(() => {
      loaded = pv;
      return pv;
    }).catch((error: unknown) => {
      loading = undefined;
      throw error;
    });
  }
  return loading;
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

/** REPORT-1 (A0008-2): подпись автора сообщения из жалобы верна — цепочка «корень → устройство → операция»,
 * автор, `op_id`, начало текста и (если задан `groupHex`) группа беседы совпадают с подписанными.
 * Движок не загружен — нет. */
export function verifyMessageProof(
  proofB64: string, opId: string, author: string, text: string, groupHex = '',
): boolean {
  if (!loaded || !proofB64) return false;
  try {
    const bytes = base64ToBytes(proofB64);
    return Boolean((JSON.parse(pv.verifyMessageProof(bytes, opId, author, text, groupHex)) as { ok?: boolean }).ok);
  } catch {
    return false;
  }
}

/** Статическая функция журнала истории движка (spec 033, `historyCall`): результат — разобранный JSON. Отказ
 * (`{"error": …}`) либо не инициализированный движок — исключение. */
export function historyStatic<T>(name: string, args: unknown = {}): T {
  return JSON.parse(pv.historyCall(name, JSON.stringify(args))) as T;
}
