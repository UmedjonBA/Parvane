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
 * spec 035 (T070, contracts/engine-api.md): модель движка — намерения → изменения модели. Граница —
 * proto3-JSON типов `engine/v1/model.proto`; ошибка вызова — `{"error": "<вид>"}` в строке результата,
 * ошибка открытия — исключение с той же строкой. Прежние поштучные экспорты (`Client`, `history*`, …)
 * остаются до перехода web на модель (T118).
 */
export class PvEngine {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Вызов по имени (`start`, `submit`, `storeLoaded`, `storeCommitted`, `ingest`, `tick`, `chatList`,
     * `historyPage`, `viewState`, `viewGroup`, `capabilities`, `unlockPin`, `engineInfo`) → JSON результата.
     */
    call(name: string, args_json: string): string;
    engineInfo(): string;
    /**
     * Открыть по конфигурации (`EngineConfig`, JSON); дальше — `call("start", "{}")`.
     */
    static open(config_json: string): PvEngine;
    /**
     * Ревизия последнего выпущенного изменения модели.
     */
    revision(): number;
}

/**
 * Открытое хранилище профиля (одна вкладка).
 */
export class PvStore {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    /**
     * P1 переноса поколения (смена DEK после установки PIN): пачка с корнем.
     */
    beginRotation(): any;
    /**
     * Хост зафиксировал пачку.
     */
    committed(batch_id: number): void;
    /**
     * Хост не смог зафиксировать пачку.
     */
    failed(batch_id: number, reason: string): void;
    /**
     * Открыть запись по ключу носителя и значению.
     */
    open(key: string, value: Uint8Array): Uint8Array;
    /**
     * Корень сменила другая вкладка: принять его (`ready` | `locked` | `too_new`).
     */
    refreshRoot(root: Uint8Array): string;
    /**
     * Байты корня (для записи `root` вне пачки движка не нужны — тесты, сверка).
     */
    rootBytes(): Uint8Array;
    /**
     * Сводка корня (JSON): поколения, чем обёрнуто, соль и итерации PIN.
     */
    rootInfo(): string;
    /**
     * Прочитанное по `read` переноса: `keys[i]` → `values[i]` (Uint8Array).
     */
    rotationLoaded(read_id: number, keys: Array<any>, values: Array<any>): void;
    /**
     * Следующее действие переноса: `{type: 'read', readId, prefix, after, limit}` | `{type: 'write', batch}` |
     * `{type: 'continue'}` | `{type: 'done'}` | `{type: 'aborted', errors}`.
     */
    rotationNext(): any;
    /**
     * Номер зафиксированной точки переноса (1–6) или 0.
     */
    rotationPoint(): number;
    /**
     * Записей в пачке переноса (тесты).
     */
    setBatchLimit(n: number): void;
    /**
     * `ready` | `locked` | `too_new`.
     */
    state(): string;
    /**
     * Забыть DEK.
     */
    storeLock(): void;
    /**
     * Снять PIN: обёртка ключом устройства — пачка только с корнем.
     */
    storeRemovePin(device_key: Uint8Array): any;
    /**
     * Установить/сменить PIN: обёртка `pin` (соль 16 байт, итерации, KEK хоста) вместо прежней — пачка только
     * с корнем; записи данных не трогаются (FR-021).
     */
    storeSetPin(salt: Uint8Array, iterations: number, kek: Uint8Array): any;
    /**
     * Разблокировать: ключом устройства (32 байта) либо KEK из PIN (32 байта, `pin = true`).
     */
    storeUnlock(key: Uint8Array, pin: boolean): void;
    /**
     * Разблокировать PIN-строкой (вывод PBKDF2 в движке — медленнее WebCrypto; тесты и запасной путь).
     */
    storeUnlockPin(pin: string): void;
    /**
     * Обернуть DEK ключом устройства (новый профиль) — пачка только с корнем.
     */
    storeWrapDevice(device_key: Uint8Array): any;
    /**
     * Пачка записей (`kinds[i]`, `names[i]`, `values[i]`: Uint8Array) и удалений (`delKinds[i]`, `delNames[i]`).
     */
    write(kinds: Array<any>, names: Array<any>, values: Array<any>, del_kinds: Array<any>, del_names: Array<any>): any;
}

/**
 * Разобрать кадр сервера → объект {kind, …} (тела — Uint8Array).
 */
export function decodeFrame(bytes: Uint8Array): any;

/**
 * Байты → proto3-JSON по полному имени типа (лимиты схемы — до разбора). Незнакомый тип — `UnknownMethod`.
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
 * proto3-JSON → байты сообщения по полному имени типа — для ВСЕХ сообщений схемы (spec 035, FR-050:
 * тонкий вызов сгенерированного `type_codec`). Незнакомый тип — `UnknownMethod`.
 */
export function encodeMessage(type_name: string, json: string): Uint8Array;

/**
 * Тело запроса любого метода реестра из proto3-JSON (T161).
 */
export function encodeMethodRequest(method: string, json: string): Uint8Array;

export function encodePing(nonce: bigint): Uint8Array;

/**
 * `pad_to` — дополнить кадр до длины, кратной этому числу (spec 025, режим L2); не задано — без дополнения.
 * `dest_domain` (spec 028) — домен сервера объекта; пусто или свой — обычный запрос.
 */
export function encodeRequest(id: bigint, method: string, body: Uint8Array, timeout_ms: number, pad_to?: number | null, dest_domain?: string | null): Uint8Array;

/**
 * Тело `cloud.blob.upload_chunk` из байт зашифрованного чанка (A7): без
 * base64/JSON. `bucket`: 0 — медиа чатов, 1 — диск «Облака». Кадр запроса —
 * как обычно, `encodeRequest(id, method, body, timeout)`. Чанки скачивания
 * уже приходят байтами (`decodeFrame` → `chunk.data`).
 */
export function encodeUploadChunk(upload_id: string, index: number, bucket: number, data: Uint8Array): Uint8Array;

/**
 * spec 035 (FR-046, contracts/versioning.md): `engineInfo()` этой сборки движка (JSON).
 */
export function engineInfo(): string;

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
 * Статические функции журнала истории (spec 033) по имени: `historyApply`, `historyMerge`, `historyView`,
 * `historyIsUnread`, `historyMarkMerge`, `historyMarkAfter`, `historyCanDelete`, `historyRowFromWire`,
 * `historySegmentKey`, `historySegmentDigest`, `historyNeedsReplace`, `historyCompact`, `historySummary`,
 * `historyApplyMany`, `historyNewStamp`, `historyUnreadKinds`. Результат — JSON-текст.
 */
export function historyCall(name: string, args_json: string): string;

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
 * A0023-1: эфемерная пара для ответа владельца через Telegram — 64 байта: приватный ‖ публичный.
 */
export function recoveryTgKeypair(): Uint8Array;

/**
 * A0023-1: открыть запечатанный сервером ответ владельца приватным ключом пары.
 */
export function recoveryTgOpen(secret: Uint8Array, user: string, device_id: string, sealed: Uint8Array): string;

/**
 * Прогнать набор векторов conformance движком (тест клиента на своей сборке).
 */
export function runConformanceVectors(suite: string, json: string): number;

/**
 * Полные имена всех сообщений схемы (тесты кодеков во всех обвязках, spec 035 T012).
 */
export function schemaMessageNames(): string;

/**
 * C1-06: новый ключ восстановления (184 бита, `XXXX-XXXX-…`, 10 групп).
 * Жалоба администратору сервера (spec 024): JSON жалобы, запечатанный его открытым ключом
 * (`ServerDescribeResponse.report_public_key`); `reporter` — свой адрес (сервер берёт его из сессии).
 */
export function sealReport(admin_public: Uint8Array, reporter: string, plaintext: Uint8Array): Uint8Array;

/**
 * Страница `msg.inbox.sync` → {records: Uint8Array[] (каждая — InboxRecord), more}.
 */
export function splitSyncResponse(bytes: Uint8Array): any;

/**
 * Инициализация модуля: часы браузера для движка.
 */
export function start(): void;

/**
 * Открыть хранилище: байты корня (`root`) с носителя либо пусто — новый профиль (поколение 1, новый DEK;
 * обёртку даёт `storeWrapDevice`). Существующее — заблокировано до `storeUnlock`.
 */
export function storeOpen(root: Uint8Array): PvStore;

/**
 * REPORT-1 (A0008-2): подтвердить авторство сообщения из жалобы — `proof` (из события) и `op_id`
 * (UUID-строка), автор и начало текста совпадают с подписанным; `group_hex` не пуст — и группа беседы. Возвращает JSON `{ok, root?, deviceId?}`.
 */
export function verifyMessageProof(proof: Uint8Array, op_id: string, author: string, text: string, group_hex: string): string;

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
    readonly __wbg_pvengine_free: (a: number, b: number) => void;
    readonly __wbg_pvstore_free: (a: number, b: number) => void;
    readonly decodeFrame: (a: number, b: number, c: number) => void;
    readonly decodeMessage: (a: number, b: number, c: number, d: number, e: number) => void;
    readonly decodeMethodResponse: (a: number, b: number, c: number, d: number, e: number) => void;
    readonly deviceLogEntries: (a: number, b: number, c: number) => void;
    readonly encodeAuth: (a: number, b: number, c: number) => void;
    readonly encodeHello: (a: number, b: number, c: number, d: number, e: number, f: number) => void;
    readonly encodeMessage: (a: number, b: number, c: number, d: number, e: number) => void;
    readonly encodeMethodRequest: (a: number, b: number, c: number, d: number, e: number) => void;
    readonly encodePing: (a: number, b: bigint) => void;
    readonly encodeRequest: (a: number, b: bigint, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number) => void;
    readonly encodeUploadChunk: (a: number, b: number, c: number, d: number, e: number, f: number, g: number) => void;
    readonly engineInfo: (a: number) => void;
    readonly generateRecoveryKey: (a: number) => void;
    readonly grantRootBackup: (a: number, b: number, c: number) => void;
    readonly grantWithRootBackup: (a: number, b: number, c: number, d: number, e: number) => void;
    readonly historyCall: (a: number, b: number, c: number, d: number, e: number) => void;
    readonly parseInvite: (a: number, b: number, c: number) => void;
    readonly parseLegacyStored: (a: number, b: number, c: number) => void;
    readonly protoMajor: () => number;
    readonly pvanonplanner_assign: (a: number, b: number, c: number, d: number, e: number, f: number, g: number) => void;
    readonly pvanonplanner_closed: (a: number, b: number) => void;
    readonly pvanonplanner_expired: (a: number, b: number, c: number) => void;
    readonly pvanonplanner_new: () => number;
    readonly pvanonplanner_openCount: (a: number) => number;
    readonly pvengine_call: (a: number, b: number, c: number, d: number, e: number, f: number) => void;
    readonly pvengine_engineInfo: (a: number, b: number) => void;
    readonly pvengine_open: (a: number, b: number, c: number) => void;
    readonly pvengine_revision: (a: number) => number;
    readonly pvstore_beginRotation: (a: number, b: number) => void;
    readonly pvstore_committed: (a: number, b: number, c: number) => void;
    readonly pvstore_failed: (a: number, b: number, c: number, d: number) => void;
    readonly pvstore_open: (a: number, b: number, c: number, d: number, e: number, f: number) => void;
    readonly pvstore_refreshRoot: (a: number, b: number, c: number, d: number) => void;
    readonly pvstore_rootBytes: (a: number, b: number) => void;
    readonly pvstore_rootInfo: (a: number, b: number) => void;
    readonly pvstore_rotationLoaded: (a: number, b: number, c: number, d: number, e: number) => void;
    readonly pvstore_rotationNext: (a: number, b: number) => void;
    readonly pvstore_rotationPoint: (a: number) => number;
    readonly pvstore_setBatchLimit: (a: number, b: number) => void;
    readonly pvstore_state: (a: number, b: number) => void;
    readonly pvstore_storeLock: (a: number) => void;
    readonly pvstore_storeRemovePin: (a: number, b: number, c: number, d: number) => void;
    readonly pvstore_storeSetPin: (a: number, b: number, c: number, d: number, e: number, f: number, g: number) => void;
    readonly pvstore_storeUnlock: (a: number, b: number, c: number, d: number, e: number) => void;
    readonly pvstore_storeUnlockPin: (a: number, b: number, c: number, d: number) => void;
    readonly pvstore_storeWrapDevice: (a: number, b: number, c: number, d: number) => void;
    readonly pvstore_write: (a: number, b: number, c: number, d: number, e: number, f: number, g: number) => void;
    readonly recoveryTgKeypair: (a: number) => void;
    readonly recoveryTgOpen: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number) => void;
    readonly runConformanceVectors: (a: number, b: number, c: number, d: number, e: number) => void;
    readonly schemaMessageNames: (a: number) => void;
    readonly sealReport: (a: number, b: number, c: number, d: number, e: number, f: number, g: number) => void;
    readonly splitSyncResponse: (a: number, b: number, c: number) => void;
    readonly start: () => void;
    readonly storeOpen: (a: number, b: number, c: number) => void;
    readonly verifyMessageProof: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number, k: number) => void;
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
