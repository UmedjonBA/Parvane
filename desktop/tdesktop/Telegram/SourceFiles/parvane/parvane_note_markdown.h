// Parvane fork: показ текста заметки «Знаний» (spec 029, T063) — порт web `markdown/MarkdownBlocks.tsx` и
// `Markdown.module.scss`: заголовки (`--pv-accent` / `--pv-orange`), абзацы, цитаты, код, черта, таблицы, списки с
// круглыми галочками (`--pv-task`) и датой задачи «Плана», встроенные файлы. Блоки — из разбора ядра
// (parvane::sections::markdown), строки — Knowledge::RichText.
#pragma once

#include "parvane/parvane_knowledge_common.h"

namespace Parvane::Knowledge {

struct MarkdownCallbacks {
	// Есть ли заметка с таким названием: ссылка на несозданную — красным
	Fn<bool(const std::string&)> noteExists;
	Fn<void(QString)> openNote;
	// Пункт с галочкой отмечен (по номеру строки); пусто — галочка только показывается
	Fn<void(int line, bool done)> toggleTask;
	// Пункт, ставший задачей «Плана»: текст без служебной метки и хвост (дата задачи)
	Fn<std::pair<std::string, QString>(const std::string &text)> taskTail;
	// Встроенный файл
	Fn<object_ptr<Ui::RpWidget>(QWidget *parent, const md::MdBlock &block)> embed;
};

class MarkdownView final : public Ui::RpWidget {
public:
	MarkdownView(QWidget *parent, MarkdownCallbacks callbacks);

	void setBlocks(const std::vector<md::MdBlock> &blocks);

protected:
	int resizeGetHeight(int newWidth) override;

private:
	struct Entry {
		Ui::RpWidget *widget = nullptr;
		int marginTop = 0;
	};
	void clear();
	[[nodiscard]] object_ptr<Ui::RpWidget> createBlock(const md::MdBlock &block, int &marginTop);
	[[nodiscard]] int maxContentWidth() const;

	MarkdownCallbacks _callbacks;
	std::vector<Entry> _entries;

};

// Показ Markdown только для чтения (окно чтения статьи и т. п.): первый заголовок, повторяющий title, пропускается;
// [[заметки]] — openNote (пусто — не нажимаются), встроенные файлы — подписью с именем. Ширина — по ширине виджета
[[nodiscard]] object_ptr<Ui::RpWidget> CreateMarkdownView(
	QWidget *parent,
	const std::string &markdown,
	const std::string &title = std::string(),
	Fn<void(QString target)> openNote = nullptr);

} // namespace Parvane::Knowledge
