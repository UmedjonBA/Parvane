"""Тексты песен — LRCLIB (https://lrclib.net, открытая база, синхронные тексты в формате LRC). Текст кладётся рядом с
файлом трека (`<имя>.lrc`): музыкальный сервер подхватывает его сам и отдаёт плееру (OpenSubsonic
`getLyricsBySongId`). С некоторых серверов LRCLIB отвечает с обрывами — сначала через прокси источников, если он
есть. Не нашлось или не ответил — трек остаётся без текста.
"""

import json
import os
import urllib.error
import urllib.parse
import urllib.request

API = "https://lrclib.net/api"
HEADERS = {"User-Agent": "parvane-music-fetch (https://github.com/UmedjonBA/Parvane)"}
TIMEOUT_SECS = 15
PROXY = os.environ.get("MUSIC_FETCH_PROXY") or None
# Длительность записи LRCLIB и файла расходится не больше чем на столько — иначе это другая версия
DURATION_TOLERANCE_SECS = 4


def openers():
    if PROXY:
        yield urllib.request.build_opener(urllib.request.ProxyHandler({"http": PROXY, "https": PROXY}))
    yield urllib.request.build_opener()


def call(path, **params):
    url = f"{API}/{path}?{urllib.parse.urlencode(params)}"
    for opener in openers():
        try:
            with opener.open(urllib.request.Request(url, headers=HEADERS), timeout=TIMEOUT_SECS) as response:
                return json.load(response)
        except urllib.error.HTTPError as error:
            if error.code == 404:
                return None
        except (OSError, ValueError):
            continue
    return None


def find(artist, title, album, duration):
    """Текст: синхронный (LRC) либо простой; `None` — не нашлось."""
    if not artist or not title:
        return None
    params = {"artist_name": artist, "track_name": title}
    if album:
        params["album_name"] = album
    if duration:
        params["duration"] = int(duration)
    exact = call("get", **params)
    if exact and (exact.get("syncedLyrics") or exact.get("plainLyrics")):
        return exact.get("syncedLyrics") or exact.get("plainLyrics")
    # Точного совпадения нет — поиск: та же длительность (± допуск), синхронный — первым
    found = call("search", track_name=title, artist_name=artist) or []
    fits = [item for item in found if isinstance(item, dict) and not item.get("instrumental")
            and (not duration or abs(float(item.get("duration") or 0) - duration) <= DURATION_TOLERANCE_SECS)]
    fits.sort(key=lambda item: not item.get("syncedLyrics"))
    for item in fits:
        text = item.get("syncedLyrics") or item.get("plainLyrics")
        if text:
            return text
    return None


def write_sidecar(audio_path, artist, title, album, duration):
    """Положить текст рядом с файлом трека; вернуть, нашёлся ли."""
    text = find(artist, title, album, duration)
    if not text:
        return False
    with open(os.path.splitext(audio_path)[0] + ".lrc", "w", encoding="utf-8") as out:
        out.write(text.strip() + "\n")
    return True
