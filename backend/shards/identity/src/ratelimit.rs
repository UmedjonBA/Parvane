//! Частотные лимиты: регистрация, логин (P-33), фетч prekeys (P-21), кэш OTK.

use crate::*;

/// Простой лимит попыток регистрации в памяти: не более `PARVANE_REGISTER_RATE`
/// (по умолчанию 5) на логин за 60 секунд. Защита от массовой саморегистрации.
pub(crate) fn rate_ok(user: &str) -> bool {
    use std::collections::HashMap;
    use std::sync::{Mutex, OnceLock};
    static LIMITER: OnceLock<Mutex<HashMap<String, Vec<i64>>>> = OnceLock::new();
    // Глобальный кэп поверх пер-логин: пер-логин лимит НЕ мешает спаму РАЗНЫМИ
    // логинами (каждый — свой bucket). Глобальный ловит массовую саморегистрацию
    // (в закрытом режиме за basic-auth это ещё и защита при утечке пароля сайта).
    static GLOBAL: OnceLock<Mutex<Vec<i64>>> = OnceLock::new();
    let limit: usize = std::env::var("PARVANE_REGISTER_RATE")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(5);
    let global_limit: usize = std::env::var("PARVANE_REGISTER_RATE_GLOBAL")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(30);
    let now = now_unix();

    let gmap = GLOBAL.get_or_init(|| Mutex::new(Vec::new()));
    {
        // 4.14: отравленный мьютекс не должен навсегда ломать регистрацию
        let mut g = gmap.lock().unwrap_or_else(|e| e.into_inner());
        g.retain(|&t| now - t < 60);
        if g.len() >= global_limit {
            return false;
        }
    }

    let map = LIMITER.get_or_init(|| Mutex::new(HashMap::new()));
    let mut guard = map.lock().unwrap_or_else(|e| e.into_inner());
    evict_stale_buckets(&mut guard, now);
    let hits = guard.entry(limiter_key(user)).or_default();
    hits.retain(|&t| now - t < 60);
    if hits.len() >= limit {
        return false;
    }
    hits.push(now);
    // Успешную попытку учитываем и в глобальном счётчике
    gmap.lock().unwrap_or_else(|e| e.into_inner()).push(now);
    true
}

/// Общий частотный лимит «не более `limit` за 60 с» по произвольному ключу в
/// пространстве `scope` (в памяти процесса). Используется для лимитов по IP.
pub(crate) fn window_rate_ok(scope: &str, key: &str, limit: usize) -> bool {
    use std::collections::HashMap;
    use std::sync::{Mutex, OnceLock};
    static MAP: OnceLock<Mutex<HashMap<String, Vec<i64>>>> = OnceLock::new();
    let now = now_unix();
    let map = MAP.get_or_init(|| Mutex::new(HashMap::new()));
    let mut guard = map.lock().unwrap_or_else(|e| e.into_inner());
    evict_stale_buckets(&mut guard, now);
    let hits = guard.entry(format!("{scope}:{}", limiter_key(key))).or_default();
    hits.retain(|&t| now - t < 60);
    if hits.len() >= limit {
        return false;
    }
    hits.push(now);
    true
}

/// P-37: ключи лимитеров приходят от клиента (логин до 4 МиБ, IP) — ограничиваем
/// длину: длинные заменяем SHA-256-хэшем, чтобы карта не росла на байты атакующего.
pub(crate) const LIMITER_KEY_MAX: usize = 128;
pub(crate) fn limiter_key(key: &str) -> String {
    if key.len() <= LIMITER_KEY_MAX {
        return key.to_string();
    }
    let digest = Sha256::digest(key.as_bytes());
    format!("h:{}", B64.encode(digest))
}

/// P-37: выселение пустых/устаревших корзин, чтобы память лимитеров не росла
/// на уникальных ключах. Зовётся при каждом обращении, но чистит не чаще
/// чем при превышении порога записей.
pub(crate) const LIMITER_MAX_ENTRIES: usize = 50_000;
pub(crate) fn evict_stale_buckets<K: std::hash::Hash + Eq>(map: &mut std::collections::HashMap<K, Vec<i64>>, now: i64) {
    if map.len() < LIMITER_MAX_ENTRIES {
        return;
    }
    map.retain(|_, hits| {
        hits.retain(|&t| now - t < 60);
        !hits.is_empty()
    });
}

#[derive(Default)]
pub(crate) struct LoginBucket {
    /// Метки времени попыток в текущем частотном окне (60 c).
    pub(crate) attempts: Vec<i64>,
    /// Серия подряд идущих неудач (сбрасывается при верном пароле).
    pub(crate) fails: u32,
    /// Unix-время, до которого логин по этому ключу заблокирован.
    pub(crate) locked_until: i64,
}

pub(crate) fn login_limiter() -> &'static std::sync::Mutex<std::collections::HashMap<String, LoginBucket>> {
    use std::collections::HashMap;
    use std::sync::{Mutex, OnceLock};
    static L: OnceLock<Mutex<HashMap<String, LoginBucket>>> = OnceLock::new();
    L.get_or_init(|| Mutex::new(HashMap::new()))
}

pub(crate) fn env_u64(key: &str, default: u64) -> u64 {
    std::env::var(key).ok().and_then(|s| s.parse().ok()).unwrap_or(default)
}

/// Выселение корзин логина (ID-02): карта росла на каждый новый логин и
/// чистилась только при верном пароле — аноним исчерпывал память identity
/// уникальными логинами. Чистим при превышении порога: сначала корзины без
/// активного лок-аута и без попыток за последнюю минуту, если всё ещё тесно —
/// все незаблокированные (теряется только эскалация задержки).
pub(crate) fn evict_login_buckets(map: &mut std::collections::HashMap<String, LoginBucket>, now: i64) {
    if map.len() < LIMITER_MAX_ENTRIES {
        return;
    }
    map.retain(|_, b| {
        b.attempts.retain(|&t| now - t < 60);
        b.locked_until > now || !b.attempts.is_empty()
    });
    if map.len() >= LIMITER_MAX_ENTRIES {
        map.retain(|_, b| b.locked_until > now);
    }
}

/// Пропускает попытку логина или отвергает её: частотный лимит на 60 c
/// (PARVANE_LOGIN_RATE, по умолчанию 10) и активный лок-аут после серии неудач.
/// Ключ — через `limiter_key` (длинный логин заменяется хэшем).
pub(crate) fn login_gate_check(user: &str) -> Result<()> {
    let rate = env_u64("PARVANE_LOGIN_RATE", 10) as usize;
    let now = now_unix();
    let map = login_limiter();
    let mut guard = map.lock().unwrap_or_else(|e| e.into_inner());
    evict_login_buckets(&mut guard, now);
    let bucket = guard.entry(limiter_key(user)).or_default();
    if bucket.locked_until > now {
        anyhow::bail!("слишком много неудачных попыток, попробуйте позже");
    }
    bucket.attempts.retain(|&t| now - t < 60);
    if bucket.attempts.len() >= rate {
        anyhow::bail!("слишком много попыток, попробуйте позже");
    }
    bucket.attempts.push(now);
    Ok(())
}

/// Учесть неудачную попытку и, при достижении порога, включить экспоненциальный
/// лок-аут: base * 2^(fails-threshold), но не дольше max.
pub(crate) fn login_record_failure(user: &str) {
    let threshold = env_u64("PARVANE_LOGIN_LOCK_THRESHOLD", 5) as u32;
    let base = env_u64("PARVANE_LOGIN_LOCK_BASE_SECS", 2);
    let max = env_u64("PARVANE_LOGIN_LOCK_MAX_SECS", 900);
    let now = now_unix();
    let map = login_limiter();
    let mut guard = map.lock().unwrap_or_else(|e| e.into_inner());
    evict_login_buckets(&mut guard, now);
    let bucket = guard.entry(limiter_key(user)).or_default();
    bucket.fails = bucket.fails.saturating_add(1);
    if bucket.fails >= threshold {
        let over = (bucket.fails - threshold).min(20);
        let backoff = base.saturating_mul(1u64 << over).min(max);
        bucket.locked_until = now + backoff as i64;
    }
}

/// Верный пароль: снимаем лок-аут и счётчик неудач для этого логина.
pub(crate) fn login_record_success(user: &str) {
    let map = login_limiter();
    let mut guard = map.lock().unwrap_or_else(|e| e.into_inner());
    guard.remove(&limiter_key(user));
}






