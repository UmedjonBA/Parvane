//! «Микс дня» «Музыки»: отбор и порядок треков ежедневной подборки. Единственная реализация — шард `music`
//! собирает кандидатов (библиотека сервера, каталог) и вызывает [`build`]; клиенты показывают готовый микс.
//!
//! Кандидаты — треки библиотеки (с отметкой «любимое», числом своих прослушиваний, днём последнего) и треки каталога
//! из трёх источников: радио исполнителей профиля, похожие исполнители, соседний жанр. Вкус человека — [`taste`]:
//! вес каждого исполнителя по выбранным, ♡, прослушиваниям, дослушанному, скачанному, пропущенному и «не нравится»;
//! исполнитель с «не нравится» целиком либо на двух его треках в микс не попадает. Режим задаёт доли: обычный —
//! больше знакомого, «Любимое» — почти только своё, «Новое» — больше каталога; часть каталога — из соседнего жанра.
//! Сегодняшний микс «Другой микс» не повторяет никогда, треки прошлых дней — только если иначе микс короче
//! [`MIX_SIZE`]; не больше [`PER_ARTIST`] треков одного исполнителя (из каталога — [`PER_ARTIST_CATALOG`]); подряд
//! один исполнитель не идёт. Перемешивание детерминировано `seed`: тот же микс при повторной сборке в тот же день.

use std::collections::{BTreeMap, BTreeSet};

/// Треков в миксе.
pub const MIX_SIZE: usize = 25;
/// Треков одного исполнителя в миксе — не больше.
pub const PER_ARTIST: usize = 3;
/// Новых (из каталога) треков одного исполнителя — не больше: подборка должна открывать разных.
pub const PER_ARTIST_CATALOG: usize = 2;
/// Сколько «не нравится» на треках одного исполнителя убирают его из микса целиком.
pub const DISLIKES_TO_BLOCK: usize = 2;
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

    /// Сколько каталога — из соседнего жанра (разнообразие): пятая часть микса, в «Новом» — треть.
    fn genre_share(self) -> usize {
        match self {
            Self::Normal => 5,
            Self::Favorites => 0,
            Self::Discover => 8,
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
    /// Откуда трек: радио исполнителя, похожий исполнитель, соседний жанр.
    pub source: Source,
    /// Для подписи: исполнитель радио либо похожий («похоже на …»), название жанра.
    pub because_of: String,
}

/// Источник трека каталога.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Source {
    /// Похож на исполнителя профиля.
    #[default]
    Related,
    /// Радио исполнителя профиля (подборка каталога по нему).
    Radio,
    /// Популярное в соседнем жанре — разнообразие.
    Genre,
}

impl Source {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Related => "catalog",
            Self::Radio => "radio",
            Self::Genre => "genre",
        }
    }

    /// Насколько источник близок ко вкусу: радио — ближе всего, соседний жанр — дальше всего.
    fn base(self) -> f64 {
        match self {
            Self::Radio => 1.0,
            Self::Related => 0.8,
            Self::Genre => 0.3,
        }
    }
}

/// Строка микса: трек и почему он здесь.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Pick {
    Library { id: String, reason: Reason },
    Catalog { reference: String, because_of: String, source: Source },
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
    /// Треки миксов прошлых дней (id библиотеки и `dz:` каталога) — не повторять, если без них хватает на микс.
    pub recent: BTreeSet<String>,
    /// Треки сегодняшнего микса — «Другой микс» их не повторяет никогда.
    pub current: BTreeSet<String>,
    /// Вкус: вес исполнителя (нормализованное имя), см. [`taste`].
    pub weights: BTreeMap<String, f64>,
    /// «Не нравится»: треки (id и `dz:`) и исполнители (нормализованные имена, см. [`norm`]).
    pub disliked_tracks: BTreeSet<String>,
    pub disliked_artists: BTreeSet<String>,
}

/// Микс: до [`MIX_SIZE`] строк.
pub fn build(input: &Input) -> Vec<Pick> {
    let mut rng = Rng(input.seed | 1);
    let blocked = |artist: &str| input.disliked_artists.contains(&norm(artist));
    let weight = |artist: &str| input.weights.get(&norm(artist)).copied().unwrap_or(0.0);
    let owned: BTreeSet<String> = input.library.iter().map(|t| key(&t.artist, &t.title)).collect();

    let mut library: Vec<(f64, &LibraryCandidate, Reason)> = input
        .library
        .iter()
        // Любимое и так в «Любимом»: подборка его не повторяет — кроме режима «Любимое», где его просят явно
        .filter(|t| !(t.starred && input.mode != Mode::Favorites))
        .filter(|t| !input.current.contains(&t.id) && !input.disliked_tracks.contains(&t.id) && !blocked(&t.artist))
        .map(|t| {
            let (score, reason) = library_score(t, input.today, input.mode);
            (score + weight(&t.artist) * 0.2 + rng.unit() * 0.75, t, reason)
        })
        .collect();
    library.sort_by(|a, b| b.0.total_cmp(&a.0));

    let mut catalog: Vec<(f64, &CatalogCandidate)> = input
        .catalog
        .iter()
        .filter(|t| {
            !input.current.contains(&t.reference)
                && !input.disliked_tracks.contains(&t.reference)
                && !blocked(&t.artist)
                && !owned.contains(&key(&t.artist, &t.title))
        })
        // Ближе ко вкусу — выше: источник, вес исполнителя (отрицательный — «не нравится» на его треке), случай
        .map(|t| (t.source.base() + weight(&t.artist).clamp(-4.0, 6.0) * 0.35 + rng.unit() * 1.2, t))
        .collect();
    catalog.sort_by(|a, b| b.0.total_cmp(&a.0));

    let mut per_artist: BTreeMap<String, usize> = BTreeMap::new();
    let mut seen: BTreeSet<String> = BTreeSet::new();
    let mut take = |artist: &str, track_key: String, limit: usize| {
        let count = per_artist.entry(norm(artist)).or_default();
        if *count >= limit || seen.contains(&track_key) {
            return false;
        }
        seen.insert(track_key);
        *count += 1;
        true
    };
    let catalog_pick = |t: &CatalogCandidate| Pick::Catalog { reference: t.reference.clone(), because_of: t.because_of.clone(), source: t.source };
    let want_catalog = input.mode.catalog_share().min(MIX_SIZE);
    let want_genre = input.mode.genre_share().min(want_catalog);
    let mut from_catalog: Vec<(String, Pick)> = Vec::new();
    let mut from_library: Vec<(String, Pick)> = Vec::new();
    // Прошлые дни — только во втором проходе, когда без них микс короче
    for allow_recent in [false, true] {
        let fresh = |id: &str| allow_recent || !input.recent.contains(id);
        // Разнообразие: доля соседнего жанра, потом остальной каталог по близости ко вкусу
        for (_, t) in catalog.iter().filter(|(_, t)| t.source == Source::Genre) {
            if from_catalog.iter().filter(|(_, p)| matches!(p, Pick::Catalog { source: Source::Genre, .. })).count() >= want_genre {
                break;
            }
            if fresh(&t.reference) && take(&t.artist, key(&t.artist, &t.title), PER_ARTIST_CATALOG) {
                from_catalog.push((t.artist.clone(), catalog_pick(t)));
            }
        }
        for (_, t) in &catalog {
            if from_catalog.len() >= want_catalog {
                break;
            }
            if fresh(&t.reference) && take(&t.artist, key(&t.artist, &t.title), PER_ARTIST_CATALOG) {
                from_catalog.push((t.artist.clone(), catalog_pick(t)));
            }
        }
        for (_, t, reason) in &library {
            if from_library.len() + from_catalog.len() >= MIX_SIZE {
                break;
            }
            if fresh(&t.id) && take(&t.artist, key(&t.artist, &t.title), PER_ARTIST) {
                from_library.push((t.artist.clone(), Pick::Library { id: t.id.clone(), reason: *reason }));
            }
        }
        // Библиотеки не хватило — добрать каталогом
        for (_, t) in &catalog {
            if from_library.len() + from_catalog.len() >= MIX_SIZE {
                break;
            }
            if fresh(&t.reference) && take(&t.artist, key(&t.artist, &t.title), PER_ARTIST_CATALOG) {
                from_catalog.push((t.artist.clone(), catalog_pick(t)));
            }
        }
        if from_library.len() + from_catalog.len() >= MIX_SIZE {
            break;
        }
    }
    interleave(from_library, from_catalog)
}

/// Сигналы вкуса одного человека: имена исполнителей, по одному на событие.
#[derive(Clone, Debug, Default)]
pub struct Signals {
    /// Выбраны в настройках микса.
    pub seeds: Vec<String>,
    /// По одному на трек в «Любимом».
    pub starred: Vec<String>,
    /// По одному на день, когда слушал трек исполнителя (30 дней).
    pub played: Vec<String>,
    /// Дослушал трек до конца.
    pub finished: Vec<String>,
    /// Переключил в первые секунды.
    pub skipped: Vec<String>,
    /// Добавил трек на сервер.
    pub fetched: Vec<String>,
    /// «Не нравится» на треке.
    pub disliked_tracks: Vec<String>,
    /// «Не нравится» на исполнителе.
    pub disliked_artists: Vec<String>,
}

/// Вкус: веса исполнителей и кто убран из микса целиком.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Taste {
    pub weights: BTreeMap<String, f64>,
    pub blocked: BTreeSet<String>,
}

impl Taste {
    /// Исполнители по убыванию веса, только с весом больше нуля — от них строятся радио и похожие.
    pub fn top(&self, limit: usize) -> Vec<String> {
        let mut liked: Vec<(&String, &f64)> = self.weights.iter().filter(|(a, w)| **w > 0.0 && !self.blocked.contains(*a)).collect();
        liked.sort_by(|a, b| b.1.total_cmp(a.1).then_with(|| a.0.cmp(b.0)));
        liked.into_iter().take(limit).map(|(a, _)| a.clone()).collect()
    }
}

/// Вес исполнителя по сигналам: выбран +3, ♡ +2, день прослушивания +0,5 (не больше +4), дослушал +0,5, скачал +1,
/// пропустил −1, «не нравится» на треке −3. «Не нравится» на исполнителе либо на [`DISLIKES_TO_BLOCK`] его треках —
/// исполнитель убран.
pub fn taste(signals: &Signals) -> Taste {
    let mut weights: BTreeMap<String, f64> = BTreeMap::new();
    let mut add = |artists: &[String], delta: f64| {
        for a in artists {
            let n = norm(a);
            if !n.is_empty() {
                *weights.entry(n).or_default() += delta;
            }
        }
    };
    add(&signals.seeds, 3.0);
    add(&signals.starred, 2.0);
    add(&signals.finished, 0.5);
    add(&signals.fetched, 1.0);
    add(&signals.skipped, -1.0);
    add(&signals.disliked_tracks, -3.0);
    let mut plays: BTreeMap<String, f64> = BTreeMap::new();
    for a in &signals.played {
        *plays.entry(norm(a)).or_default() += 0.5;
    }
    for (a, w) in plays {
        if !a.is_empty() {
            *weights.entry(a).or_default() += w.min(4.0);
        }
    }
    let mut dislikes: BTreeMap<String, usize> = BTreeMap::new();
    for a in &signals.disliked_tracks {
        *dislikes.entry(norm(a)).or_default() += 1;
    }
    let mut blocked: BTreeSet<String> = signals.disliked_artists.iter().map(|a| norm(a)).filter(|a| !a.is_empty()).collect();
    blocked.extend(dislikes.into_iter().filter(|(a, n)| *n >= DISLIKES_TO_BLOCK && !a.is_empty()).map(|(a, _)| a));
    Taste { weights, blocked }
}

/// Соседние жанры каталога (номера жанров Deezer): откуда брать разнообразие для любителя жанра.
pub fn neighbor_genres(genre: u32) -> &'static [u32] {
    match genre {
        116 => &[165, 132, 113],      // рэп/хип-хоп → R&B, поп, танцевальная
        132 => &[113, 165, 85],       // поп → танцевальная, R&B, альтернатива
        152 => &[85, 464, 153],       // рок → альтернатива, метал, блюз
        165 => &[116, 169, 132],      // R&B → рэп, соул и фанк, поп
        113 => &[106, 132, 116],      // танцевальная → электронная, поп, рэп
        85 => &[152, 106, 466],       // альтернатива → рок, электронная, фолк
        106 => &[113, 85, 132],       // электронная → танцевальная, альтернатива, поп
        466 => &[85, 84, 153],        // фолк → альтернатива, кантри, блюз
        144 => &[2, 116, 165],        // регги → африканская, рэп, R&B
        129 => &[153, 169, 98],       // джаз → блюз, соул, классика
        98 => &[129, 173, 466],       // классика → джаз, кино, фолк
        464 => &[152, 85, 106],       // метал → рок, альтернатива, электронная
        169 => &[165, 129, 153],      // соул и фанк → R&B, джаз, блюз
        153 => &[129, 152, 169],      // блюз → джаз, рок, соул
        197 => &[132, 113, 116],      // латино → поп, танцевальная, рэп
        _ => &[132, 116, 85],
    }
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
        CatalogCandidate { reference: format!("dz:{r}"), artist: artist.into(), title: format!("Трек {r}"), because_of: "Группа".into(), ..Default::default() }
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
        i.current.insert("l0".into());
        i.disliked_tracks.insert("dz:c1".into());
        i.disliked_artists.insert(norm("Исп 2"));
        // Трек каталога, который уже есть на сервере, не предлагается
        i.catalog.push(CatalogCandidate { reference: "dz:dup".into(), artist: "Исп 3".into(), title: "Песня l3".into(), ..Default::default() });
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

    /// Обычный микс и «Открытия» не повторяют любимое — оно и так в «Любимом»
    #[test]
    fn starred_tracks_stay_out_of_normal_and_discover() {
        for mode in [Mode::Normal, Mode::Discover] {
            let mut i = input(mode);
            i.library = vec![lib("fav", "Любимый", 5, true), lib("x", "Прочий", 5, false)];
            let mix = build(&i);
            assert!(!mix.iter().any(|p| matches!(p, Pick::Library { id, .. } if id == "fav")), "{mode:?}: любимое в миксе");
            assert!(mix.iter().any(|p| matches!(p, Pick::Library { id, .. } if id == "x")), "{mode:?}: прочее пропало");
        }
    }

    /// Вкус: выбранные и ♡ — плюс, пропуски и «не нравится» на треке — минус; два «не нравится» убирают исполнителя
    #[test]
    fn taste_weights_and_blocks_by_track_dislikes() {
        let v = |xs: &[&str]| xs.iter().map(|x| (*x).to_string()).collect::<Vec<_>>();
        let t = taste(&Signals {
            seeds: v(&["Эндшпиль"]),
            starred: v(&["Santiz", "Santiz"]),
            played: v(&["Santiz", "Santiz", "Santiz", "Santiz", "Santiz", "Santiz", "Santiz", "Santiz", "Santiz", "Santiz"]),
            skipped: v(&["Каспийский груз"]),
            disliked_tracks: v(&["jamik", "jamik", "Нурминский"]),
            disliked_artists: v(&["Кто-то"]),
            ..Default::default()
        });
        assert_eq!(t.weights[&norm("Santiz")], 4.0 + 4.0, "♡ дважды и прослушивания — не больше +4");
        assert!(t.blocked.contains(&norm("jamik")), "два «не нравится» на треках");
        assert!(!t.blocked.contains(&norm("Нурминский")) && t.weights[&norm("Нурминский")] < 0.0, "одно — вниз, но не убран");
        assert!(t.blocked.contains(&norm("Кто-то")));
        assert_eq!(t.top(2), vec![norm("Santiz"), norm("Эндшпиль")]);
    }

    /// Новое: не больше двух треков одного исполнителя, доля соседнего жанра, ближе ко вкусу — выше
    #[test]
    fn catalog_is_spread_by_artist_and_genre() {
        let mut i = input(Mode::Normal);
        i.library.clear();
        i.catalog = (0..30).map(|n| CatalogCandidate { source: Source::Radio, ..cat(&format!("r{n}"), &format!("Рад {}", n % 3)) }).collect();
        i.catalog.extend((0..30).map(|n| CatalogCandidate { source: Source::Genre, because_of: "R&B".into(), ..cat(&format!("g{n}"), &format!("Жанр {n}")) }));
        i.catalog.extend((0..30).map(|n| CatalogCandidate { source: Source::Related, ..cat(&format!("p{n}"), &format!("Пох {n}")) }));
        let mix = build(&i);
        assert_eq!(mix.len(), MIX_SIZE);
        let genre = mix.iter().filter(|p| matches!(p, Pick::Catalog { source: Source::Genre, .. })).count();
        assert!(genre >= Mode::Normal.genre_share(), "соседнего жанра {genre}");
        let radio = mix.iter().filter(|p| matches!(p, Pick::Catalog { source: Source::Radio, .. })).count();
        assert!(radio <= 3 * PER_ARTIST_CATALOG, "по два трека на исполнителя радио: {radio}");
    }

    /// Сегодняшний микс не повторяется никогда; прошлые дни — только если иначе микс короче
    #[test]
    fn other_mix_never_repeats_today_and_stays_full() {
        let mut i = input(Mode::Normal);
        let first = build(&i);
        let ids = |m: &[Pick]| m.iter().map(|p| match p { Pick::Library { id, .. } => id.clone(), Pick::Catalog { reference, .. } => reference.clone() }).collect::<BTreeSet<_>>();
        i.current = ids(&first);
        i.seed = seed("alice@local", 200, 7);
        let second = build(&i);
        assert!(ids(&second).is_disjoint(&i.current));
        // Всё остальное было в прошлые дни — микс всё равно полный, без сегодняшних
        i.recent = i.library.iter().map(|t| t.id.clone()).chain(i.catalog.iter().map(|t| t.reference.clone())).collect();
        let third = build(&i);
        assert_eq!(third.len(), second.len());
        assert!(ids(&third).is_disjoint(&i.current));
    }

    /// Вес исполнителя поднимает его треки каталога над треками безразличного
    #[test]
    fn liked_artists_rank_higher() {
        let mut i = input(Mode::Discover);
        i.library.clear();
        i.catalog = (0..40).map(|n| cat(&format!("c{n}"), &format!("Кат {n}"))).collect();
        i.weights = (0..10).map(|n| (norm(&format!("Кат {n}")), 6.0)).collect();
        let mix = build(&i);
        let liked = mix.iter().filter(|p| matches!(p, Pick::Catalog { reference, .. } if reference.trim_start_matches("dz:c").parse::<u32>().is_ok_and(|n| n < 10))).count();
        assert!(liked >= 8, "любимых исполнителей в миксе {liked} из 10");
    }

    #[test]
    fn short_library_is_filled_from_catalog() {
        let mut i = input(Mode::Normal);
        i.library.truncate(4);
        // Любимое в обычный микс не идёт
        let usable = i.library.iter().filter(|t| !t.starred).count();
        let mix = build(&i);
        assert_eq!(mix.len(), MIX_SIZE);
        assert_eq!(count_catalog(&mix), MIX_SIZE - usable);
    }
}
