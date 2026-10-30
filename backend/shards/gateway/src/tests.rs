//! Тесты gateway: адрес клиента за прокси, лимиты (v1-путь удалён — T110).

use crate::*;

#[test]
fn client_ip_trusts_forwarded_only_from_proxy() {
    let lo: IpAddr = "127.0.0.1".parse().unwrap();
    let pub_ip: IpAddr = "8.8.8.8".parse().unwrap();
    assert_eq!(client_ip_from(Some(lo), Some("203.0.113.5, 10.0.0.1")), "203.0.113.5");
    assert_eq!(client_ip_from(Some(lo), Some("garbage")), "127.0.0.1");
    assert_eq!(client_ip_from(Some(pub_ip), Some("203.0.113.5")), "8.8.8.8", "от публичного пира заголовку не верим");
    assert_eq!(client_ip_from(None, Some("203.0.113.5")), "");
}

#[test]
fn token_bucket_bursts_then_refills() {
    let mut bucket = TokenBucket::new(3.0, 1.0);
    let t0 = Instant::now();
    assert!(bucket.try_take_at(t0));
    assert!(bucket.try_take_at(t0));
    assert!(bucket.try_take_at(t0));
    assert!(!bucket.try_take_at(t0), "всплеск исчерпан");
    assert!(bucket.try_take_at(t0 + Duration::from_secs(1)), "пополнение по времени");
}

#[test]
fn anonymous_idle_is_short() {
    assert!(anon_idle_secs() <= 60, "анонимное соединение не живёт сутками (GW-02)");
    assert_eq!(V1_UPGRADE_REQUIRED, "upgrade_required");
}

#[test]
fn proxy_peer_is_capped_only_by_total_limit() {
    // GW-02: адрес пира-прокси (Caddy) не делится на «клиентов» квотой «на IP»; публичный пир — делится.
    let limits = Limits {
        conns: Arc::new(Semaphore::new(100)),
        per_ip: Arc::new(Mutex::new(HashMap::new())),
        max_per_ip: 2,
        per_client: Arc::new(Mutex::new(HashMap::new())),
        max_per_client: 2,
    };
    let proxy: IpAddr = "10.0.0.2".parse().unwrap();
    let _g: Vec<_> = (0..5).map(|_| admit(&limits, proxy, true).unwrap()).collect();
    assert!(admit(&limits, proxy, false).is_none(), "без прокси квота «на IP» действует и для приватного адреса");
    let direct: IpAddr = "8.8.8.8".parse().unwrap();
    let _d1 = admit(&limits, direct, true).unwrap();
    let _d2 = admit(&limits, direct, true).unwrap();
    assert!(admit(&limits, direct, true).is_none());
}

#[test]
fn per_client_limit_counts_forwarded_address() {
    // GW-01: за прокси адрес пира один; лимит считается по адресу клиента из X-Forwarded-For.
    let limits = Limits {
        conns: Arc::new(Semaphore::new(10)),
        per_ip: Arc::new(Mutex::new(HashMap::new())),
        max_per_ip: 10,
        per_client: Arc::new(Mutex::new(HashMap::new())),
        max_per_client: 2,
    };
    let proxy: IpAddr = "10.0.0.1".parse().unwrap();
    let g1 = admit_client(&limits, Some(proxy), "203.0.113.5").unwrap();
    let _g2 = admit_client(&limits, Some(proxy), "203.0.113.5").unwrap();
    assert!(admit_client(&limits, Some(proxy), "203.0.113.5").is_err(), "третье соединение одного клиента");
    assert!(admit_client(&limits, Some(proxy), "203.0.113.6").is_ok(), "другой клиент за тем же прокси");
    drop(g1);
    assert!(admit_client(&limits, Some(proxy), "203.0.113.5").is_ok(), "слот освобождается при закрытии");
    // Прямое подключение уже учтено в admit и повторно не считается.
    assert!(matches!(admit_client(&limits, Some(proxy), "10.0.0.1"), Ok(None)));
}
