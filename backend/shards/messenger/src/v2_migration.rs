//! Разовый перенос на стороне сервера (spec 035, US1, FR-061, FR-066; T104, T150).
//!
//! **Сводный порядок миграций сервера spec 035** (принцип VII: шарды стартуют в прежнем порядке — nats → identity →
//! messenger → cloud → domains → … → gateway; каждый шард до приёма запросов сам доводит свои миграции):
//!
//! | Шард | Миграция `migrations_v2/` | Что | Данные |
//! |---|---|---|---|
//! | messenger | `0007_user_state_log_v2` | журнал `state.v2` (`user_state_log_v2`, `user_state_head_v2`) | новые таблицы; `user_state_log` заморожен (`state.append` → `UPGRADE_REQUIRED`), переносят клиенты |
//! | messenger | `0008_group_windows` | окна членства `group_membership_windows`, `group_windows_built` | пересчёт из `group_state_log` при старте (`v2_groups::rebuild_windows`) ДО приёма запросов |
//! | messenger | `0009_remote_group_subscriptions` | подписки на группы чужих серверов (PV-014) | новая таблица; клиенты подписываются при переносе (T103) |
//! | messenger | `0010_inbox_group_key` | `inbox_log.group_key` (одно неподтверждённое уведомление журнала на группу) | колонка, у прежних записей — NULL |
//! | messenger | `0011_device_minor_seen` | статистика «устройства перенесли» (T150) | новая таблица |
//! | messenger | `0012_drop_legacy_origin` | удаление таблицы `legacy_origin` (легаси-копии v1, T096) | на проде строк 0 |
//! | domains | `0005_log_truncation` | `containers.truncated_upto` (обрезка журнала снимком с `complete`) | колонка, 0 |
//! | identity | — | новые виды записей журнала устройств (ротация SSK) | без переноса |
//!
//! Шифртекст не трогается ни одной миграцией. Проверка «ничего не потеряно» — `scripts/migration_audit_server.py`
//! (выгрузки до/после и инварианты), `messenger --migration-check` (окна членства согласны с журналами групп),
//! прогон — `scripts/migration_server_check.sh` на синтетической базе (T101) и на копии прода (T143, по слову
//! пользователя).
//!
//! Флаги шарда (выход до NATS, кроме `--migration-check`): `--migrate-only` — открыть базу, применить миграции и выйти;
//! `--migration-status` — числа «устройства перенесли» (JSON, без адресов); `--migration-check` — с NATS и identity
//! пересчитать окна членства по журналам и сравнить с таблицей.

use std::collections::{BTreeMap, BTreeSet, HashSet};
use std::sync::{Mutex, OnceLock};

use sqlx::SqlitePool;
use tracing::warn;

/// Сводный порядок миграций сервера spec 035: (шард, файл миграции).
pub(crate) const ORDER: &[(&str, &str)] = &[
    ("messenger", "0007_user_state_log_v2.sql"),
    ("messenger", "0008_group_windows.sql"),
    ("messenger", "0009_remote_group_subscriptions.sql"),
    ("messenger", "0010_inbox_group_key.sql"),
    ("messenger", "0011_device_minor_seen.sql"),
    ("messenger", "0012_drop_legacy_origin.sql"),
    ("domains", "0005_log_truncation.sql"),
];

fn seen() -> &'static Mutex<HashSet<String>> {
    static S: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
    S.get_or_init(Default::default)
}

/// Отметить устройство, подключившееся с минором `minor` (один раз на процесс — дальше без записи в базу).
pub(crate) async fn mark_minor(pool: &SqlitePool, device: &str, minor: u32) {
    if minor < parvane_protocol::limits::PROTO_MINOR_035 {
        return;
    }
    if seen().lock().map(|s| s.contains(device)).unwrap_or(false) {
        return;
    }
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0);
    let r = sqlx::query("INSERT INTO device_minor_seen (device, minor, first_ms) VALUES (?, ?, ?) ON CONFLICT(device) DO UPDATE SET minor = MAX(minor, excluded.minor)")
        .bind(device)
        .bind(i64::from(minor))
        .bind(now)
        .execute(pool)
        .await;
    match r {
        Ok(_) => {
            if let Ok(mut s) = seen().lock() {
                s.insert(device.to_string());
            }
        }
        Err(e) => warn!("messenger: отметка минора устройства: {}", e),
    }
}

/// Статистика «устройства перенесли» (только числа).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(crate) struct MigrationStatus {
    /// Устройства с инбоксом (`inbox_device`).
    pub devices: u64,
    /// Из них подключались с минором ≥ `PROTO_MINOR_035`.
    pub devices_new: u64,
    /// Аккаунты с журналом личного состояния (прежним или новым).
    pub accounts: u64,
    /// Из них с `Migrated` в новом журнале (op_id `Migrated` выводится из адреса, шифртекст не открывается).
    pub accounts_migrated: u64,
}

impl MigrationStatus {
    pub fn json(&self) -> String {
        format!(
            "{{\"devices\":{},\"devices_new_minor\":{},\"devices_left\":{},\"accounts\":{},\"accounts_migrated\":{},\"accounts_left\":{}}}",
            self.devices,
            self.devices_new,
            self.devices.saturating_sub(self.devices_new),
            self.accounts,
            self.accounts_migrated,
            self.accounts.saturating_sub(self.accounts_migrated)
        )
    }
}

pub(crate) async fn status(pool: &SqlitePool) -> anyhow::Result<MigrationStatus> {
    let devices: Vec<(String,)> = sqlx::query_as("SELECT device FROM inbox_device").fetch_all(pool).await?;
    let new: Vec<(String,)> = sqlx::query_as("SELECT device FROM device_minor_seen WHERE minor >= ?")
        .bind(i64::from(parvane_protocol::limits::PROTO_MINOR_035))
        .fetch_all(pool)
        .await?;
    let all: BTreeSet<String> = devices.into_iter().map(|(d,)| d).collect();
    let new: BTreeSet<String> = new.into_iter().map(|(d,)| d).collect();
    let users: Vec<(String,)> = sqlx::query_as("SELECT user FROM user_state_log UNION SELECT user FROM user_state_log_v2").fetch_all(pool).await?;
    let mut migrated = 0u64;
    for (u,) in &users {
        let id = parvane_protocol::migrate::state_v1::migrated_op_id(u);
        let r: Option<(i64,)> = sqlx::query_as("SELECT 1 FROM user_state_log_v2 WHERE user = ? AND op_id = ?").bind(u).bind(id.to_vec()).fetch_optional(pool).await?;
        if r.is_some() {
            migrated += 1;
        }
    }
    Ok(MigrationStatus {
        devices: all.len() as u64,
        devices_new: all.intersection(&new).count() as u64,
        accounts: users.len() as u64,
        accounts_migrated: migrated,
    })
}

/// Окна членства по журналам групп против таблицы: (групп проверено, групп с расхождением).
pub(crate) async fn windows_check(ctx: &crate::v2::V2) -> anyhow::Result<(u64, u64)> {
    let groups: Vec<(Vec<u8>,)> = sqlx::query_as("SELECT DISTINCT group_id FROM group_state_log").fetch_all(&ctx.v2).await?;
    let (mut n, mut bad) = (0u64, 0u64);
    for (gid,) in groups {
        n += 1;
        let Some(want) = crate::v2_groups::expected_windows(ctx, &gid).await else {
            bad += 1;
            continue;
        };
        let have: Vec<(String, i64, Option<i64>)> =
            sqlx::query_as("SELECT user, join_v, exit_v FROM group_membership_windows WHERE group_id = ? ORDER BY user, join_v").bind(&gid).fetch_all(&ctx.v2).await?;
        let have: BTreeMap<(String, i64), Option<i64>> = have.into_iter().map(|(u, j, e)| ((u, j), e)).collect();
        if have != want {
            bad += 1;
        }
    }
    Ok((n, bad))
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn pool() -> SqlitePool {
        let p = sqlx::sqlite::SqlitePoolOptions::new().max_connections(1).connect("sqlite::memory:").await.unwrap();
        sqlx::migrate!("./migrations_v2").run(&p).await.unwrap();
        p
    }

    /// T150: подсчёт «устройства перенесли» — устройства с инбоксом и отметкой минора, аккаунты с `Migrated`.
    #[tokio::test]
    async fn migration_status_counts() {
        let p = pool().await;
        assert_eq!(status(&p).await.unwrap(), MigrationStatus::default());
        for d in ["dev-a", "dev-b", "dev-c"] {
            sqlx::query("INSERT INTO inbox_device (device) VALUES (?)").bind(d).execute(&p).await.unwrap();
        }
        mark_minor(&p, "dev-a", parvane_protocol::limits::PROTO_MINOR_035).await;
        mark_minor(&p, "dev-b", 0).await; // старый минор не отмечается
        mark_minor(&p, "dev-z", parvane_protocol::limits::PROTO_MINOR_035).await; // без инбокса — не считается
        mark_minor(&p, "dev-a", parvane_protocol::limits::PROTO_MINOR_035).await; // повтор — без изменений
        for (u, seq) in [("alice@local", 1), ("bob@local", 1), ("carol@local", 1)] {
            sqlx::query("INSERT INTO user_state_log (user, seq, op_id, record, at) VALUES (?, ?, ?, x'00', 0)").bind(u).bind(seq).bind(vec![seq as u8; 16]).execute(&p).await.unwrap();
        }
        // alice перенесла (Migrated), bob пишет в новый журнал без Migrated, dave — только новый журнал
        let mid = parvane_protocol::migrate::state_v1::migrated_op_id("alice@local");
        sqlx::query("INSERT INTO user_state_log_v2 (user, seq, op_id, record, at) VALUES ('alice@local', 1, ?, x'00', 0)").bind(mid.to_vec()).execute(&p).await.unwrap();
        sqlx::query("INSERT INTO user_state_log_v2 (user, seq, op_id, record, at) VALUES ('bob@local', 1, ?, x'00', 0)").bind(vec![7u8; 16]).execute(&p).await.unwrap();
        let mid = parvane_protocol::migrate::state_v1::migrated_op_id("dave@local");
        sqlx::query("INSERT INTO user_state_log_v2 (user, seq, op_id, record, at) VALUES ('dave@local', 1, ?, x'00', 0)").bind(mid.to_vec()).execute(&p).await.unwrap();
        let s = status(&p).await.unwrap();
        assert_eq!(s, MigrationStatus { devices: 3, devices_new: 1, accounts: 4, accounts_migrated: 2 });
        assert_eq!(s.json(), r#"{"devices":3,"devices_new_minor":1,"devices_left":2,"accounts":4,"accounts_migrated":2,"accounts_left":2}"#);
        assert!(!s.json().contains('@'), "без адресов");
    }

    /// T096: после миграций таблицы легаси-копий v1 нет (`0012_drop_legacy_origin`), прочие таблицы целы.
    #[tokio::test]
    async fn legacy_origin_dropped() {
        let p = pool().await;
        let n: (i64,) = sqlx::query_as("SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'legacy_origin'").fetch_one(&p).await.unwrap();
        assert_eq!(n.0, 0, "таблица legacy_origin осталась");
        let n: (i64,) = sqlx::query_as("SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'inbox_log'").fetch_one(&p).await.unwrap();
        assert_eq!(n.0, 1);
    }

    /// T104: сводный порядок перечисляет все миграции spec 035 этого шарда, и они есть в каталоге.
    #[test]
    fn order_lists_existing_migrations() {
        let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
        for (shard, file) in ORDER {
            let p = dir.join("..").join(shard).join("migrations_v2").join(file);
            assert!(p.is_file(), "нет миграции {shard}/{file}");
        }
        let mut names: Vec<String> = std::fs::read_dir(dir.join("migrations_v2")).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().to_string()).collect();
        names.sort();
        let ours: Vec<&str> = ORDER.iter().filter(|(s, _)| *s == "messenger").map(|(_, f)| *f).collect();
        let tail: Vec<&str> = names.iter().map(String::as_str).filter(|n| n.as_bytes()[..4] >= b"0007"[..]).collect();
        assert_eq!(tail, ours, "миграция messenger после 0006 не в сводном порядке");
    }
}
