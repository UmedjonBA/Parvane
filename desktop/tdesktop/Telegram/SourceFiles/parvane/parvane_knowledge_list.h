// Parvane fork: список заметок «Знаний» (spec 029, T063) — порт `renderList` / `renderGroup` / `renderRow` web
// `notes/Knowledge.tsx`: группы «Без папки», папки (сворачиваются, «+» и «⋯»), заметки дня (свежие пять, «Показать все»),
// строки с плиткой-буквой, началом текста и ближайшей датой «Плана», перенос заметки в папку перетаскиванием,
// сообщение о справке и кнопки «Новая заметка» / «Новая папка» / «Вернуть справку».
#pragma once

#include "parvane/parvane_knowledge_common.h"

#include <parvane/sections/notes_folders.h>

namespace Parvane::Knowledge {

struct KnowledgeListData {
	std::vector<notes::NoteRef> notes;
	std::vector<notes::NoteFolder> folders;
	// Найденное поиском (id заметок по порядку); nullopt — поиска нет
	std::optional<std::vector<std::string>> found;
	std::vector<std::string> collapsed;
	std::optional<std::string> openId;
	bool areAllDailyShown = false;
	// Ближайшая дата «Плана» по заметке (уже отформатирована)
	std::map<std::string, QString> nearest;
	// Сообщение о появившейся папке справки (подпись папки); пусто — не показывать
	QString guideNotice;
	// Справки нет — кнопка «Вернуть справку»
	bool guideMissing = false;
	bool narrow = false;
};

struct KnowledgeListCallbacks {
	Fn<void(std::string noteId)> pick;
	Fn<void(std::string groupKey)> toggleGroup;
	// Новая заметка в группе: папка (nullopt — «Без папки»), ключ группы раскрывается
	Fn<void(std::optional<std::string> folderId, std::string groupKey)> newInFolder;
	Fn<void(std::string folderId)> folderMenu;
	Fn<void()> showAllDaily;
	Fn<void()> newNote;
	Fn<void()> newFolder;
	Fn<void()> guide;
	Fn<void()> guideDismiss;
	Fn<void(std::string noteId, std::optional<std::string> folderId)> move;
};

class KnowledgeList final : public Ui::RpWidget {
public:
	KnowledgeList(QWidget *parent, KnowledgeListCallbacks callbacks);

	void setData(KnowledgeListData data);
	// Строка открытой заметки — для прокрутки к ней
	[[nodiscard]] std::optional<QRect> rowGeometry(const std::string &noteId) const;

protected:
	int resizeGetHeight(int newWidth) override;
	void paintEvent(QPaintEvent *e) override;
	bool eventFilter(QObject *o, QEvent *e) override;

private:
	struct Item {
		Ui::RpWidget *widget = nullptr;
		int top = 0; // отступ сверху
		bool fullWidth = false;
		int group = -1; // номер группы (для переноса)
	};
	struct GroupInfo {
		std::string key;
		std::optional<std::string> folderId;
		bool isTarget = false;
		QRect rect;
	};
	struct RowDrag {
		std::string noteId;
		QPoint start;
		bool active = false;
	};

	void rebuild();
	void clear();
	void add(Ui::RpWidget *widget, int top, int group = -1);
	[[nodiscard]] int groupAt(QPoint position) const;

	KnowledgeListCallbacks _callbacks;
	KnowledgeListData _data;
	std::vector<Item> _items;
	std::vector<GroupInfo> _groups;
	std::map<std::string, Ui::RpWidget*> _rows;
	std::map<QObject*, std::string> _draggable;
	std::optional<RowDrag> _drag;
	int _dropGroup = -1;
	bool _suppressClick = false;

};

} // namespace Parvane::Knowledge
