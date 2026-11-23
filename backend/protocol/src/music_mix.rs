//! «Микс дня» «Музыки»: отбор и порядок треков ежедневной подборки. Единственная реализация — шард `music`
//! собирает кандидатов (библиотека сервера, каталог) и вызывает [`build`]; клиенты показывают готовый микс.
//!
//! Кандидаты — треки библиотеки (с отметкой «любимое», числом своих прослушиваний, днём последнего) и треки каталога
//! похожих исполнителей. Режим задаёт доли: обычный — больше знакомого, «Любимое» — почти только своё, «Новое» —
//! больше каталога. Вчерашние и позавчерашние треки микса не повторяются; не больше [`PER_ARTIST`] треков одного
//! исполнителя; подряд один исполнитель не идёт. Перемешивание детерминировано `seed` (человек и день): тот же микс
//! при повторной сборке в тот же день.

use std::collections::{BTreeMap, BTreeSet};

/// Треков в миксе.
pub const MIX_SIZE: usize = 25;
/// Треков одного исполнителя в миксе — не больше.
pub const PER_ARTIST: usize = 3;
/// Дней без прослушивания, после которых знакомый трек «соскучился» и поднимается выше.
const FORGOTTEN_DAYS: i64 = 14;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Mode {
    #[default]
    Normal,
    /// Почти только своё: любимое и часто слушаемое.
    Favorites,
    /// Больше нового из каталога.
    Discover,
}

impl Mode {
    pub fn parse(s: &str) -> Self {
        match s {
            "favorites" => Self::Favorites,
            "discover" => Self::Discover,
            _ => Self::Normal,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Normal => "normal",
            Self::Favorites => "favorites",
            Self::Discover => "discover",
        }
    }

    /// Сколько из [`MIX_SIZE`] — треки каталога (остальное — библиотека; нехватку одной стороны добирает другая).
    fn catalog_share(self) -> usize {
        match self {
            Self::Normal => 10,
            Self::Favorites => 3,
            Self::Discover => 18,
        }
    }
}

/// Трек библиотеки сервера.
#[derive(Clone, Debug, Default)]
pub struct LibraryCandidate {
    pub id: String,
    pub artist: String,
    pub title: String,
    pub starred: bool,
    /// Сколько дней этот человек его слушал.
    pub plays: u32,
    /// День последнего прослушивания (дни от эпохи); `None` — не слушал.
    pub last_day: Option<i64>,
    /// Исполнитель — из выбранных любимых.
    pub seed_artist: bool,
}

/// Трек каталога (ещё не на сервере).
#[derive(Clone, Debug, Default)]
pub struct CatalogCandidate {
    /// `dz:<id>`.
    pub reference: String,
    pub artist: String,
    pub title: String,
    /// Исполнитель, похожий на которого дал этот трек (для подписи «похоже на …»).
    pub because_of: String,
}

/// Строка микса: трек и почему он здесь.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Pick {
    Library { id: String, reason: Reason },
    Catalog { reference: String, because_of: String },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Reason {
    Starred,
    Frequent,
    Forgotten,
    SeedArtist,
    Library,
}

impl Reason {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Starred => "starred",
            Self::Frequent => "frequent",
            Self::Forgotten => "forgotten",
            Self::SeedArtist => "seed_artist",
            Self::Library => "library",
        }
    }
}

/// Вход сборки.
#[derive(Clone, Debug, Default)]
pub struct Input {
    pub mode: Mode,
    pub today: i64,
    pub seed: u64,
    pub library: Vec<LibraryCandidate>,
    pub catalog: Vec<CatalogCandidate>,
    /// Треки прошлых миксов (id библиотеки и `dz:` каталога) — не повторять.
    pub recent: BTreeSet<String>,
    /// «Не нравится»: треки (id и `dz:`) и исполнители (нормализованные имена, см. [`norm`]).
    pub disliked_tracks: BTreeSet<String>,
    pub disliked_artists: BTreeSet<String>,
}

/// Микс: до [`MIX_SIZE`] строк.
pub fn build(input: &Input) -> Vec<Pick> {
    let mut rng = Rng(input.seed | 1);
    let blocked = |artist: &str| input.disliked_artists.contains(&norm(artist));
    let owned: BTreeSet<String> = input.library.iter().map(|t| key(&t.artist, &t.title)).collect();

    let mut library: Vec<(f64, &LibraryCandidate, Reason)> = input
        .library
        .iter()
        .filter(|t| !input.recent.contains(&t.id) && !input.disliked_tracks.contains(&t.id) && !blocked(&t.artist))
        .map(|t| {
            let (score, reason) = library_score(t, input.today, input.mode);
            (score + rng.unit() * 0.75, t, reason)
        })
        .collect();
    library.sort_by(|a, b| b.0.total_cmp(&a.0));

    let mut catalog: Vec<(f64, &CatalogCandidate)> = input
        .catalog
        .iter()
        .filter(|t| {
            !input.recent.contains(&t.reference)
                && !input.disliked_tracks.contains(&t.reference)
                && !blocked(&t.artist)
                && !owned.contains(&key(&t.artist, &t.title))
        })
        .map(|t| (rng.unit(), t))
        .collect();
    catalog.sort_by(|a, b| b.0.total_cmp(&a.0));

    let mut per_artist: BTreeMap<String, usize> = BTreeMap::new();
    let mut seen: BTreeSet<String> = BTreeSet::new();
    let mut take = |artist: &str, track_key: String| {
        let count = per_artist.entry(norm(artist)).or_default();
        if *count >= PER_ARTIST || !seen.insert(track_key) {
            return false;
        }
        *count += 1;
        true
    };
    let want_catalog = input.mode.catalog_share().min(MIX_SIZE);
    let mut from_catalog: Vec<(String, Pick)> = Vec::new();
    for (_, t) in &catalog {
        if from_catalog.len() >= want_catalog {
            break;
        }
        if take(&t.artist, key(&t.artist, &t.title)) {
            from_catalog.push((t.artist.clone(), Pick::Catalog { reference: t.reference.clone(), because_of: t.because_of.clone() }));
        }
    }
    let mut from_library: Vec<(String, Pick)> = Vec::new();
    for (_, t, reason) in &library {
        if from_library.len() + from_catalog.len() >= MIX_SIZE {
            break;
        }
        if take(&t.artist, key(&t.artist, &t.title)) {
            from_library.push((t.artist.clone(), Pick::Library { id: t.id.clone(), reason: *reason }));
        }
    }
    // Библиотеки не хватило — добрать каталогом
    for (_, t) in &catalog {
        if from_library.len() + from_catalog.len() >= MIX_SIZE {
            break;
        }
        if take(&t.artist, key(&t.artist, &t.title)) {
            from_catalog.push((t.artist.clone(), Pick::Catalog { reference: t.reference.clone(), because_of: t.because_of.clone() }));
        }
    }
    interleave(from_library, from_catalog)
}

/// Знакомое выше: любимое, часто слушаемое, давно не слушанное, исполнители из выбранных.
fn library_score(t: &LibraryCandidate, today: i64, mode: Mode) -> (f64, Reason) {
    let forgotten = t.plays > 0 && t.last_day.is_some_and(|d| today - d >= FORGOTTEN_DAYS);
    let mut score = f64::from(t.plays.min(30)).ln_1p();
    let mut reason = Reason::Library;
    if t.seed_artist {
        score += 1.5;
        reason = Reason::SeedArtist;
    }
    if t.plays >= 3 {
        reason = Reason::Frequent;
    }
    if forgotten {
        score += 1.0;
        reason = Reason::Forgotten;
    }
    if t.starred {
        score += if mode == Mode::Favorites { 3.0 } else { 2.0 };
        reason = Reason::Starred;
    }
    // Слушал вчера-сегодня — пусть отдохнёт
    if t.last_day.is_some_and(|d| today - d <= 1) {
        score -= 2.0;
    }
    (score, reason)
}

/// Библиотека и каталог вперемешку (доля каталога — равномерно), один исполнитель подряд не идёт, если можно иначе.
fn interleave(library: Vec<(String, Pick)>, catalog: Vec<(String, Pick)>) -> Vec<Pick> {
    let total = library.len() + catalog.len();
    let mut pending: Vec<(String, Pick)> = Vec::with_capacity(total);
    let (mut li, mut ci) = (library.into_iter(), catalog.into_iter());
    let catalog_left = |placed_catalog: usize, placed: usize, catalog_total: usize| {
        // Каталог ставится, когда его доля в уже поставленном отстаёт от общей
        placed_catalog * total < catalog_total * (placed + 1)
    };
    let catalog_total = ci.len();
    let mut placed_catalog = 0;
    for placed in 0..total {
        let next = if catalog_left(placed_catalog, placed, catalog_total) { ci.next().or_else(|| li.next()) } else { li.next().or_else(|| ci.next()) };
        if let Some(item) = next {
            if matches!(item.1, Pick::Catalog { .. }) {
                placed_catalog += 1;
            }
            pending.push(item);
        }
    }
    // Один исполнитель подряд — переставить с ближайшим следующим другим
    for i in 1..pending.len() {
        if norm(&pending[i].0) == norm(&pending[i - 1].0) {
            if let Some(j) = (i + 1..pending.len()).find(|&j| norm(&pending[j].0) != norm(&pending[i - 1].0)) {
                pending.swap(i, j);
            }
        }
    }
    pending.into_iter().map(|(_, pick)| pick).collect()
}

/// Имя исполнителя для сравнения: регистр, «ё», пробелы и знаки не важны.
pub fn norm(s: &str) -> String {
    s.to_lowercase().replace('ё', "е").chars().filter(|c| c.is_alphanumeric()).collect()
}

fn key(artist: &str, title: &str) -> String {
    format!("{}|{}", norm(artist), norm(title))
}

/// Детерминированный генератор (xorshift64*).
struct Rng(u64);

impl Rng {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 >> 12;
        self.0 ^= self.0 << 25;
        self.0 ^= self.0 >> 27;
        self.0.wrapping_mul(0x2545_F491_4F6C_DD1D)
    }

    fn unit(&mut self) -> f64 {
        (self.next() >> 11) as f64 / (1u64 << 53) as f64
    }
}

/// Зерно микса: человек и день — та же сборка в тот же день даёт тот же микс, «Другой микс» меняет `salt`.
pub fn seed(user: &str, day: i64, salt: u64) -> u64 {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for b in user.bytes().chain(day.to_le_bytes()).chain(salt.to_le_bytes()) {
        h ^= u64::from(b);
        h = h.wrapping_mul(0x0100_0000_01b3);
    }
    h
}

#[cfg(test)]
mod tests {
    use super::*;

    fn lib(id: &str, artist: &str, plays: u32, starred: bool) -> LibraryCandidate {
        LibraryCandidate { id: id.into(), artist: artist.into(), title: format!("Песня {id}"), plays, starred, last_day: Some(100), ..Default::default() }
    }

    fn cat(r: &str, artist: &str) -> CatalogCandidate {
        CatalogCandidate { reference: format!("dz:{r}"), artist: artist.into(), title: format!("Трек {r}"), because_of: "Группа".into() }
    }

    fn input(mode: Mode) -> Input {
        let library = (0..40).map(|i| lib(&format!("l{i}"), &format!("Исп {}", i % 10), i % 7, i % 9 == 0)).collect();
        let catalog = (0..40).map(|i| cat(&format!("c{i}"), &format!("Кат {}", i % 12))).collect();
        Input { mode, today: 200, seed: seed("alice@local", 200, 0), library, catalog, ..Default::default() }
    }

    fn count_catalog(mix: &[Pick]) -> usize {
        mix.iter().filter(|p| matches!(p, Pick::Catalog { .. })).count()
    }

    #[test]
    fn mode_sets_the_share_of_new_tracks() {
        assert_eq!(build(&input(Mode::Normal)).len(), MIX_SIZE);
        assert_eq!(count_catalog(&build(&input(Mode::Normal))), 10);
        assert_eq!(count_catalog(&build(&input(Mode::Favorites))), 3);
        assert_eq!(count_catalog(&build(&input(Mode::Discover))), 18);
    }

    #[test]
    fn same_day_same_mix_other_salt_other_mix() {
        let a = build(&input(Mode::Normal));
        assert_eq!(a, build(&input(Mode::Normal)));
        let mut other = input(Mode::Normal);
        other.seed = seed("alice@local", 200, 1);
        assert_ne!(a, build(&other));
    }

    #[test]
    fn no_repeats_dislikes_or_owned_catalog_and_artists_spread() {
        let mut i = input(Mode::Normal);
        i.recent.insert("l0".into());
        i.disliked_tracks.insert("dz:c1".into());
        i.disliked_artists.insert(norm("Исп 2"));
        // Трек каталога, который уже есть на сервере, не предлагается
        i.catalog.push(CatalogCandidate { reference: "dz:dup".into(), artist: "Исп 3".into(), title: "Песня l3".into(), because_of: String::new() });
        let mix = build(&i);
        let ids: Vec<String> = mix.iter().map(|p| match p { Pick::Library { id, .. } => id.clone(), Pick::Catalog { reference, .. } => reference.clone() }).collect();
        assert!(!ids.contains(&"l0".to_string()) && !ids.contains(&"dz:c1".to_string()) && !ids.contains(&"dz:dup".to_string()));
        assert!(!ids.iter().any(|id| id == "l2" || id == "l12" || id == "l22"), "исполнитель «не нравится»");
        let artist_of = |id: &str| -> String {
            i.library.iter().find(|t| t.id == id).map(|t| t.artist.clone())
                .or_else(|| i.catalog.iter().find(|t| t.reference == id).map(|t| t.artist.clone())).unwrap()
        };
        let artists: Vec<String> = ids.iter().map(|id| artist_of(id)).collect();
        for w in artists.windows(2) {
            assert_ne!(w[0], w[1], "один исполнитель подряд");
        }
        let mut per = BTreeMap::new();
        for a in &artists {
            *per.entry(a.clone()).or_insert(0) += 1;
        }
        assert!(per.values().all(|&n| n <= PER_ARTIST));
    }

    #[test]
    fn starred_and_seed_artists_come_first_in_favorites() {
        let mut i = input(Mode::Favorites);
        i.library = vec![lib("fav", "Любимый", 0, true), lib("seedy", "Выбранный", 0, false), lib("x", "Прочий", 0, false)];
        i.library[1].seed_artist = true;
        let mix = build(&i);
        let pos = |id: &str| mix.iter().position(|p| matches!(p, Pick::Library { id: x, .. } if x == id));
        assert!(pos("fav").is_some() && pos("seedy").is_some());
        assert!(matches!(mix.iter().find(|p| matches!(p, Pick::Library { id, .. } if id == "fav")), Some(Pick::Library { reason: Reason::Starred, .. })));
    }

    #[test]
    fn short_library_is_filled_from_catalog() {
        let mut i = input(Mode::Normal);
        i.library.truncate(4);
        let mix = build(&i);
        assert_eq!(mix.len(), MIX_SIZE);
        assert_eq!(count_catalog(&mix), MIX_SIZE - 4);
    }
}
