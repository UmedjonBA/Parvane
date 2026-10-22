// Parvane fork: геометрия статичной карты и клиент тайлов через preview.map.tile.
// Математика — порт web media.ts renderStaticMap/fetchTile; см. map_tiles.h.
#include "parvane/map_tiles.h"

#include <algorithm>
#include <array>
#include <chrono>
#include <cmath>
#include <condition_variable>
#include <cstdio>
#include <list>
#include <mutex>
#include <thread>
#include <unordered_map>

#include <nlohmann/json.hpp>


namespace parvane::map {

namespace {

constexpr double kPi = 3.14159265358979323846;
constexpr double kMaxLat = 85.05; // предел Web Mercator, как в web

// base64 → байты (тот же алфавит, что у шарда: base64 стандартный с '=')

} // namespace

std::string TileKey::str() const {
    char buf[48];
    std::snprintf(buf, sizeof(buf), "%u/%u/%u", z, x, y);
    return std::string(buf);
}

int Geometry::canvasWidth() const {
    return static_cast<int>(std::lround(width * scale));
}

int Geometry::canvasHeight() const {
    return static_cast<int>(std::lround(height * scale));
}

Geometry computeGeometry(double lat, double lon, int zoom, int width, int height,
                         double scale) {
    Geometry g;
    g.zoom = std::min(kMaxZoom, std::max(0, zoom));
    g.width = width;
    g.height = height;
    g.scale = std::min(3.0, std::max(1.0, scale));
    if (width <= 0 || height <= 0 || !std::isfinite(lat) || !std::isfinite(lon)) {
        g.width = std::max(0, width);
        g.height = std::max(0, height);
        return g;
    }
    // Долгота из сообщения может быть любой (1e300): к [-180, 180], иначе центр вне int64 и перебор тайлов —
    // неопределённое поведение (ревью 21 окт 2026)
    lon = std::remainder(lon, 360.0);
    // Web Mercator: центр в «тайловых пикселях» уровня zoom (как в web)
    const double n = std::ldexp(1.0, g.zoom); // 2^zoom
    const double latRad = std::max(-kMaxLat, std::min(kMaxLat, lat)) * kPi / 180.0;
    g.centerX = ((lon + 180.0) / 360.0) * n * kTileSize;
    g.centerY = ((1.0 - std::log(std::tan(latRad) + 1.0 / std::cos(latRad)) / kPi) / 2.0)
        * n * kTileSize;
    g.left = g.centerX - width / 2.0;
    g.top = g.centerY - height / 2.0;

    const auto ni = static_cast<std::int64_t>(n);
    const auto txFrom = static_cast<std::int64_t>(std::floor(g.left / kTileSize));
    const auto txTo = static_cast<std::int64_t>(std::floor((g.left + width) / kTileSize));
    const auto tyFrom = static_cast<std::int64_t>(std::floor(g.top / kTileSize));
    const auto tyTo = static_cast<std::int64_t>(std::floor((g.top + height) / kTileSize));
    const auto dstSize = static_cast<int>(std::ceil(kTileSize * g.scale));
    for (auto tx = txFrom; tx <= txTo; ++tx) {
        for (auto ty = tyFrom; ty <= tyTo; ++ty) {
            if (ty < 0 || ty >= ni) continue; // по вертикали не оборачиваем
            const auto wrappedX = ((tx % ni) + ni) % ni;
            TilePlacement p;
            p.key.z = static_cast<std::uint32_t>(g.zoom);
            p.key.x = static_cast<std::uint32_t>(wrappedX);
            p.key.y = static_cast<std::uint32_t>(ty);
            p.dstX = static_cast<int>(std::lround((tx * kTileSize - g.left) * g.scale));
            p.dstY = static_cast<int>(std::lround((ty * kTileSize - g.top) * g.scale));
            p.dstSize = dstSize;
            g.tiles.push_back(p);
        }
    }
    return g;
}

// ── TileClient ───────────────────────────────────────────────────────────────

struct TileClient::Impl {
    mutable std::mutex mu;
    std::condition_variable cv;
    // LRU: список ключей по свежести вставки + карта ключ → (итератор, байты)
    std::list<std::string> order;
    std::unordered_map<std::string,
        std::pair<std::list<std::string>::iterator, std::vector<std::uint8_t>>> cache;
    // ключи, которые сейчас качает другой поток — ждём их, а не дублируем
    std::unordered_map<std::string, int> inflight;
    int limit = 8;
    int active = 0;
    std::size_t requests = 0; // обращений к шарду (каждая попытка)

    // Один запрос к шарду; пустой вектор при любой ошибке.
    std::vector<std::uint8_t> requestOnce(const TileClient::Fetcher &fetcher, const TileKey &key) {
        try {
            const auto png = fetcher(key);
            return std::vector<std::uint8_t>(png.begin(), png.end());
        } catch (const std::exception &) {
            return {};
        }
    }

    void remember(const std::string &k, std::vector<std::uint8_t> png) {
        // под mu
        while (!order.empty() && static_cast<int>(cache.size()) >= kTileCacheLimit) {
            const auto oldest = order.back();
            order.pop_back();
            cache.erase(oldest);
        }
        order.push_front(k);
        cache[k] = { order.begin(), std::move(png) };
    }
};

TileClient::TileClient() : impl_(std::make_unique<Impl>()) {
}

TileClient::~TileClient() = default;

std::vector<std::uint8_t> TileClient::fetch(const Fetcher &fetcher, const TileKey &key, bool *fromCache) {
    auto &d = *impl_;
    const auto k = key.str();
    if (fromCache) {
        *fromCache = false;
    }
    {
        std::unique_lock<std::mutex> lk(d.mu);
        for (;;) {
            if (const auto it = d.cache.find(k); it != d.cache.end()) {
                // поднять в голову LRU
                d.order.erase(it->second.first);
                d.order.push_front(k);
                it->second.first = d.order.begin();
                if (fromCache) {
                    *fromCache = true;
                }
                return it->second.second;
            }
            if (d.inflight.count(k)) {
                d.cv.wait(lk); // другой поток качает этот же тайл
                continue;
            }
            if (d.active >= d.limit) {
                d.cv.wait(lk);
                continue;
            }
            d.inflight[k] = 1;
            ++d.active;
            break;
        }
    }
    std::vector<std::uint8_t> png;
    for (int attempt = 0; attempt < kTileAttempts && png.empty(); ++attempt) {
        if (attempt > 0) {
            std::this_thread::sleep_for(std::chrono::milliseconds(kTileRetryMs));
        }
        {
            std::lock_guard<std::mutex> lk(d.mu);
            ++d.requests;
        }
        png = d.requestOnce(fetcher, key);
    }
    {
        std::lock_guard<std::mutex> lk(d.mu);
        d.inflight.erase(k);
        --d.active;
        if (!png.empty()) {
            d.remember(k, png);
        }
    }
    d.cv.notify_all();
    return png;
}

void TileClient::setConcurrencyLimit(int n) {
    std::lock_guard<std::mutex> lk(impl_->mu);
    impl_->limit = std::max(1, n);
    impl_->cv.notify_all();
}

std::size_t TileClient::cachedCount() const {
    std::lock_guard<std::mutex> lk(impl_->mu);
    return impl_->cache.size();
}

std::size_t TileClient::requestCount() const {
    std::lock_guard<std::mutex> lk(impl_->mu);
    return impl_->requests;
}

void TileClient::clear() {
    std::lock_guard<std::mutex> lk(impl_->mu);
    impl_->cache.clear();
    impl_->order.clear();
}

} // namespace parvane::map
