//! Файлы библиотеки (макет «Музыки» 23 ноя): корзина на 30 дней, «Откуда файл», правка тегов, «Вставить ссылку»,
//! вторая версия трека и копия.

use parvane_protocol::pb::parvane::core::v2::ErrorCode;
use parvane_protocol::pb::parvane::music::v1 as pb;
use serde_json::json;

use crate::tests::{call, found, settled, setup_fetch, start};

#[tokio::test]
async fn deleted_track_goes_to_trash_and_comes_back() {
    let (fake, ctx, dir) = setup_fetch(30, u64::MAX).await;
    crate::library::open_plays(dir.join("music.db").to_str().unwrap()).await;
    fake.candidates.lock().unwrap().insert("youtube".into(), vec![found("a", "Группа - Песня t1", 215)]);
    let job = settled(&ctx, "alice@local", &start(&ctx, "alice@local", "Песня t1").await.unwrap().job_id).await;
    assert_eq!(job.state, pb::FetchState::Done as i32, "{job:?}");
    // Чужое удалить нельзя, своё — в корзину
    assert_eq!(call::<pb::AddedDeleteResponse>(&ctx, "bob@local", "music.added.delete", pb::AddedDeleteRequest { track_id: job.track_id.clone() }).await.unwrap_err(), ErrorCode::Forbidden);
    call::<pb::AddedDeleteResponse>(&ctx, "alice@local", "music.added.delete", pb::AddedDeleteRequest { track_id: job.track_id.clone() }).await.unwrap();
    let trash: pb::TrashListResponse = call(&ctx, "alice@local", "music.trash.list", pb::TrashListRequest {}).await.unwrap();
    assert_eq!((trash.items.len(), trash.admin), (1, false));
    let item = &trash.items[0];
    assert_eq!((item.title.as_str(), item.deleted_by.as_str(), item.days_left), ("Песня t1", "alice", 30));
    assert!(dir.join("library/.trash").join(&item.id).read_dir().unwrap().count() > 0, "файл лежит в корзине");
    let bob: pb::TrashListResponse = call(&ctx, "bob@local", "music.trash.list", pb::TrashListRequest {}).await.unwrap();
    assert!(bob.items.is_empty(), "чужая корзина не видна");
    // Стереть раньше срока — только администратор; вернуть — свой
    assert_eq!(call::<pb::TrashPurgeResponse>(&ctx, "alice@local", "music.trash.purge", pb::TrashPurgeRequest { id: item.id.clone(), all: false }).await.unwrap_err(), ErrorCode::Forbidden);
    call::<pb::TrashRestoreResponse>(&ctx, "alice@local", "music.trash.restore", pb::TrashRestoreRequest { id: item.id.clone() }).await.unwrap();
    let trash: pb::TrashListResponse = call(&ctx, "alice@local", "music.trash.list", pb::TrashListRequest {}).await.unwrap();
    assert!(trash.items.is_empty());
    // Снова в корзину и администратор чистит её целиком
    let added: pb::AddedListResponse = call(&ctx, "alice@local", "music.added.list", pb::AddedListRequest { mine: true, offset: 0, limit: 10 }).await.unwrap();
    assert_eq!(added.tracks.len(), 1, "вернувшийся трек снова в «Добавлено мной»");
    let path_row = crate::fetch::store::list(&ctx.fetch.as_ref().unwrap().pool, Some("alice@local"), 0, 10).await.unwrap();
    let row = &path_row[0];
    ctx.fetch.as_ref().unwrap().trash(ctx.sub.as_ref().unwrap(), "alice@local", row).await.unwrap();
    call::<pb::TrashPurgeResponse>(&ctx, "admin@local", "music.trash.purge", pb::TrashPurgeRequest { id: String::new(), all: true }).await.unwrap();
    let admin: pb::TrashListResponse = call(&ctx, "admin@local", "music.trash.list", pb::TrashListRequest {}).await.unwrap();
    assert!(admin.admin && admin.items.is_empty());
    let _ = std::fs::remove_dir_all(dir);
}

#[tokio::test]
async fn tags_are_edited_by_owner_or_admin_and_can_be_restored() {
    let (fake, ctx, dir) = setup_fetch(30, u64::MAX).await;
    crate::library::open_plays(dir.join("music.db").to_str().unwrap()).await;
    fake.candidates.lock().unwrap().insert("youtube".into(), vec![found("a", "Группа - Песня t1", 215)]);
    let job = settled(&ctx, "alice@local", &start(&ctx, "alice@local", "Песня t1").await.unwrap().job_id).await;
    let edit = |fields: &[&str], tags: pb::TagSet| pb::FileTagsRequest { track_ids: vec![job.track_id.clone()], tags: Some(tags), fields: fields.iter().map(|f| f.to_string()).collect(), ..Default::default() };
    let new_album = pb::TagSet { album: "Новый альбом".into(), year: 2023, ..Default::default() };
    assert_eq!(call::<pb::FileTagsResponse>(&ctx, "bob@local", "music.file.tags", edit(&["album", "year"], new_album.clone())).await.unwrap_err(), ErrorCode::Forbidden);
    let r: pb::FileTagsResponse = call(&ctx, "alice@local", "music.file.tags", edit(&["album", "year"], new_album)).await.unwrap();
    assert_eq!((r.changed, r.failed), (1, 0));
    let info: pb::FileInfoResponse = call(&ctx, "alice@local", "music.file.info", pb::FileInfoRequest { track_id: job.track_id.clone() }).await.unwrap();
    let tags = info.tags.unwrap();
    assert_eq!((tags.album.as_str(), tags.year), ("Новый альбом", 2023), "меняются только тронутые поля");
    assert_eq!((info.source.as_str(), info.adder.as_str(), info.edited_by.as_str(), info.can_edit, info.has_original_tags), ("youtube", "alice", "alice", true, true));
    assert_eq!((info.codec.as_str(), info.bitrate_kbps, info.bits), ("flac", 900, 16));
    let other: pb::FileInfoResponse = call(&ctx, "bob@local", "music.file.info", pb::FileInfoRequest { track_id: job.track_id.clone() }).await.unwrap();
    assert!(!other.can_edit, "чужое — только смотреть");
    // Администратор правит чужое; «Вернуть исходные теги»
    call::<pb::FileTagsResponse>(&ctx, "admin@local", "music.file.tags", edit(&["genre"], pb::TagSet { genre: "Пост-рок".into(), ..Default::default() })).await.unwrap();
    call::<pb::FileRestoreTagsResponse>(&ctx, "alice@local", "music.file.restore_tags", pb::FileRestoreTagsRequest { track_id: job.track_id.clone() }).await.unwrap();
    let back: pb::FileInfoResponse = call(&ctx, "alice@local", "music.file.info", pb::FileInfoRequest { track_id: job.track_id.clone() }).await.unwrap();
    let tags = back.tags.unwrap();
    assert_eq!((tags.album.as_str(), tags.genre.as_str(), back.has_original_tags), ("", "", false));
    let _ = (json!({}), std::fs::remove_dir_all(dir));
}

#[tokio::test]
async fn link_of_track_on_server_asks_and_second_version_is_marked() {
    let (_fake, ctx, dir) = setup_fetch(30, u64::MAX).await;
    crate::library::open_plays(dir.join("music.db").to_str().unwrap()).await;
    let link = |as_version: bool| pb::FetchStartRequest { url: "https://soundcloud.com/gruppa/t2".into(), as_version, star: true, ..Default::default() };
    // Трек уже на сервере: задача готова с ним, скачивания нет
    let job: pb::FetchStartResponse = call(&ctx, "alice@local", "music.fetch.start", link(false)).await.unwrap();
    let done = settled(&ctx, "alice@local", &job.job.unwrap().job_id).await;
    assert!(done.existing && done.state == pb::FetchState::Done as i32 && done.track_id == "t2", "{done:?}");
    // «Добавить вторую версию»: качается по ссылке и помечается «[v2]»
    let job: pb::FetchStartResponse = call(&ctx, "alice@local", "music.fetch.start", link(true)).await.unwrap();
    let v2 = settled(&ctx, "alice@local", &job.job.unwrap().job_id).await;
    assert!(!v2.existing && v2.state == pb::FetchState::Done as i32, "{v2:?}");
    let rows = crate::fetch::store::list(&ctx.fetch.as_ref().unwrap().pool, Some("alice@local"), 0, 10).await.unwrap();
    assert_eq!(rows.len(), 1);
    let (source, version): (String, i64) = sqlx::query_as("SELECT source, version FROM added_tracks").fetch_one(&ctx.fetch.as_ref().unwrap().pool).await.unwrap();
    assert_eq!((source.as_str(), version), ("soundcloud", 1), "первая учтённая версия этого трека на сервере");
    let _ = std::fs::remove_dir_all(dir);
}

#[tokio::test]
async fn admin_sets_limits_sources_and_personal_limits() {
    let (fake, ctx, dir) = setup_fetch(30, u64::MAX).await;
    crate::library::open_plays(dir.join("music.db").to_str().unwrap()).await;
    let get = |user: &'static str| call::<pb::AdminGetResponse>(&ctx, user, "music.admin.get", pb::AdminGetRequest {});
    let alice = get("alice@local").await.unwrap();
    assert!(!alice.admin && alice.library_dir.is_empty(), "путь библиотеки — только администратору");
    assert_eq!(alice.settings.unwrap().per_day, 30);
    let set = |fields: &[&str], s: pb::AdminSettings| pb::AdminSetRequest { settings: Some(s), fields: fields.iter().map(|f| f.to_string()).collect() };
    assert_eq!(call::<pb::AdminSetResponse>(&ctx, "alice@local", "music.admin.set", set(&["per_day"], pb::AdminSettings { per_day: 5, ..Default::default() })).await.unwrap_err(), ErrorCode::Forbidden);
    // Общий лимит 5, ссылки выключены — только тронутые поля
    let r: pb::AdminSetResponse = call(&ctx, "admin@local", "music.admin.set", set(&["per_day", "links"], pb::AdminSettings { per_day: 5, links: false, ..Default::default() })).await.unwrap();
    let s = r.settings.unwrap();
    assert_eq!((s.per_day, s.links, s.uploads), (5, false, true));
    let info: pb::InfoResponse = call(&ctx, "alice@local", "music.info", pb::InfoRequest {}).await.unwrap();
    assert_eq!(info.add_per_day, 5);
    let link = pb::FetchStartRequest { url: "https://soundcloud.com/gruppa/t2".into(), ..Default::default() };
    assert_eq!(call::<pb::FetchStartResponse>(&ctx, "alice@local", "music.fetch.start", link).await.unwrap_err(), ErrorCode::Forbidden, "ссылки выключены");
    // Свой лимит перекрывает общий; «без каталога» — только слушать
    let person = |per_day: u32, reset: bool, no_catalog: bool| pb::AdminPersonSetRequest { address: "alice@local".into(), per_day, reset, no_catalog };
    let p: pb::AdminPersonSetResponse = call(&ctx, "admin@local", "music.admin.person_set", person(50, false, false)).await.unwrap();
    let p = p.person.unwrap();
    assert_eq!((p.nick.as_str(), p.per_day, p.own_limit), ("alice", 50, true));
    let _: pb::AdminPersonSetResponse = call(&ctx, "admin@local", "music.admin.person_set", person(0, true, true)).await.unwrap();
    fake.candidates.lock().unwrap().insert("youtube".into(), vec![found("a", "Группа - Песня t1", 215)]);
    assert_eq!(start(&ctx, "alice@local", "Песня t1").await.unwrap_err(), ErrorCode::Limit, "без каталога — не скачивает");
    let people: pb::AdminPeopleResponse = call(&ctx, "admin@local", "music.admin.people", pb::AdminPeopleRequest {}).await.unwrap();
    let alice = people.people.iter().find(|p| p.nick == "alice").unwrap();
    assert!(alice.no_catalog && alice.per_day == 0);
    assert!(people.people[0].admin, "администраторы первыми");
    assert_eq!(call::<pb::AdminPeopleResponse>(&ctx, "alice@local", "music.admin.people", pb::AdminPeopleRequest {}).await.unwrap_err(), ErrorCode::Forbidden);
    let _ = std::fs::remove_dir_all(dir);
}
