// Parvane fork: тесты геометрии статичной карты (порт web renderStaticMap).
// Чистые, без backend. Сверка с web: те же формулы → те же ключи тайлов.
#include "parvane/map_tiles.h"
#include "parvane/topics.h"

#include <cmath>
#include <cstdio>
#include <set>
#include <string>

static int g_fail = 0;
static void check(bool c, const char *msg) {
    std::printf("%s %s\n", c ? "[ok]" : "[FAIL]", msg);
    if (!c) ++g_fail;
}

// Ключ тайла для точки по формулам OSM (независимая проверка центра)
static std::pair<long, long> osmTile(double lat, double lon, int z) {
    const double n = std::ldexp(1.0, z);
    const double latRad = lat * M_PI / 180.0;
    const auto x = static_cast<long>(std::floor((lon + 180.0) / 360.0 * n));
    const auto y = static_cast<long>(std::floor(
        (1.0 - std::log(std::tan(latRad) + 1.0 / std::cos(latRad)) / M_PI) / 2.0 * n));
    return { x, y };
}

// Фальшивый транспорт: отвечает валидным {ok, png_base64} на каждый запрос
// и считает обращения — проверка LRU и дедупа TileClient без стека.
struct FakeTransport : parvane::ITransport {
    int requests = 0;
    std::string request(const std::string &subject, const std::string &,
                        std::int64_t) override {
        ++requests;
        if (subject != parvane::topics::PreviewMapTile) return "{\"ok\":false}";
        return "{\"ok\":true,\"png_base64\":\"iVBORw0KGgo=\"}"; // сигнатура PNG
    }
    void publish(const std::string &, const std::string &) override {}
    void requestMany(const std::string &, const std::string &, const ReplyHandler &,
                     std::int64_t) override {}
    void subscribe(const std::string &, Handler) override {}
};

int main() {
    using namespace parvane::map;

    // Москва, размер пузыря tdesktop 320×240, scale 1
    {
        const auto g = computeGeometry(55.751244, 37.618423, kDefaultZoom, 320, 240, 1.0);
        check(g.zoom == kMaxZoom && kMaxZoom == 15,
              "Москва: запрошенный z16 срезан до 15 (P-23, паритет с web)");
        check(g.canvasWidth() == 320 && g.canvasHeight() == 240, "Москва: канвас 320x240");
        check(g.tiles.size() >= 4 && g.tiles.size() <= 9, "Москва: 2x2…3x3 тайла");
        // центр покрыт: тайл центра из независимой формулы есть в наборе
        const auto [cx, cy] = osmTile(55.751244, 37.618423, kMaxZoom);
        bool found = false;
        for (const auto &t : g.tiles) {
            if (t.key.x == static_cast<std::uint32_t>(cx)
                && t.key.y == static_cast<std::uint32_t>(cy)) {
                found = true;
                // тайл центра лежит так, что центр канваса внутри него
                const double cxPx = g.canvasWidth() / 2.0;
                const double cyPx = g.canvasHeight() / 2.0;
                check(t.dstX <= cxPx && cxPx < t.dstX + t.dstSize
                    && t.dstY <= cyPx && cyPx < t.dstY + t.dstSize,
                    "Москва: центр канваса внутри центрального тайла");
            }
        }
        check(found, "Москва: центральный тайл OSM в покрытии");
        // ключи уникальны и в формате z/x/y
        std::set<std::string> keys;
        for (const auto &t : g.tiles) keys.insert(t.key.str());
        check(keys.size() == g.tiles.size(), "Москва: ключи тайлов уникальны");
        check(g.tiles[0].key.str().rfind("15/", 0) == 0, "TileKey::str() = z/x/y");
    }

    // scale 2 (HiDPI): канвас вдвое больше, размер тайла на канвасе 512
    {
        const auto g = computeGeometry(55.751244, 37.618423, 16, 160, 120, 2.0);
        check(g.canvasWidth() == 320 && g.canvasHeight() == 240, "scale 2: канвас 320x240");
        check(!g.tiles.empty() && g.tiles[0].dstSize == 512, "scale 2: тайл 512 px на канвасе");
    }

    // Граница даты: долгота 179.999 (0,09 тайла до края на z15) — часть тайлов
    // оборачивается на x=0…
    {
        const auto g = computeGeometry(10.0, 179.999, 16, 320, 240, 1.0);
        const std::uint32_t n = 1u << kMaxZoom;
        bool allInRange = true, hasWrapped = false, hasLast = false;
        for (const auto &t : g.tiles) {
            if (t.key.x >= n) allInRange = false;
            if (t.key.x == 0) hasWrapped = true;
            if (t.key.x == n - 1) hasLast = true;
        }
        check(allInRange, "179.999: все x < 2^z (обёрнуты)");
        check(hasWrapped && hasLast, "179.999: есть тайлы x=n-1 и x=0 (переход через дату)");
        // dstX по необёрнутому tx: обёрнутый x=0 лежит правее x=n-1
        int dstLast = 0, dstWrapped = 0;
        for (const auto &t : g.tiles) {
            if (t.key.x == n - 1) dstLast = t.dstX;
            if (t.key.x == 0) dstWrapped = t.dstX;
        }
        check(dstWrapped > dstLast, "179.999: обёрнутый тайл рисуется правее (по tx)");
    }

    // Широта 80° — обычная точка, ty в диапазоне
    {
        const auto g = computeGeometry(80.0, 20.0, 16, 320, 240, 1.0);
        check(!g.tiles.empty(), "80°: покрытие есть");
        bool ok = true;
        for (const auto &t : g.tiles) if (t.key.y >= (1u << kMaxZoom)) ok = false;
        check(ok, "80°: все y < 2^z");
    }

    // Полюс: широта 89 clamp'ится до 85.05, тайлы с ty < 0 пропущены
    {
        const auto g = computeGeometry(89.0, 0.0, 2, 320, 240, 1.0);
        bool ok = true;
        for (const auto &t : g.tiles) if (t.key.y >= 4) ok = false;
        check(ok, "полюс z2: ty вне [0,4) отброшены");
        check(g.tiles.size() < 9, "полюс z2: часть вертикальных тайлов пропущена");
    }

    // clamp зума и scale
    {
        const auto g = computeGeometry(0, 0, 25, 320, 240, 7.0);
        check(g.zoom == kMaxZoom, "зум ограничен kMaxZoom");
        check(g.scale == 3.0, "scale ограничен 3");
        const auto e = computeGeometry(0, 0, 16, 0, 240, 1.0);
        check(e.tiles.empty(), "нулевая ширина → пустое покрытие");
    }

    // TileClient: SC-005 — повторный тайл из кэша, к шарду один раз; LRU ≤ 200
    {
        FakeTransport t;
        TileClient c;
        const TileKey k{ 16, 39615, 20487 };
        bool fromCache = true;
        const auto a = c.fetch(t, k, "bob@local", "tok", &fromCache);
        check(a.size() == 8 && !fromCache, "TileClient: первый fetch — реальный запрос, PNG-байты");
        const auto b = c.fetch(t, k, "bob@local", "tok", &fromCache);
        check(b == a && fromCache, "TileClient: повторный fetch — из кэша");
        check(t.requests == 1 && c.requestCount() == 1, "TileClient: к шарду один запрос на тайл");
        for (std::uint32_t i = 0; i < std::uint32_t(kTileCacheLimit) + 5; ++i) {
            c.fetch(t, TileKey{ 16, 1000 + i, 2000 }, "bob@local", "tok");
        }
        check(c.cachedCount() == std::size_t(kTileCacheLimit), "TileClient: LRU не растёт выше kTileCacheLimit");
        c.fetch(t, k, "bob@local", "tok", &fromCache);
        check(!fromCache, "TileClient: вытесненный из LRU тайл запрашивается заново");
        c.clear();
        check(c.cachedCount() == 0, "TileClient: clear() очищает кэш");
    }

    std::printf("%s\n", g_fail ? "ЕСТЬ ПРОВАЛЫ" : "все проверки прошли");
    return g_fail ? 1 : 0;
}
