// Parvane fork: реализация parvane_note_markdown.h. Размеры — из web `Markdown.module.scss` (в комментариях — rem).
#include "parvane/parvane_note_markdown.h"

#include <parvane/sections/notes_view.h>

#include "ui/painter.h"
#include "styles/style_basic.h"

#include <QtGui/QtEvents>

namespace Parvane::Knowledge {
namespace {

using Kit::Px;
using Kit::Rem;

// Цитата: черта 0.1875rem `--pv-accent` слева и отступ 0.75rem, текст `--pv-muted`
class QuoteBlock final : public Ui::RpWidget {
public:
	QuoteBlock(QWidget *parent, const std::string &text, const MarkdownCallbacks &callbacks)
	: RpWidget(parent)
	, _text(Ui::CreateChild<RichText>(this, RichText::Style{ .tone = Tone::Muted })) {
		Kit::RepaintOnTones(this);
		_text->setMarkdown(text, callbacks.noteExists);
		_text->setOpenNote(callbacks.openNote);
	}

protected:
	int resizeGetHeight(int newWidth) override {
		const auto left = Rem(0.1875) + Rem(0.75);
		_text->resizeToWidth(std::max(newWidth - left, 1));
		_text->moveToLeft(left, 0, newWidth);
		return _text->height();
	}
	void paintEvent(QPaintEvent *e) override {
		auto p = QPainter(this);
		p.fillRect(0, 0, Rem(0.1875), height(), ToneColor(Tone::Accent));
	}

private:
	const not_null<RichText*> _text;

};

// Код: подложка `--pv-raised`, скругление 0.5rem, поля 0.5rem 0.75rem, моноширинный 0.8125rem
class PreBlock final : public Ui::RpWidget {
public:
	PreBlock(QWidget *parent, const std::string &text)
	: RpWidget(parent)
	, _text(Ui::CreateChild<RichText>(this, RichText::Style{ .px = 13, .mono = true })) {
		Kit::RepaintOnTones(this);
		_text->setPlain(Q(text));
	}

protected:
	int resizeGetHeight(int newWidth) override {
		const auto padX = Rem(0.75);
		const auto padY = Rem(0.5);
		_text->resizeToWidth(std::max(newWidth - 2 * padX, 1));
		_text->moveToLeft(padX, padY, newWidth);
		return _text->height() + 2 * padY;
	}
	void paintEvent(QPaintEvent *e) override {
		auto p = QPainter(this);
		PainterHighQualityEnabler hq(p);
		p.setPen(Qt::NoPen);
		p.setBrush(ToneColor(Tone::Raised));
		const auto radius = Rem(0.5);
		p.drawRoundedRect(rect(), radius, radius);
	}

private:
	const not_null<RichText*> _text;

};

// Черта: 1px `--pv-line`, поля 0.25rem
class RuleBlock final : public Ui::RpWidget {
public:
	explicit RuleBlock(QWidget *parent) : RpWidget(parent) {
		Kit::RepaintOnTones(this);
		resize(width(), Rem(0.25) * 2 + Px(1));
	}

protected:
	int resizeGetHeight(int newWidth) override {
		return Rem(0.25) * 2 + Px(1);
	}
	void paintEvent(QPaintEvent *e) override {
		auto p = QPainter(this);
		p.fillRect(0, Rem(0.25), width(), Px(1), ToneColor(Tone::Line));
	}

};

// Пункт списка: метка (точка / номер `--pv-faint`) либо круглая галочка, текст, хвост-дата задачи «Плана»
class ItemRow final : public Ui::RpWidget {
public:
	ItemRow(
		QWidget *parent,
		const md::MdListItem &item,
		bool ordered,
		int number,
		const MarkdownCallbacks &callbacks)
	: RpWidget(parent)
	, _depth(item.depth)
	, _task(item.isChecked.has_value()) {
		Kit::RepaintOnTones(this);
		auto text = item.text;
		auto tail = QString();
		if (_task && callbacks.taskTail) {
			auto [clean, when] = callbacks.taskTail(text);
			text = std::move(clean);
			tail = std::move(when);
		}
		const auto done = _task && *item.isChecked;
		_text = Ui::CreateChild<RichText>(this, RichText::Style{
			.tone = done ? Tone::Faint : Tone::Fg,
			.strike = done,
		});
		_text->setMarkdown(text, callbacks.noteExists);
		_text->setOpenNote(callbacks.openNote);
		if (_task) {
			_check = Ui::CreateChild<Kit::Check>(this, Q(text), done, true, Tone::Purple);
			if (const auto toggle = callbacks.toggleTask) {
				const auto line = item.line;
				_check->checkedChanges() | rpl::on_next([=](bool checked) {
					toggle(line, checked);
				}, _check->lifetime());
			} else {
				_check->setAttribute(Qt::WA_TransparentForMouseEvents);
			}
			if (!tail.isEmpty()) {
				_tail = Ui::CreateChild<Kit::Tag>(this, Kit::Tag::Descriptor{
					.text = tail,
					.tone = Tone::Purple,
					.icon = u"cal"_q,
				});
			}
		} else {
			_marker = ordered ? (QString::number(number) + '.') : QString::fromUtf8("•");
		}
	}

protected:
	int resizeGetHeight(int newWidth) override {
		// Пункт с галочкой стоит у края списка (`margin-inline-start: -1.375rem`), прочие — после поля 1.375rem
		const auto indent = _depth * Rem(1.25);
		const auto gap = Rem(0.625);
		auto x = indent + (_task ? 0 : Rem(1.375));
		if (_check) {
			_check->moveToLeft(indent, Rem(0.0625) + std::max((LineHeight() - _check->height()) / 2, 0), newWidth);
			x = indent + _check->width() + gap;
		}
		const auto available = std::max(newWidth - x, 1);
		auto textWidth = available;
		if (_tail) {
			const auto room = available - _tail->width() - Rem(0.375);
			textWidth = std::clamp(_text->naturalTextWidth(), 1, std::max(room, 1));
		}
		_text->resizeToWidth(textWidth);
		_text->moveToLeft(x, 0, newWidth);
		auto height = _text->height();
		if (_tail) {
			const auto tx = x + textWidth + Rem(0.375);
			if (tx + _tail->width() <= newWidth) {
				_tail->moveToLeft(tx, (LineHeight() - _tail->height()) / 2, newWidth);
			} else {
				_tail->moveToLeft(x, height, newWidth);
				height += _tail->height();
			}
		}
		return std::max(height, _check ? _check->height() : 0);
	}
	void paintEvent(QPaintEvent *e) override {
		if (_marker.isEmpty()) {
			return;
		}
		auto p = QPainter(this);
		const auto font = Kit::Font(Kit::kBodyPx);
		p.setFont(font->f);
		p.setPen(ToneColor(Tone::Faint));
		const auto indent = _depth * Rem(1.25);
		const auto box = QRect(indent, 0, Rem(1.375) - Rem(0.25), LineHeight());
		p.drawText(box, Qt::AlignRight | Qt::AlignVCenter, _marker);
	}

private:
	[[nodiscard]] static int LineHeight() {
		return int(std::round(Px(Kit::kBodyPx) * 1.5));
	}

	const int _depth = 0;
	const bool _task = false;
	RichText *_text = nullptr;
	Kit::Check *_check = nullptr;
	Kit::Tag *_tail = nullptr;
	QString _marker;

};

// Список: пункты с промежутком 0.25rem
class ListBlock final : public Ui::RpWidget {
public:
	ListBlock(QWidget *parent, const md::MdBlock &block, const MarkdownCallbacks &callbacks)
	: RpWidget(parent) {
		auto number = 0;
		for (const auto &item : block.items) {
			if (!item.depth) {
				++number;
			}
			_rows.push_back(Ui::CreateChild<ItemRow>(this, item, block.isOrdered, number, callbacks));
		}
	}

protected:
	int resizeGetHeight(int newWidth) override {
		auto y = 0;
		for (const auto row : _rows) {
			if (y) {
				y += Rem(0.25);
			}
			row->resizeToWidth(newWidth);
			row->moveToLeft(0, y, newWidth);
			y += row->height();
		}
		return y;
	}

private:
	std::vector<ItemRow*> _rows;

};

// Таблица: ячейки 0.3125rem 0.625rem в рамке `--pv-line`, шапка — полужирная на `--pv-raised`, текст 0.875rem
class TableBlock final : public Ui::RpWidget {
public:
	TableBlock(QWidget *parent, const md::MdBlock &block, const MarkdownCallbacks &callbacks)
	: RpWidget(parent)
	, _align(block.align) {
		Kit::RepaintOnTones(this);
		_columns = int(block.header.size());
		for (const auto &row : block.rows) {
			_columns = std::max(_columns, int(row.size()));
		}
		const auto addRow = [&](const std::vector<std::string> &cells, bool head) {
			auto row = std::vector<RichText*>();
			for (auto i = 0; i != _columns; ++i) {
				const auto cell = Ui::CreateChild<RichText>(this, RichText::Style{
					.px = 14,
					.semibold = head,
					.lineHeight = 1.45,
				});
				cell->setMarkdown((i < int(cells.size())) ? cells[i] : std::string(), callbacks.noteExists);
				cell->setOpenNote(callbacks.openNote);
				row.push_back(cell);
			}
			_cells.push_back(std::move(row));
		};
		addRow(block.header, true);
		for (const auto &row : block.rows) {
			addRow(row, false);
		}
	}

protected:
	int resizeGetHeight(int newWidth) override {
		const auto padX = Rem(0.625);
		const auto padY = Rem(0.3125);
		const auto line = Px(1);
		// Ширины столбцов: по самому широкому тексту, не шире области (сжимаются пропорционально)
		_widths.assign(_columns, 0);
		for (const auto &row : _cells) {
			for (auto i = 0; i != _columns; ++i) {
				_widths[i] = std::max(_widths[i], row[i]->naturalTextWidth() + 2 * padX + line);
			}
		}
		auto total = line;
		for (const auto w : _widths) {
			total += w;
		}
		if (total > newWidth && total > 0) {
			const auto factor = double(newWidth - line) / double(total - line);
			for (auto &w : _widths) {
				w = std::max(int(w * factor), 2 * padX + line + Px(8));
			}
		}
		_heights.clear();
		auto y = line;
		for (const auto &row : _cells) {
			auto h = 0;
			for (auto i = 0; i != _columns; ++i) {
				row[i]->resizeToWidth(std::max(_widths[i] - 2 * padX - line, 1));
				h = std::max(h, row[i]->height());
			}
			auto x = line;
			for (auto i = 0; i != _columns; ++i) {
				const auto cell = row[i];
				const auto inner = _widths[i] - 2 * padX - line;
				const auto align = (i < int(_align.size())) ? _align[i] : md::MdAlign::None;
				const auto shift = (align == md::MdAlign::Center)
					? (inner - std::min(cell->naturalTextWidth(), inner)) / 2
					: (align == md::MdAlign::Right)
					? (inner - std::min(cell->naturalTextWidth(), inner))
					: 0;
				if (shift > 0) {
					cell->resizeToWidth(std::max(inner - shift, 1));
				}
				cell->moveToLeft(x + padX + std::max(shift, 0), y + padY, newWidth);
				x += _widths[i];
			}
			_heights.push_back(h + 2 * padY + line);
			y += h + 2 * padY + line;
		}
		return y;
	}
	void paintEvent(QPaintEvent *e) override {
		auto p = QPainter(this);
		const auto line = Px(1);
		auto total = line;
		for (const auto w : _widths) {
			total += w;
		}
		if (!_heights.empty()) {
			p.fillRect(line, line, total - line, _heights[0] - line, ToneColor(Tone::Raised));
		}
		const auto color = ToneColor(Tone::Line);
		auto y = 0;
		p.fillRect(0, 0, total, line, color);
		for (const auto h : _heights) {
			y += h;
			p.fillRect(0, y - line, total, line, color);
		}
		auto x = 0;
		p.fillRect(0, 0, line, y, color);
		for (const auto w : _widths) {
			x += w;
			p.fillRect(x, 0, line, y, color);
		}
	}

private:
	std::vector<md::MdAlign> _align;
	int _columns = 0;
	std::vector<std::vector<RichText*>> _cells;
	std::vector<int> _widths;
	std::vector<int> _heights;

};

} // namespace

MarkdownView::MarkdownView(QWidget *parent, MarkdownCallbacks callbacks)
: RpWidget(parent)
, _callbacks(std::move(callbacks)) {
}

void MarkdownView::clear() {
	for (const auto &entry : _entries) {
		delete entry.widget;
	}
	_entries.clear();
}

object_ptr<Ui::RpWidget> MarkdownView::createBlock(const md::MdBlock &block, int &marginTop) {
	marginTop = 0;
	switch (block.type) {
	case md::MdBlockType::Heading: {
		// `.heading1` 1.125rem `--pv-accent`, `.heading2` 1rem и `.heading3` 0.9375rem `--pv-orange`
		const auto px = (block.level <= 1) ? 18 : (block.level == 2) ? 16 : 15;
		marginTop = (block.level <= 1) ? Rem(0.625) : (block.level == 2) ? Rem(0.5) : Rem(0.375);
		auto result = object_ptr<RichText>(this, RichText::Style{
			.px = px,
			.semibold = true,
			.tone = (block.level <= 1) ? Tone::Accent : Tone::Orange,
			.lineHeight = 1.5,
		});
		result->setMarkdown(block.text, _callbacks.noteExists);
		result->setOpenNote(_callbacks.openNote);
		return result;
	}
	case md::MdBlockType::Paragraph: {
		auto result = object_ptr<RichText>(this, RichText::Style());
		result->setMarkdown(block.text, _callbacks.noteExists);
		result->setOpenNote(_callbacks.openNote);
		return result;
	}
	case md::MdBlockType::Quote:
		return object_ptr<QuoteBlock>(this, block.text, _callbacks);
	case md::MdBlockType::Code:
		return object_ptr<PreBlock>(this, block.text);
	case md::MdBlockType::Rule:
		return object_ptr<RuleBlock>(this);
	case md::MdBlockType::Table:
		return object_ptr<TableBlock>(this, block, _callbacks);
	case md::MdBlockType::List:
		return object_ptr<ListBlock>(this, block, _callbacks);
	case md::MdBlockType::Embed:
		if (_callbacks.embed) {
			return _callbacks.embed(this, block);
		}
		break;
	}
	return { nullptr };
}

void MarkdownView::setBlocks(const std::vector<md::MdBlock> &blocks) {
	clear();
	for (const auto &block : blocks) {
		auto marginTop = 0;
		auto widget = createBlock(block, marginTop);
		if (!widget) {
			continue;
		}
		const auto raw = widget.release();
		raw->setParent(this);
		raw->show();
		raw->heightValue() | rpl::skip(1) | rpl::on_next([=] {
			resizeToWidth(width());
		}, raw->lifetime());
		_entries.push_back({ raw, marginTop });
	}
	resizeToWidth(width());
}

int MarkdownView::maxContentWidth() const {
	// `max-width: 70ch`
	return Kit::Font(Kit::kBodyPx)->width(QChar('0')) * 70;
}

int MarkdownView::resizeGetHeight(int newWidth) {
	const auto width = std::min(newWidth, maxContentWidth());
	const auto gap = Rem(0.5);
	auto y = 0;
	for (auto i = 0; i != int(_entries.size()); ++i) {
		const auto &entry = _entries[i];
		if (i) {
			y += gap;
		}
		y += entry.marginTop;
		entry.widget->resizeToWidth(std::max(width, 1));
		entry.widget->moveToLeft(0, y, newWidth);
		y += entry.widget->height();
	}
	return y;
}

object_ptr<Ui::RpWidget> CreateMarkdownView(
		QWidget *parent,
		const std::string &markdown,
		const std::string &title,
		Fn<void(QString target)> openNote) {
	auto result = object_ptr<MarkdownView>(parent, MarkdownCallbacks{
		.openNote = std::move(openNote),
		.taskTail = [](const std::string &text) {
			return std::make_pair(notes::splitTaskMarker(text).text, QString());
		},
		.embed = [](QWidget *parent, const md::MdBlock &block) -> object_ptr<Ui::RpWidget> {
			auto label = object_ptr<RichText>(parent, RichText::Style{ .tone = Tone::Muted });
			if (block.url) {
				auto part = md::MdInline();
				part.type = md::MdInlineType::Link;
				part.text = block.alt.value_or(*block.url);
				part.url = *block.url;
				label->setInlines({ part });
			} else {
				label->setPlain(Q(block.alt.value_or(md::embedBaseName(block.name))));
			}
			return label;
		},
	});
	result->setBlocks(md::parseMarkdown(markdown, title));
	return result;
}

} // namespace Parvane::Knowledge
