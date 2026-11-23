-- «Микс дня»: настройки человека (режим, час обновления по местному времени, любимые исполнители каталога)
CREATE TABLE IF NOT EXISTS mix_settings (
    user TEXT PRIMARY KEY,
    mode TEXT NOT NULL DEFAULT 'normal',
    hour INTEGER NOT NULL DEFAULT 6,
    tz_offset_min INTEGER NOT NULL DEFAULT 0,
    -- JSON: [{"ref","name","picture"}]
    artists TEXT NOT NULL DEFAULT '[]',
    updated_ms INTEGER NOT NULL
);

-- Собранные миксы: по одному на человека и местный день; треки — JSON строк микса
CREATE TABLE IF NOT EXISTS mixes (
    user TEXT NOT NULL,
    day TEXT NOT NULL,
    built_ms INTEGER NOT NULL,
    mode TEXT NOT NULL,
    tracks TEXT NOT NULL,
    PRIMARY KEY (user, day)
);

-- «Не нравится»: трек (id библиотеки либо dz: каталога) или исполнитель (нормализованное имя)
CREATE TABLE IF NOT EXISTS dislikes (
    user TEXT NOT NULL,
    kind TEXT NOT NULL,
    key TEXT NOT NULL,
    track_id TEXT NOT NULL DEFAULT '',
    ref TEXT NOT NULL DEFAULT '',
    artist TEXT NOT NULL DEFAULT '',
    title TEXT NOT NULL DEFAULT '',
    created_ms INTEGER NOT NULL,
    PRIMARY KEY (user, kind, key)
);

-- История поиска «Музыки»: 30 последних разных запросов человека
CREATE TABLE IF NOT EXISTS search_history (
    user TEXT NOT NULL,
    query_key TEXT NOT NULL,
    query TEXT NOT NULL,
    searched_ms INTEGER NOT NULL,
    PRIMARY KEY (user, query_key)
);
