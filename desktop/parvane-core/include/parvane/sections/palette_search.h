// Parvane fork (spec 029, фаза 4): общий поиск (палитра Ctrl+K) — порт web
// `components/parvane/palette/paletteSearch.ts` и `paletteKeys.ts`: что и в каком порядке показать по запросу,
// и какие клавиши открывают палитру. Чистые функции без UI.
//
// Позиции и длины — в КОДОВЫХ ТОЧКАХ строки UTF-8 (в web — кодовые единицы UTF-16; для знаков вне BMP, эмодзи,
// они различаются: QString тоже считает UTF-16, при подсветке в Qt переводить индексы).
#pragma once

#include <optional>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

namespace parvane::sections::palette {

enum class PaletteGroup { Command, Chat, Note, Record };
// Порядок групп в выдаче: команды, чаты, заметки, записи
inline constexpr PaletteGroup kPaletteGroups[] = {
    PaletteGroup::Command, PaletteGroup::Chat, PaletteGroup::Note, PaletteGroup::Record};
// "command" | "chat" | "note" | "record"
const char *groupName(PaletteGroup group);

struct PaletteItem {
    // Ключ действия, уникален в пределах палитры: `nav:today`, `chat:<id>`, `note:<id>`, `task:<id>`…
    std::string key;
    PaletteGroup group = PaletteGroup::Command;
    std::string title;
    // Текст, по которому запись тоже находится (в строке показывается отрывок вокруг совпадения)
    std::optional<std::string> text;
    // Те же строки, приведённые `normalizePaletteText`, — считаются один раз при сборке записи
    std::optional<std::string> normTitle;
    std::optional<std::string> normText;
};

// Участок совпадения: начало и конец (не включая) в кодовых точках строки
using PaletteRange = std::pair<int, int>;

struct PaletteSnippet {
    std::string text;
    std::vector<PaletteRange> ranges;
};

struct PaletteResult {
    // Индекс записи во входном списке (в web — сама запись)
    size_t index = 0;
    // Совпадения в названии
    std::vector<PaletteRange> ranges;
    // Отрывок текста с совпадением — только когда название запрос целиком не объясняет
    std::optional<PaletteSnippet> snippet;
};

struct PaletteSection {
    PaletteGroup group = PaletteGroup::Command;
    std::vector<PaletteResult> results;
};

inline constexpr int kPaletteGroupLimit = 6;
// По текстам записей запрос ищется с этой длины (без пробелов)
inline constexpr int kTextMinQueryLength = 2;

// Строка для сравнения: без регистра, «ё» = «е». Число кодовых точек сохраняется
std::string normalizePaletteText(std::string_view value);

// Слова запроса (приведённые)
std::vector<std::string> splitPaletteQuery(std::string_view query);

// Запись с заранее приведёнными строками
PaletteItem withNormalized(PaletteItem item);

// Результаты по группам в порядке `kPaletteGroups`; пустые группы не возвращаются. Внутри группы — по качеству
// совпадения, при равенстве — в порядке источника. Пустой запрос показывает только команды (все)
std::vector<PaletteSection> searchPalette(const std::vector<PaletteItem> &items, std::string_view query,
    int limit = kPaletteGroupLimit);

struct PalettePart {
    std::string text;
    bool isMatch = false;
    bool operator==(const PalettePart &) const = default;
};
// Строка с участками совпадения → куски для отрисовки
std::vector<PalettePart> splitByRanges(std::string_view text, const std::vector<PaletteRange> &ranges);

// Строка, выбранная стрелкой: список замкнут в кольцо
int movePaletteIndex(int index, int delta, int count);

// --- клавиши (web paletteKeys.ts). DOM нет — цель события описывает UI ---

struct PaletteKeyTarget {
    bool isElement = false;          // false — документ/окно/нет фокуса
    std::string tagName;             // "INPUT", "TEXTAREA", "SELECT", …
    bool isContentEditable = false;  // сам узел редактируемый
    bool insideEditable = false;     // предок (или сам) — contenteditable≠false либо role="textbox"
};

struct PaletteKeyEvent {
    std::string key;  // KeyboardEvent.key
    std::string code; // KeyboardEvent.code
    bool ctrlKey = false;
    bool metaKey = false;
    bool altKey = false;
    bool shiftKey = false;
    bool isComposing = false;
    PaletteKeyTarget target;
};

// Фокус в месте, где «/» печатается: поле, список, редактируемый текст
bool isEditableTarget(const PaletteKeyTarget &target);
// «/» без модификаторов вне поля ввода; Shift не мешает
bool isPaletteSlashKey(const PaletteKeyEvent &e);
// Ctrl+K (Cmd+K); `code` — чтобы сочетание работало и в русской раскладке
bool isPaletteHotkey(const PaletteKeyEvent &e);

} // namespace parvane::sections::palette
