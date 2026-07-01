// Parvane fork: реализация CloudClient (см. cloud_client.h).
#include "parvane/cloud_client.h"

#include <algorithm>
#include <array>
#include <cstdint>
#include <map>
#include <stdexcept>

#include "parvane/events.h"
#include "parvane/ids.h"
#include "parvane/topics.h"

namespace parvane {

namespace {

constexpr char kB64[] =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

std::string base64Encode(const std::string &in) {
    std::string out;
    out.reserve(((in.size() + 2) / 3) * 4);
    std::size_t i = 0;
    const auto n = in.size();
    while (i + 3 <= n) {
        const std::uint32_t v = (std::uint8_t(in[i]) << 16) |
                                (std::uint8_t(in[i + 1]) << 8) |
                                std::uint8_t(in[i + 2]);
        out.push_back(kB64[(v >> 18) & 0x3F]);
        out.push_back(kB64[(v >> 12) & 0x3F]);
        out.push_back(kB64[(v >> 6) & 0x3F]);
        out.push_back(kB64[v & 0x3F]);
        i += 3;
    }
    if (i + 1 == n) {
        const std::uint32_t v = std::uint8_t(in[i]) << 16;
        out.push_back(kB64[(v >> 18) & 0x3F]);
        out.push_back(kB64[(v >> 12) & 0x3F]);
        out.push_back('=');
        out.push_back('=');
    } else if (i + 2 == n) {
        const std::uint32_t v =
            (std::uint8_t(in[i]) << 16) | (std::uint8_t(in[i + 1]) << 8);
        out.push_back(kB64[(v >> 18) & 0x3F]);
        out.push_back(kB64[(v >> 12) & 0x3F]);
        out.push_back(kB64[(v >> 6) & 0x3F]);
        out.push_back('=');
    }
    return out;
}

std::string base64Decode(const std::string &in) {
    std::array<std::int8_t, 256> tab;
    tab.fill(-1);
    for (int i = 0; i < 64; ++i) tab[std::uint8_t(kB64[i])] = static_cast<std::int8_t>(i);

    std::string out;
    out.reserve((in.size() / 4) * 3);
    std::uint32_t buf = 0;
    int bits = 0;
    for (char c : in) {
        if (c == '=' || c == '\n' || c == '\r') continue;
        const std::int8_t d = tab[std::uint8_t(c)];
        if (d < 0) continue; // пропускаем не-base64 символы
        buf = (buf << 6) | static_cast<std::uint32_t>(d);
        bits += 6;
        if (bits >= 8) {
            bits -= 8;
            out.push_back(static_cast<char>((buf >> bits) & 0xFF));
        }
    }
    return out;
}

} // namespace

std::string CloudClient::upload(const std::string &from, const std::string &token,
                                const std::string &filename, const std::string &mime,
                                const std::string &bytes, std::size_t chunkSize,
                                int timeoutMs) {
    if (chunkSize == 0) chunkSize = 256 * 1024;
    const std::string fileId = newUuidV7();

    const std::size_t total =
        bytes.empty() ? 1 : (bytes.size() + chunkSize - 1) / chunkSize;

    for (std::size_t idx = 0; idx < total; ++idx) {
        const std::size_t off = idx * chunkSize;
        const std::size_t len = std::min(chunkSize, bytes.size() - std::min(off, bytes.size()));
        const std::string slice =
            (off < bytes.size()) ? bytes.substr(off, len) : std::string();

        UploadChunkPayload chunk;
        chunk.file_id = fileId;
        chunk.chunk_index = static_cast<std::uint32_t>(idx);
        chunk.total_chunks = static_cast<std::uint32_t>(total);
        chunk.data = base64Encode(slice);
        chunk.filename = filename;
        chunk.mime_type = mime;

        const json ev = makeEvent(newUuidV7(), from, nowUnix(), token, chunk.toJson());
        // request/reply: шард подтверждает запись чанка (сериализует загрузку).
        const std::string ackRaw =
            _t.request(topics::FileUploadChunk, ev.dump(), timeoutMs);
        const json ack = json::parse(ackRaw);
        if (!ack.value("ok", false)) {
            throw std::runtime_error("cloud: чанк " + std::to_string(idx) +
                                     " отвергнут: " + ack.value("error", std::string("?")));
        }
    }

    UploadCompletePayload comp;
    comp.file_id = fileId;
    comp.filename = filename;
    comp.total_chunks = static_cast<std::uint32_t>(total);
    comp.size_bytes = bytes.size();
    comp.mime_type = mime;

    const json ev = makeEvent(newUuidV7(), from, nowUnix(), token, comp.toJson());
    const std::string raw = _t.request(topics::FileUploadComplete, ev.dump(), timeoutMs);
    const auto resp = UploadCompleteResponse::fromJson(json::parse(raw));
    if (!resp.ok) {
        throw std::runtime_error("cloud: complete отвергнут: " +
                                 resp.error.value_or("?"));
    }
    return resp.file_id.value_or(fileId);
}

CloudClient::Downloaded CloudClient::download(const std::string &from,
                                              const std::string &token,
                                              const std::string &fileId,
                                              int timeoutMs) {
    const json payload{{"file_id", fileId}};
    const json ev = makeEvent(newUuidV7(), from, nowUnix(), token, payload);

    Downloaded result;
    std::map<std::uint32_t, std::string> chunks; // index → декодированные байты
    std::uint32_t expected = 0;
    bool sawError = false;

    _t.requestMany(
        topics::FileDownloadRequest, ev.dump(),
        [&](const std::string &reply) -> bool {
            DownloadResponse r;
            try {
                r = DownloadResponse::fromJson(json::parse(reply));
            } catch (...) {
                return true; // битый ответ — ждём валидный до таймаута
            }
            if (!r.ok) {
                sawError = true;
                result.error = r.error.value_or("download failed");
                return false; // ошибка — дальше ждать нечего
            }
            if (r.filename && result.filename.empty()) result.filename = *r.filename;
            if (r.mime_type && result.mime.empty()) result.mime = *r.mime_type;
            if (r.total_chunks) expected = *r.total_chunks;
            if (r.data && r.chunk_index) {
                chunks[*r.chunk_index] = base64Decode(*r.data);
            }
            // Достаточно, когда собрали все ожидаемые чанки.
            return !(expected > 0 && chunks.size() >= expected);
        },
        timeoutMs);

    if (sawError) {
        result.ok = false;
        return result;
    }
    if (expected == 0 || chunks.size() < expected) {
        result.ok = false;
        result.error = "неполная загрузка: " + std::to_string(chunks.size()) +
                       "/" + std::to_string(expected) + " чанков";
        return result;
    }
    // Склейка по возрастанию индекса (std::map упорядочен).
    for (const auto &[idx, data] : chunks) {
        (void)idx;
        result.bytes += data;
    }
    result.ok = true;
    return result;
}

std::vector<FileEntry> CloudClient::list(const std::string &from,
                                         const std::string &token, int timeoutMs) {
    const json ev = makeEvent(newUuidV7(), from, nowUnix(), token, json::object());
    const std::string raw = _t.request(topics::FileListRequest, ev.dump(), timeoutMs);
    return FileListResponse::fromJson(json::parse(raw)).files;
}

} // namespace parvane
