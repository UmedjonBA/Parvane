//! Тесты шарда domains на временной SQLite (без NATS: владельцы ключей
//! подставляются в кэш вместо identity).

use std::sync::atomic::{AtomicU32, Ordering};

use ed25519_dalek::SigningKey;
use parvane_protocol::codec::decode_checked;
use parvane_protocol::domain::{self, no_groups, sample, Author, ContainerAccess, Grantee, Stamp};
use parvane_protocol::limits::Origin;
use parvane_protocol::pb::parvane::core::v2::{
    Container, ContainerOp, DomainContainerCreateRequest, DomainContainerCreateResponse, DomainContainerGetRequest,
    DomainContainerGetResponse, DomainGrantListRequest, DomainGrantListResponse, DomainGrantRevokeRequest,
    DomainGrantRevokeResponse, DomainGrantSetRequest, DomainOpAppendRequest, DomainOpAppendResponse, DomainOpSyncRequest,
    DomainOpSyncResponse, DomainSnapshotGetRequest, DomainSnapshotGetResponse, DomainSnapshotPutRequest, ErrorCode,
    GrantLevel, Ref, ShardRequest,
};
use parvane_protocol::pb::parvane::sample::v1::SampleOp;
use parvane_protocol::sign;
use prost::Message;

use crate::store::{self, Domains};

static N: AtomicU32 = AtomicU32::new(0);

async fn setup() -> Domains {
    let dir = std::env::temp_dir().join(format!("parvane-domains-test-{}-{}", std::process::id(), N.fetch_add(1, Ordering::SeqCst)));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let pool = store::open_store(dir.join("domains.db").to_str().unwrap()).await.unwrap();
    assert!(dir.join("domains.db-v2.db").exists());
    Domains::new(pool, None, "local".into())
}

fn device(d: &Domains, user: &str, id: &str) -> SigningKey {
    let k = sign::generate_signing_key();
    d.remember_key(k.verifying_key().to_bytes(), Author { user: user.into(), device_id: id.into() });
    k
}

async fn call<M: Message>(d: &Domains, user: &str, method: &str, msg: &M) -> Result<Vec<u8>, ErrorCode> {
    let req = ShardRequest { method: method.into(), user: user.into(), device_id: "d1".into(), body: msg.encode_to_vec(), ..Default::default() };
    // Ответ разбирается клиентом с проверкой лимитов (как от сервера).
    d.dispatch(method, req).await
}

fn resp<M: Message + prost::Name + Default>(b: Vec<u8>) -> M {
    decode_checked(&b, Origin::Server).unwrap()
}

fn op(key: &SigningKey, c: &Container, epoch: u64, k: &[u8; 32], lamport: u64, dev: &str, val: &str) -> ContainerOp {
    let pt = SampleOp { entries: vec![sample::set("k", val.as_bytes(), &Stamp::new(lamport, dev))] }.encode_to_vec();
    domain::seal_op(key, c, epoch, k, &pt, 1).unwrap()
}

async fn append(d: &Domains, user: &str, o: &ContainerOp) -> Result<u64, ErrorCode> {
    call(d, user, "domain.op.append", &DomainOpAppendRequest { op: Some(o.clone()) }).await.map(|b| resp::<DomainOpAppendResponse>(b).seq)
}

async fn sync(d: &Domains, user: &str, c: &Ref, after: u64, max_bytes: u32) -> Result<DomainOpSyncResponse, ErrorCode> {
    call(d, user, "domain.op.sync", &DomainOpSyncRequest { container: Some(c.clone()), after_seq: after, max_bytes }).await.map(resp)
}

async fn access_of(d: &Domains, user: &str, c: &Ref, keys: &[(&SigningKey, &str)]) -> ContainerAccess {
    let r: DomainGrantListResponse = resp(call(d, user, "domain.grant.list", &DomainGrantListRequest { container: Some(c.clone()), after_version: 0 }).await.unwrap());
    let map: Vec<([u8; 32], String)> = keys.iter().map(|(k, u)| (k.verifying_key().to_bytes(), u.to_string())).collect();
    let resolve = |k: &[u8; 32]| map.iter().find(|(x, _)| x == k).map(|(_, u)| Author { user: u.clone(), device_id: String::new() });
    ContainerAccess::replay(r.genesis.as_ref().unwrap(), &r.entries, &resolve, &no_groups).unwrap()
}

#[tokio::test]
async fn container_grants_and_revoke() {
    let d = setup().await;
    let alice = device(&d, "alice@local", "a1");
    let bob = device(&d, "bob@local", "b1");
    let eve = device(&d, "eve@local", "e1");

    // Создание: генезис владельца.
    let (c, genesis) = domain::new_container(&alice, "local", sample::DOMAIN_NAME, "alice@local", 1).unwrap();
    let cref = c.r#ref.clone().unwrap();
    let create = DomainContainerCreateRequest { genesis: Some(genesis.clone()) };
    let r: DomainContainerCreateResponse = resp(call(&d, "alice@local", "domain.container.create", &create).await.unwrap());
    assert_eq!(r.container.unwrap().key_epoch, 1);
    assert_eq!(call(&d, "alice@local", "domain.container.create", &create).await, Err(ErrorCode::Duplicate));
    // Чужая сессия не создаёт контейнер от имени alice.
    let (_, g2) = domain::new_container(&alice, "local", sample::DOMAIN_NAME, "alice@local", 1).unwrap();
    assert_eq!(call(&d, "bob@local", "domain.container.create", &DomainContainerCreateRequest { genesis: Some(g2) }).await, Err(ErrorCode::Forbidden));
    // Генезис с подписью чужого устройства — отказ.
    let (_, g3) = domain::new_container(&eve, "local", sample::DOMAIN_NAME, "alice@local", 1).unwrap();
    assert_eq!(call(&d, "alice@local", "domain.container.create", &DomainContainerCreateRequest { genesis: Some(g3) }).await, Err(ErrorCode::Forbidden));
    // Контейнер чужого домена — федерации нет.
    let (_, g4) = domain::new_container(&alice, "other.example", sample::DOMAIN_NAME, "alice@local", 1).unwrap();
    assert_eq!(call(&d, "alice@local", "domain.container.create", &DomainContainerCreateRequest { genesis: Some(g4) }).await, Err(ErrorCode::FederationUnavailable));

    let k1 = domain::new_epoch_key();
    assert_eq!(append(&d, "alice@local", &op(&alice, &c, 1, &k1, 1, "a1", "v1")).await, Ok(1));
    assert_eq!(append(&d, "alice@local", &op(&alice, &c, 1, &k1, 2, "a1", "v2")).await, Ok(2));
    // Повтор op_id — DUPLICATE, seq не расходуется.
    let o3 = op(&alice, &c, 1, &k1, 3, "a1", "v3");
    assert_eq!(append(&d, "alice@local", &o3).await, Ok(3));
    assert_eq!(append(&d, "alice@local", &o3).await, Err(ErrorCode::Duplicate));
    // seq ставит только сервер.
    let mut with_seq = op(&alice, &c, 1, &k1, 4, "a1", "x");
    with_seq.seq = 77;
    assert_eq!(append(&d, "alice@local", &with_seq).await, Err(ErrorCode::Invalid));
    // Изменённый шифртекст — дайджест не сходится.
    let mut bad = op(&alice, &c, 1, &k1, 4, "a1", "x");
    bad.aead_ciphertext[20] ^= 1;
    assert_eq!(append(&d, "alice@local", &bad).await, Err(ErrorCode::Invalid));
    // Подпись чужим устройством от имени alice.
    assert_eq!(append(&d, "alice@local", &op(&eve, &c, 1, &k1, 4, "e1", "x")).await, Err(ErrorCode::Forbidden));

    // Без гранта контейнер «не существует».
    assert_eq!(sync(&d, "bob@local", &cref, 0, 0).await.err(), Some(ErrorCode::NotFound));
    assert_eq!(append(&d, "bob@local", &op(&bob, &c, 1, &k1, 5, "b1", "x")).await, Err(ErrorCode::NotFound));

    // Грант read: синхронизация есть, записи нет.
    let acc = access_of(&d, "alice@local", &cref, &[(&alice, "alice@local")]).await;
    let bob_g = Grantee::User("bob@local".into());
    let g_read = domain::sign_grant(&alice, &acc, &bob_g, GrantLevel::Read, 2).unwrap();
    call(&d, "alice@local", "domain.grant.set", &DomainGrantSetRequest { grant: Some(g_read.clone()) }).await.unwrap();
    // Повтор записи — цепочка уже ушла вперёд.
    assert_eq!(call(&d, "alice@local", "domain.grant.set", &DomainGrantSetRequest { grant: Some(g_read) }).await, Err(ErrorCode::Invalid));
    let s = sync(&d, "bob@local", &cref, 0, 0).await.unwrap();
    assert_eq!(s.ops.iter().map(|o| o.seq).collect::<Vec<_>>(), vec![1, 2, 3]);
    assert!(!s.more);
    assert_eq!(append(&d, "bob@local", &op(&bob, &c, 1, &k1, 5, "b1", "x")).await, Err(ErrorCode::Forbidden));
    // Читатель не выдаёт гранты.
    let acc = access_of(&d, "bob@local", &cref, &[(&alice, "alice@local")]).await;
    let g_bad = domain::sign_grant(&bob, &acc, &bob_g, GrantLevel::Admin, 3).unwrap();
    assert_eq!(call(&d, "bob@local", "domain.grant.set", &DomainGrantSetRequest { grant: Some(g_bad) }).await, Err(ErrorCode::Forbidden));

    // Повышение до write: bob пишет.
    let g_write = domain::sign_grant(&alice, &acc, &bob_g, GrantLevel::Write, 3).unwrap();
    call(&d, "alice@local", "domain.grant.set", &DomainGrantSetRequest { grant: Some(g_write) }).await.unwrap();
    assert_eq!(append(&d, "bob@local", &op(&bob, &c, 1, &k1, 5, "b1", "bob")).await, Ok(4));
    let got: DomainContainerGetResponse = resp(call(&d, "bob@local", "domain.container.get", &DomainContainerGetRequest { container: Some(cref.clone()) }).await.unwrap());
    assert_eq!((got.level, got.head_seq, got.grant_version), (GrantLevel::Write as i32, 4, 2));

    // Отзыв: новая эпоха 2; старая эпоха больше не принимается; bob вне доступа.
    let acc = access_of(&d, "alice@local", &cref, &[(&alice, "alice@local")]).await;
    // revoke-запись через grant.set не проходит.
    let rv = domain::sign_revoke(&alice, &acc, &bob_g, 4).unwrap();
    assert_eq!(call(&d, "alice@local", "domain.grant.set", &DomainGrantSetRequest { grant: Some(rv.clone()) }).await, Err(ErrorCode::Invalid));
    let r: DomainGrantRevokeResponse = resp(call(&d, "alice@local", "domain.grant.revoke", &DomainGrantRevokeRequest { grant: Some(rv) }).await.unwrap());
    assert_eq!((r.version, r.key_epoch), (3, 2));
    assert_eq!(append(&d, "alice@local", &op(&alice, &c, 1, &k1, 6, "a1", "old")).await, Err(ErrorCode::Expired));
    let k2 = domain::new_epoch_key();
    assert_eq!(append(&d, "alice@local", &op(&alice, &c, 2, &k2, 6, "a1", "new")).await, Ok(5));
    assert_eq!(sync(&d, "bob@local", &cref, 0, 0).await.err(), Some(ErrorCode::NotFound));
    assert_eq!(append(&d, "bob@local", &op(&bob, &c, 2, &k2, 7, "b1", "x")).await, Err(ErrorCode::NotFound));

    // Журнал грантов с сервера сводится клиентским движком в то же состояние.
    let acc = access_of(&d, "alice@local", &cref, &[(&alice, "alice@local")]).await;
    assert_eq!((acc.version, acc.epoch), (3, 2));
    assert!(acc.grants.is_empty());
}

#[tokio::test]
async fn sync_budget_and_snapshots() {
    let d = setup().await;
    let alice = device(&d, "alice@local", "a1");
    let bob = device(&d, "bob@local", "b1");
    let (c, genesis) = domain::new_container(&alice, "local", sample::DOMAIN_NAME, "alice@local", 1).unwrap();
    let cref = c.r#ref.clone().unwrap();
    call(&d, "alice@local", "domain.container.create", &DomainContainerCreateRequest { genesis: Some(genesis) }).await.unwrap();
    let k1 = domain::new_epoch_key();
    for i in 1..=10u64 {
        append(&d, "alice@local", &op(&alice, &c, 1, &k1, i, "a1", &"x".repeat(1000))).await.unwrap();
    }
    // Бюджет ~2 операции на страницу: постраничный догон без пропусков.
    let one = sync(&d, "alice@local", &cref, 0, 0).await.unwrap().ops[0].encoded_len() as u32;
    let mut after = 0;
    let mut seen = Vec::new();
    loop {
        let p = sync(&d, "alice@local", &cref, after, one * 2 + 10).await.unwrap();
        assert!(p.ops.len() <= 2 && !p.ops.is_empty());
        seen.extend(p.ops.iter().map(|o| o.seq));
        after = p.ops.last().unwrap().seq;
        if !p.more {
            break;
        }
    }
    assert_eq!(seen, (1..=10).collect::<Vec<_>>());

    // Снимок: только в пределах журнала, открывается ключом эпохи.
    let empty: DomainSnapshotGetResponse = resp(call(&d, "alice@local", "domain.snapshot.get", &DomainSnapshotGetRequest { container: Some(cref.clone()) }).await.unwrap());
    assert!(empty.snapshot.is_none());
    let too_far = domain::seal_snapshot(&alice, &c, 1, &k1, 11, b"s", 1).unwrap();
    assert_eq!(call(&d, "alice@local", "domain.snapshot.put", &DomainSnapshotPutRequest { snapshot: Some(too_far) }).await, Err(ErrorCode::Invalid));
    let s8 = domain::seal_snapshot(&alice, &c, 1, &k1, 8, b"state@8", 1).unwrap();
    call(&d, "alice@local", "domain.snapshot.put", &DomainSnapshotPutRequest { snapshot: Some(s8) }).await.unwrap();
    // Более старый снимок не затирает свежий.
    let s5 = domain::seal_snapshot(&alice, &c, 1, &k1, 5, b"state@5", 1).unwrap();
    call(&d, "alice@local", "domain.snapshot.put", &DomainSnapshotPutRequest { snapshot: Some(s5) }).await.unwrap();
    let got: DomainSnapshotGetResponse = resp(call(&d, "alice@local", "domain.snapshot.get", &DomainSnapshotGetRequest { container: Some(cref.clone()) }).await.unwrap());
    let snap = got.snapshot.unwrap();
    assert_eq!(snap.upto_seq, 8);
    assert_eq!(domain::open_snapshot(&snap, &c, &k1).unwrap().as_slice(), b"state@8");
    // Без доступа снимок не отдаётся.
    assert_eq!(call(&d, "bob@local", "domain.snapshot.get", &DomainSnapshotGetRequest { container: Some(cref.clone()) }).await, Err(ErrorCode::NotFound));
    let s_bob = domain::seal_snapshot(&bob, &c, 1, &k1, 8, b"x", 1).unwrap();
    assert_eq!(call(&d, "bob@local", "domain.snapshot.put", &DomainSnapshotPutRequest { snapshot: Some(s_bob) }).await, Err(ErrorCode::NotFound));
}

#[tokio::test]
async fn session_required() {
    let d = setup().await;
    let req = ShardRequest { method: "domain.op.sync".into(), body: DomainOpSyncRequest::default().encode_to_vec(), ..Default::default() };
    assert_eq!(d.dispatch("domain.op.sync", req).await, Err(ErrorCode::Forbidden));
    // Все методы реестра роли "domains" обслуживаются.
    let names: Vec<&str> = parvane_v2rt::methods_of("domains").iter().map(|m| m.name).collect();
    assert_eq!(names.len(), 11, "{names:?}");
    for n in names {
        let req = ShardRequest { method: n.into(), user: "alice@local".into(), device_id: "d1".into(), body: vec![], ..Default::default() };
        assert_ne!(d.dispatch(n, req).await, Err(ErrorCode::Unavailable), "{n}");
    }
}

#[tokio::test]
async fn key_rotate_and_container_list() {
    use parvane_protocol::pb::parvane::core::v2::{DomainContainerListRequest, DomainContainerListResponse, DomainKeyRotateRequest, DomainKeyRotateResponse};
    let d = setup().await;
    let alice = device(&d, "alice@local", "a1");
    let bob = device(&d, "bob@local", "b1");
    let (c, genesis) = domain::new_container(&alice, "local", "parvane.planner.v1", "alice@local", 1).unwrap();
    let cref = c.r#ref.clone().unwrap();
    call(&d, "alice@local", "domain.container.create", &DomainContainerCreateRequest { genesis: Some(genesis) }).await.unwrap();
    let k1 = domain::new_epoch_key();
    assert_eq!(append(&d, "alice@local", &op(&alice, &c, 1, &k1, 1, "a1", "v1")).await, Ok(1));

    // Список: владельцу виден, чужому — пусто, другой домен — пусто, негодное имя — INVALID.
    let list = |user: &'static str, dom: &'static str| {
        let d = &d;
        async move {
            let r: DomainContainerListResponse = resp(call(d, user, "domain.container.list", &DomainContainerListRequest { domain: dom.into() }).await.unwrap());
            r.containers
        }
    };
    let mine = list("alice@local", "parvane.planner.v1").await;
    assert_eq!(mine.len(), 1);
    assert_eq!(mine[0].r#ref.as_ref(), Some(&cref));
    assert_eq!(mine[0].key_epoch, 1);
    assert!(list("bob@local", "parvane.planner.v1").await.is_empty());
    assert!(list("alice@local", "sample.v1").await.is_empty());
    assert_eq!(call(&d, "alice@local", "domain.container.list", &DomainContainerListRequest { domain: "Bad Name".into() }).await, Err(ErrorCode::Invalid));

    // Смена эпохи без грантов: только админ; старая эпоха закрыта для новых операций.
    let acc = access_of(&d, "alice@local", &cref, &[(&alice, "alice@local")]).await;
    let bad = domain::sign_rotate(&bob, &acc, 2).unwrap();
    assert_eq!(call(&d, "bob@local", "domain.key.rotate", &DomainKeyRotateRequest { rotate: Some(bad) }).await, Err(ErrorCode::NotFound));
    // Запись «rotate» через grant.set — отказ (не тот вид).
    let rot = domain::sign_rotate(&alice, &acc, 2).unwrap();
    assert_eq!(call(&d, "alice@local", "domain.grant.set", &DomainGrantSetRequest { grant: Some(rot.clone()) }).await, Err(ErrorCode::Invalid));
    let r: DomainKeyRotateResponse = resp(call(&d, "alice@local", "domain.key.rotate", &DomainKeyRotateRequest { rotate: Some(rot.clone()) }).await.unwrap());
    assert_eq!((r.version, r.key_epoch), (1, 2));
    // Повтор той же записи — цепочка ушла вперёд.
    assert_eq!(call(&d, "alice@local", "domain.key.rotate", &DomainKeyRotateRequest { rotate: Some(rot) }).await, Err(ErrorCode::Invalid));
    assert_eq!(append(&d, "alice@local", &op(&alice, &c, 1, &k1, 2, "a1", "old")).await, Err(ErrorCode::Expired));
    let k2 = domain::new_epoch_key();
    assert_eq!(append(&d, "alice@local", &op(&alice, &c, 2, &k2, 2, "a1", "new")).await, Ok(2));
    // Журнал грантов с сервера сводится клиентом в ту же эпоху; грантов по-прежнему нет; владелец читает обе эпохи.
    let acc = access_of(&d, "alice@local", &cref, &[(&alice, "alice@local")]).await;
    assert_eq!((acc.version, acc.epoch), (1, 2));
    assert!(acc.grants.is_empty());
    assert!(acc.could_write_at("alice@local", 1, &no_groups) && acc.could_write_at("alice@local", 2, &no_groups));
    // Список отражает новую эпоху.
    assert_eq!(list("alice@local", "parvane.planner.v1").await[0].key_epoch, 2);
}
