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
    const block = webSync.slice(idx, idx + 400);
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
    expect(client.slice(uk, uk + 400)).toMatch(/continue;/);
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
