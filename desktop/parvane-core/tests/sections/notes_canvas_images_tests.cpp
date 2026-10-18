// Parvane fork (spec 029, фаза 4): перенос 1:1 web `notes/notesCanvasImages.test.ts`. Обещания web заменены
// обратными вызовами: «медленная» загрузка запоминает `done` и отвечает, когда тест скажет.
#include <map>
#include <memory>

#include "notes_test_util.h"
#include "parvane/sections/notes_canvas_images.h"

using namespace parvane::sections;
using namespace parvane::sections::notes;

static cloud::CloudNode file(const std::string &name, const std::string &mime, int64_t size, bool hasThumb = true) {
    auto node = cloudNode("f", name);
    node.mime = mime;
    node.size = size;
    node.blob = nlohmann::json{{"fileId", "f"}, {"key", "k"}, {"nonce", "n"}, {"capability", "c"}, {"size", 1}};
    if (hasThumb) node.thumb = nlohmann::json{{"fileId", "t"}, {"nonce", "n"}, {"capability", "c"}, {"width", 320}, {"height", 240}};
    return node;
}

struct Timer {
    std::function<void()> run;
    bool isCleared = false;
};

struct Setup {
    std::vector<Timer> timers;
    std::vector<std::string> revoked;
    int count = 0;
    std::unique_ptr<CanvasImageCache> cache;

    explicit Setup(std::optional<int> maxLoads = std::nullopt, std::optional<int64_t> maxBytes = std::nullopt) {
        CanvasImageCacheDeps deps;
        deps.createUrl = [this](const CanvasImageBlob &) { return "blob:" + std::to_string(++count); };
        deps.revokeUrl = [this](const std::string &url) { revoked.push_back(url); };
        deps.setTimer = [this](std::function<void()> run, int64_t) {
            timers.push_back({std::move(run)});
            return static_cast<CanvasTimerId>(timers.size() - 1);
        };
        deps.clearTimer = [this](CanvasTimerId id) { timers[id].isCleared = true; };
        deps.keepMs = 100;
        deps.maxLoads = maxLoads;
        deps.maxBytes = maxBytes;
        cache = std::make_unique<CanvasImageCache>(deps);
    }

    // Срок вышел: срабатывают таймеры, которые не отменены
    void expire() {
        auto list = timers;
        for (auto &t : timers) t.isCleared = true;
        for (const auto &t : list) {
            if (!t.isCleared) t.run();
        }
    }

    std::optional<std::string> acquire(const std::string &key, const CanvasImageLoad &load) {
        std::optional<std::string> got = std::string("<ждёт>");
        cache->acquire(key, load, [&got](std::optional<std::string> url) { got = url; });
        return got;
    }
};

static CanvasImageLoad blobOf(int64_t size = 1, int *loads = nullptr) {
    return [size, loads](CanvasImageDone done) {
        if (loads) ++*loads;
        done(CanvasImageBlob{size, nullptr});
    };
}

static void testSource() {
    std::printf("холст: откуда карточка берёт картинку\n");
    const auto jpg = file("фото.jpg", "image/jpeg", 5000000);
    const auto png = file("снимок.PNG", "", 5000000);
    check(canvasImageSource(&jpg, CanvasImageQuality::Full) == CanvasImageSource::Full
              && canvasImageSource(&png, CanvasImageQuality::Full) == CanvasImageSource::Full,
          "по умолчанию — сам файл, а не миниатюра");
    check(canvasImageSource(&jpg, CanvasImageQuality::Thumb) == CanvasImageSource::Thumb, "настройка «миниатюрами» оставляет миниатюру");
    const auto bare = file("фото.jpg", "image/jpeg", 5000, false);
    check(canvasImageSource(&bare, CanvasImageQuality::Full) == CanvasImageSource::Full
              && canvasImageSource(&bare, CanvasImageQuality::Thumb) == CanvasImageSource::None,
          "картинка без миниатюры в полном качестве видна, миниатюрами — значок");
    const auto big = file("карта.png", "image/png", kCanvasImageMaxBytes + 1);
    const auto edge = file("карта.png", "image/png", kCanvasImageMaxBytes);
    check(canvasImageSource(&big, CanvasImageQuality::Full) == CanvasImageSource::Thumb
              && canvasImageSource(&edge, CanvasImageQuality::Full) == CanvasImageSource::Full,
          "слишком большая картинка остаётся миниатюрой");
    const auto pdf = file("отчёт.pdf", "application/pdf", 5000);
    const auto svg = file("схема.svg", "image/svg+xml", 5000, false);
    check(canvasImageSource(&pdf, CanvasImageQuality::Full) == CanvasImageSource::Thumb
              && canvasImageSource(&svg, CanvasImageQuality::Full) == CanvasImageSource::None
              && canvasImageSource(nullptr, CanvasImageQuality::Full) == CanvasImageSource::None
              && !isCanvasImage("text/markdown", "заметка.md"),
          "не картинка и файл без содержимого целиком не читаются");
}

static void testCache() {
    std::printf("холст: адреса картинок в полном качестве\n");
    {
        Setup s;
        int loads = 0;
        const auto a = s.acquire("a", blobOf(1, &loads));
        const auto b = s.acquire("a", blobOf(1, &loads));
        const auto c = s.acquire("a", blobOf(1, &loads));
        check(a == std::optional<std::string>("blob:1") && b == a && c == a && loads == 1,
              "файл читается один раз, сколько бы карточек и перерисовок его ни просило");
    }
    {
        Setup s;
        s.acquire("a", blobOf());
        s.acquire("a", blobOf());
        s.cache->release("a");
        s.expire();
        const bool firstKept = s.revoked.empty();
        s.cache->release("a");
        const bool secondKept = s.revoked.empty();
        s.expire();
        check(firstKept && secondKept && s.revoked == std::vector<std::string>{"blob:1"} && s.cache->size() == 0,
              "адрес освобождается, когда карточек не осталось и срок вышел");
    }
    {
        Setup s;
        int loads = 0;
        s.acquire("a", blobOf(1, &loads));
        s.cache->release("a");
        const auto again = s.acquire("a", blobOf(1, &loads));
        s.expire();
        check(again == std::optional<std::string>("blob:1") && s.revoked.empty() && loads == 1,
              "карточка, вернувшаяся до срока, получает прежний адрес без чтения");
    }
    {
        Setup s;
        s.acquire("a", blobOf());
        s.cache->release("a");
        s.expire();
        check(s.acquire("a", blobOf()) == std::optional<std::string>("blob:2"), "после освобождения файл читается заново и получает новый адрес");
    }
    {
        Setup s;
        s.acquire("a", blobOf());
        s.cache->release("b");
        s.expire();
        check(s.revoked.empty() && s.cache->size() == 1, "лишнее освобождение чужую карточку адреса не лишает");
    }
    {
        Setup s;
        const auto failed = s.acquire("a", [](CanvasImageDone done) { done(std::nullopt); });
        s.cache->release("a");
        const auto empty = s.acquire("a", [](CanvasImageDone done) { done(std::nullopt); });
        s.cache->release("a");
        check(!failed && !empty && s.acquire("a", blobOf()) == std::optional<std::string>("blob:1"),
              "непрочитанный файл не запоминается: следующая попытка читает снова");
    }
    {
        Setup s;
        CanvasImageDone finish;
        std::optional<std::string> got = std::string("<ждёт>");
        s.cache->acquire("a", [&finish](CanvasImageDone done) { finish = done; }, [&got](std::optional<std::string> url) { got = url; });
        s.cache->release("a");
        s.expire();
        finish(CanvasImageBlob{1, nullptr});
        check(!got && s.revoked.empty() && s.cache->size() == 0, "карточка ушла, пока файл читался: адрес не создаётся");
    }
    {
        Setup s(2);
        std::vector<std::string> started;
        std::map<std::string, CanvasImageDone> finish;
        std::map<std::string, std::optional<std::string>> urls;
        for (const std::string key : {"a", "b", "c", "d"}) {
            urls[key] = std::string("<ждёт>");
            s.cache->acquire(
                key,
                [&, key](CanvasImageDone done) {
                    started.push_back(key);
                    finish[key] = done;
                },
                [&, key](std::optional<std::string> url) { urls[key] = url; });
        }
        bool ok = started == std::vector<std::string>{"a", "b"} && s.cache->pending() == 4;
        finish["a"](CanvasImageBlob{1, nullptr});
        ok = ok && started == std::vector<std::string>{"a", "b", "c"};
        finish["b"](CanvasImageBlob{1, nullptr});
        finish["c"](CanvasImageBlob{1, nullptr});
        ok = ok && started == std::vector<std::string>{"a", "b", "c", "d"};
        finish["d"](CanvasImageBlob{1, nullptr});
        ok = ok && urls["a"] == std::optional<std::string>("blob:1") && urls["b"] == std::optional<std::string>("blob:2")
            && urls["c"] == std::optional<std::string>("blob:3") && urls["d"] == std::optional<std::string>("blob:4")
            && s.cache->pending() == 0;
        check(ok, "читается не больше заданного числа файлов разом, остальные ждут своей очереди");
    }
    {
        Setup s(std::nullopt, 10);
        s.acquire("a", blobOf(4));
        s.acquire("b", blobOf(4));
        bool ok = s.cache->bytes() == 8;
        s.cache->release("a");
        s.cache->release("b");
        s.acquire("c", blobOf(4));
        ok = ok && s.revoked == std::vector<std::string>{"blob:1"} && s.cache->bytes() == 8 && s.cache->size() == 2;
        s.acquire("d", blobOf(6));
        ok = ok && s.revoked == std::vector<std::string>{"blob:1", "blob:2"} && s.cache->bytes() == 10;
        s.acquire("e", blobOf(6));
        ok = ok && s.revoked == std::vector<std::string>{"blob:1", "blob:2"} && s.cache->bytes() == 16 && s.cache->size() == 3;
        check(ok, "память сверх предела освобождают адреса без карточек, давно свободные первыми; занятые остаются");
    }
}

int main() {
    testSource();
    testCache();
    return finish();
}
