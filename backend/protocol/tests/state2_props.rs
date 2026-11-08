//! spec 035 T031 (US2, FR-016): свойство сведения личного состояния v2 — при любом порядке, повторах и
//! разбиении записей (часть журнала → снимок → остальное; две половины → слияние снимков) итог побайтно один
//! (`snapshot_bytes`), отказы одни и те же. ≥ 2000 случайных испытаний на смеси видов объектов, операций всех
//! видов, неизвестных видов операций и заведомо плохих операций.

use parvane_protocol::pb::parvane::state::v2::{
    state_op::Op, Create, Delete, FieldValue, Mark, ObjectKey, ObjectKind, Patch, SetAdd, SetRemove, StateOp,
};
use parvane_protocol::state2::State2;
use prost::Message;
use rand::rngs::StdRng;
use rand::seq::SliceRandom;
use rand::{Rng, SeedableRng};

const TRIALS: usize = 2000;

fn key(kind: ObjectKind, k: &str) -> Option<ObjectKey> {
    Some(ObjectKey { kind: kind as i32, key: k.into() })
}

/// Байты поля с тегом: string/bytes-поле `field` со значением `v`.
fn str_field(field: u32, v: &[u8]) -> Vec<u8> {
    let mut out = Vec::new();
    prost::encoding::encode_key(field, prost::encoding::WireType::LengthDelimited, &mut out);
    prost::encoding::encode_varint(v.len() as u64, &mut out);
    out.extend_from_slice(v);
    out
}

fn peer(addr: &str) -> Vec<u8> {
    use parvane_protocol::pb::parvane::core::v2::UserRef;
    use parvane_protocol::pb::parvane::state::v1::{peer, Peer};
    Peer { kind: Some(peer::Kind::User(UserRef { address: addr.into() })) }.encode_to_vec()
}

fn random_op(rng: &mut StdRng, i: usize) -> Vec<u8> {
    let objects = [
        key(ObjectKind::Folder, "5"),
        key(ObjectKind::Folder, "6"),
        key(ObjectKind::Contact, "bob@x"),
        key(ObjectKind::Scheduled, "000000000000000000000000000000aa"),
        key(ObjectKind::ChatCleared, "u:bob@x"),
        key(ObjectKind::Archive, "u:carol@x"),
    ];
    let object = objects.choose(rng).cloned().flatten();
    let kind = object.as_ref().map(|o| o.kind).unwrap_or(0);
    // Поля значения вида: у папки 2 title, 3 emoticon, 50 — неизвестное; у контакта 2, 3, 4.
    let fields: &[u32] = if kind == ObjectKind::Folder as i32 { &[2, 3, 50] } else { &[2, 3, 4] };
    let words: [&[u8]; 4] = [b"a", b"b", b"cc", b""];
    let fv = |rng: &mut StdRng| {
        let f = *fields.choose(rng).unwrap();
        FieldValue { field: f, value: str_field(f, words.choose(rng).unwrap()) }
    };
    let elems = ["a@x", "b@x", "c@x"];
    let op = match rng.gen_range(0..9) {
        0 => Some(Op::Create(Create { object, set: (0..rng.gen_range(0..2)).map(|_| fv(rng)).collect() })),
        1 | 2 => {
            let set = vec![fv(rng)];
            let clear = if rng.gen_bool(0.3) { vec![*fields.choose(rng).unwrap()] } else { vec![] };
            Some(Op::Patch(Patch { object, set, clear }))
        }
        3 => Some(Op::Delete(Delete { object })),
        4 => Some(Op::SetAdd(SetAdd { object, field: 4, element: peer(elems.choose(rng).unwrap()) })),
        5 => Some(Op::SetRemove(SetRemove { object, field: 4, element: peer(elems.choose(rng).unwrap()) })),
        6 => {
            let v: u32 = rng.gen_range(1..300);
            let value = v.to_be_bytes().iter().copied().skip_while(|b| *b == 0).collect();
            Some(Op::Mark(Mark { object, field: if kind == ObjectKind::ChatCleared as i32 { 2 } else { 1 }, value }))
        }
        _ => None,
    };
    let lamport = if rng.gen_ratio(1, 40) { 0 } else { rng.gen_range(1..12) };
    let device = ["d1", "d2", "d3"].choose(rng).unwrap().to_string();
    let mut op_id = [0u8; 16];
    // Повтор op_id у разных операций — тоже допустимый вход (сводится одинаково).
    op_id[15] = (i % 7) as u8;
    op_id[14] = rng.gen_range(0..3);
    let mut bytes = StateOp { op_id: op_id.to_vec(), lamport, device_id: device, ts_ms: 0, op }.encode_to_vec();
    if rng.gen_ratio(1, 15) {
        // Неизвестный обычный вид операции (поле 900, пусто).
        bytes.extend_from_slice(&[0xa2, 0x38, 0x00]);
    }
    bytes
}

fn apply_all(st: &mut State2, ops: &[(usize, Vec<u8>)]) -> std::collections::BTreeSet<usize> {
    let mut rejected = std::collections::BTreeSet::new();
    for (i, b) in ops {
        if st.apply_bytes(b).is_err() {
            rejected.insert(*i);
        }
    }
    rejected
}

#[test]
fn any_order_repeats_and_splits_give_one_snapshot() {
    let mut rng = StdRng::seed_from_u64(0x0350_0035);
    let mut nonempty = 0usize;
    for trial in 0..TRIALS {
        let n = rng.gen_range(1..14);
        let ops: Vec<(usize, Vec<u8>)> = (0..n).map(|i| (i, random_op(&mut rng, i))).collect();
        let mut base = State2::new();
        let base_rej = apply_all(&mut base, &ops);
        let want = base.snapshot_bytes();
        if !base.view().is_empty() {
            nonempty += 1;
        }

        // Перестановка с повторами.
        let mut shuffled = ops.clone();
        for _ in 0..rng.gen_range(0..4) {
            let dup = ops.choose(&mut rng).unwrap().clone();
            shuffled.push(dup);
        }
        shuffled.shuffle(&mut rng);
        let mut st = State2::new();
        assert_eq!(apply_all(&mut st, &shuffled), base_rej, "испытание {trial}: отказы при перестановке");
        assert_eq!(st.snapshot_bytes(), want, "испытание {trial}: снимок при перестановке");
        assert_eq!(st.max_lamport(), base.max_lamport());

        // Разбиение: часть → снимок → загрузка → остальное.
        let cut = rng.gen_range(0..=shuffled.len());
        let mut first = State2::new();
        apply_all(&mut first, &shuffled[..cut]);
        let mut resumed = State2::from_snapshot_bytes(&first.snapshot_bytes()).expect("снимок читается");
        apply_all(&mut resumed, &shuffled[cut..]);
        assert_eq!(resumed.snapshot_bytes(), want, "испытание {trial}: снимок после разбиения");

        // Две половины на разных устройствах → слияние снимков.
        let (a, b) = shuffled.split_at(cut);
        let mut sa = State2::new();
        apply_all(&mut sa, a);
        let mut sb = State2::new();
        apply_all(&mut sb, b);
        sa.merge(&sb);
        assert_eq!(sa.snapshot_bytes(), want, "испытание {trial}: слияние половин");
    }
    assert!(nonempty > TRIALS / 2, "генератор почти не даёт видимых объектов: {nonempty}");
}
