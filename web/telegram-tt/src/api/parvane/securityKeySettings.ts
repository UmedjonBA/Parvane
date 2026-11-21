import type { SecurityKeyInfo } from './securityKeys';
import type { V2Json } from './v2/control';

import { V2Error } from './v2/transport';
import { checkSecurityKeySupported, createSecurityKey, parseSecurityKeyList } from './securityKeys';

// Карточка «Ключ безопасности» в настройках (SECKEY-1, доска `ZdProfileX`): список ключей, добавление, снятие и
// «Требовать ключ при входе». Добавление, снятие и выключатель — со свежим паролем (`identity.session.reauth`)

export type SecurityKeyState = {
  keys: SecurityKeyInfo[];
  isRequired: boolean;
  isRecoveryReady: boolean;
  isSupported: boolean;
};

export type SecurityKeyChange = 'ok' | 'bad_password' | 'no_recovery' | 'limit' | 'duplicate' | 'not_linked'
  | 'cancelled' | 'unsupported' | 'failed';

type Deps = {
  call: (method: string, request: V2Json) => Promise<V2Json>;
  selfAddress: () => string;
  log: (message: string) => void;
};

const ERROR_RESULTS: Record<string, SecurityKeyChange> = {
  ERROR_CODE_NOT_FOUND: 'no_recovery',
  ERROR_CODE_LIMIT: 'limit',
  ERROR_CODE_DUPLICATE: 'duplicate',
  ERROR_CODE_FORBIDDEN: 'not_linked',
};

export function createSecurityKeySettings(deps: Deps) {
  async function getState(): Promise<SecurityKeyState> {
    const list = parseSecurityKeyList(await deps.call('identity.seckey.list', {}));
    return { ...list, isSupported: checkSecurityKeySupported() };
  }

  async function reauth(password: string): Promise<SecurityKeyChange | undefined> {
    try {
      await deps.call('identity.session.reauth', { password });
      return undefined;
    } catch (err) {
      return err instanceof V2Error && err.code === 'ERROR_CODE_FORBIDDEN' ? 'bad_password' : 'failed';
    }
  }

  function classify(err: unknown, fallback: SecurityKeyChange = 'failed'): SecurityKeyChange {
    deps.log(`ключ безопасности: ${String(err)}`);
    return err instanceof V2Error ? ERROR_RESULTS[err.code] || fallback : fallback;
  }

  async function addKey(password: string, name: string): Promise<SecurityKeyChange> {
    const denied = await reauth(password);
    if (denied) return denied;
    try {
      const challenge = await deps.call('identity.seckey.challenge', {});
      const request = await createSecurityKey(challenge, deps.selfAddress(), name);
      if (typeof request === 'string') return request;
      await deps.call('identity.seckey.add', request);
      return 'ok';
    } catch (err) {
      return classify(err);
    }
  }

  async function removeKey(password: string, id: string): Promise<SecurityKeyChange> {
    const denied = await reauth(password);
    if (denied) return denied;
    try {
      await deps.call('identity.seckey.remove', { credential_id: id });
      return 'ok';
    } catch (err) {
      return classify(err);
    }
  }

  async function setRequired(password: string, isRequired: boolean): Promise<SecurityKeyChange> {
    const denied = await reauth(password);
    if (denied) return denied;
    try {
      await deps.call('identity.seckey.set_required', { required: isRequired });
      return 'ok';
    } catch (err) {
      return classify(err);
    }
  }

  return {
    getState, addKey, removeKey, setRequired,
  };
}
