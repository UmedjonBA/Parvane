// Parvane fork: заметка «Знаний» (spec 029, T063) — порт web `notes/NoteView.tsx` и `notes/NoteEmbed.tsx`: чтение
// с живыми [[ссылками]], тегами и круглыми галочками; правка — текстом `.md` (Ui::InputField); название правится на
// месте; свойства, папка (перенос в другую), ближайшая запись «Плана»; «Запланировано» (записи «Плана» со ссылкой
// сюда); на узком экране и в панели графа — ещё и «Связи». Встроенные файлы — карточкой файла личного диска.
#pragma once

#include "parvane/parvane_knowledge_common.h"

#include "base/unique_qptr.h"

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
	void save();
	void toggleTask(int line, bool done);
	void askDelete();
	void schedule();
	void chooseFromCloud();
	void insertEmbeds(const std::vector<QString> &names);
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
	base::unique_qptr<Ui::RpWidget> _buttons;
	base::unique_qptr<Ui::RpWidget> _planned;
	base::unique_qptr<NoteLinks> _links;

};

} // namespace Parvane::Knowledge
