"""Источники файлов «Найти и скачать», у которых свой сайт, а не yt-dlp: hitmoz и hitmos.fm.

Оба отдают MP3 прямой ссылкой (обычно 320 кбит/с, без DRM) и открываются с серверов, где YouTube и SoundCloud
закрыты, поэтому идут первыми. Поиск — страница результатов сайта: у hitmoz строка трека несёт JSON
`data-musmeta` (исполнитель, название), длительность и ссылку `/get/music/<ГГГГММДД>/…mp3` — дата загрузки файла
нужна шарду для правила «загружено до … — копия без правок»; у hitmos.fm список треков лежит в данных страницы
Next.js (`self.__next_f`) объектами `{id, title, artist, duration, play, download, image}`, даты нет.

Скачивание — только по ссылке на домен самого источника (`allowed_url`): сервис не качает что угодно откуда угодно.
"""

import html
import json
import os
import re
import urllib.parse
import urllib.request

USER_AGENT = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36"
TIMEOUT_SECS = 15
# Зеркала hitmoz меняются: первое ответившее берётся; порядок — переменной `MUSIC_FETCH_HITMOZ_DOMAINS`
HITMOZ_DOMAINS = [d.strip() for d in os.environ.get(
    "MUSIC_FETCH_HITMOZ_DOMAINS", "ru.hitmox.net,ru.hitmoz.org,rus.hitmotop.com").split(",") if d.strip()]
HITMOS_DOMAIN = os.environ.get("MUSIC_FETCH_HITMOS_DOMAIN", "rus.hitmos.fm")
# Файлы hitmos.fm отдаёт с поддоменов (`dwc1.hitmos.fm`, `plc1.hitmos.fm`)
HITMOS_FILE_SUFFIX = ".hitmos.fm"

HITMOZ_ITEM = re.compile(r'<li class="tracks__item track[^"]*"[^>]*data-musmeta=\'([^\']+)\'(.*?)</li>', re.S)
HITMOZ_TIME = re.compile(r'class="track__fulltime">\s*(\d+):(\d\d)\s*<')
HITMOZ_FILE = re.compile(r'href="(/get/music/(\d{4})(\d\d)(\d\d)/[^"]+\.mp3)"')
NEXT_CHUNK = re.compile(r'self\.__next_f\.push\(\[1,"(.*?)"\]\)', re.S)
HITMOS_OBJECT = re.compile(r'\{"id":\d+,"title":')


def get(url, referer=None):
    headers = {"User-Agent": USER_AGENT, "Accept-Language": "ru-RU,ru;q=0.9"}
    if referer:
        headers["Referer"] = referer
    return urllib.request.urlopen(urllib.request.Request(url, headers=headers), timeout=TIMEOUT_SECS)


def search(source, query, limit):
    """Кандидаты источника в виде, общем с yt-dlp: id (ссылка на файл), title «исполнитель - название», uploader,
    duration (с), uploaded (ГГГГ-ММ-ДД либо None), bitrate (0 — неизвестно), explicit (None)."""
    if source == "hitmoz":
        return search_hitmoz(query, limit)
    return search_hitmos(query, limit)


def search_hitmoz(query, limit):
    last_error = None
    for domain in HITMOZ_DOMAINS:
        url = f"https://{domain}/search?{urllib.parse.urlencode({'q': query})}"
        try:
            with get(url) as response:
                page = response.read().decode("utf-8", "replace")
        except OSError as error:
            last_error = error
            continue
        return parse_hitmoz(page, domain, limit)
    raise last_error or OSError("hitmoz: ни одно зеркало не ответило")


def parse_hitmoz(page, domain, limit):
    found = []
    for meta_raw, body in HITMOZ_ITEM.findall(page):
        try:
            meta = json.loads(html.unescape(meta_raw))
        except ValueError:
            continue
        file_match = HITMOZ_FILE.search(body)
        if not file_match:
            continue
        time_match = HITMOZ_TIME.search(body)
        path, year, month, day = file_match.groups()
        artist, title = str(meta.get("artist") or "").strip(), str(meta.get("title") or "").strip()
        found.append({
            "id": f"https://{domain}{path}",
            "title": f"{artist} - {title}",
            "uploader": artist,
            "duration": int(time_match.group(1)) * 60 + int(time_match.group(2)) if time_match else 0,
            "uploaded": f"{year}-{month}-{day}",
            "bitrate": 0,
            "explicit": None,
        })
        if len(found) >= limit:
            break
    return found


def search_hitmos(query, limit):
    url = f"https://{HITMOS_DOMAIN}/search?{urllib.parse.urlencode({'q': query})}"
    with get(url) as response:
        page = response.read().decode("utf-8", "replace")
    return parse_hitmos(page, limit)


def parse_hitmos(page, limit):
    # Данные страницы Next.js — строки JS подряд; склеенные, они содержат JSON-объекты треков
    payload = ""
    for chunk in NEXT_CHUNK.findall(page):
        try:
            payload += json.loads(f'"{chunk}"')
        except ValueError:
            continue
    decoder = json.JSONDecoder()
    found, seen = [], set()
    for match in HITMOS_OBJECT.finditer(payload):
        try:
            item, _ = decoder.raw_decode(payload, match.start())
        except ValueError:
            continue
        download = str(item.get("download") or "")
        if not download or item.get("id") in seen or not allowed_url("hitmos_fm", download):
            continue
        seen.add(item.get("id"))
        artist, title = str(item.get("artist") or "").strip(), str(item.get("title") or "").strip()
        found.append({
            "id": download,
            "title": f"{artist} - {title}",
            "uploader": artist,
            "duration": int(item.get("duration") or 0),
            "uploaded": None,
            "bitrate": 0,
            "explicit": None,
        })
        if len(found) >= limit:
            break
    return found


def allowed_url(source, url):
    """Ссылка ведёт на файл самого источника (https и его домен)."""
    parts = urllib.parse.urlparse(url)
    host = (parts.hostname or "").lower()
    if parts.scheme != "https":
        return False
    if source == "hitmoz":
        return host in HITMOZ_DOMAINS and parts.path.startswith("/get/")
    return host == HITMOS_DOMAIN or host.endswith(HITMOS_FILE_SUFFIX)


def fetch_file(source, url, target, on_progress):
    """Скачать файл источника в `target` (.mp3). `on_progress(done, total)` может прервать загрузку исключением."""
    if not allowed_url(source, url):
        raise ValueError("ссылка не на файл источника")
    referer = f"https://{urllib.parse.urlparse(url).hostname}/"
    with get(url, referer) as response:
        kind = response.headers.get("Content-Type", "")
        if not kind.startswith("audio/") and kind != "application/octet-stream":
            raise OSError(f"источник отдал не звук: {kind}")
        total = int(response.headers.get("Content-Length") or 0)
        done = 0
        with open(target, "wb") as out:
            while True:
                block = response.read(64 * 1024)
                if not block:
                    break
                out.write(block)
                done += len(block)
                on_progress(done, total)
    if done == 0:
        raise OSError("пустой файл")
    return target
