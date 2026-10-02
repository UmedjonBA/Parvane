//! Источник времени движка. На сервере и в нативных клиентах — системные часы;
//! в браузере (`wasm32-unknown-unknown`) `SystemTime` недоступен — обвязка
//! подставляет `Date.now()` через `set_clock` при инициализации.

use std::sync::OnceLock;

static CLOCK: OnceLock<fn() -> i64> = OnceLock::new();

/// Задать источник времени (мс с эпохи Unix). Повторный вызов игнорируется.
pub fn set_clock(f: fn() -> i64) {
    let _ = CLOCK.set(f);
}

/// Текущее время, мс с эпохи Unix.
pub fn now_ms() -> i64 {
    if let Some(f) = CLOCK.get() {
        return f();
    }
    #[cfg(not(all(target_arch = "wasm32", target_os = "unknown")))]
    {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| i64::try_from(d.as_millis()).unwrap_or(i64::MAX))
            .unwrap_or(0)
    }
    #[cfg(all(target_arch = "wasm32", target_os = "unknown"))]
    {
        0
    }
}
