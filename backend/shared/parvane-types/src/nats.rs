//! Подключение к NATS с опциональным TLS. Все шарды используют этот helper вместо
//! прямого `async_nats::connect`, чтобы TLS включался единообразно из окружения.
//!
//! Если задан `PARVANE_NATS_TLS_CA` (путь к CA-сертификату) — соединение идёт по
//! TLS (шифрование сигналинга на сети); URL при этом обычно `tls://host:4222`.
//! Без переменной — обычное plaintext-подключение (обратная совместимость).

/// Подключиться к NATS. Читает `PARVANE_NATS_TLS_CA` для TLS.
pub async fn connect(url: &str) -> Result<async_nats::Client, async_nats::ConnectError> {
    // Шина может подняться позже шарда (compose, раннеры тестов, стенды):
    // первичное подключение повторяется, а не завершает процесс. Раньше шарды
    // «выигрывали» эту гонку только потому, что перед NATS успевали прогнать
    // миграции SQLite (T110: messenger стал подключаться первым и падал в тестах).
    let mut opts = async_nats::ConnectOptions::new().retry_on_initial_connect();
    if let (Ok(user), Ok(pass)) = (
        std::env::var("PARVANE_NATS_USER"),
        std::env::var("PARVANE_NATS_PASS"),
    ) {
        if !user.is_empty() && !pass.is_empty() {
            // GW-05: ответы на запросы роли — в её почтовый ящик `_INBOX.<роль>`; подписка роли в ACL только
            // на свой префикс, чужие ответы ей не видны
            opts = opts.custom_inbox_prefix(crate::topic_contract::reply_inbox_prefix(&user));
            opts = opts.user_and_password(user, pass);
        }
    }

    match std::env::var("PARVANE_NATS_TLS_CA") {
        Ok(ca) if !ca.is_empty() => {
            opts.require_tls(true)
                .add_root_certificates(std::path::PathBuf::from(ca))
                .connect(url)
                .await
        }
        _ => opts.connect(url).await,
    }
}
