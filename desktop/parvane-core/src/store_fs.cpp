// Parvane fork: см. store_fs.h (spec 035, FR-028).
#include "parvane/store_fs.h"

#include <algorithm>
#include <array>
#include <cerrno>
#include <cstdio>
#include <cstring>

#include <dirent.h>
#include <fcntl.h>
#include <sys/stat.h>
#include <unistd.h>

#include "parvane/gen/model.h"

namespace parvane::store_fs {

namespace {

constexpr char kMagic[4] = {'P', 'V', 'S', '1'};
constexpr uint8_t kTypeBatch = 1;
constexpr uint8_t kTypePack = 2;
constexpr uint8_t kOpPut = 1;
constexpr uint8_t kOpDel = 2;

uint32_t crc32(const std::string &data) {
    static const auto table = [] {
        std::array<uint32_t, 256> t{};
        for (uint32_t i = 0; i < 256; ++i) {
            uint32_t c = i;
            for (int k = 0; k < 8; ++k) c = (c & 1) ? 0xEDB88320u ^ (c >> 1) : c >> 1;
            t[i] = c;
        }
        return t;
    }();
    uint32_t c = 0xFFFFFFFFu;
    for (unsigned char b : data) c = table[(c ^ b) & 0xFF] ^ (c >> 8);
    return c ^ 0xFFFFFFFFu;
}

void putU32(std::string &out, uint32_t v) {
    for (int i = 0; i < 4; ++i) out += char((v >> (8 * i)) & 0xFF);
}
void putU64(std::string &out, uint64_t v) {
    for (int i = 0; i < 8; ++i) out += char((v >> (8 * i)) & 0xFF);
}

struct Reader {
    const std::string &s;
    size_t pos = 0;
    bool ok = true;
    uint64_t num(int n) {
        if (pos + size_t(n) > s.size()) {
            ok = false;
            return 0;
        }
        uint64_t v = 0;
        for (int i = 0; i < n; ++i) v |= uint64_t(uint8_t(s[pos + size_t(i)])) << (8 * i);
        pos += size_t(n);
        return v;
    }
    std::string bytes() {
        const auto n = num(4);
        if (!ok || pos + n > s.size()) {
            ok = false;
            return {};
        }
        std::string out = s.substr(pos, n);
        pos += n;
        return out;
    }
};

// Файл: magic | u8 тип | u64 seq | u32 число записей | записи (u8 op, ключ, [значение]) | u32 crc32.
std::string encodeFile(uint8_t type, uint64_t seq, const std::vector<std::pair<uint8_t, const Put *>> &recs) {
    std::string out(kMagic, 4);
    out += char(type);
    putU64(out, seq);
    putU32(out, uint32_t(recs.size()));
    for (const auto &[op, p] : recs) {
        out += char(op);
        putU32(out, uint32_t(p->key.size()));
        out += p->key;
        if (op == kOpPut) {
            putU32(out, uint32_t(p->value.size()));
            out += p->value;
        }
    }
    putU32(out, crc32(out));
    return out;
}

struct Decoded {
    uint8_t type = 0;
    uint64_t seq = 0;
    std::vector<std::pair<uint8_t, Put>> recs;
};

std::optional<Decoded> decodeFile(const std::string &data) {
    if (data.size() < 4 + 1 + 8 + 4 + 4 || std::memcmp(data.data(), kMagic, 4) != 0) return std::nullopt;
    const std::string body = data.substr(0, data.size() - 4);
    Reader tail{data, data.size() - 4};
    if (uint32_t(tail.num(4)) != crc32(body)) return std::nullopt;
    Reader r{body, 4};
    Decoded d;
    d.type = uint8_t(r.num(1));
    d.seq = r.num(8);
    const auto n = r.num(4);
    for (uint64_t i = 0; i < n && r.ok; ++i) {
        const auto op = uint8_t(r.num(1));
        Put p;
        p.key = r.bytes();
        if (op == kOpPut) p.value = r.bytes();
        else if (op != kOpDel) return std::nullopt;
        d.recs.emplace_back(op, std::move(p));
    }
    if (!r.ok || r.pos != body.size()) return std::nullopt;
    return d;
}

std::string seqName(const char *prefix, uint64_t seq) {
    char buf[48];
    std::snprintf(buf, sizeof buf, "%s-%020llu.bin", prefix, static_cast<unsigned long long>(seq));
    return buf;
}

std::optional<uint64_t> seqOf(const std::string &name, const char *prefix) {
    const std::string p = std::string(prefix) + "-";
    if (name.rfind(p, 0) != 0 || name.size() != p.size() + 20 + 4 || name.compare(name.size() - 4, 4, ".bin") != 0) return std::nullopt;
    uint64_t v = 0;
    for (size_t i = p.size(); i < p.size() + 20; ++i) {
        if (name[i] < '0' || name[i] > '9') return std::nullopt;
        v = v * 10 + uint64_t(name[i] - '0');
    }
    return v;
}

void setErr(std::string *error, const std::string &e) {
    if (error) *error = e;
}

struct PosixFs final : FsOps {
    int openWrite(const std::string &path) override { return ::open(path.c_str(), O_WRONLY | O_CREAT | O_TRUNC | O_CLOEXEC, 0600); }
    int openAppend(const std::string &path) override { return ::open(path.c_str(), O_WRONLY | O_CREAT | O_APPEND | O_CLOEXEC, 0600); }
    bool writeAll(int fd, const void *data, size_t n) override {
        const char *p = static_cast<const char *>(data);
        while (n > 0) {
            const ssize_t w = ::write(fd, p, n);
            if (w < 0) {
                if (errno == EINTR) continue;
                return false;
            }
            p += w;
            n -= size_t(w);
        }
        return true;
    }
    bool fsyncFd(int fd) override { return ::fsync(fd) == 0; }
    bool closeFd(int fd) override { return ::close(fd) == 0; }
    bool fsyncDir(const std::string &dir) override {
        const int fd = ::open(dir.c_str(), O_RDONLY | O_DIRECTORY | O_CLOEXEC);
        if (fd < 0) return false;
        const bool ok = ::fsync(fd) == 0;
        ::close(fd);
        return ok;
    }
    bool rename(const std::string &from, const std::string &to) override { return ::rename(from.c_str(), to.c_str()) == 0; }
    bool remove(const std::string &path) override { return ::unlink(path.c_str()) == 0 || errno == ENOENT; }
    std::optional<std::string> readFile(const std::string &path) override {
        FILE *f = std::fopen(path.c_str(), "rb");
        if (!f) return std::nullopt;
        std::string out;
        char buf[65536];
        size_t n;
        while ((n = std::fread(buf, 1, sizeof buf, f)) > 0) out.append(buf, n);
        const bool err = std::ferror(f) != 0;
        std::fclose(f);
        if (err) return std::nullopt;
        return out;
    }
    std::vector<std::string> list(const std::string &dir) override {
        std::vector<std::string> out;
        DIR *d = ::opendir(dir.c_str());
        if (!d) return out;
        while (auto *e = ::readdir(d)) {
            const std::string n = e->d_name;
            if (n != "." && n != "..") out.push_back(n);
        }
        ::closedir(d);
        return out;
    }
    bool mkdirs(const std::string &dir) override {
        std::string cur;
        for (size_t i = 0; i <= dir.size(); ++i) {
            if (i == dir.size() || dir[i] == '/') {
                if (!cur.empty() && ::mkdir(cur.c_str(), 0700) != 0 && errno != EEXIST) return false;
            }
            if (i < dir.size()) cur += dir[i];
        }
        return true;
    }
};

// В памяти: файлы — словарь «путь → байты», каталоги не нужны (модель в памяти — тесты и разовые проверки).
struct MemoryFs final : FsOps {
    std::map<std::string, std::string> files;
    std::map<int, std::pair<std::string, std::string>> open; // fd → (путь, накопленное)
    int next = 3;
    int openWrite(const std::string &path) override {
        open[next] = {path, std::string()};
        return next++;
    }
    bool writeAll(int fd, const void *data, size_t n) override {
        auto it = open.find(fd);
        if (it == open.end()) return false;
        it->second.second.append(static_cast<const char *>(data), n);
        return true;
    }
    bool fsyncFd(int fd) override { return open.count(fd) != 0; }
    bool closeFd(int fd) override {
        auto it = open.find(fd);
        if (it == open.end()) return false;
        files[it->second.first] = std::move(it->second.second);
        open.erase(it);
        return true;
    }
    bool fsyncDir(const std::string &) override { return true; }
    bool rename(const std::string &from, const std::string &to) override {
        auto it = files.find(from);
        if (it == files.end()) return false;
        files[to] = std::move(it->second);
        files.erase(from);
        return true;
    }
    bool remove(const std::string &path) override {
        files.erase(path);
        return true;
    }
    std::optional<std::string> readFile(const std::string &path) override {
        auto it = files.find(path);
        if (it == files.end()) return std::nullopt;
        return it->second;
    }
    std::vector<std::string> list(const std::string &dir) override {
        std::vector<std::string> out;
        const auto prefix = dir + "/";
        for (const auto &[p, _] : files) {
            if (p.rfind(prefix, 0) == 0 && p.find('/', prefix.size()) == std::string::npos) out.push_back(p.substr(prefix.size()));
        }
        return out;
    }
    bool mkdirs(const std::string &) override { return true; }
};

}  // namespace

FsOps &posixFs() {
    static PosixFs fs;
    return fs;
}

std::unique_ptr<FsOps> memoryFs() { return std::make_unique<MemoryFs>(); }

std::unique_ptr<Store> Store::open(const std::string &dir, FsOps &fs, std::string *error) {
    std::unique_ptr<Store> s(new Store(dir, fs));
    if (!fs.mkdirs(dir)) {
        setErr(error, "store_fs: каталог " + dir + " не создаётся");
        return nullptr;
    }
    if (!s->load(error)) return nullptr;
    return s;
}

bool Store::load(std::string *error) {
    std::vector<std::string> names = fs_.list(dir_);
    std::sort(names.begin(), names.end());
    std::vector<uint64_t> packs, batches;
    for (const auto &n : names) {
        if (n.size() > 4 && n.compare(n.size() - 4, 4, ".tmp") == 0) {
            fs_.remove(dir_ + "/" + n);  // недописанный файл прерванной записи
        } else if (auto p = seqOf(n, "pack")) {
            packs.push_back(*p);
        } else if (auto b = seqOf(n, "batch")) {
            batches.push_back(*b);
        }
    }
    if (!packs.empty()) {
        const uint64_t last = packs.back();
        const auto data = fs_.readFile(dir_ + "/" + seqName("pack", last));
        const auto d = data ? decodeFile(*data) : std::nullopt;
        if (!d || d->type != kTypePack || d->seq != last) {
            setErr(error, "store_fs: снимок " + seqName("pack", last) + " испорчен");
            return false;
        }
        for (auto &[op, p] : d->recs) kv_[p.key] = std::move(p.value);
        packSeq_ = seq_ = last;
        // Прежние снимки от прерванной упаковки — лишние.
        for (const auto p : packs)
            if (p != last) fs_.remove(dir_ + "/" + seqName("pack", p));
    }
    for (const auto b : batches) {
        if (b <= packSeq_) {
            fs_.remove(dir_ + "/" + seqName("batch", b));  // уже в снимке (упаковка прервана после rename)
            continue;
        }
        const auto data = fs_.readFile(dir_ + "/" + seqName("batch", b));
        const auto d = data ? decodeFile(*data) : std::nullopt;
        if (!d || d->type != kTypeBatch || d->seq != b) {
            setErr(error, "store_fs: пачка " + seqName("batch", b) + " испорчена");
            return false;
        }
        for (auto &[op, p] : d->recs) {
            if (op == kOpDel) kv_.erase(p.key);
            else kv_[p.key] = std::move(p.value);
        }
        seq_ = b;
        journal_.push_back(b);
    }
    return true;
}

bool Store::writeDurable(const std::string &name, const std::string &bytes, std::string *error) {
    const std::string tmp = dir_ + "/" + name + ".tmp";
    const std::string fin = dir_ + "/" + name;
    const int fd = fs_.openWrite(tmp);
    if (fd < 0) {
        setErr(error, "store_fs: не открыть " + tmp);
        return false;
    }
    bool ok = fs_.writeAll(fd, bytes.data(), bytes.size()) && fs_.fsyncFd(fd);
    ok = fs_.closeFd(fd) && ok;
    // Каталог: запись о временном файле долговечна до переименования; после — сама замена.
    ok = ok && fs_.fsyncDir(dir_) && fs_.rename(tmp, fin);
    if (!ok) {
        fs_.remove(tmp);
        setErr(error, "store_fs: запись " + name + " не удалась");
        return false;
    }
    if (!fs_.fsyncDir(dir_)) {
        setErr(error, "store_fs: fsync каталога после " + name + " не удался");
        return false;
    }
    return true;
}

bool Store::commit(const Batch &batch, std::string *error) {
    std::vector<std::pair<uint8_t, const Put *>> recs;
    std::vector<Put> dels;
    dels.reserve(batch.deletes.size());
    for (const auto &k : batch.deletes) dels.push_back(Put{k, {}});
    for (const auto &d : dels) recs.emplace_back(kOpDel, &d);
    for (const auto &p : batch.puts) recs.emplace_back(kOpPut, &p);
    const uint64_t seq = seq_ + 1;
    if (!writeDurable(seqName("batch", seq), encodeFile(kTypeBatch, seq, recs), error)) return false;
    for (const auto &k : batch.deletes) kv_.erase(k);
    for (const auto &p : batch.puts) kv_[p.key] = p.value;
    seq_ = seq;
    journal_.push_back(seq);
    if (journal_.size() >= kPackEvery) {
        std::string packErr;
        pack(&packErr);  // пачка уже долговечна; неудачная упаковка повторится позже
    }
    return true;
}

bool Store::pack(std::string *error) {
    std::vector<std::pair<uint8_t, const Put *>> recs;
    std::vector<Put> all;
    all.reserve(kv_.size());
    for (const auto &[k, v] : kv_) all.push_back(Put{k, v});
    for (const auto &p : all) recs.emplace_back(kOpPut, &p);
    if (!writeDurable(seqName("pack", seq_), encodeFile(kTypePack, seq_, recs), error)) return false;
    const uint64_t prevPack = packSeq_;
    packSeq_ = seq_;
    for (const auto b : journal_) fs_.remove(dir_ + "/" + seqName("batch", b));
    journal_.clear();
    if (prevPack != 0 && prevPack != packSeq_) fs_.remove(dir_ + "/" + seqName("pack", prevPack));
    fs_.fsyncDir(dir_);
    return true;
}

std::vector<Put> Store::read(const Reads &r) const {
    std::vector<Put> out;
    for (const auto &k : r.keys) {
        const auto it = kv_.find(k);
        if (it != kv_.end()) out.push_back(Put{it->first, it->second});
    }
    if (r.all || !r.prefix.empty()) {
        auto it = r.prefix.empty() ? kv_.begin() : kv_.lower_bound(r.prefix);
        for (; it != kv_.end(); ++it) {
            if (it->first.compare(0, r.prefix.size(), r.prefix) != 0) break;
            if (!r.after.empty() && it->first <= r.after) continue;
            if (r.limit != 0 && out.size() >= r.limit) break;
            out.push_back(Put{it->first, it->second});
        }
    }
    return out;
}

bool Store::commitJson(const std::string &batchJson, std::string *error) {
    gen::StoreBatch b;
    try {
        b = nlohmann::json::parse(batchJson).get<gen::StoreBatch>();
    } catch (const std::exception &e) {
        setErr(error, std::string("store_fs: пачка не разобрана: ") + e.what());
        return false;
    }
    Batch batch;
    for (auto &p : b.puts) batch.puts.push_back(Put{std::move(p.key), std::move(p.value)});
    batch.deletes = std::move(b.deletes);
    return commit(batch, error);
}

std::string Store::readJson(const std::string &readsJson) const {
    gen::StoreReads q;
    try {
        q = nlohmann::json::parse(readsJson).get<gen::StoreReads>();
    } catch (const std::exception &) {
        return "{\"error\":\"Malformed\"}";
    }
    Reads r;
    r.keys = q.keys;
    r.prefix = q.prefix;
    r.after = q.after;
    r.limit = q.limit;
    gen::StoreLoaded loaded;
    loaded.read_id = q.read_id;
    for (auto &p : read(r)) loaded.entries.push_back(gen::StorePut{std::move(p.key), std::move(p.value)});
    return nlohmann::json(loaded).dump();
}

}  // namespace parvane::store_fs
