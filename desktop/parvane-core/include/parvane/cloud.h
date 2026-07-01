// Parvane fork: C++-зеркало cloud-пейлоадов из shared/parvane-types/src/lib.rs.
// Контракт (Фаза 4, медиа-блобы):
//   file.upload.chunk    — ParvaneEvent<UploadChunkPayload> (request/reply: ack)
//   file.upload.complete — ParvaneEvent<UploadCompletePayload> (request/reply)
//   file.download.request — ParvaneEvent<DownloadRequest>; cloud шлёт N чанков
//                           (DownloadResponse) на reply-инбокс
//   file.list.request    — ParvaneEvent<FileListPayload> → FileListResponse
//
// data-поля — base64 (кодирование/декодирование в cloud_client.cpp).
#pragma once

#include <cstdint>
#include <optional>
#include <string>
#include <vector>

#include <nlohmann/json.hpp>

namespace parvane {

using nlohmann::json;

// ── UploadChunkPayload (file.upload.chunk) ────────────────────────────────────
struct UploadChunkPayload {
    std::string file_id;
    std::uint32_t chunk_index = 0;
    std::uint32_t total_chunks = 0;
    std::string data; // base64
    std::string filename;
    std::string mime_type;

    json toJson() const {
        return json{{"file_id", file_id},
                    {"chunk_index", chunk_index},
                    {"total_chunks", total_chunks},
                    {"data", data},
                    {"filename", filename},
                    {"mime_type", mime_type}};
    }
};

// ── UploadCompletePayload (file.upload.complete) ──────────────────────────────
struct UploadCompletePayload {
    std::string file_id;
    std::string filename;
    std::uint32_t total_chunks = 0;
    std::uint64_t size_bytes = 0;
    std::string mime_type;

    json toJson() const {
        return json{{"file_id", file_id},
                    {"filename", filename},
                    {"total_chunks", total_chunks},
                    {"size_bytes", size_bytes},
                    {"mime_type", mime_type}};
    }
};

// ── UploadCompleteResponse ────────────────────────────────────────────────────
struct UploadCompleteResponse {
    bool ok = false;
    std::optional<std::string> file_id;
    std::optional<std::string> error;

    static UploadCompleteResponse fromJson(const json &j) {
        UploadCompleteResponse r;
        r.ok = j.value("ok", false);
        if (auto it = j.find("file_id"); it != j.end() && !it->is_null())
            r.file_id = it->get<std::string>();
        if (auto it = j.find("error"); it != j.end() && !it->is_null())
            r.error = it->get<std::string>();
        return r;
    }
};

// ── DownloadResponse (элемент потока file.download.request) ────────────────────
// Каждый чанк — отдельный DownloadResponse с data!=null. total_chunks в каждом
// одинаков — по нему клиент знает, сколько чанков ждать.
struct DownloadResponse {
    bool ok = false;
    std::optional<std::string> filename;
    std::optional<std::string> mime_type;
    std::optional<std::uint32_t> chunk_index;
    std::optional<std::uint32_t> total_chunks;
    std::optional<std::string> data; // base64
    std::optional<std::string> error;

    static DownloadResponse fromJson(const json &j) {
        DownloadResponse r;
        r.ok = j.value("ok", false);
        if (auto it = j.find("filename"); it != j.end() && !it->is_null())
            r.filename = it->get<std::string>();
        if (auto it = j.find("mime_type"); it != j.end() && !it->is_null())
            r.mime_type = it->get<std::string>();
        if (auto it = j.find("chunk_index"); it != j.end() && !it->is_null())
            r.chunk_index = it->get<std::uint32_t>();
        if (auto it = j.find("total_chunks"); it != j.end() && !it->is_null())
            r.total_chunks = it->get<std::uint32_t>();
        if (auto it = j.find("data"); it != j.end() && !it->is_null())
            r.data = it->get<std::string>();
        if (auto it = j.find("error"); it != j.end() && !it->is_null())
            r.error = it->get<std::string>();
        return r;
    }
};

// ── FileEntry (элемент FileListResponse) ──────────────────────────────────────
struct FileEntry {
    std::string file_id;
    std::string filename;
    std::string mime_type;
    std::int64_t size_bytes = 0;
    std::int64_t created_at = 0;

    static FileEntry fromJson(const json &j) {
        FileEntry e;
        e.file_id = j.value("file_id", std::string());
        e.filename = j.value("filename", std::string());
        e.mime_type = j.value("mime_type", std::string());
        e.size_bytes = j.value("size_bytes", std::int64_t(0));
        e.created_at = j.value("created_at", std::int64_t(0));
        return e;
    }
};

// ── FileListResponse (file.list.response) ─────────────────────────────────────
struct FileListResponse {
    std::vector<FileEntry> files;

    static FileListResponse fromJson(const json &j) {
        FileListResponse r;
        if (auto it = j.find("files"); it != j.end() && it->is_array()) {
            r.files.reserve(it->size());
            for (const auto &f : *it)
                r.files.push_back(FileEntry::fromJson(f));
        }
        return r;
    }
};

} // namespace parvane
