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

/// Проверка, что строка безопасна как ЧАСТЬ NATS-subject: непустая, без
/// пробельных символов (в т.ч. CR/LF — иначе кадр `PUB <subj> <len>` можно
/// разорвать и внедрить второй `PUB`/`SUB`), без разделителя токенов `.` на
/// краях и без wildcard-символов `*`/`>`. Применяется во всех шардах ПЕРЕД
/// каждым `publish` с subject, собранным из пользовательского ввода.
pub fn is_valid_subject_token(token: &str) -> bool {
    !token.is_empty()
        && !token.starts_with('.')
        && !token.ends_with('.')
        && token.bytes().all(|b| {
            !b.is_ascii_whitespace() && b != b'*' && b != b'>' && b != 0
        })
}

#[cfg(test)]
mod subject_tests {
    use super::is_valid_subject_token;

    #[test]
    fn rejects_injection_and_wildcards() {
        assert!(is_valid_subject_token("bob@local"));
        assert!(is_valid_subject_token("gcall:alice@local"));
        // Инъекция кадра через пробел/CRLF
        assert!(!is_valid_subject_token("bob@s 0\r\n\r\nPUB msg.user.bob@s 3"));
        assert!(!is_valid_subject_token("bob@s\tx"));
        assert!(!is_valid_subject_token("bob\r@s"));
        assert!(!is_valid_subject_token("bob\n@s"));
        // Wildcards и пустое
        assert!(!is_valid_subject_token(">"));
        assert!(!is_valid_subject_token("*"));
        assert!(!is_valid_subject_token(""));
        assert!(!is_valid_subject_token(".bob"));
        assert!(!is_valid_subject_token("bob."));
    }
}
