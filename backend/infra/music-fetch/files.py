"""Файлы библиотеки «Музыки» (макет 23 ноя): правка тегов человеком, сведения «Откуда файл», разбор ссылки.

Теги пишутся `mutagen` в простом виде (MP3 — ID3, M4A, FLAC, Ogg/Opus), меняются только переданные поля, звук не
трогается. Обложка — ссылкой каталога (https) либо картинкой в base64; без неё прежняя обложка остаётся."""

import base64
import os
import subprocess
import urllib.request

LINK_HOSTS = {
    "youtube.com": "youtube", "www.youtube.com": "youtube", "m.youtube.com": "youtube", "music.youtube.com": "youtube",
    "youtu.be": "youtube", "soundcloud.com": "soundcloud", "www.soundcloud.com": "soundcloud",
    "m.soundcloud.com": "soundcloud", "on.soundcloud.com": "soundcloud",
}
# Поля правки → ключи простого вида mutagen
EASY_KEYS = {
    "title": "title", "artist": "artist", "album": "album", "album_artist": "albumartist", "year": "date",
    "genre": "genre", "track": "tracknumber", "disc": "discnumber",
}
COVER_MAX_BYTES = 5 * 1024 * 1024
COVER_TIMEOUT_SECS = 15
PROBE_TIMEOUT_SECS = 30


def link_source(url):
    """Источник ссылки: YouTube, SoundCloud, Bandcamp (`*.bandcamp.com`); чужая ссылка — `None`."""
    if not isinstance(url, str) or not url.startswith("https://"):
        return None
    host = url.split("/", 3)[2].split(":")[0].lower()
    if host.endswith(".bandcamp.com") or host == "bandcamp.com":
        return "bandcamp"
    return LINK_HOSTS.get(host)


def read_tags(path):
    """Теги файла и сведения о нём: формат, битрейт, частота, разрядность, длительность, размер, есть ли обложка."""
    import mutagen

    audio = mutagen.File(path, easy=True)
    tags = {}
    if audio is not None and audio.tags is not None:
        for field, key in EASY_KEYS.items():
            values = audio.tags.get(key)
            if values:
                tags[field] = str(values[0])
    return {"tags": tags, "file": probe(path), "has_cover": has_cover(path)}


def probe(path):
    out = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "a:0", "-show_entries",
                          "stream=codec_name,bit_rate,sample_rate,bits_per_raw_sample:format=duration,bit_rate",
                          "-of", "default=noprint_wrappers=1", path],
                         check=False, timeout=PROBE_TIMEOUT_SECS, capture_output=True, text=True).stdout
    info = {}
    for line in out.splitlines():
        key, _, value = line.partition("=")
        if value and value != "N/A" and key not in info:
            info[key] = value
    return {
        "codec": info.get("codec_name", ""),
        "bitrate": int(float(info.get("bit_rate") or 0)),
        "sample_rate": int(float(info.get("sample_rate") or 0)),
        "bits": int(float(info.get("bits_per_raw_sample") or 0)),
        "duration": int(float(info.get("duration") or 0)),
        "bytes": os.path.getsize(path),
    }


def has_cover(path):
    import mutagen

    audio = mutagen.File(path)
    if audio is None or audio.tags is None:
        return bool(getattr(audio, "pictures", None))
    keys = [str(k) for k in audio.tags.keys()]
    return any(k.startswith("APIC") or k == "covr" or k.lower() == "metadata_block_picture" for k in keys) \
        or bool(getattr(audio, "pictures", None))


def write_tags(path, changes, cover=None):
    """Переписать переданные поля (пустая строка — убрать поле); `cover` — байты JPEG/PNG либо `None`."""
    import mutagen

    audio = mutagen.File(path, easy=True)
    if audio is None:
        raise ValueError("файл не читается")
    if audio.tags is None:
        audio.add_tags()
    for field, value in changes.items():
        key = EASY_KEYS.get(field)
        if key is None:
            continue
        value = str(value).strip()
        if value:
            audio.tags[key] = [value]
        elif key in audio.tags:
            del audio.tags[key]
    audio.save()
    if cover:
        write_cover(path, cover)


def write_cover(path, data):
    import mutagen
    from mutagen.flac import FLAC, Picture
    from mutagen.id3 import APIC, ID3
    from mutagen.mp4 import MP4, MP4Cover

    mime = "image/png" if data[:8] == b"\x89PNG\r\n\x1a\n" else "image/jpeg"
    ext = os.path.splitext(path)[1].lower()
    if ext == ".mp3":
        tags = ID3(path)
        tags.delall("APIC")
        tags.add(APIC(encoding=3, mime=mime, type=3, desc="Cover", data=data))
        tags.save(path, v2_version=3)
    elif ext in (".m4a", ".mp4", ".aac"):
        audio = MP4(path)
        kind = MP4Cover.FORMAT_PNG if mime == "image/png" else MP4Cover.FORMAT_JPEG
        audio["covr"] = [MP4Cover(data, imageformat=kind)]
        audio.save()
    else:
        picture = Picture()
        picture.type = 3
        picture.mime = mime
        picture.data = data
        if ext == ".flac":
            audio = FLAC(path)
            audio.clear_pictures()
            audio.add_picture(picture)
        else:
            audio = mutagen.File(path)
            audio["METADATA_BLOCK_PICTURE"] = [base64.b64encode(picture.write()).decode("ascii")]
        audio.save()


def cover_bytes(cover_url, cover_b64, opener):
    """Обложка из ссылки каталога (https, через `opener` с прокси) либо из base64; не больше 5 МБ."""
    if cover_b64:
        data = base64.b64decode(cover_b64)
    elif cover_url and str(cover_url).startswith("https://"):
        with opener(urllib.request.Request(cover_url), timeout=COVER_TIMEOUT_SECS) as response:
            data = response.read(COVER_MAX_BYTES + 1)
    else:
        return None
    if len(data) > COVER_MAX_BYTES:
        raise ValueError("обложка больше 5 МБ")
    return data


def resolve(url, ydl_factory):
    """Что за ссылкой: название, исполнитель, длительность, источник. Плейлист — первый трек не берём: отказ."""
    source = link_source(url)
    if source is None:
        raise ValueError("ссылка не YouTube, SoundCloud или Bandcamp")
    with ydl_factory({"skip_download": True, "noplaylist": True}) as ydl:
        info = ydl.extract_info(url, download=False)
    if info.get("_type") == "playlist":
        raise ValueError("это список, а не трек")
    artist = info.get("artist") or info.get("creator") or info.get("uploader") or ""
    title = info.get("track") or info.get("title") or ""
    return {
        "source": source,
        "id": info.get("webpage_url") or url,
        "artist": str(artist),
        "title": str(title),
        "album": str(info.get("album") or ""),
        "duration": int(info.get("duration") or 0),
    }
