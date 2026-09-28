//! Лимиты gateway: соединения на IP/всего, token-bucket на сессию, таймауты (P-30/P-37).

use crate::*;

/// Лимиты параллельных соединений (глобально и на IP-источник) против исчерпания
/// ресурсов множеством незакрытых/неавторизованных сокетов.
pub(crate) struct Limits {
    pub(crate) conns: Arc<Semaphore>,
    pub(crate) per_ip: Arc<Mutex<HashMap<IpAddr, usize>>>,
    pub(crate) max_per_ip: usize,
}

/// RAII-учёт соединения: освобождает глобальный permit и счётчик по IP при Drop.
pub(crate) struct ConnGuard {
    pub(crate) _permit: OwnedSemaphorePermit,
    pub(crate) per_ip: Arc<Mutex<HashMap<IpAddr, usize>>>,
    pub(crate) ip: IpAddr,
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
pub(crate) fn admit(limits: &Limits, ip: IpAddr) -> Option<ConnGuard> {
    let permit = limits.conns.clone().try_acquire_owned().ok()?;
    {
        let mut map = limits.per_ip.lock().unwrap_or_else(|e| e.into_inner());
        let count = map.entry(ip).or_insert(0);
        if *count >= limits.max_per_ip {
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

/// Лимиты одной авторизованной сессии по классам операций.
pub(crate) struct SessionRate {
    pub(crate) messages: TokenBucket,
    pub(crate) uploads: TokenBucket,
    pub(crate) requests: TokenBucket,
}

impl SessionRate {
    pub(crate) fn from_env() -> Self {
        Self {
            // сообщения/правки/реакции: всплеск 30, устойчиво 3 в секунду
            messages: TokenBucket::new(env_f64("GATEWAY_RATE_MSG_BURST", 30.0), env_f64("GATEWAY_RATE_MSG_PER_SEC", 3.0)),
            // чанки загрузки (256 КиБ): всплеск 400, устойчиво 40/с ≈ 10 МБ/с
            uploads: TokenBucket::new(env_f64("GATEWAY_RATE_UPLOAD_BURST", 400.0), env_f64("GATEWAY_RATE_UPLOAD_PER_SEC", 40.0)),
            // прочие request/reply: всплеск 120, устойчиво 20/с
            requests: TokenBucket::new(env_f64("GATEWAY_RATE_REQ_BURST", 120.0), env_f64("GATEWAY_RATE_REQ_PER_SEC", 20.0)),
        }
    }

    /// true — операция допущена; false — лимит исчерпан
    pub(crate) fn allow(&mut self, subject: &str) -> bool {
        if subject == FILE_UPLOAD_CHUNK || subject == FILE_UPLOAD_COMPLETE {
            self.uploads.try_take()
        } else if subject.starts_with(MSG_CHAT_PREFIX) {
            self.messages.try_take()
        } else {
            self.requests.try_take()
        }
    }
}

pub(crate) const RATE_LIMITED: &str = "rate_limited: слишком часто, подождите";

/// Bootstrap-запросы (регистрация/логин) идут до auth, поэтому identity не знает
/// источник; подмешиваем `client_ip` в JSON-объект payload (поле клиента, если
/// он его прислал, перезаписывается — подделать нельзя).
/// P-33: потолок подписок на одну сессию.
pub(crate) const MAX_SUBS_PER_SESSION: usize = 64;
/// P-33: клиентский timeout_ms ограничен 30 с — иначе висящие reqmany/req
/// держали бы задачи и inbox'ы NATS неограниченно.
pub(crate) const MAX_TIMEOUT_MS: u64 = 30_000;
pub(crate) fn clamp_timeout(timeout_ms: u64) -> u64 {
    timeout_ms.clamp(100, MAX_TIMEOUT_MS)
}
