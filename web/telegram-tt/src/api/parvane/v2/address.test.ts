import { describe, expect, it } from 'vitest';

import {
  destFor, destForInvite, destForUser, domainOf, federationReason, isForeign,
} from './address';

describe('федерация: адресат запроса (FED-1)', () => {
  it('свой домен и пустота — обычный запрос, чужой — адресат', () => {
    expect(domainOf('anya@A.example')).toBe('a.example');
    expect(domainOf('без адреса')).toBe('');
    expect(destFor('A.Example', 'a.example')).toBeUndefined();
    expect(destFor('', 'a.example')).toBeUndefined();
    expect(destFor('b.example', 'a.example')).toBe('b.example');
    expect(destForUser('boris@b.example', 'a.example')).toBe('b.example');
    expect(destForUser('anya@a.example', 'a.example')).toBeUndefined();
    expect(isForeign('boris@b.example', 'a.example')).toBe(true);
    expect(isForeign('anya@a.example', 'a.example')).toBe(false);
  });
});

describe('федерация: причины отказа (FR-013)', () => {
  it('коды федерации — ключи словаря, прочее — нет', () => {
    expect(federationReason({ code: 'ERROR_CODE_DOMAIN_UNREACHABLE' })).toBe('ParvaneFederationUnreachable');
    expect(federationReason(new Error('ERROR_CODE_SERVER_KEY_CHANGED'))).toBe('ParvaneFederationKeyChanged');
    expect(federationReason({ code: 'ERROR_CODE_DOMAIN_REFUSED' })).toBe('ParvaneFederationRefused');
    expect(federationReason({ code: 'ERROR_CODE_DOMAIN_BLOCKED' })).toBe('ParvaneFederationDomainBlocked');
    expect(federationReason({ code: 'ERROR_CODE_FEDERATION_UNAVAILABLE' })).toBe('ParvaneFederationDisabled');
    expect(federationReason({ code: 'ERROR_CODE_FORBIDDEN' })).toBeUndefined();
    expect(federationReason(undefined)).toBeUndefined();
  });
});

describe('destForInvite', () => {
  it('ссылка с хостом этой страницы — своя, даже если хост не домен сервера', () => {
    expect(destForInvite('127.0.0.1', 'local', '127.0.0.1')).toBeUndefined();
    expect(destForInvite('abc.onion', 'parvane.example', 'ABC.onion')).toBeUndefined();
  });
  it('ссылка другого сервера — его серверу', () => {
    expect(destForInvite('b.example', 'a.example', 'a.example')).toBe('b.example');
    expect(destForInvite('a.example', 'a.example', 'web.a.example')).toBeUndefined();
  });
});
