// Parvane fork (spec 029, фаза 4): холст «Знаний» в открытом формате JSON Canvas (файлы `.canvas`) — зеркало web
// `components/parvane/notes/notesCanvas.ts`. Чистые функции: разбор и запись файла, правки документа (каждая
// возвращает новый документ), геометрия вида и стрелок. Без UI, хранилища и сети.
//
// Файл, записанный десктопом, байт в байт совпадает с тем, что записал бы web (`serializeCanvas`): тот же порядок
// и имена полей, табуляция, запись чисел и строк как у `JSON.stringify`. Незнакомые поля узлов и связей (в том
// числе поля Parvane `pvNote`, `pvFolder`, …) и верхнего уровня (`pvGraphScope`, `metadata`, …) хранятся как есть.
#pragma once

#include <functional>
#include <optional>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

#include <nlohmann/json.hpp>

namespace parvane::sections::notes {

// JSON с порядком ключей как в файле (как у объектов JS)
using CanvasJson = nlohmann::ordered_json;

inline const std::vector<std::string> kCanvasNodeTypes = {"text", "file", "group", "link"};
inline const std::vector<std::string> kCanvasPresetColors = {"1", "2", "3", "4", "5", "6"};

enum class CanvasSide { Top, Right, Bottom, Left };
inline const std::vector<CanvasSide> kCanvasSides = {
    CanvasSide::Top, CanvasSide::Right, CanvasSide::Bottom, CanvasSide::Left};

const char *canvasSideName(CanvasSide side);
// Сторона по имени из файла ('top' | 'right' | 'bottom' | 'left'); иное — nullopt
std::optional<CanvasSide> canvasSideFromName(std::string_view name);

struct CanvasPoint {
    double x = 0;
    double y = 0;
    bool operator==(const CanvasPoint &) const = default;
};

struct CanvasRect {
    double x = 0;
    double y = 0;
    double width = 0;
    double height = 0;
    bool operator==(const CanvasRect &) const = default;
};

struct CanvasViewport {
    double width = 0;
    double height = 0;
};

// Вид: экранная точка = точка холста × scale + (x, y)
struct CanvasView {
    double scale = 1;
    double x = 0;
    double y = 0;
    bool operator==(const CanvasView &) const = default;
};

struct CanvasAnchor {
    double x = 0;
    double y = 0;
    CanvasSide side = CanvasSide::Top;
    bool operator==(const CanvasAnchor &) const = default;
};

// Узел холста. `type` — строка: файл из другого приложения может нести незнакомый тип узла. Все поля, кроме id,
// type и геометрии, лежат в `fields` в порядке появления (color, text, file, subpath, url, label, background,
// backgroundStyle, pv*-поля Parvane и незнакомые) — значения любые, как в файле. Сравнение `==` — как `toEqual`
// в vitest: порядок ключей не важен.
struct CanvasNode {
    std::string id;
    std::string type;
    double x = 0;
    double y = 0;
    double width = 0;
    double height = 0;
    CanvasJson fields = CanvasJson::object();

    CanvasRect rect() const { return {x, y, width, height}; }
    bool has(std::string_view key) const;
    // Строковое значение поля; поля нет или оно не строка — nullopt
    std::optional<std::string> str(std::string_view key) const;
    // Значение поля; поля нет — nullptr
    const CanvasJson *get(std::string_view key) const;
    // Поставить поле: прежнее меняется на месте, новое встаёт в конец (как `{ ...node, key }` в JS)
    void set(const std::string &key, CanvasJson value);
    void erase(std::string_view key);

    bool operator==(const CanvasNode &other) const;
};

struct CanvasEdge {
    std::string id;
    std::string fromNode;
    std::string toNode;
    // fromSide, fromEnd, toSide, toEnd, color, label и незнакомые — в порядке появления
    CanvasJson fields = CanvasJson::object();

    bool has(std::string_view key) const;
    std::optional<std::string> str(std::string_view key) const;
    const CanvasJson *get(std::string_view key) const;
    void set(const std::string &key, CanvasJson value);
    void erase(std::string_view key);

    bool operator==(const CanvasEdge &other) const;
};

struct CanvasDoc {
    std::vector<CanvasNode> nodes;
    std::vector<CanvasEdge> edges;
    // Незнакомые поля верхнего уровня файла — сохраняются при записи. Пустой объект — их нет (`extra` в web нет)
    CanvasJson extra = CanvasJson::object();

    bool operator==(const CanvasDoc &other) const;
};

// `Json` — текст не разобрать; `Shape` — это не объект холста (`nodes` или `edges` есть, но не массив)
enum class CanvasParseError { Json, Shape };

struct CanvasDropped {
    int nodes = 0;
    int edges = 0;
    bool operator==(const CanvasDropped &) const = default;
};

struct CanvasParseResult {
    CanvasDoc doc;
    std::optional<CanvasParseError> error;
    // Сколько узлов и связей выброшено: без id, без типа или концов, с повторным id
    CanvasDropped dropped;
};

// Правка полей: nullopt — как `undefined` в web, поле убирается. Ключи x, y, width, height (числа) и type (строка)
// правят геометрию и тип; id не меняется
using CanvasPatch = std::vector<std::pair<std::string, std::optional<CanvasJson>>>;

using CanvasRandom = std::function<double()>;       // источник чисел [0, 1)
using CanvasMakeId = std::function<std::string()>;  // новый id

inline constexpr double kCanvasDefaultNodeWidth = 250;
inline constexpr double kCanvasDefaultNodeHeight = 60;
inline constexpr double kCanvasMinScale = 0.15;
inline constexpr double kCanvasMaxScale = 2.5;
// «Вписать» не приближает сильнее этого
inline constexpr double kCanvasFitMaxScale = 1.2;
inline constexpr double kCanvasFitPadding = 40;

bool isCanvasNodeType(std::string_view type);
bool isCanvasPresetColor(const std::optional<std::string> &color);

CanvasDoc createEmptyCanvas();

// Идентификатор узла или связи: 16 шестнадцатеричных знаков. `random` — источник чисел [0, 1); без него —
// системный генератор (как Math.random в web)
std::string newCanvasId(const CanvasRandom &random = {});

// ── разбор и запись ──────────────────────────────────────────────────────────

// Разбор файла `.canvas` (терпимый, как в web): незнакомые типы и поля сохраняются, числа приводятся (нет или не
// число — 0 для координат, 250 × 60 для размера), узлы без id или типа и связи без id или концов выбрасываются.
// Пустой файл и `{}` — пустой холст без ошибки. Нечитаемый JSON и не-объект — пустой документ и `error`.
CanvasParseResult parseCanvas(std::string_view text);

// Запись файла `.canvas`: JSON с отступом табуляцией и постоянным порядком ключей — ровно как web
std::string serializeCanvas(const CanvasDoc &doc);

// ── правки ───────────────────────────────────────────────────────────────────

const CanvasNode *findNode(const CanvasDoc &doc, std::string_view id);
const CanvasEdge *findEdge(const CanvasDoc &doc, std::string_view id);

// Новый узел в конце списка. Узел с занятым или пустым id не добавляется — прежний документ
CanvasDoc addNode(const CanvasDoc &doc, const CanvasNode &node);
// Правка полей узла; nullopt в `patch` убирает поле. `id` не меняется
CanvasDoc updateNode(const CanvasDoc &doc, std::string_view id, const CanvasPatch &patch);
// Удаление узла вместе с его связями. Содержимое удалённой группы остаётся на месте
CanvasDoc removeNode(const CanvasDoc &doc, std::string_view id);
// Стрелка от `from` к `to`. Не добавляется: петля, нет одного из узлов, такая стрелка уже есть
CanvasDoc addEdge(const CanvasDoc &doc, const std::string &from, const std::string &to,
                  const std::optional<std::string> &label = std::nullopt, const CanvasMakeId &makeId = {});
// Правка связи; nullopt и пустая подпись убирают поле. Концы и id не меняются
CanvasDoc updateEdge(const CanvasDoc &doc, std::string_view id, const CanvasPatch &patch);
CanvasDoc removeEdge(const CanvasDoc &doc, std::string_view id);

// Узлы, чей прямоугольник целиком лежит внутри группы (касание считается; вложенные группы входят)
std::vector<CanvasNode> nodesInGroup(const CanvasDoc &doc, std::string_view groupId);
// Сдвиг узла на (dx, dy) с округлением до целых; группа тянет за собой содержимое
CanvasDoc moveNode(const CanvasDoc &doc, std::string_view id, double dx, double dy);

// ── геометрия ────────────────────────────────────────────────────────────────

std::optional<CanvasRect> boundsOf(const CanvasDoc &doc);
double clampCanvasScale(double scale);
CanvasView fitView(const std::optional<CanvasRect> &bounds, CanvasViewport viewport,
                   double padding = kCanvasFitPadding);
// Вид для телефона: крупно первая группа; групп нет — весь холст
CanvasView firstGroupView(const CanvasDoc &doc, CanvasViewport viewport, double padding = kCanvasFitPadding);
// Середина стороны прямоугольника
CanvasPoint sidePoint(const CanvasRect &rect, CanvasSide side);

// Стороны связи как в файле (поля `fromSide`/`toSide`); незнакомое значение не учитывается
struct CanvasSides {
    std::optional<std::string> fromSide;
    std::optional<std::string> toSide;
};
CanvasSides sidesOf(const CanvasEdge &edge);

struct CanvasAnchors {
    CanvasAnchor from;
    CanvasAnchor to;
    bool operator==(const CanvasAnchors &) const = default;
};
CanvasAnchors edgeAnchors(const CanvasRect &fromNode, const CanvasRect &toNode, const CanvasSides &sides = {});

// ── поведение JS, общее для модулей холста ───────────────────────────────────
namespace canvasjs {

// Math.round: половина — вверх
double round(double value);
// String(number): запись числа как в JS
std::string numberToString(double value);
// JSON.stringify(value, undefined, indent); `indent` пусто — в одну строку. Ключи-индексы ("0", "12") идут первыми
// по возрастанию, как в объектах JS
std::string stringify(const CanvasJson &value, std::string_view indent = {});
// Сравнение как `toEqual`: порядок ключей объектов не важен, числа — по значению
bool deepEqual(const CanvasJson &a, const CanvasJson &b);
// Сравнение строк по кодовым единицам UTF-16 (Array.prototype.sort)
bool utf16Less(std::string_view a, std::string_view b);
// Пробельный знак JS (\s и String.prototype.trim)
bool isSpace(char32_t c);
std::string trim(std::string_view text);
bool hasSpace(std::string_view text);
// Длина в кодовых единицах UTF-16 и `slice(0, n)` в них же (суррогатная пара не режется: знак уходит целиком)
std::size_t utf16Length(std::string_view text);
std::string utf16Slice(std::string_view text, std::size_t units);
// Number(string): как в JS; не число — nullopt
std::optional<double> stringToNumber(std::string_view text);

} // namespace canvasjs

} // namespace parvane::sections::notes
