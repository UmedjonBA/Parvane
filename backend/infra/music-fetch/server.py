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
import subprocess
import threading
import time
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import yt_dlp

import catalog
import sites
import sponsorblock

LIBRARY_DIR = os.path.realpath(os.environ.get("MUSIC_FETCH_LIBRARY_DIR", "/music"))
COOLDOWN_SECS = int(os.environ.get("MUSIC_FETCH_COOLDOWN_SECS", "900"))
PROXY = os.environ.get("MUSIC_FETCH_PROXY") or None
COOKIES_FILE = os.environ.get("MUSIC_FETCH_COOKIES_FILE") or None
# Перезапись тегов скачанного файла (ffmpeg без перекодирования)
RETAG_TIMEOUT_SECS = 120
# Обложку вшивает ffmpeg; в Opus/Vorbis (и WebM с ними) — `mutagen` после перекладки в Ogg
COVER_EXTS = (".mp3", ".m4a")
OGG_EXTS = (".webm", ".opus", ".ogg")
COVER_TIMEOUT_SECS = 15
COVER_MAX_BYTES = 5 * 1024 * 1024
MAX_LIMIT = 10
# Запрос источнику: (префикс поиска yt-dlp, добавка к строке)
SOURCES = {
    "youtube": ("ytsearch", ""),
    # Перезаливы: тот же YouTube, но ищем копии с пометкой «без цензуры»
    "youtube_reupload": ("ytsearch", " без цензуры"),
    "soundcloud": ("scsearch", ""),
}
# Файлы этих источников — клипы YouTube: немузыкальные куски вырезаются по SponsorBlock
YOUTUBE_SOURCES = ("youtube", "youtube_reupload")
# Источники со своим сайтом (sites.py): MP3 прямой ссылкой, без yt-dlp
SITE_SOURCES = ("hitmoz", "hitmos_fm")
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


def catalog_references(query, limit):
    return {"tracks": catalog.references(query, limit)}


def candidates(source, artist, title, limit):
    if source in SITE_SOURCES:
        return {"candidates": guarded(source, lambda: sites.search(source, f"{artist} {title}", limit))}
    prefix, suffix = SOURCES[source]
    request = f"{prefix}{limit}:{artist} {title}{suffix}"

    def search():
        # Запись, которую не разобрать (у SoundCloud — официальные загрузки под DRM), пропускается: без этого одна
        # такая роняла весь поиск источника, а скачать её всё равно нельзя
        with yt_dlp.YoutubeDL(ydl_options({"skip_download": True, "ignoreerrors": True})) as ydl:
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


def download(source, item_id, dest, tags=None):
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
        if source in SITE_SOURCES:
            path = sites.fetch_file(source, item_id, target + ".mp3", lambda done, total: hook(
                {"downloaded_bytes": done, "total_bytes": total}))
            return {"duration": probe_duration(path)}, path
        with yt_dlp.YoutubeDL(options) as ydl:
            info = ydl.extract_info(item_id, download=True)
            return info, ydl.prepare_filename(info)

    try:
        info, path = guarded(source, fetch)
    finally:
        with PROGRESS_LOCK:
            PROGRESS.pop(dest, None)
            CANCELLED.discard(dest)
    # Клип с YouTube: немузыкальные куски, отмеченные зрителями (SponsorBlock), — вырезаются
    if source in YOUTUBE_SOURCES and sponsorblock.strip(path, str(info.get("id") or ""), probe_duration(path)):
        info = {**info, "duration": probe_duration(path)}
    if tags:
        path = retag(path, tags)
    return {
        "path": os.path.relpath(path, LIBRARY_DIR),
        "bytes": os.path.getsize(path),
        "duration": int(info.get("duration") or 0),
    }


def probe_duration(path):
    """Длительность файла, с (0 — не узнать)."""
    try:
        out = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", path],
                             check=True, timeout=30, capture_output=True, text=True).stdout
        return int(float(out.strip() or 0))
    except (OSError, ValueError, subprocess.SubprocessError):
        return 0


def retag(path, tags):
    """Теги файла — по эталону каталога, в UTF-8; возвращает путь файла (Opus из WebM переезжает в `.opus`).
    Перезаливы несут свои теги («5. Группа - Песня (prod.)», нередко в cp1251, которую музыкальный сервер читает как
    latin-1). Есть ссылка каталога (`ref`) — полные теги (исполнитель альбома, номер, диск, год) и обложка: в MP3 и
    M4A — ffmpeg, в Opus/Vorbis — перекладка в Ogg без перекодирования и `mutagen` (ffmpeg обложку в Ogg не пишет).
    Звук не перекодируется; не вышло — файл остаётся как был."""
    full = dict(tags)
    if str(tags.get("ref") or "").startswith("dz:"):
        try:
            full.update({k: v for k, v in catalog.track_tags(tags["ref"]).items() if v})
        except (OSError, ValueError, catalog.CatalogError) as error:
            print(f"retag: каталог: {type(error).__name__}: {error}", flush=True)
    ext = os.path.splitext(path)[1].lower()
    cover = fetch_cover(full.get("cover_url"), path)
    try:
        if ext in OGG_EXTS:
            return retag_ogg(path, full, cover)
        retag_ffmpeg(path, full, cover if ext in COVER_EXTS else None)
        return path
    except (OSError, subprocess.SubprocessError, ValueError) as error:
        print(f"retag: {type(error).__name__}: {error}", flush=True)
        return path
    finally:
        if cover and os.path.exists(cover):
            os.remove(cover)


TAG_FIELDS = (("artist", "artist", "ARTIST"), ("title", "title", "TITLE"), ("album", "album", "ALBUM"),
              ("album_artist", "album_artist", "ALBUMARTIST"), ("track", "track", "TRACKNUMBER"),
              ("disc", "disc", "DISCNUMBER"), ("year", "date", "DATE"))


def tag_values(full):
    for key, ffmpeg_name, vorbis_name in TAG_FIELDS:
        value = str(full.get(key) or "").strip()
        if value and value != "0":
            yield ffmpeg_name, vorbis_name, value


def retag_ffmpeg(path, full, cover):
    ext = os.path.splitext(path)[1]
    tmp = f"{path}.tags{ext}"
    command = ["ffmpeg", "-v", "error", "-y", "-i", path]
    if cover:
        command += ["-i", cover, "-map", "0:a", "-map", "1:v", "-c", "copy", "-disposition:v", "attached_pic"]
    else:
        command += ["-map", "0:a", "-c", "copy"]
    command += ["-map_metadata", "-1"]
    for name, _, value in tag_values(full):
        command += ["-metadata", f"{name}={value}"]
    if ext.lower() == ".mp3":
        command += ["-id3v2_version", "3"]
    command.append(tmp)
    try:
        subprocess.run(command, check=True, timeout=RETAG_TIMEOUT_SECS, capture_output=True)
        os.replace(tmp, path)
    finally:
        if os.path.exists(tmp):
            os.remove(tmp)


def retag_ogg(path, full, cover):
    """Opus/Vorbis (в том числе WebM с YouTube) → Ogg без перекодирования, теги и обложка — `mutagen`."""
    import base64
    from mutagen.flac import Picture
    from mutagen.oggopus import OggOpus
    from mutagen.oggvorbis import OggVorbis

    codec = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "a:0", "-show_entries", "stream=codec_name",
                            "-of", "csv=p=0", path], check=True, timeout=30, capture_output=True, text=True).stdout.strip()
    if codec not in ("opus", "vorbis"):
        raise ValueError(f"звук {codec!r} в Ogg не переложить")
    target = os.path.splitext(path)[0] + (".opus" if codec == "opus" else ".ogg")
    tmp = f"{target}.tags"
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", path, "-map", "0:a", "-c", "copy", "-map_metadata", "-1",
                    "-f", "ogg", tmp], check=True, timeout=RETAG_TIMEOUT_SECS, capture_output=True)
    try:
        audio = (OggOpus if codec == "opus" else OggVorbis)(tmp)
        audio.delete()
        for _, name, value in tag_values(full):
            audio[name] = [value]
        if cover:
            picture = Picture()
            picture.type = 3
            picture.mime = "image/jpeg"
            with open(cover, "rb") as image:
                picture.data = image.read()
            audio["METADATA_BLOCK_PICTURE"] = [base64.b64encode(picture.write()).decode("ascii")]
        audio.save()
        os.replace(tmp, target)
    finally:
        if os.path.exists(tmp):
            os.remove(tmp)
    if target != path and os.path.exists(path):
        os.remove(path)
    return target


def retag_existing(relative, tags):
    """Дозаполнить теги и обложку уже скачанного файла: ссылки каталога нет — найти трек в каталоге по исполнителю и
    названию (совпадение названия и исполнителя без учёта регистра). Ответ — новый путь (Opus из WebM переезжает) и
    нашёлся ли трек в каталоге."""
    path = safe_dest(relative)
    if not os.path.isfile(path):
        raise ValueError("нет файла")
    full = {k: str(v) for k, v in tags.items() if isinstance(v, (str, int))}
    if not str(full.get("ref") or "").startswith("dz:"):
        artist, title = full.get("artist", "").strip(), full.get("title", "").strip()
        found = catalog.references(f"{artist} {title}", 10) if artist and title else []
        match = next((t for t in found if t["title"].casefold() == title.casefold()
                      and artist.casefold() in t["artist"].casefold()), None)
        if match is None:
            return {"path": relative, "matched": False}
        full["ref"] = match["ref"]
    new_path = retag(path, full)
    return {"path": os.path.relpath(new_path, LIBRARY_DIR), "matched": True}


def fetch_cover(url, near):
    """Обложка из каталога во временный файл рядом с треком; не вышло — `None`."""
    if not url or not url.startswith("https://"):
        return None
    target = f"{near}.cover.jpg"
    try:
        with urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": "parvane-music-fetch"}),
                                    timeout=COVER_TIMEOUT_SECS) as response:
            body = response.read(COVER_MAX_BYTES + 1)
        if not body or len(body) > COVER_MAX_BYTES:
            return None
        with open(target, "wb") as out:
            out.write(body)
        return target
    except OSError:
        return None


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
            self.handle_request(lambda: catalog_references(query["q"], limit))
        elif url.path == "/catalog/search":
            self.handle_request(lambda: catalog.search(query["q"], max(0, int(query.get("offset", "0") or 0))))
        elif url.path == "/catalog/artist":
            self.handle_request(lambda: catalog.artist_page(query["ref"]))
        elif url.path == "/catalog/album":
            self.handle_request(lambda: catalog.album_page(query["ref"]))
        elif url.path == "/catalog/artists":
            self.handle_request(lambda: {"artists": catalog.artists(query.get("q", ""))})
        elif url.path == "/catalog/related":
            self.handle_request(lambda: {"artists": catalog.related(query["ref"])})
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
        if self.path not in ("/download", "/cancel", "/retag"):
            self.reply(404, {"error": "not found"})
            return
        body = json.loads(self.rfile.read(int(self.headers.get("Content-Length", "0") or 0)) or b"{}")
        if self.path == "/retag":
            self.handle_request(lambda: retag_existing(str(body["path"]), body.get("tags") or {}))
            return
        if self.path == "/cancel":
            with PROGRESS_LOCK:
                CANCELLED.add(str(body.get("dest", "")))
            self.reply(200, {})
            return
        tags = body.get("tags") if isinstance(body.get("tags"), dict) else None
        self.handle_request(lambda: download(body["source"], body["id"], body["dest"], tags))

    def log_message(self, *_args):
        pass


def main():
    host, _, port = os.environ.get("MUSIC_FETCH_BIND", "0.0.0.0:9350").rpartition(":")
    server = ThreadingHTTPServer((host or "0.0.0.0", int(port)), Handler)
    print(f"music-fetch: слушаю {host}:{port}, библиотека {LIBRARY_DIR}", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
