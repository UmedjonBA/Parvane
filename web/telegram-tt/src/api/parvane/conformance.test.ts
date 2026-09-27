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
    forbiddenHosts?: string[];
    noticeField?: string;
    changes?: string[];
    contentKinds?: Record<string, string[]>;
    clients?: { web: string; desktop: string | string[]; android: string };
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
