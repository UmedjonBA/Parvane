// Parvane fork: статичная карта для пузыря геолокации — геометрия Web Mercator
// и клиент OSM-тайлов через шард preview (`preview.map.tile`). Без Qt: склейку
// в картинку делает клиент (tdesktop — QImage), здесь только математика,
// запросы, кэш. Порт web/telegram-tt/src/api/parvane/media.ts
// (fetchTile/renderStaticMap) 1:1 — центр и зум на всех клиентах совпадают.
// Правило conformance MAP-1: наружу к картографическим хостам клиент не ходит.
#pragma once

#include <cstdint>
#include <memory>
#include <string>
#include <vector>

#include "parvane/itransport.h"

namespace parvane::map {

constexpr int kTileSize = 256;
// Зум статичной карты — как DEFAULT_MAP_CONFIG.zoom в web Location.tsx.
// Штатный tdesktop просит z13; берём зум веба, чтобы карты совпадали.
constexpr int kDefaultZoom = 16;
constexpr int kMaxZoom = 19;          // TILE_MAX_ZOOM шарда preview
constexpr int kTileCacheLimit = 200;  // TILE_CACHE_LIMIT web
constexpr int kTileTimeoutMs = 15000; // MAP_TILE_TIMEOUT_MS web (холодный тайл > 3 с)
constexpr int kTileRetryMs = 1500;    // MAP_TILE_RETRY_MS web
constexpr int kTileAttempts = 2;      // две попытки на тайл, как в web

struct TileKey {
    std::uint32_t z = 0;
    std::uint32_t x = 0;
    std::uint32_t y = 0;
    // "z/x/y" — тот же ключ, что в серверном кэше map_tiles.tile_key
    std::string str() const;
    bool operator==(const TileKey &o) const { return z == o.z && x == o.x && y == o.y; }
};

// Куда рисовать тайл на канвасе (в пикселях канваса, уже с учётом scale).
// dstX считается по НЕобёрнутому tx, поэтому у границы даты тайл с x=0
// может лечь правее тайла с x=n-1 — так же, как в web.
struct TilePlacement {
    TileKey key;
    int dstX = 0;
    int dstY = 0;
    int dstSize = 0;
};

struct Geometry {
    int zoom = kDefaultZoom;
    int width = 0;   // логические px
    int height = 0;
    double scale = 1; // DPR/масштаб, [1, 3]
    double centerX = 0; // центр в «тайловых пикселях» уровня zoom
    double centerY = 0;
    double left = 0;
    double top = 0;
    std::vector<TilePlacement> tiles;

    int canvasWidth() const;  // round(width * scale)
    int canvasHeight() const; // round(height * scale)
};

// Порт renderStaticMap: clamp zoom [0, kMaxZoom], scale [1, 3], lat ±85.05;
// покрытие tx/ty по floor, ty вне [0, 2^z) пропускается, x оборачивается.
// Ширина/высота ≤ 0 → пустая геометрия (tiles пуст).
Geometry computeGeometry(double lat, double lon, int zoom, int width, int height,
                         double scale);

// Клиент тайлов: LRU-кэш PNG-байт (≤ kTileCacheLimit), дедуп одновременных
// запросов одного ключа, ограничение параллельности, две попытки с паузой.
// fetch блокирующий — звать с воркера. Транспорт не хранится: владелец
// снимает его на момент запроса (у tdesktop транспорт живёт в сессии и может
// смениться). Пустой результат = не получилось (в кэш не кладётся, следующая
// карта попробует снова).
class TileClient {
public:
    TileClient();
    ~TileClient();

    TileClient(const TileClient &) = delete;
    TileClient &operator=(const TileClient &) = delete;

    // fromCache (необязательно): true — байты взяты из LRU или от параллельного
    // запроса того же ключа, к шарду этот вызов не ходил (SC-005: ≤ 1 запрос
    // на уникальный тайл за жизнь клиента).
    std::vector<std::uint8_t> fetch(ITransport &transport, const TileKey &key,
                                    const std::string &self, const std::string &token,
                                    bool *fromCache = nullptr);

    void setConcurrencyLimit(int n); // по умолчанию 8 (gateway: 20 req/s)
    std::size_t cachedCount() const;
    std::size_t requestCount() const; // реальных обращений к шарду (с повторами)
    void clear();

private:
    struct Impl;
    std::unique_ptr<Impl> impl_;
};

} // namespace parvane::map
