//! «Музыка на сервере · для администратора» и «Люди и лимиты» (макет «Музыки» 23 ноя, доски `MusicSettings`,
//! `ZdMusicX-06`). Настройки сервера — в таблице `music_settings` (исходные значения — переменные окружения
//! `PARVANE_MUSIC_ADD_PER_DAY`, `PARVANE_MUSIC_QUOTA_BYTES`, `PARVANE_MUSIC_UPLOAD_MAX_BYTES`), личные лимиты — в
//! `user_limits`. Действующие лимиты человека (`Limits`) проверяют задачи скачивания, загрузка своих файлов и
//! удаление чужого. Менять — только администратор (`PARVANE_MUSIC_ADMINS`).

use std::collections::BTreeSet;

use parvane_protocol::pb::parvane::core::v2::ErrorCode;
use parvane_protocol::pb::parvane::music::v1 as pb;
use prost::Message as _;
use serde_json::Value;
use tracing::error;

use crate::fetch::jobs::Fetch;
use crate::subsonic::{Subsonic, SERVICE_USER};

type Reply = Result<Vec<u8>, ErrorCode>;

const DAY_MS: i64 = 86_400_000;
const PER_DAY_MAX: u32 = 10_000;
const FIELDS: [&str; 7] = ["per_day", "quota_bytes", "upload_max_bytes", "links", "uploads", "only_admins_delete", "confirm_album_delete"];

/// Действующие для человека лимиты и права.
#[derive(Clone, Debug)]
pub(crate) struct Limits {
    pub per_day: u32,
    pub quota_bytes: u64,
    pub upload_max_bytes: u64,
    pub links: bool,
    pub uploads: bool,
    pub only_admins_delete: bool,
}

fn db_err(e: sqlx::Error) -> ErrorCode {
    error!("музыка: настройки сервера: {e}");
    ErrorCode::Unavailable
}

fn nick(address: &str) -> String {
    address.split('@').next().unwrap_or("").chars().take(64).collect()
}

impl Fetch {
    /// Настройки сервера: сохранённое администратором поверх значений окружения.
    pub(crate) async fn settings(&self) -> pb::AdminSettings {
        let mut s = pb::AdminSettings {
            per_day: self.add_per_day,
            quota_bytes: self.quota_bytes,
            upload_max_bytes: self.upload_max_bytes,
            links: true,
            uploads: true,
            only_admins_delete: true,
            confirm_album_delete: true,
        };
        let rows: Vec<(String, String)> = match sqlx::query_as("SELECT key, value FROM music_settings").fetch_all(&self.pool).await {
            Ok(rows) => rows,
            Err(e) => {
                error!("музыка: настройки сервера не прочитаны: {e}");
                return s;
            }
        };
        for (key, value) in rows {
            let flag = value == "1";
            match key.as_str() {
                "per_day" => s.per_day = value.parse().unwrap_or(s.per_day),
                "quota_bytes" => s.quota_bytes = value.parse().unwrap_or(s.quota_bytes),
                "upload_max_bytes" => s.upload_max_bytes = value.parse().unwrap_or(s.upload_max_bytes),
                "links" => s.links = flag,
                "uploads" => s.uploads = flag,
                "only_admins_delete" => s.only_admins_delete = flag,
                "confirm_album_delete" => s.confirm_album_delete = flag,
                _ => {}
            }
        }
        s
    }

    /// Лимиты человека: свой суточный лимит перекрывает общий; «без каталога» — ноль.
    pub(crate) async fn limits_for(&self, address: &str) -> Limits {
        let s = self.settings().await;
        let own: Option<(Option<i64>, i64)> = sqlx::query_as("SELECT per_day, no_catalog FROM user_limits WHERE user = ?").bind(address).fetch_optional(&self.pool).await.unwrap_or(None);
        let per_day = match own {
            Some((_, no_catalog)) if no_catalog != 0 => 0,
            Some((Some(n), _)) => u32::try_from(n.max(0)).unwrap_or(0),
            _ => s.per_day,
        };
        Limits { per_day, quota_bytes: s.quota_bytes, upload_max_bytes: s.upload_max_bytes, links: s.links, uploads: s.uploads, only_admins_delete: s.only_admins_delete }
    }

    async fn scan_status(&self, sub: &Subsonic) -> pb::ScanStatus {
        let v = sub.call(SERVICE_USER, "getScanStatus", &[]).await.unwrap_or(Value::Null);
        let st = v.get("scanStatus").cloned().unwrap_or(Value::Null);
        let last = st.get("lastScan").and_then(Value::as_str).and_then(parse_time_ms).unwrap_or(0);
        pb::ScanStatus {
            scanning: st.get("scanning").and_then(Value::as_bool).unwrap_or(false),
            last_scan_ms: last,
            tracks: st.get("count").and_then(Value::as_u64).and_then(|n| u32::try_from(n).ok()).unwrap_or(0),
        }
    }

    pub async fn admin_get(&self, sub: &Subsonic, address: &str) -> Reply {
        let admin = self.is_admin(address);
        let duplicates: (i64,) = sqlx::query_as("SELECT COUNT(*) FROM (SELECT name_key FROM added_tracks WHERE deleted_ms = 0 AND name_key != '' GROUP BY name_key, version HAVING COUNT(*) > 1)")
            .fetch_one(&self.pool)
            .await
            .map_err(db_err)?;
        Ok(pb::AdminGetResponse {
            settings: Some(self.settings().await),
            admin,
            library_dir: if admin { self.library_dir.display().to_string() } else { String::new() },
            scan: Some(self.scan_status(sub).await),
            duplicates: u32::try_from(duplicates.0).unwrap_or(0),
            people: u32::try_from(self.people_addresses().await?.len()).unwrap_or(0),
            parallel: u32::try_from(self.parallel).unwrap_or(u32::MAX),
            fetch_enabled: self.service.is_some(),
        }
        .encode_to_vec())
    }

    pub async fn admin_set(&self, address: &str, r: pb::AdminSetRequest) -> Reply {
        if !self.is_admin(address) {
            return Err(ErrorCode::Forbidden);
        }
        let new = r.settings.unwrap_or_default();
        for field in &r.fields {
            let value = match field.as_str() {
                "per_day" if new.per_day <= PER_DAY_MAX => new.per_day.to_string(),
                "quota_bytes" => new.quota_bytes.to_string(),
                "upload_max_bytes" if new.upload_max_bytes > 0 => new.upload_max_bytes.to_string(),
                "links" => u8::from(new.links).to_string(),
                "uploads" => u8::from(new.uploads).to_string(),
                "only_admins_delete" => u8::from(new.only_admins_delete).to_string(),
                "confirm_album_delete" => u8::from(new.confirm_album_delete).to_string(),
                f if FIELDS.contains(&f) => return Err(ErrorCode::Invalid),
                _ => continue,
            };
            sqlx::query("INSERT OR REPLACE INTO music_settings (key, value) VALUES (?, ?)").bind(field).bind(value).execute(&self.pool).await.map_err(db_err)?;
        }
        Ok(pb::AdminSetResponse { settings: Some(self.settings().await) }.encode_to_vec())
    }

    /// Люди с музыкой на сервере: добавлявшие, слушавшие, с личным лимитом, администраторы.
    async fn people_addresses(&self) -> Result<BTreeSet<String>, ErrorCode> {
        let mut out: BTreeSet<String> = self.admins.iter().cloned().collect();
        for sql in ["SELECT DISTINCT adder FROM added_tracks", "SELECT DISTINCT user FROM plays", "SELECT user FROM user_limits"] {
            let rows: Vec<(String,)> = sqlx::query_as(sql).fetch_all(&self.pool).await.map_err(db_err)?;
            out.extend(rows.into_iter().map(|(a,)| a).filter(|a| a.contains('@')));
        }
        Ok(out)
    }

    async fn person(&self, address: &str) -> pb::Person {
        let (today, bytes) = self.usage(address).await;
        let own: Option<(Option<i64>, i64)> = sqlx::query_as("SELECT per_day, no_catalog FROM user_limits WHERE user = ?").bind(address).fetch_optional(&self.pool).await.unwrap_or(None);
        let limits = self.limits_for(address).await;
        pb::Person {
            address: address.to_string(),
            nick: nick(address),
            admin: self.is_admin(address),
            today: if today == u32::MAX { 0 } else { today },
            bytes: if bytes == u64::MAX { 0 } else { bytes },
            per_day: limits.per_day,
            own_limit: own.as_ref().is_some_and(|(n, _)| n.is_some()),
            no_catalog: own.is_some_and(|(_, no)| no != 0),
        }
    }

    pub async fn admin_people(&self, address: &str) -> Reply {
        if !self.is_admin(address) {
            return Err(ErrorCode::Forbidden);
        }
        let mut people = Vec::new();
        for a in self.people_addresses().await? {
            people.push(self.person(&a).await);
        }
        // Администраторы первыми, потом по нику
        people.sort_by(|a, b| b.admin.cmp(&a.admin).then_with(|| a.nick.cmp(&b.nick)));
        Ok(pb::AdminPeopleResponse { people }.encode_to_vec())
    }

    pub async fn admin_person_set(&self, address: &str, r: pb::AdminPersonSetRequest) -> Reply {
        if !self.is_admin(address) {
            return Err(ErrorCode::Forbidden);
        }
        let who = r.address.trim();
        if !who.contains('@') || who.len() > 128 || r.per_day > PER_DAY_MAX {
            return Err(ErrorCode::Invalid);
        }
        let per_day: Option<i64> = if r.reset { None } else { Some(i64::from(r.per_day)) };
        sqlx::query("INSERT OR REPLACE INTO user_limits (user, per_day, no_catalog) VALUES (?, ?, ?)")
            .bind(who)
            .bind(per_day)
            .bind(i64::from(r.no_catalog))
            .execute(&self.pool)
            .await
            .map_err(db_err)?;
        Ok(pb::AdminPersonSetResponse { person: Some(self.person(who).await) }.encode_to_vec())
    }

    pub async fn admin_scan(&self, sub: &Subsonic, address: &str) -> Reply {
        if !self.is_admin(address) {
            return Err(ErrorCode::Forbidden);
        }
        let _ = sub.call(SERVICE_USER, "startScan", &[]).await;
        Ok(pb::AdminScanResponse { scan: Some(self.scan_status(sub).await) }.encode_to_vec())
    }
}

/// «2026-11-23T03:40:00Z» (как отдаёт музыкальный сервер) → мс; не разобралось — `None`.
fn parse_time_ms(text: &str) -> Option<i64> {
    let date = text.get(..10)?;
    let mut parts = date.split('-').map(|p| p.parse::<i64>().ok());
    let (y, m, d) = (parts.next()??, parts.next()??, parts.next()??);
    let time = text.get(11..19).unwrap_or("00:00:00");
    let mut t = time.split(':').map(|p| p.parse::<i64>().ok());
    let (hh, mm, ss) = (t.next().flatten().unwrap_or(0), t.next().flatten().unwrap_or(0), t.next().flatten().unwrap_or(0));
    // Дни от 1970-01-01 (Говард Хиннант, days_from_civil)
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let doy = (153 * (if m > 2 { m - 3 } else { m + 9 }) + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146_097 + doe - 719_468;
    Some(days * DAY_MS + (hh * 3600 + mm * 60 + ss) * 1000)
}

#[cfg(test)]
mod tests {
    #[test]
    fn scan_time_is_parsed() {
        assert_eq!(super::parse_time_ms("1970-01-02T00:00:01Z"), Some(86_401_000));
        assert_eq!(super::parse_time_ms("2026-11-23T03:40:00.123Z"), Some(1_795_405_200_000));
        assert_eq!(super::parse_time_ms("мусор"), None);
    }
}
