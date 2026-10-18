// Parvane fork (spec 029, фаза 4): ссылки на заметки в названии записи «Плана» — порт web plannerLinks.ts.
#include "parvane/sections/planner_links.h"

#include "planner_quick_text.h"

namespace parvane::sections::planner {

using namespace text;

namespace {

constexpr char16_t kMaskFirst = 0xE000;
constexpr char16_t kMaskLast = 0xF8FF;

const Regex &noteLink() { return rx(R"(\[\[([^[\]|\n]+)(?:\|([^[\]\n]*))?\]\])"); }

} // namespace

std::vector<NamePart> splitNameLinks(const std::string &utf8) {
    const S name = fromUtf8(utf8);
    std::vector<NamePart> result;
    int position = 0;
    for (const auto &match : matchAll(noteLink(), name)) {
        const S note = trim(match.str(name, 1));
        if (note.empty()) continue;
        if (match.index() > position) result.push_back({toUtf8(slice(name, position, match.index())), std::nullopt});
        const S caption = match.has(2) ? trim(match.str(name, 2)) : S();
        result.push_back({toUtf8(caption.empty() ? note : caption), toUtf8(note)});
        position = match.end();
    }
    if (position < int(name.size())) result.push_back({toUtf8(slice(name, position)), std::nullopt});
    return result;
}

std::string formatPlainName(const std::string &name) {
    std::string out;
    for (const auto &part : splitNameLinks(name)) out += part.text;
    return out;
}

std::string formatDescriptionLine(const std::optional<std::string> &description) {
    const S text = fromUtf8(description.value_or(""));
    for (const auto &part : splitStr(text, u"\n")) {
        if (!trim(part).empty()) return formatPlainName(toUtf8(trim(part)));
    }
    return "";
}

MaskedLinks16 maskNameLinks16(const std::u16string &text) {
    MaskedLinks16 out;
    out.text = replaceAll(noteLink(), text, [&](const Match &m) {
        const S link = m.str(text, 0);
        if (trim(m.str(text, 1)).empty() || size_t(kMaskFirst) + out.links.size() > size_t(kMaskLast)) return link;
        out.links.push_back(link);
        return S(link.size(), char16_t(kMaskFirst + out.links.size() - 1));
    });
    return out;
}

std::u16string unmaskNameLinks16(const std::u16string &text, const std::vector<std::u16string> &links) {
    if (links.empty()) return text;
    S out;
    size_t i = 0;
    while (i < text.size()) {
        const char16_t c = text[i];
        if (c < kMaskFirst || c > kMaskLast) {
            out += c;
            ++i;
            continue;
        }
        size_t j = i;
        while (j < text.size() && text[j] == c) ++j;
        const size_t index = size_t(c - kMaskFirst);
        out += index < links.size() ? links[index] : text.substr(i, j - i);
        i = j;
    }
    return out;
}

MaskedLinks maskNameLinks(const std::string &text) {
    const auto masked = maskNameLinks16(fromUtf8(text));
    MaskedLinks out{toUtf8(masked.text), {}};
    for (const auto &link : masked.links) out.links.push_back(toUtf8(link));
    return out;
}

std::string unmaskNameLinks(const std::string &text, const std::vector<std::string> &links) {
    std::vector<S> wide;
    for (const auto &link : links) wide.push_back(fromUtf8(link));
    return toUtf8(unmaskNameLinks16(fromUtf8(text), wide));
}

} // namespace parvane::sections::planner
