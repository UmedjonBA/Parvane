import { describe, expect, it } from 'vitest';

import {
  buildBundleMark, canonicalRecoveryKey, deriveBundleKey, openKeyBundle, pickRecoveryKey, readGrantBundleKey,
  sealKeyBundle, withBundleKey, withFreshLog,
} from './keyBundle';

const KEY = '0123-4567-89AB-CDEF-GHJK-MNPQ-RSTV-WXYZ-0123-4567';
const ADDRESS = 'alice@local';
const encoder = new TextEncoder();
const decoder = new TextDecoder();

describe('копия ключей аккаунта под ключом восстановления (spec 015)', () => {
  it('ключ восстановления приводится к одной записи, как в движке', () => {
    const canonical = canonicalRecoveryKey(KEY);
    expect(canonical).toHaveLength(40);
    // Регистр, пробелы и дефисы не важны; O → 0, I и L → 1
    expect(canonicalRecoveryKey(` ${KEY.toLowerCase().replace(/-/g, ' ')} `)).toBe(canonical);
    expect(canonicalRecoveryKey(KEY.replace('0123', 'O1L3'))).toBe(canonical!.replace('0123', '0113'));
    expect(canonicalRecoveryKey(KEY.replace('0123', 'OIL3'))).toBe(canonical!.replace('0123', '0113'));
    expect(canonicalRecoveryKey('привет')).toBeUndefined();
    expect(canonicalRecoveryKey(KEY.slice(0, -1))).toBeUndefined();
    expect(canonicalRecoveryKey(KEY.replace('0123', 'UUUU'))).toBeUndefined();
  });

  // Прод, 9 окт 2026: ключ, вставленный вместе с куском текста диалога, движок отклонял
  it('ключ находится во вставленном тексте', () => {
    expect(pickRecoveryKey(KEY)).toBe(KEY);
    expect(pickRecoveryKey(`  ${KEY.toLowerCase()}  `)).toBe(KEY);
    expect(pickRecoveryKey(KEY.replace(/-/g, ' — '))).toBe(KEY);
    expect(pickRecoveryKey(KEY.replace(/-/g, ''))).toBe(KEY);
    expect(pickRecoveryKey(`Сохраните ключ восстановления: ${KEY}\nОн восстановит ключи аккаунта.`)).toBe(KEY);
    expect(pickRecoveryKey(`Save your recovery key: ${KEY}\nIt restores your account keys.`)).toBe(KEY);
    expect(pickRecoveryKey(`🔑 Ключ восстановления аккаунта @daria в Parvane:\n\n${KEY}\n\nНе удаляйте.`)).toBe(KEY);
    // Не ключ — отдаём как есть, движок отклонит
    expect(pickRecoveryKey(' привет ')).toBe('привет');
    expect(pickRecoveryKey('0123-4567')).toBe('0123-4567');
  });

  it('ключ копии зависит от ключа восстановления и адреса, но не от оформления', async () => {
    const key = await deriveBundleKey(KEY, ADDRESS);
    expect(key).toHaveLength(32);
    expect(await deriveBundleKey(KEY.toLowerCase().replace(/-/g, ''), ADDRESS)).toEqual(key);
    expect(await deriveBundleKey(KEY, 'bob@local')).not.toEqual(key);
    expect(await deriveBundleKey(KEY.replace('4567', '4568'), ADDRESS)).not.toEqual(key);
    expect(await deriveBundleKey('не ключ', ADDRESS)).toBeUndefined();
  });

  it('копия открывается только своим ключом и для своего адреса', async () => {
    const key = (await deriveBundleKey(KEY, ADDRESS))!;
    const payload = {
      grant: 'Z3JhbnQ=',
      planner: '{"domain":"local","id":"c1","keys":[]}',
      history: {
        fileId: 'f1', fileKey: 'k', fileNonce: 'n', at: 1700000000000, mark: 'abc',
      },
    };
    const sealed = await sealKeyBundle(key, ADDRESS, payload);
    expect(decoder.decode(sealed.subarray(0, 4))).toBe('PVKB');
    // Содержимое не лежит открытым текстом
    expect(decoder.decode(sealed)).not.toContain('Z3JhbnQ');
    expect(await openKeyBundle(key, ADDRESS, sealed)).toEqual(payload);

    const otherKey = (await deriveBundleKey(KEY.replace('4567', '4568'), ADDRESS))!;
    expect(await openKeyBundle(otherKey, ADDRESS, sealed)).toBeUndefined();
    expect(await openKeyBundle(key, 'bob@local', sealed)).toBeUndefined();
    const tampered = sealed.slice();
    tampered[tampered.length - 1] ^= 1;
    expect(await openKeyBundle(key, ADDRESS, tampered)).toBeUndefined();
    expect(await openKeyBundle(key, ADDRESS, sealed.subarray(0, 10))).toBeUndefined();
  });

  it('копия без материала привязки не принимается, лишние и битые поля отбрасываются', async () => {
    const key = (await deriveBundleKey(KEY, ADDRESS))!;
    const noGrant = await sealKeyBundle(key, ADDRESS, { grant: '' });
    expect(await openKeyBundle(key, ADDRESS, noGrant)).toBeUndefined();
    const broken = await sealKeyBundle(key, ADDRESS, {
      grant: 'Zw==', history: { fileId: 'f1' },
    } as unknown as Parameters<typeof sealKeyBundle>[2]);
    expect(await openKeyBundle(key, ADDRESS, broken))
      .toEqual({ grant: 'Zw==', planner: undefined, history: undefined });
  });

  it('журнал в материале привязки заменяется свежим, остальное не трогается', () => {
    const grant = encoder.encode(JSON.stringify({ ssk: 'aa', log: '00', dk: 'bb', gen: 2, rb: 'cc' }));
    const patched = JSON.parse(decoder.decode(withFreshLog(grant, new Uint8Array([0x0a, 0xff, 0x01]))));
    expect(patched).toEqual({ ssk: 'aa', log: '0aff01', dk: 'bb', gen: 2, rb: 'cc' });
  });

  it('ключ копии едет в материале привязки', () => {
    const grant = encoder.encode(JSON.stringify({ ssk: 'aa', log: '00' }));
    expect(readGrantBundleKey(grant)).toBeUndefined();
    const keyed = withBundleKey(grant, 'a2V5');
    expect(readGrantBundleKey(keyed)).toBe('a2V5');
    expect(JSON.parse(decoder.decode(keyed)).ssk).toBe('aa');
    expect(readGrantBundleKey(encoder.encode('не json'))).toBeUndefined();
  });

  it('отпечаток копии меняется вместе с содержимым', async () => {
    const mark = await buildBundleMark({ grant: 'a' });
    expect(mark).toMatch(/^[0-9a-f]{64}$/);
    expect(await buildBundleMark({ grant: 'a' })).toBe(mark);
    expect(await buildBundleMark({ grant: 'b' })).not.toBe(mark);
  });
});
