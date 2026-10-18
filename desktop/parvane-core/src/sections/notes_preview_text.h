// Parvane fork (spec 029, фаза 4): разбор строки заметки для показа — регулярки web `notesCanvasNote.ts` и
// `notesLook.ts`, разобранные вручную по кодовым точкам. Внутренний заголовок notes_canvas_note.cpp и notes_look.cpp.
#pragma once

#include "notes_text.h"

namespace parvane::sections::notes::preview {

using text::U32;

inline bool isMarkerChar(char32_t c) { return (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9'); }

// `/ \^t[a-z0-9]{4,12}\s*$/` → '' (метка пункта в конце строки)
inline U32 stripTaskMarker(const U32 &s) {
    for (size_t i = 0; i + 3 <= s.size(); ++i) {
        if (s[i] != U' ' || s[i + 1] != U'^' || s[i + 2] != U't') continue;
        size_t j = i + 3;
        while (j < s.size() && isMarkerChar(s[j])) ++j;
        const size_t run = j - (i + 3);
        if (run < 4 || run > 12) continue;
        size_t k = j;
        while (k < s.size() && text::isSpace(s[k])) ++k;
        if (k == s.size()) return s.substr(0, i);
    }
    return s;
}

// `/^#+\s*/` → длина совпадения (0 — нет)
inline size_t headingMark(const U32 &s) {
    size_t i = 0;
    while (i < s.size() && s[i] == U'#') ++i;
    if (!i) return 0;
    while (i < s.size() && text::isSpace(s[i])) ++i;
    return i;
}

// `/^\s*[-*+] (\[[ xX]\] )?/` → длина совпадения (0 — нет)
inline size_t listMark(const U32 &s) {
    size_t i = 0;
    while (i < s.size() && text::isSpace(s[i])) ++i;
    if (i + 1 >= s.size() || (s[i] != U'-' && s[i] != U'*' && s[i] != U'+') || s[i + 1] != U' ') return 0;
    i += 2;
    if (i + 4 <= s.size() && s[i] == U'['
        && (s[i + 1] == U' ' || s[i + 1] == U'x' || s[i + 1] == U'X') && s[i + 2] == U']' && s[i + 3] == U' ') {
        i += 4;
    }
    return i;
}

} // namespace parvane::sections::notes::preview
