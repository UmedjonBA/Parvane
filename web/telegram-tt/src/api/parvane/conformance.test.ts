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
// кода — тест сторожит, что v1-код в web не вернулся.
// spec 029 (18 окт 2026): v1 удалён из desktop (ядро parvane-core и клиент
// parvane_client.cpp: Olm/Megolm, messenger/group/call_client, v2_legacy,
// прямой NATS, курсоры синка, очередь починки). Desktop-пункты тех же правил
// сторожат, что v1-кода в desktop нет, остальные — смотрят в v2-код desktop.
// spec 031 (22 окт 2026): v1 удалён из android (монолит jni/parvane_jni.cpp,
// parvane-e2e, мост BridgeTransport, курсоры синка, легаси-копии). Android-пункты
// так же сторожат, что v1-кода нет, и смотрят в модули jni_*.cpp поверх v2-сессии ядра.
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

// Клиент desktop с T038 (spec 029) разбит по темам: parvane_client.cpp + parvane_client_*.cpp + внутренний заголовок
const DESKTOP_CLIENT_FILES = [
  'parvane_client.cpp', 'parvane_client_internal.h', 'parvane_client_auth.cpp', 'parvane_client_groups.cpp',
  'parvane_client_state.cpp', 'parvane_client_devices.cpp', 'parvane_client_linking.cpp', 'parvane_client_export.cpp',
];

function readDesktopSource() {
  return DESKTOP_CLIENT_FILES
    .map((file) => readFileSync(path.join(REPO_ROOT, 'desktop/tdesktop/Telegram/SourceFiles/parvane', file), 'utf8'))
    .join('\n');
}

// Сессия v2 ядра desktop разнесена по трём файлам (spec 029)
function readDesktopSession() {
  return ['v2_session.cpp', 'v2_session_account.cpp', 'v2_session_groups.cpp']
    .map((file) => readRepo(`desktop/parvane-core/src/${file}`))
    .join('\n');
}

// spec 029: v1-модули ядра desktop удалены вместе с заголовками
const DESKTOP_V1_FILES = [
  'desktop/parvane-core/src/e2e.cpp',
  'desktop/parvane-core/include/parvane/e2e.h',
  'desktop/parvane-core/src/transport.cpp',
  'desktop/parvane-core/src/messenger_client.cpp',
  'desktop/parvane-core/include/parvane/messenger_client.h',
  'desktop/parvane-core/src/group_client.cpp',
  'desktop/parvane-core/src/call_client.cpp',
  'desktop/parvane-core/src/v2_legacy.cpp',
  // T038 (spec 029): мост v1-запросов и клиент блобов v1 удалены — запросы аккаунта типизированным API v2
  'desktop/parvane-core/src/v2_bridge.cpp',
  'desktop/parvane-core/include/parvane/v2_bridge.h',
  'desktop/parvane-core/src/cloud_client.cpp',
  'desktop/parvane-core/include/parvane/cloud_client.h',
];

function expectDesktopV1FilesGone() {
  DESKTOP_V1_FILES.forEach((file) => expect(existsSync(path.join(REPO_ROOT, file)), file).toBe(false));
}

// JNI android с spec 031 разбит по модулям поверх v2::Session/v2_account/Control ядра (как desktop)
const ANDROID_JNI_FILES = [
  'jni_internal.h', 'jni_main.cpp', 'jni_session.cpp', 'jni_messages.cpp', 'jni_groups.cpp', 'jni_account.cpp',
  'jni_calls.cpp', 'jni_push.cpp', 'jni_sections.cpp', 'jni_planner_ops.cpp', 'v2_bridge.h', 'protocol_jni.cpp',
];

function readAndroidJni(file?: string) {
  return (file ? [file] : ANDROID_JNI_FILES).map((name) => readRepo(`android/jni/${name}`)).join('\n');
}

const ANDROID_SECTIONS_DIR = 'android/tgx-overlay/app/src/main/java/org/thunderdog/challegram/parvane/sections';

function readAndroidKt(name: string) {
  return readRepo(`android/libtd/src/main/java/org/drinkless/tdlib/${name}`);
}

// spec 031: монолит JNI с v1, Rust-библиотека v1 (Olm/Megolm) и сценарии v1/двойного стека удалены
const ANDROID_V1_FILES = [
  'android/jni/parvane_jni.cpp',
  'backend/shared/parvane-e2e/Cargo.toml',
  'backend/shared/parvane-e2e/src/lib.rs',
  'backend/shared/parvane-e2e/include/parvane_e2e.h',
  'android/tgx_protocol_v2_flow.sh',
  'android/tgx_link_flow.sh',
  'android/tgx_link_e2e.sh',
];

// Признаки v1-кода шва: Olm/Megolm ядра, мост и транспорт v1, курсоры синка, починка, легаси-копии, подпись v1
const ANDROID_V1_CODE = new RegExp([
  'parvane::e2e::', 'BridgeTransport', 'ITransport', 'g_transport', 'g_messenger', 'e2eSigner', 'makeV1Transport',
  'v1Absent', 'g_diskCursorId', 'enum class Deliver', 'kRepairAttempts', 'g_unconfirmedRead', 'pumpLoop',
  'sendLegacyCopies', 'publishLegacySet', 'syncLegacySet', 'isForeignLegacyCopy', 'legacyDevices', 'onGroupNotice',
  'decCachePut',
].join('|'));

function expectAndroidV1Gone() {
  ANDROID_V1_FILES.forEach((file) => expect(existsSync(path.join(REPO_ROOT, file)), file).toBe(false));
  ANDROID_JNI_FILES.forEach((file) => expect(readAndroidJni(file), file).not.toMatch(ANDROID_V1_CODE));
  expect(readRepo('android/jni/CMakeLists.txt')).not.toMatch(/PARVANE_E2E_LIB|parvane_e2e\b/);
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

  it('desktop: курсора синка v1 нет (spec 029: v1 удалён из desktop) — история из журнала, новое — инбокс v2', () => {
    expectDesktopV1FilesGone();
    const source = readDesktopSource();
    expect(source).not.toMatch(/SaveCursors|LoadCursors|NotePendingAndMayAdvance|mayAdvance|PumpReceive/);
    // При старте лента поднимается из локального журнала истории без ack и без повторной записи
    expect(source).toMatch(/void ReplayHistory\(\) \{[\s\S]{0,2400}injectOnMain\(session, msgs, \/\*live=\*\/false\);/);
    // Новое пишется в журнал только после вставки (живое, без TTL)
    expect(source).toMatch(/if \(live && TtlFromContent\(sm\.content\) == 0\) \{\s+HistoryAppend\(sm\);/);
  });

  it('android: курсора синка v1 нет (spec 031) — история из журнала, новое — инбокс v2', () => {
    expectAndroidV1Gone();
    const main = readAndroidJni('jni_main.cpp');
    // Каталог прежней версии (cursors.json, pending.json, …) только стирается — читать его нечем
    expect(main)
      .toContain('for (const auto *name : {"cursors.json", "dec-cache.jsonl", "pending.json", "v2-ids.txt"})');
    // Событие пишется в журнал истории до показа (без TTL), реплей — из свёрнутого журнала
    expect(main).toContain('if (journaledType(event.value("type", "")) && !hasTtl(event)) journalAppend(event);');
    expect(main).toMatch(/void journalReplay\(\) \{\s+auto msgs = journalFold\(\);/);
    // Входящее v2 разбирает движок; повтор (тот же uuid) не показывается дважды
    const session = readAndroidJni('jni_session.cpp');
    expect(session).toContain('const auto in = parvane::v2::interpretDirect(ev, me);');
    expect(session).toContain('if (!markSeen(in.id)) return; // повтор');
    expect(String(rule('SYNC-1').clients!.android)).toContain('tgx_conformance_flow.sh');
  });
});

describe('SYNC-2: непрочитанное не держит курсор вечно', () => {
  it('web: курсора нет (T110) — строки приходят расшифрованными, шифртекст v1 пропускается', () => {
    const source = readFileSync(path.join(process.cwd(), 'src/api/parvane/sync.ts'), 'utf8');
    expect(source).not.toMatch(/REPAIR_ATTEMPTS|mayAdvanceDiskCursor|undecryptableUuids/);
    // Строки приходят расшифрованными (движок v2 / кэш); шифртекст v1 пропускается
    expect(source).toMatch(/в формате v1 — пропущено/);
  });

  it('desktop: курсора и очереди починки нет (spec 029: v1 удалён из desktop) — шифртекст v1 не показывается', () => {
    const source = readDesktopSource();
    expect(source).not.toMatch(/kRepairAttempts|parvane-pending\.txt|g_repair/);
    // Строки приходят расшифрованными движком v2; запись LegacyV1 не разбирается
    expect(source).toMatch(/if \(type == "legacyV1"\) \{\s+return true; \/\/ кадры v1 больше не разбираются/);
  });

  it('android: курсора и очереди починки нет (spec 031) — запись LegacyV1 пропускается', () => {
    expectAndroidV1Gone();
    expect(readAndroidJni('jni_session.cpp')).toContain('if (type == "legacyV1") return true; // v1 удалён');
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

  it('desktop: журнал прочитанного, квитанция — E2E-содержимое v2 (spec 029: повтора msg.chat.read нет)', () => {
    const source = readDesktopSource();
    expect(source).toMatch(/parvane-read\.txt/);
    expect(source).not.toMatch(/void RetryUnconfirmedReads\(/);
    // Прочитанное сразу в журнал устройства; квитанцию автору доставляет движок v2
    expect(source).toMatch(/void MirrorRead\([\s\S]{0,2500}AppendReadJournal\(v2ids\);/);
    expect(source).toMatch(/TryMutateV2\(first, parvane::json\{\{"receipt", \{\s+\{"kind", "RECEIPT_KIND_READ"\}/);
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

  it('android: журнал прочитанного ДО квитанции, квитанция — E2E-содержимое v2 (spec 031)', () => {
    const messages = readAndroidJni('jni_messages.cpp');
    expect(messages).toMatch(new RegExp('nativeMarkRead[\\s\\S]{0,200}'
      + 'journalAppend\\(json\\{\\{"type", "read"\\}, \\{"ids", json::array\\(\\{id\\}\\)\\}\\}\\);[\\s\\S]{0,300}'
      + '"RECEIPT_KIND_READ"'));
    expect(readAndroidJni()).not.toMatch(/msg\.chat\.read|read\.json/);
    // Свёртка журнала: прочитанное (read) переживает перезапуск
    expect(readAndroidJni('jni_main.cpp'))
      .toMatch(/\} else if \(t == "read"\) \{[\s\S]{0,300}it->second\["read"\] = true;/);
    expect(String(rule('READ-1').clients!.android)).toContain('tgx_conformance_flow.sh');
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

  it('desktop: Olm/Megolm-пути нет (spec 029: v1 удалён из desktop) — автора и ключи проверяет движок v2', () => {
    expectDesktopV1FilesGone();
    const client = readDesktopSource();
    expect(client).not.toMatch(/parvane::e2e::|groupSeal|claimedFrom|Verdict::Unknown/);
    // Раздача Megolm-ключа из прежней истории ничего не показывает; кадры v1 не разбираются
    expect(client).toMatch(/contentKind\(sm\.content\) == "skdm"\) \{\s+continue;/);
    expect(client).toMatch(/if \(type == "legacyV1"\) \{\s+return true;/);
  });

  it('android: Olm/Megolm-пути нет (spec 031: v1 удалён из android) — автора и ключи проверяет движок v2', () => {
    expectAndroidV1Gone();
    const session = readAndroidJni('jni_session.cpp');
    expect(session).not.toMatch(/skdm|groupOpen|groupSeal|verifySender|senderIdentity/);
    // Входящее (и автор) — из разбора движка; править и удалять у всех можно только своё
    expect(session).toContain('const auto in = parvane::v2::interpretDirect(ev, me);');
    expect(session)
      .toContain('if (row->from != in.from || !in.content.is_object()) continue; // править можно только своё');
    expect(session).toContain('if (row->from != in.from) continue; // удалить у всех можно только своё');
    // Кадры v1 не разбираются
    expect(session).toContain('if (type == "legacyV1") return true; // v1 удалён');
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
      exportsPreV2Rows: boolean; incomingRead: boolean; groupRowsWaitForGroup: boolean;
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
    // С T110 строки эпохи v1 (без origin) тоже едут в экспорте — иначе второе
    // устройство аккаунта с перепиской до v2 остаётся с пустым списком чатов
    expect(r.v2History.exportsPreV2Rows).toBe(true);
    expect(collectV2History([{ ...row, id: 'pre-v2', origin: undefined }]).map((m) => m.id)).toEqual(['pre-v2']);
    const provider = readRepo('web/telegram-tt/src/api/parvane/provider.ts');
    expect(provider).toMatch(/linkVersion: 2,\s+v2History: collectV2History\(/);
    expect(provider).toContain('v2History = parseV2History(exportText);');
    expect(provider).toContain('isV2GroupAddress(stored.to) && !store.isGroupAddress(stored.to)');
    expect(provider).toContain('stored.from === owner ? stored : { ...stored, read: true }');
    // desktop: выдача и приём
    const desktop = readDesktopSource();
    expect(desktop).toContain(`kV2HistoryLimit = std::size_t(${r.v2History.limit})`);
    expect(desktop).toContain(`state["${r.v2History.exportField}"] = std::move(rows)`);
    // spec 029: экспорт — формат web 2 (`{linkVersion: 2, v2History}`), материала v1 нет; ключи «Плана» и «Облака» —
    // как у web (`planner`, `cloud`), в обе стороны
    expect(desktop).toContain('auto base = nlohmann::json{ { "linkVersion", 2 } };');
    expect(desktop).toContain('const auto exported = WithV2History(base.dump());');
    expect(desktop).toContain('parvane::keybundle::putLinkDomainKeys(base,');
    expect(desktop).toContain('ImportV2History(stateJson)');
    expect(desktop).toMatch(/readLinkDomainKeys\(stateJson\);\s+NoteDomainKeys\(keys\.planner, keys\.cloud\);/);
    expect(desktop).toContain('if (group && !known) {');
    expect(desktop).toContain('sm.read = true; // история, а не новые входящие');
    // android (spec 031): выдача и приём — формат web 2, материала v1 нет
    const android = readAndroidJni('jni_account.cpp');
    expect(android).toContain(`kV2HistoryLimit = ${r.v2History.limit}`);
    expect(android).toContain(`exported["${r.v2History.exportField}"] = std::move(rows)`);
    expect(android).toContain('auto exported = json{{"linkVersion", 2}};');
    expect(android).toContain(`state["${r.v2History.exportField}"]`);
    expect(android).toContain('const auto stateJson = downloadDecrypt(box, "file_id", "file_key", "file_nonce");');
    expect(android).toContain('importV2History(stateJson); // LINK-1 п. 8');
    expect(android).toContain('parvane::keybundle::putLinkDomainKeys(exported,');
    expect(android).toMatch(/readLinkDomainKeys\(stateJson\);\s+noteDomainKeys\(keys\.planner, keys\.cloud\);/);
    expect(android).toContain('if (in.group && !groupKnown(to)) {');
    expect(android).toContain('deferLinkedGroupRow(to, std::move(ev));');
    expect(android).toContain('ev["read"] = out ? row.value("read", false) : true; // история, а не новые входящие');
    expect(readAndroidJni('jni_session.cpp')).toContain('flushLinkedGroupRows(address);');
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
    const desktop = readDesktopSource();
    expect(desktop).toContain(`boxPlain["${r.v2Grant.boxField}"] = {{${coords[0]}, v2File}`);
    expect(desktop).toContain(`box.contains("${r.v2Grant.boxField}")`);
    expect(desktop).toContain('s->joinWithGrant(std::move(*material))');
    const core = readRepo('desktop/parvane-core/src/v2_session.cpp');
    expect(core).toContain('c->joinWithGrant(linkMaterial_, cfg_.otkCount)');
    expect(core).toContain('{"type", "needsLinking"}');
    // android (spec 031): выдача (роль старого устройства) и приём
    const android = readAndroidJni('jni_account.cpp');
    expect(android).toContain(`boxPlain["${r.v2Grant.boxField}"] = {{${coords[0]}, c->uploadBlob(encV2.ciphertext)}`);
    expect(android).toContain('auto material = s->linkGrantMaterial();');
    expect(android).toContain(`box.contains("${r.v2Grant.boxField}")`);
    expect(android).toContain('s->joinWithGrant(std::move(material));');
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
    const desktop = readDesktopSource();
    // spec 029: экспорт без материала v1 (Olm-pickle, decCache, перенос владения)
    expect(desktop).not.toMatch(/exportLinkStateJson|signLinkTransfer|importLinkedHistory/);
    expect(desktop).toMatch(/grant\.value\("eph_pub", std::string\(\)\) != challenge/);
    expect(desktop).toContain('parvane::linking::sasCodeV2(eph->publicB64(), newChallenge)');
    // android (spec 031): обе роли, экспорт без материала v1
    const android = readAndroidJni('jni_account.cpp');
    expect(android).not.toMatch(/exportLinkStateJson|signLinkTransfer|importLinkedHistory|importStateLocked/);
    expect(android).toContain('parvane::linking::sasCodeV2(eph->publicB64(), newChallenge)');
    expect(android).toContain('grant.value("eph_pub", std::string()) != challenge');
    expect(android).toContain('parvane::linking::sasCodeV2(o.ephPub, own->publicB64())');
    expect(android).toContain('if (!parvane::linking::commitmentMatches(o.ephPub, o.commitment)) {');
  });
});

describe('KEY-1: смена ключа по виденным identity, signed_prekey только с подписью', () => {
  const r = rule('KEY-1') as unknown as {
    keyChangeSource: string; prekeySignatureRequiredInDeviceList: boolean;
    allDevicesRejectedVerdict: string;
  };
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

  it('desktop: ключей устройств v1 нет (spec 029) — смена ключа собеседника = смена корня (RECOVER-1)', () => {
    expectDesktopV1FilesGone();
    const client = readDesktopSource();
    expect(client).not.toMatch(/rememberContactIdentity|g_seenIds|prekeySigOk|identity\.prekeys\./);
    expect(client).toMatch(/type == "peerRootChanged"[\s\S]{0,500}AnnounceKeyChange\(user\)/);
    expect(readDesktopSession()).toContain('outbox_.push_back(json{{"type", "peerRootChanged"}, {"user", user}});');
  });

  it('android: ключей устройств v1 нет (spec 031) — смена ключа собеседника = смена корня, служебное в чате', () => {
    expectAndroidV1Gone();
    expect(readAndroidJni()).not.toMatch(/rememberContactIdentity|g_seenIds|prekeySigOk|identity\.prekeys\./);
    expect(readAndroidJni('jni_session.cpp'))
      .toMatch(/if \(type == "peerRootChanged"\) \{[\s\S]{0,200}emit\(json\{\{"type", "peer_root_changed"\}/);
    expect(readAndroidKt('Client.kt')).toMatch(/"peer_root_changed" -> [\s\S]{0,300}chatServiceMessage\(u, u, "root:/);
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

  it('desktop: отправок v1 нет (spec 029: v1 удалён из desktop) — каждая отправка конвертом движка v2', () => {
    expectDesktopV1FilesGone();
    const desktop = readDesktopSource();
    expect(desktop).not.toMatch(/m->sendContent\(|E2eSigner|sendLegacyCopies|msg\.chat\.ack/);
    expect(desktop).toContain('s->sendContent(to, *mapped, id);');
    // Собеседник без журнала устройств v2 — отказ отправки, понижения до v1 нет
    expect(desktop).toContain('throw std::runtime_error("у собеседника нет журнала устройств');
  });

  it('android: отправок v1 нет (spec 031: v1 удалён из android) — каждая отправка конвертом движка v2', () => {
    expectAndroidV1Gone();
    const jni = readAndroidJni('jni_messages.cpp');
    expect(jni).not.toMatch(/msg\.chat\.send|msg\.chat\.ack|sealSealed|trySendV2/);
    // Одна точка отправки содержимого — v2-сессия; мутации — тоже содержимым v2
    expect(jni).toContain('s->sendContent(to, *mapped, id);');
    expect(jni).toContain('s->sendContent(chat, content, parvane::v2::newUuidV7());');
    // Сессия не готова (устройство не привязано) — отказ отправки, понижения до v1 нет
    expect(jni).toContain('if (v2NeedsLinking()) throw parvane::v2::V2Error("ERROR_CODE_NOT_LINKED");');
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
      ...ANDROID_JNI_FILES.map((file) => `android/jni/${file}`),
    ];
    files.forEach((file) => {
      const source = readFileSync(path.join(REPO_ROOT, file), 'utf8');
      expect(source, file).not.toMatch(/subscribe\(['"]presence\.\*['"]/);
    });
    // android (spec 031): v1-топиков нет — своё присутствие и «печатает» эфемерными каналами v2-сессии,
    // чужое — подпиской на конкретных собеседников
    const android = readAndroidJni();
    expect(android).not.toMatch(/presence\.<|msg\.typing\.|"presence\./);
    expect(android).toContain('try { s->sendPresence(true); } catch (const std::exception &) {}');
    expect(android).toContain('try { s->watchPeers(peers); } catch (const std::exception &) {}');
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

  it('desktop берёт тайлы методом preview.map_tile (v2_account::mapTile) и не знает картографических хостов', () => {
    // T038 (spec 029): топиков v1 в desktop нет — тайл запрашивается методом v2 соединения управления
    const account = readRepo('desktop/parvane-core/src/v2_account.cpp');
    expect(account).toContain('c.call("preview.map_tile"');
    const core = readRepo('desktop/parvane-core/src/map_tiles.cpp');
    expect(core).not.toMatch(/topics::|ITransport|makeEvent/);
    expect(readRepo('desktop/tdesktop/Telegram/SourceFiles/parvane/parvane_map.cpp'))
      .toContain('parvane::v2::account::mapTile(*control, key.z, key.x, key.y, parvane::map::kTileTimeoutMs)');
    for (const file of map.clients!.desktop as string[]) {
      const source = readRepo(file);
      for (const host of hosts) expect(source).not.toContain(host);
    }
  });

  it('android берёт тайлы методом preview.map_tile ядра и не знает картографических хостов', () => {
    const client = readRepo('android/libtd/src/main/java/org/drinkless/tdlib/Client.kt');
    expect(client).toMatch(/ParvaneCore\.mapTile\(/);
    // spec 031: топиков v1 нет — тайл запрашивается тем же методом соединения управления v2, что у desktop
    const jni = readAndroidJni('jni_messages.cpp');
    expect(jni).toContain('nativeMapTile');
    expect(jni)
      .toContain('png = parvane::v2::account::mapTile(*c, std::uint32_t(z), std::uint32_t(x), std::uint32_t(y));');
    for (const file of [
      'android/libtd/src/main/java/org/drinkless/tdlib/Client.kt',
      'android/libtd/src/main/java/org/drinkless/tdlib/MapGeometry.kt',
      ...ANDROID_JNI_FILES.map((name) => `android/jni/${name}`),
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
    const source = readDesktopSource();
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
    // android: docId считает шов (spec 031: FNV в JNI больше не нужен — адреса не хешируются в топики v1)
    expect(readAndroidKt('EmojiDocId.kt')).toContain(`const val OFFSET_BASIS: Long = ${basis}L`);
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
    const source = readDesktopSource();
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

  it('десктоп: нотиса v1 нет (spec 029: v1 удалён из desktop) — сведения из журнала движка, по ревизии', () => {
    expectDesktopV1FilesGone();
    const client = readDesktopSource();
    expect(client).not.toMatch(/onGroupNotice|ApplyGroupInfo\(session, \*n\.info/);
    expect(client).toMatch(/QHash<QString, quint64> g_groupVersions;/);
    expect(client).toMatch(/gi\.version < known\.value\(\)/);
    // Сведения приходят событием сессии v2 и применяются только как источник «v2 …»
    expect(client).toMatch(/if \(type == "groupUpdated"\) \{[\s\S]{0,300}ApplyV2Group\(address, info, isNew\);/);
    const applyCalls = client.match(/ApplyGroupInfo\(session, [^\n]*/g) || [];
    expect(applyCalls.length).toBeGreaterThan(0);
    applyCalls.forEach((call) => expect(call).toContain('u"v2'));
    // Исключили или группу удалили — запись журнала, чат снимается без перезагрузки
    expect(client).toMatch(/if \(type == "groupLeft"\) \{[\s\S]{0,400}DropGroupLocally\(session, address,/);
    expect(readRepo('desktop/parvane-core/include/parvane/group.h')).toMatch(/std::uint64_t version = 0;/);
    expect(String(group.clients!.desktop)).toContain('verify_conformance_group.sh');
  });

  it('android: нотиса v1 нет (spec 031) — событие сессии groupUpdated → `group` шва, применение по ревизии', () => {
    expectAndroidV1Gone();
    const jni = readAndroidJni('jni_session.cpp');
    // Сведения — из журнала группы v2 (событие сессии), исключение/удаление — без перезагрузки
    expect(jni).toMatch(new RegExp('if \\(type == "groupUpdated"\\) \\{[\\s\\S]{0,800}'
      + 'emit\\(json\\{\\{"type", "group"\\}, \\{"group_id", address\\}, \\{"change", "v2"\\}'));
    expect(jni).toMatch(/if \(type == "groupLeft"\) \{[\s\S]{0,300}\{"change", "removed"\}/);
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

  // spec 031: звонки на android — менеджеры ядра (CallManager/GroupCallManager) и org.webrtc из состава X;
  // кандидат кодирует/читает тот же кодек ядра, сигналы — только запечатанными конвертами v2
  it('android: общий кодек ядра, сигналы через v2-сессию', () => {
    const calls = readAndroidJni('jni_calls.cpp');
    expect(calls).toContain('const auto c = parvane::parseIceCandidate(candidate);');
    expect(calls).toContain('cb(parvane::iceCandidateJson(parvane::IceCandidate{sdp, mid, index}));');
    expect(calls).toContain('if (!s || !s->sendCallSignal(peer, signal, std::string(), &error)) return false;');
    expect(calls).toContain('return s && s->sendCallSignal(peer, signal, groupCallId);');
    expect(calls).not.toMatch(/call\.signal|JSON\.parse|candidate"\]/);
    expect(readAndroidJni('jni_session.cpp')).toContain('handleCallSignal(ev.value("from", std::string()), '
      + 'ev.value("group", false), ev.value("signal", json::object()));');
    expect(String(rule('CALL-1').clients!.android)).toContain('tgx_calls_flow.sh');
  });

  // CALL-2 (spec 031): приглашение в групповой звонок группы несёт её адрес и название
  it('android: групповой звонок группы — с адресом и названием (CALL-2)', () => {
    const calls = readAndroidJni('jni_calls.cpp');
    expect(calls).toContain('gm->startCall(parvane::v2::newUuidV7(), parts, v ? "video" : "audio", g, t);');
    expect(calls).toContain('{"group", group}, {"title", parvane::v2::cleanGroupTitle(title)}');
    expect(readRepo(`${ANDROID_SECTIONS_DIR}/GroupCallController.kt`))
      .toContain('ParvaneCalls.groupStart(members, false, g.optString("gid"), g.optString("title"))');
    expect(String(rule('CALL-2').clients!.android)).toContain('tgx_group_call_flow.sh');
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
          .toMatch(/JSON\.parse\((pv\.|codec\.decode|client\.|session\.|host\.decode|String\(e$|localStorage\.)/);
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

  it('desktop: легаси-копий нет (spec 029: v1 удалён из desktop) — доставить v1-устройствам нечем', () => {
    expectDesktopV1FilesGone();
    const desktop = readDesktopSource();
    expect(desktop).not.toMatch(/sendLegacyCopies|publishLegacySet|isForeignLegacyCopy|legacyDevices/);
    const session = readDesktopSession();
    expect(session).not.toMatch(/legacyDevices|syncLegacySet|deliver_legacy/);
    // Запись LegacyV1 (кадр v1) целиком пропускается: читать её нечем
    expect(desktop).toMatch(/if \(type == "legacyV1"\) \{\s+return true;/);
  });

  it('android: легаси-копий нет (spec 031: v1 удалён из android) — доставить v1-устройствам нечем', () => {
    expectAndroidV1Gone();
    expect(readAndroidJni()).not.toMatch(/deliver_legacy|LegacyDevices|legacySet/);
    // Запись LegacyV1 (кадр v1) целиком пропускается: читать её нечем
    expect(readAndroidJni('jni_session.cpp')).toContain('if (type == "legacyV1") return true; // v1 удалён');
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

  it('desktop и android: «печатает» — только эфемерный канал сессии ядра, кадра v1 нет', () => {
    const session = readRepo('desktop/parvane-core/src/v2_session.cpp');
    expect(session).toContain('if (!group && !isV2Peer(chat)) return false;');
    expect(session).toContain('if (!ready_ || !client_) return true; // чат v2: по v1 не понижаем');
    // desktop (T038): кадра v1 нет вовсе — только эфемерный канал сессии
    expect(readDesktopSource()).toContain('(void)s->sendTyping(to);');
    expect(readDesktopSource()).not.toMatch(/msgTyping\(/);
    // android (spec 031): тоже без кадра v1; в L2-чате «печатает» не уходит (L2-1)
    const android = readAndroidJni('jni_messages.cpp');
    expect(android).toMatch(new RegExp('nativeSendTyping[\\s\\S]{0,200}if \\(l2Active\\(chat\\)\\) return; // L2-1'
      + '[\\s\\S]{0,300}\\(void\\)s->sendTyping\\(chat\\);'));
    expect(readAndroidJni()).not.toMatch(/msgTyping\(|msg\.typing\./);
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
    // «Сменить ключи» — отзыв с ротациями; иначе обычный выход (запись `sign_out`, ключи прежние)
    expect(provider).toMatch(new RegExp('TOPIC_DEVICE_REVOKE[\\s\\S]{0,900}'
      + 'shouldRotateKeys \\? v2Controller\\.revokeDevice : v2Controller\\.signOutDevice;'
      + '\\s*const isJournaled = await revoke\\(deviceId\\)'));
    const controller = readRepo('web/telegram-tt/src/api/parvane/v2/controller.ts');
    // Первый запрос — запись журнала: отказ поднимает состояние заново
    expect(controller).toContain('const [entry, ...rotations] = outcome.requests;');
    expect(controller).toContain('const [entry] = (client!.signOutDevice(deviceId) as RevokeOutcome).requests;');
    expect(controller).toMatch(/await call\(entry\.chan[\s\S]{0,400}idConn\?\.close\(\);\s*throw e;/);
    expect(controller).toContain('client.importRootBackup(unb64(rootBackupB64), recoveryKey.trim()).fill(0);');
    expect(controller).toContain('client?.forgetRoot();');
    expect(controller).toContain('pv.grantWithRootBackup(keyed, unb64(rootBackupB64))');
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
    const session = readDesktopSession();
    expect(session).toContain('runRequestsLocked(json::array({requests[0]}));');
    expect(session).toContain('if (stateRekeyed_ && !readable) {');
    expect(session).toContain('grantWithRootBackup(material, backup)');
    expect(session).toContain('grantRootBackup(linkMaterial_)');
    r.sskResults.forEach((result) => expect(session, result).toContain(`"${result}"`));
    const desktop = readDesktopSource();
    // «Выйти и сменить ключи» — отзыв с ротациями; иначе обычный выход (запись `sign_out`)
    expect(desktop).toMatch(
      new RegExp('account::revokeDevice\\(\\*t, devStd, pwStd\\)[\\s\\S]{0,2000}'
        + 'rotateKeys \\? s->revokeDevice\\(devStd\\) : s->signOutDevice\\(devStd\\)'),
    );
    expect(desktop).toContain('for (const auto &id : s->ownDevices()) {');
    // android (spec 031): «Выйти и сменить ключи» — отзыв с ротациями, иначе обычный выход; пароль (session.reauth) —
    // при любом способе, как desktop и web (P-07)
    const android = readAndroidJni('jni_account.cpp');
    expect(android).toMatch(new RegExp('parvane::v2::account::revokeDevice\\(\\*c, dev, jstr\\(env, password\\)\\);'
      + '[\\s\\S]{0,400}const bool ok = rotate == JNI_TRUE \\? s->revokeDevice\\(dev\\) : s->signOutDevice\\(dev\\);'));
    expect(android).toContain('for (const auto &id : s->ownDevices()) inLog.insert(id);');
    expect(android).toContain('out["left_devices"] = s->leftSskHolders();');
    // Смена SSK: держатель корня — сам, иначе ключом восстановления (экран устройств)
    expect(readAndroidJni('jni_session.cpp'))
      .toContain('LOGI("v2: смена SSK корнем: %s", s->rotateSsk(std::string()).c_str());');
    expect(android).toContain('s->rotateSsk(parvane::keybundle::pickRecoveryKey(jstr(env, key)))');
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
    expect(identity).toContain(`DeviceLogSyncAnonResponse { entries, more, ${r.genesisField}, deleted: false }`);
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
    // android (spec 031): событие смены корня, вход по ключу и сброс личности — методами сессии ядра
    expect(readAndroidJni('jni_session.cpp')).toContain('emit(json{{"type", "peer_root_changed"}');
    const account = readAndroidJni('jni_account.cpp');
    expect(account).toContain('return jout(env, s ? s->resetIdentity(jstr(env, password)) : std::string("failed"));');
    expect(account)
      .toContain('auto outcome = s->joinWithRecoveryKey(parvane::keybundle::pickRecoveryKey(jstr(env, key)), false);');
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
    // Загрузка — авторизованным соединением блобов (perf A7: своё соединение
    // V2Control, не очередь соединения движка), чанк — байтами от движка
    r.uploadMethods.forEach((method) => expect(controller, method).toContain(`'${method}'`));
    expect(controller).toContain('blobControl.requestBytes(method, body, BLOB_TIMEOUT_MS)');
    // Bucket по умолчанию 0 (медиа чатов); 1 («Облако») передаёт только cloudBlobs.ts
    expect(controller).toContain('uploadBlobChunk(uploadId: string, index: number, data: Uint8Array, bucket = 0)');
    expect(controller).toContain('encodeUploadChunkBody(pv, uploadId, index, bucket, data)');
    expect(readRepo('web/telegram-tt/src/api/parvane/attachmentUpload.ts'))
      .toContain('transport.uploadBlobChunk(uploadId, index, data))');
    expect(controller).toContain(`const method = '${r.downloadMethod}';`);
    // Скачивание по секрету — анонимным каналом: пул соединений блобов (A9) открывает их только так
    const blobPool = controller.slice(
      controller.indexOf('const blobConns = createBlobConnPool<V2Connection>('),
      controller.indexOf('function streamBlobCap('),
    );
    expect(blobPool).toContain('new V2Connection(pv, deps.gatewayUrl(), CHANNEL_ANONYMOUS)');
    expect(controller).toMatch(/blobConns\.run\(\s*`file:\$\{fileId\}`/);
    const map = readRepo('web/telegram-tt/src/api/parvane/v2/contentMap.ts');
    expect(map).toContain(`${r.contentField}: c.${r.contentField},`);
    expect(map).toContain(`${r.contentField}: m.${r.contentField} || undefined,`);
  });

  it('desktop и android: общее ядро, секрет в содержимом, анонимное скачивание', () => {
    const session = readRepo('desktop/parvane-core/src/v2_session.cpp');
    r.uploadMethods.forEach((method) => expect(session, method).toContain(`"${method}"`));
    expect(session).toContain(`conn.requestStream("${r.downloadMethod}"`);
    expect(session).toContain('conn.open(kChannelAnonymous, cfg_.clientVersion);');
    // 21 окт 2026: пакетная загрузка с потолком размера вынесена в v2_link (downloadBlobChunks)
    const link = readRepo('desktop/parvane-core/include/parvane/v2_link.h');
    expect(link).toContain(`inline constexpr std::uint32_t kBlobDownloadBatch = ${r.maxChunksPerRequest};`);
    const content = readRepo('desktop/parvane-core/src/v2_content.cpp');
    expect(content).toContain(`if (has(c, "${r.contentField}")) m["${r.contentField}"] = str(c, "${r.contentField}");`);
    const desktop = readDesktopSource();
    // spec 029: v1-устройств нет — вложение чата всегда по capability, без грантов получателям
    expect(desktop).not.toContain('legacyDevices');
    expect(desktop).toMatch(
      /BlobRecipientsFor\(const std::string &\) \{\s+\/\/[^\n]*\n\s+return \{ kBlobCapabilityMark \};/,
    );
    expect(desktop).toContain('const auto fileId = s->uploadBlob(bytes, capability);');
    // 21 окт 2026: загрузка вложения с потолком по заявленному размеру
    expect(desktop).toMatch(/s->downloadBlobCap\(\s*fileId,\s*parvane::v2::fromBase64\(cap\),/);
    // android (spec 031): v1-устройств нет — вложение чата всегда по секрету, без грантов получателям
    const android = readAndroidJni();
    expect(android).not.toMatch(/legacyDevices|getCloudRecipients|recipients\)/);
    const messages = readAndroidJni('jni_messages.cpp');
    expect(messages).toContain('const auto fileId = s->uploadBlob(ciphertext, capability);');
    expect(messages).toContain(`target["${r.contentField}"] = parvane::v2::toBase64(capability);`);
    const main = readAndroidJni('jni_main.cpp');
    expect(main).toContain('d.bytes = s->downloadBlobCap(fileId, *secret, std::string(), maxBytes);');
    expect(main).toContain(
      `rememberBlobCap(content.value("file_id", std::string()), content.value("${r.contentField}", std::string()));`,
    );
    // Секрет запоминается с каждым показанным содержимым (живое, журнал, перенос истории)
    expect(main).toMatch(/void noteMessage\([^)]*\) \{\s+if \(id\.empty\(\)\) return;\s+rememberBlobCaps\(content\);/);
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
    // spec 029: v1-блоба настроек desktop не публикует вовсе — правка уходит в журнал
    expect(desktop).toMatch(/void PublishNotifyBlob\(\) \{\s+\/\/[^\n]*\n\}/);
    expect(desktop).toMatch(/void MirrorNotifySettings\([\s\S]{0,800}ScheduleStateFlush\("notify"\);/);
    // Своя несохранённая правка сильнее серверного значения — по группам полей
    // (незнакомые/группы и звонки/присутствие, T137): серверным перезаписывается
    // только то, что не правилось на этом устройстве
    expect(desktop).toMatch(/if \(!privacy\.dirty\) \{\s+privacy\.strangers = strangers;/);
    expect(desktop).toMatch(/if \(!privacy\.dirtyCallsPresence\) \{\s+privacy\.callsNobody = callsNobody;/);
    const session = readRepo('desktop/parvane-core/src/v2_session.cpp');
    expect(session).toContain(`call(false, "${r.privacyGetMethod}"`);
    expect(session).toContain(`call(false, "${r.privacySetMethod}"`);
    expect(session).toMatch(/if \(privacySet_\) \{\s+pushPrivacyLocked\(\);\s+\} else \{\s+fetchPrivacyLocked\(\);/);
  });

  it('android: те же виды в журнале (spec 031: закреп, «непрочитано», реакция), приватность — событие сессии', () => {
    const journal = readAndroidKt('StateJournal.kt');
    const kinds = journal.match(/val KINDS = listOf\(([^)]*)\)/)![1];
    r.kinds.forEach((kind) => expect(kinds, kind).toContain(`"${kind}"`));
    expect(journal).toContain(`.put("list", "${r.mainPinList}")`);
    expect(journal).toContain('out.put("unread_marks", peers(local.unreadMarkedChatIds(), "unread"))');
    expect(journal).toContain('snap.optJSONObject("quick_reaction")?.let { r ->');
    expect(readRepo('android/libtd/src/test/java/org/drinkless/tdlib/StateJournalTest.kt'))
      .toContain('fun pinsUnreadAndReactionRoundTrip()');
    const client = readAndroidKt('Client.kt');
    ['is TdApi.ToggleChatIsPinned ->', 'is TdApi.ToggleChatIsMarkedAsUnread ->', 'is TdApi.SetDefaultReactionType ->']
      .forEach((handler) => expect(client).toContain(handler));
    // Приватность — с сервера событием сессии; своя неподтверждённая правка сильнее (PrivacyPrefs)
    expect(readAndroidJni('jni_session.cpp')).toContain('type == "privacy" ? "privacy" : "privacy_saved"');
    expect(client).toContain('"privacy" -> if (privacy.applyServer(store.self,');
    expect(String(rule('STATE-2').clients!.android)).toContain('pinsUnreadAndReactionRoundTrip');
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
    // android (spec 031): блокировка в шве зовёт отзыв доступа ядра
    expect(readAndroidJni('jni_account.cpp')).toContain('s->revokeContactAccess(jstr(env, peer))');
    expect(readAndroidKt('Client.kt')).toContain('if (ParvaneCore.revokeContactAccess(address))');
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

  it('desktop: id чата — от прежнего адреса; сведений v1 нет — перевод не запускается (spec 029)', () => {
    const client = readDesktopSource();
    // Переведённые группы по-прежнему открываются прежним чатом
    expect(client).toContain('g_migratedFrom.constFind(rawAddress)');
    expect(client).toContain('const auto gid = CanonicalGroup(rawGid);');
    expect(client).toMatch(/void DropGroupLocally\([^)]*\) \{\s*if \(IsMigratedGroup\(gid\)\) \{\s*return;/);
    expect(client).toContain('NoteV2GroupOrigin(session, address, info);');
    // Перевод запускает только сведения группы v1, а их источников (шард, нотис) у desktop больше нет:
    // ApplyGroupInfo зовётся лишь из журнала v2 (см. GROUP-1)
    expectDesktopV1FilesGone();
    (client.match(/ApplyGroupInfo\(session, [^\n]*/g) || []).forEach((call) => expect(call).toContain('u"v2'));
    const session = readDesktopSession();
    expect(session).not.toContain('legacyDevices(member)');
    expect(readRepo('desktop/parvane-core/src/v2_engine.cpp')).toContain('pv_client_group_create_from(');
  });

  it('android: групп v1 нет (spec 031) — каталог v1 стирается при первом запуске, перевод не запускается', () => {
    expectAndroidV1Gone();
    const jni = readAndroidJni();
    expect(jni).not.toMatch(/migrateGroup|groupCreateFrom|group_create_from/);
    expect(readAndroidJni('jni_main.cpp')).toContain('wipeAccountData("каталог протокола v1");');
    // Группы — только из журнала v2-сессии (адреса `v2g:`)
    expect(readAndroidJni('jni_main.cpp')).toContain('for (const auto &address : s->groupAddresses()) {');
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
    // spec 024: одобрение несёт ссылку заявки (`via_link_id`)
    const approve = `Change::${r.approveEntry}(gpb::${r.approveEntry} { via_link_id: via_link_id.to_vec(), `;
    expect(client).toContain(`${approve}member: Some(member.clone()) })`);
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
    expect(controller).toContain('client!.groupRequestDecide(hex, user, approve, linkId)');
    const groups = readRepo('web/telegram-tt/src/api/parvane/groups.ts');
    expect(groups).toContain(`const GROUP_ABOUT_MAX_CHARS = ${r.aboutMaxChars};`);
    expect(groups).toContain('v2.setGroupInfo(groupId, { name: title })');
  });

  it('desktop и android: v1-сведения о группе v2 отбрасываются, правка — set_info_patch под мьютексом движка', () => {
    expect(r.v1NoticeApplied).toBe(false);
    const core = readDesktopSession();
    expect(core).toContain('change.contains("set_info_patch")');
    // Решение по заявке — запрос движка (spec 024: с ссылкой заявки), без локального применения
    expect(core).toContain('if (!linkId.empty()) args["viaLinkHex"] = linkId;');
    expect(core).toContain('reqJson = client_->call("groupRequestDecide", args);');
    const desktop = readDesktopSource();
    expect(desktop).toContain('parvane::v2::isGroupAddress(gi.group_id) && !source.startsWith(u"v2"_q)');
    expect(desktop).toContain('return { { "set_info_patch", std::move(patch) } };');
    expect(desktop).toContain(`about.toUcs4().size() > ${r.aboutMaxChars}`);
    // android (spec 031): v1-сведений нет вовсе; правка — Session::setGroupInfo ядра (set_info_patch под мьютексом),
    // переименование — запись set_info_patch, заявка — запрос движка со ссылкой
    expectAndroidV1Gone();
    const android = readAndroidJni('jni_groups.cpp');
    expect(android).toContain('const bool ok = s->setGroupInfo(gid, nm, ab, clearAvatar == JNI_TRUE');
    expect(android).toContain('if (act == "rename") return json{{"set_info_patch", {{"name", a}}}};');
    expect(android).toMatch(new RegExp(`\\(c & 0xC0\\) != 0x80; \\}\\) > ${r.aboutMaxChars}\\)`));
    expect(android).toContain(
      's->decideJoinRequest(jstr(env, groupId), jstr(env, member), approve == JNI_TRUE, jstr(env, linkId))',
    );
  });
});

describe('E6-1: клиент работоспособен без соединения v1', () => {
  const r = rule('E6-1') as unknown as {
    v1Frame: string;
    bridged: string[];
    prefersV1: string[];
    preAuthMethods: string[];
    ownedBlobMethods: string[];
    desktopMethods: string[];
    legacyEvent: string;
    clients: { web: string; desktop: string; android: string };
  };
  const webBridge = readRepo('web/telegram-tt/src/api/parvane/v2/bridge.ts');
  // T038 (spec 029): desktop без моста — типизированный API аккаунта над методами v2
  const coreAccount = readRepo('desktop/parvane-core/src/v2_account.cpp');

  it('мост web обслуживает список запросов; ядро desktop зовёт те же методы v2 напрямую', () => {
    r.bridged.forEach((subject) => {
      expect(webBridge, subject).toContain(`case '${subject}':`);
    });
    // cloud.blob.delete зовётся через Control::deleteBlob (v2_control.cpp)
    const coreControlForMethods = readRepo('desktop/parvane-core/src/v2_control.cpp');
    r.desktopMethods.forEach((method) => {
      expect(coreAccount + coreControlForMethods, method).toContain(`"${method}"`);
    });
    // T110 / spec 029: ни web, ни ядро desktop класса «v1, если жив» не имеют — список и
    // отзыв устройств всегда методами v2, прекеев нет
    expect(webBridge).not.toMatch(/bridgePrefersV1|PREFERS_V1|prekeys|setkey/);
    expect(coreAccount).not.toMatch(/prefersV1|PrefersV1|identity\.prekeys|setkey|subject ==/);
    expect(coreAccount).toContain('c.call("identity.device.list", json::object())');
    expect(coreAccount).toContain('(void)c.call("identity.device.revoke", json{{"device_id", deviceId}});');
  });

  it('вход и регистрация — методами канала PRE, свои блобы — методами cloud.blob', () => {
    const webControl = readRepo('web/telegram-tt/src/api/parvane/v2/control.ts');
    const coreControl = readRepo('desktop/parvane-core/src/v2_control.cpp');
    r.preAuthMethods.forEach((method) => {
      expect(webBridge, method).toContain(`'${method}'`);
      expect(coreAccount, method).toContain(`"${method}"`);
    });
    r.ownedBlobMethods.forEach((method) => {
      expect(webControl, method).toContain(`'${method}'`);
      expect(coreControl, method).toContain(`"${method}"`);
    });
  });

  it('web: соединения v1 нет вовсе (T110) — все запросы мостом, записи LegacyV1 пропускаются', () => {
    const gateway = readRepo('web/telegram-tt/src/api/parvane/gateway.ts');
    expect(gateway).not.toMatch(/new WebSocket|hasV1|isVirtual|upgrade_required/);
    expect(gateway).toContain('viaV2 = await getV2Bridge().request(subject, payload);');
    const engine = readRepo('web/telegram-tt/src/api/parvane/v2/engine.ts');
    expect(engine).not.toMatch(/isV2Enabled|parvane:proto|VITE_PARVANE_PROTO_V2/);
    const provider = readRepo('web/telegram-tt/src/api/parvane/provider.ts');
    expect(provider).not.toMatch(/onLegacyFrame|handleInboxFrame/);
    const controller = readRepo('web/telegram-tt/src/api/parvane/v2/controller.ts');
    expect(controller).toContain(`if (ev.type === '${r.legacyEvent}') {`);
  });

  it('desktop: соединения v1 и моста нет (spec 029, T038) — соединение управления v2, LegacyV1 пропускаются', () => {
    expectDesktopV1FilesGone();
    const desktop = readDesktopSource();
    // Соединение управления v2 вместо моста; ни транспорта v1, ни его топиков в клиенте
    expect(desktop).toContain('g_control = MakeControl();');
    expect(desktop).not.toMatch(
      /BridgeTransport|ITransport|topics::|MakeTransport|g_transport|CloudClient|NatsTransport/,
    );
    // «Печатает» и присутствие — только эфемерными каналами v2-сессии (TYPING-1)
    expect(desktop).not.toMatch(/msgTyping\(|presence\(std::to_string/);
    expect(desktop).toContain('(void)s->sendTyping(to);');
    expect(desktop).toMatch(new RegExp(`if \\(type == "${r.legacyEvent}"\\) \\{\\s+return true;`));
    expect(desktop).not.toContain('bridge->deliver(std::string("msg.user.") + self, frame);');
  });

  it('web, desktop и android без v1 целиком (сценариев «v1 выключен» нет)', () => {
    expect(existsSync(path.join(REPO_ROOT, 'scripts/e2e_protocol_v1_off.mjs'))).toBe(false);
    // spec 029: сценарий desktop «v1 выключен» удалён — v1 выключать нечего
    expect(existsSync(path.join(REPO_ROOT, 'desktop/verify_protocol_v2_v1off.sh'))).toBe(false);
    expect(readRepo('desktop/verify_lib.sh')).not.toContain('PARVANE_V1_MODE');
    // spec 031: в android ни моста, ни транспорта v1 — соединение управления v2 и сессия ядра, как desktop;
    // сценарий двойного стека (tgx_protocol_v2_flow.sh, блок disabled) удалён вместе с v1
    expectAndroidV1Gone();
    const session = readAndroidJni('jni_session.cpp');
    expect(session).toContain('g_control = makeControl();');
    expect(session).toContain('return std::make_shared<parvane::v2::Control>(std::move(cfg));');
    expect(session).toContain(`if (type == "${r.legacyEvent}") return true; // v1 удалён`);
    ['tgx_lib.sh', 'tgx_session_flow.sh', 'tgx_conformance_flow.sh'].forEach((file) => {
      expect(readRepo(`android/${file}`), file).not.toMatch(/PARVANE_V1_MODE|TGX_PROTO_V1|PARVANE_PROTO_V2/);
    });
    expect(r.clients.android).toContain('spec 031');
    expect(r.clients.android).toContain('makeControl');
  });
});

describe('DOMAIN-1: планировщик parvane.planner.v1 — ключи контейнера своим устройствам, чужой домен мимо', () => {
  const r = rule('DOMAIN-1') as unknown as {
    domain: string; keyShareKind: string; linkExportField: string; rotateMethod: string; snapshotEvery: number;
  };

  it('движок: домен, вид ключа, смена эпохи и порог снимка — из правила', () => {
    const planner = readRepo('backend/protocol/src/domain/planner.rs');
    expect(planner).toContain(`pub const DOMAIN_NAME: &str = "${r.domain}";`);
    expect(planner).toContain(`pub const SNAPSHOT_EVERY: u64 = ${r.snapshotEvery};`);
    const client = readRepo('backend/protocol/src/client_planner.rs');
    expect(client).toContain(`OutRequest::id("${r.rotateMethod}"`);
    expect(client).toContain('fn planner_accept_key(&mut self, sender: &str, share: &ContainerKeyShare, seq: u64)');
    // spec 026: «своё устройство» — и под прежним ником
    expect(client).toContain('if !self.is_own_address(sender) || share.domain != planner::DOMAIN_NAME {');
    const core = readRepo('backend/protocol/src/client.rs');
    const kind = r.keyShareKind.replace(/(^|_)([a-z])/g, (_, __, c: string) => c.toUpperCase());
    expect(core).toContain(`Some(content::Kind::${kind}(share)) => {`);
    expect(core).toContain('match self.planner_rotate_on_revoke(now_ms()) {');
  });

  it('web: контейнер, очередь и ключи в экспорте линковки', () => {
    const sync = readRepo('web/telegram-tt/src/api/parvane/v2/planner.ts');
    expect(sync).toContain(`export const PLANNER_DOMAIN = '${r.domain}';`);
    expect(sync).toContain('\'domain.op.sync\'');
    expect(sync).toContain('\'domain.snapshot.get\'');
    const provider = readRepo('web/telegram-tt/src/api/parvane/provider.ts');
    expect(provider).toContain(`${r.linkExportField}: v2Controller.planner.keysExport(),`);
    expect(provider).toContain('if (plannerKeys) v2Controller.planner.keysImport(plannerKeys);');
    const controller = readRepo('web/telegram-tt/src/api/parvane/v2/controller.ts');
    expect(controller).toContain('if (ev.type === \'plannerChanged\') planner.onEngineEvent();');
  });

  // spec 031: «План» на android — экраны оверлея X над хабом разделов ядра (порт desktop, логика в ядре)
  it('android: контейнер планировщика ведёт ядро, ключи — из копии ключей аккаунта, событие движка — в хаб', () => {
    const sections = readAndroidJni('jni_sections.cpp');
    expect(sections).toContain('planner::PlannerSync plannerSync_;');
    expect(sections).toContain('if (domainName == "planner") {');
    expect(readAndroidJni('jni_session.cpp')).toMatch(
      /if \(type == "plannerChanged" \|\| type == "cloudChanged"\) \{\s+sectionsEngineEvent\(/,
    );
    expect(readAndroidJni('jni_account.cpp')).toContain('noteDomainKeys(bundle.value("planner", std::string()),');
    expect(existsSync(path.join(REPO_ROOT, ANDROID_SECTIONS_DIR, 'PlannerController.kt'))).toBe(true);
    expect(String(rule('DOMAIN-1').clients!.android)).toContain('tgx_sections_flow.sh');
  });
});

describe('TASK-1: задание в чат — видимые сообщения, клиент без планировщика показывает текст', () => {
  const r = rule('TASK-1') as unknown as {
    kinds: string[];
    fieldNumbers: Record<string, number>;
    vectors: string[];
    fallbackField: string;
    sourceField: string;
    clients: { web: string; desktop: string; android: string };
  };

  it('схема и вектора: поля 20/21, случаи в content/kinds.json', () => {
    const proto = readRepo('proto/parvane/msg/v2/content.proto');
    expect(proto).toContain(`TaskOffer task_offer = ${r.fieldNumbers.task_offer};`);
    expect(proto).toContain(`TaskResponse task_response = ${r.fieldNumbers.task_response};`);
    expect(proto).toContain(`string ${r.fallbackField} = 8 [(parvane.core.v2.max_len) = 600];`);
    const vectors = readRepo('proto/parvane/vectors/content/kinds.json');
    r.vectors.forEach((name) => expect(vectors).toContain(`"name": "${name}"`));
    const planner = readRepo('proto/parvane/planner/v1/planner.proto');
    expect(planner).toContain(`Source ${r.sourceField} = 16;`);
  });

  it('web: разбор обоих видов, хранилище решений, принятие один раз на аккаунт', () => {
    const map = readRepo('web/telegram-tt/src/api/parvane/v2/contentMap.ts');
    r.kinds.forEach((kind) => expect(map).toContain(`case '${kind}':`));
    const sync = readRepo('web/telegram-tt/src/api/parvane/sync.ts');
    expect(sync).toContain('function handleTaskOfferContent(stored: WireStoredMessage) {');
    const messages = readRepo('web/telegram-tt/src/api/parvane/messages.ts');
    // Дубль ищет общая функция: задача — по `source`, событие (карточка со временем) — по id карточки
    expect(messages).toContain('if (findOfferInPlan(json ? JSON.parse(json) : undefined, uuid)) return \'exists\';');
    expect(readRepo('web/telegram-tt/src/api/parvane/taskOffers.ts'))
      .toContain(`find((candidate) => candidate.${r.sourceField}?.opId === opId);`);
    expect(messages).toContain('const opId = uuid.replace(/-/g, \'\');');
    expect(messages).toContain('async parvaneRespondTaskOffer(');
  });

  it('desktop и android: оба вида показываются текстом из поля text', () => {
    const core = readRepo('desktop/parvane-core/src/v2_content.cpp');
    r.kinds.forEach((kind) => expect(core).toContain(`"${kind}"`));
    // spec 029: ядро разбирает оба вида в карточку (как web), клиент без карточки показывает `text`
    expect(core).toContain('} else if (c.contains("task_offer") && c["task_offer"].is_object()) {');
    expect(core).toContain('} else if (c.contains("task_response") && c["task_response"].is_object()) {');
    expect(readRepo('desktop/parvane-core/include/parvane/messenger.h'))
      .toContain('const bool card = kind == "task_offer" || kind == "task_response" || kind == "cloud_invite"');
    const tests = readRepo('desktop/parvane-core/tests/v2_tests.cpp');
    expect(tests).toContain(
      'for (const auto *kind : {"task_offer", "task_response", "cloud_invite", "article", "mod_report"})',
    );
    expect(tests).toContain('" показывается текстом"');
    expect(tests).toContain('task_offer туда и обратно без потерь');
    expect(r.clients.desktop).toContain('v2_tests.cpp');
    const store = readRepo('android/libtd/src/main/java/org/drinkless/tdlib/ParvaneStore.kt');
    expect(store).toContain('"task_offer", "task_response" -> textContent(c)');
    expect(readRepo('android/libtd/src/test/java/org/drinkless/tdlib/ProtocolV2SeamTest.kt'))
      .toContain('taskOfferShowsAsText');
    expect(r.clients.android).toContain('taskOfferShowsAsText');
    // spec 031: у X карточка с кнопками (inline-клавиатура), нажатие — GetCallbackQueryAnswer → «План» ядра
    expect(readAndroidKt('Cards.kt')).toContain('"task_offer" -> if (out) null else when (decided) {');
    const client = readAndroidKt('Client.kt');
    expect(client).toContain('is TdApi.GetCallbackQueryAnswer -> onCardPress(');
    expect(client).toContain('org.parvane.core.ParvaneSections.planner("offerAccept",');
    expect(readRepo('android/libtd/src/test/java/org/drinkless/tdlib/CardsTest.kt'))
      .toContain('fun offerButtonsDependOnKindAndDecision()');
  });
});

describe('DOMAIN-2: облако cloud.v1 — контейнеры, ключи своим устройствам и участникам, чужой домен мимо', () => {
  const r = rule('DOMAIN-2') as unknown as {
    domain: string;
    keyShareKind: string;
    linkExportField: string;
    bundleField: string;
    leaveMethod: string;
    snapshotEvery: number;
    maxNodes: number;
    snapshotMaxBytes: number;
    driveBucket: number;
    clients: { web: string; desktop: string; android: string };
  };

  it('движок: домен, пределы, выход участника и приём ключа только от админа контейнера', () => {
    const cloud = readRepo('backend/protocol/src/domain/cloud.rs');
    expect(cloud).toContain(`pub const DOMAIN_NAME: &str = "${r.domain}";`);
    expect(cloud).toContain(`pub const SNAPSHOT_EVERY: u64 = ${r.snapshotEvery};`);
    expect(cloud).toContain(`pub const MAX_NODES: usize = ${r.maxNodes};`);
    const domain = readRepo('backend/protocol/src/domain.rs');
    expect(r.snapshotMaxBytes).toBe(3 * 1024 * 1024);
    expect(domain).toContain('pub const MAX_SNAPSHOT_PLAINTEXT: usize = 3 * 1_048_576;');
    expect(domain).toContain('pub const OP_LEAVE: &str = "leave";');
    const client = readRepo('backend/protocol/src/client_cloud.rs');
    expect(client).toContain(`OutRequest::id("${r.leaveMethod}"`);
    // spec 026: отправитель — с прежними адресами (смена ника); право админа проверяет движок домена
    expect(client).toContain('match c.access.accept_key_share_any(share, &names, &no_groups) {');
    expect(client).toContain('if !c.access.can_write(&me, &no_groups) {');
    const core = readRepo('backend/protocol/src/client.rs');
    expect(core).toContain('if share.domain == crate::domain::cloud::DOMAIN_NAME {');
    expect(core).toContain('o.requests.extend(self.cloud_rotate_on_revoke(now_ms()));');
    const tests = readRepo('backend/protocol/tests/client_flow.rs');
    expect(tests).toContain('fn cloud_drive_on_own_devices_and_rotated_on_revoke()');
    expect(tests).toContain('fn cloud_shared_folder_roles_revoke_and_leave()');
    expect(r.clients.desktop).toContain('cloud_shared_folder_roles_revoke_and_leave');
  });

  it('шарды: bucket облака со своей квотой, метод выхода участника', () => {
    const shard = readRepo('backend/shards/cloud/src/main.rs');
    expect(shard).toContain(`pub(crate) const BUCKET_DRIVE: i64 = ${r.driveBucket};`);
    expect(shard).toContain('PARVANE_CLOUD_DRIVE_QUOTA_BYTES');
    expect(readRepo('proto/parvane/cloud/v1/cloud.proto')).toContain(`BLOB_BUCKET_DRIVE = ${r.driveBucket};`);
    expect(readRepo('backend/shards/domains/src/store.rs')).toContain(`"${r.leaveMethod}" => {`);
  });

  it('web: контейнеры, ключи в экспорте линковки и в копии ключей аккаунта', () => {
    const sync = readRepo('web/telegram-tt/src/api/parvane/v2/cloud.ts');
    expect(sync).toContain(`export const CLOUD_DOMAIN = '${r.domain}';`);
    expect(sync).toContain('\'domain.op.sync\'');
    expect(sync).toContain('\'domain.snapshot.get\'');
    const provider = readRepo('web/telegram-tt/src/api/parvane/provider.ts');
    expect(provider).toContain(`${r.linkExportField}: v2Controller.cloud.keysExport(),`);
    expect(provider).toContain('if (cloudKeys) v2Controller.cloud.keysImport(cloudKeys);');
    expect(provider).toContain(`if (bundle.${r.bundleField}) v2Controller.cloud.keysImport(bundle.${r.bundleField});`);
    const controller = readRepo('web/telegram-tt/src/api/parvane/v2/controller.ts');
    expect(controller).toContain('if (ev.type === \'cloudChanged\' && ev.id) cloud.onEngineEvent(ev.id);');
    expect(controller).toContain(`${r.bundleField}: cloud.keysExport(),`);
    expect(readRepo('web/telegram-tt/src/api/parvane/cloudBlobs.ts')).toContain('bucket: \'BLOB_BUCKET_DRIVE\'');
  });

  // spec 031: «Облако»/«Знания» на android — экраны оверлея X над CloudSync/CloudDrive/NotesStore ядра
  it('android: контейнеры облака ведёт ядро, ключи — из копии ключей аккаунта, событие движка — в хаб', () => {
    const sections = readAndroidJni('jni_sections.cpp');
    expect(sections).toContain('cloud::CloudSync cloud_;');
    expect(sections).toContain('cloud::CloudDrive drive_;');
    expect(sections).toContain('} else if (domainName == "cloud") {');
    expect(sections)
      .toContain('session->stateCall("cloudContainerSet", json{{"containerJson", cloud::cloudEntryToState(entry)}});');
    expect(readAndroidJni('jni_account.cpp'))
      .toMatch(/noteDomainKeys\(bundle\.value\("planner"[\s\S]{0,120}bundle\.contains\("cloud"\)/);
    expect(existsSync(path.join(REPO_ROOT, ANDROID_SECTIONS_DIR, 'CloudController.kt'))).toBe(true);
    expect(String(rule('DOMAIN-2').clients!.android)).toContain('tgx_sections_flow.sh');
  });
});

describe('CLOUD-1: приглашение в папку облака — видимое сообщение, клиент без раздела показывает текст', () => {
  const r = rule('CLOUD-1') as unknown as {
    kinds: string[];
    fieldNumbers: Record<string, number>;
    vectors: string[];
    fallbackField: string;
    clients: { web: string; desktop: string; android: string };
  };

  it('схема и вектора: поле 22, случай в content/kinds.json', () => {
    const proto = readRepo('proto/parvane/msg/v2/content.proto');
    expect(proto).toContain(`CloudInvite cloud_invite = ${r.fieldNumbers.cloud_invite};`);
    expect(proto).toContain(`string ${r.fallbackField} = 4 [(parvane.core.v2.max_len) = 600];`);
    const vectors = readRepo('proto/parvane/vectors/content/kinds.json');
    r.vectors.forEach((name) => expect(vectors).toContain(`"name": "${name}"`));
  });

  it('web, desktop и android: приглашение разбирается и показывается текстом', () => {
    const map = readRepo('web/telegram-tt/src/api/parvane/v2/contentMap.ts');
    r.kinds.forEach((kind) => expect(map).toContain(`case '${kind}':`));
    expect(readRepo('web/telegram-tt/src/api/parvane/store.ts')).toContain('case \'cloud_invite\':');
    const core = readRepo('desktop/parvane-core/src/v2_content.cpp');
    expect(core).toContain('} else if (c.contains("cloud_invite") && c["cloud_invite"].is_object()) {');
    expect(readRepo('desktop/parvane-core/tests/v2_tests.cpp')).toContain('cloud_invite туда и обратно');
    expect(r.clients.desktop).toContain('v2_tests.cpp');
    const store = readRepo('android/libtd/src/main/java/org/drinkless/tdlib/ParvaneStore.kt');
    expect(store).toContain('"cloud_invite" -> textContent(c)');
    expect(readRepo('android/libtd/src/test/java/org/drinkless/tdlib/ProtocolV2SeamTest.kt'))
      .toContain('cloudInviteShowsAsText');
    expect(r.clients.android).toContain('cloudInviteShowsAsText');
  });
});

describe('ARTICLE-1: статья — видимое сообщение, клиент без окна чтения показывает текст', () => {
  const r = rule('ARTICLE-1') as unknown as {
    kinds: string[];
    fieldNumbers: Record<string, number>;
    vectors: string[];
    fallbackField: string;
    clients: { web: string; desktop: string; android: string };
  };

  it('схема и вектора: поле 23, случай в content/kinds.json', () => {
    const proto = readRepo('proto/parvane/msg/v2/content.proto');
    expect(proto).toContain(`Article article = ${r.fieldNumbers.article};`);
    expect(proto).toContain(`string ${r.fallbackField} = 3 [(parvane.core.v2.max_len) = 600];`);
    const vectors = readRepo('proto/parvane/vectors/content/kinds.json');
    r.vectors.forEach((name) => expect(vectors).toContain(`"name": "${name}"`));
  });

  it('web, desktop и android: статья разбирается и показывается', () => {
    const map = readRepo('web/telegram-tt/src/api/parvane/v2/contentMap.ts');
    r.kinds.forEach((kind) => expect(map).toContain(`case '${kind}':`));
    expect(readRepo('web/telegram-tt/src/api/parvane/store.ts')).toContain('case \'article\':');
    const core = readRepo('desktop/parvane-core/src/v2_content.cpp');
    expect(core).toContain('} else if (c.contains("article") && c["article"].is_object()) {');
    expect(readRepo('desktop/parvane-core/tests/v2_tests.cpp')).toContain('article → v2 с картинкой');
    expect(r.clients.desktop).toContain('v2_tests.cpp');
    const store = readRepo('android/libtd/src/main/java/org/drinkless/tdlib/ParvaneStore.kt');
    expect(store).toContain('"article" -> textContent(c)');
    expect(readRepo('android/libtd/src/test/java/org/drinkless/tdlib/ProtocolV2SeamTest.kt'))
      .toContain('articleShowsAsText');
    expect(r.clients.android).toContain('articleShowsAsText');
    // spec 031: у X — кнопки «Читать» и «В заметки» (заметка создаётся ядром «Знаний»)
    expect(readAndroidKt('Cards.kt'))
      .toContain('"article" -> row(button(if (ru) "Читать" else "Read", "article", uuid)');
    expect(readAndroidKt('Client.kt')).toContain('org.parvane.core.ParvaneSections.notes("create",');
  });
});

describe('REPORT-1: жалоба админам группы — карточка у админа, клиент без модерации показывает текст', () => {
  const r = rule('REPORT-1') as unknown as {
    kinds: string[];
    fieldNumbers: Record<string, number>;
    vectors: string[];
    fallbackField: string;
    clients: { web: string; desktop: string; android: string };
  };

  it('схема и вектора: поле 24, случай в content/kinds.json', () => {
    const proto = readRepo('proto/parvane/msg/v2/content.proto');
    expect(proto).toContain(`ModReport mod_report = ${r.fieldNumbers.mod_report};`);
    expect(proto).toContain(`string ${r.fallbackField} = 5 [(parvane.core.v2.max_len) = 600];`);
    const vectors = readRepo('proto/parvane/vectors/content/kinds.json');
    r.vectors.forEach((name) => expect(vectors).toContain(`"name": "${name}"`));
  });

  it('web: жалоба разбирается, показывается карточкой и отправляется', () => {
    const map = readRepo('web/telegram-tt/src/api/parvane/v2/contentMap.ts');
    r.kinds.forEach((kind) => expect(map).toContain(`case '${kind}':`));
    expect(readRepo('web/telegram-tt/src/api/parvane/store.ts')).toContain('buildModReportContent');
    expect(readRepo('web/telegram-tt/src/api/parvane/messages.ts')).toContain('async reportMessages(');
    expect(r.clients.web).toContain('e2e_web_reports.mjs');
  });

  // spec 031: android шлёт жалобы из штатного окна X, админу — карточка с кнопками после проверки своими данными
  it('android: жалоба разбирается, показывается и отправляется', () => {
    expect(readAndroidKt('ParvaneStore.kt')).toContain('"mod_report" -> textContent(c)');
    const client = readAndroidKt('Client.kt');
    expect(client)
      .toContain('private fun reportChat(chatId: Long, optionId: String, messageIds: LongArray, comment: String)');
    expect(client).toContain('val content = JSONObject().put("kind", "mod_report")');
    expect(client).toContain('ParvaneCore.submitReport(');
    expect(client).toContain('val checked = ParvaneCore.checkModReport(content.toString(), from) ?: return null');
    const groups = readAndroidJni('jni_groups.cpp');
    expect(groups).toContain('try { return jout(env, s->submitReport(report)); }');
    expect(groups).toContain('const auto check = parvane::v2::validateModReport(');
    expect(readAndroidKt('Cards.kt')).toContain('"mod_report" -> if (out || !modChecked) null else');
    expect(readRepo('android/libtd/src/test/java/org/drinkless/tdlib/CardsTest.kt'))
      .toContain('fun modReportOnlyWhenCheckedAndArticleAlways()');
    expect(r.clients.android).not.toContain('ОТКРЫТО');
    expect(r.clients.android).toContain('CardsTest');
  });

  // spec 029: desktop разбирает жалобу, показывает карточку админу и шлёт жалобы
  it('desktop: жалоба разбирается, показывается и отправляется', () => {
    const core = readRepo('desktop/parvane-core/src/v2_content.cpp');
    expect(core).toContain('} else if (c.contains("mod_report") && c["mod_report"].is_object()) {');
    expect(readRepo('desktop/parvane-core/tests/v2_tests.cpp')).toContain('mod_report туда и обратно');
    expect(readDesktopSession()).toContain('std::string Session::submitReport(const json &report) {');
    const desktop = readDesktopSource();
    expect(desktop).toContain('void ReportMessages(');
    expect(desktop).toContain('u"pv:moddel:"_q + uuid');
    expect(r.clients.desktop).not.toContain('ОТКРЫТО');
    expect(r.clients.desktop).toContain('v2_tests.cpp');
  });
});

describe('RENAME-1: смена ника — журнал прежнего адреса закрыт, новый продолжает личность', () => {
  const r = rule('RENAME-1') as unknown as {
    logFields: Record<string, number>;
    groupChange: Record<string, number>;
    aliasDays: number;
    clients: { web: string; desktop: string; android: string };
  };

  it('схема: Rename и renamed_from в журнале устройств, RenameMember и подсказка адреса в журнале группы', () => {
    const envelope = readRepo('proto/parvane/core/v2/envelope.proto');
    expect(envelope).toContain(`Rename rename = ${r.logFields.rename};`);
    expect(envelope).toContain(`string renamed_from = ${r.logFields.renamed_from} [(max_len) = 128];`);
    const group = readRepo('proto/parvane/group/v2/group.proto');
    expect(group).toContain(`RenameMember rename_member = ${r.groupChange.rename_member};`);
    expect(group).toContain(`string signer_address = ${r.groupChange.signer_address}`);
  });

  it('движок: Rename только корнем, журнал закрыт; RenameMember сверяет корень прежнего адреса', () => {
    const identity = readRepo('backend/protocol/src/identity.rs');
    expect(identity).toContain('Change::Rename(r) => {');
    expect(identity).toContain('if self.renamed_to.is_some() {');
    const group = readRepo('backend/protocol/src/group.rs');
    expect(group).toContain('let old_root = lookup.and_then(|l| (l.root_of)(&old)).ok_or(ProtoError::Forbidden)?;');
    const client = readRepo('backend/protocol/src/client_rename.rs');
    ['pub fn rename_prepare(', 'pub fn rename_apply(', 'pub fn rename_follow(', 'fn link_peer_rename(']
      .forEach((f) => expect(client).toContain(f));
    const identityShard = readRepo('backend/shards/identity/src/v2/rename.rs');
    expect(identityShard).toContain(`pub(crate) const ALIAS_TTL_MS: i64 = ${r.aliasDays} * 24 * 60 * 60 * 1000;`);
  });

  it('web: смена ника, перенос собеседника без KEY-1, своё другое устройство', () => {
    const controller = readRepo('web/telegram-tt/src/api/parvane/v2/controller.ts');
    ['async function renameAccount(', 'async function followPeerRename(', 'async function followOwnRename(',
      'async function renameGroupsPending(']
      .forEach((f) => expect(controller).toContain(f));
    expect(controller).toMatch(/'renamed'\) await followPeerRename\(user, verdict\)/);
    expect(readRepo('web/telegram-tt/src/api/parvane/store.ts')).toContain('registerUserRename(');
    expect(readRepo('web/telegram-tt/src/api/parvane/secureStorage.ts'))
      .toContain('export async function migrateStorageUser(');
    expect(r.clients.web).toContain('e2e_web_rename.mjs');
  });

  // spec 031: android меняет ник (экран аккаунта оверлея), сессия и журнал истории переезжают под новый адрес
  it('android: смена ника, перенос собеседника', () => {
    const account = readAndroidJni('jni_account.cpp');
    expect(account).toContain('auto out = s->renameAccount(jstr(env, nick), jstr(env, password),');
    expect(account).toContain('std::filesystem::rename(v2StateDir(oldAddress), v2StateDir(newAddress), ec);');
    expect(account).toContain('emit(json{{"type", "renamed"}, {"from", oldAddress}, {"to", newAddress}});');
    expect(readAndroidJni('jni_session.cpp')).toContain('if (type == "peerRenamed") {');
    expect(readAndroidKt('ParvaneStore.kt')).toContain('fun noteRename(from: String, to: String): Boolean {');
    expect(readAndroidKt('Client.kt')).toContain('store.noteRename(from, to)');
    expect(readRepo(`${ANDROID_SECTIONS_DIR}/AccountController.kt`))
      .toContain('ParvaneCore.renameAccount(');
    expect(r.clients.android).not.toContain('ОТКРЫТО');
  });

  // spec 029: desktop меняет ник, переносит собеседника и своё другое устройство
  it('desktop: смена ника, перенос собеседника, своё другое устройство', () => {
    const session = readDesktopSession();
    ['json Session::renameAccount(', 'void Session::followPeerRenameLocked(', 'bool Session::followOwnRename(',
      'void Session::renameGroupsPending(']
      .forEach((f) => expect(session).toContain(f));
    const desktop = readDesktopSource();
    ['QString LatestAddress(const QString &address) {', 'bool NoteRename(const QString &from, const QString &to) {',
      'void MoveAccountLocal(const QString &oldAddress, const QString &newAddress) {']
      .forEach((f) => expect(desktop).toContain(f));
    expect(readRepo('desktop/parvane-core/tests/v2_session_tests.cpp')).toContain('spec 026: ник сменён');
    expect(r.clients.desktop).not.toContain('ОТКРЫТО');
    expect(r.clients.desktop).toContain('v2_session_tests.cpp');
  });
});

describe('DELETE-1: удаление аккаунта — отсрочка, восстановление входом, «Удалённый аккаунт» у собеседника', () => {
  const r = rule('DELETE-1') as unknown as {
    fields: Record<string, number>;
    delayDays: number;
    clients: { web: string; desktop: string; android: string };
  };

  it('схема и сервер: поля входа и синка журнала, срок, стирание в шардах', () => {
    const identity = readRepo('proto/parvane/identity/v2/identity.proto');
    expect(identity).toContain(`bool cancel_deletion = ${r.fields.session_issue_cancel_deletion};`);
    expect(identity).toContain(`int64 deletion_at_ms = ${r.fields.session_issue_deletion_at_ms};`);
    expect(identity).toContain(`bool deleted = ${r.fields.log_sync_deleted};`);
    expect(readRepo('proto/parvane/core/v2/internal.proto')).toContain(`bool purge = ${r.fields.rename_notice_purge};`);
    expect(readRepo('backend/shards/identity/src/v2/delete.rs'))
      .toContain(`pub(crate) const DELETE_DELAY_MS: i64 = ${r.delayDays} * 24 * 60 * 60 * 1000;`);
  });

  it('web: удаление, вход в удаляемый аккаунт, удалённый собеседник', () => {
    const controller = readRepo('web/telegram-tt/src/api/parvane/v2/controller.ts');
    ['async function deleteAccount(', 'function isDeletedLog(', 'async function checkPeerDeleted(']
      .forEach((f) => expect(controller).toContain(f));
    expect(readRepo('web/telegram-tt/src/api/parvane/connectionController.ts'))
      .toContain('throw new AccountDeletionPendingError(');
    expect(readRepo('web/telegram-tt/src/api/parvane/store.ts')).toContain('\'userTypeDeleted\'');
    expect(r.clients.web).toContain('e2e_web_account_delete.mjs');
  });

  // spec 031: android удаляет аккаунт, восстанавливает входом с отменой удаления, видит удалённого собеседника
  it('android: удаление, вход в удаляемый аккаунт, удалённый собеседник', () => {
    expect(readAndroidJni('jni_account.cpp')).toContain('return jreply(env, s->deleteAccount(jstr(env, password)));');
    const session = readAndroidJni('jni_session.cpp');
    expect(session).toContain('req.cancelDeletion = cancelDeletion == JNI_TRUE;');
    expect(session).toContain('if (r.deletionAtMs) out["deletion_at_ms"] = r.deletionAtMs;');
    expect(session).toContain('if (type == "peerDeleted") {');
    expect(readAndroidKt('ParvaneStore.kt'))
      .toContain('fun markDeleted(address: String, deletedName: String): TdApi.User? {');
    const client = readAndroidKt('Client.kt');
    expect(client).toContain('store.markDeleted(u, uiText("peer_deleted"))');
    expect(client).toContain('r = ParvaneCore.login(pendingNick, password, "", cancelDeletion = true)');
    expect(client).toContain('val restore = askDeletion(deletionAt)');
    expect(readRepo(`${ANDROID_SECTIONS_DIR}/AccountController.kt`))
      .toContain('ParvaneCore.deleteAccount(pw)');
    expect(r.clients.android).not.toContain('ОТКРЫТО');
  });

  // spec 029: desktop удаляет аккаунт, восстанавливает его входом и видит удалённого собеседника
  it('desktop: удаление, вход в удаляемый аккаунт, удалённый собеседник', () => {
    const session = readDesktopSession();
    expect(session).toContain('json Session::deleteAccount(const std::string &password) {');
    expect(session).toContain('outbox_.push_back(json{{"type", "peerDeleted"}, {"user", user}});');
    expect(readRepo('desktop/parvane-core/src/v2_account.cpp')).toContain('body["cancel_deletion"] = true;');
    expect(readDesktopSource()).toContain('MarkPeerDeleted(user, true);');
    expect(readRepo('desktop/parvane-core/tests/v2_session_tests.cpp'))
      .toContain('spec 027: вход с отменой удаления — аккаунт восстановлен');
    expect(r.clients.desktop).not.toContain('ОТКРЫТО');
    expect(r.clients.desktop).toContain('v2_session_tests.cpp');
  });
});

describe('CLOUD-2: ссылки облака для людей без аккаунта — только web', () => {
  const r = rule('CLOUD-2') as unknown as {
    ownerMethods: string[];
    anonMethods: string[];
    usageField: string;
    usageFieldNumber: number;
    pagePath: string;
  };

  it('схема: методы владельца — с личностью, методы посетителя — анонимным каналом', () => {
    const proto = readRepo('proto/parvane/cloud/v1/cloud.proto');
    [...r.ownerMethods, ...r.anonMethods].forEach((name) => expect(proto).toContain(`name: "${name}"`));
    r.anonMethods.forEach((name) => {
      const at = proto.indexOf(`name: "${name}"`);
      expect(proto.slice(at, at + 120)).toContain('channel: METHOD_CHANNEL_ANON');
    });
    r.ownerMethods.forEach((name) => {
      const at = proto.indexOf(`name: "${name}"`);
      expect(proto.slice(at, at + 120)).toContain('channel: METHOD_CHANNEL_ID');
    });
    expect(proto).toContain(`uint64 ${r.usageField} = ${r.usageFieldNumber};`);
  });

  it('web: приложение ведёт ссылки, публичная страница зовёт только методы посетителя', () => {
    const drive = readRepo('web/telegram-tt/src/api/parvane/cloudDrive.ts');
    r.ownerMethods.forEach((name) => expect(drive).toContain(`'${name}'`));
    const pageFiles = ['client.ts', 'frames.ts', 'index.ts', 'linkProto.ts'];
    const page = pageFiles.map((file) => readRepo(`web/telegram-tt/src/publicLink/${file}`)).join('\n');
    r.anonMethods.forEach((name) => expect(page).toContain(`'${name}'`));
    r.ownerMethods.forEach((name) => expect(page).not.toContain(name));
    expect(readRepo('backend/infra/deploy/Caddyfile')).toContain(r.pagePath);
  });

  it('desktop и android: методы ссылок не вызываются', () => {
    const core = readRepo('desktop/parvane-core/src/v2_account.cpp');
    // android (spec 031): «Облако» есть (хаб разделов ядра и экраны оверлея), ссылок для людей без аккаунта — нет
    const android = [
      readAndroidJni(),
      readRepo('android/libtd/src/main/java/org/parvane/core/ParvaneSections.kt'),
      readRepo(`${ANDROID_SECTIONS_DIR}/CloudController.kt`),
    ].join('\n');
    [...r.ownerMethods, ...r.anonMethods].forEach((name) => {
      expect(core).not.toContain(name);
      expect(android).not.toContain(name);
    });
  });
});

describe('ORDER-1: живое сообщение встаёт после всего, что уже есть в чате', () => {
  const r = rule('ORDER-1') as unknown as {
    liveWindowSecs: number;
    orderField: string;
    clients: { web: string; desktop: string; android: string };
  };

  it('web: окно «живого», сохранение места и порядок восстановления', () => {
    const store = readRepo('web/telegram-tt/src/api/parvane/store.ts');
    expect(store).toContain(`const LIVE_ORDER_WINDOW_SECS = ${r.liveWindowSecs};`);
    expect(store).toContain('export function compareStoredOrder(');
    const sync = readRepo('web/telegram-tt/src/api/parvane/sync.ts');
    expect(sync).toContain(`{ ...stored, ${r.orderField}: message.id }`);
    expect(sync).toContain('records.concat(savedNotes).sort(compareStoredOrder)');
    const messages = readRepo('web/telegram-tt/src/api/parvane/messages.ts');
    expect(messages).toContain(`${r.orderField}: localMessage.id,`);
    expect(readRepo('web/telegram-tt/src/api/parvane/wire.ts')).toContain(`${r.orderField}?: number;`);
  });

  // spec 029: desktop ставит сообщения по порядку прихода — id выдаётся счётчиком, а не из
  // времени отправителя (лента tdesktop упорядочена по id); место сохраняет журнал истории
  it('desktop: id по порядку прихода, место — порядком строк журнала истории', () => {
    const desktop = readDesktopSource();
    expect(desktop).toContain('qint64 g_nextMsgId = 1;');
    // Счётчик только растёт: других присваиваний нет, id сообщения не выводится из `ts`
    expect(desktop.match(/g_nextMsgId\s*=[^=]/g) || []).toHaveLength(1);
    expect((desktop.match(/MsgId\(g_nextMsgId\+\+\)/g) || []).length).toBeGreaterThan(5);
    expect(desktop).not.toMatch(/MsgId\([^)]*\.ts\b/);
    const inject = desktop.slice(desktop.indexOf('void injectOnMain(\n\t\tnot_null<Main::Session*> session,'));
    expect(inject).toContain('const auto msgId = MsgId(g_nextMsgId++);');
    // Журнал истории — в порядке вставки, воспроизводится тем же порядком (без сортировки); только строка старше
    // показанных больше чем на окно «живого» сообщения (перенос истории) встаёт по времени (spec 030)
    const replay = desktop.slice(desktop.indexOf('void ReplayHistory() {'));
    const replayBody = replay.slice(0, replay.indexOf('\n}\n'));
    expect(replayBody).toContain('for (const auto &line : StoreReadLines(HistoryPath())) {');
    expect(replayBody).not.toMatch(/sort\(/);
    expect(r.clients.desktop).not.toContain('ОТКРЫТО');
    expect(r.clients.desktop).toContain('g_nextMsgId');
  });

  // spec 031: android, как desktop, — id по порядку прихода (шов), журнал истории в порядке записи;
  // только строка старше показанных больше чем на окно «живого» встаёт по времени
  it('android: id по порядку прихода, место — порядком строк журнала истории', () => {
    const store = readAndroidKt('ParvaneStore.kt');
    expect(store).toContain('val msgId = nextMessageId++ shl 20');
    expect(store.match(/nextMessageId\s*=[^=]/g) || []).toHaveLength(1);
    const main = readAndroidJni('jni_main.cpp');
    expect(main).toContain(`constexpr std::int64_t kLiveWindowSecs = ${r.liveWindowSecs};`);
    const fold = main.slice(main.indexOf('std::vector<json> journalFoldLocked() {'));
    const foldBody = fold.slice(0, fold.indexOf('\n}\n'));
    expect(foldBody).toContain('placeByTime(out);');
    expect(foldBody).not.toMatch(/sort\(/);
    const place = main.slice(main.indexOf('void placeByTime(std::vector<json> &msgs) {'));
    expect(place.slice(0, place.indexOf('\n}\n'))).not.toMatch(/sort\(/);
    expect(r.clients.android).not.toContain('ОТКРЫТО');
    expect(r.clients.android).toContain('placeByTime');
  });
});

describe('RECOVER-2: новое устройство по ключу восстановления входит без других устройств', () => {
  const r = rule('RECOVER-2') as unknown as {
    bundleField: string;
    bundleMagic: string;
    bundleKdfSalt: string;
    grantBundleKeyField: string;
    methods: string[];
    clients: { web: string; desktop: string; android: string };
  };

  it('web: формат копии ключей и вход по ней', () => {
    const bundle = readRepo('web/telegram-tt/src/api/parvane/v2/keyBundle.ts');
    const magic = Array.from(r.bundleMagic, (char) => `0x${char.charCodeAt(0).toString(16)}`).join(', ');
    expect(bundle).toContain(`const MAGIC = [${magic}];`);
    expect(bundle).toContain(`const SALT = '${r.bundleKdfSalt}';`);
    expect(bundle).toContain(`material.${r.grantBundleKeyField} = bundleKeyB64;`);
    const controller = readRepo('web/telegram-tt/src/api/parvane/v2/controller.ts');
    expect(controller).toContain(`JSON.stringify({ ${r.bundleField}: b64(sealed) })`);
    // Вход по ключу — материалом привязки из копии, а не отзывом прежних устройств
    expect(controller).toContain('withBundleKey(withFreshLog(unb64(payload.grant), ownLog), b64(bundleKey))');
    // Привязка переживает обрыв: состояние движка с запросом — в хранилище до ответа сервера
    expect(controller).toContain('await storage.saveRecord(PENDING_JOIN_RECORD, join);');
    expect(controller).toContain('const probe = client.otkRequest(OTK_COUNT) as OutReq;');
  });

  it('методы ключа восстановления через Telegram есть в схеме, сервере, боте и web', () => {
    const proto = readRepo('proto/parvane/identity/v2/identity.proto');
    const identity = readRepo('backend/shards/identity/src/v2.rs');
    r.methods.forEach((method) => {
      expect(proto, method).toContain(`name: "${method}"`);
      expect(identity, method).toContain(`"${method}" =>`);
    });
    expect(proto).toContain(`bytes ${r.bundleField} = 3`);
    const bot = readRepo('backend/infra/telegram-bot/parvane_tg_bot.py');
    const controller = readRepo('web/telegram-tt/src/api/parvane/v2/controller.ts');
    r.methods.forEach((method) => {
      if (method.startsWith('identity.telegram.')) expect(bot, method).toContain(`"${method}"`);
      else expect(controller, method).toContain(`'${method}'`);
    });
    // Ключ восстановления в базу identity не пишется: очередь бота и ответы — в памяти
    const queue = readRepo('backend/shards/identity/src/recovery_tg.rs');
    expect(queue).not.toMatch(/sqlx::|INSERT |SqlitePool/);
  });

  // spec 029: desktop входит по копии ключей аккаунта (тот же формат, что web), прежние устройства остаются
  it('desktop: копия ключей и вход по ней', () => {
    const bundle = readRepo('desktop/parvane-core/src/keybundle.cpp');
    expect(bundle).toContain(`"${r.bundleKdfSalt}"`);
    const session = readDesktopSession();
    expect(session).toContain('KeyJoinOutcome Session::joinWithRecoveryKey(');
    expect(session).toContain(`json{{"${r.bundleField}", toBase64(sealed)}}`);
    r.methods.filter((method) => method.startsWith('identity.recovery.'))
      .forEach((method) => expect(session, method).toContain(`"${method}"`));
    expect(readRepo('desktop/parvane-core/tests/webcompat_tests.cpp')).toContain('static void keyBundle() {');
    expect(readRepo('desktop/parvane-core/tests/v2_session_tests.cpp'))
      .toContain('spec 015: прежнее устройство осталось в журнале');
    expect(r.clients.desktop).not.toContain('ОТКРЫТО');
  });

  // spec 031: android входит по копии ключей аккаунта (то же ядро, что desktop), ключ — ответом боту Telegram
  it('android: вход по ключу через копию ключей, Telegram, снимок истории', () => {
    const account = readAndroidJni('jni_account.cpp');
    expect(account).toContain('const auto requested = s->requestTelegramKey(again == JNI_TRUE);');
    expect(account).toContain('const auto reply = s->pollTelegramKey(false);');
    expect(account).toContain('auto outcome = s->joinWithRecoveryKey(key, true);');
    expect(account)
      .toContain('auto outcome = s->joinWithRecoveryKey(parvane::keybundle::pickRecoveryKey(jstr(env, key)), false);');
    // Копия ключей: снимок истории пишет и читает шов, ключи разделов — из копии
    expect(account).toContain('const auto bundle = s->fetchKeyBundle();');
    expect(account).toContain('const auto mark = parvane::keybundle::digestHex(exportJson);');
    expect(readAndroidJni('jni_session.cpp')).toContain(
      'cfg.bundleHistory = [](const json &previous, bool force) { return bundleHistory(previous, force); };',
    );
    expect(readAndroidKt('Client.kt'))
      .toMatch(/"needs_linking" -> \{[\s\S]{0,200}ParvaneCore\.telegramRecovery\(false\)/);
    expect(r.clients.android).not.toContain('ОТКРЫТО');
  });
});

// Прод, 5–10 окт 2026: шард call читал PARVANE_DOMAIN, а compose его не задавал — шард считал домен
// `local` и отклонял все сигналы звонков v2 (FEDERATION_UNAVAILABLE); локально домен и есть `local`,
// поэтому сценарии были зелёными
describe('деплой: каждый шард, читающий домен сервера, получает его в compose', () => {
  it.each(['identity', 'messenger', 'call', 'domains'])('%s', (shard) => {
    const sources = shard === 'identity' ? ['main.rs'] : shard === 'domains' ? ['store.rs'] : ['v2.rs'];
    expect(sources.some((file) => readRepo(`backend/shards/${shard}/src/${file}`).includes('"PARVANE_DOMAIN"')))
      .toBe(true);
    const compose = readRepo('backend/infra/deploy/docker-compose.yml');
    const start = compose.indexOf(`\n  ${shard}:\n`);
    expect(start).toBeGreaterThan(0);
    const next = compose.slice(start + 1).search(/\n {2}[a-z-]+:\n/);
    const service = compose.slice(start, next < 0 ? undefined : start + 1 + next);
    expect(service, `сервис ${shard} в docker-compose.yml`).toContain('PARVANE_DOMAIN:');
  });
});

describe('FED-1: федерация — запрос объекту чужого сервера идёт своему серверу с dest_domain', () => {
  const r = rule('FED-1') as unknown as {
    fields: Record<string, number>;
    errors: string[];
    clients: { web: string; desktop: string; android: string };
  };

  it('схема: адресат запроса, флаг реестра, домены блобов, точка входа сервера, коды отказов', () => {
    expect(readRepo('proto/parvane/core/v2/frame.proto'))
      .toContain(`string dest_domain = ${r.fields.request_dest_domain} `);
    expect(readRepo('proto/parvane/core/v2/registry.proto'))
      .toContain(`bool federated = ${r.fields.method_spec_federated};`);
    const content = readRepo('proto/parvane/msg/v2/content.proto');
    expect(content).toContain(`string blob_domain = ${r.fields.media_blob_domain} `);
    expect(content).toContain(`string blob_domain = ${r.fields.pack_ref_blob_domain} `);
    expect(readRepo('proto/parvane/group/v2/group.proto'))
      .toContain(`string avatar_domain = ${r.fields.set_info_avatar_domain} `);
    expect(readRepo('proto/parvane/core/v2/envelope.proto'))
      .toContain(`string s2s_endpoint = ${r.fields.server_descriptor_s2s_endpoint} `);
    const errors = readRepo('proto/parvane/core/v2/errors.proto');
    r.errors.forEach((code) => expect(errors).toContain(`${code} =`));
  });

  it('web: адресат по домену, причины отказа в обоих языках, тестовый транспорт не в образе', () => {
    const address = readRepo('web/telegram-tt/src/api/parvane/v2/address.ts');
    ['export function destFor(', 'export function federationReason('].forEach((f) => expect(address).toContain(f));
    const controller = readRepo('web/telegram-tt/src/api/parvane/v2/controller.ts');
    ['function groupDomainOf(', 'async function requestForeignTokens(', 'function setBlobDomain(']
      .forEach((f) => expect(controller).toContain(f));
    const en = readRepo('web/telegram-tt/src/assets/localization/fallback.strings');
    const ru = readRepo('web/telegram-tt/src/assets/localization/ru.strings');
    ['ParvaneFederationDisabled', 'ParvaneFederationDomainBlocked', 'ParvaneFederationRefused',
      'ParvaneFederationUnreachable', 'ParvaneFederationKeyChanged'].forEach((key) => {
      expect(en).toContain(`"${key}" =`);
      expect(ru).toContain(`"${key}" =`);
    });
    expect(readRepo('backend/infra/deploy/Dockerfile.shards')).not.toContain('insecure-test-transport');
    expect(r.clients.web).toContain('run_web_federation_e2e.sh');
    expect(r.clients.desktop).not.toContain('ОТКРЫТО');
  });

  // spec 031: адресат запросов — общее ядро (те же v2_session/v2_account/Control, что desktop); причины отказа строками
  // и сценарий двух серверов на эмуляторе — не сделаны (отмечено в правиле)
  it('android: запросы чужим серверам — ядром, профиль адреса чужого сервера — у его сервера', () => {
    // Ядро android — ровно те же исходники parvane_core, что desktop (сторож tools/check_core_sources.sh)
    const coreSources = (file: string) => {
      const text = readRepo(file);
      const start = text.indexOf('add_library(parvane_core STATIC');
      return (text.slice(start, text.indexOf(')', start)).match(/src\/[a-z0-9_/]+\.cpp/g) || []).sort();
    };
    const desktopCore = coreSources('desktop/parvane-core/CMakeLists.txt');
    expect(desktopCore).toContain('src/v2_session.cpp');
    expect(coreSources('android/jni/CMakeLists.txt')).toEqual(desktopCore);
    const account = readAndroidJni('jni_account.cpp');
    expect(account).toContain('parvane::v2::account::resolveProfiles(*c, addresses, &federationError)');
    expect(account).toContain('out["federation_error"] = federationError;');
    expect(account).toContain('noteFederationFailure(federationError);');
    expect(r.clients.android).not.toContain('ОТКРЫТО');
    expect(r.clients.android).toContain('tgx_federation_flow.sh');
    expect(r.clients.android).toContain('resolveProfiles');
  });

  it('desktop: сценарий двух серверов есть (прогон — после линковки)', () => {
    expect(r.clients.desktop).toContain('desktop/verify_federation.sh');
    const scenario = readRepo('desktop/verify_federation.sh');
    ['server_a()', 'server_b()', 'PV_FEDERATION_PEERS=', 'PARVANE_AUTOSEND=$B_USER', 'PARVANE_AUTOSEND=$A_USER']
      .forEach((s) => expect(scenario).toContain(s));
    const lib = readRepo('desktop/verify_lib.sh');
    ['PV_NATS_PORT:-4222', 'PV_GW_TCP_PORT:-9223', 'PARVANE_FEDERATION_ENDPOINTS="$']
      .forEach((s) => expect(lib).toContain(s));
  });
});

describe('PACK-2: один набор стикеров от разных отправителей — один набор', () => {
  const r = rule('PACK-2') as unknown as {
    fields: Record<string, number>;
    clients: { web: string; desktop: string; android: string };
  };

  it('схема: отпечаток содержимого в ссылке на набор', () => {
    expect(readRepo('proto/parvane/msg/v2/content.proto'))
      .toContain(`bytes content_hash = ${r.fields.pack_ref_content_hash} `);
  });

  it('web и desktop считают отпечаток одним алгоритмом (общий вектор), desktop сверяет архив', () => {
    expect(readRepo('web/telegram-tt/src/api/parvane/stickerPacks.ts'))
      .toContain('export async function packContentHash(');
    expect(readRepo('web/telegram-tt/src/api/parvane/clientVectors.test.ts'))
      .toContain('vectorPath(\'pack-hash.json\')');
    expect(readRepo('proto/parvane/vectors/clients/pack-hash.json')).toContain('"content_hash"');
    const core = readRepo('desktop/parvane-core/src/pack_archive.cpp');
    ['std::string contentHash(', 'bool archiveMatchesContentHash('].forEach((f) => expect(core).toContain(f));
    const content = readRepo('desktop/parvane-core/src/v2_content.cpp');
    expect(content).toContain('o["content_hash"] = str(p, "content_hash")');
    expect(content).toContain('out["content_hash"] = contentHash');
    const client = readDesktopSource();
    ['AttachPackContentHash(ref, archive)', 'FindInstalledPackByHash(root, contentHash)',
      'parvane::pack::archiveMatchesContentHash(bytes, contentHash)',
      'parvane::pack::archiveMatchesContentHash(*dec, contentHash)'].forEach((s) => expect(client).toContain(s));
    expect(readRepo('desktop/parvane-core/tests/webcompat_tests.cpp')).toContain('vectorPath("pack-hash.json")');
    expect(r.clients.desktop).not.toContain('ОТКРЫТО');
  });

  // spec 031: android кладёт отпечаток в ссылку при отправке и разводит одноимённые наборы с разным
  // отпечатком; сверки скачанного архива и поиска того же набора под другим именем нет (отмечено в правиле)
  it('android: отпечаток в ссылке на набор, одноимённые наборы с разным отпечатком — разные каталоги', () => {
    const messages = readAndroidJni('jni_messages.cpp');
    expect(messages).toContain('const auto hash = parvane::pack::archiveContentHashB64(archive);');
    expect(messages)
      .toContain('out = json{{"name", raw}, {"key", enc.keyB64}, {"nonce", enc.nonceB64}, {"content_hash", hash}};');
    expect(messages).toContain('const auto wantHash = ref.contains("content_hash") && ref["content_hash"].is_string()');
    expect(messages).toContain('parvane::pack::archiveMatchesContentHash(*dec, wantHash)');
    expect(messages).toContain('findInstalledPackByHash(root, wantHash)');
    expect(messages)
      .toContain('dir = root + "/" + parvane::pack::sanitizeName(raw.substr(0, 25) + " " + hashTag(wantHash));');
    expect(messages).toContain('Java_org_parvane_core_ParvaneCore_nativePackHash');
    expect(r.clients.android).not.toContain('ОТКРЫТО');
    expect(r.clients.android).toContain('hashTag');
  });
});
