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
        max_onion: 2,
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
        max_onion: 2,
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

/// S7-18: IPv6 считается сетью /64 (и в квоте соединений, и в метке для identity); клиенты Tor (метка от прокси)
/// — своя корзина с отдельным потолком, а не адрес прокси 127.0.0.1 на всех.
#[test]
fn ipv6_counts_by_64_and_onion_has_own_bucket() {
    let limits = Limits {
        conns: Arc::new(Semaphore::new(100)),
        per_ip: Arc::new(Mutex::new(HashMap::new())),
        max_per_ip: 2,
        per_client: Arc::new(Mutex::new(HashMap::new())),
        max_per_client: 2,
        max_onion: 3,
    };
    // Прямые соединения: разные адреса одной /64 — одна квота
    let a: IpAddr = "2001:db8:1:2::1".parse().unwrap();
    let b: IpAddr = "2001:db8:1:2:ffff::9".parse().unwrap();
    let other: IpAddr = "2001:db8:1:3::1".parse().unwrap();
    let _g1 = admit(&limits, a, false).unwrap();
    let _g2 = admit(&limits, b, false).unwrap();
    assert!(admit(&limits, "2001:db8:1:2::77".parse().unwrap(), false).is_none(), "третий адрес той же /64");
    assert!(admit(&limits, other, false).is_some(), "другая /64");
    // За прокси: то же по адресу клиента
    let proxy: IpAddr = "10.0.0.1".parse().unwrap();
    let _c1 = admit_client(&limits, Some(proxy), "2001:db8:5:6::1").unwrap();
    let _c2 = admit_client(&limits, Some(proxy), "2001:db8:5:6::2").unwrap();
    assert!(admit_client(&limits, Some(proxy), "2001:db8:5:6::3").is_err());
    // Метка для лимитов identity
    assert_eq!(limit_label("2001:db8:5:6:1:2:3:4"), "2001:db8:5:6::/64");
    assert_eq!(limit_label("::ffff:198.51.100.7"), "198.51.100.7");
    assert_eq!(limit_label("203.0.113.5"), "203.0.113.5");
    assert_eq!(limit_label(ONION_CLIENT), ONION_CLIENT);
    // Tor: метку ставит только прокси; у Tor своя корзина и потолок
    let lo: IpAddr = "127.0.0.1".parse().unwrap();
    assert_eq!(client_ip_from_hdr(Some(lo), Some("127.0.0.1"), true), ONION_CLIENT);
    assert_eq!(client_ip_from_hdr(Some("8.8.8.8".parse().unwrap()), None, true), "8.8.8.8", "от публичного пира метке не верим");
    let tor: Vec<_> = (0..3).map(|_| admit_client(&limits, Some(lo), ONION_CLIENT).unwrap()).collect();
    assert!(tor.iter().all(Option::is_some));
    assert!(admit_client(&limits, Some(lo), ONION_CLIENT).is_err(), "потолок Tor");
    assert!(admit_client(&limits, Some(lo), "198.51.100.7").is_ok(), "обычный клиент за тем же прокси не задет");
}
