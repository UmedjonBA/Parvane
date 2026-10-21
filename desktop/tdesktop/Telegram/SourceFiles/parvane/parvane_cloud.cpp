// Parvane fork: экран раздела «Облако» (рейка — «Файлы», spec 029, T064) — порт web `cloud/Cloud.tsx` и
// `CloudItem.tsx`: остров с шапкой (поиск по всем папкам, «Общая папка», «Папка», «Загрузить»), строка состояния
// синхронизации, путь и сортировка, полоса совместной папки, корзина, выделение, единый список (приглашения, ход
// переносов, совместные папки, свои ссылки, файлы и папки, строки-папки «Доступные мне», «Мои ссылки»,
// «Корзина»), занятое место, перетаскивание файлов, короткое уведомление.
#include "parvane/parvane_cloud.h"
#include "parvane/parvane_cloud_internal.h"
#include "parvane/parvane_mascot.h"

#include "parvane/parvane_sections_host.h"
#include "parvane/parvane_space.h"

#include "lang/lang_keys.h"
#include "ui/painter.h"
#include "ui/widgets/popup_menu.h"
#include "ui/widgets/scroll_area.h"
#include "ui/wrap/vertical_layout.h"
#include "window/window_session_controller.h"
#include "core/file_utilities.h"

#include <QtCore/QDateTime>
#include <QtCore/QFileInfo>
#include <QtCore/QMimeData>
#include <QtCore/QTimer>
#include <QtCore/QUrl>
#include <QtGui/QDragEnterEvent>
#include <QtGui/QKeyEvent>

#include <array>

namespace Parvane::Cloud {
namespace {

using namespace Kit;
using Kind = Btn::Kind;

constexpr auto kSearchDebounceMs = 150;
constexpr auto kUsageWarnShare = 0.9;
// Папка хранилища заметок в корне личного диска (названия — как в `notes/notesStore.ts`)
const auto kVaultNames = std::array<const char*, 2>{ "Знания", "Knowledge" };

[[nodiscard]] std::optional<std::string> Opt(const std::string &value) {
	return value.empty() ? std::optional<std::string>() : std::optional<std::string>(value);
}

// Узел, который просили открыть извне (палитра Ctrl+K): контейнер и id; экран забирает его, когда дерево готово
struct OpenRequest {
	std::string container;
	std::string node;
};
[[nodiscard]] std::optional<OpenRequest> &PendingOpen() {
	static auto result = std::optional<OpenRequest>();
	return result;
}
[[nodiscard]] rpl::event_stream<> &OpenRequests() {
	static auto result = rpl::event_stream<>();
	return result;
}

// Однострочная подпись по центру строки высотой height (разделитель пути «/», число выбранного)
class CenterText final : public Ui::RpWidget {
public:
	CenterText(QWidget *parent, const QString &text, int px, Tone tone, bool semibold, int height)
	: RpWidget(parent)
	, _text(text)
	, _px(px)
	, _tone(tone)
	, _semibold(semibold) {
		RepaintOnTones(this);
		const auto font = Font(_px, _semibold);
		setNaturalWidth(font->width(_text));
		resize(font->width(_text), height);
	}

protected:
	void paintEvent(QPaintEvent *e) override {
		auto p = QPainter(this);
		const auto font = Font(_px, _semibold);
		p.setFont(font->f);
		p.setPen(ToneColor(_tone));
		p.drawText(0, (height() - font->height) / 2 + font->ascent, _text);
	}

private:
	QString _text;
	int _px = 14;
	Tone _tone = Tone::Fg;
	bool _semibold = false;

};

// `.pathLink`: шаг пути (2.25rem, поля 0 0.875rem, приглушённый 0.875rem; под курсором — текст и подложка)
class CrumbBtn final : public Kit::Button {
public:
	CrumbBtn(QWidget *parent, const QString &text) : Button(parent), _text(text) {
		setAccessibleName(text);
		const auto font = Font(14);
		const auto w = std::min(Rem(14), 2 * Rem(0.875) + font->width(_text));
		setNaturalWidth(w);
		resize(w, Rem(2.25));
	}

protected:
	void paintEvent(QPaintEvent *e) override {
		auto p = QPainter(this);
		const auto over = isOver() || isDown();
		if (over) {
			PainterHighQualityEnabler hq(p);
			p.setPen(Qt::NoPen);
			p.setBrush(ToneColor(Tone::Hover));
			p.drawRoundedRect(QRectF(rect()), Rem(0.5), Rem(0.5));
		}
		const auto font = Font(14);
		p.setFont(font->f);
		p.setPen(ToneColor(over ? Tone::Fg : Tone::Muted));
		const auto pad = Rem(0.875);
		p.drawText(pad, (height() - font->height) / 2 + font->ascent, font->elided(_text, width() - 2 * pad));
		paintFocusRing(p, QRectF(rect()), Rem(0.5));
	}

private:
	QString _text;

};

// `.banner`: полоса совместной папки — фиолетовый текст на его 12 %, со значком «users»
class Banner final : public Kit::Button {
public:
	Banner(QWidget *parent, const QString &text, bool clickable) : Button(parent), _text(text) {
		setAccessibleName(text);
		setDisabled(!clickable);
		if (!clickable) {
			setAttribute(Qt::WA_TransparentForMouseEvents);
		}
	}

protected:
	int resizeGetHeight(int newWidth) override {
		const auto font = Font(14);
		const auto inner = std::max(newWidth - 2 * Rem(0.75) - Rem(1.125) - Rem(0.5), 1);
		const auto rect = QFontMetrics(font->f).boundingRect(QRect(0, 0, inner, 10000), Qt::TextWordWrap, _text);
		return rect.height() + 2 * Rem(0.625);
	}
	void paintEvent(QPaintEvent *e) override {
		auto p = QPainter(this);
		{
			PainterHighQualityEnabler hq(p);
			p.setPen(Qt::NoPen);
			p.setBrush(Mix(Tone::Purple, 0.12));
			p.drawRoundedRect(QRectF(rect()), Rem(0.5), Rem(0.5));
		}
		const auto font = Font(14);
		const auto color = ToneColor(Tone::Purple);
		const auto icon = Rem(1.125);
		PaintCloudIcon(p, u"users"_q, color, Rem(0.75), Rem(0.625) + std::max((font->height - icon) / 2, 0), icon);
		p.setFont(font->f);
		p.setPen(color);
		const auto left = Rem(0.75) + icon + Rem(0.5);
		p.drawText(QRect(left, Rem(0.625), width() - left - Rem(0.75), height()), Qt::TextWordWrap | Qt::AlignLeft | Qt::AlignTop, _text);
		paintFocusRing(p, QRectF(rect()), Rem(0.5));
	}

private:
	QString _text;

};

// Пилюли шапки: видимые встают подряд с промежутком 0.875rem
class PillsBar final : public Ui::RpWidget {
public:
	explicit PillsBar(QWidget *parent) : RpWidget(parent) {
	}

	template <typename Widget>
	Widget *add(object_ptr<Widget> &&child) {
		const auto raw = child.release();
		raw->setParent(this);
		_items.push_back(raw);
		return raw;
	}
	void setShown(std::vector<bool> shown) {
		auto x = 0;
		auto h = 0;
		for (auto i = 0; i != int(_items.size()); ++i) {
			const auto w = _items[i];
			const auto visible = i < int(shown.size()) && shown[i];
			w->setVisible(visible);
			if (!visible) {
				continue;
			}
			if (x) {
				x += Rem(0.875);
			}
			w->move(x, 0);
			x += w->width();
			h = std::max(h, w->height());
		}
		for (const auto w : _items) {
			w->move(w->x(), (h - w->height()) / 2);
		}
		resize(x, std::max(h, 1));
	}

private:
	std::vector<Ui::RpWidget*> _items;

};

// `.notice`: короткое сообщение поверх раздела — пилюля `--pv-fg` с текстом `--pv-panel`
class Toast final : public Ui::RpWidget {
public:
	explicit Toast(QWidget *parent) : RpWidget(parent) {
		RepaintOnTones(this);
		setCursor(style::cur_pointer);
	}
	void setText(const QString &text) {
		_text = text;
		const auto font = Font(14);
		const auto maxWidth = std::max(parentWidget()->width() - 2 * Rem(1), Rem(4));
		const auto w = std::min(font->width(_text) + 2 * Rem(1.125), maxWidth);
		resize(w, font->height + 2 * Rem(0.625));
		update();
	}

protected:
	void paintEvent(QPaintEvent *e) override {
		auto p = QPainter(this);
		PainterHighQualityEnabler hq(p);
		p.setPen(Qt::NoPen);
		p.setBrush(ToneColor(Tone::Fg));
		p.drawRoundedRect(QRectF(rect()), height() / 2., height() / 2.);
		const auto font = Font(14);
		p.setFont(font->f);
		p.setPen(ToneColor(Tone::Panel));
		p.drawText(rect(), Qt::AlignCenter, font->elided(_text, width() - 2 * Rem(1.125)));
	}
	void mousePressEvent(QMouseEvent *e) override {
		HideNotice();
	}

private:
	QString _text;

};

// `.dropZone`: пунктирная рамка акцентом поверх содержимого
class DropZone final : public Ui::RpWidget {
public:
	explicit DropZone(QWidget *parent) : RpWidget(parent) {
		setAttribute(Qt::WA_TransparentForMouseEvents);
	}

protected:
	void paintEvent(QPaintEvent *e) override {
		auto p = QPainter(this);
		PainterHighQualityEnabler hq(p);
		const auto r = QRectF(rect()).marginsRemoved(QMarginsF(Rem(0.5), Rem(0.5), Rem(0.5), Rem(0.5)));
		auto pen = QPen(ToneColor(Tone::Accent));
		pen.setWidthF(Rem(0.125));
		pen.setStyle(Qt::DashLine);
		p.setPen(pen);
		auto bg = ToneColor(Tone::Panel);
		const auto accent = ToneColor(Tone::Accent);
		bg = QColor(
			int(bg.red() * 0.88 + accent.red() * 0.12),
			int(bg.green() * 0.88 + accent.green() * 0.12),
			int(bg.blue() * 0.88 + accent.blue() * 0.12));
		p.setBrush(bg);
		p.drawRoundedRect(r, Rem(0.75), Rem(0.75));
		const auto font = Font(18, true);
		p.setFont(font->f);
		p.setPen(accent);
		p.drawText(rect(), Qt::AlignCenter, tr::lng_parvane_cloud_drop_here(tr::now));
	}

};

class CloudScreen final : public Ui::RpWidget {
public:
	CloudScreen(QWidget *parent, not_null<Window::SessionController*> controller);

protected:
	void resizeEvent(QResizeEvent *e) override;
	void keyPressEvent(QKeyEvent *e) override;
	void dragEnterEvent(QDragEnterEvent *e) override;
	void dragLeaveEvent(QDragLeaveEvent *e) override;
	void dragMoveEvent(QDragMoveEvent *e) override;
	void dropEvent(QDropEvent *e) override;

private:
	void scheduleRebuild();
	void rebuild();
	void consumeOpenRequest();
	void layoutIsland();
	void goTo(Place place);
	[[nodiscard]] Place placeOf(const std::string &container, std::optional<std::string> folder = {}) const;
	[[nodiscard]] QString pathText(const Entry &entry) const;
	[[nodiscard]] QString accessText(const std::string &container) const;
	[[nodiscard]] bool isVault(const Entry &entry) const;
	[[nodiscard]] bool canEditEntry(const Entry &entry) const;
	[[nodiscard]] std::vector<Entry> computeEntries();
	[[nodiscard]] std::vector<MovePlace> movePlaces() const;
	[[nodiscard]] bool canAddHere() const;
	[[nodiscard]] QStringList droppedPaths(const QMimeData *data) const;

	void open(const Entry &entry);
	void action(const QString &key, const Entry &entry);
	void showNodeMenu(const Entry &entry);
	void showContainerMenu(const std::string &id);
	void showMove(const std::string &container, std::vector<CloudNode> nodes);
	void showPurge(std::vector<Entry> entries, bool emptyTrash);
	void showShareFolder(const Entry &entry);
	void showPreview(const Entry &entry);
	void pickFiles();
	void access();
	void back();

	const not_null<Window::SessionController*> _controller;
	Island *_island = nullptr;
	Header *_header = nullptr;
	Field *_search = nullptr;
	PillsBar *_pills = nullptr;
	Label *_syncNotice = nullptr;
	Ui::ScrollArea *_scroll = nullptr;
	Ui::VerticalLayout *_list = nullptr;
	Toast *_toast = nullptr;
	DropZone *_drop = nullptr;

	QString _query;
	QString _applied;
	QTimer _searchTimer;
	std::set<QString> _selected;
	std::vector<Entry> _entries;
	Place _shownPlace;
	bool _rebuildPending = false;
	bool _dragging = false;

};

CloudScreen::CloudScreen(QWidget *parent, not_null<Window::SessionController*> controller)
: RpWidget(parent)
, _controller(controller) {
	setAcceptDrops(true);
	setFocusPolicy(Qt::ClickFocus);
	_island = Ui::CreateChild<Island>(this);
	_header = Ui::CreateChild<Header>(_island, SectionTitle(Section::Files));
	_search = _header->addShrinkable(
		object_ptr<Field>(_header, Field::Kind::HeaderSearch, rpl::single(tr::lng_parvane_cloud_search(tr::now))),
		Rem(17.5),
		Rem(8));
	_header->addStretch();
	_pills = _header->add(object_ptr<PillsBar>(_header));
	_pills->add(object_ptr<PillBtn>(_pills, tr::lng_parvane_cloud_shared_folder(tr::now), u"users"_q))->setClickedCallback([=] {
		ShowShareSheet(this, _controller, std::nullopt);
	});
	_pills->add(object_ptr<PillBtn>(_pills, tr::lng_parvane_cloud_folder(tr::now), u"folder"_q))->setClickedCallback([=] {
		ShowNameSheet(
			this,
			tr::lng_parvane_cloud_new_folder(tr::now),
			tr::lng_parvane_cloud_folder_name(tr::now),
			tr::lng_parvane_cloud_create(tr::now),
			QString(),
			[](QString name) { CreateFolder(name); });
	});
	_pills->add(object_ptr<PillBtn>(_pills, tr::lng_parvane_cloud_upload(tr::now), u"upload"_q, true))->setClickedCallback([=] {
		pickFiles();
	});
	_pills->setShown({ false, false, false });

	auto noticeSt = Label::Style();
	noticeSt.px = 14;
	noticeSt.tone = Tone::Muted;
	noticeSt.multiline = true;
	_syncNotice = Ui::CreateChild<Label>(_island, QString(), noticeSt);
	_syncNotice->hide();
	_scroll = Ui::CreateChild<Ui::ScrollArea>(_island);
	_list = _scroll->setOwnedWidget(object_ptr<Ui::VerticalLayout>(_scroll)).data();
	_toast = Ui::CreateChild<Toast>(_island);
	_toast->hide();
	_drop = Ui::CreateChild<DropZone>(_island);
	_drop->hide();

	RepaintOnTones(this);
	_searchTimer.setSingleShot(true);
	connect(&_searchTimer, &QTimer::timeout, [=] {
		_applied = _query;
		_selected.clear();
		scheduleRebuild();
	});
	_search->textChanges() | rpl::on_next([=](const QString &text) {
		_query = text;
		if (_query.trimmed().isEmpty()) {
			// Очистка — сразу, ввод — с задержкой
			_searchTimer.stop();
			_applied = QString();
			_selected.clear();
			scheduleRebuild();
		} else {
			_searchTimer.start(kSearchDebounceMs);
		}
	}, lifetime());
	_search->cancels() | rpl::on_next([=] {
		_search->setText(QString());
	}, lifetime());

	DataChanges() | rpl::on_next([=] {
		scheduleRebuild();
	}, lifetime());
	StoreChanges() | rpl::on_next([=] {
		scheduleRebuild();
	}, lifetime());
	_header->heightValue() | rpl::on_next([=] {
		layoutIsland();
	}, lifetime());
	TonesChanges() | rpl::on_next([=] {
		scheduleRebuild();
	}, lifetime());
	// Пока раздел на экране, сервер опрашивается часто (это включает хозяйство разделов по SetShownSection)
	SectionValue() | rpl::filter([](Section s) { return s == Section::Files; }) | rpl::on_next([=] {
		Load();
	}, lifetime());
	OpenRequests().events() | rpl::on_next([=] {
		scheduleRebuild();
	}, lifetime());
	Load();
	rebuild();
	consumeOpenRequest();
}

void CloudScreen::resizeEvent(QResizeEvent *e) {
	// `.root`: поля 0.5rem 0.5rem 0.5rem 0
	_island->setGeometry(0, Rem(0.5), width() - Rem(0.5), height() - Rem(1));
	layoutIsland();
}

void CloudScreen::layoutIsland() {
	const auto inner = _island->innerRect();
	_header->resizeToWidth(inner.width());
	_header->move(inner.topLeft());
	auto top = inner.y() + _header->height();
	if (!_syncNotice->isHidden()) {
		// `.syncNotice`: поля 0.5rem 1.125rem, линия снизу
		_syncNotice->resizeToWidth(inner.width() - 2 * Rem(1.125));
		_syncNotice->move(inner.x() + Rem(1.125), top + Rem(0.5));
		top += _syncNotice->height() + Rem(1);
	}
	_scroll->setGeometry(inner.x(), top, inner.width(), std::max(inner.y() + inner.height() - top, 0));
	_list->resizeToWidth(inner.width());
	_drop->setGeometry(_scroll->geometry());
	if (!_toast->isHidden()) {
		_toast->move(inner.x() + (inner.width() - _toast->width()) / 2, inner.y() + inner.height() - Rem(1.75) - _toast->height());
		_toast->raise();
	}
}

void CloudScreen::scheduleRebuild() {
	if (_rebuildPending) {
		return;
	}
	_rebuildPending = true;
	QTimer::singleShot(0, this, [=] {
		_rebuildPending = false;
		rebuild();
		consumeOpenRequest();
	});
}

void CloudScreen::consumeOpenRequest() {
	auto &pending = PendingOpen();
	if (!pending) {
		return;
	}
	const auto &nodes = NodesOf(pending->container);
	const auto i = std::find_if(nodes.begin(), nodes.end(), [&](const CloudNode &node) {
		return node.id == pending->node;
	});
	if (i == nodes.end()) {
		// Дерево ещё читается — ждём; готово, а узла нет (удалён) — забываем просьбу
		if (IsLoaded() && Current().status != "loading") {
			pending = std::nullopt;
		}
		return;
	}
	const auto entry = Entry{ pending->container, *i };
	// Папка открывается сама, файл — просмотром в своей папке (список соседей — для листания)
	const auto target = entry.node.isFolder()
		? placeOf(entry.container, entry.node.id)
		: placeOf(entry.container, entry.node.parent);
	if (!(CurrentPlace() == target) || !_applied.isEmpty()) {
		goTo(target);
		return;
	}
	pending = std::nullopt;
	if (!entry.node.isFolder()) {
		showPreview(entry);
	}
}

Place CloudScreen::placeOf(const std::string &container, std::optional<std::string> folder) const {
	const auto &data = Current();
	if (data.rootId && container == *data.rootId) {
		return Place{ QString(), {}, folder.value_or(std::string()) };
	}
	const auto c = ContainerOf(container);
	return Place{ (c && c->kind == "shared") ? u"shared"_q : QString(), container, folder.value_or(std::string()) };
}

QString CloudScreen::pathText(const Entry &entry) const {
	const auto place = placeOf(entry.container);
	auto parts = QStringList{ tr::lng_parvane_cloud_drive(tr::now) };
	if (!place.view.isEmpty()) {
		parts.push_back(VirtualName(place.view));
	}
	if (!place.container.empty()) {
		parts.push_back(ContainerName(ContainerOf(place.container)));
	}
	const auto parent = entry.node.parent && !entry.node.parent->empty() ? entry.node.parent : std::nullopt;
	if (parent) {
		for (const auto &n : cloud::pathOf(NodesOf(entry.container), parent)) {
			parts.push_back(Q(n.name));
		}
	}
	return parts.join(u" / "_q);
}

QString CloudScreen::accessText(const std::string &container) const {
	const auto c = ContainerOf(container);
	if (!c || c->kind == "root") {
		return tr::lng_parvane_cloud_only_you(tr::now);
	}
	if (c->kind != "owned") {
		return tr::lng_parvane_cloud_from(tr::now, lt_name, NameOf(c->owner));
	}
	if (c->members.empty()) {
		return tr::lng_parvane_cloud_only_you(tr::now);
	}
	auto names = QStringList();
	for (const auto &m : c->members) {
		names.push_back(NameOf(m.user));
	}
	return names.join(u", "_q);
}

bool CloudScreen::isVault(const Entry &entry) const {
	const auto &root = Current().rootId;
	if (!root || entry.container != *root || !entry.node.isFolder()) {
		return false;
	}
	if (entry.node.parent && !entry.node.parent->empty()) {
		return false;
	}
	return std::any_of(kVaultNames.begin(), kVaultNames.end(), [&](const char *name) { return entry.node.name == name; });
}

bool CloudScreen::canEditEntry(const Entry &entry) const {
	return CanEdit(entry.container);
}

std::vector<Entry> CloudScreen::computeEntries() {
	const auto &data = Current();
	const auto place = CurrentPlace();
	const auto query = _applied.trimmed();
	const auto sort = CurrentSort();
	auto result = std::vector<Entry>();
	if (!query.isEmpty()) {
		// Поиск — по всем папкам: личный диск, свои и принятые совместные; корзина не в счёт
		auto owners = std::map<std::string, std::string>();
		auto found = std::vector<CloudNode>();
		for (const auto &c : data.containers) {
			if (c.kind == "invite") {
				continue;
			}
			for (const auto &node : cloud::searchNodes(cloud::listedNodes(NodesOf(c.id)), S(query))) {
				owners[c.id + "/" + node.id] = c.id;
				found.push_back(node);
			}
		}
		// Узел помним вместе с контейнером: id узлов разных контейнеров могут совпасть
		auto byNode = std::multimap<std::string, std::string>();
		for (const auto &[key, container] : owners) {
			byNode.emplace(key.substr(container.size() + 1), container);
		}
		auto used = std::set<std::string>();
		for (const auto &node : cloud::sortNodes(found, sort)) {
			const auto range = byNode.equal_range(node.id);
			for (auto i = range.first; i != range.second; ++i) {
				const auto key = i->second + "/" + node.id;
				if (used.insert(key).second) {
					result.push_back({ i->second, node });
					break;
				}
			}
		}
		return result;
	}
	const auto isVirtual = !place.view.isEmpty() && place.container.empty();
	if (isVirtual && place.view == u"trash"_q) {
		return Trash();
	}
	if (isVirtual) {
		return result;
	}
	const auto container = ActiveContainer(place);
	if (container.empty()) {
		return result;
	}
	// Служебные файлы Parvane (отметка справки в хранилище заметок) в списке не показываются
	for (const auto &node : cloud::sortNodes(cloud::childrenOf(cloud::listedNodes(NodesOf(container)), Opt(place.folder)), sort)) {
		result.push_back({ container, node });
	}
	return result;
}

std::vector<MovePlace> CloudScreen::movePlaces() const {
	auto result = std::vector<MovePlace>();
	for (const auto &c : Current().containers) {
		if (c.kind == "invite" || (c.role != "owner" && c.role != "editor")) {
			continue;
		}
		result.push_back(MovePlace{
			c.id,
			c.kind == "root" ? tr::lng_parvane_cloud_drive(tr::now) : ContainerName(&c),
			c.kind != "root",
			NodesOf(c.id),
		});
	}
	return result;
}

bool CloudScreen::canAddHere() const {
	const auto place = CurrentPlace();
	const auto isVirtual = !place.view.isEmpty() && place.container.empty();
	const auto status = Current().status;
	const auto blocked = (status == "needs-linking" || status == "loading");
	return !blocked && !isVirtual && CanEdit(place.container);
}

void CloudScreen::goTo(Place place) {
	_search->setText(QString());
	_query = _applied = QString();
	_selected.clear();
	// «Мои ссылки» перечитываются при каждом открытии: срок мог истечь, ссылку могло создать другое устройство
	if (place.view == u"links"_q && place.container.empty()) {
		RefreshLinks();
	}
	SetPlace(std::move(place));
	scheduleRebuild();
}

void CloudScreen::back() {
	const auto place = CurrentPlace();
	if (!_query.isEmpty()) {
		_search->setText(QString());
		return;
	}
	const auto path = cloud::pathOf(NodesOf(ActiveContainer(place)), Opt(place.folder));
	if (!path.empty()) {
		goTo(Place{ place.view, place.container, path.size() > 1 ? path[path.size() - 2].id : std::string() });
	} else if (!place.container.empty()) {
		goTo(Place{ place.view, {}, {} });
	} else if (!place.view.isEmpty()) {
		goTo(Place());
	} else {
		ShowSection(Section::Chats);
	}
}

void CloudScreen::keyPressEvent(QKeyEvent *e) {
	if (e->key() == Qt::Key_Escape || e->key() == Qt::Key_Back) {
		back();
		return;
	}
	RpWidget::keyPressEvent(e);
}

QStringList CloudScreen::droppedPaths(const QMimeData *data) const {
	auto result = QStringList();
	if (!data || !data->hasUrls()) {
		return result;
	}
	for (const auto &url : data->urls()) {
		if (url.isLocalFile()) {
			const auto path = url.toLocalFile();
			if (QFileInfo(path).isFile()) {
				result.push_back(path);
			}
		}
	}
	return result;
}

void CloudScreen::dragEnterEvent(QDragEnterEvent *e) {
	if (!canAddHere() || droppedPaths(e->mimeData()).isEmpty()) {
		return;
	}
	e->acceptProposedAction();
	_dragging = true;
	_drop->show();
	_drop->raise();
}

void CloudScreen::dragMoveEvent(QDragMoveEvent *e) {
	if (_dragging) {
		e->acceptProposedAction();
	}
}

void CloudScreen::dragLeaveEvent(QDragLeaveEvent *e) {
	_dragging = false;
	_drop->hide();
}

void CloudScreen::dropEvent(QDropEvent *e) {
	_dragging = false;
	_drop->hide();
	const auto paths = droppedPaths(e->mimeData());
	if (!canAddHere() || paths.isEmpty()) {
		return;
	}
	e->acceptProposedAction();
	UploadHere(paths);
}

void CloudScreen::pickFiles() {
	FileDialog::GetOpenPaths(
		this,
		tr::lng_parvane_cloud_upload(tr::now),
		FileDialog::AllFilesFilter(),
		[=](FileDialog::OpenResult &&result) {
			if (!result.paths.isEmpty()) {
				UploadHere(result.paths);
			}
		});
}

// «Доступ» в открытой папке: у совместной — участники, у папки личного диска — предложение сделать её совместной
void CloudScreen::access() {
	const auto place = CurrentPlace();
	if (!place.container.empty()) {
		ShowShareSheet(this, _controller, place.container);
		return;
	}
	const auto container = ActiveContainer(place);
	if (place.folder.empty() || container.empty()) {
		return;
	}
	for (const auto &n : NodesOf(container)) {
		if (n.id == place.folder) {
			showShareFolder({ container, n });
		}
	}
}

void CloudScreen::open(const Entry &entry) {
	if (entry.node.isFolder()) {
		goTo(placeOf(entry.container, entry.node.id));
		return;
	}
	showPreview(entry);
}

void CloudScreen::showPreview(const Entry &entry) {
	auto siblings = std::vector<Entry>();
	for (const auto &e : _entries) {
		if (!e.node.isFolder()) {
			siblings.push_back(e);
		}
	}
	ShowPreviewSheet(this, PreviewArgs{
		.entry = entry,
		.siblings = siblings,
		.folderText = pathText(entry),
		.accessText = accessText(entry.container),
		.download = [=](Entry e) { Download(this, e); },
		.send = [=](Entry e) { SendToChat(_controller, { e }); },
		.more = [=](Entry e) { showNodeMenu(e); },
	});
}

void CloudScreen::showMove(const std::string &container, std::vector<CloudNode> nodes) {
	const auto place = CurrentPlace();
	const auto active = ActiveContainer(place);
	const auto c = ContainerOf(container);
	auto moved = std::vector<std::string>();
	for (const auto &n : nodes) {
		moved.push_back(n.id);
	}
	const auto rootName = (Current().rootId && container == *Current().rootId)
		? tr::lng_parvane_cloud_drive(tr::now)
		: ContainerName(c);
	ShowFolderSheet(this, FolderSheetArgs{
		// Один объект — «Переместить «имя»», несколько — общее название окна
		.title = nodes.size() == 1 ? tr::lng_parvane_cloud_move_title_one(tr::now, lt_name, Q(nodes[0].name)) : QString(),
		.rootName = rootName,
		.nodes = NodesOf(container),
		.movedIds = moved,
		.startFolder = (container == active) ? Opt(place.folder) : std::nullopt,
		.places = movePlaces(),
		.sourcePlace = container,
		.submit = [=](std::optional<std::string> target, std::optional<std::string> placeId) {
			if (placeId && *placeId != container) {
				MoveAcross(container, nodes, *placeId, target);
			} else {
				MoveNodes(container, nodes, target);
			}
			_selected.clear();
			scheduleRebuild();
		},
	});
}

void CloudScreen::showPurge(std::vector<Entry> entries, bool emptyTrash) {
	ShowConfirmSheet(
		this,
		emptyTrash ? tr::lng_parvane_cloud_empty_trash_action(tr::now) : tr::lng_parvane_cloud_delete_forever(tr::now),
		emptyTrash ? tr::lng_parvane_cloud_empty_trash_confirm(tr::now) : tr::lng_parvane_cloud_delete_forever_confirm(tr::now),
		tr::lng_parvane_cloud_delete_forever(tr::now),
		true,
		[=] {
			if (emptyTrash) {
				EmptyTrash();
			} else {
				RunByContainer(entries, [](const std::string &c, const std::vector<CloudNode> &nodes) {
					PurgeNodes(c, nodes);
				});
			}
			_selected.clear();
			scheduleRebuild();
		});
}

void CloudScreen::showShareFolder(const Entry &entry) {
	ShowConfirmSheet(
		this,
		tr::lng_parvane_cloud_share(tr::now),
		tr::lng_parvane_cloud_share_folder_confirm(tr::now, lt_name, Q(entry.node.name)),
		tr::lng_parvane_cloud_share_folder_action(tr::now),
		false,
		[=] {
			const auto weak = QPointer<CloudScreen>(this);
			ShareFolder(entry, [=](std::optional<std::string> created) {
				if (weak && created) {
					ShowShareSheet(weak.data(), _controller, created);
				}
			});
		});
}

void CloudScreen::action(const QString &key, const Entry &entry) {
	if (key == u"open"_q) {
		open(entry);
	} else if (key == u"download"_q) {
		Download(this, entry);
	} else if (key == u"rename"_q) {
		ShowNameSheet(
			this,
			tr::lng_parvane_cloud_rename(tr::now),
			tr::lng_parvane_cloud_new_name(tr::now),
			tr::lng_parvane_cloud_save(tr::now),
			Q(entry.node.name),
			[=](QString name) { Rename(entry, name); });
	} else if (key == u"move"_q) {
		showMove(entry.container, { entry.node });
	} else if (key == u"delete"_q) {
		TrashNodes(entry.container, { entry.node });
	} else if (key == u"restore"_q) {
		RestoreNodes(entry.container, { entry.node });
	} else if (key == u"purge"_q) {
		showPurge({ entry }, false);
	} else if (key == u"send"_q) {
		SendToChat(_controller, { entry });
	} else if (key == u"share"_q) {
		showShareFolder(entry);
	} else if (key == u"link"_q) {
		ShowLinkSheet(this, LinkSource{ entry.container, entry.node.id, Q(entry.node.name) }, std::nullopt);
	} else if (key == u"select"_q) {
		_selected.insert(KeyOf(entry));
		scheduleRebuild();
	}
}

void CloudScreen::showNodeMenu(const Entry &entry) {
	auto actions = std::vector<MenuAction>();
	const auto isFolder = entry.node.isFolder();
	if (entry.node.trashed) {
		actions.push_back({ u"restore"_q, u"restore"_q, tr::lng_parvane_cloud_restore(tr::now) });
		actions.push_back({ u"purge"_q, u"trash"_q, tr::lng_parvane_cloud_delete_forever(tr::now), true });
	} else {
		const auto canEditThis = canEditEntry(entry);
		const auto fixed = isVault(entry);
		const auto &root = Current().rootId;
		actions.push_back({
			u"open"_q,
			isFolder ? u"folder"_q : u"eye"_q,
			isFolder ? tr::lng_parvane_cloud_open(tr::now) : tr::lng_parvane_cloud_view(tr::now),
		});
		if (!isFolder) {
			actions.push_back({ u"download"_q, u"download"_q, tr::lng_parvane_cloud_download(tr::now) });
		}
		if (isFolder && canEditThis && root && entry.container == *root) {
			actions.push_back({ u"share"_q, u"users"_q, tr::lng_parvane_cloud_share_open(tr::now) });
		}
		// Ссылка для людей без аккаунта (spec 022): личный диск либо совместная папка с правом правки
		if (canEditThis) {
			actions.push_back({ u"link"_q, u"link"_q, tr::lng_parvane_cloud_link(tr::now) });
		}
		if (!isFolder) {
			actions.push_back({ u"send"_q, u"chat"_q, tr::lng_parvane_cloud_send_to_chat(tr::now) });
		}
		if (canEditThis && !fixed) {
			actions.push_back({ u"move"_q, u"move"_q, tr::lng_parvane_cloud_move(tr::now) });
		}
		if (canEditThis) {
			actions.push_back({ u"rename"_q, u"edit"_q, tr::lng_parvane_cloud_rename(tr::now) });
		}
		if (canEditThis && !fixed) {
			actions.push_back({ u"delete"_q, u"trash"_q, tr::lng_parvane_cloud_to_trash(tr::now), true });
		}
	}
	ShowMenuSheet(this, Q(entry.node.name), std::move(actions), [=](QString key) {
		action(key, entry);
	});
}

void CloudScreen::showContainerMenu(const std::string &id) {
	const auto c = ContainerOf(id);
	const auto owned = c && c->kind == "owned";
	auto actions = std::vector<MenuAction>{
		{ u"open"_q, u"folder"_q, tr::lng_parvane_cloud_open(tr::now) },
	};
	if (owned) {
		actions.push_back({ u"access"_q, u"users"_q, tr::lng_parvane_cloud_share(tr::now) });
	} else {
		actions.push_back({ u"leave"_q, u"x"_q, tr::lng_parvane_cloud_leave(tr::now), true });
	}
	ShowMenuSheet(this, ContainerName(c), std::move(actions), [=](QString key) {
		if (key == u"open"_q) {
			goTo(placeOf(id));
		} else if (key == u"access"_q) {
			ShowShareSheet(this, _controller, id);
		} else if (key == u"leave"_q) {
			ShowConfirmSheet(
				this,
				tr::lng_parvane_cloud_leave(tr::now),
				tr::lng_parvane_cloud_leave_confirm(tr::now),
				tr::lng_parvane_cloud_leave(tr::now),
				true,
				[=] { Leave(id); });
		}
	});
}

void CloudScreen::rebuild() {
	const auto &data = Current();
	const auto place = CurrentPlace();
	if (!(place == _shownPlace)) {
		_shownPlace = place;
		_selected.clear();
	}
	const auto status = data.status;
	const auto blocked = (status == "needs-linking" || status == "loading");
	const auto query = _applied.trimmed();
	const auto isSearch = !query.isEmpty();
	const auto isVirtual = !place.view.isEmpty() && place.container.empty();
	const auto isTrash = !isSearch && isVirtual && place.view == u"trash"_q;
	const auto isSharedList = !isSearch && isVirtual && place.view == u"shared"_q;
	const auto isLinksList = !isSearch && isVirtual && place.view == u"links"_q;
	const auto isRoot = !isSearch && place.view.isEmpty() && place.container.empty() && place.folder.empty();
	const auto containerId = isVirtual ? std::string() : ActiveContainer(place);
	const auto container = ContainerOf(place.container);
	const auto canEdit = !isVirtual && CanEdit(place.container);
	const auto canAdd = !blocked && canEdit;
	const auto isPersonalRoot = place.container.empty() && place.folder.empty();

	// Шапка: поиск — если не заблокировано; «Общая папка» — в корне личного диска; «Папка», «Загрузить»
	_search->setVisible(!blocked);
	_pills->setShown({ canAdd && isPersonalRoot, canAdd, canAdd });

	// Строка состояния синхронизации
	const auto statusText = (status == "needs-linking")
		? tr::lng_parvane_cloud_needs_linking(tr::now)
		: (status == "offline")
		? tr::lng_parvane_cloud_sync_unavailable(tr::now)
		: (status == "no-key")
		? tr::lng_parvane_cloud_sync_pending(tr::now)
		: QString();
	_syncNotice->setText(statusText);
	_syncNotice->setTone(blocked ? Tone::Fg : Tone::Muted);
	_syncNotice->setVisible(!statusText.isEmpty());

	_entries = computeEntries();
	const auto scrollTop = _scroll->scrollTop();
	Kit::ClearLayout(_list);
	const auto pad = Rem(1.25); // `.content`
	const auto listPad = pad - Rem(0.625); // `.list { margin-inline: -0.625rem }`
	auto firstBlock = true;
	const auto block = [&](object_ptr<Ui::RpWidget> w, int bottom, int left = 0, int right = 0) {
		const auto raw = _list->add(std::move(w), style::margins(pad + left, firstBlock ? pad : 0, pad + right, bottom));
		firstBlock = false;
		return raw;
	};
	const auto listRow = [&](object_ptr<Ui::RpWidget> w) {
		const auto raw = _list->add(std::move(w), style::margins(listPad, firstBlock ? pad : 0, listPad, 0));
		firstBlock = false;
		return raw;
	};

	if (!blocked) {
		// `.tools`: путь либо число найденного — слева, сортировка — справа
		auto tools = object_ptr<HRow>(_list, Rem(0.5));
		if (isSearch) {
			auto st = Label::Style();
			st.px = 13;
			st.tone = Tone::Muted;
			tools->add(object_ptr<Label>(tools.data(), tr::lng_parvane_cloud_found(tr::now, lt_amount, QString::number(_entries.size())), st), true);
		} else {
			auto crumbs = object_ptr<Flow>(tools.data(), Rem(0.125));
			const auto crumb = [&](const QString &title, Place target, bool first) {
				if (!first) {
					crumbs->add(object_ptr<CenterText>(crumbs.data(), u"/"_q, kBodyPx, Tone::Faint, false, Rem(2.25)));
				}
				crumbs->add(object_ptr<CrumbBtn>(crumbs.data(), title))->setClickedCallback([=] {
					goTo(target);
				});
			};
			crumb(tr::lng_parvane_cloud_drive(tr::now), Place(), true);
			if (!place.view.isEmpty()) {
				crumb(VirtualName(place.view), Place{ place.view, {}, {} }, false);
			}
			if (container) {
				crumb(ContainerName(container), Place{ place.view, place.container, {} }, false);
			}
			for (const auto &n : cloud::pathOf(NodesOf(containerId), Opt(place.folder))) {
				crumb(Q(n.name), Place{ place.view, place.container, n.id }, false);
			}
			tools->add(std::move(crumbs), true);
		}
		if (!isTrash && !isSharedList && !isLinksList) {
			const auto sort = CurrentSort();
			const auto shortTitle = sort.key == cloud::SortKey::Date
				? tr::lng_parvane_cloud_modified(tr::now)
				: sort.key == cloud::SortKey::Size
				? tr::lng_parvane_cloud_size(tr::now)
				: tr::lng_parvane_cloud_name(tr::now);
			const auto pill = tools->add(object_ptr<PillBtn>(
				tools.data(),
				shortTitle,
				sort.isDescending ? u"down"_q : u"up"_q,
				false,
				true));
			pill->setAccessibleName(tr::lng_parvane_cloud_sort(tr::now) + u": "_q + shortTitle);
			pill->setClickedCallback([=] {
				auto menu = CreateMenu(pill);
				const auto item = [&](cloud::SortKey key, const QString &title) {
					const auto current = CurrentSort();
					AddMenuAction(menu.get(), title, [=] {
						const auto now = CurrentSort();
						SetSort(cloud::Sort{ key, now.key == key ? !now.isDescending : false });
					}, current.key == key ? u"check"_q : QString());
				};
				item(cloud::SortKey::Name, tr::lng_parvane_cloud_sort_name(tr::now));
				item(cloud::SortKey::Date, tr::lng_parvane_cloud_sort_date(tr::now));
				item(cloud::SortKey::Size, tr::lng_parvane_cloud_sort_size(tr::now));
				const auto raw = menu.get();
				raw->popup(pill->mapToGlobal(QPoint(pill->width(), pill->height())));
				// Меню удаляет себя после закрытия
				(void)menu.release();
			});
		}
		block(std::move(tools), Rem(0.625), isSearch ? 0 : -Rem(0.625));
	}

	if (!blocked && !isSearch && container) {
		auto names = QStringList();
		for (const auto &m : container->members) {
			names.push_back(NameOf(m.user));
		}
		const auto owned = (container->kind == "owned");
		const auto text = owned
			? (names.isEmpty()
				? tr::lng_parvane_cloud_shared_banner_alone(tr::now, lt_name, ContainerName(container))
				: tr::lng_parvane_cloud_shared_banner(tr::now, lt_name, ContainerName(container), lt_members, names.join(u", "_q)))
			: tr::lng_parvane_cloud_incoming_banner(
				tr::now,
				lt_name,
				ContainerName(container),
				lt_owner,
				NameOf(container->owner),
				lt_rights,
				container->role == "editor" ? tr::lng_parvane_cloud_can_edit(tr::now) : tr::lng_parvane_cloud_view_only(tr::now));
		const auto banner = block(object_ptr<Banner>(_list, text, owned), Rem(0.625));
		static_cast<Banner*>(banner)->setClickedCallback([=] { access(); });
	}

	if (isTrash && !_entries.empty()) {
		auto row = object_ptr<HRow>(_list, Rem(0.5));
		auto st = Label::Small();
		st.multiline = true;
		row->add(object_ptr<Label>(row.data(), tr::lng_parvane_cloud_trash_note(tr::now), st), true);
		row->add(object_ptr<Btn>(row.data(), tr::lng_parvane_cloud_empty_trash_action(tr::now), Kind::Danger))->setClickedCallback([=] {
			showPurge({}, true);
		});
		block(std::move(row), Rem(0.375));
	}

	// Выделение
	auto selectedEntries = std::vector<Entry>();
	for (const auto &e : _entries) {
		if (_selected.count(KeyOf(e))) {
			selectedEntries.push_back(e);
		}
	}
	if (!selectedEntries.empty()) {
		auto editable = std::vector<Entry>();
		for (const auto &e : selectedEntries) {
			if (canEditEntry(e)) {
				editable.push_back(e);
			}
		}
		// Переносить разом можно только лежащее в одном контейнере
		const auto sameContainer = editable.size() == selectedEntries.size()
			&& std::all_of(selectedEntries.begin(), selectedEntries.end(), [&](const Entry &e) {
				return e.container == selectedEntries[0].container;
			});
		auto bar = object_ptr<Flow>(_list, Rem(0.5));
		bar->add(object_ptr<IconBtn>(bar.data(), u"x"_q, tr::lng_parvane_cloud_clear_selection(tr::now), true))->setClickedCallback([=] {
			_selected.clear();
			scheduleRebuild();
		});
		bar->add(object_ptr<CenterText>(
			bar.data(),
			tr::lng_parvane_cloud_selected(tr::now, lt_amount, QString::number(selectedEntries.size())),
			14,
			Tone::Fg,
			true,
			Rem(2.25)));
		if (isTrash) {
			bar->add(object_ptr<Btn>(bar.data(), tr::lng_parvane_cloud_restore(tr::now), Kind::Ghost))->setClickedCallback([=] {
				RunByContainer(selectedEntries, [](const std::string &c, const std::vector<CloudNode> &nodes) {
					RestoreNodes(c, nodes);
				});
				_selected.clear();
				scheduleRebuild();
			});
			bar->add(object_ptr<Btn>(bar.data(), tr::lng_parvane_cloud_delete_forever(tr::now), Kind::Danger))->setClickedCallback([=] {
				showPurge(selectedEntries, false);
			});
		} else {
			if (std::any_of(selectedEntries.begin(), selectedEntries.end(), [](const Entry &e) { return !e.node.isFolder(); })) {
				bar->add(object_ptr<Btn>(bar.data(), tr::lng_parvane_cloud_send_to_chat(tr::now), Kind::Ghost))->setClickedCallback([=] {
					SendToChat(_controller, selectedEntries);
				});
			}
			if (sameContainer) {
				bar->add(object_ptr<Btn>(bar.data(), tr::lng_parvane_cloud_move(tr::now), Kind::Ghost))->setClickedCallback([=] {
					auto nodes = std::vector<CloudNode>();
					for (const auto &e : selectedEntries) {
						nodes.push_back(e.node);
					}
					showMove(selectedEntries[0].container, nodes);
				});
			}
			if (!editable.empty()) {
				bar->add(object_ptr<Btn>(bar.data(), tr::lng_parvane_cloud_to_trash(tr::now), Kind::Danger))->setClickedCallback([=] {
					RunByContainer(editable, [](const std::string &c, const std::vector<CloudNode> &nodes) {
						TrashNodes(c, nodes);
					});
					_selected.clear();
					scheduleRebuild();
				});
			}
		}
		block(std::move(bar), Rem(0.5));
	}

	if (!IsLoaded() && !blocked) {
		// web `<Loading />`: маскот с полями, как у пустого состояния
		block(object_ptr<Mascot>(_list, Mascot::Side() + 2 * Rem(2.5)), 0);
	}

	auto hasRows = false;
	if (IsLoaded()) {
		const auto &containers = data.containers;
		// Приглашения в чужие папки — строкой вверху корня
		if (isRoot) {
			for (const auto &c : containers) {
				if (c.kind != "invite") {
					continue;
				}
				const auto owner = NameOf(c.owner);
				const auto row = static_cast<ListRow*>(listRow(object_ptr<ListRow>(_list, ListRow::Descriptor{
					.tile = Tile{ .letter = owner.left(1).toUpper(), .color = ToneColor(Tone::Purple), .round = true },
					.title = tr::lng_parvane_cloud_invite_from(tr::now, lt_name, owner, lt_folder, ContainerName(&c)),
					.sub = RoleTitle(c.role).toLower(),
					.plain = true,
					.background = Mix(Tone::Purple, 0.10),
				})));
				const auto id = c.id;
				row->addRight(object_ptr<Btn>(row, tr::lng_parvane_cloud_decline(tr::now), Kind::Ghost))->setClickedCallback([=] {
					AnswerInvite(id, false);
				});
				row->addRight(object_ptr<Btn>(row, tr::lng_parvane_cloud_accept(tr::now), Kind::Accent))->setClickedCallback([=] {
					AnswerInvite(id, true);
				});
				_list->add(object_ptr<Ui::RpWidget>(_list), style::margins(0, 0, 0, Rem(0.375)))->resize(1, 0);
			}
		}
		// Ход загрузок, скачиваний и переносов
		for (const auto &t : Transfers()) {
			const auto percent = t.total ? std::min<std::int64_t>(100, std::llround(t.done * 100. / t.total)) : 0;
			const auto sizeText = FormatSize(t.total);
			const auto stateText = (t.state == u"done"_q)
				? tr::lng_parvane_cloud_done(tr::now)
				: (t.state == u"failed"_q)
				? ErrorText(t.error.isEmpty() ? u"rejected"_q : t.error)
				: (t.kind == u"upload"_q)
				? tr::lng_parvane_cloud_uploading(tr::now, lt_percent, QString::number(percent), lt_size, sizeText)
				: (t.kind == u"move"_q)
				? tr::lng_parvane_cloud_moving(tr::now, lt_percent, QString::number(percent), lt_size, sizeText)
				: tr::lng_parvane_cloud_downloading(tr::now, lt_percent, QString::number(percent), lt_size, sizeText);
			const auto row = static_cast<ListRow*>(listRow(object_ptr<ListRow>(_list, ListRow::Descriptor{
				.tile = Tile{
					.icon = t.kind == u"upload"_q ? u"upload"_q : t.kind == u"move"_q ? u"move"_q : u"download"_q,
					.color = ToneColor(Tone::Blue),
				},
				.title = t.name,
				.sub = stateText,
				.plain = true,
				.progress = (t.state == u"active"_q) ? std::optional<double>(percent / 100.) : std::nullopt,
				.subError = (t.state == u"failed"_q),
			})));
			const auto id = t.id;
			if (t.state == u"failed"_q && t.kind == u"upload"_q) {
				row->addRight(object_ptr<Btn>(row, tr::lng_parvane_cloud_retry(tr::now), Kind::Ghost))->setClickedCallback([=] {
					RetryUpload(id);
				});
			}
			if (t.state != u"done"_q) {
				row->addRight(object_ptr<IconBtn>(row, u"x"_q, tr::lng_parvane_cloud_cancel(tr::now), true))->setClickedCallback([=] {
					CancelTransfer(id);
				});
			}
		}
		// Совместные папки: свои — в корне, чужие принятые — в «Доступных мне»
		for (const auto &c : containers) {
			const auto listed = (isRoot && c.kind == "owned") || (isSharedList && c.kind == "shared");
			if (!listed) {
				continue;
			}
			hasRows = true;
			const auto owned = (c.kind == "owned");
			const auto count = int(cloud::childrenOf(cloud::listedNodes(NodesOf(c.id))).size());
			const auto shared = owned
				? (c.members.empty()
					? tr::lng_parvane_cloud_shared_alone(tr::now)
					: tr::lng_parvane_cloud_shared_with(tr::now, lt_amount, QString::number(c.members.size())))
				: (tr::lng_parvane_cloud_from(tr::now, lt_name, NameOf(c.owner)) + u" · "_q + RoleTitle(c.role).toLower());
			const auto row = static_cast<ListRow*>(listRow(object_ptr<ListRow>(_list, ListRow::Descriptor{
				.tile = Tile{ .icon = u"folder"_q, .color = ToneColor(owned ? Tone::Blue : Tone::Purple) },
				.title = ContainerName(&c),
				.sub = ItemsText(count) + u" · "_q,
				.subAccent = shared,
			})));
			const auto id = c.id;
			row->setCallbacks([=] { goTo(placeOf(id)); });
			if (owned) {
				row->addRight(object_ptr<IconBtn>(row, u"users"_q, tr::lng_parvane_cloud_share(tr::now), false, Tone::Purple))->setClickedCallback([=] {
					ShowShareSheet(this, _controller, id);
				});
			}
			row->addRight(object_ptr<IconBtn>(row, u"dots"_q, tr::lng_parvane_cloud_actions(tr::now)))->setClickedCallback([=] {
				showContainerMenu(id);
			});
		}
		// Свои ссылки
		if (isLinksList && Links() && Links()->is_array()) {
			for (const auto &link : *Links()) {
				hasRows = true;
				const auto state = Q(link.value("state", std::string()));
				const auto kind = Q(link.value("kind", std::string()));
				const auto expires = link.value("expiresAt", std::int64_t(0));
				const auto created = link.value("createdAt", std::int64_t(0));
				const auto term = (state == u"preparing"_q)
					? tr::lng_parvane_cloud_link_unfinished(tr::now)
					: (state == u"expired"_q)
					? tr::lng_parvane_cloud_link_state_expired(tr::now)
					: expires
					? tr::lng_parvane_cloud_link_state_until(tr::now, lt_date, ShortDate(expires * 1000))
					: tr::lng_parvane_cloud_link_state_forever(tr::now);
				auto facts = QStringList();
				if (!kind.isEmpty()) {
					facts.push_back(kind == u"folder"_q ? tr::lng_parvane_cloud_folder(tr::now) : tr::lng_parvane_cloud_link_kind_file(tr::now));
				}
				if (created > 0) {
					facts.push_back(tr::lng_parvane_cloud_link_created(tr::now, lt_date, ShortDate(created * 1000)));
				}
				facts.push_back(term);
				facts.push_back(FormatSize(link.value("bytes", std::int64_t(0))));
				const auto name = Q(link.value("name", std::string()));
				const auto row = static_cast<ListRow*>(listRow(object_ptr<ListRow>(_list, ListRow::Descriptor{
					.tile = Tile{
						.icon = kind == u"folder"_q ? u"folder"_q : kind == u"file"_q ? u"file"_q : u"link"_q,
						.color = ToneColor(state == u"active"_q ? Tone::Blue : Tone::Muted),
					},
					.title = name.isEmpty() ? tr::lng_parvane_cloud_link_heading(tr::now) : name,
					.sub = facts.join(u" · "_q),
				})));
				const auto id = Q(link.value("id", std::string()));
				row->setCallbacks([=] { ShowLinkSheet(this, std::nullopt, id); });
			}
		}
		// Файлы и папки
		const auto now = QDateTime::currentMSecsSinceEpoch();
		auto stats = std::map<std::string, std::map<std::string, cloud::FolderStats>>();
		for (const auto &entry : _entries) {
			hasRows = true;
			const auto &node = entry.node;
			const auto isFolder = node.isFolder();
			const auto vault = isVault(entry);
			const auto c = ContainerOf(entry.container);
			const auto incoming = c && c->kind == "shared";
			auto facts = QStringList();
			if (isTrash) {
				const auto days = cloud::trashDaysLeft(node, now);
				facts.push_back(days
					? tr::lng_parvane_cloud_trash_days_left(tr::now, lt_count, days)
					: tr::lng_parvane_cloud_trash_expired(tr::now));
			} else if (vault) {
				facts.push_back(tr::lng_parvane_cloud_vault(tr::now));
			} else if (isFolder) {
				if (!stats.count(entry.container)) {
					stats[entry.container] = cloud::folderStats(NodesOf(entry.container));
				}
				const auto &byId = stats[entry.container];
				const auto i = byId.find(node.id);
				facts.push_back(ItemsText(i == byId.end() ? 0 : i->second.count));
			} else {
				facts.push_back(FormatSize(node.size));
				if (node.mtime) {
					facts.push_back(ShortDate(node.mtime));
				}
			}
			if (isSearch) {
				facts.push_back(pathText(entry));
			}
			const auto fileKind = isFolder ? cloud::FileKind::Other : cloud::kindOfFile(node.mime, node.name);
			const auto color = vault ? Tone::Yellow : incoming ? Tone::Purple : isFolder ? Tone::Blue : Tone::Fg;
			const auto key = KeyOf(entry);
			const auto row = static_cast<ListRow*>(listRow(object_ptr<ListRow>(_list, ListRow::Descriptor{
				.tile = Tile{
					.icon = isFolder ? u"folder"_q : fileKind == cloud::FileKind::Photo ? u"image"_q : u"note"_q,
					.color = ToneColor(color),
					.thumb = isFolder ? QImage() : Thumb(entry.container, node),
				},
				.title = Q(node.name),
				.sub = facts.join(u" · "_q),
				.selectable = true,
				.selected = _selected.count(key) > 0,
				.selecting = !_selected.empty(),
			})));
			row->setToolTip(Q(node.name));
			row->setCallbacks([=] {
				// В корзине нажатие открывает меню
				if (isTrash) {
					showNodeMenu(entry);
				} else {
					open(entry);
				}
			}, [=] {
				if (_selected.count(key)) {
					_selected.erase(key);
				} else {
					_selected.insert(key);
				}
				scheduleRebuild();
			});
			if (isTrash) {
				row->addRight(object_ptr<Btn>(row, tr::lng_parvane_cloud_restore(tr::now), Kind::Ghost))->setClickedCallback([=] {
					RestoreNodes(entry.container, { entry.node });
				});
			}
			row->addRight(object_ptr<IconBtn>(row, u"dots"_q, tr::lng_parvane_cloud_actions(tr::now)))->setClickedCallback([=] {
				showNodeMenu(entry);
			});
		}
		if (!hasRows && Transfers().empty()) {
			const auto emptyText = isSearch
				? tr::lng_parvane_cloud_nothing_found(tr::now)
				: isTrash
				? tr::lng_parvane_cloud_empty_trash(tr::now)
				: isSharedList
				? tr::lng_parvane_cloud_empty_shared(tr::now)
				: isLinksList
				? tr::lng_parvane_cloud_links_empty(tr::now)
				: isRoot
				? tr::lng_parvane_cloud_empty(tr::now)
				: tr::lng_parvane_cloud_empty_folder(tr::now);
			block(object_ptr<Empty>(_list, emptyText), 0);
			const auto hint = (isRoot && !isSearch)
				? tr::lng_parvane_cloud_empty_hint(tr::now)
				: (isLinksList ? tr::lng_parvane_cloud_links_empty_hint(tr::now) : QString());
			if (!hint.isEmpty()) {
				auto st = Label::Small();
				st.align = style::al_top;
				st.multiline = true;
				block(object_ptr<Label>(_list, hint, st), Rem(1.5));
			}
		}
		// Строки-папки в конце корня
		if (isRoot) {
			const auto virtualRow = [&](const QString &view, int count) {
				const auto hint = (view == u"shared"_q)
					? (count ? tr::lng_parvane_cloud_shared_count(tr::now, lt_amount, QString::number(count)) : tr::lng_parvane_cloud_shared_none(tr::now))
					: (view == u"links"_q)
					? (count ? tr::lng_parvane_cloud_links_count(tr::now, lt_amount, QString::number(count)) : tr::lng_parvane_cloud_links_none(tr::now))
					: (count ? tr::lng_parvane_cloud_trash_count(tr::now, lt_amount, QString::number(count)) : tr::lng_parvane_cloud_empty_trash(tr::now));
				const auto row = static_cast<ListRow*>(listRow(object_ptr<ListRow>(_list, ListRow::Descriptor{
					.tile = Tile{
						.icon = view == u"shared"_q ? u"users"_q : view == u"links"_q ? u"link"_q : u"trash"_q,
						.color = ToneColor(Tone::Fg),
					},
					.title = VirtualName(view),
					.sub = hint,
				})));
				row->setCallbacks([=] { goTo(Place{ view, {}, {} }); });
			};
			auto sharedCount = 0;
			for (const auto &c : containers) {
				sharedCount += (c.kind == "shared") ? 1 : 0;
			}
			virtualRow(u"shared"_q, sharedCount);
			virtualRow(u"links"_q, (Links() && Links()->is_array()) ? int(Links()->size()) : 0);
			virtualRow(u"trash"_q, int(Trash().size()));
		}
	}

	// Занятое место
	if (data.usage && data.usage->value("quota", std::int64_t(0)) > 0) {
		const auto used = data.usage->value("used", std::int64_t(0));
		const auto quota = data.usage->value("quota", std::int64_t(0));
		const auto links = data.usage->value("linksBytes", std::int64_t(0));
		const auto share = double(used) / quota;
		auto text = tr::lng_parvane_cloud_usage(tr::now, lt_used, FormatSize(used), lt_total, FormatSize(quota));
		const auto sizes = cloud::usageOf(NodesOf(data.rootId.value_or(std::string())));
		if (sizes.trash > 0) {
			text += u" · "_q + tr::lng_parvane_cloud_usage_trash(tr::now, lt_size, FormatSize(sizes.trash));
		}
		if (links > 0) {
			text += u" · "_q + tr::lng_parvane_cloud_usage_links(tr::now, lt_size, FormatSize(links));
		}
		text += u" · "_q + tr::lng_parvane_cloud_encrypted(tr::now);
		auto st = Label::Style();
		st.px = 13;
		st.tone = Tone::Muted;
		st.multiline = true;
		const auto warn = share >= kUsageWarnShare;
		// `.usage`: поле сверху 0.875rem; «Место почти закончилось» — красным
		_list->add(object_ptr<Label>(_list, text, st), style::margins(pad, Rem(0.875), pad, warn ? 0 : pad));
		if (warn) {
			auto alert = st;
			alert.tone = Tone::Red;
			_list->add(object_ptr<Label>(_list, tr::lng_parvane_cloud_usage_almost_full(tr::now), alert), style::margins(pad, 0, pad, pad));
		}
	} else {
		_list->add(object_ptr<Ui::RpWidget>(_list), style::margins(0, 0, 0, pad))->resize(1, 0);
	}

	_list->resizeToWidth(_scroll->width());
	_scroll->scrollToY(scrollTop);

	// Уведомление
	if (const auto notice = Notice()) {
		_toast->setText(NoticeText(*notice));
		_toast->show();
	} else {
		_toast->hide();
	}
	layoutIsland();
}

} // namespace

} // namespace Parvane::Cloud

namespace Parvane {

void OpenCloudNode(const std::string &container, const std::string &nodeId) {
	Cloud::PendingOpen() = Cloud::OpenRequest{ container, nodeId };
	ShowSection(Section::Files);
	Cloud::OpenRequests().fire({});
}

void RegisterCloud() {
	RegisterSectionFactory(Section::Files, [](
			not_null<QWidget*> parent,
			not_null<Window::SessionController*> controller,
			Section section) {
		return object_ptr<Ui::RpWidget>(object_ptr<Cloud::CloudScreen>(parent.get(), controller));
	});
}

} // namespace Parvane
