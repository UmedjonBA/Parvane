//! Юнит-тесты шарда федерации (spec 028); межсерверный обмен целиком —
//! живой тест `parvane-integration --test v2_federation_live` на двух стеках.

use parvane_protocol::codec::decode_checked;
use parvane_protocol::federation::TrustedServer;
use parvane_protocol::limits::Origin;
use parvane_protocol::pb::parvane::core::v2::{KeyOwnerResponse, ServerDescriptor};
use prost::Message;

use crate::outbound::scope_key_owner;
use crate::peers::endpoint_of;

fn trusted(domain: &str, endpoint: &str) -> TrustedServer {
    TrustedServer {
        domain: domain.into(),
        server_key: [1; 32],
        descriptor: ServerDescriptor { domain: domain.into(), s2s_endpoint: endpoint.into(), ..Default::default() },
    }
}

#[test]
fn endpoint_from_descriptor_only_for_own_host_over_https() {
    let base = "https://b.example";
    // Нестандартный порт своего хоста — да (прод на 20443).
    assert_eq!(endpoint_of(&trusted("b.example", "https://b.example:20443"), base), "https://b.example:20443");
    assert_eq!(endpoint_of(&trusted("b.example", "https://B.Example:20443/"), base), "https://B.Example:20443");
    // Чужой хост, http, путь — нет: иначе сервер отправлял бы других на третьи хосты.
    for bad in ["https://evil.example", "http://b.example:20443", "https://b.example/x", "https://b.example?q=1", "not a url", ""] {
        assert_eq!(endpoint_of(&trusted("b.example", bad), base), base, "{bad}");
    }
}

#[test]
fn key_owner_answer_is_limited_to_the_asked_domain() {
    let resp = |user: &str, aliases: &[&str]| {
        KeyOwnerResponse { found: true, user: user.into(), aliases: aliases.iter().map(|a| a.to_string()).collect(), ..Default::default() }
            .encode_to_vec()
    };
    let r: KeyOwnerResponse = decode_checked(&scope_key_owner(&resp("bob@b.example", &["old@b.example", "eve@c.example"]), "b.example"), Origin::Server).unwrap();
    assert_eq!((r.found, r.user.as_str(), r.aliases), (true, "bob@b.example", vec!["old@b.example".to_string()]));
    // Сервер B не может назвать владельцем пользователя другого домена.
    let r: KeyOwnerResponse = decode_checked(&scope_key_owner(&resp("anya@a.example", &[]), "b.example"), Origin::Server).unwrap();
    assert!(!r.found);
}

#[test]
fn config_parses_endpoints_and_blocklist() {
    std::env::set_var("PARVANE_FEDERATION_ENDPOINTS", "B.Example=https://b.example:20443/ , c.test=http://127.0.0.1:9");
    std::env::set_var("PARVANE_FEDERATION_BLOCK", "Spam.Example, ,x.test");
    std::env::set_var("PARVANE_FEDERATION", "on");
    std::env::set_var("PARVANE_FEDERATION_INSECURE_HTTP", "1");
    let c = crate::config::Config::from_env();
    assert!(c.enabled);
    assert_eq!(c.endpoints.get("b.example").map(String::as_str), Some("https://b.example:20443"));
    assert_eq!(c.endpoints.get("c.test").map(String::as_str), Some("http://127.0.0.1:9"));
    assert!(c.blocked.contains("spam.example") && c.blocked.contains("x.test") && c.blocked.len() == 2);
    // Без фичи сборки тестовый транспорт не включается переменной окружения.
    assert_eq!(c.insecure_http, cfg!(feature = "insecure-test-transport"));
}

#[tokio::test]
async fn domain_bucket_limits_bursts() {
    let cfg = crate::config::Config {
        enabled: true,
        domain: "own.example".into(),
        bind: "127.0.0.1:0".into(),
        endpoints: Default::default(),
        blocked: Default::default(),
        rate_burst: 3.0,
        rate_per_sec: 0.001,
        insecure_http: false,
        well_known_file: None,
    };
    let pool = sqlx::sqlite::SqlitePoolOptions::new().connect("sqlite::memory:").await.unwrap();
    let Ok(nc) = async_nats::ConnectOptions::new().retry_on_initial_connect().connect("nats://127.0.0.1:1").await else { return };
    let fed = crate::peers::Fed::new(cfg, pool, nc);
    assert!((0..3).all(|_| fed.admit("a.example")));
    assert!(!fed.admit("a.example"), "сверх запаса — отказ");
    assert!(fed.admit("b.example"), "другой домен — своя корзина");
}

/// Тестовый транспорт без TLS не попадает в образ прода и в деплой (R16).
#[test]
fn insecure_transport_never_ships() {
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../infra/deploy");
    for f in ["Dockerfile.shards", "deploy.sh", "docker-compose.yml"] {
        let text = std::fs::read_to_string(root.join(f)).unwrap_or_default();
        assert!(!text.is_empty(), "{f} не прочитан");
        assert!(!text.contains("insecure-test-transport"), "{f}: фича тестового транспорта");
        assert!(!text.contains("PARVANE_FEDERATION_INSECURE_HTTP"), "{f}: тестовый транспорт");
    }
}

#[tokio::test]
async fn failed_discovery_is_remembered_and_rate_limited() {
    let cfg = crate::config::Config {
        enabled: true,
        domain: "own.example".into(),
        bind: "127.0.0.1:0".into(),
        endpoints: Default::default(),
        blocked: Default::default(),
        rate_burst: 3.0,
        rate_per_sec: 1.0,
        insecure_http: false,
        well_known_file: None,
    };
    let pool = sqlx::sqlite::SqlitePoolOptions::new().connect("sqlite::memory:").await.unwrap();
    let Ok(nc) = async_nats::ConnectOptions::new().retry_on_initial_connect().connect("nats://127.0.0.1:1").await else { return };
    let fed = crate::peers::Fed::new(cfg, pool, nc);
    assert!(fed.discovery_allowed("junk.example").is_ok());
    fed.discovery_failed("junk.example");
    assert!(fed.discovery_allowed("junk.example").is_err(), "неудачное обнаружение не повторяется сразу");
    // Общий счётчик: поток разных доменов упирается в предел обращений в минуту.
    let denied = (0..200).filter(|i| fed.discovery_allowed(&format!("d{i}.example")).is_err()).count();
    assert!(denied > 0, "обращения за описателем ограничены");
}

fn test_cfg(endpoints: &[(&str, &str)]) -> crate::config::Config {
    crate::config::Config {
        enabled: true,
        domain: "own.example".into(),
        bind: "127.0.0.1:0".into(),
        endpoints: endpoints.iter().map(|(d, b)| (d.to_string(), b.to_string())).collect(),
        blocked: Default::default(),
        rate_burst: 3.0,
        rate_per_sec: 1.0,
        insecure_http: false,
        well_known_file: None,
    }
}

async fn migrated_pool(tag: &str) -> sqlx::SqlitePool {
    let path = std::env::temp_dir().join(format!("pv-fed-test-{tag}-{}-{}.db", std::process::id(), crate::peers::now_ms()));
    crate::store::open(path.to_str().unwrap()).await.unwrap()
}

/// S7-14: одна мёртвая сторона с сотнями готовых писем не занимает всю выборку тика; отказ откладывает
/// весь домен.
#[tokio::test]
async fn outbox_due_serves_every_domain() {
    let pool = migrated_pool("outbox").await;
    for _ in 0..300 {
        assert!(crate::store::outbox_put(&pool, "dead.example", b"x", 1).await.unwrap());
    }
    assert!(crate::store::outbox_put(&pool, "ok.example", b"y", 2).await.unwrap());
    let rows = crate::store::outbox_due(&pool, 10, 256, 8).await.unwrap();
    assert!(rows.iter().any(|r| r.1 == "ok.example"), "здоровый домен попал в выборку");
    assert!(rows.iter().filter(|r| r.1 == "dead.example").count() <= 8);
    crate::store::outbox_defer_dest(&pool, "dead.example", 1_000).await.unwrap();
    let rows = crate::store::outbox_due(&pool, 10, 256, 8).await.unwrap();
    assert_eq!(rows.iter().map(|r| r.1.as_str()).collect::<Vec<_>>(), vec!["ok.example"], "мёртвый домен отложен целиком");
}

/// S7-15: бюджет обнаружения, выеденный случайными доменами, не останавливает связь с закреплённым
/// сервером (просроченный кэш → прежний описатель и закреплённый ключ); анонимный и входящий бюджеты
/// отдельно от бюджета вошедших.
#[tokio::test]
async fn pinned_peer_survives_exhausted_discovery() {
    // Точка обнаружения — loopback по https: фильтр адресов отвергает её сразу (сеть не нужна).
    let pool = migrated_pool("pinned").await;
    let Ok(nc) = async_nats::ConnectOptions::new().retry_on_initial_connect().connect("nats://127.0.0.1:1").await else { return };
    let fed = crate::peers::Fed::new(test_cfg(&[("peer.example", "https://127.0.0.1:1"), ("peer2.example", "https://127.0.0.1:1")]), pool.clone(), nc);
    crate::store::pin(&pool, "peer.example", &[7; 32], 1).await.unwrap();
    fed.insert_stale_peer("peer.example", [7; 32]).await;
    let used = (0..60).filter(|i| fed.discovery_allowed(&format!("r{i}.example")).is_ok()).count();
    assert_eq!(used, 60);
    assert!(fed.discovery_allowed("one-more.example").is_err(), "бюджет вошедших исчерпан");
    let p = fed.trust("peer.example").await.expect("закреплённый сервер доступен без бюджета");
    assert_eq!(p.trusted.server_key, [7; 32]);
    // Закреплённый без кэша (после перезапуска) — по закреплённому ключу.
    crate::store::pin(&pool, "peer2.example", &[8; 32], 1).await.unwrap();
    assert_eq!(fed.trust("peer2.example").await.map(|p| p.trusted.server_key).ok(), Some([8; 32]));
    // Анонимный бюджет свой.
    assert!(fed.discovery_allowed_as("anon.example", crate::peers::Discover::Anon).is_ok());
    // Лимит на IP для входящих.
    let ip: std::net::IpAddr = "203.0.113.5".parse().unwrap();
    let n = (0..20).filter(|_| fed.discovery_ip_allowed(ip)).count();
    assert_eq!(n, 6, "не больше 6 обнаружений в минуту с одного IP");
    assert!(fed.discovery_ip_allowed("203.0.113.6".parse().unwrap()));
}

#[test]
fn client_ip_trusts_forwarded_only_from_proxy() {
    use crate::inbound::client_ip;
    let caddy: std::net::IpAddr = "172.18.0.5".parse().unwrap();
    let public: std::net::IpAddr = "198.51.100.1".parse().unwrap();
    assert_eq!(client_ip(caddy, Some("1.2.3.4, 203.0.113.9")), "203.0.113.9".parse::<std::net::IpAddr>().unwrap());
    assert_eq!(client_ip(public, Some("203.0.113.9")), public, "заголовок от не-прокси не верим");
    assert_eq!(client_ip(caddy, None), caddy);
}

/// S7-17: медленные тела закрываются по сроку, сверх 32 одновременных непроверенных — 503.
#[tokio::test]
async fn slow_bodies_are_bounded() {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let pool = migrated_pool("slow").await;
    let Ok(nc) = async_nats::ConnectOptions::new().retry_on_initial_connect().connect("nats://127.0.0.1:1").await else { return };
    let fed = crate::peers::Fed::new(test_cfg(&[]), pool, nc);
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(crate::inbound::serve_listener(fed, listener));
    let head = "POST /_parvane/s2s HTTP/1.1\r\nHost: x\r\nContent-Length: 100000\r\n\r\nA";
    let mut conns = vec![];
    for _ in 0..32 {
        let mut c = tokio::net::TcpStream::connect(addr).await.unwrap();
        c.write_all(head.as_bytes()).await.unwrap();
        conns.push(c);
    }
    tokio::time::sleep(std::time::Duration::from_millis(300)).await;
    let mut extra = tokio::net::TcpStream::connect(addr).await.unwrap();
    extra.write_all(head.as_bytes()).await.unwrap();
    let mut buf = [0u8; 64];
    let n = tokio::time::timeout(std::time::Duration::from_secs(2), extra.read(&mut buf)).await.expect("33-й ответ сразу").unwrap();
    assert!(String::from_utf8_lossy(&buf[..n]).starts_with("HTTP/1.1 503"), "33-й — 503");
    let started = std::time::Instant::now();
    for mut c in conns {
        let mut b = vec![];
        let r = tokio::time::timeout(std::time::Duration::from_secs(9), c.read_to_end(&mut b)).await;
        assert!(r.is_ok(), "медленное тело закрыто по сроку");
    }
    assert!(started.elapsed() < std::time::Duration::from_secs(10));
}

/// PV-015: кусок к соседу несёт номер куска блоба от шарда (окно gateway S7-13 начинается с 16, 32…),
/// а не порядковый номер с 0; кусок не по порядку — ошибка со следующим номером.
#[test]
fn stream_relay_keeps_blob_chunk_numbers() {
    use crate::inbound::ChunkRelay;
    use parvane_protocol::pb::parvane::core::v2::ShardStreamChunk;
    let chunk = |index: u32, last: bool| ShardStreamChunk { index, last, data: vec![index as u8], error: None };
    let mut r = ChunkRelay::default();
    let out: Vec<_> = (16..32).map(|i| r.next(Some(chunk(i, i == 31)))).collect();
    assert_eq!(out.iter().map(|c| c.index).collect::<Vec<_>>(), (16..32).collect::<Vec<_>>());
    assert!(out.iter().all(|c| c.error.is_none()));
    assert_eq!(out.iter().filter(|c| c.last).count(), 1);
    // Пропуск у шарда — ошибка с ожидаемым номером.
    let mut r = ChunkRelay::default();
    assert_eq!(r.next(Some(chunk(40, false))).index, 40);
    let bad = r.next(Some(chunk(42, false)));
    assert!(bad.error.is_some() && bad.last && bad.index == 41, "{bad:?}");
    // Сбой шины до первого куска — ошибка, поток кончается.
    let mut r = ChunkRelay::default();
    let gone = r.next(None);
    assert!(gone.error.is_some() && gone.last);
}
