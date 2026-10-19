// Parvane fork: хуки сценариев для разделов (spec 029, T066) — `verify_*.sh` и пары с web проверяют «План»,
// «Знания» и «Облако» без UI: действия по таймеру и маркеры снимков в журнале.
//
//   PARVANE_AUTOPLANNER=task:<название>@<сек>[,event:<название>|<день>|<начало>|<конец>@<сек>]
//   PARVANE_AUTONOTES=note:<заголовок>|<текст>@<сек>
//   PARVANE_AUTOCLOUD=folder:<имя>@<сек>
//
// Маркеры (на каждое изменение снимка, повтор одной и той же строки не пишется):
//   «planner: status=<…> loaded=<0|1> задачи=[…] события=[…]»
//   «notes: status=<ready|loading> заметки=[…]»
//   «cloud: status=<…> корень=[…]» (личный диск, без корзины)
// Без переменных окружения ничего не делает.
#include "parvane/parvane_sections_data.h"

#include "parvane/parvane_client.h"

#include <parvane/sections/cloud_sync.h>

#include <QtCore/QDateTime>
#include <QtCore/QTimer>
#include <QtWidgets/QApplication>
#include <QtWidgets/QWidget>

#include <random>

namespace Parvane::Sections {

rpl::lifetime &Hooks();

namespace {

struct HookStep {
	QString op;
	QString arg;
	int seconds = 0;
};

[[nodiscard]] std::vector<HookStep> ParseSteps(const char *name) {
	auto result = std::vector<HookStep>();
	const auto raw = qEnvironmentVariable(name);
	if (raw.isEmpty()) {
		return result;
	}
	for (const auto &part : raw.split(',', Qt::SkipEmptyParts)) {
		const auto at = part.lastIndexOf('@');
		const auto colon = part.indexOf(':');
		if (colon <= 0) {
			continue;
		}
		auto step = HookStep();
		step.op = part.left(colon);
		step.arg = (at > colon) ? part.mid(colon + 1, at - colon - 1) : part.mid(colon + 1);
		step.seconds = (at > colon) ? part.mid(at + 1).toInt() : 0;
		result.push_back(step);
	}
	return result;
}

[[nodiscard]] QString Names(const std::vector<QString> &names) {
	return u"["_q + QStringList(names.begin(), names.end()).join(';') + u"]"_q;
}

[[nodiscard]] std::string NewId() {
	static auto rng = std::mt19937_64(std::random_device{}());
	static const char digits[] = "0123456789abcdef";
	auto result = std::string();
	for (auto i = 0; i != 32; ++i) {
		result.push_back(digits[rng() & 0x0F]);
	}
	return result;
}

void After(int seconds, Fn<void()> callback) {
	QTimer::singleShot(std::max(seconds, 0) * 1000, callback);
}

// Дождаться загруженного «Плана», затем правка
void WhenPlannerLoaded(Fn<void()> callback, int attempts = 120) {
	const auto view = Planner();
	if (view->isLoaded && view->status == "ready") {
		callback();
	} else if (attempts > 0) {
		QTimer::singleShot(1000, [=] { WhenPlannerLoaded(callback, attempts - 1); });
	} else {
		LOG(("Parvane: autoplanner — «План» не загрузился (status=%1)").arg(QString::fromStdString(view->status)));
	}
}

void RunPlannerStep(const HookStep &step) {
	if (step.op == u"task"_q) {
		const auto name = step.arg.toStdString();
		WhenPlannerLoaded([=] {
			UpdatePlanner([=](planner::State &state) {
				auto task = planner::Task();
				task.id = NewId();
				task.name = name;
				state.tasks.push_back(std::move(task));
			});
			LOG(("Parvane: autoplanner task %1 → отправлено").arg(QString::fromStdString(name)));
		});
	} else if (step.op == u"event"_q) {
		const auto parts = step.arg.split('|');
		if (parts.size() < 4) {
			return;
		}
		WhenPlannerLoaded([=] {
			UpdatePlanner([=](planner::State &state) {
				auto event = planner::Event();
				event.id = NewId();
				event.name = parts[0].toStdString();
				event.day = parts[1].toStdString();
				event.start = parts[2].toStdString();
				event.end = parts[3].toStdString();
				state.events.push_back(std::move(event));
			});
			LOG(("Parvane: autoplanner event %1 → отправлено").arg(parts[0]));
		});
	}
}

void RunNotesStep(const HookStep &step) {
	if (step.op != u"note"_q) {
		return;
	}
	const auto parts = step.arg.split('|');
	const auto title = parts.value(0).toStdString();
	const auto text = parts.mid(1).join('|').toStdString();
	SetShownSection(Section::Knowledge); // хранилище заметок поднимается с разделом
	After(5, [=] {
		Ask<std::string>([=](Workers &w) -> std::string {
			const auto vault = IsRussianUi() ? std::string("Знания") : std::string("Knowledge");
			const auto id = w.notes.createNote(title, vault, text);
			return id.value_or(std::string());
		}, [=](std::string id) {
			LOG(("Parvane: autonotes note %1 → %2").arg(
				QString::fromStdString(title),
				id.empty() ? u"не создана"_q : u"создана"_q));
		});
	});
}

void RunCloudStep(const HookStep &step) {
	if (step.op != u"folder"_q) {
		return;
	}
	const auto name = step.arg.toStdString();
	Ask<bool>([=](Workers &w) -> bool {
		w.cloud.ensure(true);
		// Личного диска ещё нет — `apply("root")` создаст его, как первая правка экрана «Облака»
		const auto data = notes::parseCloudData(w.drive.state());
		const auto empty = std::vector<cloud::CloudNode>();
		const auto &nodes = data->rootId ? data->nodesOf(data->rootId) : empty;
		const auto ops = cloud::createFolderOps(nodes, std::nullopt, name, NewId());
		const auto result = w.drive.applyOps("root", ops);
		return result.value("ok", false);
	}, [=](bool ok) {
		LOG(("Parvane: autocloud folder %1 → %2").arg(QString::fromStdString(name), ok ? u"ok"_q : u"отказ"_q));
	});
}

// Маркеры снимков
void LogSnapshots() {
	static auto lastPlanner = QString();
	PlannerValue() | rpl::on_next([](const std::shared_ptr<const PlannerView> &view) {
		auto tasks = std::vector<QString>();
		for (const auto &task : view->state.tasks) {
			tasks.push_back(QString::fromStdString(task.name));
		}
		auto events = std::vector<QString>();
		for (const auto &event : view->state.events) {
			events.push_back(QString::fromStdString(event.name));
		}
		const auto line = u"planner: status=%1 loaded=%2 задачи=%3 события=%4"_q.arg(
			QString::fromStdString(view->status),
			view->isLoaded ? u"1"_q : u"0"_q,
			Names(tasks),
			Names(events));
		if (line != lastPlanner) {
			lastPlanner = line;
			LOG(("Parvane: %1").arg(line));
		}
	}, Hooks());
	static auto lastNotes = QString();
	NotesValue() | rpl::on_next([](const std::shared_ptr<const NotesView> &view) {
		auto titles = std::vector<QString>();
		for (const auto &note : view->notes) {
			titles.push_back(QString::fromStdString(note->title));
		}
		const auto line = u"notes: status=%1 заметки=%2"_q.arg(
			(view->status == notes::NotesStatus::Ready) ? u"ready"_q : u"loading"_q,
			Names(titles));
		if (line != lastNotes) {
			lastNotes = line;
			LOG(("Parvane: %1").arg(line));
		}
	}, Hooks());
	static auto lastCloud = QString();
	CloudValue() | rpl::on_next([](const std::shared_ptr<const CloudView> &view) {
		auto names = std::vector<QString>();
		if (view->rootId && view->state.is_object()) {
			const auto data = notes::parseCloudData(view->state);
			for (const auto &node : data->nodesOf(data->rootId)) {
				if (!node.trashed && (!node.parent || node.parent->empty())) {
					names.push_back(QString::fromStdString(node.name));
				}
			}
		}
		std::sort(names.begin(), names.end());
		const auto line = u"cloud: status=%1 корень=%2"_q.arg(QString::fromStdString(view->status), Names(names));
		if (line != lastCloud) {
			lastCloud = line;
			LOG(("Parvane: %1").arg(line));
		}
	}, Hooks());
}

// Отладка раскладки (PARVANE_DUMPTREE=<сек>[,<сек>…]): дерево видимых виджетов с геометрией в окне
void DumpTree(QWidget *widget, int depth) {
	if (!widget->isVisible() || depth > 14) {
		return;
	}
	const auto global = widget->mapTo(widget->window(), QPoint());
	LOG(("Parvane: tree %1%2 [%3,%4 %5x%6]").arg(
		QString(depth * 2, ' '),
		QString::fromLatin1(widget->metaObject()->className()),
		QString::number(global.x()),
		QString::number(global.y()),
		QString::number(widget->width()),
		QString::number(widget->height())));
	for (const auto child : widget->children()) {
		if (const auto w = qobject_cast<QWidget*>(child)) {
			DumpTree(w, depth + 1);
		}
	}
}

void DumpTrees() {
	for (const auto top : QApplication::topLevelWidgets()) {
		if (top->isVisible()) {
			DumpTree(top, 0);
		}
	}
}

} // namespace

rpl::lifetime &Hooks() {
	static auto result = rpl::lifetime();
	return result;
}

void StartSectionHooks() {
	static auto started = false;
	for (const auto &part : qEnvironmentVariable("PARVANE_DUMPTREE").split(',', Qt::SkipEmptyParts)) {
		After(part.toInt(), [] { DumpTrees(); });
	}
	const auto planner = ParseSteps("PARVANE_AUTOPLANNER");
	const auto notesSteps = ParseSteps("PARVANE_AUTONOTES");
	const auto cloudSteps = ParseSteps("PARVANE_AUTOCLOUD");
	if (started || (planner.empty() && notesSteps.empty() && cloudSteps.empty())) {
		return;
	}
	started = true;
	LogSnapshots();
	OnSessionChanged();
	for (const auto &step : planner) {
		After(step.seconds, [=] { RunPlannerStep(step); });
	}
	for (const auto &step : notesSteps) {
		After(step.seconds, [=] { RunNotesStep(step); });
	}
	for (const auto &step : cloudSteps) {
		After(step.seconds, [=] { RunCloudStep(step); });
	}
	if (!cloudSteps.empty() && notesSteps.empty()) {
		Post([](Workers &w) { w.cloud.ensure(true); });
	}
}

} // namespace Parvane::Sections
