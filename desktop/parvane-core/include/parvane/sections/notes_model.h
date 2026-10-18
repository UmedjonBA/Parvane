// Parvane fork (spec 029, фаза 4): заметки «Знаний» — порт web `components/parvane/notes/notesModel.ts`.
// Чистые функции над текстом `.md`: свойства (YAML в начале файла), ссылки `[[…]]`, теги, пункты `- [ ]` с метками
// `^t…`, указатель связей и поиск, переименование ссылок. Без сети, хранилища и UI. Заметку для ссылок определяет
// название (имя файла без `.md`): без учёта регистра и крайних пробелов. Строки — UTF-8; номера строк — с нуля;
// позиции ссылок в строке (`NoteLineLink::from/to`) — в БАЙТАХ UTF-8 (в web — в единицах UTF-16).
#pragma once

#include <cstdint>
#include <functional>
#include <map>
#include <optional>
#include <string>
#include <utility>
#include <vector>

namespace parvane::sections::notes {

// Значение свойства: строка либо список строк
struct PropertyValue {
    bool isList = false;
    std::string scalar;
    std::vector<std::string> list;

    static PropertyValue text(std::string value) { return PropertyValue{false, std::move(value), {}}; }
    static PropertyValue items(std::vector<std::string> values) { return PropertyValue{true, {}, std::move(values)}; }
    bool operator==(const PropertyValue &) const = default;
};

// Свойства в порядке появления (как ключи объекта JS); повторный ключ заменяет значение на прежнем месте
struct NoteProperties {
    std::vector<std::pair<std::string, PropertyValue>> entries;

    void set(const std::string &key, PropertyValue value);
    const PropertyValue *get(const std::string &key) const;
    bool empty() const { return entries.empty(); }
    // Сравнение без учёта порядка — как `toEqual` для объекта
    bool operator==(const NoteProperties &other) const;
};

struct NoteTask {
    // Номер строки в полном тексте заметки, с нуля (свойства в начале файла тоже считаются)
    int line = 0;
    bool isDone = false;
    // Текст пункта без галочки и без метки
    std::string text;
    // Метка связи с задачей плана без `^`: `t7f3a`
    std::optional<std::string> marker;
    bool operator==(const NoteTask &) const = default;
};

struct ParsedNote {
    NoteProperties properties;
    std::string body;
    std::vector<std::string> links;
    std::vector<std::string> tags;
    std::vector<NoteTask> tasks;
    std::string preview;
};

struct NoteSource {
    std::string id;
    std::string title;
    std::string folder;
    std::string text;
    double updatedAt = 0;
};

struct IndexedNote : NoteSource {
    ParsedNote parsed;
    // Заметки, на которые ведут ссылки (без самой заметки), в порядке появления
    std::vector<std::string> linkedIds;
    // Названия из ссылок, для которых заметки ещё нет
    std::vector<std::string> unresolved;
};

struct UnresolvedTitle {
    std::string title;
    std::vector<std::string> fromIds;
    bool operator==(const UnresolvedTitle &) const = default;
};

struct TagCount {
    std::string tag;
    int count = 0;
    bool operator==(const TagCount &) const = default;
};

// Указатель заметок (в web — объект с замыканиями). Указатели на заметки живут, пока жив указатель
class NotesIndex {
public:
    explicit NotesIndex(const std::vector<NoteSource> &sources);

    const std::vector<IndexedNote> &notes() const { return notes_; }
    const IndexedNote *byId(const std::string &noteId) const;
    const IndexedNote *byTitle(const std::string &title) const;
    std::vector<const IndexedNote *> backlinks(const std::string &noteId) const;
    // Заметки, которых ещё нет: название, как в первой ссылке, и кто на него ссылается
    const std::vector<UnresolvedTitle> &unresolved() const { return unresolved_; }
    const std::vector<TagCount> &tags() const { return tags_; }
    std::vector<const IndexedNote *> search(const std::string &query) const;

private:
    std::vector<IndexedNote> notes_;
    std::map<std::string, std::string> idByTitle_;
    std::map<std::string, size_t> indexById_;
    std::map<std::string, std::vector<size_t>> backlinks_;
    std::vector<UnresolvedTitle> unresolved_;
    std::vector<TagCount> tags_;
    std::vector<std::pair<std::string, std::string>> haystacks_;
};

struct TaskMarkerChange {
    int line = 0;
    std::string oldMarker;
    std::string newMarker;
    bool operator==(const TaskMarkerChange &) const = default;
};

struct EnsureMarkerResult {
    std::string text;
    std::optional<std::string> marker;
    bool operator==(const EnsureMarkerResult &) const = default;
};

struct DedupeMarkersResult {
    std::string text;
    std::vector<TaskMarkerChange> changes;
    bool operator==(const DedupeMarkersResult &) const = default;
};

struct NoteLineLink {
    std::string target;
    std::optional<std::string> alias;
    // Байты UTF-8 в строке
    size_t from = 0;
    size_t to = 0;
};

struct NoteLines {
    // Строки полного текста (разрез по `\n`; `\r` в конце строки остаётся)
    std::vector<std::string> lines;
    // Строка, где ссылки не разбираются: свойства в начале файла и блок кода
    std::vector<bool> skipped;
    // Ссылки строки с позициями в ней; код в строке ссылкой не считается
    std::vector<std::vector<NoteLineLink>> links;
};

using MakeId = std::function<std::string()>;

inline constexpr int kPreviewLength = 140;
inline constexpr int kMarkerIdLength = 5;
inline constexpr int kMarkerAttempts = 50;

ParsedNote parseNote(const std::string &text);
std::string serializeNote(const NoteProperties &properties, const std::string &body);
/** Название заметки как ключ сравнения: ссылки и имена файлов сверяются по нему */
std::string normalizeNoteTitle(const std::string &title);
/** Текст для поиска: без регистра, «ё» = «е», число кодовых точек сохранено */
std::string noteSearchText(const std::string &text);

std::string setTaskDone(const std::string &text, int line, bool isDone);
/** Ставит пункту метку ` ^t<id>`, если её ещё нет. Строка без пункта — текст прежний, метки нет */
EnsureMarkerResult ensureTaskMarker(const std::string &text, int line, const MakeId &makeId);
std::optional<int> findTaskLine(const std::string &text, const std::string &marker);
std::string removeTaskLine(const std::string &text, const std::string &marker);
/** Скопированный пункт несёт чужую метку: первая строка её сохраняет, копии получают новые */
DedupeMarkersResult dedupeTaskMarkers(const std::string &text, const MakeId &makeId);
// Случайный id метки, как `Math.random().toString(36)` web: 5 знаков [a-z0-9]. Логика берёт генератор параметром;
// этот — для вызывающего UI
std::string makeRandomMarkerId();

/** Перенацеливает `[[Старое]]` и `[[Старое|подпись]]` на новое название; код не трогает */
std::string renameLinks(const std::string &text, const std::string &oldTitle, const std::string &newTitle);
/** Текст заметки построчно — для правки ссылок на месте: где они стоят и какие строки разбору не подлежат */
NoteLines scanNoteLines(const std::string &text);

/** Название ежедневной заметки — сам ключ дня `YYYY-MM-DD` */
std::string dailyNoteTitle(const std::string &day);
std::string dailyNoteTemplate(const std::string &day);

} // namespace parvane::sections::notes
