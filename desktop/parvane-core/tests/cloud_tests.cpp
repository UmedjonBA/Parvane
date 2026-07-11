// Parvane fork: тесты cloud-слоя parvane-core (CloudClient + cloud.h-пейлоады)
// против ЖИВОГО бэкенда (NATS + identity + cloud, поднимает run_all_tests.sh).
//
// Покрытие:
//   A. Чистые (без бэкенда): toJson/fromJson пейлоадов, устойчивость fromJson.
//   B. Живой путь: upload→download round-trip (1 чанк и много чанков со склейкой
//      по порядку), list (метаданные + изоляция владельца), download
//      несуществующего файла → ok=false, бинарь с нулевыми байтами.
#include <cstdio>
#include <cstdlib>
#include <string>

#include "parvane/cloud.h"
#include "parvane/cloud_client.h"
#include "parvane/events.h"
#include "parvane/topics.h"
#include "parvane/transport.h"

using parvane::CloudClient;
using parvane::FileEntry;
using parvane::json;

static int g_total = 0, g_fail = 0;

static void check(bool ok, const std::string &name, const std::string &info = "") {
    ++g_total;
    if (!ok) ++g_fail;
    std::printf("  %s  %s%s\n", ok ? "ok  " : "FAIL", name.c_str(),
                info.empty() ? "" : (" — " + info).c_str());
}

static std::string env(const char *n, const std::string &d) {
    const char *v = std::getenv(n);
    return (v && *v) ? std::string(v) : d;
}

static std::string issue(parvane::Transport &tr, const std::string &user) {
    parvane::IssueRequest req{user, "test"};
    tr.request(parvane::topics::IdentityRegister, req.toJson().dump()); // регистрируем (идемпотентно)
    auto resp = parvane::IssueResponse::fromJson(
        json::parse(tr.request(parvane::topics::IdentityIssue, req.toJson().dump())));
    return resp.token.value_or("");
}

int main() {
    const std::string url = env("PARVANE_NATS_URL", "nats://127.0.0.1:4222");
    std::printf("=== parvane-core cloud tests (NATS %s) ===\n", url.c_str());

    // ── A. Чистые тесты ───────────────────────────────────────────────────────
    {
        parvane::UploadChunkPayload c;
        c.file_id = "f1"; c.chunk_index = 2; c.total_chunks = 5;
        c.data = "ZGF0YQ=="; c.filename = "a.bin"; c.mime_type = "application/octet-stream";
        const json j = c.toJson();
        check(j["file_id"] == "f1" && j["chunk_index"] == 2 && j["total_chunks"] == 5
                  && j["data"] == "ZGF0YQ==" && j["filename"] == "a.bin",
              "UploadChunkPayload::toJson — все поля");
    }
    {
        json j = {{"ok", true}, {"filename", "x.png"}, {"mime_type", "image/png"},
                  {"chunk_index", 1}, {"total_chunks", 3}, {"data", "QUJD"}};
        auto r = parvane::DownloadResponse::fromJson(j);
        check(r.ok && r.filename.value_or("") == "x.png"
                  && r.mime_type.value_or("") == "image/png"
                  && r.chunk_index.value_or(0) == 1 && r.total_chunks.value_or(0) == 3
                  && r.data.value_or("") == "QUJD",
              "DownloadResponse::fromJson — чанк");
        json err = {{"ok", false}, {"error", "файл не найден"}};
        auto re = parvane::DownloadResponse::fromJson(err);
        check(!re.ok && re.error.value_or("") == "файл не найден" && !re.data.has_value(),
              "DownloadResponse::fromJson — ошибка");
    }
    {
        json j = {{"files", json::array({
            json{{"file_id", "a"}, {"filename", "1.bin"}, {"mime_type", "m"},
                 {"size_bytes", 10}, {"created_at", 99}}})}};
        auto r = parvane::FileListResponse::fromJson(j);
        check(r.files.size() == 1 && r.files[0].file_id == "a"
                  && r.files[0].size_bytes == 10 && r.files[0].created_at == 99,
              "FileListResponse::fromJson");
    }

    // ── B. Живой бэкенд ───────────────────────────────────────────────────────
    parvane::Transport tr;
    try {
        tr.connect(url);
    } catch (const std::exception &e) {
        check(false, "connect к live NATS", e.what());
        std::printf("РЕЗУЛЬТАТ: НЕТ соединения, живые тесты пропущены\n");
        std::printf("\nИТОГО: %d/%d прошло\n", g_total - g_fail, g_total);
        return 1;
    }

    const std::string alice = "alice@local";
    const std::string bob = "bob@local";
    const std::string jwtAlice = issue(tr, alice);
    const std::string jwtBob = issue(tr, bob);
    check(!jwtAlice.empty() && !jwtBob.empty(), "issue alice+bob токены");

    CloudClient cc(tr);

    // B1. upload одного чанка → download → байты совпадают (в т.ч. нулевые байты).
    const std::string blob1 = std::string("parvane\x00\x01\x02 cloud", 15);
    std::string id1;
    try {
        id1 = cc.upload(alice, jwtAlice, "note.bin", "application/octet-stream", blob1);
        check(!id1.empty(), "upload(1 чанк) вернул file_id", id1.substr(0, 8));
    } catch (const std::exception &e) {
        check(false, "upload(1 чанк)", e.what());
    }
    if (!id1.empty()) {
        auto d = cc.download(alice, jwtAlice, id1);
        check(d.ok && d.bytes == blob1,
              "download(1 чанк): байты совпадают",
              std::to_string(d.bytes.size()) + "/" + std::to_string(blob1.size()) + "б");
        check(d.filename == "note.bin" && d.mime == "application/octet-stream",
              "download: filename/mime", d.filename + " " + d.mime);
    }

    // B2. upload многих чанков (малый chunkSize) → склейка по порядку.
    std::string blob2;
    for (int i = 0; i < 1000; ++i) blob2 += static_cast<char>('A' + (i % 26));
    std::string id2;
    try {
        id2 = cc.upload(alice, jwtAlice, "big.txt", "text/plain", blob2,
                        /*chunkSize=*/64);
        check(!id2.empty(), "upload(много чанков, chunkSize=64)", id2.substr(0, 8));
    } catch (const std::exception &e) {
        check(false, "upload(много чанков)", e.what());
    }
    if (!id2.empty()) {
        auto d = cc.download(alice, jwtAlice, id2);
        check(d.ok && d.bytes == blob2,
              "download(много чанков): склейка по chunk_index верна",
              std::to_string(d.bytes.size()) + "/" + std::to_string(blob2.size()) + "б");
    }

    // B3. list содержит оба файла с корректными размерами.
    {
        auto files = cc.list(alice, jwtAlice);
        const FileEntry *f1 = nullptr;
        const FileEntry *f2 = nullptr;
        for (const auto &f : files) {
            if (f.file_id == id1) f1 = &f;
            if (f.file_id == id2) f2 = &f;
        }
        check(f1 && f2, "list: оба файла присутствуют",
              "total=" + std::to_string(files.size()));
        if (f1) check(f1->size_bytes == static_cast<std::int64_t>(blob1.size())
                          && f1->filename == "note.bin",
                      "list: метаданные note.bin");
        if (f2) check(f2->size_bytes == static_cast<std::int64_t>(blob2.size()),
                      "list: размер big.txt", std::to_string(f2 ? f2->size_bytes : -1));
    }

    // B4. изоляция владельца: bob не видит файлы alice.
    {
        auto files = cc.list(bob, jwtBob);
        bool leaked = false;
        for (const auto &f : files)
            if (f.file_id == id1 || f.file_id == id2) leaked = true;
        check(!leaked, "изоляция: bob не видит файлы alice",
              "у bob " + std::to_string(files.size()) + " файл(ов)");
    }

    // B5. download несуществующего файла → ok=false с ошибкой.
    {
        auto d = cc.download(alice, jwtAlice, "00000000-0000-7000-8000-000000000000",
                             /*timeoutMs=*/1500);
        check(!d.ok, "download несуществующего → ok=false",
              d.error.empty() ? "(без текста)" : d.error);
    }

    std::printf("\nИТОГО: %d/%d прошло\n", g_total - g_fail, g_total);
    return g_fail == 0 ? 0 : 1;
}
