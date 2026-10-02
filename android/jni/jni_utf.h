// Parvane Android: строки JNI ↔ стандартный UTF-8. GetStringUTFChars/NewStringUTF
// работают в «модифицированном UTF-8» (символы вне BMP — эмодзи — парами
// суррогатов по 3 байта): такой текст не принимает движок v2 (serde/proto3
// требуют корректный UTF-8), а HotSpot при NewStringUTF с 4-байтовыми
// последовательностями портит строку. Здесь — перевод через UTF-16.
#pragma once

#include <jni.h>

#include <cstdint>
#include <string>
#include <vector>

namespace parvane::jniutf {

inline std::string fromJava(JNIEnv *env, jstring s) {
    if (!s) return {};
    const jsize n = env->GetStringLength(s);
    std::vector<jchar> u(static_cast<size_t>(n));
    if (n) env->GetStringRegion(s, 0, n, u.data());
    std::string out;
    out.reserve(static_cast<size_t>(n));
    for (jsize i = 0; i < n; ++i) {
        std::uint32_t c = u[static_cast<size_t>(i)];
        if (c >= 0xD800 && c <= 0xDBFF && i + 1 < n) {
            const std::uint32_t lo = u[static_cast<size_t>(i + 1)];
            if (lo >= 0xDC00 && lo <= 0xDFFF) { c = 0x10000 + ((c - 0xD800) << 10) + (lo - 0xDC00); ++i; }
            else c = 0xFFFD;
        } else if (c >= 0xD800 && c <= 0xDFFF) {
            c = 0xFFFD; // одиночный суррогат
        }
        if (c < 0x80) out.push_back(static_cast<char>(c));
        else if (c < 0x800) { out.push_back(static_cast<char>(0xC0 | (c >> 6))); out.push_back(static_cast<char>(0x80 | (c & 0x3F))); }
        else if (c < 0x10000) { out.push_back(static_cast<char>(0xE0 | (c >> 12))); out.push_back(static_cast<char>(0x80 | ((c >> 6) & 0x3F))); out.push_back(static_cast<char>(0x80 | (c & 0x3F))); }
        else { out.push_back(static_cast<char>(0xF0 | (c >> 18))); out.push_back(static_cast<char>(0x80 | ((c >> 12) & 0x3F))); out.push_back(static_cast<char>(0x80 | ((c >> 6) & 0x3F))); out.push_back(static_cast<char>(0x80 | (c & 0x3F))); }
    }
    return out;
}

inline jstring toJava(JNIEnv *env, const std::string &s) {
    std::vector<jchar> u;
    u.reserve(s.size());
    for (size_t i = 0; i < s.size();) {
        const auto b = static_cast<unsigned char>(s[i]);
        std::uint32_t c = 0xFFFD;
        size_t len = 1;
        if (b < 0x80) c = b;
        else if ((b >> 5) == 0x6 && i + 1 < s.size()) { c = ((b & 0x1F) << 6) | (s[i + 1] & 0x3F); len = 2; }
        else if ((b >> 4) == 0xE && i + 2 < s.size()) { c = ((b & 0x0F) << 12) | ((s[i + 1] & 0x3F) << 6) | (s[i + 2] & 0x3F); len = 3; }
        else if ((b >> 3) == 0x1E && i + 3 < s.size()) { c = ((b & 0x07) << 18) | ((s[i + 1] & 0x3F) << 12) | ((s[i + 2] & 0x3F) << 6) | (s[i + 3] & 0x3F); len = 4; }
        i += len;
        if (c >= 0x10000) { c -= 0x10000; u.push_back(static_cast<jchar>(0xD800 + (c >> 10))); u.push_back(static_cast<jchar>(0xDC00 + (c & 0x3FF))); }
        else u.push_back(static_cast<jchar>(c));
    }
    return env->NewString(u.data(), static_cast<jsize>(u.size()));
}

} // namespace parvane::jniutf
