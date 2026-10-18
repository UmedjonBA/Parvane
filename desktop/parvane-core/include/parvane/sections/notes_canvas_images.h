// Parvane fork (spec 029, фаза 4): картинки карточек файлов на холсте «Знаний» в полном качестве — порт web
// `components/parvane/notes/notesCanvasImages.ts`. Миниатюра облака — 320 точек по длинной стороне; растянутая на
// карточку она мутная, поэтому карточка показывает сам файл. Адрес расшифрованной картинки (в web — object URL,
// на десктопе — что вернёт `createUrl`, например ключ кэша QPixmap) один на файл: его делят все карточки этого
// файла, он переживает перерисовки и освобождается, когда карточек с ним не осталось.
//
// Отличие от web: вместо обещаний — обратные вызовы. Загрузка зовёт `done` (сразу либо позже) ровно один раз;
// `acquire` сообщает адрес через `onUrl` (сразу, если адрес уже есть). Потоков здесь нет: всё зовётся из одного.
#pragma once

#include <cstdint>
#include <functional>
#include <map>
#include <memory>
#include <optional>
#include <string>
#include <vector>

#include "parvane/sections/cloud_model.h"
#include "parvane/sections/notes_prefs.h"

namespace parvane::sections::notes {

// Что показывает карточка: сам файл, миниатюру либо значок файла
enum class CanvasImageSource { Full, Thumb, None };

// Прочитанный файл: размер в байтах и непрозрачные данные для `createUrl`
struct CanvasImageBlob {
    int64_t size = 0;
    std::shared_ptr<void> data;
};

using CanvasImageDone = std::function<void(std::optional<CanvasImageBlob>)>;
using CanvasImageLoad = std::function<void(CanvasImageDone done)>;
using CanvasImageUrl = std::function<void(std::optional<std::string>)>;
using CanvasTimerId = uint64_t;

struct CanvasImageCacheDeps {
    std::function<std::string(const CanvasImageBlob &)> createUrl;
    std::function<void(const std::string &)> revokeUrl;
    std::function<CanvasTimerId(std::function<void()>, int64_t ms)> setTimer;
    std::function<void(CanvasTimerId)> clearTimer;
    // Столько адрес живёт после ухода последней карточки
    int64_t keepMs = 0;
    // Сколько файлов читается одновременно и сколько байт картинок держится разом
    std::optional<int> maxLoads;
    std::optional<int64_t> maxBytes;
};

// Картинка больше этого в карточку целиком не читается — остаётся миниатюра
inline constexpr int64_t kCanvasImageMaxBytes = 32LL * 1024 * 1024;
inline constexpr int64_t kCanvasImagesMaxBytes = 192LL * 1024 * 1024;
inline constexpr int kCanvasImageMaxLoads = 3;
// Карточка уже этого на экране показывает миниатюру: полный файл на ней не разглядеть
inline constexpr int kCanvasFullImageMinPx = 320;
// Срок жизни адреса без карточек (в web — для общего кэша `getCanvasImageCache`)
inline constexpr int64_t kCanvasImageKeepMs = 30000;

bool isCanvasImage(const std::string &mime, const std::string &name);
// Откуда карточка берёт картинку. Полное качество — у картинки не больше предела; слишком большая и любая при
// настройке «миниатюрами» показывают миниатюру, а без неё — значок файла
CanvasImageSource canvasImageSource(const cloud::CloudNode *node, CanvasImageQuality quality,
                                    int64_t maxBytes = kCanvasImageMaxBytes);

// Адреса картинок по ключу (версия содержимого файла) со счётчиком карточек
class CanvasImageCache {
public:
    explicit CanvasImageCache(CanvasImageCacheDeps deps);

    // Адрес картинки; `load` зовётся один раз на ключ, пока адрес жив. Каждому `acquire` — свой `release`
    void acquire(const std::string &key, const CanvasImageLoad &load, const CanvasImageUrl &onUrl);
    void release(const std::string &key);
    size_t size() const { return entries_.size(); }
    int64_t bytes() const { return totalBytes_; }
    // Сколько чтений идёт и ждёт
    size_t pending() const { return loading_ + waiting_.size(); }

private:
    struct Entry;
    void drop(const std::string &key, const std::shared_ptr<Entry> &entry);
    void trim();
    void next();

    CanvasImageCacheDeps deps_;
    int maxLoads_;
    int64_t maxBytes_;
    std::map<std::string, std::shared_ptr<Entry>> entries_;
    std::vector<std::function<void()>> waiting_;
    size_t loading_ = 0;
    int64_t totalBytes_ = 0;
    int64_t freedCount_ = 0;
};

} // namespace parvane::sections::notes
