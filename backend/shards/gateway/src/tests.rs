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
