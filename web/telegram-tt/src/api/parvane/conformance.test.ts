import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { isContentAllowedForMember } from './groups';
import { packRefCacheKey, shouldReusePackRef } from './messages';
import { buildEmojiDocId, getEmojiPackNames, sanitizePackName } from './stickerPacks';
import { shouldApplyGroupInfo } from './store';

// Правила из conformance/ обязаны соблюдать ВСЕ клиенты. Тест сторожит две
// вещи: логику веба и то, что константы десктопа не разъехались с документом.
// Смысл — поймать расхождение реализаций до пользователя: именно так фикс
// курсора (коммит 23ce150d) уехал в веб и не доехал до десктопа.
const REPO_ROOT = path.resolve(process.cwd(), '../..');
const rules = JSON.parse(
  readFileSync(path.join(REPO_ROOT, 'conformance/sync-rules.json'), 'utf8'),
) as {
  rules: {
    id: string;
    maxRepairAttempts?: number;
    maxCacheAgeMs?: number;
    cases?: Record<string, unknown>[];
    tileTopic?: string;
    tileSize?: number;
    defaultZoom?: number;
    maxZoom?: number;
    forbiddenHosts?: string[];
    noticeField?: string;
    changes?: string[];
    contentKinds?: Record<string, string[]>;
    clients?: { web: string; desktop: string | string[]; android: string };
    vectors?: string;
    engineSuite?: string;
  }[];
};

function rule(id: string) {
  const found = rules.rules.find((item) => item.id === id);
  if (!found) throw new Error(`нет правила ${id}`);
  return found;
}

function readRepo(rel: string) {
  return readFileSync(path.join(REPO_ROOT, rel), 'utf8');
}

function readDesktopSource() {
  return readFileSync(
    path.join(REPO_ROOT, 'desktop/tdesktop/Telegram/SourceFiles/parvane/parvane_client.cpp'),
    'utf8',
  );
}

describe('SYNC-1: дисковый курсор двигается только по применённому', () => {
  // Зеркало решения из web sync.ts persistCursor и desktop NotePendingAndMayAdvance
  const mayPersist = (c: { applied: boolean; e2eReady: boolean; deliberateReject?: boolean }) =>
    c.e2eReady && (c.applied || Boolean(c.deliberateReject));

  it.each(rule('SYNC-1').cases as {
    name: string; applied: boolean; e2eReady: boolean; deliberateReject?: boolean; persistCursor: boolean;
  }[])('$name', (testCase) => {
    expect(mayPersist(testCase)).toBe(testCase.persistCursor);
  });

  it('web не пишет курсор без E2E и при пропущенных сообщениях', () => {
    const source = readFileSync(path.join(process.cwd(), 'src/api/parvane/sync.ts'), 'utf8');
    expect(source).toMatch(/!deps\.getE2e\(\)\) return;/);
    expect(source).toMatch(/if \(!mayAdvanceDiskCursor\(\)\) return;/);
  });

  it('desktop двигает дисковый курсор только после успешной вставки', () => {
    const source = readDesktopSource();
    // SaveCursors обязан стоять внутри ветки mayAdvance, после injectOnMain
    const inject = source.indexOf('injectOnMain(session, msgs);');
    const save = source.indexOf('SaveCursors(cursorId, cursorUpd)');
    expect(inject).toBeGreaterThan(0);
    expect(save).toBeGreaterThan(inject);
    expect(source).toMatch(/if \(mayAdvance\) \{/);
  });
});

describe('SYNC-2: непрочитанное не держит курсор вечно', () => {
  it('web REPAIR_ATTEMPTS совпадает с документом', () => {
    const expected = rule('SYNC-2').maxRepairAttempts;
    const source = readFileSync(path.join(process.cwd(), 'src/api/parvane/sync.ts'), 'utf8');
    const match = source.match(/const REPAIR_ATTEMPTS = (\d+);/);
    expect(match?.[1]).toBe(String(expected));
  });

  it('desktop kRepairAttempts совпадает с документом', () => {
    const expected = rule('SYNC-2').maxRepairAttempts;
    const match = readDesktopSource().match(/constexpr int kRepairAttempts = (\d+);/);
    expect(match?.[1]).toBe(String(expected));
  });
});

describe('PROFILE-1: профиль перечитывается по TTL', () => {
  it('desktop kProfileTtlMs не больше документированного', () => {
    const max = rule('PROFILE-1').maxCacheAgeMs!;
    const match = readDesktopSource().match(/constexpr qint64 kProfileTtlMs = ([^;]+);/);
    expect(match).toBeTruthy();
    const value = eval(match![1]) as number;
    expect(value).toBeLessThanOrEqual(max);
  });

  it('desktop не резолвит профиль «один раз за сессию»', () => {
    const source = readDesktopSource();
    expect(source).not.toMatch(/g_resolveRequested/);
    expect(source).toMatch(/g_resolvedAt/);
  });
});

describe('READ-1: прочитанное журналируется локально и подтверждается', () => {
  const isRead = (c: { serverRead: boolean; localRead: boolean }) => c.serverRead || c.localRead;

  it.each(rule('READ-1').cases as {
    name: string; serverRead: boolean; localRead: boolean; isRead: boolean;
  }[])('$name', (testCase) => {
    expect(isRead(testCase)).toBe(testCase.isRead);
  });

  it('web считает прочитанным объединение серверного флага и локального журнала', () => {
    const source = readFileSync(path.join(process.cwd(), 'src/api/parvane/provider.ts'), 'utf8');
    // Единый предикат живёт в sync.ts (isUnreadIncoming): серверный флаг ИЛИ
    // локальный журнал; provider и пересчёты зовут его, а не дублируют
    expect(source).toMatch(/syncController\.isUnreadIncoming\(chat\.id, message\)/);
    const sync = readFileSync(path.join(process.cwd(), 'src/api/parvane/sync.ts'), 'utf8');
    expect(sync).toMatch(
      /function isUnreadIncoming[\s\S]*?!wireFlagsByUuid\.get\(uuid\)\?\.read && !reportedReadUuids\.has\(uuid\)/,
    );
  });

  it('desktop журналирует и повторяет прочитанное (READ-1)', () => {
    const source = readDesktopSource();
    expect(source).toMatch(/parvane-read\.txt/);
    expect(source).toMatch(/void RetryUnconfirmedReads\(/);
    expect(source).toMatch(/NoteReported\(ids\);/);
  });

  it('web повторяет неподтверждённые msg.chat.read', () => {
    const source = readFileSync(path.join(process.cwd(), 'src/api/parvane/sync.ts'), 'utf8');
    expect(source).toMatch(/retryUnconfirmedReads/);
  });
});

describe('FAIL-1: ожидание без ответа запрещено', () => {
  it('web не кэширует отвергнутый импорт бандла', () => {
    const source = readFileSync(path.join(process.cwd(), 'src/util/moduleLoader.ts'), 'utf8');
    expect(source).toMatch(/delete LOAD_PROMISES\[bundleName\]/);
  });

  it('web обрабатывает отказ загрузки бандла', () => {
    const source = readFileSync(path.join(process.cwd(), 'src/hooks/useModuleLoader.ts'), 'utf8');
    expect(source).toMatch(/recoverFromStaleChunk/);
  });

  it('desktop при отказе авторизации выходит на экран входа, а не молчит', () => {
    const source = readDesktopSource();
    // Протухший JWT раньше тихо оставлял старый журнал на экране (8 сен 2026)
    expect(source).toMatch(/void OnAuthRejected\(const QString &reason\) \{/);
    expect(source).toMatch(/forcedLogOut\(\)/);
  });

  it('desktop: любой MTProto-запрос отдаётся в fail локальной ошибкой', () => {
    const source = readFileSync(
      path.join(REPO_ROOT, 'desktop/tdesktop/Telegram/SourceFiles/mtproto/mtp_instance.cpp'),
      'utf8',
    );
    expect(source).toMatch(/PARVANE_NO_MTPROTO/);
  });

  it('desktop не ждёт messages.getDialogFilters, которого не будет', () => {
    const source = readFileSync(
      path.join(REPO_ROOT, 'desktop/tdesktop/Telegram/SourceFiles/data/data_chat_filters.cpp'),
      'utf8',
    );
    expect(source).not.toMatch(/_loadRequestId = api\.request\(MTPmessages_GetDialogFilters/);
  });
});

describe('E2E-1: автор из провода, SKDM из identity конверта, unknown не показывается', () => {
  const webSync = readFileSync(
    path.join(REPO_ROOT, 'web/telegram-tt/src/api/parvane/sync.ts'),
    'utf8',
  );

  it('правило E2E-1 задокументировано в sync-rules.json', () => {
    const r = rule('E2E-1') as unknown as {
      groupAuthor: string; megolmPlaintext: string;
      skdmBoundToEnvelopeIdentity: boolean;
      unknownVerdict: { show: boolean; ack: boolean };
    };
    expect(r.groupAuthor).toBe('wireFrom');
    expect(r.megolmPlaintext).toBe('bareContent');
    expect(r.skdmBoundToEnvelopeIdentity).toBe(true);
    expect(r.unknownVerdict.show).toBe(false);
    expect(r.unknownVerdict.ack).toBe(false);
  });

  it('web разворачивает Megolm-plaintext, не доверяя inner.from как автору', () => {
    // Группа берёт автора из wire stored.from, а content — через unwrapMegolmContent
    expect(webSync).toMatch(/function unwrapMegolmContent/);
    expect(webSync).toMatch(/const inner = unwrapMegolmContent\(JSON\.parse\(plain\)\)/);
    // В групповой ветке verify.claimedFrom — это stored.from (wire), не inner.from
    expect(webSync).toMatch(/claimedFrom: stored\.from, senderIdentity: content\.sender_identity/);
  });

  it('web: SKDM принимается только при совпадении sender_identity с конвертом', () => {
    expect(webSync).toMatch(/inner\.content\.sender_identity === content\.sender_identity/);
  });

  it('web: вердикт unknown не показывает и не ack-ает сообщение (retry)', () => {
    const idx = webSync.indexOf('verdict === \'unknown\'');
    expect(idx).toBeGreaterThan(0);
    const block = webSync.slice(idx, idx + 800);
    expect(block).toMatch(/sawUndecryptable = true/);
    expect(block).toMatch(/undecryptableUuids\.add/);
    // между началом ветки и её return не должно быть sendAck
    const untilReturn = block.slice(0, block.indexOf('return'));
    expect(untilReturn).not.toMatch(/sendAck/);
  });

  it('desktop: groupSeal шлёт голый content, приём не доверяет inner.from в группе', () => {
    const e2e = readFileSync(
      path.join(REPO_ROOT, 'desktop/parvane-core/src/e2e.cpp'),
      'utf8',
    );
    // groupSeal больше не оборачивает в {from, content}
    const seal = e2e.slice(e2e.indexOf('std::string groupSeal'));
    expect(seal.slice(0, 400)).not.toMatch(/\{\{"from", g_self\}, \{"content"/);
    const client = readDesktopSource();
    expect(client).toMatch(/const auto author = direct \? claimedFrom : wireFrom;/);
    // unknown в prepareIncoming держит сообщение (continue), не показывает
    const uk = client.indexOf('Verdict::Unknown');
    expect(uk).toBeGreaterThan(0);
    expect(client.slice(uk, uk + 700)).toMatch(/continue;/);
  });

  it('android: автор группы = wire from, SKDM привязан к identity конверта', () => {
    const jni = readFileSync(
      path.join(REPO_ROOT, 'android/jni/parvane_jni.cpp'),
      'utf8',
    );
    // В группе inner.from больше не назначается автором
    const grp = jni.slice(jni.indexOf('group_encrypted'));
    expect(grp.slice(0, 900)).not.toMatch(/author = inner\["from"\]/);
    // SKDM привязан к envelope senderIdentity
    expect(jni).toMatch(/skdmIdentity == senderIdentity/);
    // unknown откладывает (return без ack)
    expect(jni).toMatch(/не подтверждён — откладываем/);
  });
});

describe('LINK-1: линковка v2 — обязательство, challenge, SAS от пары ключей, без приватного аккаунта', () => {
  const r = rule('LINK-1') as unknown as {
    sasDigits: number; sasInfo: string; exportLinkVersion: number;
    exportContainsPrivateAccount: boolean; acceptsLegacyOffers: boolean;
    transferStatement: string;
    v2Grant: { boxField: string; boxCoords: string[]; materialKeys: string[]; secondDeviceCreatesRoot: boolean };
    vectors: { newPubB64: string; oldPubB64: string; commitmentOfNew: string; sas: string };
  };

  it('грант v2: материал движка отдельным блобом, второе устройство корень не создаёт', async () => {
    expect(r.v2Grant.secondDeviceCreatesRoot).toBe(false);
    // Материал движка (WASM; формат общий с C ABI) — ровно ключи из правила
    const { PvClient } = await import('../../lib/parvane-protocol/parvane_protocol');
    const first = new PvClient('alice@local', 'd1', 'local');
    first.createIdentity(1);
    first.ensureStateKey();
    const material = JSON.parse(new TextDecoder().decode(first.linkGrantMaterial())) as Record<string, unknown>;
    expect(Object.keys(material).sort()).toEqual(r.v2Grant.materialKeys);
    first.free();

    const coords = r.v2Grant.boxCoords.map((key) => `"${key}"`);
    const provider = readRepo('web/telegram-tt/src/api/parvane/provider.ts');
    expect(provider).toContain('await joinV2WithLinkGrant(boxPayload.v2)');
    expect(provider).toContain('v2Controller.linkGrantMaterial()');
    const controller = readRepo('web/telegram-tt/src/api/parvane/v2/controller.ts');
    expect(controller).toContain('client.joinWithGrant(material, OTK_COUNT)');
    expect(controller).toContain('deps.onNeedsLinking?.()');
    // desktop: выдача и приём; android (шов): приём
    const desktop = readRepo('desktop/tdesktop/Telegram/SourceFiles/parvane/parvane_client.cpp');
    expect(desktop).toContain(`boxPlain["${r.v2Grant.boxField}"] = {{${coords[0]}, v2File}`);
    expect(desktop).toContain(`box.contains("${r.v2Grant.boxField}")`);
    expect(desktop).toContain('s->joinWithGrant(std::move(*material))');
    const core = readRepo('desktop/parvane-core/src/v2_session.cpp');
    expect(core).toContain('c->joinWithGrant(linkMaterial_, cfg_.otkCount)');
    expect(core).toContain('{"type", "needsLinking"}');
    const android = readRepo('android/jni/parvane_jni.cpp');
    expect(android).toContain(`box.contains("${r.v2Grant.boxField}")`);
    expect(android).toContain('s->joinWithGrant(std::move(*material))');
  });

  it('правило LINK-1 задокументировано в sync-rules.json', () => {
    expect(r.sasDigits).toBe(12);
    expect(r.sasInfo).toBe('parvane-link-sas-v2');
    expect(r.exportLinkVersion).toBe(2);
    expect(r.exportContainsPrivateAccount).toBe(false);
    expect(r.acceptsLegacyOffers).toBe(false);
  });

  it('web считает commitment и SAS по кросс-клиентским векторам', async () => {
    const { linkCommitment, sasCodeV2 } = await import('./linking');
    expect(await linkCommitment(r.vectors.newPubB64)).toBe(r.vectors.commitmentOfNew);
    expect(await sasCodeV2(r.vectors.newPubB64, r.vectors.oldPubB64)).toBe(r.vectors.sas);
  });

  it('web: экспорт для линковки без приватного материала, transfer по строке из правила', () => {
    const webE2e = readFileSync(
      path.join(REPO_ROOT, 'web/telegram-tt/src/api/parvane/e2e.ts'),
      'utf8',
    );
    const idx = webE2e.indexOf('exportLinkStateJson(): string {');
    expect(idx).toBeGreaterThan(0);
    const body = webE2e.slice(idx, webE2e.indexOf('signLinkTransfer(', idx));
    expect(body).toMatch(/linkVersion: 2/);
    expect(body).not.toMatch(/pickle|account:/);
    // eslint-disable-next-line no-template-curly-in-string
    expect(webE2e).toContain('`link-transfer:${self}:${this.signingKey}:${newSigningKey}`');
    expect(r.transferStatement).toBe('link-transfer:<user>:<old_signing_key>:<new_signing_key>');
  });

  it('web: грант принимается только под ключ challenge, legacy-офферы не обслуживаются', () => {
    const provider = readFileSync(
      path.join(REPO_ROOT, 'web/telegram-tt/src/api/parvane/provider.ts'),
      'utf8',
    );
    expect(provider).toMatch(/grant\.eph_pub !== linkRuntime\.challenge/);
    const idx = provider.indexOf('async function describeLinkOffer');
    expect(idx).toBeGreaterThan(0);
    expect(provider.slice(idx, idx + 300)).toMatch(/if \(!offer\.commitment\) return undefined/);
  });

  it('desktop и android используют те же примитивы ядра', () => {
    const core = readFileSync(
      path.join(REPO_ROOT, 'desktop/parvane-core/src/linking.cpp'),
      'utf8',
    );
    expect(core).toContain('"parvane-link-sas-v2"');
    expect(core).toMatch(/v %= 1000000000000ULL/);
    const desktop = readFileSync(
      path.join(REPO_ROOT, 'desktop/tdesktop/Telegram/SourceFiles/parvane/parvane_client.cpp'),
      'utf8',
    );
    expect(desktop).toMatch(/exportLinkStateJson\(DecCacheSnapshot\(\)\)/);
    expect(desktop).toMatch(/grant\.value\("eph_pub", std::string\(\)\) != challenge/);
    const android = readFileSync(path.join(REPO_ROOT, 'android/jni/parvane_jni.cpp'), 'utf8');
    expect(android).toMatch(/sasCodeV2\(g_linkEph->publicB64\(\), challenge\)/);
    expect(android).toMatch(/grant\.value\("eph_pub", std::string\(\)\) != g_linkChallenge/);
  });
});

describe('KEY-1: смена ключа по виденным identity, signed_prekey только с подписью', () => {
  const r = rule('KEY-1') as unknown as {
    keyChangeSource: string; prekeySignatureRequiredInDeviceList: boolean;
    allDevicesRejectedVerdict: string;
  };
  const webE2e = readFileSync(
    path.join(REPO_ROOT, 'web/telegram-tt/src/api/parvane/e2e.ts'),
    'utf8',
  );
  const core = readFileSync(
    path.join(REPO_ROOT, 'desktop/parvane-core/src/e2e.cpp'),
    'utf8',
  );

  it('правило KEY-1 задокументировано в sync-rules.json', () => {
    expect(r.keyChangeSource).toBe('seenIdentities');
    expect(r.prekeySignatureRequiredInDeviceList).toBe(true);
    expect(r.allDevicesRejectedVerdict).toBe('unknown');
  });

  it('web и desktop: смена ключа — по множеству виденных, не по кэшу primary', () => {
    const webIdx = webE2e.indexOf('rememberContactIdentity(contact: string, identity: string): boolean {');
    expect(webIdx).toBeGreaterThan(0);
    const webBody = webE2e.slice(webIdx, webIdx + 700);
    expect(webBody).toMatch(/this\.seenIdentities\.get\(contact\)/);
    expect(webBody).toMatch(/const changed = Boolean\(seen\?\.size\)/);
    const coreIdx = core.indexOf(
      'bool rememberContactIdentity(const std::string &contact, const std::string &identity) {',
    );
    expect(coreIdx).toBeGreaterThan(0);
    expect(core.slice(coreIdx, coreIdx + 700)).toMatch(/auto &seen = g_seenIds\[contact\]/);
  });

  it('web и desktop: каталог засевает виденные только при первом знакомстве', () => {
    expect(webE2e).toMatch(/if \(!this\.seenIdentities\.get\(contact\)\?\.size\) \{/);
    expect(core).toMatch(/if \(g_seenIds\[contact\]\.empty\(\)\) \{/);
  });

  it('web и desktop: устройство без валидной подписи SPK пропускается, пустой каталог = unknown', () => {
    expect(webE2e).toMatch(/if \(!verifyPrekeySignature\(device\)\) \{\s*rejected\+\+;\s*return;/);
    expect(webE2e).toMatch(/if \(rejected && !Object\.keys\(next\)\.length\) return;/);
    expect(core).toMatch(/if \(!prekeySigOk\(d\)\) \{\s*\+\+rejected;\s*continue;/);
    expect(core).toMatch(/if \(rejected && next\.empty\(\)\) \{\s*return;/);
  });
});

describe('SEND-1: подпись отправки, ack без sender, правка только тем же E2E-видом', () => {
  const r = rule('SEND-1') as unknown as {
    sendStatement: string; ackCarriesSender: boolean; editKeepsKind: boolean;
  };
  const messages = readFileSync(
    path.join(REPO_ROOT, 'web/telegram-tt/src/api/parvane/messages.ts'),
    'utf8',
  );
  const webSync = readFileSync(
    path.join(REPO_ROOT, 'web/telegram-tt/src/api/parvane/sync.ts'),
    'utf8',
  );

  it('правило SEND-1 задокументировано в sync-rules.json', () => {
    expect(r.sendStatement).toBe('send:<message_id>:<ciphertext>');
    expect(r.ackCarriesSender).toBe(false);
    expect(r.editKeepsKind).toBe(true);
  });

  it('web подписывает каждую E2E-отправку строкой из правила', () => {
    // eslint-disable-next-line no-template-curly-in-string
    expect(messages).toContain('engine.signCallData(`send:${messageId}:${ciphertext}`)');
    const publishes = messages.match(/publishOrThrow\(TOPIC_MSG_SEND/g) || [];
    const signed = messages.match(/signature: signSend\(/g) || [];
    expect(publishes.length).toBeGreaterThan(0);
    expect(signed.length).toBe(publishes.length);
  });

  it('web: ack без sender', () => {
    const idx = webSync.indexOf('function sendAck(messageId: string)');
    expect(idx).toBeGreaterThan(0);
    expect(webSync.slice(idx, idx + 300)).not.toMatch(/sender:/);
    expect(webSync).not.toMatch(/sendAck\([^)]*,\s*[^)]+\)/);
  });

  it('desktop и android подписывают send той же строкой и шлют ack без sender', () => {
    const core = readFileSync(
      path.join(REPO_ROOT, 'desktop/parvane-core/include/parvane/messenger.h'),
      'utf8',
    );
    expect(core).toContain('return "send:" + messageId + ":" + ciphertext;');
    const client = readFileSync(
      path.join(REPO_ROOT, 'desktop/parvane-core/src/messenger_client.cpp'),
      'utf8',
    );
    expect(client).toMatch(/const json payload\{\{"message_id", messageId\}\};/);
    const desktop = readFileSync(
      path.join(REPO_ROOT, 'desktop/tdesktop/Telegram/SourceFiles/parvane/parvane_client.cpp'),
      'utf8',
    );
    const sends = desktop.match(/m->sendContent\(/g) || [];
    const signers = desktop.match(/E2eSigner\(\)\);/g) || [];
    expect(signers.length).toBe(sends.length);
    const android = readFileSync(path.join(REPO_ROOT, 'android/jni/parvane_jni.cpp'), 'utf8');
    const androidSends = android.match(/g_messenger->sendContent\(/g) || [];
    const androidSigners = android.match(/e2eSigner\(\)\);/g) || [];
    expect(androidSigners.length).toBe(androidSends.length);
  });

  it('messenger и gateway: подпись send обязательна, правка не понижает E2E', () => {
    // 4.7: messenger разбит на модули — подпись в auth.rs, правки в store.rs
    const messengerAuth = readFileSync(
      path.join(REPO_ROOT, 'backend/shards/messenger/src/auth.rs'),
      'utf8',
    );
    const messengerStore = readFileSync(
      path.join(REPO_ROOT, 'backend/shards/messenger/src/store.rs'),
      'utf8',
    );
    expect(messengerAuth).toMatch(/let statement = format!\("send:\{message_id\}:\{ciphertext\}"\);/);
    expect(messengerStore).toMatch(/content\.kind\(\) != stored_content\.kind\(\)/);
    expect(messengerStore).toMatch(/AND kind NOT IN \('encrypted', 'group_encrypted'\)/);
    const gateway = readFileSync(
      path.join(REPO_ROOT, 'backend/shards/gateway/src/acl.rs'),
      'utf8',
    );
    // 4.10: субъекты — константами из parvane-types, не литералами
    expect(gateway).toMatch(/subject == MSG_SEND \|\| subject == MSG_EDIT/);
    expect(gateway).not.toMatch(/"msg\.(chat|typing)\.|"presence\."/);
  });
});

describe('EPHEMERAL-1: typing только свой/по членству, presence по собеседникам', () => {
  it('правило задокументировано', () => {
    const r = rule('EPHEMERAL-1') as unknown as { presenceSubscribe: string };
    expect(r.presenceSubscribe).toContain('presence.* forbidden');
  });

  it('ни один клиент не подписывается на presence.*', () => {
    const files = [
      'web/telegram-tt/src/api/parvane/connectionController.ts',
      'desktop/tdesktop/Telegram/SourceFiles/parvane/parvane_client.cpp',
      'android/jni/parvane_jni.cpp',
    ];
    files.forEach((file) => {
      const source = readFileSync(path.join(REPO_ROOT, file), 'utf8');
      expect(source, file).not.toMatch(/subscribe\(['"]presence\.\*['"]/);
    });
    const web = readFileSync(path.join(REPO_ROOT, files[0]), 'utf8');
    expect(web).toMatch(/subscribe\(buildPresenceTopic\(peerId\)/);
    expect(web).not.toMatch(/subscribe\(`presence\./);
    // 4.7: ACL gateway живёт в acl.rs
    const gateway = readFileSync(path.join(REPO_ROOT, 'backend/shards/gateway/src/acl.rs'), 'utf8');
    expect(gateway).toMatch(/is_own_ephemeral_subject\(user, MSG_TYPING_PREFIX, subject\)/);
    expect(gateway).toMatch(/async fn group_typing_allowed/);
  });
});

describe('BLOB-1: чанковый AEAD медиа-блобов', () => {
  it('правило задокументировано с вектором', () => {
    const r = rule('BLOB-1') as unknown as { chunkSizeDefault: number; vector: { headHex: string } };
    expect(r.chunkSizeDefault).toBe(262144);
    expect(r.vector.headHex.startsWith('50564232')).toBe(true);
  });

  it('web и parvane-core реализуют один формат, окна без тега больше не расшифровываются', () => {
    const web = readFileSync(path.join(REPO_ROOT, 'web/telegram-tt/src/api/parvane/blobcrypt.ts'), 'utf8');
    expect(web).not.toMatch(/AES-CTR/);
    expect(web).toMatch(/const MAGIC = \[0x50, 0x56, 0x42, 0x32\]/);
    expect(web).toMatch(/export async function decryptBlobChunks/);
    const media = readFileSync(path.join(REPO_ROOT, 'web/telegram-tt/src/api/parvane/media.ts'), 'utf8');
    expect(media).not.toMatch(/decryptRange/);
    expect(media).toContain(
      'decryptBlobChunks(window, keys.keyB64, keys.nonceB64, header, blobFrom, totalBlobChunks)',
    );
    const core = readFileSync(path.join(REPO_ROOT, 'desktop/parvane-core/src/blobcrypt.cpp'), 'utf8');
    expect(core).toMatch(/constexpr char kMagic\[4\] = \{'P', 'V', 'B', '2'\}/);
    expect(core).toMatch(/std::optional<std::string> decryptChunks/);
    const coreTests = readFileSync(path.join(REPO_ROOT, 'desktop/parvane-core/tests/blobcrypt_tests.cpp'), 'utf8');
    const webTests = readFileSync(path.join(REPO_ROOT, 'web/telegram-tt/src/api/parvane/blobcrypt.test.ts'), 'utf8');
    const r = rule('BLOB-1') as unknown as {
      vector: { headHex: string; tailHex: string };
      legacyVector: { ciphertextB64: string };
    };
    expect(webTests).toContain(r.vector.headHex);
    expect(webTests).toContain(r.vector.tailHex);
    expect(webTests).toContain(r.legacyVector.ciphertextB64);
    expect(coreTests).toContain(r.legacyVector.ciphertextB64);
  });
});

describe('MAP-1: фрагменты карты — только через шард preview', () => {
  const map = rule('MAP-1');
  const hosts = map.forbiddenHosts ?? [];

  it('web берёт тайлы через preview.map.tile и не знает картографических хостов', () => {
    const wire = readFileSync(path.join(process.cwd(), 'src/api/parvane/wire.ts'), 'utf8');
    expect(wire).toContain(`TOPIC_PREVIEW_MAP_TILE = '${map.tileTopic}'`);
    const media = readRepo(map.clients!.web);
    expect(media).toMatch(/TOPIC_PREVIEW_MAP_TILE/);
    expect(media).toMatch(new RegExp(`MAP_TILE_SIZE = ${map.tileSize};`));
    for (const host of hosts) expect(media).not.toContain(host);
  });

  it('desktop берёт тайлы через topics::PreviewMapTile и не знает картографических хостов', () => {
    const topics = readRepo('desktop/parvane-core/include/parvane/topics.h');
    expect(topics).toContain(`PreviewMapTile = "${map.tileTopic}"`);
    const core = readRepo('desktop/parvane-core/src/map_tiles.cpp');
    expect(core).toMatch(/topics::PreviewMapTile/);
    for (const file of map.clients!.desktop as string[]) {
      const source = readRepo(file);
      for (const host of hosts) expect(source).not.toContain(host);
    }
  });

  it('android берёт тайлы через ядро (preview.map.tile) и не знает картографических хостов', () => {
    const client = readRepo('android/libtd/src/main/java/org/drinkless/tdlib/Client.kt');
    expect(client).toMatch(/ParvaneCore\.mapTile\(/);
    const jni = readRepo('android/jni/parvane_jni.cpp');
    expect(jni).toMatch(/nativeMapTile/);
    for (const file of [
      'android/libtd/src/main/java/org/drinkless/tdlib/Client.kt',
      'android/libtd/src/main/java/org/drinkless/tdlib/MapGeometry.kt',
      'android/jni/parvane_jni.cpp',
    ]) {
      const source = readRepo(file);
      for (const host of hosts) expect(source, file).not.toContain(host);
    }
    expect(String(map.clients!.android)).toContain('tgx_folders_preview_flow.sh');
  });

  it('зум статичной карты совпадает на web и desktop', () => {
    const location = readFileSync(
      path.join(process.cwd(), 'src/components/middle/message/Location.tsx'),
      'utf8',
    );
    expect(location).toMatch(new RegExp(`zoom: ${map.defaultZoom},`));
    const header = readRepo('desktop/parvane-core/include/parvane/map_tiles.h');
    expect(header).toMatch(new RegExp(`kDefaultZoom = ${map.defaultZoom};`));
    expect(header).toMatch(new RegExp(`kTileSize = ${map.tileSize};`));
  });

  it('зум обрезается до серверного предела во всех клиентах и на сервере (P-23)', () => {
    expect(readRepo('backend/shards/preview/src/main.rs')).toMatch(new RegExp(`TILE_MAX_ZOOM: u32 = ${map.maxZoom};`));
    expect(readRepo('web/telegram-tt/src/api/parvane/media.ts')).toMatch(new RegExp(`MAP_MAX_ZOOM = ${map.maxZoom};`));
    expect(readRepo('desktop/parvane-core/include/parvane/map_tiles.h'))
      .toContain(`kMaxZoom = ${map.maxZoom};`);
    expect(readRepo('android/libtd/src/main/java/org/drinkless/tdlib/MapGeometry.kt'))
      .toMatch(new RegExp(`MAX_ZOOM = ${map.maxZoom}\\b`));
  });
});

describe('PACK-1: архив пака — под набор получателей', () => {
  const pack = rule('PACK-1');

  it('веб переиспользует архив только для подмножества получателей', () => {
    for (const testCase of pack.cases ?? []) {
      const { cached, next, reuse } = testCase as { cached: string[]; next: string[]; reuse: boolean };
      expect(shouldReusePackRef(cached, next), String(testCase.name)).toBe(reuse);
    }
  });

  it('ключ кэша архива — отпечаток содержимого, а не число файлов и размер', async () => {
    const bytes = (values: number[]) => ({ data: new Uint8Array(values).buffer });
    // Тот же набор, пересобранный с ДРУГИМИ файлами той же суммарной длины,
    // не должен переиспользовать чужой архив
    const original = await packRefCacheKey('set1', [bytes([1, 2, 3]), bytes([4, 5, 6])]);
    const sameSizes = await packRefCacheKey('set1', [bytes([9, 9, 9]), bytes([8, 8, 8])]);
    expect(sameSizes).not.toBe(original);
    // Те же файлы — тот же ключ (иначе архив грузился бы каждый раз заново)
    expect(await packRefCacheKey('set1', [bytes([1, 2, 3]), bytes([4, 5, 6])])).toBe(original);
    // Разные наборы не делят архив
    expect(await packRefCacheKey('set2', [bytes([1, 2, 3]), bytes([4, 5, 6])])).not.toBe(original);
  });

  it('десктоп помнит ссылку вместе с набором получателей', () => {
    const source = readFileSync(
      path.join(REPO_ROOT, 'desktop/tdesktop/Telegram/SourceFiles/parvane/parvane_client.cpp'),
      'utf8',
    );
    // ссылка ищется по набору получателей, а не только по id набора
    expect(source).toMatch(/FindUploadedPackRef\(\s*\n?\s*quint64 setId,\s*\n?\s*const QSet<QString> &recipients\)/);
    expect(source).toMatch(/\(recipients - entry\.recipients\)\.isEmpty\(\)/);
    expect(source).toMatch(/RememberUploadedPackRef\(/);
    expect(source).not.toMatch(/g_packRefUploaded\.value\(\w+\);/);
    expect(String(pack.clients!.desktop)).toContain('verify_conformance_packs.sh');
  });
});

describe('EMOJI-1: docId кастом-эмодзи — от имени из ссылки', () => {
  const emoji = rule('EMOJI-1');

  // Эталон формулы — независимо от реализации веба
  function referenceDocId(value: string) {
    let hash = BigInt((emoji as { offsetBasis?: string }).offsetBasis || '0');
    for (const byte of new TextEncoder().encode(value)) {
      hash ^= BigInt(byte);
      hash = (hash * BigInt((emoji as { prime?: string }).prime || '0')) & 0xffffffffffffffffn;
    }
    return BigInt.asIntN(64, hash).toString();
  }

  it('начальное значение FNV совпадает с десктопом и android', () => {
    const basis = (emoji as { offsetBasis?: string }).offsetBasis;
    expect(readDesktopSource()).toContain(`std::uint64_t h = ${basis}ULL;`);
    const jni = readFileSync(path.join(REPO_ROOT, 'android/jni/parvane_jni.cpp'), 'utf8');
    expect(jni).toContain(`std::uint64_t h = ${basis}ULL;`);
  });

  it('веб считает docId по формуле правила', () => {
    for (const testCase of emoji.cases ?? []) {
      const { packName, file } = testCase as { packName: string; file: string };
      expect(buildEmojiDocId(packName, file), String(testCase.name))
        .toBe(referenceDocId(`pvemoji:${packName}|${file}`));
    }
  });

  it('сохранённый пак помнит сырое имя: docId не меняются после перезагрузки', () => {
    for (const testCase of emoji.cases ?? []) {
      const { packName } = testCase as { packName: string };
      const stored = { name: sanitizePackName(packName), rawName: packName };
      // «после перезагрузки» реестр сессии пуст — имена берутся из записи
      expect(getEmojiPackNames('pvpk-reload-check', stored)[0]).toBe(packName);
    }
  });

  it('веб кладёт в ссылку сырое имя эмодзи-пака', () => {
    const source = readFileSync(path.join(process.cwd(), 'src/api/parvane/messages.ts'), 'utf8');
    expect(source).toMatch(/pack\.rawName \|\| getEmojiPackRawName\(setId\) \|\| pack\.name/);
  });

  it('десктоп грузит полученный пак под сырым именем и после рестарта', () => {
    const source = readFileSync(
      path.join(REPO_ROOT, 'desktop/tdesktop/Telegram/SourceFiles/parvane/parvane_client.cpp'),
      'utf8',
    );
    // сырое имя пишется рядом с распакованным каталогом и читается при загрузке
    expect(source).toMatch(/WriteRawPackName\(dest, rawName\)/);
    expect(source).toMatch(/const auto rawName = ReadRawPackName\(dir, packName\)/);
    expect(String(emoji.clients!.desktop)).toContain('verify_conformance_packs.sh');
  });
});

describe('GROUP-1: сведения группы применяются по ревизии, изменения — без перезагрузки', () => {
  const group = rule('GROUP-1');

  it.each(group.cases as { name: string; local: number | null; incoming: number | null; apply: boolean }[])(
    '$name',
    (testCase) => {
      expect(shouldApplyGroupInfo(testCase.local ?? undefined, testCase.incoming ?? undefined)).toBe(testCase.apply);
    },
  );

  it('веб: нотис группы — поле `group` в кадре инбокса, применение через applyNotice', () => {
    expect(group.noticeField).toBe('group');
    const sync = readFileSync(path.join(process.cwd(), 'src/api/parvane/sync.ts'), 'utf8');
    expect(sync).toMatch(/\.group;/);
    expect(sync).toMatch(/deps\.groups\.applyNotice\(group\)/);
    const groups = readFileSync(path.join(process.cwd(), 'src/api/parvane/groups.ts'), 'utf8');
    for (const change of group.changes ?? []) {
      expect(groups, `change ${change}`).toContain(`case '${change}':`);
    }
    // неизвестный вид — догон, а не ошибка
    expect(groups).toMatch(/default: \{\n\s+deps\.log\(`неизвестное изменение группы/);
    const store = readFileSync(path.join(process.cwd(), 'src/api/parvane/store.ts'), 'utf8');
    expect(store).toMatch(
      /if \(!shouldApplyGroupInfo\(this\.groupVersionByAddress\.get\(info\.group_id\), info\.version\)\)/,
    );
  });

  it('десктоп: нотис читается из поля `group`, сведения применяются по ревизии, removed/deleted снимают чат', () => {
    const core = readRepo('desktop/parvane-core/src/messenger_client.cpp');
    expect(core).toMatch(/MessengerClient::onGroupNotice\(/);
    expect(core).toMatch(/p\.contains\("group"\)/);
    const client = readDesktopSource();
    expect(client).toMatch(/QHash<QString, quint64> g_groupVersions;/);
    expect(client).toMatch(/gi\.version < known\.value\(\)/);
    expect(client).toMatch(/onGroupNotice\(self,/);
    expect(client).toMatch(/n\.change == "removed" \|\| n\.change == "deleted"/);
    expect(client).toMatch(/ApplyGroupInfo\(session, \*n\.info/);
    const header = readRepo('desktop/parvane-core/include/parvane/group.h');
    expect(header).toMatch(/struct GroupNotice/);
    expect(header).toMatch(/std::uint64_t version = 0;/);
    expect(String(group.clients!.desktop)).toContain('verify_conformance_group.sh');
  });

  it('android: событие `group` ядра → повторный синк групп, применение по ревизии', () => {
    const jni = readRepo('android/jni/parvane_jni.cpp');
    expect(jni).toMatch(/onGroupNotice\(g_self,/);
    expect(jni).toMatch(/\{"type", "group"\}/);
    const client = readRepo('android/libtd/src/main/java/org/drinkless/tdlib/Client.kt');
    expect(client).toMatch(/"group" ->/);
    const store = readRepo('android/libtd/src/main/java/org/drinkless/tdlib/ParvaneStore.kt');
    expect(store).toMatch(/version < existed\.version/);
    expect(String(group.clients!.android)).toContain('ParvaneStoreGroupTest');
  });
});

describe('GROUP-2: права по типу содержимого соблюдаются на клиенте', () => {
  const rule2 = rule('GROUP-2');
  type Case = {
    name: string;
    perms: Record<string, boolean>;
    kind: string;
    hasLink: boolean;
    role: string | null;
    allowed: boolean;
  };

  it.each(rule2.cases as Case[])('$name', (testCase) => {
    if (testCase.role !== 'member') {
      // владелец/админ/неизвестная роль под фильтр не подпадают — решает вызывающий (sync.ts)
      expect(testCase.allowed).toBe(true);
      return;
    }
    const content = {
      kind: testCase.kind,
      text: 'x',
      ...(testCase.hasLink ? { webpage: { url: 'https://x' } } : {}),
    } as never;
    expect(isContentAllowedForMember(testCase.perms as never, content)).toBe(testCase.allowed);
  });

  it('таблица contentKinds совпадает с реализацией веба', () => {
    const groups = readFileSync(path.join(process.cwd(), 'src/api/parvane/groups.ts'), 'utf8');
    for (const kind of rule2.contentKinds!.send_media) {
      expect(groups, kind).toMatch(new RegExp(`MEDIA_KINDS[^;]*'${kind}'`));
    }
    for (const kind of rule2.contentKinds!.send_stickers_gifs) {
      expect(groups, kind).toMatch(new RegExp(`STICKER_KINDS[^;]*'${kind}'`));
    }
    const sync = readFileSync(path.join(process.cwd(), 'src/api/parvane/sync.ts'), 'utf8');
    expect(sync).toMatch(/role !== 'member'/);
    expect(sync).toMatch(/group-perm-hidden/);
  });

  it('десктоп: та же формула в parvane-core и фильтр при инъекции', () => {
    const header = readRepo('desktop/parvane-core/include/parvane/group.h');
    expect(header).toMatch(/inline bool isContentAllowedForMember\(/);
    expect(header).toMatch(/inline bool contentHasLink\(/);
    for (const kind of rule2.contentKinds!.send_media) {
      expect(header, kind).toContain(`kind == "${kind}"`);
    }
    const client = readDesktopSource();
    expect(client).toMatch(/скрыто правами группы/);
    expect(client).toMatch(/GroupRoleOf\(toStr, authorAddr\) == u"member"_q/);
    expect(client).toMatch(/parvane::isContentAllowedForMember\(/);
    expect(String(rule2.clients!.desktop)).toContain('verify_conformance_perms.sh');
  });

  it('android: та же формула в ParvaneStore и фильтр при приёме', () => {
    const store = readRepo('android/libtd/src/main/java/org/drinkless/tdlib/ParvaneStore.kt');
    expect(store).toMatch(/fun isContentAllowedForMember\(/);
    const client = readRepo('android/libtd/src/main/java/org/drinkless/tdlib/Client.kt');
    expect(client).toMatch(/isContentAllowedForMember\(/);
    expect(String(rule2.clients!.android)).toContain('ParvaneStorePermsTest');
  });
});

describe('PROTO-1: в клиенте нет собственного разбора протокола v2 (spec 007, T086)', () => {
  const V2_DIR = 'web/telegram-tt/src/api/parvane/v2';
  const v2Files = ['controller.ts', 'contentMap.ts', 'engine.ts', 'transport.ts', 'stateJournal.ts'];

  it('движок подключается только в v2/engine.ts', () => {
    const offenders = v2Files
      .filter((file) => file !== 'engine.ts')
      .filter((file) => /lib\/parvane-protocol/.test(readRepo(`${V2_DIR}/${file}`)));
    expect(offenders).toEqual([]);
  });

  it('кадры и тела не разбираются вручную: только через движок', () => {
    v2Files.forEach((file) => {
      const source = readRepo(`${V2_DIR}/${file}`);
      // Ручной разбор protobuf/кадров: varint, DataView, байтовые поля по тегам
      expect(source, file).not.toMatch(/new DataView|>>> 7|& 0x7f/);
      // JSON разбирается только из ответов движка (proto3-JSON pbjson) и своих настроек
      const parses = source.match(/JSON\.parse\(([^)]*)/g) || [];
      parses.forEach((call) => {
        // (журнал состояния: `session` — сессия движка, `host.decode` — движок)
        expect(call, `${file}: ${call}`)
          .toMatch(/JSON\.parse\((pv\.|client\.|session\.|host\.decode|String\(e$|localStorage\.)/);
      });
    });
  });
});

describe('SEAL-1 / GSEAL-1 / CONTENT-1 / L2-1: общие векторы движка прогоняет каждый клиент (spec 007)', () => {
  it.each(['SEAL-1', 'GSEAL-1', 'CONTENT-1', 'L2-1'])('%s', (id) => {
    const item = rule(id);
    const vectors = JSON.parse(readRepo(item.vectors!)) as { cases: unknown[] };
    expect(vectors.cases.length).toBeGreaterThan(2);
    // Правило закрыто, только когда набор движка назван в тесте КАЖДОГО клиента
    (['web', 'desktop', 'android'] as const).forEach((client) => {
      const file = String(item.clients![client]);
      expect(readRepo(file), `${id}: ${client} (${file})`).toContain(item.engineSuite!);
    });
  });

  // L2-1 (T079): кроме векторов — поведение клиента: typing/presence закрыты
  // в чате с активным режимом, смена режима — служебное сообщение чата
  it('L2-1: тест поведения есть в каждом клиенте, сетка в правиле — та же, что в векторах', () => {
    const item = rule('L2-1') as ReturnType<typeof rule> & {
      grid: number[]; behaviourTests: Record<'web' | 'desktop' | 'android', string>;
    };
    (['web', 'desktop', 'android'] as const).forEach((client) => {
      expect(readRepo(item.behaviourTests[client]), `L2-1: ${client}`).toContain('chat_mode');
    });
    const vectors = JSON.parse(readRepo(item.vectors!)) as { cases: { name: string; expect: { len?: number } }[] };
    const sizes = vectors.cases.map((c) => c.expect.len).filter((len): len is number => len !== undefined);
    expect(sizes.length).toBeGreaterThan(20);
    sizes.forEach((len) => {
      expect(item.grid.includes(len) || (len > 32768 && len % 32768 === 0), `размер ${len} на сетке`).toBe(true);
    });
    // desktop: решение «не слать typing / не публиковать присутствие» — в клиенте
    const desktop = readDesktopSource();
    expect(desktop).toContain('L2Active(address)');
    expect(desktop).toContain('g_l2PresenceAllowed');
  });

  it('android: наборы идут через C ABI движка, а не свой разбор', () => {
    const test = readRepo('android/libtd/src/test/java/org/drinkless/tdlib/ProtocolVectorsTest.kt');
    expect(test).toContain('ParvaneProtocol.runConformanceVectors');
    expect(readRepo('desktop/parvane-core/tests/protocol_vectors_tests.cpp')).toContain('pv_run_conformance_vectors');
  });
});
