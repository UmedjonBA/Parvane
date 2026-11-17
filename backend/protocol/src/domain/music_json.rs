//! JSON плейлистов «Музыки» для хостов (spec 039, этап C; правило MUSIC-2): показ и правки считает движок,
//! клиенты только рисуют.
//!
//! Состояние: `{headSeq, sizeBytes, playlists:[{id, name, createdMs, count, durationSecs, items:[{id, trackId,
//! server, title, artist, durationSecs}]}]}` — только живое, плейлисты по времени создания, треки в порядке
//! показа. Изменения: `{"changes":[{"playlist":{id, name, createdMs}}, {"playlist":{id, "deleted":true}},
//! {"item":{id, playlistId, trackId, server, rank, title, artist, durationSecs, addedMs}},
//! {"item":{id, "deleted":true}}]}` — метки ставит движок.
//!
//! Действие пользователя → изменения (`compose`): `{action:"create", name}` (ответ несёт `id` нового плейлиста),
//! `{action:"rename", playlistId, name}`, `{action:"delete", playlistId}`, `{action:"add", playlistId,
//! tracks:[{id, server, title, artist, durationSecs}]}` (трек, уже стоящий в плейлисте, пропускается —
//! `skipped`), `{action:"remove", itemId}`, `{action:"move", itemId, toIndex}`.

use serde_json::{json, Map, Value};

use super::music::{self, MusicState};
use crate::error::{ProtoError, Result};
use crate::pb::parvane::core::v2::LwwStamp;
use crate::pb::parvane::music::v1::{playlist_change::Change as Kind, MusicOp, Playlist, PlaylistChange, PlaylistItem};

/// Шаг `rank` между соседними треками; меньше `MIN_GAP` между соседями — плейлист перенумеровывается.
const RANK_STEP: f64 = 1024.0;
const MIN_GAP: f64 = 1e-6;
const MAX_ADD: usize = 200;

fn item_json(i: &PlaylistItem) -> Value {
    json!({"id": i.id, "trackId": i.track_id, "server": i.server, "title": i.title, "artist": i.artist, "durationSecs": i.duration_secs})
}

pub fn state_json(state: &MusicState, head_seq: u64) -> String {
    let playlists: Vec<Value> = state
        .live_playlists()
        .into_iter()
        .map(|p| {
            let items = state.items_of(&p.id);
            let total: u64 = items.iter().map(|i| u64::from(i.duration_secs)).sum();
            json!({
                "id": p.id, "name": p.name, "createdMs": p.created_ms, "count": items.len(), "durationSecs": total,
                "items": items.into_iter().map(item_json).collect::<Vec<_>>(),
            })
        })
        .collect();
    json!({"headSeq": head_seq, "sizeBytes": state.snapshot_size(), "playlists": playlists}).to_string()
}

fn id_of(o: &Map<String, Value>) -> Result<String> {
    o.get("id").and_then(Value::as_str).filter(|s| !s.is_empty()).map(str::to_string).ok_or(ProtoError::InvalidField("id"))
}

fn is_deleted(o: &Map<String, Value>) -> bool {
    o.get("deleted").and_then(Value::as_bool).unwrap_or(false)
}

fn text(o: &Map<String, Value>, key: &'static str) -> Result<String> {
    match o.get(key) {
        None | Some(Value::Null) => Ok(String::new()),
        Some(v) => v.as_str().map(str::to_string).ok_or(ProtoError::InvalidField(key)),
    }
}

fn num(o: &Map<String, Value>, key: &'static str) -> Result<f64> {
    match o.get(key) {
        None | Some(Value::Null) => Ok(0.0),
        Some(v) => v.as_f64().filter(|n| n.is_finite()).ok_or(ProtoError::InvalidField(key)),
    }
}

fn int(o: &Map<String, Value>, key: &'static str) -> Result<i64> {
    let n = num(o, key)?;
    if n.fract() != 0.0 {
        return Err(ProtoError::InvalidField(key));
    }
    Ok(n as i64)
}

fn probe() -> Option<LwwStamp> {
    Some(LwwStamp { lamport: 1, device_id: "x".into() })
}

fn playlist_of(o: &Map<String, Value>) -> Result<Playlist> {
    let id = id_of(o)?;
    if is_deleted(o) {
        return Ok(Playlist { id, deleted: Some(Default::default()), ..Default::default() });
    }
    let p = Playlist { id, name: text(o, "name")?.trim().to_string(), created_ms: int(o, "createdMs")?, ..Default::default() };
    // Локальная правка проверяется сразу: негодное не уходит в журнал
    music::check_playlist(&Playlist { stamp: probe(), ..p.clone() })?;
    Ok(p)
}

fn item_of(o: &Map<String, Value>) -> Result<PlaylistItem> {
    let id = id_of(o)?;
    if is_deleted(o) {
        return Ok(PlaylistItem { id, deleted: Some(Default::default()), ..Default::default() });
    }
    let i = PlaylistItem {
        id,
        playlist_id: text(o, "playlistId")?,
        track_id: text(o, "trackId")?,
        server: text(o, "server")?,
        rank: num(o, "rank")?,
        title: text(o, "title")?,
        artist: text(o, "artist")?,
        duration_secs: u32::try_from(int(o, "durationSecs")?).map_err(|_| ProtoError::InvalidField("durationSecs"))?,
        added_ms: int(o, "addedMs")?,
        ..Default::default()
    };
    music::check_item(&PlaylistItem { stamp: probe(), ..i.clone() })?;
    Ok(i)
}

pub fn op_from_json(text: &str) -> Result<MusicOp> {
    let v: Value = serde_json::from_str(text).map_err(|_| ProtoError::Malformed)?;
    let items = v.get("changes").and_then(Value::as_array).ok_or(ProtoError::InvalidField("changes"))?;
    if items.is_empty() || items.len() > 500 {
        return Err(ProtoError::InvalidField("changes"));
    }
    let mut changes = Vec::with_capacity(items.len());
    for item in items {
        let o = item.as_object().ok_or(ProtoError::Malformed)?;
        let (kind, body) = o.iter().next().ok_or(ProtoError::Malformed)?;
        let body = body.as_object().ok_or(ProtoError::Malformed)?;
        let c = match kind.as_str() {
            "playlist" => Kind::Playlist(playlist_of(body)?),
            "item" => Kind::Item(item_of(body)?),
            _ => return Err(ProtoError::InvalidField("changes")),
        };
        changes.push(PlaylistChange { change: Some(c) });
    }
    Ok(MusicOp { changes })
}

fn item_change(i: &PlaylistItem, rank: f64) -> Value {
    json!({"item": {
        "id": i.id, "playlistId": i.playlist_id, "trackId": i.track_id, "server": i.server, "rank": rank,
        "title": i.title, "artist": i.artist, "durationSecs": i.duration_secs, "addedMs": i.added_ms,
    }})
}

fn cut(s: &str, max: usize) -> String {
    let mut out: String = s.chars().filter(|c| !c.is_control()).collect();
    while out.len() > max {
        out.pop();
    }
    out
}

/// Действие пользователя → изменения для `prepareLocal`. `new_id` — источник id (в тестах — счётчик).
/// Действие без последствий (плейлиста нет, трек уже стоит) — пустой список изменений.
pub fn compose(state: &MusicState, action: &Value, now_ms: i64, mut new_id: impl FnMut() -> String) -> Result<Value> {
    let o = action.as_object().ok_or(ProtoError::Malformed)?;
    let playlist = |key: &'static str| -> Result<Option<&Playlist>> {
        let id = text(o, key)?;
        Ok(state.playlists.get(&id).filter(|p| MusicState::is_playlist_alive(p)))
    };
    let live_item = |id: &str| state.items.get(id).filter(|i| MusicState::is_item_alive(i));
    let name = || -> Result<String> {
        let name = cut(text(o, "name")?.trim(), music::MAX_NAME);
        if name.is_empty() { Err(ProtoError::InvalidField("name")) } else { Ok(name) }
    };
    let mut changes: Vec<Value> = Vec::new();
    let mut extra = Map::new();
    match text(o, "action")?.as_str() {
        "create" => {
            let id = new_id();
            changes.push(json!({"playlist": {"id": id, "name": name()?, "createdMs": now_ms}}));
            extra.insert("id".into(), json!(id));
        }
        "rename" => {
            if let Some(p) = playlist("playlistId")? {
                changes.push(json!({"playlist": {"id": p.id, "name": name()?, "createdMs": p.created_ms}}));
            }
        }
        // Треки удалённого плейлиста не показываются и уйдут из снимка вместе со старыми надгробиями
        "delete" => {
            if let Some(p) = playlist("playlistId")? {
                changes.push(json!({"playlist": {"id": p.id, "deleted": true}}));
            }
        }
        "add" => {
            let tracks = o.get("tracks").and_then(Value::as_array).ok_or(ProtoError::InvalidField("tracks"))?;
            if tracks.len() > MAX_ADD {
                return Err(ProtoError::InvalidField("tracks"));
            }
            if let Some(p) = playlist("playlistId")? {
                let present = state.items_of(&p.id);
                let mut rank = present.last().map_or(0.0, |i| i.rank);
                let mut seen: Vec<(String, String)> = present.iter().map(|i| (i.server.clone(), i.track_id.clone())).collect();
                let mut skipped = 0;
                for t in tracks {
                    let t = t.as_object().ok_or(ProtoError::Malformed)?;
                    let key = (text(t, "server")?, id_of(t)?);
                    if seen.contains(&key) {
                        skipped += 1;
                        continue;
                    }
                    rank += RANK_STEP;
                    changes.push(json!({"item": {
                        "id": new_id(), "playlistId": p.id, "trackId": key.1, "server": key.0, "rank": rank,
                        "title": cut(&text(t, "title")?, 600), "artist": cut(&text(t, "artist")?, 600),
                        "durationSecs": int(t, "durationSecs")?.clamp(0, 48 * 3600), "addedMs": now_ms,
                    }}));
                    seen.push(key);
                }
                extra.insert("skipped".into(), json!(skipped));
            }
        }
        "remove" => {
            if let Some(i) = live_item(&text(o, "itemId")?) {
                changes.push(json!({"item": {"id": i.id, "deleted": true}}));
            }
        }
        "move" => {
            if let Some(moved) = live_item(&text(o, "itemId")?) {
                let others: Vec<&PlaylistItem> = state.items_of(&moved.playlist_id).into_iter().filter(|i| i.id != moved.id).collect();
                let to = usize::try_from(int(o, "toIndex")?.max(0)).unwrap_or(0).min(others.len());
                let before = to.checked_sub(1).map(|n| others[n].rank);
                let after = others.get(to).map(|i| i.rank);
                let rank = match (before, after) {
                    (None, None) => RANK_STEP,
                    (Some(b), None) => b + RANK_STEP,
                    (None, Some(a)) => a - RANK_STEP,
                    (Some(b), Some(a)) => (a + b) / 2.0,
                };
                let is_tight = matches!((before, after), (Some(b), Some(a)) if a - b < MIN_GAP);
                if is_tight {
                    // Между соседями не осталось места: весь плейлист получает ровные места заново
                    let mut order = others;
                    order.insert(to, moved);
                    changes.extend(order.iter().enumerate().map(|(n, i)| item_change(i, (n as f64 + 1.0) * RANK_STEP)));
                } else if state.items_of(&moved.playlist_id).iter().position(|i| i.id == moved.id) != Some(to) {
                    changes.push(item_change(moved, rank));
                }
            }
        }
        _ => return Err(ProtoError::InvalidField("action")),
    }
    extra.insert("changes".into(), Value::Array(changes));
    Ok(Value::Object(extra))
}

/// Случайный id записи.
pub fn new_id() -> String {
    let mut id = [0u8; 12];
    rand::RngCore::fill_bytes(&mut rand::rngs::OsRng, &mut id);
    hex::encode(id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::Stamp;

    struct Sim {
        st: MusicState,
        lamport: u64,
        next: u32,
    }

    impl Sim {
        fn new() -> Self {
            Sim { st: MusicState::default(), lamport: 0, next: 0 }
        }

        /// Действие пользователя на устройстве `dev`: изменения движка применяются к состоянию.
        fn act(&mut self, dev: &str, action: Value) -> Value {
            let next = &mut self.next;
            let out = compose(&self.st, &action, 1_794_000_000_000, || {
                *next += 1;
                format!("id{next}")
            })
            .unwrap();
            if !out["changes"].as_array().unwrap().is_empty() {
                let mut op = op_from_json(&json!({"changes": out["changes"]}).to_string()).unwrap();
                self.lamport += 1;
                music::stamp_op(&mut op, &Stamp::new(self.lamport, dev));
                self.st.apply_op(&op, dev).unwrap();
            }
            out
        }

        fn view(&self) -> Value {
            serde_json::from_str(&state_json(&self.st, 0)).unwrap()
        }

        fn order(&self, playlist: usize) -> Vec<String> {
            self.view()["playlists"][playlist]["items"].as_array().unwrap().iter().map(|i| i["trackId"].as_str().unwrap().to_string()).collect()
        }
    }

    fn track(id: &str, secs: u32) -> Value {
        json!({"id": id, "title": format!("Трек {id}"), "artist": "Группа", "durationSecs": secs})
    }

    #[test]
    fn playlists_keep_order_and_skip_duplicates() {
        let mut s = Sim::new();
        let id = s.act("d1", json!({"action": "create", "name": "  Дорога  "}))["id"].as_str().unwrap().to_string();
        let added = s.act("d1", json!({"action": "add", "playlistId": id, "tracks": [track("a", 100), track("b", 200), track("c", 50)]}));
        assert_eq!(added["changes"].as_array().unwrap().len(), 3);
        let again = s.act("d1", json!({"action": "add", "playlistId": id, "tracks": [track("b", 200), track("d", 10)]}));
        assert_eq!((again["skipped"].as_i64(), again["changes"].as_array().unwrap().len()), (Some(1), 1));
        let v = s.view();
        assert_eq!((v["playlists"][0]["name"].as_str(), v["playlists"][0]["count"].as_i64(), v["playlists"][0]["durationSecs"].as_i64()), (Some("Дорога"), Some(4), Some(360)));
        assert_eq!(s.order(0), ["a", "b", "c", "d"]);
        // Перестановки: в начало, в конец, в середину, на своё место (без изменений)
        let item = |s: &Sim, track: &str| s.view()["playlists"][0]["items"].as_array().unwrap().iter().find(|i| i["trackId"] == track).unwrap()["id"].as_str().unwrap().to_string();
        let d = item(&s, "d");
        s.act("d1", json!({"action": "move", "itemId": d, "toIndex": 0}));
        assert_eq!(s.order(0), ["d", "a", "b", "c"]);
        s.act("d1", json!({"action": "move", "itemId": d, "toIndex": 99}));
        assert_eq!(s.order(0), ["a", "b", "c", "d"]);
        let a = item(&s, "a");
        s.act("d1", json!({"action": "move", "itemId": a, "toIndex": 2}));
        assert_eq!(s.order(0), ["b", "c", "a", "d"]);
        assert!(s.act("d1", json!({"action": "move", "itemId": a, "toIndex": 2}))["changes"].as_array().unwrap().is_empty());
        // Много перестановок в одно место: места кончаются — плейлист перенумеровывается, порядок цел
        for _ in 0..80 {
            let first = item(&s, &s.order(0)[0]);
            s.act("d1", json!({"action": "move", "itemId": first, "toIndex": 1}));
        }
        let mut sorted = s.order(0);
        sorted.sort();
        assert_eq!(sorted, ["a", "b", "c", "d"], "ни один трек не потерян и не задвоен");
        // Удаление трека, переименование, удаление плейлиста
        s.act("d1", json!({"action": "remove", "itemId": item(&s, "c")}));
        s.act("d1", json!({"action": "rename", "playlistId": id, "name": "В дорогу"}));
        let v = s.view();
        assert_eq!((v["playlists"][0]["name"].as_str(), v["playlists"][0]["count"].as_i64()), (Some("В дорогу"), Some(3)));
        s.act("d1", json!({"action": "delete", "playlistId": id}));
        assert!(s.view()["playlists"].as_array().unwrap().is_empty());
        assert!(s.act("d1", json!({"action": "add", "playlistId": id, "tracks": [track("z", 1)]}))["changes"].as_array().unwrap().is_empty(), "в удалённый плейлист не добавляется");
    }

    #[test]
    fn two_devices_adding_at_once_lose_nothing_in_any_order() {
        let mut base = Sim::new();
        let id = base.act("d1", json!({"action": "create", "name": "Общий"}))["id"].as_str().unwrap().to_string();
        let op = |dev: &str, lamport: u64, changes: Value| {
            let mut op = op_from_json(&json!({"changes": changes}).to_string()).unwrap();
            music::stamp_op(&mut op, &Stamp::new(lamport, dev));
            (op, dev.to_string())
        };
        let add = |item: &str, track: &str| json!([{"item": {"id": item, "playlistId": id, "trackId": track, "rank": 1024.0, "title": track}}]);
        let ops = [op("d1", 5, add("i1", "a")), op("d2", 5, add("i2", "b")), op("d2", 6, json!([{"item": {"id": "i1", "deleted": true}}])), op("d1", 7, add("i3", "c"))];
        let apply = |order: &[usize]| {
            let mut st = base.st.clone();
            for &n in order {
                st.apply_op(&ops[n].0, &ops[n].1).unwrap();
            }
            st
        };
        let straight = apply(&[0, 1, 2, 3]);
        for order in [[3, 2, 1, 0], [2, 0, 3, 1], [1, 3, 0, 2]] {
            assert_eq!(apply(&order), straight, "{order:?}");
        }
        let v: Value = serde_json::from_str(&state_json(&straight, 0)).unwrap();
        let tracks: Vec<&str> = v["playlists"][0]["items"].as_array().unwrap().iter().map(|i| i["trackId"].as_str().unwrap()).collect();
        assert_eq!(tracks, ["b", "c"], "одинаковое место — порядок по id записи; удалённое не вернулось");
        // Снимок и обратно
        let mut restored = MusicState::default();
        restored.merge_snapshot(&straight.to_snapshot()).unwrap();
        assert_eq!(restored, straight);
    }

    #[test]
    fn bad_changes_and_actions_are_refused() {
        for bad in [
            r#"{"changes":[]}"#,
            r#"{"changes":[{"playlist":{"id":"p","name":"  "}}]}"#,
            r#"{"changes":[{"playlist":{"id":"p p","name":"x"}}]}"#,
            r#"{"changes":[{"item":{"id":"i","playlistId":"p","trackId":""}}]}"#,
            r#"{"changes":[{"item":{"id":"i","playlistId":"p","trackId":"t","server":"a b"}}]}"#,
            r#"{"changes":[{"track":{"id":"i"}}]}"#,
        ] {
            assert!(op_from_json(bad).is_err(), "{bad}");
        }
        let st = MusicState::default();
        assert!(compose(&st, &json!({"action": "create", "name": " "}), 0, new_id).is_err());
        assert!(compose(&st, &json!({"action": "dance"}), 0, new_id).is_err());
        assert!(compose(&st, &json!({"action": "remove", "itemId": "нет"}), 0, new_id).unwrap()["changes"].as_array().unwrap().is_empty());
        // Чужая метка в операции — отказ всей операции
        let mut op = op_from_json(r#"{"changes":[{"playlist":{"id":"p","name":"x"}}]}"#).unwrap();
        music::stamp_op(&mut op, &Stamp::new(1, "d1"));
        assert!(MusicState::default().apply_op(&op, "d2").is_err());
    }
}
