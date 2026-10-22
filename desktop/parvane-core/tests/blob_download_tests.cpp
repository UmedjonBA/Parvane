// Parvane fork: ревью безопасности 21 окт 2026, вечер (2.2) — блоб, собираемый в память, всегда с потолком.
// Свой TCP-сервер PVN2 (как gateway в dev) отвечает на cloud.blob.download_cap подделанными метаданными и
// чанками; клиент — настоящие Connection::requestStream и downloadBlobChunks (их зовут Session::downloadBlobCap
// и Control::downloadBlob). Без правки сервер, заявивший chunks = 1e6 и шлющий чанки без конца, растил память
// клиента без предела.
#include "parvane/blobcrypt.h"
#include "parvane/v2_engine.h"
#include "parvane/v2_link.h"

#include <arpa/inet.h>
#include <netinet/in.h>
#include <sys/socket.h>
#include <unistd.h>

#include <atomic>
#include <chrono>
#include <cstdio>
#include <cstring>
#include <fstream>
#include <functional>
#include <string>
#include <thread>
#include <vector>

namespace v2 = parvane::v2;

static int g_fail = 0;
static void check(bool c, const char *msg) {
    std::printf("%s %s\n", c ? "[ok]" : "[FAIL]", msg);
    if (!c) ++g_fail;
}

// ── protobuf вручную (кадры сервера движок не собирает) ─────────────────────

static void varint(std::string &out, std::uint64_t v) {
    do {
        unsigned char b = v & 0x7f;
        v >>= 7;
        if (v) b |= 0x80;
        out.push_back(static_cast<char>(b));
    } while (v);
}
static void fieldVarint(std::string &out, int num, std::uint64_t v) {
    varint(out, std::uint64_t(num) << 3);
    varint(out, v);
}
static void fieldBytes(std::string &out, int num, const std::string &bytes) {
    varint(out, (std::uint64_t(num) << 3) | 2);
    varint(out, bytes.size());
    out += bytes;
}
static std::string frame(int kind, const std::string &inner) {
    std::string f;
    fieldVarint(f, 1, 2); // proto_major
    fieldBytes(f, kind, inner);
    return f;
}
static bool readVarint(const std::string &s, std::size_t &pos, std::uint64_t &v) {
    v = 0;
    for (int shift = 0; pos < s.size() && shift < 64; shift += 7) {
        const auto b = static_cast<unsigned char>(s[pos++]);
        v |= std::uint64_t(b & 0x7f) << shift;
        if (!(b & 0x80)) return true;
    }
    return false;
}
// Поле `num` сообщения (len-delimited) — содержимое; varint-поле — в `value`
static bool findField(const std::string &s, int num, std::string *bytes, std::uint64_t *value) {
    std::size_t pos = 0;
    while (pos < s.size()) {
        std::uint64_t key = 0;
        if (!readVarint(s, pos, key)) return false;
        const int wt = int(key & 7);
        const int n = int(key >> 3);
        if (wt == 0) {
            std::uint64_t v = 0;
            if (!readVarint(s, pos, v)) return false;
            if (n == num && value) {
                *value = v;
                return true;
            }
        } else if (wt == 2) {
            std::uint64_t len = 0;
            if (!readVarint(s, pos, len) || pos + len > s.size()) return false;
            if (n == num && bytes) {
                *bytes = s.substr(pos, len);
                return true;
            }
            pos += len;
        } else {
            return false;
        }
    }
    return false;
}

// ── сервер ──────────────────────────────────────────────────────────────────

struct Plan {
    std::uint64_t size = 0;       // заявленный размер (DownloadCapResponse.size)
    std::uint64_t chunks = 0;     // заявленное число чанков
    int send = 0;                 // сколько чанков слать на самом деле (-1 — пока соединение живо)
    std::size_t chunkBytes = 0;   // размер каждого
    std::uint32_t indexBase = 0;  // индекс первого чанка
    std::vector<std::string> data; // явные чанки (вместо send/chunkBytes)
};

class FakeGateway {
public:
    FakeGateway() {
        fd_ = ::socket(AF_INET, SOCK_STREAM, 0);
        int one = 1;
        ::setsockopt(fd_, SOL_SOCKET, SO_REUSEADDR, &one, sizeof(one));
        sockaddr_in a{};
        a.sin_family = AF_INET;
        a.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
        a.sin_port = 0;
        ::bind(fd_, reinterpret_cast<sockaddr *>(&a), sizeof(a));
        socklen_t len = sizeof(a);
        ::getsockname(fd_, reinterpret_cast<sockaddr *>(&a), &len);
        port_ = ntohs(a.sin_port);
        ::listen(fd_, 8);
        thread_ = std::thread([this] { loop(); });
    }
    ~FakeGateway() {
        stop_ = true;
        ::shutdown(fd_, SHUT_RDWR);
        ::close(fd_);
        if (thread_.joinable()) thread_.join();
    }
    void setPlan(Plan p) { plan_ = std::move(p); }
    [[nodiscard]] std::string url() const { return "127.0.0.1:" + std::to_string(port_); }
    std::atomic<std::uint64_t> sentChunkBytes{0};

private:
    static bool sendFrame(int c, const std::string &f) {
        std::string out;
        varint(out, f.size());
        out += f;
        std::size_t off = 0;
        while (off < out.size()) {
            const auto n = ::send(c, out.data() + off, out.size() - off, MSG_NOSIGNAL);
            if (n <= 0) return false;
            off += std::size_t(n);
        }
        return true;
    }
    static bool readFrame(int c, std::string &acc, std::string &f) {
        for (;;) {
            std::size_t pos = 0;
            std::uint64_t len = 0;
            if (readVarint(acc, pos, len) && acc.size() >= pos + len) {
                f = acc.substr(pos, len);
                acc.erase(0, pos + len);
                return true;
            }
            char buf[4096];
            const auto n = ::recv(c, buf, sizeof(buf), 0);
            if (n <= 0) return false;
            acc.append(buf, std::size_t(n));
        }
    }
    void serve(int c) {
        std::string acc;
        char pre[4];
        if (::recv(c, pre, 4, MSG_WAITALL) != 4 || std::memcmp(pre, "PVN2", 4) != 0) return;
        std::string f;
        while (readFrame(c, acc, f)) {
            std::string inner;
            if (findField(f, 10, &inner, nullptr)) { // Hello → Welcome
                if (!sendFrame(c, frame(11, std::string()))) return;
                continue;
            }
            if (!findField(f, 20, &inner, nullptr)) continue; // не Request
            std::uint64_t id = 0;
            findField(inner, 1, nullptr, &id);
            const auto plan = plan_;
            std::string meta;
            fieldVarint(meta, 1, plan.size);
            fieldVarint(meta, 2, plan.chunks);
            std::string resp;
            fieldVarint(resp, 1, id);
            fieldBytes(resp, 2, meta);
            if (!sendFrame(c, frame(21, resp))) return;
            const auto count = plan.data.empty() ? plan.send : int(plan.data.size());
            const std::string filler(plan.chunkBytes, 'x');
            for (int i = 0; (count < 0 || i < count) && !stop_; ++i) {
                const auto &bytes = plan.data.empty() ? filler : plan.data[std::size_t(i)];
                std::string chunk;
                fieldVarint(chunk, 1, id);
                fieldVarint(chunk, 2, plan.indexBase + std::uint32_t(i));
                if (count >= 0 && i + 1 == count) fieldVarint(chunk, 3, 1);
                fieldBytes(chunk, 4, bytes);
                if (!sendFrame(c, frame(23, chunk))) return;
                sentChunkBytes += bytes.size();
            }
        }
    }
    void loop() {
        while (!stop_) {
            const int c = ::accept(fd_, nullptr, nullptr);
            if (c < 0) return;
            serve(c);
            ::close(c);
        }
    }

    int fd_ = -1;
    int port_ = 0;
    std::atomic<bool> stop_{false};
    Plan plan_;
    std::thread thread_;
};

// ── клиент ──────────────────────────────────────────────────────────────────

static long rssKb() {
    std::ifstream f("/proc/self/status");
    std::string line;
    while (std::getline(f, line)) {
        if (line.rfind("VmRSS:", 0) == 0) return std::atol(line.c_str() + 6);
    }
    return 0;
}

struct Outcome {
    std::string bytes;
    std::string error; // код V2Error
    double seconds = 0;
    long rssGrowthKb = 0;
};

static Outcome download(FakeGateway &gw, std::size_t maxBytes) {
    Outcome o;
    const auto rss0 = rssKb();
    const auto t0 = std::chrono::steady_clock::now();
    try {
        o.bytes = v2::downloadBlobChunks("cloud.blob.download_cap", maxBytes,
            [&](const v2::Connection::StreamLimits &limits) {
                v2::Connection conn(gw.url());
                conn.open(v2::kChannelAnonymous, "test");
                const auto body = v2::encodeMessage("parvane.cloud.v1.DownloadCapRequest",
                    v2::json{{"file_id", "f1"}, {"capability", v2::json(std::string(43, 'A') + "=")},
                             {"first_chunk", limits.firstChunk}, {"chunk_count", limits.chunkCount}});
                auto got = conn.requestStream("cloud.blob.download_cap", body, 10000, std::string(), limits);
                conn.close();
                return got;
            });
    } catch (const v2::V2Error &e) {
        o.error = e.code();
    } catch (const std::exception &e) {
        o.error = std::string("other: ") + e.what();
    }
    o.seconds = std::chrono::duration<double>(std::chrono::steady_clock::now() - t0).count();
    o.rssGrowthKb = rssKb() - rss0;
    return o;
}

int main() {
    FakeGateway gw;
    constexpr std::size_t kThumb = 2 * 1024 * 1024;

    // 1. Сервер заявляет chunks = 1e6 (и огромный размер) и шлёт чанки по 700 КиБ без конца: отказ по
    //    метаданным, до приёма чанков, память не растёт
    {
        Plan p;
        p.size = 1000000ull * 700 * 1024;
        p.chunks = 1000000;
        p.send = -1;
        p.chunkBytes = 700 * 1024;
        gw.setPlan(p);
        const auto o = download(gw, kThumb);
        std::printf("    chunks=1e6: %s, %.2f с, RSS +%ld КиБ\n", o.error.c_str(), o.seconds, o.rssGrowthKb);
        check(o.error == "ERROR_CODE_LIMIT", "chunks = 1e6, размер 700 ГБ: отказ LIMIT");
        check(o.seconds < 5, "отказ сразу, не после скачивания");
        check(o.rssGrowthKb < 16 * 1024, "память клиента не растёт");
    }
    // 2. chunks = 1e6 при маленьком заявленном размере: больше предела сервера (100 000) — отказ по метаданным
    {
        Plan p;
        p.size = 100;
        p.chunks = 1000000;
        p.send = -1;
        p.chunkBytes = 1;
        gw.setPlan(p);
        const auto o = download(gw, kThumb);
        check(o.error == "ERROR_CODE_LIMIT" && o.seconds < 5, "chunks = 1e6, размер 100: отказ LIMIT сразу");
    }
    // 3. Метаданные честно малы, а чанки идут без конца (сервер лжёт): отказ, как только принятое превысило
    //    потолок; дальше чанки не копятся
    {
        Plan p;
        p.size = 100;
        p.chunks = 1;
        p.send = -1;
        p.chunkBytes = 700 * 1024;
        gw.setPlan(p);
        const auto o = download(gw, kThumb);
        std::printf("    поток без конца: %s, %.2f с, RSS +%ld КиБ\n", o.error.c_str(), o.seconds, o.rssGrowthKb);
        check(o.error == "ERROR_CODE_LIMIT", "поток больше потолка: отказ LIMIT");
        check(o.rssGrowthKb < 16 * 1024, "поток больше потолка: память не растёт");
    }
    // 4. Чанк вне запрошенного окна (индекс 5000 в первой пачке) — подделка
    {
        Plan p;
        p.size = 3;
        p.chunks = 1;
        p.indexBase = 5000;
        p.data = {"abc"};
        gw.setPlan(p);
        const auto o = download(gw, kThumb);
        check(o.error == "ERROR_CODE_INVALID", "чанк вне окна: отказ INVALID");
    }
    // 5. Без явного потолка — общий (файл облака до 2 ГиБ): 3 ГБ — отказ по метаданным
    {
        Plan p;
        p.size = 3000000000ull;
        p.chunks = 5000;
        p.send = -1;
        p.chunkBytes = 700 * 1024;
        gw.setPlan(p);
        const auto o = download(gw, 0);
        check(o.error == "ERROR_CODE_LIMIT" && o.seconds < 5, "без потолка: больше 2 ГиБ — отказ LIMIT");
    }
    // 6. Честный блоб в пределах потолка — как раньше
    {
        Plan p;
        p.size = 6;
        p.chunks = 2;
        p.data = {"abc", "def"};
        gw.setPlan(p);
        const auto o = download(gw, kThumb);
        check(o.error.empty() && o.bytes == "abcdef", "честный блоб: склеен");
        const auto tight = download(gw, 5);
        check(tight.error == "ERROR_CODE_LIMIT", "потолок меньше размера: отказ LIMIT");
    }
    // 7. Потолок по содержимому: шифртекст PVB2 для N байт не больше maxCipherSize(N)
    {
        bool ok = true;
        for (const std::size_t n : {std::size_t(1), std::size_t(1023), std::size_t(1024), std::size_t(300000)}) {
            const std::string key(32, 'k'), nonce(12, 'n');
            for (const std::uint32_t chunk : {parvane::blobcrypt::kMinChunkSize, parvane::blobcrypt::kDefaultChunkSize}) {
                const auto c = parvane::blobcrypt::encryptWithKey(std::string(n, 'p'), key, nonce, chunk);
                ok = ok && c.size() <= parvane::blobcrypt::maxCipherSize(n);
            }
        }
        check(ok, "maxCipherSize покрывает шифртекст PVB2 при любом размере чанка");
        check(parvane::blobcrypt::maxCipherSize(0) == 0, "maxCipherSize(0) — 0");
    }

    std::printf("%s\n", g_fail ? "FAILED" : "ALL OK");
    return g_fail ? 1 : 0;
}
