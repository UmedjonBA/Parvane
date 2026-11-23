//! «Добавить на сервер всё» исполнителя (макет «Музыки» 23 ноя, доска `XpMusic-02`). План — выпуски каталога по
//! типам (альбомы, синглы и EP, сборники, концертные) с числом треков, сколько уже на сервере и сколько можно сегодня.
//! Запуск ставит задачи на треки выбранных выпусков, которых нет в библиотеке; что не влезло в суточный лимит, ждёт в
//! `deferred_fetch` и ставится само, когда лимит снова позволяет (`run_deferred`, «остальные — завтра сами»).

use std::collections::{BTreeMap, BTreeSet};
use std::sync::Arc;

use parvane_protocol::pb::parvane::core::v2::ErrorCode;
use parvane_protocol::pb::parvane::music::v1 as pb;
use prost::Message;
use serde_json::Value;
use tracing::{error, info};

use super::jobs::{new_id, query_of, Fetch, Job};
use super::service::{clip, num};
use crate::now_ms;
use crate::subsonic::{list, nd_user, Subsonic};

type Reply = Result<Vec<u8>, ErrorCode>;

const KINDS: [&str; 4] = ["album", "single", "compile", "live"];
/// Отложенных треков у человека — не больше (защита от бесконечной очереди).
const DEFERRED_MAX: i64 = 2000;

fn db_err(e: sqlx::Error) -> ErrorCode {
    error!("музыка: отложенные треки: {e}");
    ErrorCode::Unavailable
}

impl Fetch {
    async fn artist_releases(&self, artist_ref: &str) -> Result<(String, Vec<(String, String, u32)>), ErrorCode> {
        let r = artist_ref.trim();
        if !r.strip_prefix("dz:").is_some_and(|id| !id.is_empty() && id.bytes().all(|b| b.is_ascii_digit())) {
            return Err(ErrorCode::Invalid);
        }
        let v = self.catalog_service("artist_plan", &[("ref", r.to_string())]).await?;
        let name = v.get("artist").map(|a| clip(a, "name")).unwrap_or_default();
        let releases = v
            .get("releases")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .map(|x| (clip(x, "ref"), clip(x, "kind"), num(x, "tracks")))
            .filter(|(r, k, _)| !r.is_empty() && KINDS.contains(&k.as_str()))
            .collect();
        Ok((name, releases))
    }

    /// Треков исполнителя в библиотеке сервера (по имени).
    async fn artist_on_server(sub: &Subsonic, user: &str, name: &str) -> u32 {
        if name.is_empty() {
            return 0;
        }
        let Ok(v) = sub.call(user, "search3", &[("query", name.to_string()), ("artistCount", "5".into()), ("albumCount", "0".into()), ("songCount", "0".into())]).await else {
            return 0;
        };
        let lower = name.to_lowercase();
        let Some(id) = list(&v, &["searchResult3", "artist"]).iter().find(|a| a.get("name").and_then(Value::as_str).is_some_and(|n| n.to_lowercase() == lower)).and_then(|a| a.get("id").and_then(Value::as_str)).map(str::to_string) else {
            return 0;
        };
        let Ok(a) = sub.call(user, "getArtist", &[("id", id)]).await else { return 0 };
        list(&a, &["artist", "album"]).iter().map(|al| al.get("songCount").and_then(Value::as_u64).unwrap_or(0)).sum::<u64>().try_into().unwrap_or(u32::MAX)
    }

    pub async fn artist_plan(&self, sub: &Subsonic, address: &str, r: pb::FetchArtistPlanRequest) -> Reply {
        let (name, releases) = self.artist_releases(&r.artist_ref).await?;
        let mut groups: BTreeMap<&str, (u32, u32)> = BTreeMap::new();
        for (_, kind, tracks) in &releases {
            let g = groups.entry(KINDS.iter().find(|k| *k == kind).copied().unwrap_or("album")).or_default();
            g.0 += 1;
            g.1 += tracks;
        }
        let limits = self.limits_for(address).await;
        let (today, _) = self.usage(address).await;
        Ok(pb::FetchArtistPlanResponse {
            groups: KINDS.iter().filter_map(|k| groups.get(k).map(|(n, t)| pb::ReleaseGroup { kind: (*k).to_string(), releases: *n, tracks: *t })).collect(),
            on_server: Self::artist_on_server(sub, &nd_user(address), &name).await,
            today_left: limits.per_day.saturating_sub(today),
        }
        .encode_to_vec())
    }

    /// Поставить задачу на трек каталога; лимит кончился — `Err(Limit)`, уже качается — `Err(Duplicate)`.
    pub(crate) async fn start_track(self: &Arc<Self>, sub: Arc<Subsonic>, address: &str, track: &pb::CatalogTrack, star: bool) -> Result<String, ErrorCode> {
        let mut job = Job::new(new_id(), address, pb::FetchState::Queued);
        job.query = query_of(track);
        job.year = track.year;
        job.star = star;
        if job.query.artist.is_empty() || job.query.title.is_empty() {
            return Err(ErrorCode::Invalid);
        }
        let q = job.query.clone();
        self.admit(address, job.clone(), |j| j.query.artist == q.artist && j.query.title == q.title).await?;
        let (this, id) = (self.clone(), job.id.clone());
        self.spawn(&job.id, async move { this.run(&sub, &id).await });
        Ok(job.id)
    }

    pub async fn artist_fetch(self: &Arc<Self>, sub: Arc<Subsonic>, address: &str, r: pb::FetchArtistRequest) -> Reply {
        self.service()?;
        let kinds: BTreeSet<&str> = r.kinds.iter().map(String::as_str).filter(|k| KINDS.contains(k)).collect();
        if kinds.is_empty() {
            return Err(ErrorCode::Invalid);
        }
        let (_, releases) = self.artist_releases(&r.artist_ref).await?;
        let mut seen = BTreeSet::new();
        let (mut jobs, mut deferred, mut already) = (Vec::new(), 0u32, 0u32);
        let mut is_limited = false;
        for (album_ref, kind, _) in releases.iter().filter(|(_, k, _)| kinds.contains(k.as_str())) {
            let Ok(tracks) = self.album_references(&sub, &nd_user(address), album_ref).await else { continue };
            for track in tracks {
                if !seen.insert((track.artist.to_lowercase(), track.title.to_lowercase())) {
                    continue;
                }
                if !track.library_track_id.is_empty() {
                    already += 1;
                    continue;
                }
                if !is_limited {
                    match self.start_track(sub.clone(), address, &track, r.star).await {
                        Ok(id) => {
                            jobs.extend(self.job_pb(&id));
                            continue;
                        }
                        Err(ErrorCode::Duplicate) => continue,
                        Err(ErrorCode::Limit) => is_limited = true,
                        Err(_) => continue,
                    }
                }
                if self.defer(address, &track, r.star).await? {
                    deferred += 1;
                }
            }
            info!("музыка: «добавить всё» — выпуск {kind} разобран");
        }
        Ok(pb::FetchArtistResponse { jobs, deferred, already }.encode_to_vec())
    }

    /// Отложить трек до следующего лимита; очередь человека полна — `false`.
    async fn defer(&self, address: &str, track: &pb::CatalogTrack, star: bool) -> Result<bool, ErrorCode> {
        let (count,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM deferred_fetch WHERE user = ?").bind(address).fetch_one(&self.pool).await.map_err(db_err)?;
        if count >= DEFERRED_MAX {
            return Ok(false);
        }
        sqlx::query("INSERT INTO deferred_fetch (user, track, star, created_ms) VALUES (?, ?, ?, ?)")
            .bind(address)
            .bind(track.encode_to_vec())
            .bind(i64::from(star))
            .bind(now_ms())
            .execute(&self.pool)
            .await
            .map_err(db_err)?;
        Ok(true)
    }

    /// Отложенные треки — в работу, пока лимит каждого человека позволяет (раз в несколько минут).
    pub async fn run_deferred(self: &Arc<Self>, sub: Arc<Subsonic>) {
        if self.service.is_none() {
            return;
        }
        let users: Vec<(String,)> = match sqlx::query_as("SELECT DISTINCT user FROM deferred_fetch").fetch_all(&self.pool).await {
            Ok(rows) => rows,
            Err(e) => {
                error!("музыка: отложенные треки не прочитаны: {e}");
                return;
            }
        };
        for (user,) in users {
            let rows: Vec<(i64, Vec<u8>, i64)> = match sqlx::query_as("SELECT id, track, star FROM deferred_fetch WHERE user = ? ORDER BY id LIMIT 200").bind(&user).fetch_all(&self.pool).await {
                Ok(rows) => rows,
                Err(e) => {
                    error!("музыка: отложенные треки не прочитаны: {e}");
                    continue;
                }
            };
            for (id, raw, star) in rows {
                let result = match pb::CatalogTrack::decode(raw.as_slice()) {
                    Ok(track) => self.start_track(sub.clone(), &user, &track, star != 0).await.map(|_| ()),
                    Err(_) => Err(ErrorCode::Invalid),
                };
                if result == Err(ErrorCode::Limit) {
                    break;
                }
                if let Err(e) = sqlx::query("DELETE FROM deferred_fetch WHERE id = ?").bind(id).execute(&self.pool).await {
                    error!("музыка: отложенный трек не снят: {e}");
                    break;
                }
            }
        }
    }
}
