-- Кэш тайлов карты (OSM): общий, без пользовательских данных.
CREATE TABLE IF NOT EXISTS map_tiles (
    tile_key   TEXT PRIMARY KEY,
    png        BLOB NOT NULL,
    fetched_at INTEGER NOT NULL
);
