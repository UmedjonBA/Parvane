//! Общий SSRF-фильтр исходящих запросов (spec 007 T106, инвариант класса 14).
//!
//! Один фильтр адресов назначения для всех мест, где шард ходит наружу по
//! адресу, пришедшему от клиента: превью ссылок (preview), endpoint'ы web-push
//! (push), будущая федерация. Правила:
//! - адрес назначения — только публичный: запрещены loopback, private, link-local,
//!   CGNAT, multicast, broadcast, документационные, служебные и
//!   зарезервированные диапазоны v4 и v6, unique-local, site-local, NAT64,
//!   IPv4-compatible; у IPv4-mapped, 6to4 и Teredo проверяется вложенный v4;
//! - имена `localhost`/`*.local`/однословные хосты отвергаются до резолва;
//! - резолв fail-closed: если ХОТЬ ОДИН адрес непубличный — отказ целиком
//!   (split-horizon DNS, rebinding), а проверенные адреса фиксируются в
//!   HTTP-клиенте (`pinned_client_builder`) — повторного резолва нет;
//! - HTTP-клиент без прокси из окружения и без автоматических редиректов;
//!   редиректы вызывающий проходит сам, не больше [`MAX_REDIRECTS`], каждый хоп
//!   снова через [`follow_redirect`] + [`resolve_url`].
//!
//! Тестовый набор адресов — ниже в `tests`, общий для всех потребителей.

use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};
use std::time::Duration;

pub use url::Url;

/// Максимум редиректов на один исходящий запрос.
pub const MAX_REDIRECTS: u8 = 3;

/// Дедлайн резолва имени.
pub const DNS_TIMEOUT: Duration = Duration::from_secs(5);

/// Причина отказа. Текст (`Display`) — короткий код, безопасный для клиента:
/// ни адресов, ни имён хостов в нём нет.
#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum GuardError {
    #[error("invalid url")]
    InvalidUrl,
    #[error("unsupported_scheme")]
    UnsupportedScheme,
    #[error("blocked_port")]
    BlockedPort,
    #[error("blocked_userinfo")]
    Userinfo,
    #[error("no host")]
    NoHost,
    #[error("blocked_host")]
    BlockedHost,
    #[error("blocked_private_ip")]
    BlockedIp,
    #[error("dns resolve failed")]
    Dns,
    #[error("no dns records")]
    NoRecords,
}

/// Что разрешено «по месту»: схемы и порты адреса назначения.
#[derive(Debug, Clone, Copy)]
pub struct UrlPolicy {
    pub schemes: &'static [&'static str],
    /// Пусто — любой порт.
    pub ports: &'static [u16],
}

impl UrlPolicy {
    /// Превью ссылок: http/https только на стандартных портах.
    pub const LINK: UrlPolicy = UrlPolicy { schemes: &["http", "https"], ports: &[80, 443] };
    /// Endpoint web-push и подобные: только https, порт любой.
    pub const HTTPS: UrlPolicy = UrlPolicy { schemes: &["https"], ports: &[] };
}

/// Разобрать и проверить URL назначения без резолва: схема и порт по
/// политике, без userinfo, хост не служебное имя, IP-литерал — публичный.
pub fn check_url(input: &str, policy: &UrlPolicy) -> Result<Url, GuardError> {
    let url = Url::parse(input).map_err(|_| GuardError::InvalidUrl)?;
    check_parsed(&url, policy)?;
    Ok(url)
}

/// То же для уже разобранного URL (очередной хоп редиректа).
pub fn check_parsed(url: &Url, policy: &UrlPolicy) -> Result<(), GuardError> {
    if !policy.schemes.contains(&url.scheme()) {
        return Err(GuardError::UnsupportedScheme);
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err(GuardError::Userinfo);
    }
    let port = url.port_or_known_default().ok_or(GuardError::BlockedPort)?;
    if !policy.ports.is_empty() && !policy.ports.contains(&port) {
        return Err(GuardError::BlockedPort);
    }
    match url.host() {
        None => Err(GuardError::NoHost),
        Some(url::Host::Ipv4(v4)) => public_or_blocked(IpAddr::V4(v4)),
        Some(url::Host::Ipv6(v6)) => public_or_blocked(IpAddr::V6(v6)),
        Some(url::Host::Domain(d)) => {
            if host_name_blocked(d) {
                Err(GuardError::BlockedHost)
            } else {
                Ok(())
            }
        }
    }
}

/// Следующий хоп редиректа: `Location` относительно текущего URL + та же политика.
pub fn follow_redirect(current: &Url, location: &str, policy: &UrlPolicy) -> Result<Url, GuardError> {
    let next = current.join(location).map_err(|_| GuardError::InvalidUrl)?;
    check_parsed(&next, policy)?;
    Ok(next)
}

/// Имя хоста, которое не бывает публичным: localhost, mDNS/служебные зоны,
/// однословные имена (docker/k8s-сервисы вроде `gateway`, `nats`).
pub fn host_name_blocked(host: &str) -> bool {
    let h = host.trim_end_matches('.').to_ascii_lowercase();
    if h.is_empty() || !h.contains('.') {
        return true;
    }
    h == "localhost"
        || [".localhost", ".local", ".internal", ".home.arpa", ".localdomain"]
            .iter()
            .any(|suffix| h.ends_with(suffix))
}

fn public_or_blocked(ip: IpAddr) -> Result<(), GuardError> {
    if is_public_ip(ip) {
        Ok(())
    } else {
        Err(GuardError::BlockedIp)
    }
}

/// Адрес допустим как назначение исходящего запроса.
pub fn is_public_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => is_public_v4(v4),
        IpAddr::V6(v6) => is_public_v6(v6),
    }
}

pub fn is_public_v4(v4: Ipv4Addr) -> bool {
    let o = v4.octets();
    !(v4.is_loopback()
        || v4.is_private()
        || v4.is_link_local()
        || v4.is_broadcast()
        || v4.is_documentation()
        || v4.is_unspecified()
        || v4.is_multicast()
        // 0.0.0.0/8 «эта сеть»
        || o[0] == 0
        // CGNAT 100.64.0.0/10
        || (o[0] == 100 && (o[1] & 0xc0) == 64)
        // IETF protocol assignments 192.0.0.0/24 (P-49)
        || (o[0] == 192 && o[1] == 0 && o[2] == 0)
        // 6to4 relay anycast 192.88.99.0/24 (устарел, RFC 7526)
        || (o[0] == 192 && o[1] == 88 && o[2] == 99)
        // benchmarking 198.18.0.0/15
        || (o[0] == 198 && (o[1] & 0xfe) == 18)
        // reserved/class E 240.0.0.0/4 (включая 255.255.255.255)
        || o[0] >= 240)
}

pub fn is_public_v6(v6: Ipv6Addr) -> bool {
    let s = v6.segments();
    // IPv4-mapped ::ffff:0:0/96 — решает вложенный v4
    if let Some(v4) = v6.to_ipv4_mapped() {
        return is_public_v4(v4);
    }
    let blocked = v6.is_loopback()
        || v6.is_unspecified()
        || v6.is_multicast()
        // IPv4-compatible ::/96 (устарел) и прочее из ::/8 — наружу не маршрутизируется
        || s[0] == 0
        // discard-only 100::/64 (P-49)
        || (s[0] == 0x0100 && s[1] == 0 && s[2] == 0 && s[3] == 0)
        // NAT64 64:ff9b::/96 и local-use 64:ff9b:1::/48 (RFC 8215) — вложенный v4
        // уходит через транслятор оператора, целиком запрещено
        || (s[0] == 0x0064 && s[1] == 0xff9b && (s[2] == 0 || s[2] == 1))
        // unique-local fc00::/7
        || (s[0] & 0xfe00) == 0xfc00
        // link-local fe80::/10
        || (s[0] & 0xffc0) == 0xfe80
        // site-local fec0::/10 (P-49: устарел, но маршрутизируется внутрь)
        || (s[0] & 0xffc0) == 0xfec0
        // документационные 2001:db8::/32 и 3fff::/20 (RFC 9637)
        || (s[0] == 0x2001 && s[1] == 0x0db8)
        || (s[0] == 0x3fff && (s[1] & 0xf000) == 0)
        // ORCHIDv2 2001:20::/28 и benchmarking 2001:2::/48
        || (s[0] == 0x2001 && (s[1] & 0xfff0) == 0x0020)
        || (s[0] == 0x2001 && s[1] == 0x0002 && s[2] == 0)
        // 6to4 2002::/16 — вложенный v4 в сегментах 1–2
        || (s[0] == 0x2002 && !is_public_v4(v4_from(s[1], s[2])))
        // Teredo 2001::/32 — v4 сервера (сегменты 2–3) и инвертированный v4 клиента (6–7)
        || (s[0] == 0x2001
            && s[1] == 0
            && (!is_public_v4(v4_from(s[2], s[3])) || !is_public_v4(v4_from(!s[6], !s[7]))));
    !blocked
}

fn v4_from(hi: u16, lo: u16) -> Ipv4Addr {
    Ipv4Addr::from((u32::from(hi) << 16) | u32::from(lo))
}

/// Проверить итог резолва: непусто и ВСЕ адреса публичные (fail-closed).
pub fn check_resolved(addrs: &[SocketAddr]) -> Result<(), GuardError> {
    if addrs.is_empty() {
        return Err(GuardError::NoRecords);
    }
    if addrs.iter().any(|a| !is_public_ip(a.ip())) {
        return Err(GuardError::BlockedIp);
    }
    Ok(())
}

/// Резолв `host:port` для фиксации: все адреса обязаны быть публичными, иначе
/// отказ целиком. IP-литерал (в т.ч. `[v6]`) проверяется без DNS.
pub async fn resolve_pinned(host: &str, port: u16) -> Result<Vec<SocketAddr>, GuardError> {
    let bare = host.trim_start_matches('[').trim_end_matches(']');
    if let Ok(ip) = bare.parse::<IpAddr>() {
        let addrs = vec![SocketAddr::new(ip, port)];
        check_resolved(&addrs)?;
        return Ok(addrs);
    }
    if host_name_blocked(bare) {
        return Err(GuardError::BlockedHost);
    }
    let addrs: Vec<SocketAddr> = match tokio::time::timeout(DNS_TIMEOUT, tokio::net::lookup_host((bare, port))).await {
        Ok(Ok(it)) => it.collect(),
        _ => return Err(GuardError::Dns),
    };
    check_resolved(&addrs)?;
    Ok(addrs)
}

/// Хост URL и его проверенные адреса (порт — явный или по схеме).
pub async fn resolve_url(url: &Url) -> Result<(String, Vec<SocketAddr>), GuardError> {
    let host = url.host_str().ok_or(GuardError::NoHost)?.to_string();
    let port = url.port_or_known_default().ok_or(GuardError::BlockedPort)?;
    let addrs = resolve_pinned(&host, port).await?;
    Ok((host, addrs))
}

/// Базовый HTTP-клиент исходящих запросов: без прокси из окружения (P-49 —
/// иначе резолв и фиксация уходили бы на прокси) и без автоматических
/// редиректов (их вызывающий проходит сам через [`follow_redirect`]).
pub fn client_builder() -> reqwest::ClientBuilder {
    reqwest::Client::builder().no_proxy().redirect(reqwest::redirect::Policy::none())
}

/// [`client_builder`] с фиксацией проверенных адресов для `host`: reqwest не
/// резолвит имя повторно (анти-rebinding). Для IP-литерала фиксация не нужна.
pub fn pinned_client_builder(host: &str, addrs: &[SocketAddr]) -> reqwest::ClientBuilder {
    let builder = client_builder();
    let bare = host.trim_start_matches('[').trim_end_matches(']');
    if bare.parse::<IpAddr>().is_ok() {
        builder
    } else {
        builder.resolve_to_addrs(bare, addrs)
    }
}

/// Единый тестовый набор адресов назначения (класс 14). Им же проверяют
/// свои места исходящих запросов шарды-потребители.
pub mod test_addrs {
    /// Единый набор запрещённых адресов назначения (класс 14).
    pub const BLOCKED: &[&str] = &[
        // v4: loopback, private, link-local, CGNAT, «эта сеть», broadcast, multicast
        "127.0.0.1", "127.255.255.254", "10.0.0.1", "10.255.255.255",
        "172.16.0.1", "172.31.255.255", "192.168.0.1", "192.168.255.255",
        "169.254.169.254", "169.254.0.1", "100.64.0.1", "100.127.255.255",
        "0.0.0.0", "0.1.2.3", "255.255.255.255",
        "224.0.0.1", "239.255.255.250",
        // служебные/документационные/зарезервированные
        "192.0.0.8", "192.0.2.1", "198.51.100.1", "203.0.113.1", "192.88.99.1",
        "198.18.0.1", "198.19.255.255", "240.0.0.1", "250.1.2.3",
        // v6: loopback, unspecified, link-local, unique-local, site-local, multicast
        "::1", "::", "fe80::1", "febf::1", "fc00::1", "fd12:3456::1", "fec0::1",
        "ff02::1", "ff0e::1",
        // IPv4-mapped / IPv4-compatible
        "::ffff:127.0.0.1", "::ffff:10.0.0.1", "::ffff:169.254.169.254", "::127.0.0.1", "::8.8.8.8",
        // NAT64 (включая публичный вложенный — целиком) и local-use
        "64:ff9b::10.0.0.1", "64:ff9b::127.0.0.1", "64:ff9b::8.8.8.8", "64:ff9b:1::a00:1",
        // 6to4 с вложенным приватным/loopback
        "2002:a00:1::1", "2002:7f00:1::1", "2002:c0a8:101::1",
        // Teredo: приватный сервер; публичный сервер + приватный клиент (инвертирован)
        "2001:0:a00:1::1", "2001:0:808:808::f5ff:fffe",
        // документационные, discard-only, ORCHIDv2, benchmarking
        "2001:db8::1", "3fff::1", "100::1", "2001:20::1", "2001:2::1",
    ];

    /// Публичные адреса — разрешены.
    pub const ALLOWED: &[&str] = &[
        "8.8.8.8", "1.1.1.1", "93.184.216.34", "185.81.248.52", "100.128.0.1", "172.32.0.1",
        "2606:4700:4700::1111", "2a00:1450:4001::200e", "::ffff:8.8.8.8",
        // 6to4 и Teredo с публичными вложенными адресами
        "2002:808:808::1", "2001:0:808:808::f7f7:f7f7",
    ];
}

#[cfg(test)]
mod tests {
    use super::test_addrs::{ALLOWED, BLOCKED};
    use super::*;

    #[test]
    fn blocked_set_is_rejected() {
        for a in BLOCKED {
            let ip: IpAddr = a.parse().unwrap_or_else(|_| panic!("разбор {a}"));
            assert!(!is_public_ip(ip), "{a} должен блокироваться");
            assert_eq!(check_resolved(&[SocketAddr::new(ip, 443)]), Err(GuardError::BlockedIp), "{a}");
        }
    }

    #[test]
    fn allowed_set_passes() {
        for a in ALLOWED {
            let ip: IpAddr = a.parse().unwrap_or_else(|_| panic!("разбор {a}"));
            assert!(is_public_ip(ip), "{a} должен пропускаться");
        }
    }

    #[test]
    fn resolved_set_is_fail_closed() {
        let public = SocketAddr::new("8.8.8.8".parse().unwrap(), 443);
        let private = SocketAddr::new("10.0.0.1".parse().unwrap(), 443);
        assert_eq!(check_resolved(&[public]), Ok(()));
        assert_eq!(check_resolved(&[public, private]), Err(GuardError::BlockedIp));
        assert_eq!(check_resolved(&[]), Err(GuardError::NoRecords));
    }

    #[test]
    fn url_literals_go_through_the_same_set() {
        for a in BLOCKED {
            let ip: IpAddr = a.parse().unwrap();
            let host = match ip {
                IpAddr::V4(_) => a.to_string(),
                IpAddr::V6(_) => format!("[{a}]"),
            };
            assert_eq!(check_url(&format!("https://{host}/x"), &UrlPolicy::HTTPS), Err(GuardError::BlockedIp), "{a}");
        }
        for a in ALLOWED {
            let ip: IpAddr = a.parse().unwrap();
            let host = match ip {
                IpAddr::V4(_) => a.to_string(),
                IpAddr::V6(_) => format!("[{a}]"),
            };
            assert!(check_url(&format!("https://{host}/x"), &UrlPolicy::HTTPS).is_ok(), "{a}");
        }
        // Нестандартные записи v4 url нормализует — фильтр их тоже видит
        for alt in ["https://2130706433/", "https://0x7f.1/", "https://127.1/", "https://017700000001/"] {
            assert_eq!(check_url(alt, &UrlPolicy::HTTPS), Err(GuardError::BlockedIp), "{alt}");
        }
    }

    #[test]
    fn url_policy_schemes_ports_userinfo_hosts() {
        assert!(check_url("https://example.com/a", &UrlPolicy::LINK).is_ok());
        assert!(check_url("http://example.com/a", &UrlPolicy::LINK).is_ok());
        assert_eq!(check_url("ftp://example.com/", &UrlPolicy::LINK), Err(GuardError::UnsupportedScheme));
        assert_eq!(check_url("file:///etc/passwd", &UrlPolicy::LINK), Err(GuardError::UnsupportedScheme));
        assert_eq!(check_url("http://example.com/", &UrlPolicy::HTTPS), Err(GuardError::UnsupportedScheme));
        assert_eq!(check_url("https://example.com:8443/", &UrlPolicy::LINK), Err(GuardError::BlockedPort));
        assert!(check_url("https://push.example.com:8443/", &UrlPolicy::HTTPS).is_ok());
        assert_eq!(check_url("https://u:p@example.com/", &UrlPolicy::LINK), Err(GuardError::Userinfo));
        assert_eq!(check_url("not a url", &UrlPolicy::LINK), Err(GuardError::InvalidUrl));
        for h in ["localhost", "LOCALHOST.", "a.localhost", "printer.local", "gateway", "nats", "db.internal", "nas.home.arpa"] {
            assert_eq!(check_url(&format!("https://{h}/"), &UrlPolicy::HTTPS), Err(GuardError::BlockedHost), "{h}");
        }
    }

    #[test]
    fn redirects_are_rechecked() {
        let base = check_url("https://example.com/a/b", &UrlPolicy::LINK).unwrap();
        assert_eq!(follow_redirect(&base, "/c", &UrlPolicy::LINK).unwrap().as_str(), "https://example.com/c");
        assert_eq!(follow_redirect(&base, "http://127.0.0.1/", &UrlPolicy::LINK), Err(GuardError::BlockedIp));
        assert_eq!(follow_redirect(&base, "http://[::1]/", &UrlPolicy::LINK), Err(GuardError::BlockedIp));
        assert_eq!(follow_redirect(&base, "gopher://example.com/", &UrlPolicy::LINK), Err(GuardError::UnsupportedScheme));
        assert_eq!(follow_redirect(&base, "http://localhost:80/", &UrlPolicy::LINK), Err(GuardError::BlockedHost));
        assert_eq!(MAX_REDIRECTS, 3);
    }

    #[tokio::test]
    async fn resolve_pinned_literals_without_dns() {
        assert_eq!(resolve_pinned("127.0.0.1", 80).await, Err(GuardError::BlockedIp));
        assert_eq!(resolve_pinned("[::1]", 443).await, Err(GuardError::BlockedIp));
        assert_eq!(resolve_pinned("::ffff:127.0.0.1", 443).await, Err(GuardError::BlockedIp));
        assert_eq!(resolve_pinned("localhost", 80).await, Err(GuardError::BlockedHost));
        let ok = resolve_pinned("8.8.8.8", 443).await.unwrap();
        assert_eq!(ok, vec![SocketAddr::new("8.8.8.8".parse().unwrap(), 443)]);
    }

    #[test]
    fn clients_build_without_proxy() {
        let addrs = [SocketAddr::new("8.8.8.8".parse().unwrap(), 443)];
        assert!(pinned_client_builder("example.com", &addrs).build().is_ok());
        assert!(pinned_client_builder("[2606:4700:4700::1111]", &addrs).build().is_ok());
    }
}
