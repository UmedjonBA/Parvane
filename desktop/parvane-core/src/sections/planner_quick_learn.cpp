// Parvane fork (spec 029, T061): реализация planner_quick_learn.h — порт web `plannerQuickLearn.ts`.
#include "parvane/sections/planner_quick_learn.h"

#include <algorithm>

#include "planner_quick_text.h"

namespace parvane::sections::planner {
namespace {

// Потолок слова в данных «Плана» — в байтах UTF-8 (схема `LearnedWord.id`)
constexpr size_t kMaxHeadBytes = 64;

bool isLearnedKind(const std::string &kind) {
    return kind == "task" || kind == "event";
}

// Счётчик после правки: `value` — что выбрал пользователь, `base` — что разбор дал бы сам. `same` — результат —
// тот же объект, что `entry` (в web сравнение `===`)
template <typename T>
struct Corrected {
    std::optional<LearnCounted<T>> value;
    bool same = false;
};

template <typename T>
Corrected<T> correct(const std::optional<LearnCounted<T>> &entry, const T &value, const T &base) {
    if (!entry) {
        if (value != base) return {LearnCounted<T>{value, 1}, false};
        return {std::nullopt, true};
    }
    if (value == entry->value) {
        if (value != base) return {LearnCounted<T>{value, std::min(entry->count + 1, kLearnMaxCount)}, false};
        return {entry, true};
    }
    if (entry->count > 1) return {LearnCounted<T>{entry->value, entry->count - 1}, false};
    if (value != base) return {LearnCounted<T>{value, 1}, false};
    return {std::nullopt, false};
}

bool contains(const std::optional<std::vector<std::string>> &list, const std::string &item) {
    return list && std::find(list->begin(), list->end(), item) != list->end();
}

LearnStore trim(LearnStore store) {
    if (store.heads.size() <= kLearnMaxHeads) return store;
    std::vector<std::string> names;
    names.reserve(store.heads.size());
    for (const auto &[name, head] : store.heads) names.push_back(name);
    std::stable_sort(names.begin(), names.end(), [&](const std::string &a, const std::string &b) {
        return store.heads.at(b).at < store.heads.at(a).at;
    });
    names.resize(kLearnMaxHeads);
    LearnStore out;
    out.tick = store.tick;
    for (const auto &name : names) out.heads[name] = store.heads.at(name);
    return out;
}

// Движок принимает слово строчными буквами, без пробелов, не длиннее 64 байт
bool isSyncedHead(const std::string &head) {
    const auto text16 = text::fromUtf8(head);
    if (text::jsLower(text16) != text16) return false;
    for (const char16_t c : text16) {
        if (text::isJsSpace(c)) return false;
    }
    return head.size() <= kMaxHeadBytes;
}

} // namespace

LearnResult recordCorrection(const LearnStore &store, const QuickDraft &autoDraft, const QuickDraft &final) {
    LearnResult unchanged{store, false};
    if (!final.head || final.error || !isLearnedKind(final.kind)) return unchanged;
    const auto &headName = *final.head;
    const auto it = store.heads.find(headName);
    const LearnHead *known = it == store.heads.end() ? nullptr : &it->second;
    auto kind = known ? known->kind : std::nullopt;
    auto minutes = known ? known->minutes : std::nullopt;
    bool kindSame = true;
    bool minutesSame = true;

    if (isLearnedKind(autoDraft.kind) && !contains(final.learned, "kind")) {
        const bool isRejected = kind && kind->count >= kLearnThreshold && final.kind != kind->value;
        // Тип совпал с выбором разбора: это правка, только если отвергнуто выученное
        if (final.kind != autoDraft.kind || isRejected) {
            auto result = correct<std::string>(kind, final.kind, autoDraft.kind);
            kind = result.value;
            kindSame = result.same;
        }
    }

    if (final.kind == "event" && final.start && final.usualMinutes && !contains(final.learned, "minutes")) {
        if (final.minutes) {
            auto result = correct<double>(minutes, *final.minutes, *final.usualMinutes);
            minutes = result.value;
            minutesSame = result.same;
        } else if (minutes && minutes->count >= kLearnThreshold && minutes->value != *final.usualMinutes) {
            // Выученная длительность снята чипом: событие добавлено с обычной
            auto result = correct<double>(minutes, *final.usualMinutes, *final.usualMinutes);
            minutes = result.value;
            minutesSame = result.same;
        }
    }

    if (kindSame && minutesSame) return unchanged;
    LearnStore next;
    next.tick = store.tick + 1;
    next.heads = store.heads;
    if (kind || minutes) {
        next.heads[headName] = LearnHead{kind, minutes, next.tick};
    } else {
        next.heads.erase(headName);
    }
    return {trim(std::move(next)), true};
}

QuickLearned learnedDefaults(const LearnStore &store) {
    QuickLearned result;
    for (const auto &[name, head] : store.heads) {
        QuickLearnedEntry entry;
        if (head.kind && head.kind->count >= kLearnThreshold) entry.kind = head.kind->value;
        if (head.minutes && head.minutes->count >= kLearnThreshold) entry.minutes = head.minutes->value;
        if (entry.kind || entry.minutes) result[name] = entry;
    }
    return result;
}

LearnStore learnStoreFromWords(const std::vector<LearnedWord> &words) {
    LearnStore store;
    for (const auto &word : words) {
        LearnHead head;
        if (word.kind && !word.kind->empty() && word.kindCount > 0) {
            head.kind = LearnCounted<std::string>{*word.kind, std::min(word.kindCount, kLearnMaxCount)};
        }
        if (word.minutes && word.minutesCount > 0) {
            head.minutes = LearnCounted<double>{double(*word.minutes), std::min(word.minutesCount, kLearnMaxCount)};
        }
        if (!head.kind && !head.minutes) continue;
        head.at = word.touched;
        store.heads[word.id] = head;
        store.tick = std::max(store.tick, word.touched);
    }
    return trim(std::move(store));
}

std::vector<LearnedWord> learnStoreToWords(const LearnStore &store) {
    std::vector<LearnedWord> words;
    // Ключи std::map уже по алфавиту (байты UTF-8 — тот же порядок, что `sort()` web для этих слов)
    for (const auto &[name, ignored] : trim(store).heads) {
        const auto &head = store.heads.at(name);
        // Длительность короче пяти минут движок не хранит (как оценку задачи)
        const auto minutes = head.minutes && head.minutes->value >= kMinTaskMinutes ? head.minutes : std::nullopt;
        if (!isSyncedHead(name) || (!head.kind && !minutes)) continue;
        LearnedWord word;
        word.id = name;
        if (head.kind) word.kind = head.kind->value;
        word.kindCount = head.kind ? head.kind->count : 0;
        if (minutes) word.minutes = int(minutes->value);
        word.minutesCount = minutes ? minutes->count : 0;
        word.touched = head.at;
        words.push_back(word);
    }
    return words;
}

bool hasLearned(const LearnStore &store) {
    return !store.heads.empty();
}

std::optional<std::vector<LearnedWord>> correctWords(const std::vector<LearnedWord> &words,
                                                     const QuickDraft &autoDraft, const QuickDraft &final) {
    const auto base = learnStoreFromWords(words);
    const auto corrected = recordCorrection(base, autoDraft, final);
    if (!corrected.changed) return std::nullopt;
    return learnStoreToWords(corrected.store);
}

} // namespace parvane::sections::planner
