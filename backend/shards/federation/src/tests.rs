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
