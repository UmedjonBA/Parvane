// Parvane fork (spec 029, фаза 4): общее тестов модулей «Знаний» волны 2 — проверка и узлы облака.
#pragma once

#include <cstdio>
#include <optional>
#include <string>
#include <vector>

#include "parvane/sections/cloud_model.h"

static int g_total = 0, g_fail = 0;
static void check(bool ok, const std::string &name) {
    ++g_total;
    if (!ok) ++g_fail;
    std::printf("  %s  %s\n", ok ? "ok  " : "FAIL", name.c_str());
}
static int finish() {
    std::printf("=== %d/%d ok ===\n", g_total - g_fail, g_total);
    return g_fail ? 1 : 0;
}

[[maybe_unused]] static parvane::sections::cloud::CloudNode cloudNode(const std::string &id, const std::string &name,
                                                     const std::optional<std::string> &parent = std::nullopt,
                                                     const std::string &kind = "file", bool trashed = false) {
    parvane::sections::cloud::CloudNode node;
    node.id = id;
    node.name = name;
    node.parent = parent;
    node.kind = kind;
    node.trashed = trashed;
    node.size = 10;
    return node;
}
