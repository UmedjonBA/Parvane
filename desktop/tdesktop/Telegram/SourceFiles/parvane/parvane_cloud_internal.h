// Parvane fork: общее для файлов раздела «Облако» (parvane_cloud*.cpp, spec 029, T064) — состояние экрана
// (web cloudStore.ts: место, переносы, уведомление, ссылки, сортировка), значки и виджеты по `Cloud.module.scss`,
// шторки (CloudDialogs, CloudShareDialog, CloudLinkBlock, CloudPreview, CloudSendDialog, CloudChatDialogs).
#pragma once

#include "parvane/parvane_kit.h"
#include "parvane/parvane_sections_data.h"

#include <parvane/sections/cloud_files.h>
#include <parvane/sections/cloud_model.h>

#include <QtGui/QImage>

#include <atomic>

namespace Window {
class SessionController;
} // namespace Window

namespace Parvane::Cloud {

namespace cloud = parvane::sections::cloud;
using json = nlohmann::json;
using cloud::CloudNode;
using cloud::CloudContainerInfo;

// ── данные ───────────────────────────────────────────────────────────────────

// Узел и его контейнер (web `Entry`)
struct Entry {
	std::string container;
	CloudNode node;
};
[[nodiscard]] QString KeyOf(const Entry &entry);

// Место в едином списке (web `CloudPlace`): view — "" | shared | links | trash
struct Place {
	QString view;
	std::string container;
	std::string folder;
	bool operator==(const Place &) const = default;
};

// Разобранный снимок CloudView: контейнеры и деревья
struct Data {
	std::shared_ptr<const Sections::CloudView> view;
	std::string status = "loading";
	std::optional<std::string> rootId;
	std::vector<CloudContainerInfo> containers;
	std::map<std::string, std::vector<CloudNode>> trees;
	std::map<std::string, json> rawNodes; // узлы как в JSON движка (для ядра: план ссылки, перенос)
	std::optional<json> usage;
};
[[nodiscard]] const Data &Current();
[[nodiscard]] rpl::producer<> DataChanges();
[[nodiscard]] bool IsLoaded();

[[nodiscard]] const CloudContainerInfo *ContainerOf(const std::string &id);
[[nodiscard]] const std::vector<CloudNode> &NodesOf(const std::string &id);
[[nodiscard]] std::optional<json> RawNode(const std::string &container, const std::string &id);
[[nodiscard]] bool CanEdit(const std::string &container);
[[nodiscard]] std::string ActiveContainer(const Place &place);
[[nodiscard]] std::vector<Entry> Trash();

// ── переносы, уведомление, ссылки (web cloudStore.ts) ────────────────────────

struct Transfer {
	QString id;
	QString kind; // upload | download | move
	QString name;
	std::int64_t done = 0;
	std::int64_t total = 0;
	QString state; // active | done | failed | canceled
	QString error;
	std::shared_ptr<std::atomic<bool>> cancel;
};

struct LinkProgress {
	QString id;
	std::int64_t done = 0;
	std::int64_t total = 0;
	std::string container;
	std::string node;
	std::shared_ptr<std::atomic<bool>> cancel;
};

[[nodiscard]] const std::vector<Transfer> &Transfers();
[[nodiscard]] std::optional<QString> Notice(); // код: ошибка облака | saved | sent
[[nodiscard]] const std::optional<json> &Links(); // нет — список ещё не загружен
[[nodiscard]] const std::optional<LinkProgress> &CurrentLinkProgress();
[[nodiscard]] rpl::producer<> StoreChanges(); // переносы, уведомление, ссылки, сортировка, место

[[nodiscard]] const Place &CurrentPlace();
void SetPlace(Place place);
[[nodiscard]] cloud::Sort CurrentSort();
void SetSort(cloud::Sort sort);

void ShowNotice(const QString &code);
void HideNotice();

// Подписи (web CLOUD_ERROR_KEYS и т. п.)
[[nodiscard]] QString ErrorText(const QString &code);
[[nodiscard]] QString NoticeText(const QString &code);
[[nodiscard]] QString FormatSize(std::int64_t bytes);
[[nodiscard]] QString ShortDate(std::int64_t ms, bool withYear = false); // «5 окт»
[[nodiscard]] QString LongDate(std::int64_t seconds); // «5 октября 2026 г.»
[[nodiscard]] QString NameOf(const std::string &address); // ник без домена
[[nodiscard]] QString ContainerName(const CloudContainerInfo *container);
[[nodiscard]] QString VirtualName(const QString &view);
[[nodiscard]] QString RoleTitle(const std::string &role);
[[nodiscard]] QString ItemsText(int count);
[[nodiscard]] QString NameErrorText(std::optional<cloud::NameError> error);
[[nodiscard]] QString Q(const std::string &text);
[[nodiscard]] std::string S(const QString &text);

// Действия (web cloudStore.ts); итог — уведомлением, данные перечитываются сами
void Load(); // при открытии раздела: ссылки и занятое место
void SetActive(bool active);
void RefreshUsage();
void RefreshLinks();
void CreateFolder(const QString &name);
void Rename(const Entry &entry, const QString &name);
void MoveNodes(const std::string &container, const std::vector<CloudNode> &nodes, std::optional<std::string> target);
void MoveAcross(const std::string &from, const std::vector<CloudNode> &nodes, const std::string &to, std::optional<std::string> target);
void TrashNodes(const std::string &container, const std::vector<CloudNode> &nodes);
void RestoreNodes(const std::string &container, const std::vector<CloudNode> &nodes);
void PurgeNodes(const std::string &container, const std::vector<CloudNode> &nodes);
void EmptyTrash();
void RunByContainer(const std::vector<Entry> &list, Fn<void(const std::string&, const std::vector<CloudNode>&)> run);
void ShareFolder(const Entry &entry, Fn<void(std::optional<std::string>)> done);
void UnshareFolder(const std::string &container);
void AnswerInvite(const std::string &container, bool accept);
void Leave(const std::string &container, Fn<void(bool)> done = nullptr);
void RemoveShared(const std::string &container, Fn<void(bool)> done = nullptr);
void CallShared(const std::string &method, json args, Fn<void(bool, json)> done = nullptr);
void UploadFiles(const std::string &container, std::optional<std::string> parent, const QStringList &paths);
void UploadHere(const QStringList &paths); // в открытую папку
void RetryUpload(const QString &id);
void CancelTransfer(const QString &id);
void Download(not_null<QWidget*> parent, const Entry &entry);
void CreateLink(const std::string &container, std::optional<std::string> node, const QString &name, int ttlDays);
void CancelLinkCreate();
void RevokeLink(const QString &id, Fn<void(bool)> done = nullptr);
void ExtendLink(const QString &id, int ttlDays, Fn<void(bool)> done = nullptr);
[[nodiscard]] std::optional<json> LinkOfSource(const std::string &container, const std::string &node);
// Миниатюра узла (кэш на сессию; загружается в фоне, по готовности — StoreChanges)
[[nodiscard]] QImage Thumb(const std::string &container, const CloudNode &node);
// Содержимое файла для просмотра → done на главном потоке (nullopt — не удалось)
void OpenBlob(const Entry &entry, Fn<void(std::optional<QByteArray>)> done);
// Файлы во временный каталог (для отправки в чат) → пути по порядку; не скачанный — пропущен
void DownloadToTemp(const std::vector<Entry> &entries, Fn<void(QStringList, QString error)> done);

// ── значки и виджеты (Cloud.module.scss, PvKit) ───────────────────────────────

// Значок web PvIcon (поле 24, штрих 1.8); нет в общем наборе ParvaneIcon — свой контур
void PaintCloudIcon(QPainter &p, const QString &name, const QColor &color, int x, int y, int size);

// Плитка `.ava` со значком либо буквой либо миниатюрой
struct Tile {
	QString icon;
	QString letter;
	QColor color;
	QImage thumb;
	Kit::AvatarSize size = Kit::AvatarSize::Large;
	bool round = false;
};
void PaintTile(QPainter &p, QPoint topLeft, const Tile &tile);

// `.ib`
class IconBtn final : public Kit::Button {
public:
	IconBtn(QWidget *parent, const QString &icon, const QString &name, bool small = false, std::optional<Tone> tone = {});
	void setIcon(const QString &icon);

protected:
	void paintEvent(QPaintEvent *e) override;

private:
	QString _icon;
	bool _small = false;
	std::optional<Tone> _tone;

};

// `.pill` / `.pillAcc`; sortPill — `.sortPill` (2.625rem, рамка `--pv-line2`, значок справа)
class PillBtn final : public Kit::Button {
public:
	PillBtn(QWidget *parent, const QString &text, const QString &icon, bool accent = false, bool sortPill = false);
	void setText(const QString &text);
	void setIcon(const QString &icon);

protected:
	void paintEvent(QPaintEvent *e) override;

private:
	void refreshSize();

	QString _text;
	QString _icon;
	bool _accent = false;
	bool _sort = false;

};

// `.btn` и варианты
class Btn final : public Kit::Button {
public:
	using Kind = Kit::PushButton::Kind;
	Btn(QWidget *parent, const QString &text, Kind kind = Kind::Normal, const QString &icon = QString());
	void setText(const QString &text);
	void setIcon(const QString &icon);
	void setKind(Kind kind);

protected:
	void paintEvent(QPaintEvent *e) override;

private:
	void refreshSize();

	QString _text;
	QString _icon;
	Kind _kind = Kind::Normal;

};

// Строка списка (`.row` + `.item`, `.plainRow`): плитка, название, подпись, справа — дети, которых кладёт
// вызывающий (addRight). selectable — флажок выделения поверх плитки (`.itemCheck`)
class ListRow final : public Kit::Button {
public:
	struct Descriptor {
		Tile tile;
		QString title;
		QString sub;
		QString subAccent; // `.shared` — вторая часть подписи фиолетовым
		bool plain = false; // `.plainRow`: без подсветки под курсором
		std::optional<QColor> background; // `.inviteRow`
		bool danger = false; // `.rowRed`
		bool selectable = false;
		bool selected = false;
		bool selecting = false;
		int indent = 0; // отступ слева (дерево «Переместить»)
		QString note; // `.muted .small` справа от названия («сейчас здесь»)
		bool checkMark = false; // `.treeCheck`
		std::optional<double> progress; // `.transferBar`
		bool subError = false; // `.transferFailed .transferState`
		bool compact = false; // строка шторки (2.75rem, без `.item` 3.25rem)
	};
	ListRow(QWidget *parent, Descriptor descriptor);

	void setDescriptor(Descriptor descriptor);
	template <typename Widget>
	Widget *addRight(object_ptr<Widget> &&child) {
		return static_cast<Widget*>(addRightItem(std::move(child)));
	}
	// Нажатие на строку — open, на плитку выделяемой строки — toggle (setClickedCallback не звать)
	void setCallbacks(Fn<void()> open, Fn<void()> toggle = nullptr);

protected:
	int resizeGetHeight(int newWidth) override;
	void paintEvent(QPaintEvent *e) override;
	void mousePressEvent(QMouseEvent *e) override;

private:
	Ui::RpWidget *addRightItem(object_ptr<Ui::RpWidget> child);
	void relayout();
	[[nodiscard]] QRect tileRect() const;

	Descriptor _d;
	std::vector<Ui::RpWidget*> _right;
	Fn<void()> _open;
	Fn<void()> _toggle;
	bool _pressOnTile = false;

};

// Обычный текст с переносом; tone и размер — как Kit::Label
[[nodiscard]] object_ptr<Kit::Label> Text(QWidget *parent, const QString &text, Kit::Label::Style st);

// Ряд виджетов по горизонтали с промежутком (`display: flex; gap`): stretch — индекс растягиваемого
class HRow final : public Ui::RpWidget {
public:
	HRow(QWidget *parent, int gap);
	template <typename Widget>
	Widget *add(object_ptr<Widget> &&child, bool stretch = false) {
		return static_cast<Widget*>(addItem(std::move(child), stretch));
	}

protected:
	int resizeGetHeight(int newWidth) override;

private:
	Ui::RpWidget *addItem(object_ptr<Ui::RpWidget> child, bool stretch);

	struct Item {
		Ui::RpWidget *widget = nullptr;
		bool stretch = false;
	};
	std::vector<Item> _items;
	int _gap = 0;
	bool _inResize = false;

};

// ── шторки ───────────────────────────────────────────────────────────────────

struct MenuAction {
	QString key;
	QString icon;
	QString title;
	bool danger = false;
};
// `CloudMenu`: шторка действий «⋯»
void ShowMenuSheet(not_null<QWidget*> parent, const QString &title, std::vector<MenuAction> actions, Fn<void(QString)> pick);

// `CloudNameDialog`
void ShowNameSheet(
	not_null<QWidget*> parent,
	const QString &title,
	const QString &label,
	const QString &confirm,
	const QString &initial,
	Fn<void(QString)> submit);

// `ConfirmDialog`
void ShowConfirmSheet(
	not_null<QWidget*> parent,
	const QString &title,
	const QString &text,
	const QString &confirm,
	bool destructive,
	Fn<void()> confirmed);

// `CloudFolderDialog`: место назначения (web `CloudMovePlace`)
struct MovePlace {
	std::string id;
	QString name;
	bool shared = false;
	std::vector<CloudNode> nodes;
};
struct FolderSheetArgs {
	QString title;
	QString rootName;
	std::vector<CloudNode> nodes;
	std::vector<std::string> movedIds;
	std::optional<std::string> startFolder;
	std::vector<MovePlace> places;
	std::optional<std::string> sourcePlace;
	QString confirm;
	// target — папка (нет — корень места), place — id места (если мест несколько)
	Fn<void(std::optional<std::string> target, std::optional<std::string> place)> submit;
};
void ShowFolderSheet(not_null<QWidget*> parent, FolderSheetArgs args);

// `CloudShareDialog`: containerId пусто — создание новой совместной папки
void ShowShareSheet(
	not_null<QWidget*> parent,
	not_null<Window::SessionController*> controller,
	std::optional<std::string> containerId);

// `CloudLinkDialog`: источник (узел либо вся папка) или строка «Моих ссылок»
struct LinkSource {
	std::string container;
	std::optional<std::string> node;
	QString name;
};
void ShowLinkSheet(not_null<QWidget*> parent, std::optional<LinkSource> source, std::optional<QString> linkId);
// `CloudLinkBlock` внутри другой шторки
[[nodiscard]] object_ptr<Ui::RpWidget> MakeLinkBlock(
	QWidget *parent,
	not_null<QWidget*> sheetParent,
	std::optional<LinkSource> source,
	std::optional<QString> linkId,
	bool hasHeading,
	Fn<void()> revoked);

// `CloudPreview`
struct PreviewArgs {
	Entry entry;
	std::vector<Entry> siblings;
	QString folderText;
	QString accessText;
	Fn<void(Entry)> navigate;
	Fn<void(Entry)> download;
	Fn<void(Entry)> send;
	Fn<void(Entry)> more;
};
void ShowPreviewSheet(not_null<QWidget*> parent, PreviewArgs args);

// `CloudSendDialog`: выбор чата и отправка файлов
void SendToChat(not_null<Window::SessionController*> controller, std::vector<Entry> entries);

} // namespace Parvane::Cloud
