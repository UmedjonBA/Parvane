#!/usr/bin/env python3
"""Сервис скачивания для «Музыки» Parvane (spec 039, этап B).

Необязательный отдельный процесс: шард `music` ходит к нему по HTTP (`PARVANE_MUSIC_FETCH_URL`), наружу он не
опубликован. Сервис только ищет и качает; что считать тем самым треком (сверка с эталоном, версии без цензуры,
отсечки по дате), решает шард. Источники — на ответственности администратора сервера.

Контракт (JSON):
  GET  /health
  GET  /catalog?q=&limit=              эталоны треков из каталога (Deezer)
  GET  /candidates?source=&artist=&title=&limit=
                                       файлы источника: youtube, youtube_reupload, soundcloud; источник отказал — 503
  POST /download {"source","id","dest"} скачать в папку библиотеки по пути dest + расширение
  GET  /progress?dest=                 ход идущей загрузки {"bytes_done","bytes_total"}; нет такой — 404 (spec 041)
  POST /cancel {"dest"}                остановить загрузку dest (spec 041)
  Отказ с причиной — {"reason": "..."}: шард показывает её пользователю («Сервер не может скачивать: …»)

Окружение: MUSIC_FETCH_BIND (0.0.0.0:9350), MUSIC_FETCH_LIBRARY_DIR (/music), MUSIC_FETCH_COOLDOWN_SECS (900),
MUSIC_FETCH_PROXY (необязательный прокси для источников), MUSIC_FETCH_COOKIES_FILE (необязательный файл cookies).
"""

import json
import re
import os
import threading
import time
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import yt_dlp

LIBRARY_DIR = os.path.realpath(os.environ.get("MUSIC_FETCH_LIBRARY_DIR", "/music"))
COOLDOWN_SECS = int(os.environ.get("MUSIC_FETCH_COOLDOWN_SECS", "900"))
PROXY = os.environ.get("MUSIC_FETCH_PROXY") or None
COOKIES_FILE = os.environ.get("MUSIC_FETCH_COOKIES_FILE") or None
DEEZER_API = "https://api.deezer.com"
# Чип поиска: `artist:"…"`, `album:"…"`, `track:"…"`
FIELD_QUERY = re.compile(r'^(artist|album|track):"([^"]*)"$')
# Сколько результатов обычного поиска перебрать для отбора по полю (у Deezer не больше 100)
FIELD_SEARCH_LIMIT = 100
MAX_LIMIT = 10
# Запрос источнику: (префикс поиска yt-dlp, добавка к строке)
SOURCES = {
    "youtube": ("ytsearch", ""),
    # Перезаливы: тот же YouTube, но ищем копии с пометкой «без цензуры»
    "youtube_reupload": ("ytsearch", " без цензуры"),
    "soundcloud": ("scsearch", ""),
}
# Слова отказа источника («подтвердите, что вы не бот», лимит запросов): после них источник отдыхает
REFUSALS = ("sign in to confirm", "not a bot", "429", "too many requests", "rate limit")

# Источник → момент, до которого его не трогаем
cooldown_until = {}
# Одновременно источнику — один запрос: быстрые серии запросов и вызывают отказы
source_locks = {name: threading.Lock() for name in SOURCES}


class SourceRefused(Exception):
    pass


def ydl_options(extra):
    options = {"quiet": True, "no_warnings": True, "noplaylist": True, "socket_timeout": 20}
    if PROXY:
        options["proxy"] = PROXY
    if COOKIES_FILE:
        options["cookiefile"] = COOKIES_FILE
    options.update(extra)
    return options


def guarded(source, action):
    """Выполнить запрос к источнику с учётом отдыха после отказа."""
    if cooldown_until.get(source, 0) > time.time():
        raise SourceRefused(source)
    with source_locks[source]:
        try:
            return action()
        except yt_dlp.utils.DownloadError as error:
            text = str(error).lower()
            if any(word in text for word in REFUSALS):
                cooldown_until[source] = time.time() + COOLDOWN_SECS
                raise SourceRefused(source) from error
            raise


def upload_day(info):
    day = info.get("upload_date") or ""
    return f"{day[:4]}-{day[4:6]}-{day[6:8]}" if len(day) == 8 else None


def deezer(path, **params):
    url = f"{DEEZER_API}{path}?{urllib.parse.urlencode(params)}"
    with urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": "parvane-music-fetch"}), timeout=15) as response:
        return json.load(response).get("data", [])


def catalog(query, limit):
    """Эталоны треков. Запрос `artist:"…"`, `album:"…"`, `track:"…"` — чипы поиска «Музыки»: поиск Deezer по полю
    выдаёт постороннее, а популярное исполнителя и треки альбома с сервера приходят урезанными (ограничение по стране),
    поэтому обычный поиск пошире и только треки с текстом в нужном поле."""
    match = FIELD_QUERY.match(query.strip())
    if not match:
        return {"tracks": to_tracks(deezer("/search", q=query, limit=limit), limit)}
    field, text = match.group(1), match.group(2).strip()
    needle = text.casefold()
    found = [item for item in deezer("/search", q=text, limit=FIELD_SEARCH_LIMIT) if needle in field_value(item, field).casefold()]
    return {"tracks": to_tracks(found, limit)}


def field_value(item, field):
    if field == "track":
        return item.get("title", "")
    return (item.get(field) or {}).get("name" if field == "artist" else "title", "")


def to_tracks(items, limit):
    tracks = []
    for item in items[:limit]:
        album = item.get("album") or {}
        tracks.append({
            "artist": (item.get("artist") or {}).get("name", ""),
            "title": item.get("title", ""),
            "album": album.get("title", ""),
            "duration": int(item.get("duration") or 0),
            # Deezer: explicit_content_lyrics 1 — с ненормативной лексикой, 0 и 3 — нет, остальное — неизвестно
            "explicit": {1: True, 0: False, 3: False}.get(item.get("explicit_content_lyrics")),
            "year": 0,
        })
    return tracks


def candidates(source, artist, title, limit):
    prefix, suffix = SOURCES[source]
    request = f"{prefix}{limit}:{artist} {title}{suffix}"

    def search():
        with yt_dlp.YoutubeDL(ydl_options({"skip_download": True})) as ydl:
            return ydl.extract_info(request, download=False)

    found = guarded(source, search) or {}
    items = []
    for info in found.get("entries") or []:
        if not info or not info.get("id"):
            continue
        items.append({
            "id": info.get("webpage_url") or info["id"],
            "title": info.get("title") or "",
            "uploader": info.get("uploader") or info.get("channel") or "",
            "duration": int(info.get("duration") or 0),
            "uploaded": upload_day(info),
            "bitrate": int(info.get("abr") or 0),
            "explicit": None,
        })
    return {"candidates": items}


def safe_dest(dest):
    """Путь внутри папки библиотеки; выход за неё — ошибка."""
    full = os.path.realpath(os.path.join(LIBRARY_DIR, dest))
    if not full.startswith(LIBRARY_DIR + os.sep):
        raise ValueError("dest outside the library")
    return full


# Ход загрузок по dest и снятые загрузки (spec 041)
PROGRESS = {}
CANCELLED = set()
PROGRESS_LOCK = threading.Lock()


class Cancelled(Exception):
    pass


def download(source, item_id, dest):
    target = safe_dest(dest)
    os.makedirs(os.path.dirname(target), exist_ok=True)

    def hook(status):
        with PROGRESS_LOCK:
            if dest in CANCELLED:
                raise Cancelled()
            done = int(status.get("downloaded_bytes") or 0)
            total = int(status.get("total_bytes") or status.get("total_bytes_estimate") or 0)
            PROGRESS[dest] = (done, total)

    options = ydl_options({
        # Лучшая звуковая дорожка как есть, без перекодирования: музыкальный сервер играет opus и m4a
        "format": "bestaudio/best",
        "outtmpl": target + ".%(ext)s",
        "overwrites": True,
        "progress_hooks": [hook],
    })

    def fetch():
        with yt_dlp.YoutubeDL(options) as ydl:
            info = ydl.extract_info(item_id, download=True)
            return info, ydl.prepare_filename(info)

    try:
        info, path = guarded(source, fetch)
    finally:
        with PROGRESS_LOCK:
            PROGRESS.pop(dest, None)
            CANCELLED.discard(dest)
    return {
        "path": os.path.relpath(path, LIBRARY_DIR),
        "bytes": os.path.getsize(path),
        "duration": int(info.get("duration") or 0),
    }


class Handler(BaseHTTPRequestHandler):
    def reply(self, status, body):
        data = json.dumps(body, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def handle_request(self, action):
        try:
            self.reply(200, action())
        except SourceRefused:
            self.reply(503, {"error": "source refused"})
        except Cancelled:
            self.reply(409, {"error": "cancelled"})
        except (KeyError, ValueError):
            self.reply(400, {"error": "bad request"})
        except Exception as error:  # noqa: BLE001 — любой сбой источника отдаётся шарду кодом, не роняя сервис
            print(f"fetch: {type(error).__name__}: {error}", flush=True)
            self.reply(502, {"error": "source failed"})

    def do_GET(self):  # noqa: N802 — имя задано http.server
        url = urllib.parse.urlparse(self.path)
        query = {key: values[0] for key, values in urllib.parse.parse_qs(url.query).items()}
        limit = max(1, min(MAX_LIMIT, int(query.get("limit", "5") or 5)))
        if url.path == "/health":
            self.reply(200, {"ok": True})
        elif url.path == "/catalog":
            self.handle_request(lambda: catalog(query["q"], limit))
        elif url.path == "/candidates":
            self.handle_request(lambda: candidates(query["source"], query["artist"], query["title"], limit))
        elif url.path == "/progress":
            with PROGRESS_LOCK:
                done = PROGRESS.get(query.get("dest", ""))
            if done is None:
                self.reply(404, {"error": "not found"})
            else:
                self.reply(200, {"bytes_done": done[0], "bytes_total": done[1]})
        else:
            self.reply(404, {"error": "not found"})

    def do_POST(self):  # noqa: N802
        if self.path not in ("/download", "/cancel"):
            self.reply(404, {"error": "not found"})
            return
        body = json.loads(self.rfile.read(int(self.headers.get("Content-Length", "0") or 0)) or b"{}")
        if self.path == "/cancel":
            with PROGRESS_LOCK:
                CANCELLED.add(str(body.get("dest", "")))
            self.reply(200, {})
            return
        self.handle_request(lambda: download(body["source"], body["id"], body["dest"]))

    def log_message(self, *_args):
        pass


def main():
    host, _, port = os.environ.get("MUSIC_FETCH_BIND", "0.0.0.0:9350").rpartition(":")
    server = ThreadingHTTPServer((host or "0.0.0.0", int(port)), Handler)
    print(f"music-fetch: слушаю {host}:{port}, библиотека {LIBRARY_DIR}", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
