// Parvane fork: данные разделов «План», «Знания», «Облако» на desktop (spec 029, L3). Логика — в ядре
// (`parvane::sections::*`, порт web с тестами); здесь — её хозяйство в клиенте:
// - один рабочий поток: в нём живут PlannerSync/PlannerStore, CloudSync/CloudDrive и NotesStore (их вызовы
//   блокирующие — сеть идёт через v2-сессию), сроки `tick()/nextWakeMs()` модулей ведёт он же;
// - транспорт `DomainTransport` поверх `parvane::v2::Session` (движок по имени WASM, запрос шины, кодек методов);
// - записи устройства (очереди отправки, кэш текстов заметок) — зашифрованные файлы `tdata/parvane-v2-<адрес>/`;
// - экранам — снимки на главном потоке (`PlannerValue`, `NotesValue`, `CloudValue`), правки — заданиями в поток.
#pragma once

#include "parvane/parvane_space.h"

#include <parvane/sections/cloud_sync.h>
#include <parvane/sections/notes_store.h>
#include <parvane/sections/planner_store.h>
#include <parvane/sections/planner_sync.h>

#include <rpl/producer.h>

#include <functional>
#include <memory>

namespace Parvane::Sections {

namespace planner = parvane::sections::planner;
namespace notes = parvane::sections::notes;
namespace cloud = parvane::sections::cloud;
namespace domain = parvane::sections::domain;
using json = nlohmann::json;

// То, что доступно заданию в рабочем потоке (все указатели живы, пока идёт задание)
struct Workers {
	domain::DomainTransport &transport;
	planner::PlannerSync &plannerSync;
	planner::PlannerStore &planner;
	cloud::CloudSync &cloud;
	cloud::CloudDrive &drive;
	notes::NotesStore &notes;
	const std::string &self; // свой адрес; пусто — сессии нет
	std::int64_t nowMs;
};

// Выполнить на главном потоке (для заданий)
void PostMain(std::function<void()> fn);

// Задание в рабочий поток; после него снимки перечитываются и уходят экранам
void Post(std::function<void(Workers&)> job);

// Задание с результатом: `done` — на главном потоке
template <typename T>
void Ask(std::function<T(Workers&)> job, std::function<void(T)> done) {
	Post([job = std::move(job), done = std::move(done)](Workers &w) mutable {
		auto result = std::make_shared<T>(job(w));
		PostMain([done = std::move(done), result] { done(std::move(*result)); });
	});
}

// ── снимки для экранов (главный поток) ─────────────────────────────────────────

struct PlannerView {
	planner::State state;
	std::string status = "loading"; // loading | needs-linking | no-key | offline | ready
	bool isLoaded = false;
	bool isCached = false;
	bool canUndo = false;
	std::optional<planner::PlannerNotice> notice;
	std::int64_t sizeBytes = 0;
	std::optional<std::string> lastError;
	std::uint64_t revision = 0;
};

struct NotesView {
	std::vector<notes::NoteRef> notes;
	std::vector<notes::CanvasRef> canvases;
	std::vector<notes::NoteFolder> folders;
	notes::NotesStatus status = notes::NotesStatus::Loading;
	std::optional<notes::NotesNotice> notice;
	std::optional<std::string> guideOpenId;
	notes::CloudDataRef cloud;
	std::uint64_t revision = 0;
};

struct CloudView {
	json state;                 // `parvaneCloudState` web (status, rootId, containers, trees…)
	std::string status = "loading";
	std::optional<std::string> rootId;
	std::vector<cloud::CloudContainerInfo> containers;
	std::optional<std::string> lastError;
	std::optional<json> usage;  // `cloud.blob.usage` (buckets[], links_bytes)
	std::uint64_t revision = 0;
};

[[nodiscard]] std::shared_ptr<const PlannerView> Planner();
[[nodiscard]] rpl::producer<std::shared_ptr<const PlannerView>> PlannerValue();
[[nodiscard]] std::shared_ptr<const NotesView> Notes();
[[nodiscard]] rpl::producer<std::shared_ptr<const NotesView>> NotesValue();
[[nodiscard]] std::shared_ptr<const CloudView> Cloud();
[[nodiscard]] rpl::producer<std::shared_ptr<const CloudView>> CloudValue();

// ── частые правки ──────────────────────────────────────────────────────────────

// Правка «Плана» (web `updatePlanner`): разница уходит на сервер пакетом; уведомление с «Отменить», если задано
void UpdatePlanner(std::function<void(planner::State&)> mutate, const QString &notice = QString());
void UndoPlanner(const QString &notice);
// Правки дерева облака (`parvaneCloudApply`); `done(ok)` — на главном потоке
void ApplyCloud(const std::string &container, json ops, std::function<void(bool)> done = nullptr);
// Метод провайдера облака по имени web (`parvaneCloud*`); ответ — на главном потоке (nullopt — отказ)
void CallCloud(const std::string &method, json args, std::function<void(std::optional<json>)> done);

// ── жизненный цикл ─────────────────────────────────────────────────────────────

// Раздел на экране: подключает нужные модули (План — Календарь/Здоровье; Облако — Файлы и Знания; Знания)
void SetShownSection(Section section);
// Окно видно/скрыто (опрос 8 с только при видимом окне)
void SetWindowVisible(bool visible);
// Событие движка v2 (`plannerChanged`, `cloudChanged`); зовётся из потока сессии
void OnEngineEvent(const json &event);
// Сессия сменилась (вход, выход, смена аккаунта): модули сбрасываются и подключаются заново
void OnSessionChanged();
// Выход из приложения: дослать правки и остановить поток
void Shutdown();

} // namespace Parvane::Sections
