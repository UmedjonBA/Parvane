// Криптография v1 (Olm 1-1, Megolm групп, подписи Ed25519) на движке
// `parvane-protocol` (vodozemac в WASM). Формат провода v1 прежний: тот же,
// что у desktop/android (`parvane-e2e`) и у прежних web-клиентов на libolm.
//
// Pickle нового формата помечен префиксом `vz1:`; строка без префикса читается
// как libolm-pickle (состояния прежних версий web, копии ключей). Ключ — та же
// строка `pickleKey` состояния.

import type {
  Protocol, PvMegolmInbound, PvMegolmOutbound, PvOlmAccount, PvOlmSession,
} from './v2/engine';

import { loadProtocol } from './v2/engine';

export type OlmAccount = PvOlmAccount;
export type OlmSession = PvOlmSession;
export type MegolmOutbound = PvMegolmOutbound;
export type MegolmInbound = PvMegolmInbound;
// `type`: 0 — pre-key сообщение, 1 — обычное
export type OlmCiphertext = { type: number; body: string };

let protocol: Protocol | undefined;

/** Загрузить движок; до этого остальные функции модуля недоступны. */
export async function loadOlm() {
  protocol = await loadProtocol();
}

export function createAccount(): OlmAccount {
  return new (requireProtocol().PvOlmAccount)();
}

export function unpickleAccount(pickle: string, key: string): OlmAccount {
  return requireProtocol().PvOlmAccount.unpickle(pickle, key);
}

export function unpickleSession(pickle: string, key: string): OlmSession {
  return requireProtocol().PvOlmSession.unpickle(pickle, key);
}

/** Входящая сессия из pre-key сообщения; использованный one-time ключ удаляется из аккаунта. */
export function createInboundSession(
  account: OlmAccount, senderIdentity: string, body: string,
): { session: OlmSession; plaintext: string } {
  return account.createInboundSession(senderIdentity, body);
}

export function encryptOlm(session: OlmSession, plaintext: string): OlmCiphertext {
  return session.encrypt(plaintext);
}

export function createOutboundGroup(): MegolmOutbound {
  return new (requireProtocol().PvMegolmOutbound)();
}

export function unpickleOutboundGroup(pickle: string, key: string): MegolmOutbound {
  return requireProtocol().PvMegolmOutbound.unpickle(pickle, key);
}

/** Входящая сессия из ключа сессии (SKDM). */
export function createInboundGroup(sessionKey: string): MegolmInbound {
  return requireProtocol().PvMegolmInbound.create(sessionKey);
}

/** Входящая сессия из экспортированного ключа (формат libolm `export_session`). */
export function importInboundGroup(exported: string): MegolmInbound {
  return requireProtocol().PvMegolmInbound.importSession(exported);
}

export function unpickleInboundGroup(pickle: string, key: string): MegolmInbound {
  return requireProtocol().PvMegolmInbound.unpickle(pickle, key);
}

export function decryptGroup(
  session: MegolmInbound, ciphertext: string,
): { plaintext: string; messageIndex: number } {
  return session.decrypt(ciphertext);
}

/** Проверка подписи Ed25519 над строкой; ключ и подпись — base64. */
export function verifyEd25519(publicKey: string, message: string, signature: string): boolean {
  return requireProtocol().ed25519Verify(publicKey, message, signature);
}

function requireProtocol() {
  if (!protocol) throw new Error('Protocol engine is not loaded.');
  return protocol;
}
