// Parvane fork (spec 029, фаза 4): картинки карточек холста — порт web `notes/notesCanvasImages.ts`.
#include "parvane/sections/notes_canvas_images.h"

#include <algorithm>

namespace parvane::sections::notes {

struct CanvasImageCache::Entry {
    size_t users = 0;
    bool isResolved = false;
    std::optional<std::string> url;
    std::vector<CanvasImageUrl> waiters;
    int64_t bytes = 0;
    std::optional<CanvasTimerId> timer;
    bool isDropped = false;
    // Порядок ухода последней карточки — первым освобождается давно не нужный
    int64_t freedAt = 0;

    void resolve(const std::optional<std::string> &value) {
        isResolved = true;
        auto list = std::move(waiters);
        waiters.clear();
        for (const auto &waiter : list) {
            if (waiter) waiter(value);
        }
    }
};

bool isCanvasImage(const std::string &mime, const std::string &name) {
    return cloud::kindOfFile(mime, name) == cloud::FileKind::Photo;
}

CanvasImageSource canvasImageSource(const cloud::CloudNode *node, CanvasImageQuality quality, int64_t maxBytes) {
    if (!node || !node->blob || node->blob->is_null()) return CanvasImageSource::None;
    if (quality == CanvasImageQuality::Full && isCanvasImage(node->mime, node->name) && node->size <= maxBytes) {
        return CanvasImageSource::Full;
    }
    return node->thumb && !node->thumb->is_null() ? CanvasImageSource::Thumb : CanvasImageSource::None;
}

CanvasImageCache::CanvasImageCache(CanvasImageCacheDeps deps)
    : deps_(std::move(deps)),
      maxLoads_(std::max(1, deps_.maxLoads.value_or(kCanvasImageMaxLoads))),
      maxBytes_(deps_.maxBytes.value_or(kCanvasImagesMaxBytes)) {}

void CanvasImageCache::drop(const std::string &key, const std::shared_ptr<Entry> &entry) {
    if (const auto it = entries_.find(key); it != entries_.end() && it->second == entry) entries_.erase(it);
    if (entry->timer && deps_.clearTimer) deps_.clearTimer(*entry->timer);
    entry->timer.reset();
    entry->isDropped = true;
    totalBytes_ -= entry->bytes;
    entry->bytes = 0;
    if (entry->url && deps_.revokeUrl) deps_.revokeUrl(*entry->url);
}

// Память сверх предела: уходят адреса, у которых не осталось карточек, — давно свободные первыми
void CanvasImageCache::trim() {
    while (totalBytes_ > maxBytes_) {
        std::string oldestKey;
        std::shared_ptr<Entry> oldest;
        for (const auto &[key, entry] : entries_) {
            if (entry->users > 0 || !entry->url) continue;
            if (!oldest || entry->freedAt < oldest->freedAt) {
                oldestKey = key;
                oldest = entry;
            }
        }
        if (!oldest) return;
        drop(oldestKey, oldest);
    }
}

// Очередь чтения: не больше `maxLoads` файлов разом
void CanvasImageCache::next() {
    while (loading_ < static_cast<size_t>(maxLoads_) && !waiting_.empty()) {
        ++loading_;
        auto start = std::move(waiting_.front());
        waiting_.erase(waiting_.begin());
        start();
    }
}

void CanvasImageCache::acquire(const std::string &key, const CanvasImageLoad &load, const CanvasImageUrl &onUrl) {
    if (const auto it = entries_.find(key); it != entries_.end()) {
        auto existing = it->second;
        if (existing->timer && deps_.clearTimer) deps_.clearTimer(*existing->timer);
        existing->timer.reset();
        ++existing->users;
        if (existing->isResolved) {
            if (onUrl) onUrl(existing->url);
        } else {
            existing->waiters.push_back(onUrl);
        }
        return;
    }
    auto created = std::make_shared<Entry>();
    created->users = 1;
    created->waiters.push_back(onUrl);
    // Запись — до начала чтения: загрузка может ответить сразу
    entries_[key] = created;
    waiting_.push_back([this, key, created, load] {
        auto isDone = std::make_shared<bool>(false);
        const CanvasImageDone done = [this, key, created, isDone](std::optional<CanvasImageBlob> blob) {
            if (*isDone) return;
            *isDone = true;
            --loading_;
            std::optional<std::string> url;
            if (!blob) {
                // Не прочиталось — следующая карточка попробует снова
                if (const auto it = entries_.find(key); it != entries_.end() && it->second == created) entries_.erase(it);
            } else if (!created->isDropped) {
                created->url = deps_.createUrl ? deps_.createUrl(*blob) : std::string();
                created->bytes = blob->size;
                totalBytes_ += blob->size;
                url = created->url;
                trim();
            }
            // Все карточки ушли, пока файл читался, и срок вышел — адрес не создаётся
            created->resolve(url);
            next();
        };
        if (load) load(done);
        else done(std::nullopt);
    });
    next();
}

void CanvasImageCache::release(const std::string &key) {
    const auto it = entries_.find(key);
    if (it == entries_.end() || it->second->users == 0) return;
    auto entry = it->second;
    if (--entry->users > 0) return;
    entry->freedAt = ++freedCount_;
    if (deps_.setTimer) entry->timer = deps_.setTimer([this, key, entry] { drop(key, entry); }, deps_.keepMs);
    trim();
}

} // namespace parvane::sections::notes
