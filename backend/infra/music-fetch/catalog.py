"""Каталог «Музыки» — Deezer: эталоны треков, поиск исполнителей, альбомов и треков, страницы исполнителя и альбома,
похожие исполнители и чарт (для «Микса дня»), полные данные трека для тегов.

С некоторых серверов Deezer отвечает с перебоями (обрыв рукопожатия TLS): два коротких прямых запроса, потом — через
прокси источников (`MUSIC_FETCH_PROXY`), если он задан. Ссылки каталога — `dz:<id>`.
"""

import json
import os
import re
import urllib.parse
import urllib.request

API = "https://api.deezer.com"
HEADERS = {"User-Agent": "parvane-music-fetch"}
DIRECT_TIMEOUT_SECS = 6
PROXY_TIMEOUT_SECS = 15
DIRECT_TRIES = 2
PROXY = os.environ.get("MUSIC_FETCH_PROXY") or None
# Чип поиска: `artist:"…"`, `album:"…"`, `track:"…"`
FIELD_QUERY = re.compile(r'^(artist|album|track):"([^"]*)"$')
# Сколько результатов обычного поиска перебрать для отбора по полю (у Deezer не больше 100)
FIELD_SEARCH_LIMIT = 100
ROW_LIMIT = 12
TRACK_PAGE = 25
ARTIST_ALBUMS_LIMIT = 200
RELATED_LIMIT = 10


class CatalogError(Exception):
    pass


def get(path, **params):
    """Ответ Deezer целиком (JSON). Ошибка Deezer (`{"error": …}`) — `CatalogError`."""
    url = f"{API}{path}" + (f"?{urllib.parse.urlencode(params)}" if params else "")
    request = urllib.request.Request(url, headers=HEADERS)
    last = None
    for _ in range(DIRECT_TRIES):
        try:
            with urllib.request.urlopen(request, timeout=DIRECT_TIMEOUT_SECS) as response:
                return checked(json.load(response))
        except OSError as error:
            last = error
    if PROXY:
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({"http": PROXY, "https": PROXY}))
        with opener.open(request, timeout=PROXY_TIMEOUT_SECS) as response:
            return checked(json.load(response))
    raise last


def checked(body):
    if isinstance(body, dict) and body.get("error"):
        raise CatalogError(str(body["error"].get("message") or body["error"]))
    return body


def data(path, **params):
    return get(path, **params).get("data", [])


def ref_id(ref):
    """`dz:123` → 123; иначе ошибка."""
    if not ref.startswith("dz:") or not ref[3:].isdigit():
        raise ValueError("не ссылка каталога")
    return int(ref[3:])


# ── Перевод в общий вид ─────────────────────────────────────────────────────────────────────────────────────────

def explicit_of(code):
    # Deezer: 1 — с ненормативной лексикой, 0 и 3 — нет, остальное — неизвестно
    return {1: True, 0: False, 3: False}.get(code)


def year_of(date):
    return int(date[:4]) if isinstance(date, str) and date[:4].isdigit() else 0


def track_out(item, album=None):
    album = album or item.get("album") or {}
    return {
        "ref": f"dz:{item['id']}" if item.get("id") else "",
        "artist": (item.get("artist") or {}).get("name", ""),
        "title": item.get("title", ""),
        "album": album.get("title", ""),
        "album_ref": f"dz:{album['id']}" if album.get("id") else "",
        "duration": int(item.get("duration") or 0),
        "explicit": explicit_of(item.get("explicit_content_lyrics")),
        "year": year_of(item.get("release_date") or album.get("release_date")),
        "cover": album.get("cover_medium") or "",
    }


def ranked_artists(items, query):
    """Исполнители поиска: точное совпадение имени первым, дальше — по числу поклонников (Deezer ставит выше и
    малоизвестных однофамильцев)."""
    needle = query.strip().casefold()
    items = sorted(items, key=lambda a: (a.get("name", "").casefold() != needle, -int(a.get("nb_fan") or 0)))
    return [artist_out(item) for item in items]


def artist_out(item):
    return {
        "ref": f"dz:{item['id']}",
        "name": item.get("name", ""),
        "picture": item.get("picture_medium") or "",
        "albums": int(item.get("nb_album") or 0),
    }


def album_out(item, artist=None):
    artist = artist or item.get("artist") or {}
    return {
        "ref": f"dz:{item['id']}",
        "title": item.get("title", ""),
        "artist": artist.get("name", ""),
        "artist_ref": f"dz:{artist['id']}" if artist.get("id") else "",
        "cover": item.get("cover_medium") or "",
        "year": year_of(item.get("release_date")),
        "record_type": item.get("record_type") or "",
        "tracks": int(item.get("nb_tracks") or 0),
        "explicit": True if item.get("explicit_lyrics") else None,
    }


def unique(tracks):
    """Deezer бывает отдаёт трек дважды."""
    seen = set()
    return [t for t in tracks if t["ref"] and not (t["ref"] in seen or seen.add(t["ref"]))]


# ── Запросы ─────────────────────────────────────────────────────────────────────────────────────────────────────

def references(query, limit):
    """Эталоны треков по строке; `artist:"…"`, `album:"…"`, `track:"…"` — отбор обычного поиска по полю (поиск
    Deezer по полю выдаёт постороннее)."""
    match = FIELD_QUERY.match(query.strip())
    if not match:
        return unique([track_out(item) for item in data("/search", q=query, limit=limit)])[:limit]
    field, text = match.group(1), match.group(2).strip()
    needle = text.casefold()

    def value(item):
        if field == "track":
            return item.get("title", "")
        return (item.get(field) or {}).get("name" if field == "artist" else "title", "")

    found = [item for item in data("/search", q=text, limit=FIELD_SEARCH_LIMIT) if needle in value(item).casefold()]
    return unique([track_out(item) for item in found])[:limit]


def search(query, offset):
    """Поиск: исполнители и альбомы (при `offset` 0) и страница треков; `next` — откуда следующая страница."""
    page = get("/search", q=query, index=offset, limit=TRACK_PAGE)
    raw = page.get("data", [])
    out = {
        "tracks": unique([track_out(item) for item in raw]),
        "has_more": bool(page.get("next")) and bool(raw),
        "next": offset + len(raw),
        "artists": [],
        "albums": [],
    }
    if offset == 0:
        out["artists"] = ranked_artists(data("/search/artist", q=query, limit=ROW_LIMIT), query)
        out["albums"] = [album_out(item) for item in data("/search/album", q=query, limit=ROW_LIMIT)]
    return out


ARTIST_TOP_LIMIT = 10


def artist_page(ref):
    """Исполнитель и его релизы, новые первыми."""
    artist_id = ref_id(ref)
    artist = get(f"/artist/{artist_id}")
    albums = data(f"/artist/{artist_id}/albums", limit=ARTIST_ALBUMS_LIMIT)
    albums.sort(key=lambda item: item.get("release_date") or "", reverse=True)
    # «Популярное» исполнителя (доска `XpMusic`): его самые слушаемые треки в каталоге
    top = [track_out(item, item.get("album") or {}) for item in data(f"/artist/{artist_id}/top", limit=ARTIST_TOP_LIMIT)]
    return {"artist": artist_out(artist), "albums": [album_out(item, artist) for item in albums], "top": top}


def album_page(ref):
    """Альбом и его треки по порядку (номер и диск — у каждого)."""
    album_id = ref_id(ref)
    album = get(f"/album/{album_id}")
    tracks = data(f"/album/{album_id}/tracks", limit=500)
    out = []
    for item in tracks:
        track = track_out(item, album)
        track["track_no"] = int(item.get("track_position") or 0)
        track["disc_no"] = int(item.get("disk_number") or 0)
        out.append(track)
    return {"album": album_out(album), "tracks": out}


def artists(query):
    """Исполнители: поиск по имени либо (пусто) чарт каталога."""
    if query.strip():
        return ranked_artists(data("/search/artist", q=query, limit=30), query)
    return [artist_out(item) for item in data("/chart/0/artists", limit=30)]


def related(ref):
    """Похожие исполнители."""
    return [artist_out(item) for item in data(f"/artist/{ref_id(ref)}/related", limit=RELATED_LIMIT)]


def track_tags(ref):
    """Полные теги трека: название, исполнитель, альбом, исполнитель альбома, номер, диск, год, обложка (большая)."""
    item = get(f"/track/{ref_id(ref)}")
    album = item.get("album") or {}
    album_artist = ""
    if album.get("id"):
        try:
            album_artist = (get(f"/album/{album['id']}").get("artist") or {}).get("name", "")
        except (OSError, CatalogError, ValueError):
            album_artist = ""
    return {
        "artist": (item.get("artist") or {}).get("name", ""),
        "title": item.get("title", ""),
        "album": album.get("title", ""),
        "album_artist": album_artist,
        "track": int(item.get("track_position") or 0),
        "disc": int(item.get("disk_number") or 0),
        "year": year_of(item.get("release_date")),
        "cover_url": album.get("cover_xl") or album.get("cover_big") or "",
    }
