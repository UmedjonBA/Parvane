/* tslint:disable */
/* eslint-disable */

/**
 * C2-01 (D-05, инв. 25): какое анонимное соединение взять для запроса
 * `chan == "anon"`. Правила: соединение — только одному получателю
 * (пользователю или группе) и только в серии ≤ 60 с с открытия; копия своим
 * устройствам — отдельный получатель (своё соединение); публичные запросы
 * (журналы, бандлы, ключи жетонов) — всегда новое одноразовое соединение.
 */
export class PvAnonPlanner {
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Запрос (метод + тело из OutRequest) → `{conn, open, closeAfter}`:
     * `open` — открыть новое ANONYMOUS_DELIVERY-соединение под номером
     * `conn`, `closeAfter` — закрыть сразу после ответа.
     */
    assign(method: string, body: Uint8Array, now_ms: number): any;
    /**
     * Соединение закрылось (обрыв/таймаут) — больше не выдавать.
     */
    closed(conn: number): void;
    /**
     * Соединения, серия которых истекла, — закрыть (номера).
     */
    expired(now_ms: number): Float64Array;
    constructor();
    openCount(): number;
}

/**
 * Клиентское ядро устройства.
 */
export class PvClient {
    free(): void;
    [Symbol.dispose](): void;
    /**
     * KEY-1 v2: принять смену корня собеседника (после предупреждения).
     */
    acceptRootChange(user: string): boolean;
    ackRequest(): any;
    /**
     * Первое устройство: корень, генезис, сертификат, прекеи, ключ доставки.
     * Возвращает {requests, rootSecret} — корень для резервной копии.
     */
    createIdentity(otk_count: number): any;
    /**
     * Курсор журнала (применено до seq включительно).
     */
    cursor(): bigint;
    /**
     * Сервер отверг ключ доступа собеседника (FORBIDDEN на доставке): он сменил
     * ключ (отзыв устройства, восстановление) — дальше слепым жетоном. true —
     * ключ был и сброшен (отправку стоит повторить).
     */
    deliveryKeyRejected(peer: string): boolean;
    drainReady(): string;
    /**
     * Первое устройство без ключа личного состояния — создать (версия 1).
     */
    ensureStateKey(): boolean;
    /**
     * Событие подписки `ephemeral` → JSON-массив событий `typing`/`presence`.
     */
    ephOpen(body: Uint8Array): string;
    /**
     * Своё присутствие → запросы (пусто — L2 активен в каком-то чате).
     */
    ephPresence(online: boolean, last_seen_ms: number): Array<any>;
    /**
     * Соединение пересоздано — подписок на эфемерные каналы больше нет.
     */
    ephReset(): void;
    /**
     * Подписаться на каналы чатов `{"peers":[адрес…],"groups":[hex…]}` →
     * запросы `ephemeral.subscribe` (только новые каналы).
     */
    ephSubscribe(chats_json: string): Array<any>;
    /**
     * «Печатает»: `chat` — адрес собеседника либо hex группы, `action` — номер
     * `TypingAction`. Запросы (пусто — канала нет или чат в L2).
     */
    ephTyping(chat: string, action: number): Array<any>;
    /**
     * Экспорт состояния (шифруется ключом хранилища, 32 байта).
     */
    export(key: Uint8Array): Uint8Array;
    /**
     * C1-06: резервная копия корня под ключом восстановления (строка из
     * `generateRecoveryKey()`, ≥ 128 бит; парольной фразы нет). Корень — из
     * памяти (после createIdentity/importRootBackup) или `rootSecret`.
     * Возвращает байты копии; после подтверждения копии — `forgetRoot()` и
     * удалить корень из хранилища хоста.
     */
    exportRootBackup(recovery_key: string, root_secret?: Uint8Array | null): Uint8Array;
    /**
     * Копия корня для администратора сервера: корень — из памяти (после
     * createIdentity/importRootBackup) или `rootSecret`, запечатывается открытым
     * ключом администратора (32 байта из `server.describe`).
     */
    exportRootEscrow(escrow_public: Uint8Array, root_secret?: Uint8Array | null): Uint8Array;
    /**
     * Стереть корень из памяти движка.
     */
    forgetRoot(): void;
    /**
     * D-03 (C1-03): версия журнала группы, на которую сослался участник, а у
     * нас её нет (undefined — не отстаём). Пока отстаём, prepareGroup и
     * groupRotateEpoch отказывают need groupLog.
     */
    groupBehind(group: string): bigint | undefined;
    /**
     * Изменение группы: proto3-JSON `group.v2.GroupChange`.
     */
    groupChange(group: string, change_json: string): any;
    /**
     * Создать группу → {group: {domain, id}, request}.
     */
    groupCreate(kind: number, name: string, members: string[], perms_json: string, migrated_from?: string | null): any;
    /**
     * Забыть журнал группы (запись отвергнута сервером — перечитать с начала).
     */
    groupForget(group: string): void;
    /**
     * Состояние группы (JSON: участники, роли, права, эпоха).
     */
    groupInfo(group: string): string;
    /**
     * Ответ `group.state.sync` → версия после применения.
     */
    groupIngest(domain: string, group: string, sync_response: Uint8Array): bigint;
    /**
     * Новая ссылка-приглашение → {request, url} (секрет — только в url).
     */
    groupInviteCreate(group: string, title: string, expires_ms: number, usage_limit: number, requires_approval: boolean): any;
    /**
     * Вступить по ссылке v2 (журнал группы уже принят groupIngest) → запрос `group.join`.
     */
    groupJoin(url: string): any;
    /**
     * Группы, журнал которых известен устройству (hex id).
     */
    groupList(): string[];
    /**
     * Решение по заявке на вступление (одобрение — запись `AddMember`).
     */
    groupRequestDecide(group: string, user: string, approve: boolean): any;
    groupRotateEpoch(group: string): Array<any>;
    /**
     * FR-028 (T080): участники по данным сервера (`claimed`) без
     * подтверждённой записи журнала + добавленные отвергнутыми записями.
     */
    groupUnconfirmed(group: string, claimed: string[]): string[];
    groupVersion(group: string): bigint;
    /**
     * Известен ли ключ доступа собеседника: сигнал звонка сервер принимает
     * только с ним (слепой жетон для звонков не годится).
     */
    hasPeerDeliveryKey(peer: string): boolean;
    /**
     * Корень в памяти движка есть.
     */
    hasRoot(): boolean;
    /**
     * Ключ личного состояния есть (свой или от другого своего устройства).
     */
    hasStateKey(): boolean;
    /**
     * Восстановить корень из копии (сверяется с журналом устройств); корень
     * остаётся в памяти до `forgetRoot()` и возвращается хосту.
     */
    importRootBackup(blob: Uint8Array, recovery_key: string): Uint8Array;
    /**
     * Корень из копии под ключом восстановления на устройстве БЕЗ журнала
     * (восстановление): сверка с журналом — в `recoverWithRoot`. Корень
     * остаётся в памяти до `forgetRoot()`.
     */
    importRootBackupFor(blob: Uint8Array, recovery_key: string): void;
    /**
     * Восстановить из зашифрованного состояния.
     */
    static importState(blob: Uint8Array, key: Uint8Array): PvClient;
    /**
     * Ответ `identity.device.fetch_bundle_anon` → число открытых сессий.
     */
    ingestBundle(user: string, bundle_response: Uint8Array): number;
    /**
     * Ответ `identity.device.log_sync(_anon)` → вердикт "new" | "known" |
     * "rootChanged" (KEY-1: показать предупреждение и `acceptRootChange`) |
     * "replaced" (журнал на сервере начат заново — перечитать с версии 0).
     */
    ingestLog(user: string, sync_response: Uint8Array): string;
    /**
     * Новое устройство после линковки: материал гранта (см. linkGrantMaterial).
     */
    joinWithGrant(material: Uint8Array, otk_count: number): Array<any>;
    /**
     * Состояние L2 личного чата: JSON
     * `{active, mine, enabledBy: [адреса], pad, ephemeralAllowed}`.
     */
    l2Direct(peer: string): string;
    /**
     * Состояние L2 группы (тот же JSON): политика журнала группы (меняется
     * `groupChange` с `{"set_privacy_mode":{"l2":true}}`) + личное предпочтение.
     */
    l2Group(group: string): string;
    /**
     * Включить/выключить L2 в личном чате: запросы как у `prepareDirect`
     * (операция `ChatMode` собеседнику и своим устройствам); `op_id` — id
     * служебного сообщения в UI или пусто.
     */
    l2SetDirect(peer: string, enabled: boolean, op_id: string): Array<any>;
    /**
     * Личное предпочтение L2 в группе (свои исходящие выравниваются).
     */
    l2SetGroupPref(group: string, enabled: boolean): void;
    lastError(): string | undefined;
    /**
     * Выход: запрос с записью журнала, которой устройство убирает само себя
     * (подписана ключом устройства — оставшимся смена SSK не нужна).
     */
    leave(): Array<any>;
    /**
     * Запрос `msg.deliver_legacy` (FR-054): v1 `SendPayload` (JSON) с копиями
     * для v1-устройств из подписанных списков собеседника и своего.
     */
    legacyDeliverRequest(message_id: string, send_payload_json: string): any;
    /**
     * Опубликовать/сократить свой список v1-устройств (FR-058): JSON
     * `[{"deviceId","identity","signing"}]` → запрос `identity.device.log_append`.
     * Первая публикация задаёт список, дальше он только сокращается.
     */
    legacyDevicesRequest(devices_json: string): any;
    /**
     * Материал гранта линковки: JSON {ssk, entries[], deliveryKey, gen} (hex/байты).
     */
    linkGrantMaterial(): Uint8Array;
    /**
     * Устройства пользователя по журналу (JSON `{"v2": [...], "legacy": [...]}`).
     */
    logDevices(user: string): string;
    logVersion(user: string): bigint;
    /**
     * Новое устройство.
     */
    constructor(user: string, device_id: string, domain: string);
    /**
     * Открыть запись журнала инбокса → JSON-массив событий.
     */
    openRecord(record: Uint8Array): string;
    otkRequest(n: number): any;
    /**
     * Свой SSK раскрыт (отозвано державшее его устройство) и ещё не сменён.
     */
    ownSskExposed(): boolean;
    /**
     * Повторно применить помеченную операцию из очереди отправки (после перезапуска).
     */
    plannerApplyLocal(op: Uint8Array): number;
    /**
     * Подключить контейнер: ответы `domain.container.get` и `domain.grant.list`.
     */
    plannerAttach(get_response: Uint8Array, grants_response: Uint8Array): void;
    /**
     * Контейнер планировщика → {domain, id(hex)} | undefined.
     */
    plannerContainer(): any;
    /**
     * Создать контейнер → запрос `domain.container.create`.
     */
    plannerCreate(ts_ms: number): any;
    plannerHasKey(): boolean;
    plannerHeadSeq(): number;
    /**
     * Догнать журнал грантов (смена эпохи) → версия журнала грантов.
     */
    plannerIngestGrants(grants_response: Uint8Array): number;
    /**
     * Снимок `domain.snapshot.get` → курсор после слияния.
     */
    plannerIngestSnapshot(snapshot_response: Uint8Array): number;
    /**
     * Страница `domain.op.sync` → {applied, headSeq, more, missingEpoch?, grantsBehind}.
     */
    plannerIngestSync(sync_response: Uint8Array): any;
    plannerIsAttached(): boolean;
    /**
     * Ключи контейнера для экспорта линковки (JSON) | undefined.
     */
    plannerKeysExport(): string | undefined;
    /**
     * Ключи контейнера из экспорта линковки своего устройства.
     */
    plannerKeysImport(json: string): void;
    /**
     * Локальная правка (JSON изменений) → {opId(hex), op(Uint8Array), applied}.
     */
    plannerPrepareLocal(changes_json: string): any;
    /**
     * Зашифровать операцию → запрос `domain.op.append` (тот же opId при повторе).
     */
    plannerSeal(op: Uint8Array, op_id_hex: string, ts_ms: number): any;
    /**
     * Размер открытого текста снимка (байты).
     */
    plannerSize(): number;
    /**
     * Снимок по порогу → запрос `domain.snapshot.put` | undefined.
     */
    plannerSnapshotRequest(ts_ms: number): any;
    /**
     * Сведённое состояние (JSON, только живые объекты) | undefined.
     */
    plannerStateJson(): string | undefined;
    /**
     * Сигнал звонка собеседнику (D-08): `signal_json` — proto3-JSON
     * `call.v2.CallSignal`; оффер уходит методом `call.ring_sealed`, остальное —
     * `call.signal_sealed`, оба анонимным каналом.
     */
    prepareCall(peer: string, signal_json: string): Array<any>;
    /**
     * Личное сообщение: содержимое — proto3-JSON `msg.v2.Content`;
     * `op_id` — UUID сообщения хоста (строка) или пусто.
     */
    prepareDirect(peer: string, content_json: string, op_id: string): Array<any>;
    prepareGroup(group: string, content_json: string, op_id: string): Array<any>;
    /**
     * Публиковать ли своё присутствие: false, пока L2 активен хотя бы в одном чате.
     */
    presenceAllowed(): boolean;
    /**
     * Кто прочитал своё сообщение (по E2E-квитанциям) — JSON-массив
     * `[{"user","tsMs"}]`. Серверу v2 это неизвестно («Просмотрено», T151).
     */
    readers(id: string): string;
    /**
     * T130: восстановление на новом устройстве по корню (в памяти после
     * `importRootBackupFor`); `log_response` — ответ `identity.device.log_sync`
     * с версии 0. Запросы выполнять по порядку.
     */
    recoverWithRoot(log_response: Uint8Array, otk_count: number): Array<any>;
    /**
     * T130: сброс личности — новый корень взамен прежнего. Как
     * `createIdentity`; первый запрос — `identity.root.rotate` (нужна свежая
     * переаутентификация).
     */
    resetIdentity(otk_count: number): any;
    /**
     * Отозвать ключ доступа у собеседника (FR-033; блокировка) →
     * `{requests, pendingKeyShares: [адрес]}`; пустой `requests` — ключа у
     * собеседника не было.
     */
    revokeContactAccess(peer: string): any;
    /**
     * Отозвать своё другое устройство и выполнить последствия →
     * `{requests, pendingKeyShares: [адрес], pendingEpochs: [hex],
     * epochsNeedAdmin: [hex], sskRotationRequired, stateKeyVersion?}`. Первый
     * запрос — запись журнала (обязателен), остальные — ротации ключей.
     */
    revokeDevice(device_id: string): any;
    /**
     * Сменить SSK корнем (D-12): корень — в памяти после `importRootBackup`;
     * после успеха хост зовёт `forgetRoot()`.
     */
    rotateSsk(): Array<any>;
    /**
     * ID-01: доказательство устройства для `identity.session.issue`
     * (`ts_ms` — миллисекунды Unix, как `Date.now()`).
     */
    sessionProof(ts_ms: number): Uint8Array;
    setPeerDeliveryKey(user: string, key: Uint8Array, generation: bigint): void;
    /**
     * Раздать текущий ключ доступа собеседнику (отложенное после отзыва).
     */
    shareDeliveryKey(peer: string): Array<any>;
    /**
     * Группы v2 — своим новым устройствам (T142): ключи текущей эпохи и
     * входящие сессии Megolm. `devices_json` — JSON-массив id устройств.
     */
    shareGroupsWithOwnDevices(devices_json: string): Array<any>;
    /**
     * Секреты своих ссылок-приглашений — другим ведущим приглашения группы:
     * `links_json`, `recipients_json` — JSON-массивы ссылок и адресов.
     */
    shareInviteLinks(group_hex: string, links_json: string, recipients_json: string): Array<any>;
    /**
     * Ключ текущей эпохи — своим устройствам (`msg.deliver_sealed`).
     */
    sharePlannerWithOwnDevices(): Array<any>;
    /**
     * Сессия журнала личного состояния на текущем ключе (undefined — ключа нет).
     */
    stateSession(): PvState | undefined;
    syncRequest(): any;
    /**
     * Принятые секреты ссылок-приглашений: JSON `[{"group": hex, "url": …}]`.
     */
    takeSharedInvites(): string;
    /**
     * Размер партии — вся суточная квота.
     */
    tokenBatchSize(): number;
    tokenCount(): number;
    /**
     * Пора получать суточную партию жетонов (FR-063: по расписанию, не перед
     * тратой).
     */
    tokenRefillDue(): boolean;
    /**
     * Запрос жетонов: ответ `identity.tokens.key_list` (анонимно) + ключ сервера.
     */
    tokenRequest(key_list_response: Uint8Array, server_key: Uint8Array, count: number): any;
    tokenResponse(resp: Uint8Array): number;
}

/**
 * Журнал личного состояния устройства (R10, T098): сведение LWW (STATE-1),
 * шифрование записей ключом личного состояния из клиента (ключ не выходит
 * в JS). Курсор — в памяти: при запуске журнал читается с начала.
 */
export class PvState {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    callSet(record_json: string): Array<any>;
    /**
     * Чат очищен «у себя» до момента (T145): proto3-JSON `state.v1.ChatCleared`
     * → тела `state.append`. Граница по собеседнику только растёт.
     */
    chatCleared(cleared_json: string): Array<any>;
    /**
     * Отложенные, которые ЭТО устройство отправляет сейчас (proto3-JSON
     * `ScheduledMessage[]`); отправлять с op_id отложенного, затем `markSent`.
     */
    claimDue(now_ms: number): string;
    /**
     * Хост хочет состояние `desired_json` (StateSnapshot) по видам `kinds`:
     * операции разницы применяются локально, наружу — тела `state.append`.
     */
    diff(desired_json: string, kinds: string[]): Array<any>;
    /**
     * Ссылка снята (отозвана или удалена): `link_id` — base64.
     */
    groupInviteRemove(link_id_b64: string): Array<any>;
    /**
     * Ссылка-приглашение группы v2 (T160): proto3-JSON `state.v1.GroupInvite`
     * → тела `state.append`. LWW по `link_id`.
     */
    groupInviteSet(invite_json: string): Array<any>;
    /**
     * Ответ `state.sync` → JSON `{more, applied, rejected}`. Нерасшифрованные
     * (чужой ключ) и отвергнутые записи пропускаются — одинаково везде.
     */
    ingest(resp: Uint8Array): string;
    loadSentGuard(ids: string[]): void;
    /**
     * Отметка «отложенное отправлено» (op_id — base64 из снимка).
     */
    markSent(op_id_b64: string): Array<any>;
    /**
     * Первый запуск: локальные данные (StateSnapshot) → начальные операции.
     */
    migrate(local_json: string): Array<any>;
    /**
     * Запись истории звонков (D-08: сервер её не ведёт): proto3-JSON
     * `state.v1.CallRecord` → тела `state.append`. LWW по `call_id`.
     * Контейнер планировщика (spec 010): домен и hex id → тела `state.append`.
     */
    plannerContainerSet(domain: string, id_hex: string): Array<any>;
    /**
     * Локальный журнал уже отправленных этим устройством (hex; хранит хост).
     */
    sentGuard(): string[];
    /**
     * Сведённое состояние: proto3-JSON `state.v1.StateSnapshot`.
     */
    snapshot(): string;
    /**
     * Тело `state.sync` от курсора.
     */
    syncRequest(): Uint8Array;
}

/**
 * Разобрать кадр сервера → объект {kind, …} (тела — Uint8Array).
 */
export function decodeFrame(bytes: Uint8Array): any;

/**
 * Байты ответа → proto3-JSON по полному имени типа.
 */
export function decodeMessage(type_name: string, bytes: Uint8Array): string;

/**
 * Ответ любого метода реестра → proto3-JSON (T161).
 */
export function decodeMethodResponse(method: string, bytes: Uint8Array): string;

/**
 * Число записей в ответе журнала устройств (0 — у пользователя нет v2).
 */
export function deviceLogEntries(bytes: Uint8Array): number;

export function encodeAuth(token: string): Uint8Array;

/**
 * Hello: channel 1 — идентифицированный, 2 — анонимная доставка.
 */
export function encodeHello(channel: number, client_kind: string, client_version: string): Uint8Array;

/**
 * proto3-JSON → байты сообщения по полному имени типа (тела запросов из JS).
 */
export function encodeMessage(type_name: string, json: string): Uint8Array;

/**
 * Тело запроса любого метода реестра из proto3-JSON (T161).
 */
export function encodeMethodRequest(method: string, json: string): Uint8Array;

export function encodePing(nonce: bigint): Uint8Array;

export function encodeRequest(id: bigint, method: string, body: Uint8Array, timeout_ms: number): Uint8Array;

/**
 * C1-06: новый ключ восстановления (184 бита, `XXXX-XXXX-…`, 10 групп).
 */
export function generateRecoveryKey(): string;

/**
 * Копия корня из материала гранта (`undefined` — гранта без копии).
 */
export function grantRootBackup(material: Uint8Array): Uint8Array | undefined;

/**
 * Материал гранта линковки + копия корня под ключом восстановления (поле `rb`).
 */
export function grantWithRootBackup(material: Uint8Array, backup: Uint8Array): Uint8Array;

/**
 * Разобрать ссылку-приглашение → JSON `{kind: "v2", domain, linkId(hex)}` |
 * `{kind: "legacy", token}` (исключение — не ссылка-приглашение).
 */
export function parseInvite(url: string): string;

/**
 * Разбор записи истории/кадра v1 (legacy_v1) → JSON.
 */
export function parseLegacyStored(json_bytes: Uint8Array): string;

/**
 * Мажорная версия протокола.
 */
export function protoMajor(): number;

/**
 * Прогнать набор векторов conformance движком (тест клиента на своей сборке).
 */
export function runConformanceVectors(suite: string, json: string): number;

/**
 * Страница `msg.inbox.sync` → {records: Uint8Array[] (каждая — InboxRecord), more}.
 */
export function splitSyncResponse(bytes: Uint8Array): any;

/**
 * Инициализация модуля: часы браузера для движка.
 */
export function start(): void;

/**
 * Проверить описатель сервера → JSON {domain, serverKey(hex)}.
 */
export function verifyServerDescriptor(bytes: Uint8Array): string;

/**
 * Версия движка.
 */
export function version(): string;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly __wbg_pvanonplanner_free: (a: number, b: number) => void;
    readonly __wbg_pvclient_free: (a: number, b: number) => void;
    readonly __wbg_pvstate_free: (a: number, b: number) => void;
    readonly decodeFrame: (a: number, b: number, c: number) => void;
    readonly decodeMessage: (a: number, b: number, c: number, d: number, e: number) => void;
    readonly decodeMethodResponse: (a: number, b: number, c: number, d: number, e: number) => void;
    readonly deviceLogEntries: (a: number, b: number, c: number) => void;
    readonly encodeAuth: (a: number, b: number, c: number) => void;
    readonly encodeHello: (a: number, b: number, c: number, d: number, e: number, f: number) => void;
    readonly encodeMessage: (a: number, b: number, c: number, d: number, e: number) => void;
    readonly encodeMethodRequest: (a: number, b: number, c: number, d: number, e: number) => void;
    readonly encodePing: (a: number, b: bigint) => void;
    readonly encodeRequest: (a: number, b: bigint, c: number, d: number, e: number, f: number, g: number) => void;
    readonly generateRecoveryKey: (a: number) => void;
    readonly grantRootBackup: (a: number, b: number, c: number) => void;
    readonly grantWithRootBackup: (a: number, b: number, c: number, d: number, e: number) => void;
    readonly parseInvite: (a: number, b: number, c: number) => void;
    readonly parseLegacyStored: (a: number, b: number, c: number) => void;
    readonly protoMajor: () => number;
    readonly pvanonplanner_assign: (a: number, b: number, c: number, d: number, e: number, f: number, g: number) => void;
    readonly pvanonplanner_closed: (a: number, b: number) => void;
    readonly pvanonplanner_expired: (a: number, b: number, c: number) => void;
    readonly pvanonplanner_new: () => number;
    readonly pvanonplanner_openCount: (a: number) => number;
    readonly pvclient_acceptRootChange: (a: number, b: number, c: number, d: number) => void;
    readonly pvclient_ackRequest: (a: number) => number;
    readonly pvclient_createIdentity: (a: number, b: number, c: number) => void;
    readonly pvclient_cursor: (a: number) => bigint;
    readonly pvclient_deliveryKeyRejected: (a: number, b: number, c: number) => number;
    readonly pvclient_drainReady: (a: number, b: number) => void;
    readonly pvclient_ensureStateKey: (a: number) => number;
    readonly pvclient_ephOpen: (a: number, b: number, c: number, d: number) => void;
    readonly pvclient_ephPresence: (a: number, b: number, c: number, d: number) => void;
    readonly pvclient_ephReset: (a: number) => void;
    readonly pvclient_ephSubscribe: (a: number, b: number, c: number, d: number) => void;
    readonly pvclient_ephTyping: (a: number, b: number, c: number, d: number, e: number) => void;
    readonly pvclient_export: (a: number, b: number, c: number, d: number) => void;
    readonly pvclient_exportRootBackup: (a: number, b: number, c: number, d: number, e: number, f: number) => void;
    readonly pvclient_exportRootEscrow: (a: number, b: number, c: number, d: number, e: number, f: number) => void;
    readonly pvclient_forgetRoot: (a: number) => void;
    readonly pvclient_groupBehind: (a: number, b: number, c: number, d: number) => void;
    readonly pvclient_groupChange: (a: number, b: number, c: number, d: number, e: number, f: number) => void;
    readonly pvclient_groupCreate: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number, k: number) => void;
    readonly pvclient_groupForget: (a: number, b: number, c: number, d: number) => void;
    readonly pvclient_groupInfo: (a: number, b: number, c: number, d: number) => void;
    readonly pvclient_groupIngest: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number) => void;
    readonly pvclient_groupInviteCreate: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number) => void;
    readonly pvclient_groupJoin: (a: number, b: number, c: number, d: number) => void;
    readonly pvclient_groupList: (a: number, b: number) => void;
    readonly pvclient_groupRequestDecide: (a: number, b: number, c: number, d: number, e: number, f: number, g: number) => void;
    readonly pvclient_groupRotateEpoch: (a: number, b: number, c: number, d: number) => void;
    readonly pvclient_groupUnconfirmed: (a: number, b: number, c: number, d: number, e: number, f: number) => void;
    readonly pvclient_groupVersion: (a: number, b: number, c: number, d: number) => void;
    readonly pvclient_hasPeerDeliveryKey: (a: number, b: number, c: number) => number;
    readonly pvclient_hasRoot: (a: number) => number;
    readonly pvclient_hasStateKey: (a: number) => number;
    readonly pvclient_importRootBackup: (a: number, b: number, c: number, d: number, e: number, f: number) => void;
    readonly pvclient_importRootBackupFor: (a: number, b: number, c: number, d: number, e: number, f: number) => void;
    readonly pvclient_importState: (a: number, b: number, c: number, d: number, e: number) => void;
    readonly pvclient_ingestBundle: (a: number, b: number, c: number, d: number, e: number, f: number) => void;
    readonly pvclient_ingestLog: (a: number, b: number, c: number, d: number, e: number, f: number) => void;
    readonly pvclient_joinWithGrant: (a: number, b: number, c: number, d: number, e: number) => void;
    readonly pvclient_l2Direct: (a: number, b: number, c: number, d: number) => void;
    readonly pvclient_l2Group: (a: number, b: number, c: number, d: number) => void;
    readonly pvclient_l2SetDirect: (a: number, b: number, c: number, d: number, e: number, f: number, g: number) => void;
    readonly pvclient_l2SetGroupPref: (a: number, b: number, c: number, d: number, e: number) => void;
    readonly pvclient_lastError: (a: number, b: number) => void;
    readonly pvclient_leave: (a: number, b: number) => void;
    readonly pvclient_legacyDeliverRequest: (a: number, b: number, c: number, d: number, e: number, f: number) => void;
    readonly pvclient_legacyDevicesRequest: (a: number, b: number, c: number, d: number) => void;
    readonly pvclient_linkGrantMaterial: (a: number, b: number) => void;
    readonly pvclient_logDevices: (a: number, b: number, c: number, d: number) => void;
    readonly pvclient_logVersion: (a: number, b: number, c: number) => bigint;
    readonly pvclient_new: (a: number, b: number, c: number, d: number, e: number, f: number, g: number) => void;
    readonly pvclient_openRecord: (a: number, b: number, c: number, d: number) => void;
    readonly pvclient_otkRequest: (a: number, b: number) => number;
    readonly pvclient_ownSskExposed: (a: number) => number;
    readonly pvclient_plannerApplyLocal: (a: number, b: number, c: number, d: number) => void;
    readonly pvclient_plannerAttach: (a: number, b: number, c: number, d: number, e: number, f: number) => void;
    readonly pvclient_plannerContainer: (a: number) => number;
    readonly pvclient_plannerCreate: (a: number, b: number, c: number) => void;
    readonly pvclient_plannerHasKey: (a: number) => number;
    readonly pvclient_plannerHeadSeq: (a: number) => number;
    readonly pvclient_plannerIngestGrants: (a: number, b: number, c: number, d: number) => void;
    readonly pvclient_plannerIngestSnapshot: (a: number, b: number, c: number, d: number) => void;
    readonly pvclient_plannerIngestSync: (a: number, b: number, c: number, d: number) => void;
    readonly pvclient_plannerIsAttached: (a: number) => number;
    readonly pvclient_plannerKeysExport: (a: number, b: number) => void;
    readonly pvclient_plannerKeysImport: (a: number, b: number, c: number, d: number) => void;
    readonly pvclient_plannerPrepareLocal: (a: number, b: number, c: number, d: number) => void;
    readonly pvclient_plannerSeal: (a: number, b: number, c: number, d: number, e: number, f: number, g: number) => void;
    readonly pvclient_plannerSize: (a: number) => number;
    readonly pvclient_plannerSnapshotRequest: (a: number, b: number, c: number) => void;
    readonly pvclient_plannerStateJson: (a: number, b: number) => void;
    readonly pvclient_prepareCall: (a: number, b: number, c: number, d: number, e: number, f: number) => void;
    readonly pvclient_prepareDirect: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number) => void;
    readonly pvclient_prepareGroup: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number) => void;
    readonly pvclient_presenceAllowed: (a: number) => number;
    readonly pvclient_readers: (a: number, b: number, c: number, d: number) => void;
    readonly pvclient_recoverWithRoot: (a: number, b: number, c: number, d: number, e: number) => void;
    readonly pvclient_resetIdentity: (a: number, b: number, c: number) => void;
    readonly pvclient_revokeContactAccess: (a: number, b: number, c: number, d: number) => void;
    readonly pvclient_revokeDevice: (a: number, b: number, c: number, d: number) => void;
    readonly pvclient_rotateSsk: (a: number, b: number) => void;
    readonly pvclient_sessionProof: (a: number, b: number, c: number) => void;
    readonly pvclient_setPeerDeliveryKey: (a: number, b: number, c: number, d: number, e: number, f: bigint) => void;
    readonly pvclient_shareDeliveryKey: (a: number, b: number, c: number, d: number) => void;
    readonly pvclient_shareGroupsWithOwnDevices: (a: number, b: number, c: number, d: number) => void;
    readonly pvclient_shareInviteLinks: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number) => void;
    readonly pvclient_sharePlannerWithOwnDevices: (a: number, b: number) => void;
    readonly pvclient_stateSession: (a: number) => number;
    readonly pvclient_syncRequest: (a: number) => number;
    readonly pvclient_takeSharedInvites: (a: number, b: number) => void;
    readonly pvclient_tokenBatchSize: (a: number) => number;
    readonly pvclient_tokenCount: (a: number) => number;
    readonly pvclient_tokenRefillDue: (a: number) => number;
    readonly pvclient_tokenRequest: (a: number, b: number, c: number, d: number, e: number, f: number, g: number) => void;
    readonly pvclient_tokenResponse: (a: number, b: number, c: number, d: number) => void;
    readonly pvstate_callSet: (a: number, b: number, c: number, d: number) => void;
    readonly pvstate_chatCleared: (a: number, b: number, c: number, d: number) => void;
    readonly pvstate_claimDue: (a: number, b: number, c: number) => void;
    readonly pvstate_diff: (a: number, b: number, c: number, d: number, e: number, f: number) => void;
    readonly pvstate_groupInviteRemove: (a: number, b: number, c: number, d: number) => void;
    readonly pvstate_groupInviteSet: (a: number, b: number, c: number, d: number) => void;
    readonly pvstate_ingest: (a: number, b: number, c: number, d: number) => void;
    readonly pvstate_loadSentGuard: (a: number, b: number, c: number) => void;
    readonly pvstate_markSent: (a: number, b: number, c: number, d: number) => void;
    readonly pvstate_migrate: (a: number, b: number, c: number, d: number) => void;
    readonly pvstate_plannerContainerSet: (a: number, b: number, c: number, d: number, e: number, f: number) => void;
    readonly pvstate_sentGuard: (a: number, b: number) => void;
    readonly pvstate_snapshot: (a: number, b: number) => void;
    readonly pvstate_syncRequest: (a: number, b: number) => void;
    readonly runConformanceVectors: (a: number, b: number, c: number, d: number, e: number) => void;
    readonly splitSyncResponse: (a: number, b: number, c: number) => void;
    readonly start: () => void;
    readonly verifyServerDescriptor: (a: number, b: number, c: number) => void;
    readonly version: (a: number) => void;
    readonly __wbindgen_export: (a: number, b: number) => number;
    readonly __wbindgen_export2: (a: number, b: number, c: number, d: number) => number;
    readonly __wbindgen_export3: (a: number) => void;
    readonly __wbindgen_add_to_stack_pointer: (a: number) => number;
    readonly __wbindgen_export4: (a: number, b: number, c: number) => void;
    readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
