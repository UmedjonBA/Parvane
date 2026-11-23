"""SponsorBlock: немузыкальные куски клипов YouTube (вступление, концовка, «подписывайтесь») и реклама спонсоров —
отрезки, отмеченные зрителями (https://sponsor.ajay.app). После скачивания с YouTube они вырезаются без
перекодирования. Отметок нет, сервис недоступен или отметки странные — файл остаётся как был.
"""

import json
import os
import subprocess
import urllib.error
import urllib.parse
import urllib.request

API = "https://sponsor.ajay.app/api/skipSegments"
CATEGORIES = ["music_offtopic", "sponsor"]
TIMEOUT_SECS = 5
DIRECT_TRIES = 2
PROXY = os.environ.get("MUSIC_FETCH_PROXY") or None
# Вырезать меньше секунды — незачем; после выреза осталось меньше этой доли — отметки подозрительны, не режем
MIN_CUT_SECS = 1.0
MIN_KEPT_SHARE = 0.6
CUT_TIMEOUT_SECS = 120


def segments(video_id):
    """Отрезки «пропустить» для видео: [(начало, конец)] по возрастанию, слитые; сбой — []."""
    query = urllib.parse.urlencode({"videoID": video_id, "categories": json.dumps(CATEGORIES)})
    items = fetch_json(f"{API}?{query}")
    if not isinstance(items, list):
        return []
    spans = sorted((float(s["segment"][0]), float(s["segment"][1])) for s in items
                   if s.get("actionType", "skip") == "skip" and len(s.get("segment") or []) == 2)
    merged = []
    for start, end in spans:
        if end <= start:
            continue
        if merged and start <= merged[-1][1]:
            merged[-1] = (merged[-1][0], max(merged[-1][1], end))
        else:
            merged.append((start, end))
    return merged


def fetch_json(url):
    """Ответ SponsorBlock: с некоторых серверов он обрывается — два коротких прямых запроса, потом через прокси
    источников. 404 — отметок нет; не вышло — `None` (файл без выреза)."""
    request = urllib.request.Request(url, headers={"User-Agent": "parvane-music-fetch"})
    openers = [urllib.request.build_opener()] * DIRECT_TRIES
    if PROXY:
        openers.append(urllib.request.build_opener(urllib.request.ProxyHandler({"http": PROXY, "https": PROXY})))
    for opener in openers:
        try:
            with opener.open(request, timeout=TIMEOUT_SECS) as response:
                return json.load(response)
        except urllib.error.HTTPError as error:
            if error.code == 404:
                return []
        except (OSError, ValueError):
            continue
    return None


def kept_parts(spans, duration):
    """Что оставить: промежутки [0, duration] между вырезаемыми отрезками."""
    parts, at = [], 0.0
    for start, end in spans:
        start, end = max(0.0, start), min(duration, end)
        if start > at:
            parts.append((at, start))
        at = max(at, end)
    if at < duration:
        parts.append((at, duration))
    return [(a, b) for a, b in parts if b - a > 0.05]


def strip(path, video_id, duration):
    """Вырезать отмеченное из файла `path` (длительность `duration`, с); вернуть, вырезано ли."""
    if not video_id or duration <= 0:
        return False
    spans = segments(video_id)
    parts = kept_parts(spans, duration)
    kept = sum(b - a for a, b in parts)
    if not spans or duration - kept < MIN_CUT_SECS or kept < duration * MIN_KEPT_SHARE:
        return False
    listing = f"{path}.cut.txt"
    ext = os.path.splitext(path)[1]
    tmp = f"{path}.cut{ext}"
    escaped = path.replace("'", "'\\''")
    with open(listing, "w", encoding="utf-8") as out:
        out.write("ffconcat version 1.0\n")
        for start, end in parts:
            out.write(f"file '{escaped}'\ninpoint {start:.3f}\noutpoint {end:.3f}\n")
    try:
        subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "concat", "-safe", "0", "-i", listing, "-map", "0:a",
                        "-c", "copy", tmp], check=True, timeout=CUT_TIMEOUT_SECS, capture_output=True)
        os.replace(tmp, path)
        return True
    except (OSError, subprocess.SubprocessError) as error:
        print(f"sponsorblock: {type(error).__name__}: {error}", flush=True)
        return False
    finally:
        for leftover in (listing, tmp):
            if os.path.exists(leftover):
                os.remove(leftover)
