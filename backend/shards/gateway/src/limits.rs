//! Лимиты gateway: соединения на IP/всего, token-bucket на сессию, таймауты (P-30/P-37).

use crate::*;

/// Лимиты параллельных соединений (глобально и на IP-источник) против исчерпания
/// ресурсов множеством незакрытых/неавторизованных сокетов.
pub(crate) struct Limits {
    pub(crate) conns: Arc<Semaphore>,
    pub(crate) per_ip: Arc<Mutex<HashMap<IpAddr, usize>>>,
    pub(crate) max_per_ip: usize,
    /// GW-01: соединения на адрес КЛИЕНТА (X-Forwarded-For за Caddy): адрес пира там один — адрес прокси.
    pub(crate) per_client: Arc<Mutex<HashMap<IpAddr, usize>>>,
    pub(crate) max_per_client: usize,
}

/// RAII-учёт соединения по адресу клиента за прокси.
pub(crate) struct ClientGuard {
    per_client: Arc<Mutex<HashMap<IpAddr, usize>>>,
    ip: IpAddr,
}

impl Drop for ClientGuard {
    fn drop(&mut self) {
        let mut map = self.per_client.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(count) = map.get_mut(&self.ip) {
            *count -= 1;
            if *count == 0 {
                map.remove(&self.ip);
            }
        }
    }
}

/// GW-01: квота на адрес клиента, заявленный прокси (после рукопожатия WS). Адрес пира уже учтён
/// в `admit`, поэтому совпадающий с ним (прямое подключение) повторно не считается.
pub(crate) fn admit_client(limits: &Limits, peer: Option<IpAddr>, client_ip: &str) -> Result<Option<ClientGuard>, ()> {
    let Ok(ip) = client_ip.parse::<IpAddr>() else { return Ok(None) };
    if Some(ip) == peer {
        return Ok(None);
    }
    let mut map = limits.per_client.lock().unwrap_or_else(|e| e.into_inner());
    let count = map.entry(ip).or_insert(0);
    if *count >= limits.max_per_client {
        return Err(());
    }
    *count += 1;
    Ok(Some(ClientGuard { per_client: limits.per_client.clone(), ip }))
}

/// RAII-учёт соединения: освобождает глобальный permit и счётчик по IP при Drop.
pub(crate) struct ConnGuard {
    pub(crate) _permit: OwnedSemaphorePermit,
    pub(crate) per_ip: Arc<Mutex<HashMap<IpAddr, usize>>>,
    pub(crate) ip: IpAddr,
}

/// Адрес доверенного обратного прокси (loopback/приватная сеть): его соединения до
/// считаются только против общего лимита и квоты клиента (`admit_client`), не против квоты «на IP».
pub(crate) fn is_proxy_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => v4.is_loopback() || v4.is_private() || v4.is_link_local(),
        IpAddr::V6(v6) => v6.is_loopback() || (v6.segments()[0] & 0xfe00) == 0xfc00,
    }
}

impl Drop for ConnGuard {
    fn drop(&mut self) {
        let mut map = self.per_ip.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(count) = map.get_mut(&self.ip) {
            *count -= 1;
            if *count == 0 {
                map.remove(&self.ip);
            }
        }
    }
}

/// Пытается «впустить» соединение: берёт глобальный permit и место в квоте IP.
/// None — лимит исчерпан (вызывающий закрывает сокет, ничего не выделив).
pub(crate) fn admit(limits: &Limits, ip: IpAddr, behind_proxy: bool) -> Option<ConnGuard> {
    // Пир-прокси ограничен только общим лимитом; квота клиента применяется в `admit_client`.
    let cap = if behind_proxy && is_proxy_ip(ip) { usize::MAX } else { limits.max_per_ip };
    let permit = limits.conns.clone().try_acquire_owned().ok()?;
    {
        let mut map = limits.per_ip.lock().unwrap_or_else(|e| e.into_inner());
        let count = map.entry(ip).or_insert(0);
        if *count >= cap {
            return None; // permit дропнется здесь → глобальный слот освобождён
        }
        *count += 1;
    }
    Some(ConnGuard { _permit: permit, per_ip: limits.per_ip.clone(), ip })
}


pub(crate) fn env(key: &str, default: &str) -> String {
    std::env::var(key).unwrap_or_else(|_| default.to_string())
}

pub(crate) fn env_f64(key: &str, default: f64) -> f64 {
    std::env::var(key).ok().and_then(|v| v.parse().ok()).unwrap_or(default)
}

/// Token bucket: `capacity` — допустимый всплеск, `refill_per_sec` — устойчивая
/// частота. Клиент недоверенный: флуд сообщениями/чанками режем на gateway,
/// потому что для sealed-сообщений только он знает пользователя сессии.
pub(crate) struct TokenBucket {
    pub(crate) capacity: f64,
    pub(crate) tokens: f64,
    pub(crate) refill_per_sec: f64,
    pub(crate) last: Instant,
}

impl TokenBucket {
    pub(crate) fn new(capacity: f64, refill_per_sec: f64) -> Self {
        Self { capacity, tokens: capacity, refill_per_sec, last: Instant::now() }
    }

    pub(crate) fn try_take_at(&mut self, now: Instant) -> bool {
        let elapsed = now.saturating_duration_since(self.last).as_secs_f64();
        self.last = now;
        self.tokens = (self.tokens + elapsed * self.refill_per_sec).min(self.capacity);
        if self.tokens >= 1.0 {
            self.tokens -= 1.0;
            true
        } else {
            false
        }
    }

    pub(crate) fn try_take(&mut self) -> bool {
        self.try_take_at(Instant::now())
    }
}

/// Столько даём writer'у дослать хвост после завершения сессии (нечитающий
/// клиент иначе держал бы задачу и слот соединения бессрочно).
pub(crate) const WRITER_FLUSH_SECS: u64 = 5;

/// GW-02: простой анонимного v2-соединения (секунды) до закрытия; раньше —
/// сутки, и аноним занимал все слоты соединений молчащими сокетами.
pub(crate) fn anon_idle_secs() -> u64 {
    std::env::var("PARVANE_GATEWAY_ANON_IDLE_SECS").ok().and_then(|v| v.parse().ok()).unwrap_or(30)
}
