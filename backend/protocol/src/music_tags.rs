//! Теги своих аудиофайлов «Музыки» (spec 041, «Загрузить свои файлы»): одно чтение для клиента (показ до загрузки)
//! и шарда music (принятый файл перечитывается сам — клиенту не верим). Читает начало файла (`head`, сколько дали) и
//! необязательный хвост (`tail`, последние 128 байт — ID3v1). Форматы: MP3 (ID3v2.2–2.4, ID3v1), FLAC (STREAMINFO,
//! VORBIS_COMMENT), Ogg Vorbis/Opus (заголовок комментариев), MP4/M4A (`moov/udta/meta/ilst`, `mvhd`), WAV (без
//! тегов). Названия нет в тегах — из имени файла «Исполнитель - Название.mp3».

use serde::Serialize;
use serde_json::Value;

/// Формат по первым байтам; `Unknown` — не звук (шард такой файл не принимает).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Format {
    Mp3,
    Flac,
    Ogg,
    M4a,
    Wav,
    Unknown,
}

impl Format {
    pub fn mime(self) -> &'static str {
        match self {
            Format::Mp3 => "audio/mpeg",
            Format::Flac => "audio/flac",
            Format::Ogg => "audio/ogg",
            Format::M4a => "audio/mp4",
            Format::Wav => "audio/wav",
            Format::Unknown => "",
        }
    }

    /// Расширение файла в библиотеке.
    pub fn extension(self) -> &'static str {
        match self {
            Format::Mp3 => "mp3",
            Format::Flac => "flac",
            Format::Ogg => "ogg",
            Format::M4a => "m4a",
            Format::Wav => "wav",
            Format::Unknown => "",
        }
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Tags {
    pub title: String,
    pub artist: String,
    pub album: String,
    pub track_no: u32,
    pub year: u32,
    /// 0 — неизвестно (в MP3 без TLEN длительность знает только плеер).
    pub duration_secs: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileTags {
    pub format: Format,
    pub mime: &'static str,
    #[serde(flatten)]
    pub tags: Tags,
    /// Название и исполнитель взяты из имени файла.
    pub from_name: bool,
}

const TEXT_MAX: usize = 512;

pub fn detect(head: &[u8]) -> Format {
    if head.starts_with(b"fLaC") {
        return Format::Flac;
    }
    if head.starts_with(b"OggS") {
        return Format::Ogg;
    }
    if head.len() >= 12 && &head[..4] == b"RIFF" && &head[8..12] == b"WAVE" {
        return Format::Wav;
    }
    if head.len() >= 8 && &head[4..8] == b"ftyp" {
        return Format::M4a;
    }
    if head.starts_with(b"ID3") {
        // ID3 бывает и перед FLAC: смотрим, что за тегом
        let after = id3v2_size(head).map_or(head.len(), |n| (n + 10).min(head.len()));
        if head.get(after..).is_some_and(|rest| rest.starts_with(b"fLaC")) {
            return Format::Flac;
        }
        return Format::Mp3;
    }
    if head.len() >= 2 && head[0] == 0xFF && head[1] & 0xE0 == 0xE0 && head[1] & 0x06 != 0 {
        return Format::Mp3;
    }
    Format::Unknown
}

fn clip(s: &str) -> String {
    let t = s.trim_matches(|c: char| c.is_whitespace() || c == '\0');
    let mut out = String::new();
    for c in t.chars() {
        if out.len() + c.len_utf8() > TEXT_MAX {
            break;
        }
        if !c.is_control() {
            out.push(c);
        }
    }
    out
}

/// Однобайтовый текст тега. По стандарту — Latin-1, но русские файлы часто записаны в Windows-1251 («Ýíäøïèëü» вместо
/// «Эндшпиль»): когда больше половины букв лежат в верхней половине таблицы, текст читается как Windows-1251
/// (у западного текста такие буквы — редкие «é», «ü» среди обычных латинских).
fn latin1(b: &[u8]) -> String {
    if looks_cp1251(b) {
        return b.iter().map(|&c| cp1251_char(c)).collect();
    }
    b.iter().map(|&c| char::from(c)).collect()
}

fn looks_cp1251(b: &[u8]) -> bool {
    let high = b.iter().filter(|&&c| c >= 0xC0 || c == 0xA8 || c == 0xB8).count();
    let letters = high + b.iter().filter(|c| c.is_ascii_alphabetic()).count();
    high > 0 && high * 2 > letters
}

fn cp1251_char(c: u8) -> char {
    match c {
        0xC0..=0xFF => char::from_u32(0x0410 + u32::from(c - 0xC0)).unwrap_or('?'),
        0xA8 => 'Ё',
        0xB8 => 'ё',
        0xB9 => '№',
        0x96 => '–',
        0x97 => '—',
        0x85 => '…',
        0x93 | 0xAB => '«',
        0x94 | 0xBB => '»',
        _ => char::from(c),
    }
}

/// Текст тега уже прочитан как Latin-1 (`Ýíäøïèëü`, так его покажет и музыкальный сервер): вернуть Windows-1251,
/// если это она; иначе `None`.
pub fn repair_cp1251(text: &str) -> Option<String> {
    let bytes: Option<Vec<u8>> = text.chars().map(|c| u8::try_from(u32::from(c)).ok()).collect();
    let bytes = bytes?;
    looks_cp1251(&bytes).then(|| bytes.iter().map(|&c| cp1251_char(c)).collect())
}

fn utf16(b: &[u8], big: bool) -> String {
    let units: Vec<u16> = b.chunks_exact(2).map(|p| if big { u16::from_be_bytes([p[0], p[1]]) } else { u16::from_le_bytes([p[0], p[1]]) }).collect();
    String::from_utf16_lossy(&units)
}

/// Число из начала строки: «3/12» → 3, «2024-05-01» → 2024.
fn leading_number(s: &str) -> u32 {
    s.trim().chars().take_while(char::is_ascii_digit).take(9).collect::<String>().parse().unwrap_or(0)
}

fn set_if_empty(slot: &mut String, value: String) {
    if slot.is_empty() && !value.is_empty() {
        *slot = value;
    }
}

// ── ID3 ─────────────────────────────────────────────────────────────────────

fn synchsafe(b: &[u8]) -> usize {
    b.iter().take(4).fold(0usize, |n, &x| (n << 7) | usize::from(x & 0x7F))
}

fn id3v2_size(head: &[u8]) -> Option<usize> {
    (head.len() >= 10 && head.starts_with(b"ID3")).then(|| synchsafe(&head[6..10]))
}

fn id3_text(frame: &[u8]) -> String {
    let Some((&enc, body)) = frame.split_first() else { return String::new() };
    let text = match enc {
        0 => latin1(body),
        1 => match body {
            [0xFF, 0xFE, rest @ ..] => utf16(rest, false),
            [0xFE, 0xFF, rest @ ..] => utf16(rest, true),
            _ => utf16(body, false),
        },
        2 => utf16(body, true),
        3 => String::from_utf8_lossy(body).into_owned(),
        _ => String::new(),
    };
    // Несколько значений разделены нулём — берём первое
    clip(text.split('\0').next().unwrap_or(""))
}

fn read_id3v2(head: &[u8], tags: &mut Tags) {
    let Some(size) = id3v2_size(head) else { return };
    let version = head[3];
    let flags = head[5];
    let end = (10 + size).min(head.len());
    let mut pos = 10;
    // Расширенный заголовок
    if flags & 0x40 != 0 && head.len() >= 14 {
        let ext = if version == 4 { synchsafe(&head[10..14]) } else { u32::from_be_bytes([head[10], head[11], head[12], head[13]]) as usize + 4 };
        pos += ext;
    }
    let (id_len, header_len) = if version == 2 { (3, 6) } else { (4, 10) };
    while pos + header_len <= end {
        let id = &head[pos..pos + id_len];
        if id.iter().all(|&b| b == 0) {
            break;
        }
        let len = match version {
            2 => (usize::from(head[pos + 3]) << 16) | (usize::from(head[pos + 4]) << 8) | usize::from(head[pos + 5]),
            4 => synchsafe(&head[pos + 4..pos + 8]),
            _ => u32::from_be_bytes([head[pos + 4], head[pos + 5], head[pos + 6], head[pos + 7]]) as usize,
        };
        let body_start = pos + header_len;
        let Some(body_end) = body_start.checked_add(len) else { break };
        if len == 0 || body_end > end {
            break;
        }
        let body = &head[body_start..body_end];
        match id {
            b"TIT2" | b"TT2" => set_if_empty(&mut tags.title, id3_text(body)),
            b"TPE1" | b"TP1" => set_if_empty(&mut tags.artist, id3_text(body)),
            b"TPE2" | b"TP2" => set_if_empty(&mut tags.artist, id3_text(body)),
            b"TALB" | b"TAL" => set_if_empty(&mut tags.album, id3_text(body)),
            b"TRCK" | b"TRK" if tags.track_no == 0 => tags.track_no = leading_number(&id3_text(body)),
            b"TDRC" | b"TYER" | b"TYE" | b"TDOR" if tags.year == 0 => tags.year = leading_number(&id3_text(body)),
            b"TLEN" | b"TLE" if tags.duration_secs == 0 => tags.duration_secs = leading_number(&id3_text(body)) / 1000,
            _ => {}
        }
        pos = body_end;
    }
}

fn read_id3v1(tail: &[u8], tags: &mut Tags) {
    if tail.len() < 128 {
        return;
    }
    let t = &tail[tail.len() - 128..];
    if !t.starts_with(b"TAG") {
        return;
    }
    set_if_empty(&mut tags.title, clip(&latin1(&t[3..33])));
    set_if_empty(&mut tags.artist, clip(&latin1(&t[33..63])));
    set_if_empty(&mut tags.album, clip(&latin1(&t[63..93])));
    if tags.year == 0 {
        tags.year = leading_number(&latin1(&t[93..97]));
    }
    if tags.track_no == 0 && t[125] == 0 && t[126] != 0 {
        tags.track_no = u32::from(t[126]);
    }
}

// ── Vorbis-комментарии (FLAC, Ogg) ──────────────────────────────────────────

fn le32(b: &[u8], at: usize) -> Option<usize> {
    b.get(at..at + 4).map(|x| u32::from_le_bytes([x[0], x[1], x[2], x[3]]) as usize)
}

fn read_vorbis_comments(b: &[u8], tags: &mut Tags) {
    let Some(vendor) = le32(b, 0) else { return };
    let mut pos = 4 + vendor;
    let Some(count) = le32(b, pos) else { return };
    pos += 4;
    for _ in 0..count.min(1000) {
        let Some(len) = le32(b, pos) else { return };
        pos += 4;
        let Some(raw) = b.get(pos..pos + len) else { return };
        pos += len;
        let text = String::from_utf8_lossy(raw);
        let Some((key, value)) = text.split_once('=') else { continue };
        let value = clip(value);
        match key.to_ascii_uppercase().as_str() {
            "TITLE" => set_if_empty(&mut tags.title, value),
            "ARTIST" | "ALBUMARTIST" => set_if_empty(&mut tags.artist, value),
            "ALBUM" => set_if_empty(&mut tags.album, value),
            "TRACKNUMBER" if tags.track_no == 0 => tags.track_no = leading_number(&value),
            "DATE" | "YEAR" if tags.year == 0 => tags.year = leading_number(&value),
            _ => {}
        }
    }
}

fn read_flac(head: &[u8], tags: &mut Tags) {
    let start = id3v2_size(head).map_or(0, |n| n + 10);
    let Some(rest) = head.get(start..) else { return };
    if !rest.starts_with(b"fLaC") {
        return;
    }
    let mut pos = 4;
    loop {
        let Some(h) = rest.get(pos..pos + 4) else { return };
        let last = h[0] & 0x80 != 0;
        let kind = h[0] & 0x7F;
        let len = (usize::from(h[1]) << 16) | (usize::from(h[2]) << 8) | usize::from(h[3]);
        let Some(body) = rest.get(pos + 4..pos + 4 + len) else { return };
        match kind {
            0 if body.len() >= 18 => {
                // STREAMINFO: частота 20 бит, число отсчётов 36 бит
                let rate = (u64::from(body[10]) << 12) | (u64::from(body[11]) << 4) | (u64::from(body[12]) >> 4);
                let samples = ((u64::from(body[13]) & 0x0F) << 32) | u64::from(u32::from_be_bytes([body[14], body[15], body[16], body[17]]));
                if rate > 0 {
                    tags.duration_secs = (samples / rate).min(u64::from(u32::MAX)) as u32;
                }
            }
            4 => read_vorbis_comments(body, tags),
            _ => {}
        }
        if last {
            return;
        }
        pos += 4 + len;
    }
}

/// Пакеты первых страниц Ogg (склеивая продолжения) — до трёх пакетов.
fn ogg_packets(head: &[u8]) -> Vec<Vec<u8>> {
    let mut packets: Vec<Vec<u8>> = Vec::new();
    let mut current: Vec<u8> = Vec::new();
    let mut pos = 0;
    while packets.len() < 3 {
        let Some(h) = head.get(pos..pos + 27) else { break };
        if &h[..4] != b"OggS" {
            break;
        }
        let segments = usize::from(h[26]);
        let Some(table) = head.get(pos + 27..pos + 27 + segments) else { break };
        let mut data = pos + 27 + segments;
        for &lace in table {
            let Some(chunk) = head.get(data..data + usize::from(lace)) else { return packets };
            current.extend_from_slice(chunk);
            data += usize::from(lace);
            if lace < 255 {
                packets.push(std::mem::take(&mut current));
            }
        }
        pos = data;
    }
    packets
}

fn read_ogg(head: &[u8], tags: &mut Tags) {
    for p in ogg_packets(head) {
        if let Some(rest) = p.strip_prefix(b"OpusTags") {
            read_vorbis_comments(rest, tags);
        } else if let Some(rest) = p.strip_prefix(b"\x03vorbis") {
            read_vorbis_comments(rest, tags);
        }
    }
}

// ── MP4 ─────────────────────────────────────────────────────────────────────

fn be32(b: &[u8], at: usize) -> Option<u32> {
    b.get(at..at + 4).map(|x| u32::from_be_bytes([x[0], x[1], x[2], x[3]]))
}

/// Дочерние атомы: (тип, тело).
fn atoms(b: &[u8]) -> Vec<(&[u8], &[u8])> {
    let mut out = Vec::new();
    let mut pos = 0;
    while let Some(size) = be32(b, pos) {
        let size = size as usize;
        if size < 8 || pos + size > b.len() {
            break;
        }
        out.push((&b[pos + 4..pos + 8], &b[pos + 8..pos + size]));
        pos += size;
    }
    out
}

fn child<'a>(b: &'a [u8], name: &[u8]) -> Option<&'a [u8]> {
    atoms(b).into_iter().find(|(n, _)| *n == name).map(|(_, body)| body)
}

fn read_m4a(head: &[u8], tags: &mut Tags) {
    let Some(moov) = child(head, b"moov") else { return };
    if let Some(mvhd) = child(moov, b"mvhd") {
        let (scale, duration) = if mvhd.first() == Some(&1) {
            (be32(mvhd, 20).map(u64::from), mvhd.get(24..32).map(|x| u64::from_be_bytes(x.try_into().unwrap_or([0; 8]))))
        } else {
            (be32(mvhd, 12).map(u64::from), be32(mvhd, 16).map(u64::from))
        };
        if let (Some(s), Some(d)) = (scale, duration) {
            if s > 0 {
                tags.duration_secs = (d / s).min(u64::from(u32::MAX)) as u32;
            }
        }
    }
    let Some(meta) = child(moov, b"udta").and_then(|u| child(u, b"meta")) else { return };
    // `meta` — полный атом: 4 байта версии и флагов перед детьми
    let Some(ilst) = meta.get(4..).and_then(|m| child(m, b"ilst")) else { return };
    for (name, body) in atoms(ilst) {
        let Some(data) = child(body, b"data") else { continue };
        let Some(value) = data.get(8..) else { continue };
        let text = || clip(&String::from_utf8_lossy(value));
        match name {
            b"\xa9nam" => set_if_empty(&mut tags.title, text()),
            b"\xa9ART" | b"aART" => set_if_empty(&mut tags.artist, text()),
            b"\xa9alb" => set_if_empty(&mut tags.album, text()),
            b"\xa9day" if tags.year == 0 => tags.year = leading_number(&text()),
            b"trkn" if tags.track_no == 0 && value.len() >= 4 => tags.track_no = u32::from(u16::from_be_bytes([value[2], value[3]])),
            _ => {}
        }
    }
}

/// «Исполнитель - Название.mp3» → (исполнитель, название); без « - » — только название.
fn from_file_name(name: &str) -> (String, String) {
    let base = name.rsplit(['/', '\\']).next().unwrap_or(name);
    let stem = base.rsplit_once('.').map_or(base, |(s, _)| s);
    // Номер дорожки в начале: «03 - …», «03. …»
    let stem = stem.trim_start_matches(|c: char| c.is_ascii_digit()).trim_start_matches(['.', ' ', '-', '_']);
    match stem.split_once(" - ") {
        Some((artist, title)) => (clip(artist), clip(title)),
        None => (String::new(), clip(&stem.replace('_', " "))),
    }
}

/// Теги файла по началу (`head`) и хвосту (`tail`, может быть пустым).
pub fn read(head: &[u8], tail: &[u8], file_name: &str) -> FileTags {
    let format = detect(head);
    let mut tags = Tags::default();
    match format {
        Format::Mp3 => {
            read_id3v2(head, &mut tags);
            read_id3v1(tail, &mut tags);
        }
        Format::Flac => {
            read_id3v2(head, &mut tags);
            read_flac(head, &mut tags);
        }
        Format::Ogg => read_ogg(head, &mut tags),
        Format::M4a => read_m4a(head, &mut tags),
        Format::Wav | Format::Unknown => {}
    }
    let mut from_name = false;
    if tags.title.is_empty() {
        let (artist, title) = from_file_name(file_name);
        tags.title = title;
        from_name = true;
        set_if_empty(&mut tags.artist, artist);
    }
    FileTags { format, mime: format.mime(), tags, from_name }
}

/// Вызов хоста `musicReadTags {head, tail?, fileName?}` (байты — base64).
pub fn read_json(head: &[u8], tail: &[u8], file_name: &str) -> Value {
    serde_json::to_value(read(head, tail, file_name)).unwrap_or(Value::Null)
}

#[cfg(test)]
mod tests {

    /// Русский тег в Windows-1251 (ID3 «Latin-1») читается по-русски; западный с одной «é» — как был.
    #[test]
    fn single_byte_tags_in_windows_1251() {
        let cp1251: Vec<u8> = vec![0xDD, 0xED, 0xE4, 0xF8, 0xEF, 0xE8, 0xEB, 0xFC];
        assert_eq!(latin1(&cp1251), "Эндшпиль");
        let mut mixed = b"MiyaGi & ".to_vec();
        mixed.extend_from_slice(&cp1251);
        assert_eq!(latin1(&mixed), "MiyaGi & Эндшпиль");
        assert_eq!(latin1(&[b'C', b'a', b'f', 0xE9]), "Café");
        assert_eq!(repair_cp1251("Ýíäøïèëü").as_deref(), Some("Эндшпиль"));
        assert_eq!(repair_cp1251("Эндшпиль"), None);
        assert_eq!(repair_cp1251("Café"), None);
    }

    use super::*;

    fn id3_frame(id: &[u8], text: &str) -> Vec<u8> {
        let mut body = vec![3u8];
        body.extend_from_slice(text.as_bytes());
        let mut f = id.to_vec();
        f.extend_from_slice(&(body.len() as u32).to_be_bytes());
        f.extend_from_slice(&[0, 0]);
        f.extend_from_slice(&body);
        f
    }

    fn id3v23(frames: &[Vec<u8>]) -> Vec<u8> {
        let body: Vec<u8> = frames.concat();
        let n = body.len();
        let mut h = b"ID3\x03\x00\x00".to_vec();
        h.extend_from_slice(&[(n >> 21) as u8 & 0x7F, (n >> 14) as u8 & 0x7F, (n >> 7) as u8 & 0x7F, n as u8 & 0x7F]);
        h.extend_from_slice(&body);
        h.extend_from_slice(&[0xFF, 0xFB, 0x90, 0x00]);
        h
    }

    #[test]
    fn mp3_id3v2_utf8_and_utf16() {
        let mut utf16 = vec![1u8, 0xFF, 0xFE];
        for u in "Маршрут".encode_utf16() {
            utf16.extend_from_slice(&u.to_le_bytes());
        }
        let mut talb = b"TALB".to_vec();
        talb.extend_from_slice(&(utf16.len() as u32).to_be_bytes());
        talb.extend_from_slice(&[0, 0]);
        talb.extend_from_slice(&utf16);
        let head = id3v23(&[id3_frame(b"TIT2", "Ночной автобус"), id3_frame(b"TPE1", "Lampa"), talb, id3_frame(b"TRCK", "3/12"), id3_frame(b"TYER", "2024"), id3_frame(b"TLEN", "222000")]);
        let t = read(&head, &[], "x.mp3");
        assert_eq!(t.format, Format::Mp3);
        assert_eq!(t.mime, "audio/mpeg");
        assert_eq!((t.tags.title.as_str(), t.tags.artist.as_str(), t.tags.album.as_str()), ("Ночной автобус", "Lampa", "Маршрут"));
        assert_eq!((t.tags.track_no, t.tags.year, t.tags.duration_secs), (3, 2024, 222));
        assert!(!t.from_name);
    }

    #[test]
    fn mp3_id3v1_tail_and_name_fallback() {
        let mut tail = vec![0u8; 128];
        tail[..3].copy_from_slice(b"TAG");
        tail[3..8].copy_from_slice(b"Shore");
        tail[33..41].copy_from_slice(b"Kora Mes");
        tail[93..97].copy_from_slice(b"2021");
        tail[126] = 7;
        let t = read(&[0xFF, 0xFB, 0x90, 0], &tail, "a.mp3");
        assert_eq!((t.tags.title.as_str(), t.tags.artist.as_str(), t.tags.year, t.tags.track_no), ("Shore", "Kora Mes", 2021, 7));
        let n = read(&[0xFF, 0xFB, 0x90, 0], &[], "music/03 - Тихий порт - Берег.mp3");
        assert_eq!((n.tags.artist.as_str(), n.tags.title.as_str(), n.from_name), ("Тихий порт", "Берег", true));
        let plain = read(&[0xFF, 0xFB, 0x90, 0], &[], "my_song.mp3");
        assert_eq!((plain.tags.artist.as_str(), plain.tags.title.as_str()), ("", "my song"));
    }

    fn vorbis(fields: &[&str]) -> Vec<u8> {
        let mut b = Vec::new();
        b.extend_from_slice(&3u32.to_le_bytes());
        b.extend_from_slice(b"pv1");
        b.extend_from_slice(&(fields.len() as u32).to_le_bytes());
        for f in fields {
            b.extend_from_slice(&(f.len() as u32).to_le_bytes());
            b.extend_from_slice(f.as_bytes());
        }
        b
    }

    #[test]
    fn flac_streaminfo_and_comments() {
        let mut head = b"fLaC".to_vec();
        // STREAMINFO: 44100 Гц, 44100 * 200 отсчётов
        let mut si = vec![0u8; 34];
        let rate: u64 = 44_100;
        let samples: u64 = 44_100 * 200;
        si[10] = (rate >> 12) as u8;
        si[11] = (rate >> 4) as u8;
        si[12] = ((rate & 0x0F) << 4) as u8 | 0x02;
        si[13] = 0x70 | ((samples >> 32) as u8 & 0x0F);
        si[14..18].copy_from_slice(&(samples as u32).to_be_bytes());
        head.extend_from_slice(&[0, 0, 0, 34]);
        head.extend_from_slice(&si);
        let vc = vorbis(&["TITLE=Glass Harbor", "ARTIST=Kora Mesh", "ALBUM=Static Bloom", "DATE=2025-01-02", "TRACKNUMBER=4"]);
        head.extend_from_slice(&[0x84, 0, 0, vc.len() as u8]);
        head.extend_from_slice(&vc);
        let t = read(&head, &[], "x.flac");
        assert_eq!(t.format, Format::Flac);
        assert_eq!((t.tags.title.as_str(), t.tags.artist.as_str(), t.tags.album.as_str()), ("Glass Harbor", "Kora Mesh", "Static Bloom"));
        assert_eq!((t.tags.year, t.tags.track_no, t.tags.duration_secs), (2025, 4, 200));
    }

    fn ogg_page(packet: &[u8]) -> Vec<u8> {
        let mut p = b"OggS".to_vec();
        p.extend_from_slice(&[0; 22]);
        let mut lacing = vec![255u8; packet.len() / 255];
        lacing.push((packet.len() % 255) as u8);
        p.push(lacing.len() as u8);
        p.extend_from_slice(&lacing);
        p.extend_from_slice(packet);
        p
    }

    #[test]
    fn ogg_opus_tags() {
        let mut head = ogg_page(b"OpusHead\x01\x02\x00\x00\x80\xbb\x00\x00\x00\x00\x00");
        let mut tags = b"OpusTags".to_vec();
        tags.extend_from_slice(&vorbis(&["title=Утро", "artist=Lampa"]));
        head.extend_from_slice(&ogg_page(&tags));
        let t = read(&head, &[], "x.opus");
        assert_eq!(t.format, Format::Ogg);
        assert_eq!((t.tags.title.as_str(), t.tags.artist.as_str()), ("Утро", "Lampa"));
    }

    fn atom(name: &[u8], body: &[u8]) -> Vec<u8> {
        let mut a = ((body.len() + 8) as u32).to_be_bytes().to_vec();
        a.extend_from_slice(name);
        a.extend_from_slice(body);
        a
    }

    #[test]
    fn m4a_ilst_and_mvhd() {
        let data = |v: &[u8]| atom(b"data", &[&[0, 0, 0, 1, 0, 0, 0, 0][..], v].concat());
        let ilst = atom(b"ilst", &[atom(b"\xa9nam", &data("Берег".as_bytes())), atom(b"\xa9ART", &data(b"Tihiy")), atom(b"trkn", &data(&[0, 0, 0, 5, 0, 9, 0, 0]))].concat());
        let meta = atom(b"meta", &[&[0u8, 0, 0, 0][..], &atom(b"hdlr", &[0; 25]), &ilst].concat());
        let mut mvhd = vec![0u8; 100];
        mvhd[12..16].copy_from_slice(&1000u32.to_be_bytes());
        mvhd[16..20].copy_from_slice(&180_500u32.to_be_bytes());
        let moov = atom(b"moov", &[atom(b"mvhd", &mvhd), atom(b"udta", &meta)].concat());
        let head = [atom(b"ftyp", b"M4A \x00\x00\x00\x00"), moov].concat();
        let t = read(&head, &[], "x.m4a");
        assert_eq!(t.format, Format::M4a);
        assert_eq!((t.tags.title.as_str(), t.tags.artist.as_str(), t.tags.track_no, t.tags.duration_secs), ("Берег", "Tihiy", 5, 180));
    }

    #[test]
    fn unknown_and_broken_input_do_not_panic() {
        assert_eq!(read(b"%PDF-1.7", &[], "doc.pdf").format, Format::Unknown);
        assert_eq!(detect(b"RIFF\x00\x00\x00\x00WAVEfmt "), Format::Wav);
        // Обрезанные и испорченные заголовки — без паники
        for cut in [b"ID3\x04\x00\x00\x7f\x7f\x7f\x7fTIT2".to_vec(), b"fLaC\x84\xff\xff\xff".to_vec(), b"OggS\x00".to_vec(), atom(b"ftyp", b"M4A ").into_iter().chain(atom(b"moov", &[0xff; 20])).collect()] {
            let _ = read(&cut, &[1, 2, 3], "");
        }
    }
}
