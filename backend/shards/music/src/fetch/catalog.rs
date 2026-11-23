//! Поиск по каталогу «Музыки» (как в HomeMusic): исполнители, альбомы и страницы треков каталога, страницы
//! исполнителя и альбома. Каталог — у сервиса скачивания (`/catalog/*`); шард переводит ответ в протокол и отмечает,
//! что уже есть в библиотеке сервера (`library_track_id`, у альбома — `owned`).

use futures::StreamExt as _;
use parvane_protocol::pb::parvane::core::v2::ErrorCode;
use parvane_protocol::pb::parvane::music::v1 as pb;
use prost::Message as _;
use serde_json::Value;

use super::jobs::{catalog_pb, Fetch};
use super::service::{clip, num, query_of_json};
use crate::subsonic::Subsonic;

type Reply = Result<Vec<u8>, ErrorCode>;

/// Проверок «уже в библиотеке» разом — не больше (у каждой — запрос к музыкальному серверу).
const OWNED_PARALLEL: usize = 8;

impl Fetch {
    pub async fn catalog_search(&self, sub: &Subsonic, user: &str, r: pb::CatalogSearchRequest) -> Reply {
        let query = r.query.trim();
        if query.is_empty() {
            return Err(ErrorCode::Invalid);
        }
        let v = self.catalog_service("search", &[("q", query.to_string()), ("offset", r.offset.to_string())]).await?;
        let tracks = self.owned_tracks(sub, user, list(&v, "tracks")).await;
        Ok(pb::CatalogSearchResponse {
            artists: list(&v, "artists").iter().map(artist_pb).collect(),
            albums: list(&v, "albums").iter().map(album_pb).collect(),
            tracks,
            has_more: v.get("has_more").and_then(Value::as_bool).unwrap_or(false),
            next_offset: num(&v, "next"),
        }
        .encode_to_vec())
    }

    /// «Чарт каталога»: популярное в каталоге с пометкой «уже в библиотеке».
    pub async fn catalog_chart(&self, sub: &Subsonic, user: &str) -> Reply {
        let v = self.catalog_service("chart", &[]).await?;
        let tracks = self.owned_tracks(sub, user, list(&v, "tracks")).await;
        Ok(pb::CatalogChartResponse { tracks }.encode_to_vec())
    }

    pub async fn catalog_artist(&self, sub: &Subsonic, user: &str, r: pb::CatalogArtistRequest) -> Reply {
        let v = self.catalog_service("artist", &[("ref", checked_ref(&r.r#ref)?)]).await?;
        let top = self.owned_tracks(sub, user, list(&v, "top")).await;
        Ok(pb::CatalogArtistResponse {
            artist: v.get("artist").map(artist_pb),
            albums: list(&v, "albums").iter().map(album_pb).collect(),
            top,
        }
        .encode_to_vec())
    }

    pub async fn catalog_album(&self, sub: &Subsonic, user: &str, r: pb::CatalogAlbumRequest) -> Reply {
        let v = self.catalog_service("album", &[("ref", checked_ref(&r.r#ref)?)]).await?;
        let tracks = self.owned_tracks(sub, user, list(&v, "tracks")).await;
        let owned = tracks.iter().filter(|t| !t.library_track_id.is_empty()).count();
        let mut album = v.get("album").map(album_pb).unwrap_or_default();
        album.owned = match owned {
            0 => pb::OwnedStatus::None,
            n if n == tracks.len() => pb::OwnedStatus::Full,
            _ => pb::OwnedStatus::Partial,
        } as i32;
        Ok(pb::CatalogAlbumResponse { album: Some(album), tracks }.encode_to_vec())
    }

    /// Треки каталога (альбом целиком для «Скачать альбом»): эталоны с пометкой «уже в библиотеке».
    pub(crate) async fn album_references(&self, sub: &Subsonic, user: &str, album_ref: &str) -> Result<Vec<pb::CatalogTrack>, ErrorCode> {
        let v = self.catalog_service("album", &[("ref", checked_ref(album_ref)?)]).await?;
        Ok(self.owned_tracks(sub, user, list(&v, "tracks")).await)
    }

    pub(crate) async fn catalog_service(&self, path: &str, params: &[(&str, String)]) -> Result<Value, ErrorCode> {
        self.service()?.catalog_call(path, params).await.map_err(|_| ErrorCode::Unavailable)
    }

    async fn owned_tracks(&self, sub: &Subsonic, user: &str, raw: &[Value]) -> Vec<pb::CatalogTrack> {
        let queries: Vec<(crate::fetch::matching::Query, u32)> = raw.iter().map(|t| (query_of_json(t), num(t, "year"))).collect();
        let mut out = Vec::with_capacity(queries.len());
        let mut checks = futures::stream::iter(queries.into_iter().map(|(q, year)| async move {
            let owned = self.in_library(sub, user, &q).await.map(|t| t.id).unwrap_or_default();
            catalog_pb(&q, year, owned)
        }))
        .buffered(OWNED_PARALLEL);
        while let Some(track) = checks.next().await {
            out.push(track);
        }
        out
    }
}

fn checked_ref(r: &str) -> Result<String, ErrorCode> {
    let r = r.trim();
    if r.strip_prefix("dz:").is_some_and(|id| !id.is_empty() && id.bytes().all(|b| b.is_ascii_digit())) {
        Ok(r.to_string())
    } else {
        Err(ErrorCode::Invalid)
    }
}

fn list<'a>(v: &'a Value, key: &str) -> &'a [Value] {
    v.get(key).and_then(Value::as_array).map(Vec::as_slice).unwrap_or(&[])
}

pub(crate) fn artist_pb(v: &Value) -> pb::CatalogArtist {
    pb::CatalogArtist { r#ref: clip(v, "ref"), name: clip(v, "name"), picture_url: clip(v, "picture"), albums_count: num(v, "albums"), on_server: false }
}

fn album_pb(v: &Value) -> pb::CatalogAlbum {
    let explicit = match v.get("explicit").and_then(Value::as_bool) {
        Some(true) => pb::Explicit::Yes,
        Some(false) => pb::Explicit::No,
        None => pb::Explicit::Unspecified,
    };
    pb::CatalogAlbum {
        r#ref: clip(v, "ref"),
        title: clip(v, "title"),
        artist: clip(v, "artist"),
        artist_ref: clip(v, "artist_ref"),
        cover_url: clip(v, "cover"),
        year: num(v, "year"),
        record_type: clip(v, "record_type"),
        tracks_count: num(v, "tracks"),
        explicit: explicit as i32,
        owned: pb::OwnedStatus::Unspecified as i32,
    }
}
