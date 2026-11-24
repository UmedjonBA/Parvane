//! Поиск по каталогу, «Скачать альбом», «Микс дня», «Не нравится» и история поиска (как в HomeMusic).

use parvane_protocol::music_mix;
use parvane_protocol::pb::parvane::music::v1 as pb;
use serde_json::json;

use crate::tests::{call, setup_fetch};

/// База прослушиваний теста; замок держится до конца теста (`let _plays = with_plays(..)`)
async fn with_plays(dir: &std::path::Path) -> tokio::sync::MutexGuard<'static, ()> {
    let guard = crate::tests::plays_guard().await;
    crate::library::open_plays(dir.join("music.db").to_str().unwrap()).await;
    guard
}

#[tokio::test]
async fn catalog_search_marks_owned_and_album_page_counts_them() {
    let (_, ctx, dir) = setup_fetch(30, u64::MAX).await;
    let found: pb::CatalogSearchResponse = call(&ctx, "alice@local", "music.catalog.search", pb::CatalogSearchRequest { query: "группа".into(), offset: 0 }).await.unwrap();
    assert_eq!((found.artists.len(), found.albums.len(), found.tracks.len(), found.has_more, found.next_offset), (1, 1, 2, true, 2));
    let owned: Vec<_> = found.tracks.iter().map(|t| (t.title.as_str(), !t.library_track_id.is_empty(), t.r#ref.as_str())).collect();
    assert_eq!(owned, [("Песня t2", true, "dz:100"), ("Новая", false, "dz:101")], "уже в библиотеке — с её треком");
    let album: pb::CatalogAlbumResponse = call(&ctx, "alice@local", "music.catalog.album", pb::CatalogAlbumRequest { r#ref: "dz:10".into() }).await.unwrap();
    assert_eq!(album.album.unwrap().owned, pb::OwnedStatus::Partial as i32, "один из двух — частично");
    // Исполнитель каталога: релизы и «Популярное» с той же пометкой «уже на сервере»
    let artist: pb::CatalogArtistResponse = call(&ctx, "alice@local", "music.catalog.artist", pb::CatalogArtistRequest { r#ref: "dz:1".into() }).await.unwrap();
    assert_eq!((artist.albums.len(), artist.top.len()), (1, 2));
    assert!(!artist.top[0].library_track_id.is_empty() && artist.top[1].library_track_id.is_empty());
    // Не ссылка каталога — отказ до сервиса
    let bad = call::<pb::CatalogAlbumResponse>(&ctx, "alice@local", "music.catalog.album", pb::CatalogAlbumRequest { r#ref: "../x".into() }).await;
    assert!(bad.is_err());
    let _ = std::fs::remove_dir_all(dir);
}

#[tokio::test]
async fn album_download_queues_only_missing_tracks() {
    let (_, ctx, dir) = setup_fetch(30, u64::MAX).await;
    let r: pb::FetchStartResponse = call(&ctx, "alice@local", "music.fetch.start", pb::FetchStartRequest { album_ref: "dz:10".into(), ..Default::default() }).await.unwrap();
    let titles: Vec<_> = r.jobs.iter().map(|j| j.track.as_ref().unwrap().title.clone()).collect();
    assert_eq!(titles, ["Новая"], "«Песня t2» уже есть — не качается");
    assert_eq!(r.job.unwrap().track.unwrap().r#ref, "dz:101", "ссылка каталога — для полных тегов");
    let _ = std::fs::remove_dir_all(dir);
}

#[tokio::test]
async fn mix_needs_artists_then_builds_from_library_and_related() {
    let (fake, ctx, dir) = setup_fetch(30, u64::MAX).await;
    let _plays = with_plays(&dir).await;
    let user = "mixer@local";
    *fake.catalog.lock().unwrap() = vec![
        json!({"ref": "dz:200", "artist": "Соседи", "title": "Двор", "album": "Лето", "duration": 180}),
        json!({"ref": "dz:201", "artist": "Соседи", "title": "Окно", "album": "Лето", "duration": 190}),
    ];
    let first: pb::MixTodayResponse = call(&ctx, user, "music.mix.today", pb::MixTodayRequest { tz_offset_min: 180 }).await.unwrap();
    assert!(first.needs_artists && first.mix.is_none(), "без любимых исполнителей микса нет");
    let artists: pb::MixArtistsResponse = call(&ctx, user, "music.mix.artists", pb::MixArtistsRequest { query: "груп".into() }).await.unwrap();
    assert_eq!(artists.artists[0].name, "Группа");
    let set: pb::MixSettingsSetResponse = call(&ctx, user, "music.mix.settings", pb::MixSettingsSetRequest {
        set_artists: true, artists: artists.artists.clone(), mode: "normal".into(), set_hour: true, hour: 0, tz_offset_min: 180,
    }).await.unwrap();
    assert_eq!(set.settings.unwrap().artists.len(), 1);
    // Сборка — в фоне: спрашиваем, пока не готов
    let mut mix = None;
    for _ in 0..50 {
        let r: pb::MixTodayResponse = call(&ctx, user, "music.mix.today", pb::MixTodayRequest { tz_offset_min: 180 }).await.unwrap();
        if let Some(m) = r.mix.filter(|_| !r.building) {
            mix = Some(m);
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    }
    let mix = mix.expect("микс собран");
    assert!(mix.tracks.iter().any(|t| t.track.is_some()), "из библиотеки");
    let catalog: Vec<_> = mix.tracks.iter().filter_map(|t| t.catalog.as_ref().map(|c| (c.artist.clone(), t.because_of.clone()))).collect();
    assert!(catalog.contains(&("Соседи".to_string(), "Группа".to_string())), "похожие на выбранного: {catalog:?}");
    assert!(mix.next_ms > mix.built_ms);

    // «Не нравится» на исполнителя — «Другой микс» его не предлагает
    let _: pb::DislikeSetResponse = call(&ctx, user, "music.dislike.set", pb::DislikeSetRequest { artist: "Соседи".into(), ..Default::default() }).await.unwrap();
    let list: pb::DislikeListResponse = call(&ctx, user, "music.dislike.list", pb::DislikeListRequest {}).await.unwrap();
    assert_eq!((list.items.len(), list.items[0].kind.as_str()), (1, "artist"));
    // …и сразу выпадает из уже собранного сегодняшнего микса
    let now: pb::MixTodayResponse = call(&ctx, user, "music.mix.today", pb::MixTodayRequest { tz_offset_min: 180 }).await.unwrap();
    assert!(!now.mix.unwrap().tracks.iter().any(|t| t.catalog.as_ref().is_some_and(|c| c.artist == "Соседи")), "отмеченный остался в сегодняшнем миксе");
    let _: pb::MixRebuildResponse = call(&ctx, user, "music.mix.rebuild", pb::MixRebuildRequest { tz_offset_min: 180 }).await.unwrap();
    let mut rebuilt = None;
    for _ in 0..50 {
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        let r: pb::MixTodayResponse = call(&ctx, user, "music.mix.today", pb::MixTodayRequest { tz_offset_min: 180 }).await.unwrap();
        if let Some(m) = r.mix.filter(|m| !r.building && m.built_ms > mix.built_ms) {
            rebuilt = Some(m);
            break;
        }
    }
    let rebuilt = rebuilt.expect("микс пересобран");
    // «Другой микс» не повторяет треки прежнего
    let ids = |m: &pb::Mix| m.tracks.iter().map(|t| t.track.as_ref().map(|x| x.id.clone()).or_else(|| t.catalog.as_ref().map(|c| c.r#ref.clone())).unwrap_or_default()).collect::<std::collections::BTreeSet<_>>();
    let repeated = ids(&mix).intersection(&ids(&rebuilt)).count();
    assert_eq!(repeated, 0, "«Другой микс» повторил {repeated} треков: {:?} / {:?}", ids(&mix), ids(&rebuilt));
    assert!(!rebuilt.tracks.iter().any(|t| t.catalog.as_ref().is_some_and(|c| c.artist == "Соседи")), "исполнитель «не нравится» не предлагается");
    let _: pb::DislikeSetResponse = call(&ctx, user, "music.dislike.set", pb::DislikeSetRequest { artist: "Соседи".into(), undo: true, ..Default::default() }).await.unwrap();
    let list: pb::DislikeListResponse = call(&ctx, user, "music.dislike.list", pb::DislikeListRequest {}).await.unwrap();
    assert!(list.items.is_empty());
    let _ = std::fs::remove_dir_all(dir);
}

#[tokio::test]
async fn search_history_is_per_user_deduplicated_and_clearable() {
    let (_, ctx, dir) = setup_fetch(30, u64::MAX).await;
    let _plays = with_plays(&dir).await;
    let user = "searcher@local";
    for q in ["Miyagi", "кино", "miyagi"] {
        let _: pb::SearchRememberResponse = call(&ctx, user, "music.search.remember", pb::SearchRememberRequest { query: q.into() }).await.unwrap();
        tokio::time::sleep(std::time::Duration::from_millis(5)).await;
    }
    let h: pb::SearchHistoryResponse = call(&ctx, user, "music.search.history", pb::SearchHistoryRequest {}).await.unwrap();
    assert_eq!(h.queries, ["miyagi", "кино"], "повтор — наверх, в своём написании, без дубля");
    let other: pb::SearchHistoryResponse = call(&ctx, "someone@local", "music.search.history", pb::SearchHistoryRequest {}).await.unwrap();
    assert!(other.queries.is_empty(), "история своя");
    // ✕ у одного запроса — забыть только его (без учёта регистра)
    let _: pb::SearchForgetResponse = call(&ctx, user, "music.search.forget", pb::SearchForgetRequest { query: "КИНО".into() }).await.unwrap();
    let h: pb::SearchHistoryResponse = call(&ctx, user, "music.search.history", pb::SearchHistoryRequest {}).await.unwrap();
    assert_eq!(h.queries, ["miyagi"]);
    let _: pb::SearchForgetResponse = call(&ctx, user, "music.search.forget", pb::SearchForgetRequest::default()).await.unwrap();
    let h: pb::SearchHistoryResponse = call(&ctx, user, "music.search.history", pb::SearchHistoryRequest {}).await.unwrap();
    assert!(h.queries.is_empty());
    let _ = std::fs::remove_dir_all(dir);
}

/// Новое — из радио, похожих и соседнего жанра; два «не нравится» на треках исполнителя убирают его целиком;
/// дослушанное и пропущенное записываются
#[tokio::test]
async fn mix_uses_radio_genre_and_learns_from_dislikes() {
    let (_fake, ctx, dir) = setup_fetch(30, u64::MAX).await;
    let _plays = with_plays(&dir).await;
    let user = "taste@local";
    let artists: pb::MixArtistsResponse = call(&ctx, user, "music.mix.artists", pb::MixArtistsRequest { query: "груп".into() }).await.unwrap();
    let _: pb::MixSettingsSetResponse = call(&ctx, user, "music.mix.settings", pb::MixSettingsSetRequest {
        set_artists: true, artists: artists.artists.clone(), mode: "discover".into(), set_hour: true, hour: 0, tz_offset_min: 180,
    }).await.unwrap();
    let built = |after: i64| {
        let ctx = ctx.clone();
        async move {
            for _ in 0..50 {
                let r: pb::MixTodayResponse = call(&ctx, user, "music.mix.today", pb::MixTodayRequest { tz_offset_min: 180 }).await.unwrap();
                if let Some(m) = r.mix.filter(|m| !r.building && m.built_ms > after) {
                    return m;
                }
                tokio::time::sleep(std::time::Duration::from_millis(100)).await;
            }
            panic!("микс не собран");
        }
    };
    let mix = built(0).await;
    let reasons: std::collections::BTreeSet<String> = mix.tracks.iter().filter(|t| t.catalog.is_some()).map(|t| t.reason.clone()).collect();
    assert!(reasons.contains("radio") && reasons.contains("genre"), "источники нового: {reasons:?}");
    let genre_row = mix.tracks.iter().find(|t| t.reason == "genre").unwrap();
    assert_eq!(genre_row.because_of, "R&B");
    let per_radio_artist = |m: &pb::Mix, artist: &str| m.tracks.iter().filter(|t| t.catalog.as_ref().is_some_and(|c| c.artist == artist)).count();
    assert!(per_radio_artist(&mix, "Радио 0") <= music_mix::PER_ARTIST_CATALOG, "больше двух треков одного исполнителя");
    // Два «не нравится» на треках «Радио 0» — исполнитель пропадает и из сегодняшнего, и из следующего микса
    for (reference, title) in [("dz:500", "Волна 0"), ("dz:503", "Волна 3")] {
        let _: pb::DislikeSetResponse = call(&ctx, user, "music.dislike.set", pb::DislikeSetRequest { r#ref: reference.into(), artist: "Радио 0".into(), title: title.into(), ..Default::default() }).await.unwrap();
    }
    let _: pb::MixRebuildResponse = call(&ctx, user, "music.mix.rebuild", pb::MixRebuildRequest { tz_offset_min: 180 }).await.unwrap();
    let rebuilt = built(mix.built_ms).await;
    assert_eq!(per_radio_artist(&rebuilt, "Радио 0"), 0, "исполнитель с двумя «не нравится» остался");
    // Пропуск и дослушанное записываются; середина — нет
    for (listened, duration) in [(10, 200), (190, 200), (100, 200)] {
        let _: pb::ListenReportResponse = call(&ctx, user, "music.listen.report", pb::ListenReportRequest { artist: "Радио 1".into(), title: "Волна 1".into(), listened_secs: listened, duration_secs: duration }).await.unwrap();
    }
    let rows: Vec<(i64,)> = sqlx::query_as("SELECT finished FROM listens WHERE user = ? ORDER BY created_ms").bind(user).fetch_all(crate::library::plays_pool().unwrap()).await.unwrap();
    assert_eq!(rows, vec![(0,), (1,)]);
    let _ = std::fs::remove_dir_all(dir);
}
