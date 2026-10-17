//! Настройки федерации из окружения (spec 028, contracts §9).

use std::collections::{HashMap, HashSet};

#[derive(Debug, Clone)]
pub struct Config {
    /// `PARVANE_FEDERATION=on` — иначе отказ всему межсерверному в обе стороны.
    pub enabled: bool,
    /// Свой домен (`PARVANE_DOMAIN`).
    pub domain: String,
    /// Адрес входящего HTTP (`PARVANE_FEDERATION_BIND`), TLS снимает Caddy.
    pub bind: String,
    /// Точки входа, заданные администратором: домен → база (`https://host[:port]`).
    pub endpoints: HashMap<String, String>,
    /// Чёрный список из окружения (неснимаемый без перезапуска).
    pub blocked: HashSet<String>,
    pub rate_burst: f64,
    pub rate_per_sec: f64,
    /// Тестовый транспорт без TLS: только с фичей сборки и `PARVANE_FEDERATION_INSECURE_HTTP=1`.
    pub insecure_http: bool,
    /// Файл описателя (`/.well-known/parvane`), который пишет identity; отдаётся в тестовом режиме.
    pub well_known_file: Option<String>,
}

fn env(name: &str) -> String {
    std::env::var(name).unwrap_or_default().trim().to_string()
}

fn env_f64(name: &str, default: f64) -> f64 {
    env(name).parse().ok().filter(|v: &f64| *v > 0.0).unwrap_or(default)
}

/// Свой домен — как у остальных шардов: обрезка `@`, нижний регистр, по умолчанию `local`.
pub fn server_domain() -> String {
    let d = env("PARVANE_DOMAIN").trim_start_matches('@').to_lowercase();
    if d.is_empty() {
        "local".into()
    } else {
        d
    }
}

impl Config {
    pub fn from_env() -> Self {
        let endpoints = env("PARVANE_FEDERATION_ENDPOINTS")
            .split(',')
            .filter_map(|pair| pair.split_once('='))
            .map(|(d, base)| (d.trim().to_lowercase(), base.trim().trim_end_matches('/').to_string()))
            .filter(|(d, base)| !d.is_empty() && !base.is_empty())
            .collect();
        let blocked = env("PARVANE_FEDERATION_BLOCK").split(',').map(|d| d.trim().to_lowercase()).filter(|d| !d.is_empty()).collect();
        let insecure_http = cfg!(feature = "insecure-test-transport") && env("PARVANE_FEDERATION_INSECURE_HTTP") == "1";
        let well_known_file = Some(env("PARVANE_WELL_KNOWN_FILE")).filter(|p| !p.is_empty());
        Config {
            enabled: matches!(env("PARVANE_FEDERATION").as_str(), "on" | "1" | "true"),
            domain: server_domain(),
            bind: Some(env("PARVANE_FEDERATION_BIND")).filter(|b| !b.is_empty()).unwrap_or_else(|| "0.0.0.0:9330".into()),
            endpoints,
            blocked,
            rate_burst: env_f64("PARVANE_FEDERATION_RATE_BURST", 300.0),
            rate_per_sec: env_f64("PARVANE_FEDERATION_RATE_PER_SEC", 50.0),
            insecure_http,
            well_known_file,
        }
    }

    pub fn is_own(&self, domain: &str) -> bool {
        domain.eq_ignore_ascii_case(&self.domain)
    }
}
