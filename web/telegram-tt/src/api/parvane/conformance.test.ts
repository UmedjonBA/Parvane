import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { isContentAllowedForMember } from './groups';
import { packRefCacheKey, shouldReusePackRef } from './messages';
import { buildEmojiDocId, getEmojiPackNames, sanitizePackName } from './stickerPacks';
import { ParvaneStore, shouldApplyGroupInfo } from './store';

// Правила из conformance/ обязаны соблюдать ВСЕ клиенты. Тест сторожит две
// вещи: логику веба и то, что константы десктопа не разъехались с документом.
// Смысл — поймать расхождение реализаций до пользователя: именно так фикс
// курсора (коммит 23ce150d) уехал в веб и не доехал до десктопа.
// T110 (7 окт 2026): сервер и web без протокола v1. Пункты правил о v1-пути
// (курсор синка v1, повтор msg.chat.read, подпись v1-отправки, v1-топики
// typing/presence, нотис v1 группы, легаси-копии, понижение до v1, перевод
// групп v1, v1-блоб настроек, виртуальное соединение) для web закрыты удалением
// кода — тест сторожит, что v1-код в web не вернулся; для desktop и android
// они действуют до их T110.
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

  it('web: курсора синка v1 нет (T110) — история из кэша и журнала, инбокс v2 отдаёт только новое', () => {
    const source = readFileSync(path.join(process.cwd(), 'src/api/parvane/sync.ts'), 'utf8');
    expect(source).not.toMatch(/saveSyncCursor|loadSyncCursor|msg\.sync\.request/);
    expect(source).toMatch(/if \(await restoreFromCache\(\)\) \{/);
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
  it('web: курсора нет (T110) — строки приходят расшифрованными, шифртекст v1 пропускается', () => {
    const source = readFileSync(path.join(process.cwd(), 'src/api/parvane/sync.ts'), 'utf8');
    expect(source).not.toMatch(/REPAIR_ATTEMPTS|mayAdvanceDiskCursor|undecryptableUuids/);
    // Строки приходят расшифрованными (движок v2 / кэш); шифртекст v1 пропускается
    expect(source).toMatch(/в формате v1 — пропущено/);
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

  it('web: квитанция прочтения — E2E-содержимое v2, локальный журнал прочитанного сохраняется (T110)', () => {
    const sync = readFileSync(path.join(process.cwd(), 'src/api/parvane/sync.ts'), 'utf8');
    expect(sync).not.toMatch(/retryUnconfirmedReads|msg\.chat\.read/);
    expect(sync).toMatch(
      /markReportedRead: \(uuid: string\) => \{\s+reportedReadUuids\.add\(uuid\);\s+persistReadUuids\(\);/,
    );
    const messages = readFileSync(path.join(process.cwd(), 'src/api/parvane/messages.ts'), 'utf8');
    expect(messages).toContain('void deps.v2?.tryRead(readAddress, newlyRead)');
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

  it('web: Olm/Megolm-пути нет (T110) — автора и ключи проверяет движок v2, строка приходит расшифрованной', () => {
    expect(webSync).not.toMatch(/groupDecrypt|decryptFrom|unwrapMegolmContent|skdm|verifySenderIdentity/);
    // Шифртекст v1 из записи LegacyV1 не показывается и не подтверждается
    expect(webSync).toMatch(/kind === 'encrypted' \|\| stored\.content\.kind === 'group_encrypted'\) \{/);
    expect(existsSync(path.join(REPO_ROOT, 'web/telegram-tt/src/api/parvane/e2e.ts'))).toBe(false);
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
    v2History: {
      exportField: string; rowKeys: string[]; limit: number; skips: string[];
      incomingRead: boolean; groupRowsWaitForGroup: boolean;
    };
    vectors: { newPubB64: string; oldPubB64: string; commitmentOfNew: string; sas: string };
  };

  it('п. 8: история v2-эпохи едет в экспорте линковки и применяется во всех клиентах', async () => {
    const { collectV2History, parseV2History, V2_HISTORY_LIMIT } = await import('./v2/linkHistory');
    expect(r.v2History.exportField).toBe('v2History');
    expect(V2_HISTORY_LIMIT).toBe(r.v2History.limit);
    expect(r.v2History.incomingRead).toBe(true);
    expect(r.v2History.groupRowsWaitForGroup).toBe(true);
    // web: строка экспорта несёт обязательные ключи правила и читается обратно
    const row = {
      id: 'u1', from: 'a@local', to: 'b@local', ts: 5, content: { kind: 'text', text: 'x' }, origin: 'v2' as const,
    };
    const [exported] = collectV2History([row]);
    r.v2History.rowKeys.forEach((key) => expect(exported).toHaveProperty(key));
    const state = JSON.stringify({ [r.v2History.exportField]: [exported] });
    expect(parseV2History(state).map((m) => m.id)).toEqual(['u1']);
    const provider = readRepo('web/telegram-tt/src/api/parvane/provider.ts');
    expect(provider).toMatch(/linkVersion: 2,\s+v2History: collectV2History\(/);
    expect(provider).toContain('v2History = parseV2History(await media.blob.text())');
    expect(provider).toContain('isV2GroupAddress(stored.to) && !store.isGroupAddress(stored.to)');
    expect(provider).toContain('stored.from === owner ? stored : { ...stored, read: true }');
    // desktop: выдача и приём
    const desktop = readRepo('desktop/tdesktop/Telegram/SourceFiles/parvane/parvane_client.cpp');
    expect(desktop).toContain(`kV2HistoryLimit = std::size_t(${r.v2History.limit})`);
    expect(desktop).toContain(`state["${r.v2History.exportField}"] = std::move(rows)`);
    expect(desktop).toContain('exported = WithV2History(exported)');
    expect(desktop).toContain('ImportV2History(stateJson)');
    expect(desktop).toContain('if (group && !known) {');
    expect(desktop).toContain('sm.read = true; // история, а не новые входящие');
    // android (шов): приём
    const android = readRepo('android/jni/parvane_jni.cpp');
    expect(android).toContain(`kV2HistoryLimit = ${r.v2History.limit}`);
    expect(android).toContain(`st["${r.v2History.exportField}"]`);
    expect(android).toContain('importV2HistoryLocked(stateJson)');
    expect(android).toContain('if (in.group && !g_groupMembers.count(to))');
    expect(android).toContain('flushLinkedGroupRowsLocked(address)');
    r.v2History.skips.filter((kind) => kind.includes('encrypted')).forEach((kind) => {
      expect(desktop).toContain(`kind == "${kind}"`);
      expect(android).toContain(`kind == "${kind}"`);
    });
  });

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

  it('п. 9: группы v2 новому своему устройству пересылает движок по событию журнала устройств', () => {
    const rule9 = (r as unknown as {
      ownDeviceGroups: { engineMethod: string; shareFields: string[]; megolmExportedOnlyFromOwnAccount: boolean };
    }).ownDeviceGroups;
    expect(rule9.megolmExportedOnlyFromOwnAccount).toBe(true);
    const controller = readRepo('web/telegram-tt/src/api/parvane/v2/controller.ts');
    expect(controller).toContain('await shareGroupsWithOwnDevices(added);');
    expect(controller).toContain(`client!.${rule9.engineMethod}(JSON.stringify(devices))`);
    const core = readRepo('desktop/parvane-core/src/v2_session.cpp');
    expect(core).toContain(`client_->${rule9.engineMethod}(added)`);
    const engine = readRepo('backend/protocol/src/client.rs');
    expect(engine).toContain('pub fn share_groups_with_own_devices(&mut self, devices: &[String])');
    expect(engine).toContain('if !own || gk.megolm_owner.is_empty() {');
    expect(engine).toContain('if !(admin || own) || ctx.epoch != state.epoch {');
    const proto = readRepo('proto/parvane/msg/v2/content.proto');
    rule9.shareFields.forEach((field) => expect(proto).toMatch(new RegExp(`(bytes|string) ${field} = \\d+`)));
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

  it('web: экспорт для линковки — история v2-эпохи и грант движка (T110: без материала v1)', () => {
    const provider = readRepo('web/telegram-tt/src/api/parvane/provider.ts');
    expect(provider).toMatch(/linkVersion: 2,\s+v2History: collectV2History\(/);
    expect(provider).not.toMatch(/signLinkTransfer|importLinkedHistory|exportLinkStateJson|pickle/);
    const linking = readRepo('web/telegram-tt/src/api/parvane/linking.ts');
    expect(linking).not.toContain('transfer?:');
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
  const core = readFileSync(
    path.join(REPO_ROOT, 'desktop/parvane-core/src/e2e.cpp'),
    'utf8',
  );

  it('web: ключей устройств v1 нет (T110) — смена ключа собеседника = смена корня журнала (RECOVER-1)', () => {
    const provider = readRepo('web/telegram-tt/src/api/parvane/provider.ts');
    expect(provider).toContain('onPeerRootChanged: (user) => syncController.announceKeyChange(user),');
    const sync = readRepo('web/telegram-tt/src/api/parvane/sync.ts');
    expect(sync).toMatch(/function announceKeyChange\(address: string\)/);
  });

  it('правило KEY-1 задокументировано в sync-rules.json', () => {
    expect(r.keyChangeSource).toBe('seenIdentities');
    expect(r.prekeySignatureRequiredInDeviceList).toBe(true);
    expect(r.allDevicesRejectedVerdict).toBe('unknown');
  });

  it('desktop: смена ключа — по множеству виденных, не по кэшу primary', () => {
    const coreIdx = core.indexOf(
      'bool rememberContactIdentity(const std::string &contact, const std::string &identity) {',
    );
    expect(coreIdx).toBeGreaterThan(0);
    expect(core.slice(coreIdx, coreIdx + 700)).toMatch(/auto &seen = g_seenIds\[contact\]/);
  });

  it('desktop: каталог засевает виденные только при первом знакомстве', () => {
    expect(core).toMatch(/if \(g_seenIds\[contact\]\.empty\(\)\) \{/);
  });

  it('desktop: устройство без валидной подписи SPK пропускается, пустой каталог = unknown', () => {
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

  it('web: отправок v1 нет (T110) — каждая отправка идёт конвертом движка v2 (OP-SIG)', () => {
    expect(messages).not.toMatch(/msg\.chat\.send|publishOrThrow|signSend\(|deliverLegacy/);
    const sends = messages.match(/requireV2\(\)\.trySend\(/g) || [];
    expect(sends.length).toBeGreaterThan(0);
    expect(messages).toContain('if (!isSent) throw new E2eSendError(V2_PEER_REQUIRED);');
  });

  it('web: ack v1 нет — приём подтверждает движок (курсор инбокса v2)', () => {
    expect(webSync).not.toMatch(/sendAck|msg\.chat\.ack/);
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

  it('сервер: v1-пути отправки нет (T110) — проверка подписи v1 и ACL v1 удалены вместе с модулями', () => {
    expect(existsSync(path.join(REPO_ROOT, 'backend/shards/messenger/src/auth.rs'))).toBe(false);
    expect(existsSync(path.join(REPO_ROOT, 'backend/shards/gateway/src/acl.rs'))).toBe(false);
    // Запись инбокса v2 подписана устройством отправителя (OP-SIG) — проверяет движок
    expect(readRepo('backend/protocol/src/client.rs')).toContain('fn verify_session_proof');
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
    // web (T110): v1-топиков нет — присутствие собеседника слушает движок по
    // конкретному адресу, своё публикуется эфемерным каналом v2
    const web = readFileSync(path.join(REPO_ROOT, files[0]), 'utf8');
    expect(web).not.toMatch(/presence\.|msg\.typing\./);
    expect(web).toContain('if (address) deps.v2?.watchPresence?.(address);');
    expect(web).toContain('deps.v2?.publishPresence?.();');
    // Сервер: ACL v1-топиков удалён вместе с gateway/acl.rs
    expect(existsSync(path.join(REPO_ROOT, 'backend/shards/gateway/src/acl.rs'))).toBe(false);
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

  it('веб: нотиса v1 нет (T110) — сведения группы приходят из журнала движка и применяются по ревизии', () => {
    expect(group.noticeField).toBe('group');
    const sync = readFileSync(path.join(process.cwd(), 'src/api/parvane/sync.ts'), 'utf8');
    expect(sync).not.toMatch(/applyNotice|WireGroupNotice/);
    const provider = readFileSync(path.join(process.cwd(), 'src/api/parvane/provider.ts'), 'utf8');
    expect(provider).toContain('onGroupUpdated: (info, isNew) => groupController.applyV2Group(info, isNew),');
    const groups = readFileSync(path.join(process.cwd(), 'src/api/parvane/groups.ts'), 'utf8');
    expect(groups).toContain('if (register(info, true)) pushGroupUpdates(info, isNew);');
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

describe('CALL-1: ICE-кандидат звонка — один формат во всех клиентах', () => {
  const r = rule('CALL-1') as unknown as {
    canonicalFields: string[];
    legacyAliases: { web: string[]; desktop: string[] };
    vectors: {
      decode: { name: string; raw: string; candidate: string; mid: string; index: number }[];
      reject: string[];
    };
  };

  it('web пишет канонические поля и прежние имена, читает все виды из правила', async () => {
    const { decodeIceCandidate, encodeIceCandidate } = await import('./iceCandidate');
    const encoded = JSON.parse(encodeIceCandidate({ candidate: 'candidate:x', sdpMid: '0', sdpMLineIndex: 0 }));
    [...r.canonicalFields, ...r.legacyAliases.web, ...r.legacyAliases.desktop].forEach((field) => {
      expect(encoded, field).toHaveProperty(field);
    });
    r.vectors.decode.forEach((vector) => {
      expect(decodeIceCandidate(vector.raw), vector.name).toMatchObject({
        candidate: vector.candidate, sdpMid: vector.mid, sdpMLineIndex: vector.index,
      });
    });
    r.vectors.reject.forEach((raw) => expect(decodeIceCandidate(raw), raw).toBeUndefined());
  });

  it('web: оба движка звонков ходят через общий кодек', () => {
    ['callengine.ts', 'groupcall.ts'].forEach((file) => {
      const source = readRepo(`web/telegram-tt/src/api/parvane/${file}`);
      expect(source, file).toContain('decodeIceCandidate(signal.candidate)');
      expect(source, file).toContain('encodeIceCandidate(e.candidate.toJSON())');
      expect(source, file).not.toContain('JSON.parse(signal.candidate)');
    });
  });

  it('desktop: общий кодек ядра и звук в ответе на вызов', () => {
    const core = readRepo('desktop/parvane-core/include/parvane/call.h');
    [...r.canonicalFields, ...r.legacyAliases.web, ...r.legacyAliases.desktop].forEach((field) => {
      expect(core, field).toContain(`"${field}"`);
    });
    const backend = readRepo('desktop/tdesktop/Telegram/SourceFiles/parvane/parvane_webrtc_backend.cpp');
    expect(backend).toContain('parvane::parseIceCandidate(candidate)');
    expect(backend).toContain('parvane::iceCandidateJson(');
    // Трек — через AddTrack: иначе отвечающая сторона давала a=recvonly
    expect(backend).toContain('_pc->AddTrack(_track, { "stream0" })');
    expect(backend).not.toContain('_pc->AddTransceiver(_track');
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

describe('LEGACY-1: v1-устройства аккаунта на v2', () => {
  const r = rule('LEGACY-1') as unknown as {
    deliverMethod: string;
    listEntry: string;
    sendSignature: string;
    editSignature: string;
    cases: {
      name: string; kind: string; ciphertext: string; senderIdentity: string; ownCopy: boolean; skip: boolean;
    }[];
  };
  // Зеркало решения web sync.ts (unsealStored) и ядра e2e::isForeignLegacyCopy
  const isForeign = (c: { kind: string; ciphertext: string; senderIdentity: string; ownCopy: boolean }) => (
    c.kind === 'encrypted' && !c.ownCopy && !c.ciphertext && Boolean(c.senderIdentity)
  );

  it.each(r.cases)('$name', (testCase) => {
    expect(isForeign(testCase)).toBe(testCase.skip);
  });

  it('web: легаси-копий нет (T110) — доставить v1-устройствам нечем; запись LegacyV1 пропускается', () => {
    const messages = readRepo('web/telegram-tt/src/api/parvane/messages.ts');
    expect(messages).not.toMatch(/sealLegacy|deliverLegacy|legacyDevices/);
    const provider = readRepo('web/telegram-tt/src/api/parvane/provider.ts');
    expect(provider).not.toContain('listOwnV1Devices');
    // Запись LegacyV1 (кадр v1) целиком пропускается: читать её нечем
    const controller = readRepo('web/telegram-tt/src/api/parvane/v2/controller.ts');
    expect(controller).toMatch(/if \(ev\.type === 'legacyV1'\) \{\s+\/\/[^\n]*\n\s+return;/);
  });

  it('движок: метод доставки и запись списка из правила; журнал не меняется до подтверждения', () => {
    const client = readRepo('backend/protocol/src/client.rs');
    expect(client).toContain(`"${r.deliverMethod}"`);
    expect(client).toContain(`DevChange::LegacyDevices(${r.listEntry} { devices })`);
    expect(client).toContain('self.own_log.clone().apply(&op)?;');
  });

  it('desktop и android: общее ядро — список, копии по подписанным спискам, пропуск чужой копии', () => {
    const legacy = readRepo('desktop/parvane-core/src/v2_legacy.cpp');
    expect(legacy).toContain('e2e::sealLegacyCopies(to, content.dump(), t, token, peer, own)');
    expect(legacy).toContain(`e2e::sign("${r.sendSignature.replace('<id>:', '')}" + id + ":")`);
    expect(legacy).toContain(`e2e::sign("${r.editSignature.replace('<id>:', '')}" + id + ":")`);
    const e2e = readRepo('desktop/parvane-core/src/e2e.cpp');
    expect(e2e).toContain('want->second != stripB64Padding(info.identity)');
    expect(e2e).toContain('{"ciphertext", ""},');
    const desktop = readDesktopSource();
    expect(desktop).toContain('parvane::v2::sendLegacyCopies(*s, *t, token, to, content, id, replyTo)');
    expect(desktop).toContain('parvane::v2::publishLegacySet(*s, *t, token)');
    expect(desktop).toContain('parvane::e2e::isForeignLegacyCopy(sm.content)');
    const android = readRepo('android/jni/parvane_jni.cpp');
    expect(android).toContain('parvane::v2::sendLegacyCopies(*s, *g_transport, g_token, to, content, id, replyTo)');
    expect(android).toContain('s->syncLegacySet(catalog)');
    expect(android).toContain('parvane::e2e::isForeignLegacyCopy(');
  });
});

describe('TYPING-1: «печатает» в чате v2 — только эфемерным каналом v2', () => {
  const r = rule('TYPING-1') as unknown as {
    methods: { direct: string; group: string; subscribe: string };
    v1Topic: string;
    maxAgeMs: number;
  };

  it('движок: методы и срок жизни сигнала из правила', () => {
    const client = readRepo('backend/protocol/src/client.rs');
    Object.values(r.methods).forEach((method) => expect(client, method).toContain(`"${method}"`));
    expect(client).toContain(`const EPH_MAX_AGE_MS: i64 = ${r.maxAgeMs.toLocaleString('en-US').replace(/,/g, '_')};`);
  });

  it('web: «печатает» — только эфемерным каналом v2 (T110: v1-кадра нет)', () => {
    const messages = readRepo('web/telegram-tt/src/api/parvane/messages.ts');
    expect(messages).toContain('void deps.v2.trySendTyping(toAddress).catch(() => undefined);');
    expect(messages).not.toMatch(new RegExp(r.v1Topic.replace('.', '\\.')));
    const controller = readRepo('web/telegram-tt/src/api/parvane/v2/controller.ts');
    expect(controller).toContain('if (ev.eventKind === \'ephemeral\') applyEphemeral(ev.body);');
    expect(controller).toContain('if (!l2Gate.ephemeralAllowed(to)) return true;');
  });

  it('desktop и android: «печатает» берёт на себя ядро, v1 — только для чата не на v2', () => {
    const session = readRepo('desktop/parvane-core/src/v2_session.cpp');
    expect(session).toContain('if (!group && !isV2Peer(chat)) return false;');
    expect(session).toContain('if (!ready_ || !client_) return true; // чат v2: по v1 не понижаем');
    [readDesktopSource(), readRepo('android/jni/parvane_jni.cpp')].forEach((source) => {
      expect(source).toMatch(/if \(s->sendTyping\(to(Std)?\)\) \{?\s*return;/);
      expect(source).toMatch(/\} else if \(parvane::v2::isGroupAddress\(to(Std)?\)\) \{\s*return;/);
    });
  });
});

describe('REVOKE-1: отзыв своего устройства на v2', () => {
  const r = rule('REVOKE-1') as unknown as {
    v1Topic: string;
    logEntryMethod: string;
    grantRootBackupField: string;
    sskResults: string[];
  };

  it('движок: запись журнала первой, копия корня в гранте, смена SSK по секрету корня', () => {
    const client = readRepo('backend/protocol/src/client.rs');
    expect(client).toContain('o.requests.insert(0, req);');
    expect(client).toContain(`OutRequest::id("${r.logEntryMethod}"`);
    expect(client).toContain('pub fn rotate_ssk_with_secret(');
    const host = readRepo('backend/protocol/src/host.rs');
    expect(host).toContain(`v["${r.grantRootBackupField}"] = json!(hex::encode(backup));`);
    // T110: v1-отзыва на сервере нет — identity.device.revoke только методом v2
    const devices = readRepo('backend/shards/identity/src/devices.rs');
    expect(devices).not.toContain('log_has_device(&username, &req.device_id)');
  });

  it('web: список с устройствами журнала v2; v1-отзыв, затем журнал и ротации; SSK — ключом восстановления', () => {
    const provider = readRepo('web/telegram-tt/src/api/parvane/provider.ts');
    expect(provider).toContain('(v2Devices?.v2 || []).forEach((deviceId) => {');
    expect(provider).toMatch(/TOPIC_DEVICE_REVOKE[\s\S]{0,700}await v2Controller\.revokeDevice\(deviceId\)/);
    const controller = readRepo('web/telegram-tt/src/api/parvane/v2/controller.ts');
    // Первый запрос — запись журнала: отказ поднимает состояние заново
    expect(controller).toContain('const [entry, ...rotations] = outcome.requests;');
    expect(controller).toMatch(/await call\(entry\.chan[\s\S]{0,400}idConn\?\.close\(\);\s*throw e;/);
    expect(controller).toContain('client.importRootBackup(unb64(rootBackupB64), recoveryKey.trim()).fill(0);');
    expect(controller).toContain('client?.forgetRoot();');
    expect(controller).toContain('pv.grantWithRootBackup(material, unb64(rootBackupB64))');
    expect(controller).toContain('pv.grantRootBackup(material)');
    r.sskResults.forEach((result) => expect(controller, result).toContain(`'${result}'`));
    // Смена ключа состояния: отзывавшее устройство переносит состояние, прочие ждут
    expect(controller).toContain('deps.onStateReady?.(stateHost, \'self\');');
    expect(controller).toContain('deps.onStateReady?.(stateHost, \'peer\');');
    const journal = readRepo('web/telegram-tt/src/api/parvane/v2/stateJournal.ts');
    expect(journal).toContain('const carried = rekey === \'self\' && session ? session.snapshot() : undefined;');
    expect(journal).toContain('} else if (rekey && !isReadable) {');
  });

  it('desktop и android: общее ядро — отзыв, смена SSK, перенос журнала состояния', () => {
    const session = readRepo('desktop/parvane-core/src/v2_session.cpp');
    expect(session).toContain('runRequestsLocked(json::array({requests[0]}));');
    expect(session).toContain('if (stateRekeyed_ && !readable) {');
    expect(session).toContain('grantWithRootBackup(material, backup)');
    expect(session).toContain('grantRootBackup(linkMaterial_)');
    r.sskResults.forEach((result) => expect(session, result).toContain(`"${result}"`));
    const desktop = readDesktopSource();
    expect(desktop).toMatch(/IdentityDeviceRevoke[\s\S]{0,1500}s->revokeDevice\(devStd\)/);
    expect(desktop).toContain('for (const auto &id : s->ownDevices()) {');
    const android = readRepo('android/jni/parvane_jni.cpp');
    expect(android).toMatch(/IdentityDeviceRevoke[\s\S]{0,900}s->revokeDevice\(dev\)/);
    expect(android).toContain('for (const auto &id : s->ownDevices()) {');
  });
});

describe('RECOVER-1: смена корня собеседника, восстановление по ключу, сброс личности', () => {
  const r = rule('RECOVER-1') as unknown as {
    logVerdicts: string[];
    genesisField: string;
    backupMethods: { set: string; get: string };
    resetMethod: string;
    reauthMethod: string;
    recoverResults: string[];
    resetResults: string[];
  };

  it('движок и сервер: отпечаток журнала, вердикты, методы копии корня и сброса', () => {
    const host = readRepo('backend/protocol/src/host.rs');
    r.logVerdicts.forEach((verdict) => expect(host, verdict).toContain(`=> "${verdict}"`));
    expect(host).toContain(`c.ingest_log_sync(user, r.entries, &r.${r.genesisField})`);
    const client = readRepo('backend/protocol/src/client.rs');
    expect(client).toContain(`OutRequest::id("${r.resetMethod}"`);
    // Тот же корень, а журнал другой — откат/форк: не принимается
    expect(client).toMatch(/TrustVerdict::Changed => \{[\s\S]{0,200}LogVerdict::RootChanged/);
    expect(client).toMatch(/LogVerdict::RootChanged\)[\s\S]{0,200}_ => Err\(ProtoError::BrokenChain\)/);
    const identity = readRepo('backend/shards/identity/src/v2.rs');
    [r.backupMethods.set, r.backupMethods.get].forEach((method) => expect(identity).toContain(`"${method}" =>`));
    expect(identity).toContain(`DeviceLogSyncAnonResponse { entries, more, ${r.genesisField} }`);
    const proto = readRepo('proto/parvane/identity/v2/identity.proto');
    [r.backupMethods.set, r.backupMethods.get, r.resetMethod, r.reauthMethod].forEach((method) => {
      expect(proto, method).toContain(`name: "${method}"`);
    });
  });

  it('web: KEY-1 v2, повтор со слепым жетоном, вход нового устройства', () => {
    const controller = readRepo('web/telegram-tt/src/api/parvane/v2/controller.ts');
    expect(controller).toContain(
      'if (verdict === \'replaced\') verdict = client.ingestLog(user, await syncFrom(\'0\'));',
    );
    expect(controller).toContain('if (verdict === \'rootChanged\') return acceptPeerRoot(user);');
    expect(controller).toMatch(/client\?\.acceptRootChange\(user\)[\s\S]{0,300}deps\.onPeerRootChanged\?\.\(user\);/);
    expect(controller).toContain('if (!isForbidden(e) || !client?.deliveryKeyRejected(to)) throw e;');
    expect(controller).toMatch(/client\.ingestLog\(self, (resp|ownLog)\) === 'replaced'/);
    [r.backupMethods.set, r.backupMethods.get, r.reauthMethod].forEach((method) => {
      expect(controller, method).toContain(`'${method}'`);
    });
    expect(controller).toContain('fresh.importRootBackupFor(backup, recoveryKey.trim());');
    expect(controller).toContain('fresh.recoverWithRoot(ownLog, OTK_COUNT)');
    expect(controller).toContain('fresh.resetIdentity(OTK_COUNT)');
    [...r.recoverResults, ...r.resetResults].forEach((result) => expect(controller, result).toContain(`'${result}'`));
    const provider = readRepo('web/telegram-tt/src/api/parvane/provider.ts');
    expect(provider).toContain('onPeerRootChanged: (user) => syncController.announceKeyChange(user),');
  });

  it('desktop и android: общее ядро и событие смены корня', () => {
    const session = readRepo('desktop/parvane-core/src/v2_session.cpp');
    expect(session).toContain('if (verdict == "rootChanged") return acceptPeerRootLocked(user);');
    expect(session).toContain('outbox_.push_back(json{{"type", "peerRootChanged"}, {"user", user}});');
    expect(session).toContain('if (!forbidden || !client_ || !client_->deliveryKeyRejected(peer)) throw;');
    expect(session).toContain('if (client_->ingestLog(cfg_.self, resp) == "replaced") {');
    [r.backupMethods.set, r.backupMethods.get, r.reauthMethod].forEach((method) => {
      expect(session, method).toContain(`"${method}"`);
    });
    [...r.recoverResults, ...r.resetResults].forEach((result) => expect(session, result).toContain(`"${result}"`));
    expect(readDesktopSource()).toMatch(/type == "peerRootChanged"[\s\S]{0,500}AnnounceKeyChange\(user\)/);
    expect(readRepo('android/jni/parvane_jni.cpp')).toContain('emit(json{{"type", "peer_root_changed"}');
  });
});

describe('CAP-1: блобы вложений v2-чата — по секрету capability', () => {
  const r = rule('CAP-1') as unknown as {
    uploadMethods: string[];
    downloadMethod: string;
    capabilityBytes: number;
    contentField: string;
    maxChunksPerRequest: number;
  };

  it('web: вложение всегда без гранта получателю (T110: v1-устройств нет); скачивание анонимным каналом', () => {
    const messages = readRepo('web/telegram-tt/src/api/parvane/messages.ts');
    expect(messages).toContain('function mediaUploadOptions(): { encrypt: true; withCapability: true } {');
    expect(messages).toContain('return { encrypt: true, withCapability: true };');
    expect(messages).not.toContain('getCloudRecipients');
    const media = readRepo('web/telegram-tt/src/api/parvane/media.ts');
    expect(media).not.toMatch(/file\.upload\.chunk|file\.download\.request|requestMany/);
    expect(media).toContain(`crypto.getRandomValues(new Uint8Array(${r.capabilityBytes}))`);
    expect(media).toContain(`const CAP_DOWNLOAD_BATCH = ${r.maxChunksPerRequest};`);
    expect(media).toContain(
      `if (content.${r.contentField}) capByFileId.set(content.file_id, content.${r.contentField});`,
    );
    const controller = readRepo('web/telegram-tt/src/api/parvane/v2/controller.ts');
    r.uploadMethods.forEach((method) => expect(controller, method).toContain(`'id', '${method}'`));
    expect(controller).toContain(`const method = '${r.downloadMethod}';`);
    expect(controller).toContain('const conn = await openAnon(plan.conn);');
    const map = readRepo('web/telegram-tt/src/api/parvane/v2/contentMap.ts');
    expect(map).toContain(`${r.contentField}: c.${r.contentField},`);
    expect(map).toContain(`${r.contentField}: m.${r.contentField} || undefined,`);
  });

  it('desktop и android: общее ядро, секрет в содержимом, анонимное скачивание', () => {
    const session = readRepo('desktop/parvane-core/src/v2_session.cpp');
    r.uploadMethods.forEach((method) => expect(session, method).toContain(`"${method}"`));
    expect(session).toContain(`conn.requestStream("${r.downloadMethod}"`);
    expect(session).toContain('conn.open(kChannelAnonymous, cfg_.clientVersion);');
    expect(session).toContain(`constexpr std::uint32_t kBatch = ${r.maxChunksPerRequest};`);
    const content = readRepo('desktop/parvane-core/src/v2_content.cpp');
    expect(content).toContain(`if (has(c, "${r.contentField}")) m["${r.contentField}"] = str(c, "${r.contentField}");`);
    const desktop = readDesktopSource();
    expect(desktop).toContain('s->legacyDevices(to).empty() && s->legacyDevices(self).empty()');
    expect(desktop).toContain('s->downloadBlobCap(fileId, parvane::v2::fromBase64(cap))');
    // Прямое v1-скачивание осталось одно — запасной путь внутри DownloadChatBlob
    expect(desktop.match(/cloud\.download\(/g) || []).toHaveLength(1);
    const android = readRepo('android/jni/parvane_jni.cpp');
    expect(android).toContain('s->legacyDevices(toStd).empty() && s->legacyDevices(g_self).empty()');
    expect(android).toContain('d.bytes = s->downloadBlobCap(fileId, parvane::v2::fromBase64(cap));');
    expect(android).toContain('rememberBlobCaps(inner["content"]);');
  });
});

describe('STATE-2: личное состояние — целиком в журнале, приватность — с сервера', () => {
  const r = rule('STATE-2') as unknown as {
    kinds: string[];
    mainPinList: string;
    notifyFields: string[];
    syncIntervalMs: number;
    v1BlobWhenJournaled: string[];
    privacyGetMethod: string;
    privacySetMethod: string;
  };

  it('web: виды журнала, v1-блоба нет, приватность читается с сервера', () => {
    const journal = readRepo('web/telegram-tt/src/api/parvane/v2/stateJournal.ts');
    const managed = journal.match(/const MANAGED_KINDS: LocalStateKind\[\] = \[([\s\S]*?)\];/)![1];
    r.kinds.forEach((kind) => expect(managed, kind).toContain(`'${kind}'`));
    expect(journal).toContain(`const PIN_LIST_MAIN = '${r.mainPinList}';`);
    expect(journal).toContain(`const SYNC_INTERVAL_MS = ${r.syncIntervalMs};`);
    const notifyType = journal.match(/type SNotify = \{([^}]*)\}/)![1];
    r.notifyFields.forEach((field) => expect(notifyType, field).toContain(`${field}?:`));
    const provider = readRepo('web/telegram-tt/src/api/parvane/provider.ts');
    expect(r.v1BlobWhenJournaled).toEqual(['group_add']);
    // T110: v1-блоба настроек web не публикует вовсе — всё в журнале, `group_add` в приватности v2
    expect(provider).not.toMatch(/pushNotifySettings|msg\.chat\.setnotify/);
    expect(provider).toMatch(/async parvaneGetStrangersPolicy\(\) \{\s+await refreshV2Privacy\(\);/);
    expect(provider).toMatch(/async parvaneGetGroupAddPolicy\(\) \{\s+await refreshV2Privacy\(\);/);
    const controller = readRepo('web/telegram-tt/src/api/parvane/v2/controller.ts');
    expect(controller).toContain(`'id', '${r.privacyGetMethod}'`);
    expect(controller).toContain(`'id', '${r.privacySetMethod}'`);
  });

  it('desktop: те же виды в журнале, приватность — событие сессии, своя правка сильнее', () => {
    const desktop = readDesktopSource();
    const kinds = desktop.match(/const std::vector<std::string> kV2StateKinds\{([\s\S]*?)\};/)![1];
    // Черновики tdesktop ведёт сам — в журнал десктоп их не пишет
    r.kinds.forEach((kind) => expect(kinds, kind).toContain(`"${kind}"`));
    expect(desktop).toContain(`{ "list", "${r.mainPinList}" }`);
    expect(desktop).toContain('if (!QFile::exists(NotifyJournaledPath())) {');
    expect(desktop).toContain(
      'if (const auto s = V2Ready(); s && s->legacyDevices(SelfAddress().toStdString()).empty()) {',
    );
    // Своя несохранённая правка сильнее серверного значения — по группам полей
    // (незнакомые/группы и звонки/присутствие, T137): серверным перезаписывается
    // только то, что не правилось на этом устройстве
    expect(desktop).toMatch(/if \(!privacy\.dirty\) \{\s+privacy\.strangers = strangers;/);
    expect(desktop).toMatch(/if \(!privacy\.dirtyCallsPresence\) \{\s+privacy\.callsNobody = callsNobody;/);
    const session = readRepo('desktop/parvane-core/src/v2_session.cpp');
    expect(session).toContain(`call(false, "${r.privacyGetMethod}"`);
    expect(session).toContain(`call(false, "${r.privacySetMethod}"`);
    expect(session).toMatch(/if \(privacySet_\) \{\s+pushPrivacyLocked\(\);\s+\} else \{\s+fetchPrivacyLocked\(\);/);
    expect(readRepo('android/jni/parvane_jni.cpp')).toContain('type == "privacy" ? "privacy" : "privacy_saved"');
  });
});

describe('ACCESS-1: блокировка отзывает ключ доступа; жетоны — по расписанию', () => {
  const r = rule('ACCESS-1') as unknown as {
    engineCall: string;
    keySetMethod: string;
    tokenBatch: number;
    tokenCheckIntervalMs: number;
  };

  it('движок: новый ключ всем, кроме заблокированного', () => {
    const engine = readRepo('backend/protocol/src/client.rs');
    expect(engine).toContain(`pub fn ${r.engineCall}(&mut self, peer: &str)`);
    expect(engine).toContain('let targets = self.dk.rotate(&[peer.to_string()]);');
    expect(engine).toContain(`OutRequest::id("${r.keySetMethod}"`);
  });

  it('web: блокировка зовёт отзыв; партия жетонов — по расписанию движка', () => {
    const provider = readRepo('web/telegram-tt/src/api/parvane/provider.ts');
    expect(provider).toMatch(
      /localState\.saveBlocked\(blocked\);[\s\S]{0,300}void v2Controller\.revokeContactAccess\(address\)/,
    );
    const controller = readRepo('web/telegram-tt/src/api/parvane/v2/controller.ts');
    expect(controller).toContain('client!.revokeContactAccess(peer)');
    expect(controller).toContain(`const TOKEN_BATCH = ${r.tokenBatch};`);
    expect(r.tokenCheckIntervalMs).toBe(60 * 60 * 1000);
    expect(controller).toContain('const TOKEN_CHECK_MS = 60 * 60 * 1000;');
    expect(controller).toContain('if (!client || !serverKey || !ready || !client.tokenRefillDue()) return;');
    expect(controller).toContain('setInterval(() => void serial(refillTokens), TOKEN_CHECK_MS)');
  });

  it('desktop и android: общее ядро', () => {
    const session = readRepo('desktop/parvane-core/src/v2_session.cpp');
    expect(session).toContain('client_->revokeContactAccess(peer)');
    expect(session).toContain(`constexpr std::size_t kTokenBatch = ${r.tokenBatch};`);
    expect(session).toContain('constexpr std::int64_t kTokenCheckMs = 60 * 60 * 1000;');
    expect(session).toContain('if (!client_ || serverKey_.empty() || !client_->tokenRefillDue()) return;');
    expect(readDesktopSource()).toMatch(/if \(blocked\) \{[\s\S]{0,500}s->revokeContactAccess\(to\)/);
    expect(readRepo('android/jni/parvane_jni.cpp')).toContain('s->revokeContactAccess(jstr(env, peer))');
  });
});

describe('GROUP-4: группа v1 переводится в v2, чат остаётся прежним', () => {
  const r = rule('GROUP-4') as unknown as { createField: string; infoField: string };

  it('схема и движок: прежний group_id — в записи генезиса и в сведениях группы', () => {
    expect(readRepo('proto/parvane/group/v2/group.proto')).toContain(`string ${r.createField} = 6`);
    expect(readRepo('backend/protocol/src/client.rs')).toContain(`${r.createField}: ${r.createField}.into()`);
    expect(readRepo('backend/protocol/src/host.rs')).toContain(`"${r.infoField}": s.${r.createField}`);
    expect(readRepo('backend/protocol/wasm/src/lib.rs')).toContain(`"${r.infoField}": s.${r.createField}`);
  });

  it('web: id чата — от прежнего адреса; перевод групп не запускается (T110)', () => {
    const store = new ParvaneStore();
    store.self = 'alice@local';
    const members = [{ address: 'alice@local', role: 'owner' }, { address: 'bob@local', role: 'member' }];
    const oldGid = '0190a0b0-0000-7000-8000-000000000001';
    store.registerGroup({
      group_id: oldGid, name: 'G', kind: 'group', created_by: 'alice@local', members, version: 4,
    });
    const chatId = store.getIdForAddress(oldGid, 'group');
    const v2 = 'v2g:00112233445566778899aabbccddeeff';
    expect(store.registerGroup({
      group_id: v2, name: 'G', kind: 'group', created_by: 'alice@local', members, version: 1, migrated_from: oldGid,
    })).toBe(true);
    expect(store.getIdForAddress(v2, 'group')).toBe(chatId);
    expect(store.getIdForAddress(oldGid, 'group')).toBe(chatId);
    expect(store.getAddressForId(chatId)).toBe(v2);
    expect(store.isGroupAddress(oldGid)).toBe(true);
    expect(store.getGroupAddresses()).toEqual([v2]);
    expect(store.isMigratedGroup(oldGid)).toBe(true);
    // сведения v1 той же группы (список шарда, более свежая ревизия) — мимо
    expect(store.registerGroup({
      group_id: oldGid, name: 'подмена', kind: 'group', created_by: 'alice@local', members, version: 9,
    })).toBe(false);
    expect(store.getGroupInfo(oldGid)?.name).toBe('G');
    // T110: переводить больше нечего (v1-шарда нет) — web перевод не запускает,
    // но переведённые группы по-прежнему открываются прежним чатом
    const groups = readRepo('web/telegram-tt/src/api/parvane/groups.ts');
    expect(groups).not.toMatch(/migrateToV2|migrateGroup|applyNotice/);
  });

  it('desktop: id чата — от прежнего адреса, права — в генезисе, v1-нотис чат не снимает', () => {
    const client = readRepo('desktop/tdesktop/Telegram/SourceFiles/parvane/parvane_client.cpp');
    expect(client).toContain('g_migratedFrom.constFind(rawAddress)');
    expect(client).toContain('const auto gid = CanonicalGroup(rawGid);');
    expect(client).toMatch(/void DropGroupLocally\([^)]*\) \{\s*if \(IsMigratedGroup\(gid\)\) \{\s*return;/);
    expect(client).toContain('NoteV2GroupOrigin(session, address, info);');
    const session = readRepo('desktop/parvane-core/src/v2_session.cpp');
    expect(session).toContain('v1.value("default_permissions", json())');
    expect(session).toContain('if (!isV2Peer(member) || !legacyDevices(member).empty()) return {};');
    expect(readRepo('desktop/parvane-core/src/v2_engine.cpp')).toContain('pv_client_group_create_from(');
  });
});

describe('GROUP-3: группа v2 — сведения только из журнала, атомарная правка, заявки записью админа', () => {
  const r = rule('GROUP-3') as unknown as {
    v1NoticeApplied: boolean;
    setInfoFields: string[];
    aboutMaxChars: number;
    requestDecideMethod: string;
    approveEntry: string;
  };

  it('движок и сервер: решение по заявке — запись AddMember в запросе, заявка локально не применяется', () => {
    const client = readRepo('backend/protocol/src/client.rs');
    expect(client).toContain(`OutRequest::id("${r.requestDecideMethod}"`);
    expect(client).toContain(`Change::${r.approveEntry}(gpb::${r.approveEntry} { member: Some(member.clone()) })`);
    expect(client).toMatch(/requires_approval\)\s*\{[\s\S]{0,260}return Ok\(OutRequest::id\("group\.join"/);
    const server = readRepo('backend/shards/messenger/src/v2_groups.rs');
    expect(server).toContain('notify_invite_admins(ctx, &s).await;');
  });

  it('web: правка сведений собирается внутри очереди, предел описания — на клиенте', () => {
    const controller = readRepo('web/telegram-tt/src/api/parvane/v2/controller.ts');
    const setInfo = controller.slice(controller.indexOf('async function setGroupInfo('));
    expect(setInfo.indexOf('return serial(async () => {'))
      .toBeLessThan(setInfo.indexOf('const current = readGroup(hex);'));
    r.setInfoFields.forEach((field) => expect(setInfo.slice(0, 900)).toContain(`${field}:`));
    expect(controller).toContain('client!.groupRequestDecide(hex, user, approve)');
    const groups = readRepo('web/telegram-tt/src/api/parvane/groups.ts');
    expect(groups).toContain(`const GROUP_ABOUT_MAX_CHARS = ${r.aboutMaxChars};`);
    expect(groups).toContain('v2.setGroupInfo(groupId, { name: title })');
  });

  it('desktop и android: v1-сведения о группе v2 отбрасываются, правка — set_info_patch под мьютексом движка', () => {
    expect(r.v1NoticeApplied).toBe(false);
    const core = readRepo('desktop/parvane-core/src/v2_session.cpp');
    expect(core).toContain('change.contains("set_info_patch")');
    expect(core).toContain('client_->groupRequestDecide(hex, user, approve)');
    const desktop = readDesktopSource();
    expect(desktop).toContain('parvane::v2::isGroupAddress(gi.group_id) && !source.startsWith(u"v2"_q)');
    expect(desktop).toContain('return { { "set_info_patch", std::move(patch) } };');
    expect(desktop).toContain(`about.toUcs4().size() > ${r.aboutMaxChars}`);
    const android = readRepo('android/jni/parvane_jni.cpp');
    expect(android).toContain('if (parvane::v2::isGroupAddress(n.group_id)) return;');
    expect(android).toContain('return json{{"set_info_patch", std::move(patch)}};');
    expect(android).toContain('s->decideJoinRequest(gid, jstr(env, member), approve == JNI_TRUE)');
  });
});

describe('E6-1: клиент работоспособен без соединения v1', () => {
  const r = rule('E6-1') as unknown as {
    v1Frame: string;
    bridged: string[];
    prefersV1: string[];
    preAuthMethods: string[];
    ownedBlobMethods: string[];
    legacyEvent: string;
    clients: { web: string; desktop: string; android: string };
  };
  const webBridge = readRepo('web/telegram-tt/src/api/parvane/v2/bridge.ts');
  const coreBridge = readRepo('desktop/parvane-core/src/v2_bridge.cpp');

  it('мост web и ядра обслуживает один и тот же список запросов', () => {
    r.bridged.forEach((subject) => {
      expect(webBridge, subject).toContain(`case '${subject}':`);
      expect(coreBridge, subject).toContain(`subject == "${subject}"`);
    });
    // T110: web класса «v1, если жив» не имеет — список и отзыв устройств всегда
    // методами v2, прекеев и setkey нет; ядро desktop/android — до их T110
    expect(webBridge).not.toMatch(/bridgePrefersV1|PREFERS_V1|prekeys|setkey/);
    r.prefersV1.forEach((subject) => {
      expect(coreBridge, subject).toContain(`"${subject}"`);
    });
  });

  it('вход и регистрация — методами канала PRE, свои блобы — методами cloud.blob', () => {
    const webControl = readRepo('web/telegram-tt/src/api/parvane/v2/control.ts');
    const coreControl = readRepo('desktop/parvane-core/src/v2_control.cpp');
    r.preAuthMethods.forEach((method) => {
      expect(webBridge, method).toContain(`'${method}'`);
      expect(coreBridge, method).toContain(`"${method}"`);
    });
    r.ownedBlobMethods.forEach((method) => {
      expect(webControl, method).toContain(`'${method}'`);
      expect(coreControl, method).toContain(`"${method}"`);
    });
  });

  it('web: соединения v1 нет вовсе (T110) — все запросы мостом, записи LegacyV1 пропускаются', () => {
    const gateway = readRepo('web/telegram-tt/src/api/parvane/gateway.ts');
    expect(gateway).not.toMatch(/new WebSocket|hasV1|isVirtual|upgrade_required/);
    expect(gateway).toContain('const viaV2 = await getV2Bridge().request(subject, payload);');
    const engine = readRepo('web/telegram-tt/src/api/parvane/v2/engine.ts');
    expect(engine).not.toMatch(/isV2Enabled|parvane:proto|VITE_PARVANE_PROTO_V2/);
    const provider = readRepo('web/telegram-tt/src/api/parvane/provider.ts');
    expect(provider).not.toMatch(/onLegacyFrame|handleInboxFrame/);
    const controller = readRepo('web/telegram-tt/src/api/parvane/v2/controller.ts');
    expect(controller).toContain(`if (ev.type === '${r.legacyEvent}') {`);
  });

  it('desktop: транспорт — мост, запись LegacyV1 подаётся обработчикам инбокса', () => {
    const desktop = readDesktopSource();
    expect(desktop).toContain(
      'return std::make_unique<parvane::v2::BridgeTransport>(std::move(cfg), std::move(inner));',
    );
    expect(desktop).toContain(`if (type == "${r.legacyEvent}") {`);
    expect(desktop).toContain('bridge->deliver(std::string("msg.user.") + self, frame);');
    expect(desktop).toContain('(upgrade_required) — работаем по v2');
  });

  it('сценарии с отключённым v1 есть у desktop и android (web без v1 целиком), мост подключён и в JNI', () => {
    expect(existsSync(path.join(REPO_ROOT, 'scripts/e2e_protocol_v1_off.mjs'))).toBe(false);
    expect(readRepo('desktop/verify_protocol_v2_v1off.sh')).toContain('PARVANE_V1_MODE=disabled');
    const jni = readRepo('android/jni/parvane_jni.cpp');
    expect(jni).toContain(
      'return std::make_unique<parvane::v2::BridgeTransport>(std::move(cfg), std::move(inner));',
    );
    expect(jni).toContain(`if (type == "${r.legacyEvent}") {`);
    expect(readRepo('android/tgx_protocol_v2_flow.sh')).toContain('PARVANE_V1_MODE=disabled');
    expect(r.clients.android).toContain('BridgeTransport');
  });
});
