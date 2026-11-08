// Parvane fork: выгрузка «ничего не потеряно» (spec 035, T007) без стека и без движка: общий вход
// `conformance/audit/dump-input.json` (вид строки истории задан готовым) обязан дать побайтно те же строки, что web
// `auditDump.test.ts` (`dump-expected.jsonl`). Данные выдуманные.
#include <cstdio>
#include <fstream>
#include <map>
#include <sstream>
#include <string>

#include "parvane/audit_dump.h"

using nlohmann::json;
namespace audit = parvane::audit;

static int g_total = 0, g_fail = 0;

static void check(bool ok, const std::string &name, const std::string &info = "") {
    ++g_total;
    if (!ok) ++g_fail;
    std::printf("  %s  %s%s\n", ok ? "ok  " : "FAIL", name.c_str(), info.empty() ? "" : (" — " + info).c_str());
}

static std::string readAll(const std::string &path) {
    std::ifstream in(path, std::ios::binary);
    std::stringstream ss;
    ss << in.rdbuf();
    return ss.str();
}

static audit::Sources sourcesOf(const json &fixture) {
    audit::Sources src;
    std::map<std::string, json> views;
    for (const auto &row : fixture["rows"]) {
        views[row["target"].get<std::string>()] = row["view"];
        auto state = row;
        state.erase("view");
        src.rows.push_back(state);
    }
    std::map<std::string, std::string> markKeys;
    for (const auto &mark : fixture["marks"]) {
        markKeys[audit::canonicalJson(mark["chat"])] = mark["chatKey"].get<std::string>();
        src.marks.push_back(mark);
    }
    for (const auto &entry : fixture["ownJournal"]) src.ownJournal.push_back(entry);
    src.stateSnapshot = fixture["stateSnapshot"].get<std::string>();
    src.plannerState = fixture["plannerState"].get<std::string>();
    for (const auto &c : fixture["cloud"]) src.cloud.emplace_back(c["container"], c.value("state", std::string()));
    for (const auto &g : fixture["groups"]) src.groups.emplace_back(g["hex"].get<std::string>(), g["info"]);
    for (const auto &l : fixture["deviceLogs"]) src.deviceLogs.push_back(l);
    src.accountKeys = fixture["accountKeys"];
    src.view = [views](const json &state) { return views.at(state["target"].get<std::string>()); };
    src.chatKey = [markKeys](const json &peer) {
        const auto it = markKeys.find(audit::canonicalJson(peer));
        return it == markKeys.end() ? std::string() : it->second;
    };
    return src;
}

int main() {
    const std::string dir = PARVANE_CONFORMANCE_DIR "/audit/";
    std::printf("канонический JSON\n");
    check(audit::canonicalJson(json::parse(R"({"b":1,"a":[3,{"d":null,"c":"х"}],"e":null})")) == R"({"a":[3,{"c":"х"}],"b":1})",
          "ключи по порядку, null-поля выброшены");
    check(audit::canonicalJson(json::parse(R"({"x":1.0})")) == R"({"x":1})", "1.0 → 1 (как JSON.stringify)");

    std::printf("ключи элементов\n");
    check(audit::statePeerKey(json::parse(R"({"user":{"address":"bob@local"}})")) == "u:bob@local", "собеседник");
    check(audit::elementKey(json::parse(R"({"peer":{"group":{"id":"AQ=="}}})")) == "g:AQ==", "peer группы");
    check(audit::elementKey(json::parse(R"({"ref":{"id":"Ag=="}})")) == "r:Ag==", "ref");
    check(audit::elementKey(json::parse(R"({"id":5})")) == "5", "id-число");
    check(audit::elementKey(json::parse(R"({"op_id":"AA==","peer":{"user":{"address":"b@l"}}})")) == "AA==",
          "op_id сильнее собеседника");
    check(audit::elementKey(json::parse(R"({"text":"без id"})")).rfind("h:", 0) == 0, "без id — дайджест");

    std::printf("общие векторы с web\n");
    const auto fixture = json::parse(readAll(dir + "dump-input.json"));
    const auto got = audit::jsonl(audit::build(sourcesOf(fixture)));
    const auto expected = readAll(dir + "dump-expected.jsonl");
    check(!expected.empty(), "dump-expected.jsonl прочитан");
    check(got == expected, "строки совпадают с web побайтно", got == expected ? "" : "\n" + got);

    std::printf("правка одного значения меняет одну строку\n");
    auto changed = fixture;
    changed["rows"][0]["view"]["pinned"] = false;
    const auto other = audit::jsonl(audit::build(sourcesOf(changed)));
    std::istringstream a(got), b(other);
    std::string la, lb;
    int diff = 0;
    std::string diffLine;
    while (std::getline(a, la) && std::getline(b, lb)) {
        if (la != lb) {
            ++diff;
            diffLine = la;
        }
    }
    check(diff == 1 && diffLine.find("u:bob@local/01923a4b-5c6d-7001-8000-000000000001") != std::string::npos,
          "изменилась ровно строка сообщения");

    std::printf("\n%d/%d\n", g_total - g_fail, g_total);
    return g_fail ? 1 : 0;
}
