// spec 035 (T113): клиентское ядро — в модели движка. `EngineClient` — прежний интерфейс `PvClient` (те же имена,
// аргументы и результаты), но каждый вызов идёт в модель (`ModelHost.clientCall` → `clientCall` движка → единая
// точка входа `host::call`, общая с desktop/android). Состояние клиента живёт и сохраняется в модели; хост его
// не экспортирует и не хранит. Список методов выведен из прежней обвязки WASM (`PvClient`) и сверен с
// `backend/protocol/src/host/call.rs` (имена аргументов camelCase; байты — base64 на границе).

/** Ядро, в которое идут вызовы: модель профиля (`ModelHost`) либо модель в памяти (`openMemoryClient`). */
export interface ClientCore {
  clientCall(name: string, args: Record<string, unknown>): unknown;
  close?(): void;
}

/** Нет значения: единая точка входа отдаёт `null`. */
function isNil(value: unknown) {
  // eslint-disable-next-line no-null/no-null
  return value === undefined || value === null;
}

function b(bytes?: Uint8Array | null): string | undefined {
  if (!bytes) return undefined;
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

function u(value: unknown): Uint8Array {
  if (typeof value !== 'string') return new Uint8Array(0);
  return Uint8Array.from(atob(value), (c) => c.charCodeAt(0));
}

/** Строковый результат прежней обвязки: значение JSON единой точки входа — текстом (`logDevices`, `groupInfo`, …). */
function text(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value);
}

/** Запросы клиента — тела байтами (как прежняя обвязка), `null` полей — отсутствие. */
function reqs(value: unknown): any {
  if (isNil(value)) return undefined;
  if (Array.isArray(value)) return value.map(reqs);
  if (value && typeof value === 'object') {
    const o = value as Record<string, unknown>;
    if (typeof o.method === 'string' && typeof o.chan === 'string' && typeof o.body === 'string') {
      const out: Record<string, unknown> = { chan: o.chan, method: o.method, body: u(o.body) };
      if (typeof o.dest === 'string' && o.dest) out.dest = o.dest;
      return out;
    }
    const out: Record<string, unknown> = {};
    Object.entries(o).forEach(([k, v]) => {
      if (!isNil(v)) out[k] = reqs(v);
    });
    return out;
  }
  return value;
}

function bytesIn(value: any, fields: string[]) {
  if (!value || typeof value !== 'object') return value;
  const out = { ...value };
  fields.forEach((f) => {
    if (typeof out[f] === 'string') out[f] = u(out[f]);
  });
  return out;
}

/** Вид личного контейнера домена. */
export type PersonalKind = 'planner' | 'health' | 'music';

export class EngineClient {
  constructor(private readonly host: ClientCore) {}

  private c(name: string, args: Record<string, unknown>): unknown {
    return this.host.clientCall(name, args);
  }

  /** Клиент принадлежит модели: освобождается только модель в памяти (`openMemoryClient`), модель профиля — нет. */
  free() {
    if (this.ownsCore) this.host.close?.();
  }

  /** Клиент владеет моделью в памяти (тесты, доказательство устройства по снимку). */
  ownsCore = false;

  acceptRootChange(user: string): boolean {
    return this.c('acceptRootChange', { user }) as boolean;
  }

  ackRequest(): any {
    return reqs(this.c('ackRequest', {}));
  }

  aliasesOf(user: string): string[] {
    return this.c('aliasesOf', { user }) as string[];
  }

  cloudApplyLocal(idHex: string, op: Uint8Array): number {
    return this.c('cloudApplyLocal', { id: idHex, op: b(op) }) as number;
  }

  cloudAttach(getResponse: Uint8Array, grantsResponse: Uint8Array): string {
    return text(this.c('cloudAttach', { getResponse: b(getResponse), grantsResponse: b(grantsResponse) }));
  }

  cloudContainers(): string {
    return text(this.c('cloudContainers', {}));
  }

  cloudCreate(tsMs: number): any {
    return reqs(this.c('cloudCreate', { tsMs }));
  }

  cloudDomain(idHex: string): string {
    return text(this.c('cloudDomain', { id: idHex }));
  }

  cloudForget(idHex: string): void {
    this.c('cloudForget', { id: idHex });
  }

  cloudGrant(idHex: string, user: string, write: boolean, inviteText: string, tsMs: number): Array<any> {
    return reqs(this.c('cloudGrant', { id: idHex, user, write, inviteText, tsMs }));
  }

  cloudGrantVersion(idHex: string): number {
    return this.c('cloudGrantVersion', { id: idHex }) as number;
  }

  cloudHasKey(idHex: string): boolean {
    return this.c('cloudHasKey', { id: idHex }) as boolean;
  }

  cloudHeadSeq(idHex: string): number {
    return this.c('cloudHeadSeq', { id: idHex }) as number;
  }

  cloudIngestGrants(idHex: string, grantsResponse: Uint8Array): number {
    return this.c('cloudIngestGrants', { id: idHex, grantsResponse: b(grantsResponse) }) as number;
  }

  cloudIngestSnapshot(idHex: string, snapshotResponse: Uint8Array): number {
    return this.c('cloudIngestSnapshot', { id: idHex, snapshotResponse: b(snapshotResponse) }) as number;
  }

  cloudIngestSync(idHex: string, syncResponse: Uint8Array, strict: boolean): any {
    return reqs(this.c('cloudIngestSync', { id: idHex, syncResponse: b(syncResponse), strict }));
  }

  cloudIsAttached(idHex: string): boolean {
    return this.c('cloudIsAttached', { id: idHex }) as boolean;
  }

  cloudKeysExport(): string {
    return text(this.c('cloudKeysExport', {}));
  }

  cloudKeysImport(json: string): void {
    this.c('cloudKeysImport', { json });
  }

  cloudLeave(idHex: string, tsMs: number): any {
    return reqs(this.c('cloudLeave', { id: idHex, tsMs }));
  }

  cloudPrepareLocal(idHex: string, opsJson: string): any {
    return bytesIn(reqs(this.c('cloudPrepareLocal', { id: idHex, opsJson })), ['op']);
  }

  cloudRevoke(idHex: string, user: string, tsMs: number): Array<any> {
    return reqs(this.c('cloudRevoke', { id: idHex, user, tsMs }));
  }

  cloudRotate(idHex: string, tsMs: number): Array<any> {
    return reqs(this.c('cloudRotate', { id: idHex, tsMs }));
  }

  cloudSeal(idHex: string, op: Uint8Array, opIdHex: string, tsMs: number): any {
    return reqs(this.c('cloudSeal', { id: idHex, op: b(op), opIdHex, tsMs }));
  }

  cloudShareKeys(idHex: string): Array<any> {
    return reqs(this.c('cloudShareKeys', { id: idHex }));
  }

  cloudShareWithOwnDevices(idHex: string): Array<any> {
    return reqs(this.c('cloudShareWithOwnDevices', { id: idHex }));
  }

  cloudSnapshotRequest(idHex: string, tsMs: number): any {
    return reqs(this.c('cloudSnapshotRequest', { id: idHex, tsMs }));
  }

  cloudStateJson(idHex: string): string | undefined {
    const v = this.c('cloudStateJson', { id: idHex });
    return isNil(v) ? undefined : text(v);
  }

  createIdentity(otkCount: number): any {
    return bytesIn(reqs(this.c('createIdentity', { otkCount })), ['rootSecret']);
  }

  cursor(): bigint {
    return BigInt(this.c('cursor', {}) as number);
  }

  deliveryKeyRejected(peer: string): boolean {
    return this.c('deliveryKeyRejected', { peer }) as boolean;
  }

  drainReady(): string {
    return text(this.c('drainReady', {}));
  }

  ensureStateKey(): boolean {
    return this.c('ensureStateKey', {}) as boolean;
  }

  ephOpen(body: Uint8Array): string {
    return text(this.c('ephOpen', { body: b(body) }));
  }

  ephPresence(online: boolean, lastSeenMs: number): Array<any> {
    return reqs(this.c('ephPresence', { online, lastSeenMs }));
  }

  ephReset(): void {
    this.c('ephReset', {});
  }

  ephSubscribe(chatsJson: string): Array<any> {
    return reqs(this.c('ephSubscribe', { chatsJson }));
  }

  ephTyping(chat: string, action: number): Array<any> {
    return reqs(this.c('ephTyping', { chat, action }));
  }

  export(key: Uint8Array): Uint8Array {
    return u(this.c('export', { key: b(key) }));
  }

  exportRootBackup(recoveryKey: string, rootSecret?: Uint8Array | null): Uint8Array {
    return u(this.c('exportRootBackup', { recoveryKey, rootSecret: b(rootSecret) }));
  }

  exportRootEscrow(escrowPublic: Uint8Array, rootSecret?: Uint8Array | null): Uint8Array {
    return u(this.c('exportRootEscrow', { escrowPublic: b(escrowPublic), rootSecret: b(rootSecret) }));
  }

  forgetRoot(): void {
    this.c('forgetRoot', {});
  }

  formerAddresses(): string[] {
    return this.c('formerAddresses', {}) as string[];
  }

  groupAvatarKeyContent(group: string): string | undefined {
    const v = this.c('groupAvatarKeyContent', { group });
    return isNil(v) ? undefined : text(v);
  }

  groupBehind(group: string): bigint | undefined {
    const v = this.c('groupBehind', { group });
    return isNil(v) ? undefined : BigInt(v as number);
  }

  groupChange(group: string, changeJson: string): any {
    return reqs(this.c('groupChange', { group, changeJson }));
  }

  groupCreate(kind: number, name: string, members: string[], permsJson: string, migratedFrom?: string | null): any {
    return reqs(this.c('groupCreate', { kind, name, members, permsJson, migratedFrom }));
  }

  groupDomain(group: string): string {
    return text(this.c('groupDomain', { group }));
  }

  groupForget(group: string): void {
    this.c('groupForget', { group });
  }

  groupInfo(group: string): string {
    return text(this.c('groupInfo', { group }));
  }

  groupIngest(domain: string, group: string, syncResponse: Uint8Array): bigint {
    return BigInt(this.c('groupIngest', { domain, group, syncResponse: b(syncResponse) }) as number);
  }

  groupInviteAvatarKey(group: string, url: string): string | undefined {
    const v = this.c('groupInviteAvatarKey', { group, url });
    return isNil(v) ? undefined : text(v);
  }

  groupInviteAvatarWraps(group: string, linksJson: string): Array<any> {
    return reqs(this.c('groupInviteAvatarWraps', { group, linksJson }));
  }

  groupInviteCreate(
    group: string, title: string, expiresMs: number, usageLimit: number, requiresApproval: boolean,
  ): any {
    return reqs(this.c('groupInviteCreate', { group, title, expiresMs, usageLimit, requiresApproval }));
  }

  groupJoin(url: string): any {
    return reqs(this.c('groupJoin', { url }));
  }

  groupJoinPublic(group: string, secretHex: string): any {
    return reqs(this.c('groupJoinPublic', { group, secretHex }));
  }

  groupKeysExport(): string {
    return text(this.c('groupKeysExport', {}));
  }

  groupKeysImport(json: string): string {
    return text(this.c('groupKeysImport', { json }));
  }

  groupKeysMerge(own: string, server: string): string {
    return text(this.c('groupKeysMerge', { own, server }));
  }

  groupList(): string[] {
    return this.c('groupList', {}) as string[];
  }

  groupOpenEnvelope(envelope: Uint8Array): string {
    return text(this.c('groupOpenEnvelope', { envelope: b(envelope) }));
  }

  groupRequestDecide(group: string, user: string, approve: boolean, viaLinkHex?: string | null): any {
    return reqs(this.c('groupRequestDecide', { group, user, approve, viaLinkHex }));
  }

  groupRotateEpoch(group: string): Array<any> {
    return reqs(this.c('groupRotateEpoch', { group }));
  }

  groupSetPhoto(group: string, fileId: string, avatarDomain: string, keyB64: string): any {
    return reqs(this.c('groupSetPhoto', { group, fileId, avatarDomain, keyB64 }));
  }

  groupSetPublic(group: string, isPublic: boolean, name: string, preview: boolean, history: boolean): any {
    return reqs(this.c('groupSetPublic', { group, public: isPublic, name, preview, history }));
  }

  groupSyncByLinkRequest(domain: string, group: string, after: number, url: string, tsMs: number): any {
    return reqs(this.c('groupSyncByLinkRequest', { domain, group, after, url, tsMs }));
  }

  groupUnconfirmed(group: string, claimed: string[]): string[] {
    return this.c('groupUnconfirmed', { group, claimed }) as string[];
  }

  groupVersion(group: string): bigint {
    return BigInt(this.c('groupVersion', { group }) as number);
  }

  groupsRekeyPending(): Array<any> {
    return reqs(this.c('groupsRekeyPending', {}));
  }

  hasPeerDeliveryKey(peer: string): boolean {
    return this.c('hasPeerDeliveryKey', { peer }) as boolean;
  }

  hasRoot(): boolean {
    return this.c('hasRoot', {}) as boolean;
  }

  hasStateKey(): boolean {
    return this.c('hasStateKey', {}) as boolean;
  }

  importRootBackup(blob: Uint8Array, recoveryKey: string): Uint8Array {
    return u(this.c('importRootBackup', { blob: b(blob), recoveryKey }));
  }

  importRootBackupFor(blob: Uint8Array, recoveryKey: string): void {
    this.c('importRootBackupFor', { blob: b(blob), recoveryKey });
  }

  ingestBundle(user: string, bundleResponse: Uint8Array): number {
    return this.c('ingestBundle', { user, bundleResponse: b(bundleResponse) }) as number;
  }

  ingestLog(user: string, syncResponse: Uint8Array): string {
    return text(this.c('ingestLog', { user, syncResponse: b(syncResponse) }));
  }

  joinWithGrant(material: Uint8Array, otkCount: number): Array<any> {
    return reqs(this.c('joinWithGrant', { material: b(material), otkCount }));
  }

  l2Direct(peer: string): string {
    return text(this.c('l2Direct', { peer }));
  }

  l2Group(group: string): string {
    return text(this.c('l2Group', { group }));
  }

  l2SetDirect(peer: string, enabled: boolean, opId: string): Array<any> {
    return reqs(this.c('l2SetDirect', { peer, enabled, opId }));
  }

  l2SetGroupPref(group: string, enabled: boolean): void {
    this.c('l2SetGroupPref', { group, enabled });
  }

  lastError(): string | undefined {
    const v = this.c('lastError', {});
    return isNil(v) ? undefined : text(v);
  }

  leave(): Array<any> {
    return reqs(this.c('leave', {}));
  }

  leftSskHolders(): Array<any> {
    return reqs(this.c('leftSskHolders', {}));
  }

  linkChallengeUnwrap(deviceId: string, commitment: string, challengePub: string, wrap: Uint8Array): Uint8Array {
    return u(this.c('linkChallengeUnwrap', { deviceId, commitment, challengePub, wrap: b(wrap) }));
  }

  linkChallengeWrap(deviceId: string, commitment: string, challengePub: string, secret: Uint8Array): Uint8Array {
    return u(this.c('linkChallengeWrap', { deviceId, commitment, challengePub, secret: b(secret) }));
  }

  linkGrantMaterial(): Uint8Array {
    return u(this.c('linkGrantMaterial', {}));
  }

  logDevices(user: string): string {
    return text(this.c('logDevices', { user }));
  }

  logVersion(user: string): bigint {
    return BigInt(this.c('logVersion', { user }) as number);
  }

  logsBehind(): Array<any> {
    return reqs(this.c('logsBehind', {}));
  }

  openRecord(record: Uint8Array): string {
    return text(this.c('openRecord', { record: b(record) }));
  }

  otkRequest(n: number): any {
    return reqs(this.c('otkRequest', { n }));
  }

  ownRenamedTo(): string | undefined {
    const v = this.c('ownRenamedTo', {});
    return isNil(v) ? undefined : text(v);
  }

  ownSskExposed(): boolean {
    return this.c('ownSskExposed', {}) as boolean;
  }

  peerRenamedFrom(user: string): string | undefined {
    const v = this.c('peerRenamedFrom', { user });
    return isNil(v) ? undefined : text(v);
  }

  peerRenamedTo(user: string): string | undefined {
    const v = this.c('peerRenamedTo', { user });
    return isNil(v) ? undefined : text(v);
  }

  /** Сводка «Здоровья» для экранов (HEALTH-3): считает движок. Контейнера нет — `undefined`. */
  healthView(nowMs: number, tzMin: number): string | undefined {
    const v = this.c('healthView', { nowMs, tzMin });
    return isNil(v) ? undefined : text(v);
  }

  /** Изменения для записи разобранных записей (HEALTH-3): JSON `{changes}` для `prepareLocal`. */
  healthCompose(entries: unknown[], nowMs: number): string {
    return text(this.c('healthCompose', { entries, nowMs }));
  }

  /** Записи показателя новыми первыми (HEALTH-3): JSON `{entries, hasMore}`; пустой вид — все записи. */
  healthEntries(kind: string, limit: number, nowMs: number, tzMin: number): string {
    return text(this.c('healthEntries', {
      kind, limit, nowMs, tzMin,
    }));
  }

  /** Здоровье по дням отрезка для календаря «Плана»: JSON `{goals, days}`. */
  healthDays(fromDay: string, toDay: string): string {
    return text(this.c('healthDays', { fromDay, toDay }));
  }

  /** Проверка записи из формы (HEALTH-3): код отказа либо `undefined`, если запись годится. */
  healthCheck(entry: unknown, nowMs: number): string | undefined {
    const { problem } = this.c('healthCheck', { entry, nowMs }) as { problem?: string };
    return isNil(problem) ? undefined : problem;
  }

  /** Плейлисты «Музыки» для экранов (MUSIC-2): считает движок; контейнера ещё нет — пустой список. */
  musicStateJson(): string {
    return text(this.c('musicStateJson', {}));
  }

  /** Действие над плейлистами → JSON `{changes, id?, skipped?}` для `prepareLocal` (MUSIC-2). */
  musicCompose(action: Record<string, unknown>, nowMs: number): string {
    return text(this.c('musicCompose', { action, nowMs }));
  }

  /** Разбор свободного ввода «Здоровья» (HEALTH-2): JSON `{entries, unparsed, problems}`. */
  healthParse(input: string, nowMs: number, tzMin: number): string {
    return text(this.c('healthParse', { text: input, nowMs, tzMin }));
  }

  /**
   * Разбор ввода с подстановкой «моих продуктов» (HEALTH-3 п. 13): тот же JSON, что у `healthParse`; еда, названная
   * без чисел, несёт калории, БЖУ и граммы прошлой записи с тем же названием и пометку `recalled`.
   */
  healthRecall(input: string, nowMs: number, tzMin: number): string {
    return text(this.c('healthRecall', { text: input, nowMs, tzMin }));
  }

  /** Личный контейнер домена этого вида («План», «Здоровье»): один набор вызовов движка, имена — `<вид>Xxx`. */
  personal(kind: PersonalKind) {
    const call = (name: string, args: Record<string, unknown> = {}) => this.c(`${kind}${name}`, args);
    const textOrNone = (v: unknown) => (isNil(v) ? undefined : text(v));
    const shareName = `share${kind[0].toUpperCase()}${kind.slice(1)}WithOwnDevices`;
    return {
      applyLocal: (op: Uint8Array) => call('ApplyLocal', { op: b(op) }) as number,
      attach: (getResponse: Uint8Array, grantsResponse: Uint8Array) => {
        call('Attach', { getResponse: b(getResponse), grantsResponse: b(grantsResponse) });
      },
      container: (): any => reqs(call('Container')),
      create: (tsMs: number): any => reqs(call('Create', { tsMs })),
      hasKey: () => call('HasKey') as boolean,
      headSeq: () => call('HeadSeq') as number,
      ingestGrants: (grantsResponse: Uint8Array) => (
        call('IngestGrants', { grantsResponse: b(grantsResponse) }) as number
      ),
      ingestSnapshot: (snapshotResponse: Uint8Array) => (
        call('IngestSnapshot', { snapshotResponse: b(snapshotResponse) }) as number
      ),
      ingestSync: (syncResponse: Uint8Array): any => reqs(call('IngestSync', { syncResponse: b(syncResponse) })),
      isAttached: () => call('IsAttached') as boolean,
      keysExport: () => textOrNone(call('KeysExport')),
      keysImport: (json: string) => {
        call('KeysImport', { json });
      },
      prepareLocal: (changesJson: string): any => bytesIn(reqs(call('PrepareLocal', { changesJson })), ['op']),
      seal: (op: Uint8Array, opIdHex: string, tsMs: number): any => reqs(call('Seal', { op: b(op), opIdHex, tsMs })),
      size: () => call('Size') as number,
      snapshotRequest: (tsMs: number): any => reqs(call('SnapshotRequest', { tsMs })),
      stateJson: () => textOrNone(call('StateJson')),
      shareWithOwnDevices: (): Array<any> => reqs(this.c(shareName, {})),
    };
  }

  plannerApplyLocal(op: Uint8Array): number {
    return this.c('plannerApplyLocal', { op: b(op) }) as number;
  }

  plannerAttach(getResponse: Uint8Array, grantsResponse: Uint8Array): void {
    this.c('plannerAttach', { getResponse: b(getResponse), grantsResponse: b(grantsResponse) });
  }

  plannerContainer(): any {
    return reqs(this.c('plannerContainer', {}));
  }

  plannerCreate(tsMs: number): any {
    return reqs(this.c('plannerCreate', { tsMs }));
  }

  plannerHasKey(): boolean {
    return this.c('plannerHasKey', {}) as boolean;
  }

  plannerHeadSeq(): number {
    return this.c('plannerHeadSeq', {}) as number;
  }

  plannerIngestGrants(grantsResponse: Uint8Array): number {
    return this.c('plannerIngestGrants', { grantsResponse: b(grantsResponse) }) as number;
  }

  plannerIngestSnapshot(snapshotResponse: Uint8Array): number {
    return this.c('plannerIngestSnapshot', { snapshotResponse: b(snapshotResponse) }) as number;
  }

  plannerIngestSync(syncResponse: Uint8Array): any {
    return reqs(this.c('plannerIngestSync', { syncResponse: b(syncResponse) }));
  }

  plannerIsAttached(): boolean {
    return this.c('plannerIsAttached', {}) as boolean;
  }

  plannerKeysExport(): string | undefined {
    const v = this.c('plannerKeysExport', {});
    return isNil(v) ? undefined : text(v);
  }

  plannerKeysImport(json: string): void {
    this.c('plannerKeysImport', { json });
  }

  plannerPrepareLocal(changesJson: string): any {
    return bytesIn(reqs(this.c('plannerPrepareLocal', { changesJson })), ['op']);
  }

  plannerSeal(op: Uint8Array, opIdHex: string, tsMs: number): any {
    return reqs(this.c('plannerSeal', { op: b(op), opIdHex, tsMs }));
  }

  plannerSize(): number {
    return this.c('plannerSize', {}) as number;
  }

  plannerSnapshotRequest(tsMs: number): any {
    return reqs(this.c('plannerSnapshotRequest', { tsMs }));
  }

  plannerStateJson(): string | undefined {
    const v = this.c('plannerStateJson', {});
    return isNil(v) ? undefined : text(v);
  }

  prepareCall(peer: string, signalJson: string): Array<any> {
    return reqs(this.c('prepareCall', { peer, signalJson }));
  }

  prepareCallOwn(signalJson: string): Array<any> {
    return reqs(this.c('prepareCallOwn', { signalJson }));
  }

  prepareCover(): any {
    return reqs(this.c('prepareCover', {}));
  }

  prepareDirect(peer: string, contentJson: string, opId: string): Array<any> {
    return reqs(this.c('prepareDirect', { peer, contentJson, opId }));
  }

  prepareGroup(group: string, contentJson: string, opId: string): Array<any> {
    return reqs(this.c('prepareGroup', { group, contentJson, opId }));
  }

  presenceAllowed(): boolean {
    return this.c('presenceAllowed', {}) as boolean;
  }

  publicHistoryItems(response: Uint8Array): Array<any> {
    const items = reqs(this.c('publicHistoryItems', { response: b(response) })) as { seq: number; envelope: string }[];
    return items.map((i) => ({ ...i, envelope: u(i.envelope) }));
  }

  readers(id: string): string {
    return text(this.c('readers', { id }));
  }

  recoverWithRoot(logResponse: Uint8Array, otkCount: number): Array<any> {
    return reqs(this.c('recoverWithRoot', { logResponse: b(logResponse), otkCount }));
  }

  renameApply(): void {
    this.c('renameApply', {});
  }

  renameFollow(logResponse: Uint8Array): Array<any> {
    return reqs(this.c('renameFollow', { logResponse: b(logResponse) }));
  }

  renameGroupsPending(): Array<any> {
    return reqs(this.c('renameGroupsPending', {}));
  }

  renamePrepare(newAddress: string, newLogin: string, recoveryKey: string): Uint8Array {
    return u(this.c('renamePrepare', { newAddress, newLogin, recoveryKey }));
  }

  reportDeviceStolen(deviceId: string): any {
    return reqs(this.c('reportDeviceStolen', { deviceId }));
  }

  resetIdentity(otkCount: number): any {
    return bytesIn(reqs(this.c('resetIdentity', { otkCount })), ['rootSecret']);
  }

  revokeContactAccess(peer: string): any {
    return reqs(this.c('revokeContactAccess', { peer }));
  }

  revokeDevice(deviceId: string): any {
    return reqs(this.c('revokeDevice', { deviceId }));
  }

  rotateSsk(): Array<any> {
    return reqs(this.c('rotateSsk', {}));
  }

  selfAddress(): string {
    return text(this.c('selfAddress', {}));
  }

  sessionProof(tsMs: number): Uint8Array {
    return u(this.c('sessionProof', { tsMs }));
  }

  setPeerDeliveryKey(user: string, key: Uint8Array, generation: bigint): void {
    this.c('setPeerDeliveryKey', { user, key: b(key), generation: Number(generation) });
  }

  shareDeliveryKey(peer: string): Array<any> {
    return reqs(this.c('shareDeliveryKey', { peer }));
  }

  shareGroupsWithOwnDevices(devicesJson: string): Array<any> {
    return reqs(this.c('shareGroupsWithOwnDevices', { devicesJson }));
  }

  shareInviteLinks(groupHex: string, linksJson: string, recipientsJson: string): Array<any> {
    return reqs(this.c('shareInviteLinks', { group: groupHex, linksJson, recipientsJson }));
  }

  sharePlannerWithOwnDevices(): Array<any> {
    return reqs(this.c('sharePlannerWithOwnDevices', {}));
  }

  signOutDevice(deviceId: string): any {
    return reqs(this.c('signOutDevice', { deviceId }));
  }

  syncRequest(): any {
    return reqs(this.c('syncRequest', {}));
  }

  takeSharedInvites(): string {
    return text(this.c('takeSharedInvites', {}));
  }

  tokenBatchSize(): number {
    return this.c('tokenBatchSize', {}) as number;
  }

  tokenCount(): number {
    return this.c('tokenCount', {}) as number;
  }

  tokenCountFor(domain: string): number {
    return this.c('tokenCountFor', { domain }) as number;
  }

  tokenRefillDue(): boolean {
    return this.c('tokenRefillDue', {}) as boolean;
  }

  tokenRefillDueDomains(): Array<any> {
    return reqs(this.c('tokenRefillDueDomains', {}));
  }

  tokenRefillDueFor(domain: string): boolean {
    return this.c('tokenRefillDueFor', { domain }) as boolean;
  }

  tokenRequest(keyListResponse: Uint8Array, serverKey: Uint8Array, count: number): any {
    return reqs(this.c('tokenRequest', { keyListResponse: b(keyListResponse), serverKey: b(serverKey), count }));
  }

  tokenRequestFor(domain: string, keyListResponse: Uint8Array, serverKey: Uint8Array, count: number): any {
    return reqs(this.c('tokenRequestFor', {
      domain, keyListResponse: b(keyListResponse), serverKey: b(serverKey), count,
    }));
  }

  tokenResponse(resp: Uint8Array): number {
    return this.c('tokenResponse', { resp: b(resp) }) as number;
  }

  tokenResponseFor(domain: string, resp: Uint8Array): number {
    return this.c('tokenResponseFor', { domain, resp: b(resp) }) as number;
  }
}
