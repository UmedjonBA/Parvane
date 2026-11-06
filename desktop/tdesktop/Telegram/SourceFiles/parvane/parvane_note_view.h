// Parvane fork: заметка «Знаний» (spec 029, T063) — порт web `notes/NoteView.tsx` и `notes/NoteEmbed.tsx`: чтение
// с живыми [[ссылками]], тегами и круглыми галочками; правка — текстом `.md` (Ui::InputField); название правится на
// месте; свойства, папка (перенос в другую), ближайшая запись «Плана»; «Запланировано» (записи «Плана» со ссылкой
// сюда); на узком экране и в панели графа — ещё и «Связи». Встроенные файлы — карточкой файла личного диска.
#pragma once

#include "base/timer.h"

#include "parvane/parvane_knowledge_common.h"
#include "parvane/parvane_note_markdown.h"

#include "base/unique_qptr.h"

namespace Ui {
class ScrollArea;
} // namespace Ui

#include <QtGui/QImage>

namespace Ui {
class InputField;
} // namespace Ui

namespace Parvane::Knowledge {

class MarkdownView;
class NoteLinks;

struct NoteData {
	notes::NoteRef note;
	std::shared_ptr<const notes::NotesIndex> index;
	std::vector<notes::PlannedItem> planned;
	notes::CloudDataRef cloud;
	planner::State planner;
};

struct NoteOptions {
	// «Связи» стоят под заметкой, когда для них нет отдельного острова справа
	bool hasLinks = false;
	// «Связи» без малого графа: заметка стоит в панели большого
	bool isGraphHidden = false;
	// Узкий экран: сверху своя шапка и стрелка назад
	bool narrow = false;
};

struct NoteCallbacks {
	Fn<void(QString title)> openTitle;
	Fn<void()> back; // только на узком экране
	Fn<void(std::string noteId)> deleted; // заметка ушла в корзину
	Fn<void(std::string noteId)> pickFolder; // перенос в другую папку; пусто — папка не кнопка
	Fn<void(bool editing)> editingChanged; // правка открыта/закрыта: раздел убирает список и «Связи»
};

class NoteView final : public Ui::RpWidget {
public:
	NoteView(QWidget *parent, NoteOptions options, NoteCallbacks callbacks);
	~NoteView();

	void setData(NoteData data);
	[[nodiscard]] const std::string &noteId() const;
	[[nodiscard]] bool isEditing() const;

	// Открыть правку с выделенным куском текста (позиции — байты UTF-8 текста заметки)
	void requestEdit(size_t from, size_t to);
	// Высота видимой области раздела: правка на широком экране занимает её целиком (редактор и просмотр)
	void setViewportHeight(int height);

protected:
	int resizeGetHeight(int newWidth) override;

private:
	void rebuildTitle();
	void rebuildProps();
	void rebuildBody();
	void rebuildButtons();
	void rebuildPlanned();
	void rebuildLinks();
	void relayout();

	void startEdit();
	void cancelEdit();
	void rebuildPreview();
	void refreshEditing();
	void syncFromEditor();
	void syncFromPreview();
	[[nodiscard]] MarkdownCallbacks markdownCallbacks(bool withTasks);
	void save();
	void toggleTask(int line, bool done);
	void askDelete();
	void schedule();
	void chooseFromCloud();
	void insertEmbeds(const std::vector<QString> &names);
	void insertLocalFiles(const QStringList &paths);
	void insertClipboardImage(const QImage &image);
	void commitTitle();
	[[nodiscard]] object_ptr<Ui::RpWidget> createEmbed(QWidget *parent, const md::MdBlock &block);

	const NoteOptions _options;
	const NoteCallbacks _callbacks;
	NoteData _data;
	std::string _shownId;
	std::string _shownTitle;
	std::string _shownText;

	std::optional<std::string> _base; // текст, с которого начата правка
	bool _saving = false;
	std::optional<std::pair<int, int>> _selection; // выделить после открытия правки (QString)

	struct TitleStyle;
	std::unique_ptr<TitleStyle> _titleStyle;

	base::unique_qptr<Ui::RpWidget> _bar;
	NotesIconButton *_barToggle = nullptr;
	base::unique_qptr<Ui::RpWidget> _backButton;
	base::unique_qptr<Ui::RpWidget> _title;
	Ui::InputField *_titleField = nullptr;
	base::unique_qptr<Ui::RpWidget> _props;
	base::unique_qptr<Ui::RpWidget> _tools;
	base::unique_qptr<Kit::Field> _editor;
	base::unique_qptr<MarkdownView> _markdown;
	// Правка: живой просмотр текста (широкий экран — справа от редактора, узкий — вместо него по кнопке)
	base::unique_qptr<Ui::ScrollArea> _previewScroll;
	MarkdownView *_preview = nullptr;
	int _viewportHeight = 0;
	bool _inLayout = false;
	// Прокрутку одной панели двигает другая: её событие не должно двигать первую в ответ
	bool _drivingEditor = false;
	bool _drivingPreview = false;
	NotesIconButton *_previewToggle = nullptr;
	bool _previewShown = false;
	bool _reportedEditing = false;
	base::Timer _previewTimer;
	base::unique_qptr<Ui::RpWidget> _buttons;
	base::unique_qptr<Ui::RpWidget> _planned;
	base::unique_qptr<NoteLinks> _links;

};

} // namespace Parvane::Knowledge
