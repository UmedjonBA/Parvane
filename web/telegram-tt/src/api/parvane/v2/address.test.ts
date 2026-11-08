import { describe, expect, it } from 'vitest';

import {
  destFor, destForInvite, destForUser, domainOf, federationReason, groupDomainFor, isForeign, knownGroupDomain,
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

// Шаг 2б e2e_web_federation: Борис (сервер B) вступает по ссылке в группу сервера A. Движок для незнакомой группы
// отвечает своим доменом (B); принятый за знание, он отправлял `group.state.sync` и `group.join` серверу B —
// тот отвечал NOT_FOUND, а домен из ссылки не запоминался вовсе
describe('сервер группы по ссылке другого сервера', () => {
  it('свой домен от движка без журнала — «не знаю», группа идёт на сервер из ссылки', () => {
    const known = knownGroupDomain('b.example', false, 'b.example');
    expect(known).toBeUndefined();
    expect(groupDomainFor(known, 'a.example', 'b.example')).toBe('a.example');
  });
  it('журнал прочитан или ключ ждёт с чужим доменом — домен движка главный', () => {
    expect(knownGroupDomain('a.example', true, 'b.example')).toBe('a.example');
    expect(knownGroupDomain('b.example', true, 'b.example')).toBe('b.example');
    expect(knownGroupDomain('a.example', false, 'b.example')).toBe('a.example');
    expect(groupDomainFor('a.example', 'evil.example', 'b.example')).toBe('a.example');
  });
  it('ничего не известно — свой сервер', () => {
    expect(groupDomainFor(knownGroupDomain('', false, 'b.example'), undefined, 'b.example')).toBe('b.example');
  });
});
