import { describe, expect, it } from 'vitest';

import { bytesToBase64 } from './v2/base64';
import {
  buildSecondFactorRequest, createSecurityKey, formatSecurityKeyStep, parseSecurityKeyList, parseSecurityKeyStep,
  signSecurityKeyStep,
} from './securityKeys';

const CHALLENGE = new Uint8Array([1, 2, 3, 4]);
const KEY_ID = new Uint8Array([9, 9, 9]);

function bufferOf(bytes: number[]) {
  return new Uint8Array(bytes).buffer;
}

describe('ключ безопасности (SECKEY-1)', () => {
  it('шаг входа читается из proto3-JSON и из ответа моста прежней формы', () => {
    const engine = {
      seckeyRequired: true,
      seckeyChallenge: bytesToBase64(CHALLENGE),
      seckeyIds: [bytesToBase64(KEY_ID)],
      seckeyRpId: 'parvane.example',
      seckeyRecovery: true,
      seckeyRejected: true,
    };
    const step = parseSecurityKeyStep(engine)!;
    expect(Array.from(step.challenge)).toEqual([1, 2, 3, 4]);
    expect(step.ids.map((id) => Array.from(id))).toEqual([[9, 9, 9]]);
    expect(step).toMatchObject({
      rpId: 'parvane.example', hasRecovery: true, isRejected: true, isRecoveryWrong: false,
    });
    const bridged = formatSecurityKeyStep(engine);
    expect(bridged).toMatchObject({ ok: false, seckey_required: true, seckey_rp_id: 'parvane.example' });
    expect(parseSecurityKeyStep(bridged)!.rpId).toBe('parvane.example');
    expect(parseSecurityKeyStep({ token: 'jwt' })).toBeUndefined();
  });

  it('второй фактор в запросе: ответ ключа либо ключ восстановления', () => {
    expect(buildSecondFactorRequest(undefined)).toEqual({});
    expect(buildSecondFactorRequest({ recoveryKey: 'AAAA-BBBB' })).toEqual({ recovery_key: 'AAAA-BBBB' });
    const seckey = {
      credential_id: 'aQ==', client_data_json: 'e30=', authenticator_data: 'AA==', signature: 'MA==',
    };
    expect(buildSecondFactorRequest({ seckey })).toEqual({ seckey });
  });

  it('список ключей', () => {
    const list = parseSecurityKeyList({
      keys: [{
        credentialId: 'AQ==', name: 'USB', createdMs: '5', lastUsedMs: '0',
      }],
      required: true,
      recoveryReady: true,
    });
    expect(list).toEqual({
      keys: [{
        id: 'AQ==', name: 'USB', createdMs: 5, lastUsedMs: 0,
      }],
      isRequired: true,
      isRecoveryReady: true,
    });
    expect(parseSecurityKeyList({})).toEqual({ keys: [], isRequired: false, isRecoveryReady: false });
  });

  it('подпись вызова и регистрация ключа идут в браузер с параметрами сервера', async () => {
    let getOptions: CredentialRequestOptions | undefined;
    let createOptions: CredentialCreationOptions | undefined;
    const credentials = {
      get: (options: CredentialRequestOptions) => {
        getOptions = options;
        return Promise.resolve({
          rawId: bufferOf([9, 9, 9]),
          response: {
            clientDataJSON: bufferOf([1]), authenticatorData: bufferOf([2]), signature: bufferOf([3]),
          },
        } as unknown as Credential);
      },
      create: (options: CredentialCreationOptions) => {
        createOptions = options;
        return Promise.resolve({
          rawId: bufferOf([7]),
          response: { clientDataJSON: bufferOf([4]), getAuthenticatorData: () => bufferOf([5]) },
        } as unknown as Credential);
      },
    } as Pick<CredentialsContainer, 'create' | 'get'>;
    const step = {
      challenge: CHALLENGE,
      ids: [KEY_ID],
      rpId: 'parvane.example',
      isRejected: false,
      isRecoveryWrong: false,
      hasRecovery: false,
    };
    const signed = await signSecurityKeyStep(step, credentials);
    expect(signed).toEqual({
      seckey: {
        credential_id: bytesToBase64(KEY_ID),
        client_data_json: bytesToBase64(new Uint8Array([1])),
        authenticator_data: bytesToBase64(new Uint8Array([2])),
        signature: bytesToBase64(new Uint8Array([3])),
      },
    });
    expect(getOptions!.publicKey!.rpId).toBe('parvane.example');
    expect(getOptions!.publicKey!.allowCredentials).toHaveLength(1);

    const body = await createSecurityKey({
      challenge: bytesToBase64(CHALLENGE),
      rpId: 'parvane.example',
      userHandle: 'AQID',
      excludeIds: [bytesToBase64(KEY_ID)],
    }, 'ana@local', 'USB', credentials);
    expect(body).toEqual({
      name: 'USB',
      client_data_json: bytesToBase64(new Uint8Array([4])),
      authenticator_data: bytesToBase64(new Uint8Array([5])),
    });
    const publicKey = createOptions!.publicKey!;
    expect(publicKey.rp.id).toBe('parvane.example');
    expect(publicKey.pubKeyCredParams.map((p) => p.alg)).toEqual([-7, -8]);
    expect(publicKey.excludeCredentials).toHaveLength(1);
  });

  it('отказ браузера — отмена, а не ошибка', async () => {
    const credentials = {
      get: () => Promise.reject(new DOMException('no', 'NotAllowedError')),
      create: () => Promise.reject(new DOMException('no', 'SecurityError')),
    } as Pick<CredentialsContainer, 'create' | 'get'>;
    const step = {
      challenge: CHALLENGE, ids: [], rpId: '', isRejected: false, isRecoveryWrong: false, hasRecovery: false,
    };
    expect(await signSecurityKeyStep(step, credentials)).toBe('cancelled');
    expect(await createSecurityKey({}, 'ana@local', 'USB', credentials)).toBe('unsupported');
  });
});
