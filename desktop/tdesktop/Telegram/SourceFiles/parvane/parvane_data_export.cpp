// Parvane fork: реализация parvane_data_export.h. Тексты — как web `DataExportModal.tsx` (ключи ParvaneExport*).
// Отличия от web: архив не «скачивается», а пишется в выбранную папку (сначала во временный `.part`, по
// готовности — переименование в `parvane-export-<ник>-<дата>.zip`, занятое имя — с « (2)»); по завершении —
// уведомление окна и кнопка «Показать в папке».
#include "parvane/parvane_data_export.h"

#include "parvane/parvane_client.h"
#include "parvane/parvane_kit.h"
#include "parvane/parvane_sections_data.h"

#include "base/call_delayed.h"
#include "core/file_utilities.h"
#include "data/data_session.h"
#include "data/data_user.h"
#include "dialogs/dialogs_indexed_list.h"
#include "dialogs/dialogs_row.h"
#include "history/history.h"
#include "lang/lang_keys.h"
#include "main/main_session.h"
#include "ui/layers/generic_box.h"
#include "ui/text/format_values.h"
#include "ui/widgets/buttons.h"
#include "ui/widgets/checkbox.h"
#include "ui/widgets/labels.h"
#include "ui/wrap/slide_wrap.h"
#include "ui/wrap/vertical_layout.h"
#include "window/window_session_controller.h"
#include "styles/style_boxes.h"
#include "styles/style_layers.h"

#include <parvane/sections/cloud_files.h>
#include <parvane/sections/export_model.h>
#include <parvane/sections/export_source.h>
#include <parvane/sections/export_zip.h>

#include <crl/crl_async.h>
#include <crl/crl_on_main.h>

#include <QtCore/QDateTime>
#include <QtCore/QDir>
#include <QtCore/QFile>
#include <QtCore/QFileInfo>
#include <QtCore/QPointer>
#include <QtCore/QStandardPaths>
#include <QtCore/QUuid>

#include <atomic>
#include <chrono>
#include <future>
#include <map>
#include <thread>

namespace Parvane {
namespace {

namespace exportdata = parvane::sections::exportdata;
namespace cloud = parvane::sections::cloud;
using json = nlohmann::json;

// Кусок блоба, отдаваемый архиву за раз
constexpr auto kChunkBytes = std::size_t(1024 * 1024);
// Ожидание загрузки «Плана» перед выгрузкой: 60 × 0,5 с
constexpr auto kPlannerWaitAttempts = 60;
constexpr auto kPlannerWaitStepMs = crl::time(500);
// Ход выгрузки — на экран не чаще раза в 100 мс (смена этапа — сразу)
constexpr auto kProgressEveryMs = 100;

[[nodiscard]] QString Q(const std::string &value) {
	return QString::fromStdString(value);
}

[[nodiscard]] exportdata::CivilTime LocalCivil(std::int64_t unixSeconds) {
	const auto local = QDateTime::fromSecsSinceEpoch(unixSeconds).toLocalTime();
	const auto date = local.date();
	const auto time = local.time();
	return { date.year(), date.month(), date.day(), time.hour(), time.minute(), time.second() };
}

[[nodiscard]] exportdata::ExportLabels Labels() {
	auto result = exportdata::ExportLabels();
	const auto s = [](const QString &text) { return text.toStdString(); };
	result.title = s(tr::lng_parvane_export_html_title(tr::now));
	result.chats = s(tr::lng_parvane_export_html_chats(tr::now));
	result.planner = s(tr::lng_parvane_export_html_planner(tr::now));
	result.notes = s(tr::lng_parvane_export_html_notes(tr::now));
	result.contacts = s(tr::lng_parvane_export_html_contacts(tr::now));
	result.cloud = s(tr::lng_parvane_export_html_cloud(tr::now));
	result.savedMessages = s(tr::lng_saved_messages(tr::now));
	result.replyTo = s(tr::lng_parvane_export_html_reply_to(tr::now));
	result.forwardedFrom = s(tr::lng_parvane_export_html_forwarded_from(tr::now));
	result.edited = s(tr::lng_parvane_export_html_edited(tr::now));
	result.mediaNotIncluded = s(tr::lng_parvane_export_html_media_not_included(tr::now));
	result.mediaUnavailable = s(tr::lng_parvane_export_html_media_unavailable(tr::now));
	result.poll = s(tr::lng_parvane_export_html_poll(tr::now));
	result.location = s(tr::lng_parvane_export_html_location(tr::now));
	result.messages = s(tr::lng_parvane_export_html_messages(tr::now));
	result.exportedAt = s(tr::lng_parvane_export_html_exported_at(tr::now));
	result.privacyOn = s(tr::lng_parvane_export_html_privacy_on(tr::now));
	result.privacyOff = s(tr::lng_parvane_export_html_privacy_off(tr::now));
	return result;
}

// Байты блоба кусками для ZipWriter; прочитанное отпускается сразу по концу
[[nodiscard]] exportdata::ZipWriter::ChunkSource Chunks(std::string bytes) {
	const auto data = std::make_shared<std::string>(std::move(bytes));
	const auto offset = std::make_shared<std::size_t>(0);
	return [=](std::string &chunk) {
		if (*offset >= data->size()) {
			std::string().swap(*data);
			return false;
		}
		const auto size = std::min(kChunkBytes, data->size() - *offset);
		chunk.assign(data->data() + *offset, size);
		*offset += size;
		return true;
	};
}

// Задание в рабочем потоке разделов с ожиданием результата. Поток выгрузки — не главный и не рабочий, так что
// ждать можно; отмена прерывает ожидание (задание доработает само, результат никому не нужен)
template <typename T>
[[nodiscard]] std::optional<T> OnSections(
		std::function<T(Sections::Workers&)> job,
		const std::function<bool()> &canceled) {
	const auto promise = std::make_shared<std::promise<T>>();
	auto future = promise->get_future();
	Sections::Post([job = std::move(job), promise](Sections::Workers &w) {
		try {
			promise->set_value(job(w));
		} catch (...) {
			promise->set_exception(std::current_exception());
		}
	});
	while (future.wait_for(std::chrono::milliseconds(250)) != std::future_status::ready) {
		if (canceled()) {
			return std::nullopt;
		}
	}
	return future.get();
}

// Провайдер web для ядра: снимок переписки и «План» подготовлены на главном потоке до старта, облако и заметки —
// методами провайдера облака в рабочем потоке разделов, вложения чатов — клиентом (кэш устройства или сервер)
class Host final : public exportdata::ExportHost {
public:
	Host(json snapshot, json planner, std::function<bool()> canceled)
	: _snapshot(std::move(snapshot))
	, _planner(std::move(planner))
	, _canceled(std::move(canceled)) {
		// Ключи вложений — из содержимого сообщений снимка (ядро просит вложение только по file_id)
		const auto list = [](const json &object, const char *key) {
			return (object.is_object() && object.contains(key) && object[key].is_array())
				? object[key]
				: json::array();
		};
		const auto text = [](const json &object, const char *key) {
			return (object.contains(key) && object[key].is_string())
				? object[key].get<std::string>()
				: std::string();
		};
		for (const auto &chat : list(_snapshot, "chats")) {
			for (const auto &message : list(chat, "messages")) {
				if (!message.is_object() || !message.contains("content") || !message["content"].is_object()) {
					continue;
				}
				const auto &content = message["content"];
				const auto fileId = text(content, "file_id");
				if (!fileId.empty()) {
					_keys[fileId] = { text(content, "file_key"), text(content, "file_nonce") };
					_caps[fileId] = { text(content, "kind"),
						(content.contains("size_bytes") && content["size_bytes"].is_number_integer())
							? content["size_bytes"].get<std::int64_t>()
							: std::int64_t(0) };
				}
			}
		}
	}

	std::optional<json> callParvane(const std::string &method, const json &args) override {
		if (method == "parvaneExportSnapshot") {
			return _snapshot;
		} else if (method == "parvanePlannerState") {
			return _planner;
		} else if (method == "parvanePlannerCachedState") {
			return json(nullptr);
		} else if (method.rfind("parvaneCloud", 0) == 0) {
			auto result = OnSections<std::optional<json>>([=](Sections::Workers &w) {
				return w.drive.handle(method, args);
			}, _canceled);
			return result ? *result : std::nullopt;
		}
		return std::nullopt;
	}

	std::optional<exportdata::ZipWriter::ChunkSource> blob(const std::string &method, const json &args) override {
		auto bytes = std::optional<std::string>();
		if (method == "parvaneExportMedia") {
			const auto fileId = args.value("fileId", std::string());
			const auto i = _keys.find(fileId);
			const auto cap = _caps.find(fileId);
			const auto kind = (cap != _caps.end()) ? cap->second.first : std::string();
			const auto size = (cap != _caps.end()) ? cap->second.second : std::int64_t(0);
			bytes = (i != _keys.end())
				? ExportMediaBytes(fileId, i->second.first, i->second.second, kind, size)
				: ExportMediaBytes(fileId, std::string(), std::string(), kind, size);
		} else if (method == "parvaneCloudExportBlob") {
			const auto container = args.value("container", std::string());
			const auto node = args.value("node", std::string());
			auto result = OnSections<std::optional<std::string>>([=](Sections::Workers &w)
					-> std::optional<std::string> {
				auto got = cloud::CloudFiles(w.drive).download(container, node);
				if (!got.ok) {
					return std::nullopt;
				}
				return std::move(got.bytes);
			}, _canceled);
			if (!result) {
				throw exportdata::ExportError(exportdata::ExportErrorCode::Canceled);
			}
			bytes = std::move(*result);
		}
		if (!bytes) {
			return std::nullopt;
		}
		return Chunks(std::move(*bytes));
	}

	std::int64_t nowMs() override {
		return QDateTime::currentMSecsSinceEpoch();
	}

	void sleepMs(std::int64_t ms) override {
		std::this_thread::sleep_for(std::chrono::milliseconds(ms));
	}

private:
	json _snapshot;
	json _planner;
	std::function<bool()> _canceled;
	std::map<std::string, std::pair<std::string, std::string>> _keys;
	std::map<std::string, std::pair<std::string, std::int64_t>> _caps; // вид и заявленный размер — потолок скачивания

};

// Связь потока выгрузки с окном: поля трогает только главный поток
struct Bridge {
	QPointer<Ui::GenericBox> box;
	Fn<void(exportdata::ExportProgress)> progress;
	Fn<void(QString path, exportdata::ExportResult result)> done;
	Fn<void(QString error)> failed;
	std::atomic<bool> canceled = false;
};

[[nodiscard]] QString StageText(const exportdata::ExportProgress &progress) {
	const auto done = QString::number(progress.done);
	const auto total = QString::number(progress.total);
	if (progress.stage == "chats") {
		return tr::lng_parvane_export_stage_chats(tr::now, lt_done, done, lt_total, total);
	} else if (progress.stage == "planner") {
		return tr::lng_parvane_export_stage_planner(tr::now);
	} else if (progress.stage == "notes") {
		return tr::lng_parvane_export_stage_notes(tr::now, lt_done, done, lt_total, total);
	} else if (progress.stage == "contacts") {
		return tr::lng_parvane_export_stage_contacts(tr::now);
	} else if (progress.stage == "cloud") {
		return tr::lng_parvane_export_stage_cloud(tr::now, lt_done, done, lt_total, total);
	} else if (progress.stage == "finishing") {
		return tr::lng_parvane_export_stage_finishing(tr::now);
	}
	return tr::lng_parvane_export_stage_prepare(tr::now);
}

[[nodiscard]] QString ErrorText(exportdata::ExportErrorCode code) {
	switch (code) {
	case exportdata::ExportErrorCode::Canceled: return tr::lng_parvane_export_error_canceled(tr::now);
	case exportdata::ExportErrorCode::TooLarge: return tr::lng_parvane_export_error_too_large(tr::now);
	case exportdata::ExportErrorCode::Failed: break;
	}
	return tr::lng_parvane_export_error_failed(tr::now);
}

// Свободное имя в папке: `a.zip` → `a (2).zip`
[[nodiscard]] QString FreePath(const QString &folder, const QString &name) {
	const auto dir = QDir(folder);
	auto path = dir.filePath(name);
	const auto info = QFileInfo(name);
	const auto base = info.completeBaseName();
	const auto suffix = info.suffix().isEmpty() ? QString() : (u"."_q + info.suffix());
	for (auto i = 2; QFile::exists(path); ++i) {
		path = dir.filePath(base + u" (%1)"_q.arg(i) + suffix);
	}
	return path;
}

[[nodiscard]] QString &LastFolder() {
	static auto result = QString();
	return result;
}

[[nodiscard]] QString DefaultFolder() {
	if (!LastFolder().isEmpty() && QDir(LastFolder()).exists()) {
		return LastFolder();
	}
	const auto downloads = QStandardPaths::writableLocation(QStandardPaths::DownloadLocation);
	return downloads.isEmpty() ? QDir::homePath() : downloads;
}

// Запуск выгрузки в фоне: архив пишется во временный файл папки, по готовности переименовывается
void Run(
		std::shared_ptr<Bridge> bridge,
		std::string snapshot,
		json planner,
		QString folder,
		exportdata::ExportOptions options) {
	const auto labels = Labels();
	const auto drive = tr::lng_parvane_cloud_drive(tr::now).toStdString();
	crl::async([=] {
		const auto post = [bridge](auto &&fn) {
			crl::on_main([bridge, fn = std::forward<decltype(fn)>(fn)]() mutable {
				if (bridge->box && bridge->done) {
					fn();
				}
			});
		};
		const auto temp = QDir(folder).filePath(
			u".parvane-export-"_q + QUuid::createUuid().toString(QUuid::WithoutBraces) + u".part"_q);
		auto file = QFile(temp);
		if (!file.open(QIODevice::WriteOnly)) {
			post([bridge] { bridge->failed(tr::lng_parvane_export_error_write(tr::now)); });
			return;
		}
		// архив — личные данные: только владельцу (не по umask)
		file.setPermissions(QFileDevice::ReadOwner | QFileDevice::WriteOwner);
		auto writeFailed = false;
		const auto canceled = [bridge] { return bridge->canceled.load(); };
		auto host = Host(json::parse(snapshot, nullptr, false), planner, canceled);
		auto args = exportdata::ExportRunArgs();
		args.source = exportdata::createProviderSource(host, exportdata::ProviderNames{ drive }, canceled);
		args.options = options;
		args.labels = labels;
		args.canceled = canceled;
		args.nowUnixMs = QDateTime::currentMSecsSinceEpoch();
		args.localTime = LocalCivil;
		args.sink = [&](const uint8_t *data, size_t size) {
			if (file.write(reinterpret_cast<const char*>(data), qint64(size)) != qint64(size)) {
				writeFailed = true;
				throw exportdata::ExportError(exportdata::ExportErrorCode::Failed, "write");
			}
		};
		auto lastStage = std::string();
		auto lastAt = std::int64_t(0);
		args.onProgress = [&](const exportdata::ExportProgress &progress) {
			const auto now = QDateTime::currentMSecsSinceEpoch();
			if (progress.stage == lastStage && now - lastAt < kProgressEveryMs) {
				return;
			}
			lastStage = progress.stage;
			lastAt = now;
			post([bridge, progress] { bridge->progress(progress); });
		};
		try {
			const auto result = exportdata::runDataExport(args);
			file.close();
			const auto path = FreePath(folder, Q(result.fileName));
			if (!QFile::rename(temp, path)) {
				QFile::remove(temp);
				post([bridge] { bridge->failed(tr::lng_parvane_export_error_write(tr::now)); });
				return;
			}
			post([bridge, path, result] { bridge->done(path, result); });
		} catch (const exportdata::ExportError &e) {
			file.close();
			QFile::remove(temp);
			const auto text = writeFailed
				? tr::lng_parvane_export_error_write(tr::now)
				: bridge->canceled.load()
				? ErrorText(exportdata::ExportErrorCode::Canceled)
				: ErrorText(e.code());
			post([bridge, text] { bridge->failed(text); });
		} catch (const std::exception &e) {
			file.close();
			QFile::remove(temp);
			LOG(("Parvane: выгрузка данных не удалась: %1").arg(QString::fromUtf8(e.what())));
			const auto text = bridge->canceled.load()
				? ErrorText(exportdata::ExportErrorCode::Canceled)
				: ErrorText(exportdata::ExportErrorCode::Failed);
			post([bridge, text] { bridge->failed(text); });
		}
	});
}

// Адреса контактов устройства (список «Контакты» tdesktop)
[[nodiscard]] QStringList ContactAddresses(not_null<Main::Session*> session) {
	auto result = QStringList();
	for (const auto &row : session->data().contactsList()->all()) {
		if (const auto history = row->history()) {
			if (const auto user = history->peer->asUser()) {
				if (const auto address = AddressForUser(user); !address.isEmpty()) {
					result.push_back(address);
				}
			}
		}
	}
	return result;
}

} // namespace

void ShowDataExportBox(not_null<Window::SessionController*> controller) {
	const auto weakController = base::make_weak(controller.get());
	controller->show(Box([=](not_null<Ui::GenericBox*> box) {
		const auto bridge = std::make_shared<Bridge>();
		bridge->box = box.get();
		const auto running = box->lifetime().make_state<bool>(false);
		const auto folder = box->lifetime().make_state<QString>(DefaultFolder());
		const auto savedPath = box->lifetime().make_state<QString>();

		box->setTitle(tr::lng_parvane_export_title());
		box->setWidth(st::boxWideWidth);
		box->addRow(object_ptr<Ui::FlatLabel>(box, tr::lng_parvane_export_hint(), st::boxLabel));
		const auto media = box->addRow(
			object_ptr<Ui::Checkbox>(box, tr::lng_parvane_export_media(tr::now), true, st::defaultBoxCheckbox),
			st::boxRowPadding + QMargins(0, st::boxLittleSkip, 0, 0));
		const auto cloudBox = box->addRow(
			object_ptr<Ui::Checkbox>(box, tr::lng_parvane_export_cloud(tr::now), false, st::defaultBoxCheckbox),
			st::boxRowPadding + QMargins(0, st::boxLittleSkip, 0, 0));
		box->addRow(object_ptr<Ui::FlatLabel>(box, tr::lng_parvane_export_cloud_hint(), st::boxDividerLabel));

		const auto folderLabel = box->addRow(
			object_ptr<Ui::FlatLabel>(box, QString(), st::boxLabel),
			st::boxRowPadding + QMargins(0, st::boxLittleSkip, 0, 0));
		const auto refreshFolder = [=] {
			folderLabel->setText(tr::lng_parvane_export_folder(tr::now, lt_path, QDir::toNativeSeparators(*folder)));
		};
		refreshFolder();
		const auto change = box->addRow(
			object_ptr<Ui::LinkButton>(box, tr::lng_parvane_export_folder_change(tr::now)),
			st::boxRowPadding + QMargins(0, st::boxLittleSkip, 0, 0));
		change->setClickedCallback([=] {
			if (*running) {
				return;
			}
			FileDialog::GetFolder(box.get(), tr::lng_parvane_export_folder_choose(tr::now), *folder, [=](QString &&path) {
				if (!path.isEmpty()) {
					*folder = LastFolder() = path;
					refreshFolder();
				}
			});
		});

		// Ход: полоса, этап, записано
		const auto progressWrap = box->addRow(
			object_ptr<Ui::SlideWrap<Ui::VerticalLayout>>(box, object_ptr<Ui::VerticalLayout>(box)),
			st::boxRowPadding + QMargins(0, st::boxLittleSkip, 0, 0));
		const auto progressBox = progressWrap->entity();
		const auto bar = progressBox->add(object_ptr<Kit::Progress>(progressBox));
		const auto stage = progressBox->add(
			object_ptr<Ui::FlatLabel>(progressBox, QString(), st::boxDividerLabel),
			QMargins(0, st::boxLittleSkip, 0, 0));
		const auto written = progressBox->add(object_ptr<Ui::FlatLabel>(progressBox, QString(), st::boxDividerLabel));
		progressWrap->hide(anim::type::instant);

		// Итог либо ошибка
		const auto result = box->addRow(
			object_ptr<Ui::FlatLabel>(box, QString(), st::boxLabel),
			st::boxRowPadding + QMargins(0, st::boxLittleSkip, 0, 0));
		const auto missing = box->addRow(object_ptr<Ui::FlatLabel>(box, QString(), st::boxDividerLabel));
		const auto error = box->addRow(object_ptr<Ui::FlatLabel>(box, QString(), st::boxLabel));
		error->setTextColorOverride(st::boxTextFgError->c);
		result->hide();
		missing->hide();
		error->hide();

		const auto setRunning = [=](bool value) {
			*running = value;
			media->setDisabled(value);
			cloudBox->setDisabled(value);
			change->setDisabled(value);
			progressWrap->toggle(value, anim::type::instant);
		};

		const auto refreshButtons = std::make_shared<Fn<void()>>();
		const auto plannerMissing = box->lifetime().make_state<bool>(false);
		const auto plannerNote = box->addRow(object_ptr<Ui::FlatLabel>(
			box,
			tr::lng_parvane_export_planner_missing(tr::now),
			st::boxDividerLabel));
		plannerNote->hide();

		// Сборка в фоне: снимок переписки и «План» — с главного потока на момент запуска
		const auto launch = [=](std::optional<json> planner) {
			*plannerMissing = !planner.has_value();
			const auto session = &controller->session();
			auto snapshot = ExportSnapshotJson(ContactAddresses(session));
			if (snapshot.empty()) {
				bridge->failed(tr::lng_parvane_export_error_failed(tr::now));
				return;
			}
			stage->setText(tr::lng_parvane_export_stage_prepare(tr::now));
			Run(
				bridge,
				std::move(snapshot),
				planner.value_or(json{ { "status", "offline" } }),
				*folder,
				exportdata::ExportOptions{ media->checked(), cloudBox->checked() });
		};
		// «План» в архив попадает всегда: не загружен в этом сеансе — модуль поднимается, ждём до 30 с; без ключа,
		// без привязки устройства или по истечении — выгрузка идёт без него, и итог об этом говорит
		const auto waitPlanner = std::make_shared<Fn<void(int)>>();
		*waitPlanner = [=](int attempt) {
			if (bridge->canceled) {
				bridge->failed(ErrorText(exportdata::ExportErrorCode::Canceled));
				return;
			}
			const auto view = Sections::Planner();
			if (view && view->isLoaded) {
				launch(json{ { "status", "ready" }, { "raw", json(view->state).dump() } });
				return;
			}
			const auto hopeless = view && (view->status == "needs-linking" || view->status == "no-key");
			if (hopeless || attempt >= kPlannerWaitAttempts) {
				launch(std::nullopt);
				return;
			}
			if (attempt == 0) {
				Sections::Post([](Sections::Workers &w) {
					w.plannerSync.ensure(false);
				});
			}
			base::call_delayed(kPlannerWaitStepMs, box, [=] {
				(*waitPlanner)(attempt + 1);
			});
		};
		const auto start = [=] {
			if (*running) {
				return;
			}
			if (!QDir(*folder).exists()) {
				error->setText(tr::lng_parvane_export_error_write(tr::now));
				error->show();
				return;
			}
			bridge->canceled = false;
			*plannerMissing = false;
			result->hide();
			missing->hide();
			plannerNote->hide();
			error->hide();
			bar->setValue(0.);
			stage->setText(tr::lng_parvane_export_stage_planner(tr::now));
			written->setText(QString());
			setRunning(true);
			(*refreshButtons)();
			(*waitPlanner)(0);
		};

		bridge->progress = [=](exportdata::ExportProgress progress) {
			bar->setValue(progress.total
				? std::min(1., double(progress.done) / double(progress.total))
				: 0.);
			stage->setText(StageText(progress));
			written->setText(progress.bytes
				? tr::lng_parvane_export_written(tr::now, lt_size, Ui::FormatSizeText(qint64(progress.bytes)))
				: QString());
		};
		bridge->done = [=](QString path, exportdata::ExportResult done) {
			setRunning(false);
			*savedPath = path;
			const auto name = QFileInfo(path).fileName();
			result->setText(tr::lng_parvane_export_done(
				tr::now,
				lt_name,
				name,
				lt_size,
				Ui::FormatSizeText(qint64(QFileInfo(path).size()))));
			result->show();
			plannerNote->setVisible(*plannerMissing);
			const auto lost = done.mediaFailed + done.cloudFailed;
			if (lost > 0) {
				missing->setText(tr::lng_parvane_export_done_missing(tr::now, lt_amount, QString::number(lost)));
				missing->show();
			}
			(*refreshButtons)();
			if (const auto strong = weakController.get()) {
				strong->showToast(tr::lng_parvane_export_toast(tr::now, lt_name, name));
			}
		};
		bridge->failed = [=](QString text) {
			setRunning(false);
			error->setText(text);
			error->show();
			(*refreshButtons)();
		};

		*refreshButtons = [=] {
			box->clearButtons();
			if (*running) {
				box->addButton(tr::lng_cancel(), [=] {
					bridge->canceled = true;
				});
				return;
			}
			box->addButton(tr::lng_parvane_export_start(), start);
			box->addButton(tr::lng_close(), [=] { box->closeBox(); });
			if (!savedPath->isEmpty()) {
				box->addLeftButton(tr::lng_parvane_export_show(), [=] {
					File::ShowInFolder(*savedPath);
				});
			}
		};
		(*refreshButtons)();

		// Закрытие окна посреди выгрузки — та же отмена (как web)
		box->boxClosing() | rpl::on_next([=] {
			bridge->canceled = true;
		}, box->lifetime());
		// Окно ушло: поток выгрузки досрочно останавливается, связи с виджетами окна рвутся
		box->lifetime().add([bridge, waitPlanner] {
			bridge->canceled = true;
			bridge->progress = nullptr;
			bridge->done = nullptr;
			bridge->failed = nullptr;
			*waitPlanner = nullptr;
		});
	}));
}

} // namespace Parvane
