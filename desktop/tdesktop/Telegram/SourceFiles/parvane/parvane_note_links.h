// Parvane fork: «Связи» заметки «Знаний» (spec 029, T063) — порт web `notes/NoteLinks.tsx`: обратные ссылки и малый
// граф (заметка в центре, вокруг — заметки, на которые она ссылается, заметки, ссылающиеся на неё, и записи «Плана»
// со ссылкой сюда).
#pragma once

#include "parvane/parvane_knowledge_common.h"

namespace Parvane::Knowledge {

class NoteLinks final : public Ui::RpWidget {
public:
	struct Args {
		notes::NoteRef note;
		std::shared_ptr<const notes::NotesIndex> index;
		std::vector<notes::PlannedItem> planned;
		// Только обратные ссылки: рядом уже стоит большой граф
		bool isGraphHidden = false;
		Fn<void(QString title)> openTitle;
	};
	NoteLinks(QWidget *parent, Args args);

protected:
	int resizeGetHeight(int newWidth) override;

private:
	Ui::RpWidget *_caption = nullptr;
	Ui::RpWidget *_empty = nullptr;
	std::vector<Ui::RpWidget*> _rows;
	Ui::RpWidget *_graphCaption = nullptr;
	Ui::RpWidget *_graph = nullptr;

};

} // namespace Parvane::Knowledge
