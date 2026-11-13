// spec 036 T019: личное состояние web по видам — объекты модели (без снимка формы `state.v1`) и выбор записей
// `stateSet`/`stateMark` (как desktop `stateview::setsFor`). Данные выдуманные.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';

import type { ModelRequest, ModelSender, StateModel } from './engine';
import type { StateObject } from './stateObjects';

import {
  decodeMessage, encodeMessage, initSync, PvEngine,
} from '../../../lib/parvane-protocol/parvane_protocol';
import { MemoryModelStore, ModelHost, openStateModel } from './engine';
import {
  carriedObjects, hasPersonalState, K, markBytes, markValue, objectsOf, objectsOfKinds, peerKeyOf, peerOfKey,
  planStateWrites, valueOf,
} from './stateObjects';

const GROUP_HEX = '0f'.repeat(16);
const GROUP_B64 = btoa(String.fromCharCode(...Array(16).fill(0x0f)));
const OP_B64 = btoa(String.fromCharCode(...Array(16).fill(0xab)));
const OP_HEX = 'ab'.repeat(16);
const BOB = { user: { address: 'bob@local' } };
const GROUP = { group: { domain: 'local', id: GROUP_B64 } };

function folder(id: number, title: string) {
  return { id, title, include_peers: [BOB] };
}

function o(kind: string, key: string, value?: Record<string, unknown>, marks?: StateObject['marks']): StateObject {
  return {
    kind, key, ...(value ? { value } : {}), ...(marks ? { marks } : {}),
  };
}

const f = (id: number, title: string) => o(K.folder, String(id), folder(id, title));

/** Как `stateJournal.ts writeKinds`: объекты вида → записи → модель. */
async function apply(model: StateModel, desired: StateObject[], opts: {
  kinds?: string[]; prune?: boolean; rewrite?: boolean; base?: StateObject[];
} = {}) {
  await model.write(planStateWrites({ desired, current: model.objects(), ...opts }));
}

describe('stateObjects: ключи и отметки как у движка', () => {
  it('ключ собеседника туда и обратно', () => {
    expect(peerKeyOf(BOB)).toBe('u:bob@local');
    expect(peerKeyOf(GROUP)).toBe(`g:local:${GROUP_HEX}`);
    expect(peerOfKey(`g:local:${GROUP_HEX}`)).toEqual(GROUP);
    expect(peerOfKey('u:bob@local')).toEqual(BOB);
    expect(peerOfKey('5')).toBeUndefined();
  });

  it('показ по видам: наборы и GIF одним списком, значение признака — {}', () => {
    const view = {
      objects: [
        o(K.stickerPack, 'p:x', { set_id: 'p:x' }),
        o(K.archive, 'u:bob@local', {}),
        o(K.savedGif, 'g:abc', { set_id: 'g:abc' }),
      ],
    };
    expect(objectsOfKinds(view, [K.stickerPack, K.savedGif]).map((x) => x.key)).toEqual(['p:x', 'g:abc']);
    expect(objectsOf(view, 'ARCHIVE').map((x) => peerOfKey(x.key))).toEqual([BOB]);
    expect(valueOf(undefined)).toEqual({});
  });

  it('личное состояние в показе и перенос под новый ключ', () => {
    expect(hasPersonalState({ objects: [o(K.favedSticker, 'a', {})] })).toBe(false);
    expect(hasPersonalState({ objects: [o(K.chatCleared, 'u:bob@local', {}, [{ field: 2, value: markBytes(0) }])] }))
      .toBe(false);
    expect(hasPersonalState({ objects: [o(K.archive, 'u:bob@local', {})] })).toBe(true);
    const carried = carriedObjects({
      objects: [
        o(K.folder, '5', folder(5, 'Работа'), []),
        o(K.scheduled, OP_HEX, { op_id: OP_B64 }, [{ field: 1, value: markBytes(1) }]),
        o(K.scheduled, 'cd'.repeat(16), {}, []),
        o(K.chatCleared, 'u:bob@local', {}, [{ field: 2, value: markBytes(1234) }]),
        o(K.favedSticker, 'x', { set_id: 'x' }, []),
        o('OBJECT_KIND_UNKNOWN_FUTURE', 'z', { a: 1 }, []),
      ],
    });
    expect(carried.map((x) => `${x.kind}|${x.key}|${x.value ? 'v' : '-'}`)).toEqual([
      `${K.folder}|5|v`, `${K.scheduled}|${OP_HEX}|-`, `${K.chatCleared}|u:bob@local|-`, `${K.favedSticker}|x|v`,
    ]);
    expect(markValue(carried[2], 2)).toBe(BigInt(1234));
  });
});

describe('stateObjects: что переписать', () => {
  const shown = [f(5, 'Работа'), f(6, 'Дом')];
  const current: StateObject[] = [
    { kind: K.folder, key: '0', value: { id: 0 } },
    { kind: K.folder, key: '5', value: folder(5, 'Работа+') },
    { kind: K.folder, key: '6', value: folder(6, 'Дом') },
    { kind: K.folder, key: '7', value: folder(7, 'Чужая') },
  ];

  it('с показанным: только правленное хостом, с base; удаляется только показанное', () => {
    const { sets, marks } = planStateWrites({
      desired: [f(5, 'Работа'), f(8, 'Новая')],
      current,
      base: shown,
      kinds: ['folders'],
      prune: true,
    });
    expect(marks).toEqual([]);
    // Папку 5 хост не правил (переименование другого устройства не откатывается), 6 убрал, 8 создал, 7 и 0 не трогал
    expect(sets).toEqual([
      { kind: K.folder, key: '8', value: folder(8, 'Новая') },
      { kind: K.folder, key: '6', delete: true },
    ]);
  });

  it('правка показанного — с base; без показанного — разница с моделью', () => {
    const edited = planStateWrites({
      desired: [f(6, 'Дача')], current, base: shown, kinds: ['folders'],
    });
    expect(edited.sets).toEqual([{
      kind: K.folder, key: '6', value: folder(6, 'Дача'), base: folder(6, 'Дом'),
    }]);
    const plain = planStateWrites({ desired: [f(6, 'Дом'), f(5, 'Работа')], current });
    expect(plain.sets).toEqual([{ kind: K.folder, key: '5', value: folder(5, 'Работа') }]);
  });

  it('удалённое другим устройством не воскрешается, если хост его не правил', () => {
    const { sets } = planStateWrites({
      desired: [f(9, 'Старая')],
      current,
      base: [f(9, 'Старая')],
      kinds: ['folders'],
    });
    expect(sets).toEqual([]);
  });

  it('отложенное: отправленное не трогается, отметка — только новее', () => {
    const sentNow: StateObject[] = [
      { kind: K.scheduled, key: OP_HEX, value: { op_id: OP_B64 }, marks: [{ field: 1, value: markBytes(1) }] },
      { kind: K.chatCleared, key: 'u:bob@local', value: {}, marks: [{ field: 2, value: markBytes(500) }] },
    ];
    const { sets, marks } = planStateWrites({
      desired: [
        o(K.scheduled, OP_HEX, { op_id: OP_B64, send_at_ms: '1' }),
        o(K.chatCleared, 'u:bob@local', undefined, [{ field: 2, value: markBytes(400) }]),
      ],
      current: sentNow,
      kinds: ['scheduled'],
      prune: true,
    });
    expect(sets).toEqual([]);
    expect(marks).toEqual([]);
    const later = planStateWrites({
      desired: [o(K.chatCleared, 'u:bob@local', undefined, [{ field: 2, value: markBytes(600) }])], current: sentNow,
    });
    expect(later.marks).toEqual([{
      kind: K.chatCleared, key: 'u:bob@local', field: 2, value: markBytes(600),
    }]);
  });

  it('rewrite — все объекты целиком', () => {
    const { sets } = planStateWrites({ desired: shown, current, rewrite: true });
    expect(sets.map((s) => [s.key, s.rewrite])).toEqual([['5', true], ['6', true]]);
  });

  it('закреп: правится только основной список, архивный не удаляется; «Все чаты» и архив папок не удаляются', () => {
    const pins: StateObject[] = [
      o(K.pinList, '1', { list: 'PIN_LIST_MAIN', peers: [BOB] }),
      o(K.pinList, '2', { list: 'PIN_LIST_ARCHIVE', peers: [GROUP] }),
    ];
    const { sets } = planStateWrites({
      desired: [o(K.pinList, '1', { list: 'PIN_LIST_MAIN', peers: [] })], current: pins, base: pins, kinds: ['pinned'],
      prune: true,
    });
    expect(sets).toEqual([{
      kind: K.pinList, key: '1', value: { list: 'PIN_LIST_MAIN', peers: [] }, base: pins[0].value,
    }]);
    const folders = planStateWrites({ desired: [], current, kinds: ['folders'], prune: true });
    expect(folders.sets.map((s) => s.key)).toEqual(['5', '6', '7']);
  });

  it('объект без ключа пропускается, одиночка — с пустым ключом; одинаковый ключ — последний', () => {
    const { sets } = planStateWrites({
      desired: [
        o(K.contact, '', { note: 'x' }), o(K.quickReaction, '', { emoji: '👍' }),
        o(K.archive, 'u:bob@local', {}), o(K.archive, 'u:bob@local', { x: 1 }),
      ],
      current: [],
    });
    expect(sets.map((s) => `${s.kind}|${s.key}`)).toEqual([`${K.quickReaction}|`, `${K.archive}|u:bob@local`]);
    expect(sets[1].value).toEqual({ x: 1 });
  });
});

// Тот же путь через модель движка (WASM): показ `viewStateJson`, запись `stateSet`/`stateMark`
describe('openStateModel: личное состояние через модель по видам', () => {
  beforeAll(() => {
    initSync({ module: readFileSync(path.join(process.cwd(), 'src/lib/parvane-protocol/parvane_protocol_bg.wasm')) });
  });

  async function open() {
    const sent: string[] = [];
    const { host } = await ModelHost.open({
      user: 'alice@local',
      device_id: 'd1',
      domain: 'local',
      now_ms: '1800000000000',
      vectors: true,
      device_key: btoa(String.fromCharCode(...Array(32).fill(7))),
    }, { store: new MemoryModelStore(), send: (r) => sent.push(r.method) }, (cfg) => PvEngine.open(cfg));
    const sender = { failures: () => 0, idle: () => Promise.resolve() } as unknown as ModelSender;
    const model = openStateModel({ host, sender, subscribe: () => undefined });
    return { host, model, sent };
  }

  it('объекты вида → модель; показ по видам; правка другого устройства не откатывается', async () => {
    const { host, model, sent } = await open();
    await apply(model, [
      f(5, 'Работа'),
      o(K.archive, 'u:bob@local', {}),
      o(K.pinList, '1', { list: 'PIN_LIST_MAIN', peers: [BOB] }),
      o(K.quickReaction, '', { emoji: '👍' }),
    ], { kinds: ['folders', 'archived', 'pinned', 'reaction'], prune: true });
    expect(sent).toContain('state.ops.append');
    const shown = model.view();
    expect(shown.write_blocked).toBe(false);
    expect(valueOf(objectsOf(shown, K.folder)[0]).title).toBe('Работа');
    expect(objectsOf(shown, K.archive).map((x) => peerOfKey(x.key))).toEqual([BOB]);
    expect(valueOf(objectsOf(shown, K.quickReaction)[0])).toEqual({ emoji: '👍' });
    expect(valueOf(objectsOf(shown, K.pinList)[0]).peers).toEqual([BOB]);
    // «Другое устройство» переименовало папку после показа; хост добавил чат по показанному и разархивировал
    await apply(model, [f(5, 'Работа+дом')], { kinds: ['folders'] });
    const base = [...objectsOf(shown, K.folder), ...objectsOf(shown, K.archive)];
    await apply(model, [o(K.folder, '5', { ...folder(5, 'Работа'), include_peers: [BOB, GROUP] })], {
      kinds: ['folders', 'archived'], prune: true, base,
    });
    const after = model.view();
    const edited = valueOf(objectsOf(after, K.folder)[0]);
    expect(edited.title).toBe('Работа+дом');
    expect(edited.include_peers).toHaveLength(2);
    expect(objectsOf(after, K.archive)).toEqual([]);
    // Отметка очистки и «отправлено»
    await apply(model, [
      o(K.chatCleared, 'u:bob@local', undefined, [{ field: 2, value: markBytes(1700000000000) }]),
      o(K.scheduled, OP_HEX, undefined, [{ field: 1, value: markBytes(1) }]),
    ]);
    const marked = model.view();
    expect(markValue(objectsOf(marked, K.chatCleared)[0], 2)).toBe(BigInt(1700000000000));
    expect(markValue(objectsOf(marked, K.scheduled)[0], 1)).toBe(BigInt(1));
    // То же ещё раз — без записи; rewrite (перенос под новый ключ) — запись
    sent.length = 0;
    await apply(model, model.objects());
    expect(sent).not.toContain('state.ops.append');
    await apply(model, carriedObjects(model.view()), { rewrite: true });
    expect(sent).toContain('state.ops.append');
    host.close();
  });
});

describe('openStateModel: показанное равно желаемому — записи нет', () => {
  beforeAll(() => {
    initSync({ module: readFileSync(path.join(process.cwd(), 'src/lib/parvane-protocol/parvane_protocol_bg.wasm')) });
  });

  // Каждая отправка писала `stateSet PIN_LIST:1`: желаемое хоста (`peers: []`, поля по умолчанию явно) и показ модели
  // (proto3-JSON опускает пустые и умолчания) сравнивались по форме и «отличались» всегда
  it('пустой закреп и поля по умолчанию не дают записи при повторе', async () => {
    const sent: string[] = [];
    const logs: string[] = [];
    const { host } = await ModelHost.open({
      user: 'alice@local',
      device_id: 'd1',
      domain: 'local',
      now_ms: '1800000000000',
      vectors: true,
      device_key: btoa(String.fromCharCode(...Array(32).fill(7))),
    }, {
      store: new MemoryModelStore(), send: (r) => sent.push(r.method), log: (m) => logs.push(m),
    }, (cfg) => PvEngine.open(cfg));
    const sender = { failures: () => 0, idle: () => Promise.resolve() } as unknown as ModelSender;
    const model = openStateModel({ host, sender, subscribe: () => undefined });
    const desired = [
      o(K.pinList, '1', { list: 'PIN_LIST_MAIN', peers: [] }),
      o(K.archive, 'u:bob@local', {}),
      o(K.quickReaction, '', { emoji: '👍' }),
    ];
    await apply(model, desired, { kinds: ['pinned', 'archived', 'reaction'] });
    // Повтор — и с показанным (`base` — показ модели, как `flushDirty`): ни записи, ни `stateSet`
    sent.length = 0;
    logs.length = 0;
    await apply(model, desired, { kinds: ['pinned', 'archived', 'reaction'] });
    await apply(model, desired, { kinds: ['pinned', 'archived', 'reaction'], base: model.objects() });
    expect(sent).not.toContain('state.ops.append');
    expect(logs.filter((m) => m.includes('личное состояние —'))).toEqual([]);
    host.close();
  });
});

// Два устройства одного аккаунта через журнал «сервера» в памяти (как прежний `model_state_v1.rs` движка): признак без значения
// (`UNREAD_MARK`), поставленный на одном, снимается на другом — и снятие доходит до первого (пара state-sync)
describe('openStateModel: два устройства, признак «непрочитано»', () => {
  type Rec = { seq: string; op_id: string; aead_ciphertext: string };
  const MANAGED = ['folders', 'blocked', 'drafts', 'scheduled', 'archived', 'pinned', 'notify', 'unread', 'reaction',
    'packs', 'contacts'];

  beforeAll(() => {
    initSync({ module: readFileSync(path.join(process.cwd(), 'src/lib/parvane-protocol/parvane_protocol_bg.wasm')) });
  });

  function bytesOf(text?: string) {
    return Uint8Array.from(atob(text || ''), (c) => c.charCodeAt(0));
  }

  async function openPair() {
    const records: Rec[] = [];
    const config = {
      user: 'bob@local',
      device_id: 'd1',
      domain: 'local',
      now_ms: '1800000000000',
      vectors: true,
      device_key: btoa(String.fromCharCode(...Array(32).fill(9))),
    };
    const store = new MemoryModelStore();
    const device = async (from: MemoryModelStore) => {
      const queue: ModelRequest[] = [];
      const { host } = await ModelHost.open(config, { store: from, send: (r) => queue.push(r) },
        (cfg) => PvEngine.open(cfg));
      const sender = { failures: () => 0, idle: () => Promise.resolve() } as unknown as ModelSender;
      const model = openStateModel({ host, sender, subscribe: () => undefined });
      // Ответы «сервера» на запросы модели, пока они есть
      const pump = async () => {
        while (queue.length) {
          const r = queue.shift()!;
          let resp = new Uint8Array(0);
          if (r.method === 'state.ops.append') {
            const req = JSON.parse(decodeMessage('parvane.state.v2.AppendRequest', bytesOf(r.body))) as Rec;
            if (!records.some((x) => x.op_id === req.op_id)) {
              records.push({ seq: String(records.length + 1), op_id: req.op_id, aead_ciphertext: req.aead_ciphertext });
            }
            resp = encodeMessage('parvane.state.v2.AppendResponse', JSON.stringify({ seq: String(records.length) }));
          } else if (r.method === 'state.ops.sync') {
            const req = JSON.parse(decodeMessage('parvane.state.v2.SyncRequest', bytesOf(r.body))) as {
              after_seq?: string;
            };
            const after = Number(req.after_seq || 0);
            resp = encodeMessage('parvane.state.v2.SyncResponse',
              JSON.stringify({ records: records.filter((x) => Number(x.seq) > after) }));
          }
          await host.ingestResponse(r.req_id, resp, 0);
        }
      };
      const sync = async () => {
        await pump();
        await model.sync();
        await pump();
      };
      return { host, model, pump, sync };
    };
    const a = await device(store);
    await a.host.flush();
    // Второе устройство — тот же ключ личного состояния (копия профиля до первой записи)
    const copy = new MemoryModelStore();
    store.data.forEach((v, k) => copy.data.set(k, v));
    const b = await device(copy);
    return { a, b, records };
  }

  it('снятие отметки на втором устройстве доходит до первого', async () => {
    const { a, b } = await openPair();
    await a.sync();
    await b.sync();
    // Первое ставит отметку (показанное до правки — пустой снимок)
    const marks = (m: StateModel) => objectsOf(m.view(), K.unreadMark).map((x) => peerOfKey(x.key));
    const unreadOf = (peers: typeof BOB[]) => peers.map((p) => o(K.unreadMark, peerKeyOf(p), {}));
    // Первое ставит отметку (показанное до правки — пусто)
    let shownA = a.model.objects();
    await apply(a.model, unreadOf([BOB]), { kinds: MANAGED, prune: true, base: shownA });
    await a.pump();
    await a.sync();
    shownA = a.model.objects();
    expect(marks(a.model)).toEqual([BOB]);
    // Второе видит её и снимает
    await b.sync();
    expect(marks(b.model)).toEqual([BOB]);
    await apply(b.model, unreadOf([]), { kinds: MANAGED, prune: true, base: b.model.objects() });
    await b.pump();
    expect(marks(b.model)).toEqual([]);
    // Первое: своя запись до догона (как `syncNow`: flushLocal → pullRemote), затем показ
    await apply(a.model, unreadOf([BOB]), { kinds: MANAGED, prune: true, base: shownA });
    await a.pump();
    await a.sync();
    expect(marks(a.model)).toEqual([]);
    a.host.close();
    b.host.close();
  });
});
