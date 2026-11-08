//! spec 035 T053 (US5, FR-030): подписанное хранится и пересылается исходными байтами. Подпись `SignedOp`
//! покрывает `body` — байты `OpBody`, которые движок не пересобирает: неизвестное поле заголовка операции и
//! полезной нагрузки (запись журнала устройств, запись журнала группы, операция домена) переживает разбор,
//! проверку и повторное кодирование `SignedOp`, подпись сходится. Неизвестное поле на уровне самого
//! `SignedOp`/`GroupStateEntry` при пересборке теряется (prost его не хранит) — поэтому хост хранит
//! полученные байты записи как есть; тест фиксирует обе стороны.

use ed25519_dalek::SigningKey;
use parvane_protocol::identity::{self, DeviceLog, RootIdentity};
use parvane_protocol::pb::parvane::core::v2::{GroupStateEntry, OpBody, SignedOp};
use parvane_protocol::sign;
use prost::Message;

const USER: &str = "alice@x";

/// Дописать неизвестное поле `number` (строка) в байты сообщения.
fn with_unknown(mut b: Vec<u8>, number: u32) -> Vec<u8> {
    prost::encoding::string::encode(number, &"будущее".to_string(), &mut b);
    b
}

#[test]
fn device_log_entry_with_unknown_fields_round_trips_bytewise() {
    let root = RootIdentity::generate(USER).unwrap();
    let genesis = root.genesis_entry().unwrap();
    // Подписываем запись, в чьём OpBody и полезной нагрузке есть неизвестные поля (подписант будущего).
    let body = OpBody::decode(genesis.body.as_slice()).unwrap();
    let payload = with_unknown(body.payload.clone(), 90);
    let mut header_bytes = body.header.clone().unwrap().encode_to_vec();
    header_bytes = with_unknown(header_bytes, 91);
    let mut body_bytes = Vec::new();
    prost::encoding::bytes::encode(1, &header_bytes, &mut body_bytes);
    prost::encoding::bytes::encode(2, &payload, &mut body_bytes);
    body_bytes = with_unknown(body_bytes, 92);
    // Подпись — тем же ключом корня над новыми байтами (как сделал бы движок будущего).
    let resigned = sign_raw_like(&genesis, &root, &body_bytes);
    // Разбор и повторное кодирование SignedOp: body — те же байты, подпись сходится.
    let wire = resigned.encode_to_vec();
    let parsed = SignedOp::decode(wire.as_slice()).unwrap();
    assert_eq!(parsed.body, body_bytes, "body — исходные байты, включая неизвестное");
    assert_eq!(parsed.encode_to_vec(), wire, "SignedOp без неизвестного верхнего уровня — побайтно тот же");
    let mut log = DeviceLog::new(USER).unwrap();
    log.apply(&parsed).expect("журнал устройств принимает запись с неизвестными полями");
    assert_eq!(identity::device_log_hash(&parsed), identity::device_log_hash(&resigned), "хеш цепочки — по исходным байтам");
}

/// Подписать `body_bytes` ключом подписанта записи-образца (та же схема подписи, что `sign::sign_op`).
fn sign_raw_like(sample: &SignedOp, root: &RootIdentity, body_bytes: &[u8]) -> SignedOp {
    use sign::OpSigner;
    let key: &SigningKey = &root.root;
    assert_eq!(key.verifying_key().to_bytes().to_vec(), sample.signer_key);
    let h = OpBody::decode(sample.body.as_slice()).unwrap().header.unwrap();
    let msg = sign::op_signing_bytes(&h.domain, &h.op_type, body_bytes).unwrap();
    SignedOp { body: body_bytes.to_vec(), signature: key.sign_bytes(&msg).to_vec(), signer_key: key.public_key().to_vec() }
}

#[test]
fn unknown_top_level_field_is_lost_on_reencode_so_hosts_keep_raw_bytes() {
    let root = RootIdentity::generate(USER).unwrap();
    let genesis = root.genesis_entry().unwrap();
    let wire = with_unknown(genesis.encode_to_vec(), 15);
    let parsed = SignedOp::decode(wire.as_slice()).unwrap();
    assert_ne!(parsed.encode_to_vec(), wire, "пересборка теряет неизвестное поле SignedOp — хранить исходные байты");
    // Подпись при этом не задета (она над body).
    let mut log = DeviceLog::new(USER).unwrap();
    log.apply(&parsed).unwrap();
    // То же у записи журнала группы.
    let entry = GroupStateEntry { version: 1, change: Some(genesis), ..Default::default() };
    let wire = with_unknown(entry.encode_to_vec(), 15);
    assert_ne!(GroupStateEntry::decode(wire.as_slice()).unwrap().encode_to_vec(), wire);
}
