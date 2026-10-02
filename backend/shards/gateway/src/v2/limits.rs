//! v2: допуск запроса по реестру — канал, авторизация, роль оператора,
//! свежесть подтверждения паролем (FR-025) и классы частоты (T034, T035).

use crate::limits::{env_f64, TokenBucket};
use parvane_protocol::pb::parvane::core::v2::{Channel, ErrorCode};
use parvane_protocol::schema::MethodInfo;

/// Окно свежего подтверждения паролем.
pub(crate) const REAUTH_WINDOW_MS: i64 = 5 * 60 * 1000;

/// Что известно о сессии для допуска.
#[derive(Debug, Clone, Copy)]
pub(crate) struct Access {
    pub channel: Channel,
    pub authed: bool,
    pub operator: bool,
    pub reauth_until_ms: i64,
}

/// Допустить метод в этой сессии (без частоты).
pub(crate) fn admit(m: &MethodInfo, a: &Access, now_ms: i64) -> Result<(), ErrorCode> {
    match (m.channel, a.channel) {
        // PRE — только в идентифицируемом соединении (до или после входа).
        (1, Channel::Identified) => {}
        // ID — только после Auth.
        (2, Channel::Identified) if a.authed => {}
        // ANON — только в анонимном канале; и наоборот (D-05).
        (3, Channel::AnonymousDelivery) => {}
        _ => return Err(ErrorCode::Forbidden),
    }
    if m.operator_only && !a.operator {
        return Err(ErrorCode::Forbidden);
    }
    if m.reauth && now_ms > a.reauth_until_ms {
        return Err(ErrorCode::ReauthRequired);
    }
    Ok(())
}

/// Классы частоты сессии v2 (реестр: RateClass 1 MSG … 5 PRE).
pub(crate) struct V2Rate {
    msg: TokenBucket,
    upload: TokenBucket,
    req: TokenBucket,
    anon: TokenBucket,
    pre: TokenBucket,
}

impl V2Rate {
    pub(crate) fn from_env() -> Self {
        Self {
            msg: TokenBucket::new(env_f64("GATEWAY_RATE_MSG_BURST", 30.0), env_f64("GATEWAY_RATE_MSG_PER_SEC", 3.0)),
            upload: TokenBucket::new(env_f64("GATEWAY_RATE_UPLOAD_BURST", 400.0), env_f64("GATEWAY_RATE_UPLOAD_PER_SEC", 40.0)),
            req: TokenBucket::new(env_f64("GATEWAY_RATE_REQ_BURST", 120.0), env_f64("GATEWAY_RATE_REQ_PER_SEC", 20.0)),
            // Анонимная доставка: на соединение; право — ключ/жетон, лимит на
            // получателя/IP — в шарде.
            anon: TokenBucket::new(env_f64("GATEWAY_RATE_ANON_BURST", 60.0), env_f64("GATEWAY_RATE_ANON_PER_SEC", 6.0)),
            // До входа: мало (перебор паролей режет identity по IP).
            pre: TokenBucket::new(env_f64("GATEWAY_RATE_PRE_BURST", 20.0), env_f64("GATEWAY_RATE_PRE_PER_SEC", 1.0)),
        }
    }

    /// Допустить по классу; Err — через сколько мс повторить.
    pub(crate) fn allow(&mut self, class: i32) -> Result<(), u32> {
        let b = match class {
            1 => &mut self.msg,
            2 => &mut self.upload,
            4 => &mut self.anon,
            5 => &mut self.pre,
            _ => &mut self.req,
        };
        if b.try_take() {
            Ok(())
        } else {
            let wait = if b.refill_per_sec > 0.0 { ((1.0 - b.tokens) / b.refill_per_sec * 1000.0).ceil() } else { 1000.0 };
            Err(wait.clamp(1.0, 60_000.0) as u32)
        }
    }
}

/// Cooldown вызова на анонимное соединение (T078, P-35): не чаще одного
/// `call.ring_sealed` в 5 с. Лимит «≤ 3 звонящих на
/// адресата» — в шарде call (по адресату); отправителя не знает никто.
pub(crate) const RING_COOLDOWN_MS: u64 = 5_000;

#[derive(Default)]
pub(crate) struct RingCooldown {
    last: Option<std::time::Instant>,
}

impl RingCooldown {
    /// Err — через сколько мс повторить.
    pub(crate) fn allow(&mut self, now: std::time::Instant) -> Result<(), u32> {
        if let Some(t) = self.last {
            let passed = now.saturating_duration_since(t).as_millis() as u64;
            if passed < RING_COOLDOWN_MS {
                return Err((RING_COOLDOWN_MS - passed) as u32);
            }
        }
        self.last = Some(now);
        Ok(())
    }
}

/// Лимит ANON-запросов на IP-источник (D-08, D-17). Анонимное соединение по
/// гигиене R6 не переиспользуется, поэтому лимит на соединение (`V2Rate.anon`)
/// ничего не ограничивает: клиент просто открывает новое. Здесь — корзины на
/// источник: общая для всех ANON-методов и отдельная, строже, для
/// `identity.device.fetch_bundle_anon` (выкачивание одноразовых ключей).
///
/// Сам IP не хранится: ключ карты — SipHash адреса (IPv6 — сеть /64) с
/// ключом процесса (`RandomState`), только в памяти, в журналы не попадает и
/// между перезапусками не сопоставляется. В шину IP по-прежнему не уходит
/// (`anon::shard_request`).
pub(crate) struct AnonIpLimits {
    hasher: std::collections::hash_map::RandomState,
    map: std::sync::Mutex<std::collections::HashMap<u64, AnonIpBuckets>>,
    all: (f64, f64),
    bundle: (f64, f64),
}

struct AnonIpBuckets {
    all: TokenBucket,
    bundle: TokenBucket,
}

/// Потолок числа отслеживаемых источников (память gateway).
pub(crate) const ANON_IP_MAX_SOURCES: usize = 65_536;

/// Методы с отдельной корзиной «бандлы» на источник.
pub(crate) fn is_bundle_fetch(name: &str) -> bool {
    name == "identity.device.fetch_bundle_anon"
}

fn bucket_wait(b: &TokenBucket) -> u32 {
    let wait = if b.refill_per_sec > 0.0 { ((1.0 - b.tokens) / b.refill_per_sec * 1000.0).ceil() } else { 60_000.0 };
    wait.clamp(1.0, 60_000.0) as u32
}

/// Корзина вернулась бы к полной — запись можно забыть без потери состояния.
fn bucket_idle(b: &TokenBucket, now: std::time::Instant) -> bool {
    let elapsed = now.saturating_duration_since(b.last).as_secs_f64();
    b.tokens + elapsed * b.refill_per_sec >= b.capacity
}

impl AnonIpLimits {
    pub(crate) fn new(all: (f64, f64), bundle: (f64, f64)) -> Self {
        Self { hasher: Default::default(), map: Default::default(), all, bundle }
    }

    pub(crate) fn from_env() -> Self {
        Self::new(
            (env_f64("GATEWAY_RATE_ANON_IP_BURST", 600.0), env_f64("GATEWAY_RATE_ANON_IP_PER_SEC", 60.0)),
            (env_f64("GATEWAY_RATE_BUNDLE_IP_BURST", 60.0), env_f64("GATEWAY_RATE_BUNDLE_IP_PER_SEC", 1.0)),
        )
    }

    /// Ключ источника (вызывается при открытии анонимного соединения; сам
    /// адрес после этого сессия не держит).
    pub(crate) fn source_key(&self, ip: &str) -> u64 {
        use std::hash::BuildHasher;
        let norm = match ip.parse::<std::net::IpAddr>() {
            Ok(std::net::IpAddr::V6(v6)) => match v6.to_ipv4_mapped() {
                Some(v4) => v4.to_string(),
                None => {
                    let s = v6.segments();
                    format!("{:x}:{:x}:{:x}:{:x}::/64", s[0], s[1], s[2], s[3])
                }
            },
            Ok(std::net::IpAddr::V4(v4)) => v4.to_string(),
            Err(_) => ip.to_string(),
        };
        self.hasher.hash_one(norm)
    }

    /// Допустить ANON-запрос `method` с источника `key`; Err — через сколько мс.
    pub(crate) fn allow(&self, key: u64, method: &str, now: std::time::Instant) -> Result<(), u32> {
        let mut map = self.map.lock().unwrap_or_else(|e| e.into_inner());
        if !map.contains_key(&key) && map.len() >= ANON_IP_MAX_SOURCES {
            map.retain(|_, b| !(bucket_idle(&b.all, now) && bucket_idle(&b.bundle, now)));
            if map.len() >= ANON_IP_MAX_SOURCES {
                return Err(1000);
            }
        }
        let (all, bundle) = (self.all, self.bundle);
        let b = map.entry(key).or_insert_with(|| AnonIpBuckets {
            all: TokenBucket::new(all.0, all.1),
            bundle: TokenBucket::new(bundle.0, bundle.1),
        });
        // Проверка бандла — до расхода общей корзины: отказ по бандлам не
        // съедает токен общей.
        if is_bundle_fetch(method) {
            let mut probe = TokenBucket { capacity: b.bundle.capacity, tokens: b.bundle.tokens, refill_per_sec: b.bundle.refill_per_sec, last: b.bundle.last };
            if !probe.try_take_at(now) {
                b.bundle = probe;
                return Err(bucket_wait(&b.bundle));
            }
            if !b.all.try_take_at(now) {
                return Err(bucket_wait(&b.all));
            }
            b.bundle = probe;
            return Ok(());
        }
        if b.all.try_take_at(now) {
            Ok(())
        } else {
            Err(bucket_wait(&b.all))
        }
    }

    #[cfg(test)]
    pub(crate) fn sources(&self) -> usize {
        self.map.lock().unwrap_or_else(|e| e.into_inner()).len()
    }
}
