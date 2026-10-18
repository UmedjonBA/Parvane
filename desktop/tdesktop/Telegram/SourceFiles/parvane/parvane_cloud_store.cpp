// Parvane fork: состояние и действия раздела «Облако» (spec 029, T064) — порт web `cloud/cloudStore.ts`: разбор
// снимка CloudView, место в списке, сортировка (настройка устройства), переносы с ходом и отменой, уведомление,
// свои ссылки, миниатюры. Сеть и крипто — задания в рабочий поток разделов (`Sections::Ask`, CloudFiles ядра).
#include "parvane/parvane_cloud_internal.h"

#include "core/file_utilities.h"
#include "lang/lang_instance.h"
#include "lang/lang_keys.h"
#include "settings.h"
#include "ui/text/format_values.h"

#include <QtCore/QBuffer>
#include <QtCore/QDateTime>
#include <QtCore/QDir>
#include <QtCore/QFile>
#include <QtCore/QFileInfo>
#include <QtCore/QLocale>
#include <QtCore/QMimeDatabase>
#include <QtCore/QStandardPaths>
#include <QtCore/QTimer>
#include <QtCore/QUuid>
#include <QtGui/QImageReader>

#include <deque>

namespace Parvane {
QString GatewayUrl(); // parvane_client.cpp: адрес gateway (v2-сессия)
} // namespace Parvane

namespace Parvane::Cloud {
namespace {

constexpr auto kNoticeHideMs = 4000;
constexpr auto kDoneHideMs = 4000;
constexpr auto kUsageRefreshMs = 1600;
constexpr auto kThumbCache = 300;
constexpr auto kThumbMaxSide = 320;
constexpr auto kThumbQuality = 80;
constexpr auto kThumbSourceMaxBytes = std::int64_t(40) * 1024 * 1024;

struct UploadSpec {
	std::string container;
	std::optional<std::string> parent;
	QString name;
	QString path;
};

struct State {
	Data data;
	bool loaded = false;
	std::uint64_t revision = 0;
	Place place;
	cloud::Sort sort;
	bool sortRead = false;
	std::vector<Transfer> transfers;
	std::map<QString, UploadSpec> uploads;
	std::optional<QString> notice;
	int noticeSeq = 0;
	std::optional<json> links;
	std::optional<LinkProgress> linkProgress;
	std::map<QString, QImage> thumbs;
	std::deque<QString> thumbOrder;
	std::set<QString> thumbLoading;
	int seq = 0;
	rpl::event_stream<> dataChanges;
	rpl::event_stream<> storeChanges;
	QTimer *usageTimer = nullptr;
	rpl::lifetime lifetime;
};

State &St();

void FireStore() {
	St().storeChanges.fire({});
}

QString NewId(const char *prefix) {
	return QString::fromLatin1(prefix) + u"-"_q + QString::number(QDateTime::currentMSecsSinceEpoch()) + u"-"_q
		+ QString::number(++St().seq);
}

QString PrefsPath() {
	return cWorkingDir() + u"tdata/parvane-cloud-prefs.json"_q;
}

void ReadSort() {
	auto &st = St();
	if (st.sortRead) {
		return;
	}
	st.sortRead = true;
	auto f = QFile(PrefsPath());
	if (!f.open(QIODevice::ReadOnly)) {
		return;
	}
	try {
		const auto saved = json::parse(f.readAll().toStdString());
		const auto key = saved.value("sort", json::object()).value("key", std::string());
		st.sort.key = key == "date" ? cloud::SortKey::Date : key == "size" ? cloud::SortKey::Size : cloud::SortKey::Name;
		st.sort.isDescending = saved.value("sort", json::object()).value("isDescending", false);
	} catch (const std::exception &) {
		// Настройка вида не прочиталась — раздел работает и без неё
	}
}

void WriteSort() {
	const auto &sort = St().sort;
	const auto key = sort.key == cloud::SortKey::Date ? "date" : sort.key == cloud::SortKey::Size ? "size" : "name";
	auto f = QFile(PrefsPath());
	if (f.open(QIODevice::WriteOnly)) {
		f.write(QByteArray::fromStdString(json{ { "sort", { { "key", key }, { "isDescending", sort.isDescending } } } }.dump()));
	}
}

// Открытая папка или контейнер исчезли (удалены, доступ отозван) — подняться выше (web `fixPlace`)
void FixPlace() {
	auto &st = St();
	auto place = st.place;
	if (!place.container.empty() && !ContainerOf(place.container)) {
		st.place = place.view.isEmpty() ? Place() : Place{ place.view, {}, {} };
		return;
	}
	if (place.folder.empty()) {
		return;
	}
	const auto id = place.container.empty() ? st.data.rootId.value_or(std::string()) : place.container;
	const auto &nodes = NodesOf(id);
	const auto it = std::find_if(nodes.begin(), nodes.end(), [&](const CloudNode &n) { return n.id == place.folder; });
	if (it == nodes.end() || it->trashed) {
		st.place = Place{ place.view, place.container, {} };
	}
}

void Parse(const std::shared_ptr<const Sections::CloudView> &view) {
	auto &st = St();
	auto data = Data();
	data.view = view;
	data.status = view->status;
	data.rootId = view->rootId;
	data.containers = view->containers;
	data.usage = view->usage;
	const auto &state = view->state;
	if (state.is_object() && state.contains("trees") && state["trees"].is_object()) {
		for (const auto &[id, tree] : state["trees"].items()) {
			if (!tree.is_object() || !tree.contains("nodes") || !tree["nodes"].is_array()) {
				continue;
			}
			auto nodes = std::vector<CloudNode>();
			for (const auto &n : tree["nodes"]) {
				try {
					nodes.push_back(n.get<CloudNode>());
				} catch (const std::exception &) {
				}
			}
			data.trees[id] = std::move(nodes);
			data.rawNodes[id] = tree["nodes"];
		}
	}
	const auto changed = (view->revision != st.revision);
	st.revision = view->revision;
	st.data = std::move(data);
	if (st.data.status != "needs-linking" && st.data.status != "loading") {
		st.loaded = true;
		FixPlace();
	}
	// Занятое место меняется вместе с деревом (чужая загрузка, сборка стёртых блобов)
	if (changed && st.loaded && st.usageTimer) {
		st.usageTimer->start(kUsageRefreshMs);
	}
	st.dataChanges.fire({});
}

State &St() {
	static auto result = State();
	static auto subscribed = false;
	if (!subscribed) {
		subscribed = true;
		ReadSort();
		result.usageTimer = new QTimer();
		result.usageTimer->setSingleShot(true);
		QObject::connect(result.usageTimer, &QTimer::timeout, [] { RefreshUsage(); });
		Sections::CloudValue() | rpl::on_next([](std::shared_ptr<const Sections::CloudView> view) {
			if (view) {
				Parse(view);
			}
		}, result.lifetime);
	}
	return result;
}

Transfer *FindTransfer(const QString &id) {
	auto &list = St().transfers;
	const auto it = std::find_if(list.begin(), list.end(), [&](const Transfer &t) { return t.id == id; });
	return it == list.end() ? nullptr : &*it;
}

void DismissTransfer(const QString &id) {
	auto &list = St().transfers;
	list.erase(std::remove_if(list.begin(), list.end(), [&](const Transfer &t) { return t.id == id; }), list.end());
	St().uploads.erase(id);
	FireStore();
}

// Итог переноса: done — скрыть через 4 с, canceled — сразу (web applyTransferEvent)
void FinishTransfer(const QString &id, const json &result) {
	const auto t = FindTransfer(id);
	if (!t) {
		return;
	}
	if (result.value("ok", false)) {
		t->state = u"done"_q;
		t->done = t->total;
		if (t->kind == u"upload"_q) {
			St().uploads.erase(id);
		}
		QTimer::singleShot(kDoneHideMs, [=] { DismissTransfer(id); });
	} else if (result.value("canceled", false) || (t->cancel && t->cancel->load())) {
		t->state = u"canceled"_q;
		DismissTransfer(id);
		return;
	} else {
		t->state = u"failed"_q;
		t->error = Q(result.value("error", std::string("rejected")));
		t->done = 0;
	}
	FireStore();
}

QString Origin() {
	return Q(cloud::originOfGateway(GatewayUrl().toStdString()));
}

void ApplyOps(const std::string &container, json ops, Fn<void(bool)> done = nullptr) {
	if (ops.empty()) {
		if (done) {
			done(true);
		}
		return;
	}
	Sections::CallCloud("parvaneCloudApply", json{ { "container", container.empty() ? "root" : container }, { "ops", ops } },
		[done](std::optional<json> result) {
			const auto ok = result && result->value("ok", false);
			if (!ok) {
				ShowNotice(Q(result ? result->value("error", std::string("rejected")) : std::string("rejected")));
			}
			if (done) {
				done(ok);
			}
		});
}

std::int64_t NowMs() {
	return QDateTime::currentMSecsSinceEpoch();
}

void RunUpload(const QString &id) {
	const auto i = St().uploads.find(id);
	const auto t = FindTransfer(id);
	if (i == St().uploads.end() || !t) {
		return;
	}
	const auto spec = i->second;
	const auto cancel = t->cancel;
	Sections::Ask<json>([spec, cancel](Sections::Workers &w) -> json {
		if (cancel->load()) {
			return json{ { "ok", false }, { "canceled", true } };
		}
		auto file = QFile(spec.path);
		if (!file.open(QIODevice::ReadOnly)) {
			return json{ { "ok", false }, { "error", "not-found" } };
		}
		auto request = cloud::UploadRequest();
		request.container = spec.container;
		request.parent = spec.parent;
		request.name = S(spec.name);
		const auto info = QFileInfo(spec.path);
		request.mtime = info.lastModified().toMSecsSinceEpoch();
		request.mime = QMimeDatabase().mimeTypeForFile(info).name().toStdString();
		const auto bytes = file.readAll();
		request.bytes = bytes.toStdString();
		// Миниатюра картинки: JPEG не больше 320 px по длинной стороне (web makeThumb)
		if (QString::fromStdString(request.mime).startsWith(u"image/"_q) && bytes.size() <= kThumbSourceMaxBytes) {
			auto image = QImage::fromData(bytes);
			if (!image.isNull()) {
				if (std::max(image.width(), image.height()) > kThumbMaxSide) {
					image = image.scaled(kThumbMaxSide, kThumbMaxSide, Qt::KeepAspectRatio, Qt::SmoothTransformation);
				}
				auto jpeg = QByteArray();
				auto buffer = QBuffer(&jpeg);
				buffer.open(QIODevice::WriteOnly);
				if (image.convertToFormat(QImage::Format_RGB32).save(&buffer, "JPEG", kThumbQuality)) {
					request.thumb = cloud::UploadThumb{ jpeg.toStdString(), image.width(), image.height() };
				}
			}
		}
		if (cancel->load()) {
			return json{ { "ok", false }, { "canceled", true } };
		}
		return cloud::CloudFiles(w.drive).upload(request);
	}, [id](json result) {
		FinishTransfer(id, result);
		if (result.value("ok", false)) {
			RefreshUsage();
		}
	});
}

} // namespace

// ── данные ───────────────────────────────────────────────────────────────────

QString KeyOf(const Entry &entry) {
	return Q(entry.container) + '/' + Q(entry.node.id);
}

const Data &Current() {
	return St().data;
}

rpl::producer<> DataChanges() {
	return St().dataChanges.events();
}

bool IsLoaded() {
	return St().loaded;
}

const CloudContainerInfo *ContainerOf(const std::string &id) {
	if (id.empty()) {
		return nullptr;
	}
	for (const auto &c : St().data.containers) {
		if (c.id == id) {
			return &c;
		}
	}
	return nullptr;
}

const std::vector<CloudNode> &NodesOf(const std::string &id) {
	static const auto empty = std::vector<CloudNode>();
	const auto &trees = St().data.trees;
	const auto it = trees.find(id);
	return it == trees.end() ? empty : it->second;
}

std::optional<json> RawNode(const std::string &container, const std::string &id) {
	const auto &raw = St().data.rawNodes;
	const auto it = raw.find(container);
	if (it == raw.end()) {
		return std::nullopt;
	}
	for (const auto &n : it->second) {
		if (n.value("id", std::string()) == id) {
			return n;
		}
	}
	return std::nullopt;
}

bool CanEdit(const std::string &container) {
	if (container.empty()) {
		return true;
	}
	const auto c = ContainerOf(container);
	return !c || c->role == "owner" || c->role == "editor";
}

std::string ActiveContainer(const Place &place) {
	return !place.container.empty() ? place.container : St().data.rootId.value_or(std::string());
}

std::vector<Entry> Trash() {
	auto trees = std::map<std::string, std::vector<CloudNode>>(St().data.trees);
	auto result = std::vector<Entry>();
	for (const auto &[container, node] : cloud::trashAcross(St().data.containers, trees)) {
		result.push_back({ container, node });
	}
	return result;
}

// ── хранилище ────────────────────────────────────────────────────────────────

const std::vector<Transfer> &Transfers() {
	return St().transfers;
}

std::optional<QString> Notice() {
	return St().notice;
}

const std::optional<json> &Links() {
	return St().links;
}

const std::optional<LinkProgress> &CurrentLinkProgress() {
	return St().linkProgress;
}

rpl::producer<> StoreChanges() {
	return St().storeChanges.events();
}

const Place &CurrentPlace() {
	return St().place;
}

void SetPlace(Place place) {
	if (St().place == place) {
		return;
	}
	St().place = std::move(place);
	FireStore();
}

cloud::Sort CurrentSort() {
	ReadSort();
	return St().sort;
}

void SetSort(cloud::Sort sort) {
	St().sort = sort;
	WriteSort();
	FireStore();
}

void ShowNotice(const QString &code) {
	auto &st = St();
	st.notice = code;
	const auto seq = ++st.noticeSeq;
	QTimer::singleShot(kNoticeHideMs, [=] {
		if (St().noticeSeq == seq) {
			HideNotice();
		}
	});
	FireStore();
}

void HideNotice() {
	if (St().notice) {
		St().notice.reset();
		FireStore();
	}
}

// ── подписи ──────────────────────────────────────────────────────────────────

QString Q(const std::string &text) {
	return QString::fromStdString(text);
}

std::string S(const QString &text) {
	return text.toStdString();
}

QString ErrorText(const QString &code) {
	if (code == u"offline"_q) return tr::lng_parvane_cloud_error_offline(tr::now);
	if (code == u"no-space"_q) return tr::lng_parvane_cloud_error_no_space(tr::now);
	if (code == u"too-large"_q) return tr::lng_parvane_cloud_error_too_large(tr::now);
	if (code == u"forbidden"_q) return tr::lng_parvane_cloud_error_forbidden(tr::now);
	if (code == u"not-found"_q) return tr::lng_parvane_cloud_error_not_found(tr::now);
	if (code == u"too-many"_q) return tr::lng_parvane_cloud_error_too_many(tr::now);
	if (code == u"link-too-many"_q) return tr::lng_parvane_cloud_link_error_too_many(tr::now);
	if (code == u"link-limit"_q) return tr::lng_parvane_cloud_link_error_limit(tr::now);
	if (code == u"link-disabled"_q) return tr::lng_parvane_cloud_link_error_disabled(tr::now);
	return tr::lng_parvane_cloud_error_rejected(tr::now);
}

QString NoticeText(const QString &code) {
	if (code == u"saved"_q) return tr::lng_parvane_cloud_saved_to_cloud(tr::now);
	if (code == u"sent"_q) return tr::lng_parvane_cloud_sent_to_chat(tr::now);
	return ErrorText(code);
}

QString FormatSize(std::int64_t bytes) {
	return Ui::FormatSizeText(bytes);
}

namespace {

QLocale UiLocale() {
	return QLocale(Lang::GetInstance().id());
}

} // namespace

QString ShortDate(std::int64_t ms, bool withYear) {
	if (!ms) {
		return QString();
	}
	const auto date = QDateTime::fromMSecsSinceEpoch(ms).date();
	auto text = UiLocale().toString(date, withYear ? u"d MMM yyyy"_q : u"d MMM"_q);
	if (!withYear && text.endsWith('.')) {
		text.chop(1);
	}
	return text;
}

QString LongDate(std::int64_t seconds) {
	const auto date = QDateTime::fromSecsSinceEpoch(seconds).date();
	return UiLocale().toString(date, u"d MMMM yyyy"_q);
}

QString NameOf(const std::string &address) {
	const auto at = address.find('@');
	return Q(at == std::string::npos ? address : address.substr(0, at));
}

QString ContainerName(const CloudContainerInfo *container) {
	return (container && !container->name.empty())
		? Q(container->name)
		: tr::lng_parvane_cloud_shared_folder(tr::now);
}

QString VirtualName(const QString &view) {
	if (view == u"shared"_q) return tr::lng_parvane_cloud_tab_shared(tr::now);
	if (view == u"links"_q) return tr::lng_parvane_cloud_links(tr::now);
	return tr::lng_parvane_cloud_tab_trash(tr::now);
}

QString RoleTitle(const std::string &role) {
	if (role == "owner") return tr::lng_parvane_cloud_role_owner(tr::now);
	if (role == "editor") return tr::lng_parvane_cloud_role_editor(tr::now);
	return tr::lng_parvane_cloud_role_reader(tr::now);
}

QString ItemsText(int count) {
	return tr::lng_parvane_cloud_items(tr::now, lt_count, count);
}

QString NameErrorText(std::optional<cloud::NameError> error) {
	if (!error) {
		return QString();
	}
	switch (*error) {
	case cloud::NameError::Empty: return tr::lng_parvane_cloud_error_name_empty(tr::now);
	case cloud::NameError::TooLong: return tr::lng_parvane_cloud_error_name_long(tr::now);
	default: break;
	}
	return tr::lng_parvane_cloud_error_name_chars(tr::now);
}

// ── действия ─────────────────────────────────────────────────────────────────

void Load() {
	(void)St();
	RefreshUsage();
	// Непривязанному устройству методы ссылок недоступны — список остаётся незагруженным
	if (St().data.status != "needs-linking") {
		RefreshLinks();
	}
}

void SetActive(bool active) {
	Sections::CallCloud("parvaneCloudSetActive", json{ { "isActive", active } }, nullptr);
}

void RefreshUsage() {
	Sections::CallCloud("parvaneCloudUsage", json::object(), nullptr);
}

void RefreshLinks() {
	const auto origin = S(Origin());
	Sections::Ask<json>([origin](Sections::Workers &w) {
		return cloud::CloudFiles(w.drive).links(origin);
	}, [](json result) {
		if (result.value("ok", false)) {
			St().links = result["links"];
			FireStore();
		}
	});
}

void CreateFolder(const QString &name) {
	const auto place = St().place;
	const auto container = ActiveContainer(place);
	const auto folder = place.folder.empty() ? std::optional<std::string>() : std::optional(place.folder);
	ApplyOps(container, cloud::createFolderOps(NodesOf(container), folder, S(name), cloud::newCloudNodeId()));
}

void Rename(const Entry &entry, const QString &name) {
	ApplyOps(entry.container, cloud::renameOps(NodesOf(entry.container), entry.node, S(name)));
}

void MoveNodes(const std::string &container, const std::vector<CloudNode> &nodes, std::optional<std::string> target) {
	ApplyOps(container, cloud::moveOps(NodesOf(container), nodes, target));
}

void MoveAcross(
		const std::string &from,
		const std::vector<CloudNode> &nodes,
		const std::string &to,
		std::optional<std::string> target) {
	if (nodes.empty()) {
		return;
	}
	auto taken = cloud::namesIn(NodesOf(to), target);
	auto items = std::vector<cloud::MoveItem>();
	auto total = std::int64_t(0);
	for (const auto &n : nodes) {
		const auto name = cloud::freeName(taken, n.name);
		taken.push_back(name);
		items.push_back({ n.id, name });
		total += cloud::sizeOf(NodesOf(from), n.id);
	}
	const auto id = NewId("move");
	const auto cancel = std::make_shared<std::atomic<bool>>(false);
	const auto name = nodes.size() > 1
		? (Q(nodes[0].name) + u" +"_q + QString::number(nodes.size() - 1))
		: Q(nodes[0].name);
	St().transfers.push_back({ id, u"move"_q, name, 0, total, u"active"_q, QString(), cancel });
	FireStore();
	Sections::Ask<json>([=](Sections::Workers &w) {
		return cloud::CloudFiles(w.drive).move(from, items, to, target, [id](std::int64_t done, std::int64_t all) {
			Sections::PostMain([=] {
				if (const auto t = FindTransfer(id)) {
					t->done = done;
					t->total = all;
					FireStore();
				}
			});
		}, [cancel] { return cancel->load(); });
	}, [id](json result) {
		FinishTransfer(id, result);
		RefreshUsage();
	});
}

void TrashNodes(const std::string &container, const std::vector<CloudNode> &nodes) {
	ApplyOps(container, cloud::trashOps(nodes, NowMs()));
}

void RestoreNodes(const std::string &container, const std::vector<CloudNode> &nodes) {
	ApplyOps(container, cloud::restoreOps(NodesOf(container), nodes));
}

void PurgeNodes(const std::string &container, const std::vector<CloudNode> &nodes) {
	ApplyOps(container, cloud::purgeOps(nodes, NowMs()), [](bool ok) {
		if (ok) {
			Sections::CallCloud("parvaneCloudSync", json::object(), [](std::optional<json>) {
				RefreshUsage();
			});
		}
	});
}

void RunByContainer(const std::vector<Entry> &list, Fn<void(const std::string&, const std::vector<CloudNode>&)> run) {
	auto grouped = std::map<std::string, std::vector<CloudNode>>();
	auto order = std::vector<std::string>();
	for (const auto &e : list) {
		if (!grouped.count(e.container)) {
			order.push_back(e.container);
		}
		grouped[e.container].push_back(e.node);
	}
	for (const auto &id : order) {
		run(id, grouped[id]);
	}
}

void EmptyTrash() {
	RunByContainer(Trash(), [](const std::string &container, const std::vector<CloudNode> &nodes) {
		PurgeNodes(container, nodes);
	});
}

void ShareFolder(const Entry &entry, Fn<void(std::optional<std::string>)> done) {
	const auto id = NewId("move");
	const auto cancel = std::make_shared<std::atomic<bool>>(false);
	const auto total = cloud::sizeOf(NodesOf(entry.container), entry.node.id);
	St().transfers.push_back({ id, u"move"_q, Q(entry.node.name), 0, total, u"active"_q, QString(), cancel });
	FireStore();
	const auto container = entry.container;
	const auto node = entry.node.id;
	Sections::Ask<json>([=](Sections::Workers &w) {
		return cloud::CloudFiles(w.drive).shareFolder(container, node, [id](std::int64_t d, std::int64_t all) {
			Sections::PostMain([=] {
				if (const auto t = FindTransfer(id)) {
					t->done = d;
					t->total = all;
					FireStore();
				}
			});
		}, [cancel] { return cancel->load(); });
	}, [id, done](json result) {
		FinishTransfer(id, result);
		RefreshUsage();
		if (done) {
			done(result.value("ok", false)
				? std::optional<std::string>(result.value("container", std::string()))
				: std::nullopt);
		}
	});
}

void UnshareFolder(const std::string &container) {
	const auto rootId = St().data.rootId.value_or(std::string());
	const auto name = cloud::freeName(cloud::namesIn(NodesOf(rootId)), S(ContainerName(ContainerOf(container))));
	const auto usage = cloud::usageOf(NodesOf(container));
	const auto id = NewId("move");
	const auto cancel = std::make_shared<std::atomic<bool>>(false);
	St().transfers.push_back({ id, u"move"_q, Q(name), 0, usage.total - usage.trash, u"active"_q, QString(), cancel });
	FireStore();
	Sections::Ask<json>([=](Sections::Workers &w) {
		return cloud::CloudFiles(w.drive).unshareFolder(container, name, [id](std::int64_t d, std::int64_t all) {
			Sections::PostMain([=] {
				if (const auto t = FindTransfer(id)) {
					t->done = d;
					t->total = all;
					FireStore();
				}
			});
		}, [cancel] { return cancel->load(); });
	}, [id](json result) {
		FinishTransfer(id, result);
		RefreshUsage();
	});
}

void CallShared(const std::string &method, json args, Fn<void(bool, json)> done) {
	Sections::CallCloud(method, std::move(args), [done](std::optional<json> result) {
		const auto ok = result && result->is_object() && result->value("ok", false);
		if (!ok) {
			ShowNotice(Q((result && result->is_object()) ? result->value("error", std::string("rejected")) : std::string("rejected")));
		}
		if (done) {
			done(ok, result.value_or(json()));
		}
	});
}

void AnswerInvite(const std::string &container, bool accept) {
	CallShared("parvaneCloudAnswerInvite", json{ { "container", container }, { "isAccepted", accept } }, [=](bool ok, json) {
		// Принятая папка сразу открывается (когда снимок её уже покажет)
		if (ok && accept) {
			SetPlace(Place{ u"shared"_q, container, {} });
		}
	});
}

void Leave(const std::string &container, Fn<void(bool)> done) {
	CallShared("parvaneCloudLeave", json{ { "container", container } }, [=](bool ok, json) {
		if (done) {
			done(ok);
		}
	});
}

void RemoveShared(const std::string &container, Fn<void(bool)> done) {
	CallShared("parvaneCloudRemoveShared", json{ { "container", container } }, [=](bool ok, json) {
		RefreshUsage();
		if (done) {
			done(ok);
		}
	});
}

void UploadFiles(const std::string &container, std::optional<std::string> parent, const QStringList &paths) {
	const auto target = container.empty() ? std::string("root") : container;
	const auto nodesId = (target == "root") ? St().data.rootId.value_or(std::string()) : target;
	auto taken = cloud::namesIn(NodesOf(nodesId), parent);
	for (const auto &[id, spec] : St().uploads) {
		if (spec.container == target && spec.parent == parent) {
			taken.push_back(S(spec.name));
		}
	}
	auto added = std::vector<QString>();
	for (const auto &path : paths) {
		const auto info = QFileInfo(path);
		if (!info.isFile()) {
			continue;
		}
		const auto id = NewId("up");
		const auto name = Q(cloud::freeName(taken, info.fileName().isEmpty() ? std::string("file") : S(info.fileName())));
		taken.push_back(S(name));
		St().uploads[id] = UploadSpec{ target, parent, name, path };
		St().transfers.push_back({
			id,
			u"upload"_q,
			name,
			0,
			info.size(),
			u"active"_q,
			QString(),
			std::make_shared<std::atomic<bool>>(false),
		});
		added.push_back(id);
	}
	FireStore();
	// По очереди: задания рабочего потока идут одно за другим
	for (const auto &id : added) {
		RunUpload(id);
	}
}

void UploadHere(const QStringList &paths) {
	const auto place = St().place;
	const auto container = place.container.empty() ? std::string("root") : place.container;
	UploadFiles(container, place.folder.empty() ? std::optional<std::string>() : std::optional(place.folder), paths);
}

void RetryUpload(const QString &id) {
	const auto t = FindTransfer(id);
	if (!t) {
		return;
	}
	t->state = u"active"_q;
	t->error = QString();
	t->cancel = std::make_shared<std::atomic<bool>>(false);
	FireStore();
	RunUpload(id);
}

void CancelTransfer(const QString &id) {
	const auto t = FindTransfer(id);
	if (!t) {
		return;
	}
	if (t->state != u"active"_q) {
		DismissTransfer(id);
		return;
	}
	// Идущая загрузка блоба не прерывается (ядро грузит его целиком): отмена срабатывает между шагами
	if (t->cancel) {
		t->cancel->store(true);
	}
}

void Download(not_null<QWidget*> parent, const Entry &entry) {
	const auto name = Q(entry.node.name);
	const auto initial = QDir(QStandardPaths::writableLocation(QStandardPaths::DownloadLocation)).filePath(name);
	const auto container = entry.container;
	const auto node = entry.node.id;
	const auto size = entry.node.size;
	FileDialog::GetWritePath(
		parent.get(),
		tr::lng_parvane_cloud_download(tr::now),
		FileDialog::AllFilesFilter(),
		initial,
		[=](QString &&path) {
			if (path.isEmpty()) {
				return;
			}
			const auto id = NewId("down");
			const auto cancel = std::make_shared<std::atomic<bool>>(false);
			St().transfers.push_back({ id, u"download"_q, name, 0, size, u"active"_q, QString(), cancel });
			FireStore();
			Sections::Ask<json>([=](Sections::Workers &w) -> json {
				if (cancel->load()) {
					return json{ { "ok", false }, { "canceled", true } };
				}
				const auto got = cloud::CloudFiles(w.drive).download(container, node);
				if (!got.ok) {
					return json{ { "ok", false }, { "error", got.error } };
				}
				if (cancel->load()) {
					return json{ { "ok", false }, { "canceled", true } };
				}
				auto f = QFile(path);
				if (!f.open(QIODevice::WriteOnly) || f.write(got.bytes.data(), qint64(got.bytes.size())) != qint64(got.bytes.size())) {
					return json{ { "ok", false }, { "error", "rejected" } };
				}
				return json{ { "ok", true } };
			}, [id](json result) {
				FinishTransfer(id, result);
			});
		});
}

void CreateLink(const std::string &container, std::optional<std::string> node, const QString &name, int ttlDays) {
	auto &st = St();
	if (st.linkProgress) {
		return;
	}
	const auto id = NewId("link");
	const auto cancel = std::make_shared<std::atomic<bool>>(false);
	st.linkProgress = LinkProgress{ id, 0, 0, container, node.value_or(std::string()), cancel };
	FireStore();
	const auto origin = S(Origin());
	const auto plain = S(name);
	Sections::Ask<json>([=](Sections::Workers &w) {
		return cloud::CloudFiles(w.drive).linkCreate(container, node, plain, ttlDays, origin,
			[id](std::int64_t done, std::int64_t total) {
				Sections::PostMain([=] {
					auto &progress = St().linkProgress;
					if (progress && progress->id == id) {
						progress->done = done;
						progress->total = total;
						FireStore();
					}
				});
			}, [cancel] { return cancel->load(); });
	}, [cancel](json result) {
		auto &st = St();
		if (!result.value("ok", false)) {
			// Отмена самим пользователем — не ошибка
			if (!result.value("canceled", false) && !cancel->load()) {
				ShowNotice(Q(result.value("error", std::string("rejected"))));
			}
		} else {
			auto list = json::array({ result["link"] });
			if (st.links && st.links->is_array()) {
				for (const auto &l : *st.links) {
					if (l.value("id", std::string()) != result["link"].value("id", std::string())) {
						list.push_back(l);
					}
				}
			}
			st.links = list;
		}
		st.linkProgress.reset();
		FireStore();
		RefreshLinks();
		RefreshUsage();
	});
}

void CancelLinkCreate() {
	if (const auto &progress = St().linkProgress; progress && progress->cancel) {
		progress->cancel->store(true);
	}
}

void RevokeLink(const QString &id, Fn<void(bool)> done) {
	const auto linkId = S(id);
	Sections::Ask<json>([=](Sections::Workers &w) {
		return cloud::CloudFiles(w.drive).linkRevoke(linkId);
	}, [=](json result) {
		const auto ok = result.value("ok", false);
		if (!ok) {
			ShowNotice(Q(result.value("error", std::string("rejected"))));
		} else if (St().links && St().links->is_array()) {
			auto list = json::array();
			for (const auto &l : *St().links) {
				if (l.value("id", std::string()) != linkId) {
					list.push_back(l);
				}
			}
			St().links = list;
			FireStore();
		}
		RefreshLinks();
		RefreshUsage();
		if (done) {
			done(ok);
		}
	});
}

void ExtendLink(const QString &id, int ttlDays, Fn<void(bool)> done) {
	const auto linkId = S(id);
	Sections::Ask<json>([=](Sections::Workers &w) {
		return cloud::CloudFiles(w.drive).linkExtend(linkId, ttlDays);
	}, [=](json result) {
		const auto ok = result.value("ok", false);
		if (!ok) {
			ShowNotice(Q(result.value("error", std::string("rejected"))));
		}
		RefreshLinks();
		if (done) {
			done(ok);
		}
	});
}

std::optional<json> LinkOfSource(const std::string &container, const std::string &node) {
	const auto &links = St().links;
	return links ? cloud::linkOfSource(*links, container, node) : std::nullopt;
}

QImage Thumb(const std::string &container, const CloudNode &node) {
	if (!node.thumb || !node.thumb->is_object()) {
		return QImage();
	}
	auto &st = St();
	const auto key = Q(node.thumb->value("fileId", std::string()));
	if (const auto i = st.thumbs.find(key); i != st.thumbs.end()) {
		return i->second;
	}
	if (st.thumbLoading.count(key)) {
		return QImage();
	}
	const auto raw = RawNode(container, node.id);
	if (!raw) {
		return QImage();
	}
	st.thumbLoading.insert(key);
	const auto value = *raw;
	Sections::Ask<QImage>([value](Sections::Workers &w) {
		const auto bytes = cloud::CloudFiles(w.drive).thumb(value);
		return bytes ? QImage::fromData(QByteArray::fromStdString(*bytes)) : QImage();
	}, [key](QImage image) {
		auto &st = St();
		st.thumbLoading.erase(key);
		if (image.isNull()) {
			return;
		}
		st.thumbs[key] = image;
		st.thumbOrder.push_back(key);
		while (int(st.thumbOrder.size()) > kThumbCache) {
			st.thumbs.erase(st.thumbOrder.front());
			st.thumbOrder.pop_front();
		}
		FireStore();
	});
	return QImage();
}

void OpenBlob(const Entry &entry, Fn<void(std::optional<QByteArray>)> done) {
	const auto raw = RawNode(entry.container, entry.node.id);
	if (!raw) {
		done(std::nullopt);
		return;
	}
	const auto value = *raw;
	Sections::Ask<std::optional<QByteArray>>([value](Sections::Workers &w) -> std::optional<QByteArray> {
		const auto bytes = cloud::CloudFiles(w.drive).open(value);
		if (!bytes) {
			return std::nullopt;
		}
		return QByteArray::fromStdString(*bytes);
	}, done);
}

void DownloadToTemp(const std::vector<Entry> &entries, Fn<void(QStringList, QString)> done) {
	auto list = std::vector<std::pair<std::string, std::string>>();
	for (const auto &e : entries) {
		if (!e.node.isFolder()) {
			list.push_back({ e.container, e.node.id });
		}
	}
	const auto dir = QDir(QStandardPaths::writableLocation(QStandardPaths::TempLocation)).filePath(
		u"parvane-cloud/"_q + QUuid::createUuid().toString(QUuid::WithoutBraces));
	Sections::Ask<std::pair<QStringList, QString>>([=](Sections::Workers &w) {
		auto paths = QStringList();
		auto error = QString();
		QDir().mkpath(dir);
		auto files = cloud::CloudFiles(w.drive);
		for (const auto &[container, node] : list) {
			const auto got = files.download(container, node);
			if (!got.ok) {
				error = Q(got.error);
				continue;
			}
			auto name = Q(got.name);
			name.replace('/', '_');
			const auto path = QDir(dir).filePath(name);
			auto f = QFile(path);
			if (f.open(QIODevice::WriteOnly)) {
				f.write(got.bytes.data(), qint64(got.bytes.size()));
				paths.push_back(path);
			}
		}
		return std::make_pair(paths, error);
	}, [done](std::pair<QStringList, QString> result) {
		done(result.first, result.second);
	});
}

} // namespace Parvane::Cloud
