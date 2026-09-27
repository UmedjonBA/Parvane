import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

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
  }[];
};

function rule(id: string) {
  const found = rules.rules.find((item) => item.id === id);
  if (!found) throw new Error(`нет правила ${id}`);
  return found;
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
    const idx = webSync.indexOf("verdict === 'unknown'");
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
    vectors: { newPubB64: string; oldPubB64: string; commitmentOfNew: string; sas: string };
  };

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
    const coreIdx = core.indexOf('bool rememberContactIdentity(const std::string &contact, const std::string &identity) {');
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
    const messenger = readFileSync(
      path.join(REPO_ROOT, 'backend/shards/messenger/src/main.rs'),
      'utf8',
    );
    expect(messenger).toMatch(/let statement = format!\("send:\{message_id\}:\{ciphertext\}"\);/);
    expect(messenger).toMatch(/content\.kind\(\) != stored_content\.kind\(\)/);
    expect(messenger).toMatch(/AND kind NOT IN \('encrypted', 'group_encrypted'\)/);
    const gateway = readFileSync(
      path.join(REPO_ROOT, 'backend/shards/gateway/src/main.rs'),
      'utf8',
    );
    expect(gateway).toMatch(/subject == "msg\.chat\.send" \|\| subject == "msg\.chat\.edit"/);
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
    expect(web).toMatch(/subscribe\(`presence\.\$\{peerId\}`/);
    const gateway = readFileSync(path.join(REPO_ROOT, 'backend/shards/gateway/src/main.rs'), 'utf8');
    expect(gateway).toMatch(/is_own_ephemeral_subject\(user, "msg\.typing\.", subject\)/);
    expect(gateway).toMatch(/async fn group_typing_allowed/);
  });
});
