// Parvane Android (spec 031): запросы и правки «Плана» для экранов — см. jni_planner_ops.cpp.
#pragma once

#include <parvane/sections/planner_types.h>

#include <string>

namespace pvjni::plannerops {

using nlohmann::json;

struct Context {
    std::string today;      // YYYY-MM-DD по местному времени
    double nowMinutes = 0;  // минуты от полуночи
    std::string lang = "ru";
};

// Запрос без правки: days | undated | lists | settings | health | monthGrid | week | quickParse | stats | slots
json query(const parvane::sections::planner::State &state, const std::string &op, const json &args, const Context &ctx);
// Правка состояния (зовётся внутри `PlannerStore::update`)
json edit(parvane::sections::planner::State &state, const std::string &op, const json &args, const Context &ctx);
bool isEdit(const std::string &op);

} // namespace pvjni::plannerops
