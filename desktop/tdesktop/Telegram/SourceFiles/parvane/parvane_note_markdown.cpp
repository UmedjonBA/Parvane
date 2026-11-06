// Parvane fork: реализация parvane_note_markdown.h (доработка 6 ноя 2026: вложенные блоки, callouts, якоря, H4–H6,
// подсветка кода). Размеры — из web `Markdown.module.scss` (в комментариях — rem).
#include "parvane/parvane_note_markdown.h"

#include <parvane/sections/notes_view.h>

#include "ui/painter.h"
#include "ui/widgets/scroll_area.h"
#include "styles/style_basic.h"

#include <QtGui/QtEvents>

#include <map>

namespace Parvane::Knowledge {
namespace {

using Kit::Px;
using Kit::Rem;

// Якорь `#раздел`: заголовок ищется во всём тексте (от внешнего MarkdownView), прокручивается ближайшая область
void ScrollToAnchor(QWidget *from, const QString &id) {
	auto root = from;
	for (auto widget = from; widget; widget = widget->parentWidget()) {
		if (dynamic_cast<MarkdownView*>(widget)) {
			root = widget;
		}
	}
	QWidget *target = nullptr;
	for (const auto child : root->findChildren<QWidget*>()) {
		const auto anchor = child->property("pvAnchor").toString();
		if (!anchor.isEmpty() && (anchor == id || anchor == id.toLower())) {
			target = child;
			break;
		}
	}
	if (!target) {
		return;
	}
	for (auto widget = target->parentWidget(); widget; widget = widget->parentWidget()) {
		if (const auto scroll = dynamic_cast<Ui::ScrollArea*>(widget)) {
			if (const auto inner = scroll->widget()) {
				scroll->scrollToY(target->mapTo(inner, QPoint()).y());
			}
			return;
		}
	}
}

// Ссылки строки: [[заметка]] и `#раздел`
void Wire(not_null<RichText*> text, const MarkdownCallbacks &callbacks, QWidget *host) {
	text->setOpenNote(callbacks.openNote);
	text->setOpenAnchor([=](QString id) {
		ScrollToAnchor(host, id);
	});
}

// Callout `> [!NOTE]` / `> [!info]-`: тон по виду (как web CALLOUT_TONES)
[[nodiscard]] Tone CalloutTone(const std::string &kind) {
	static const auto kTones = std::map<std::string, Tone>{
		{ "note", Tone::Blue }, { "info", Tone::Blue }, { "todo", Tone::Blue },
		{ "abstract", Tone::Aqua }, { "summary", Tone::Aqua }, { "tldr", Tone::Aqua },
		{ "tip", Tone::Green }, { "hint", Tone::Green }, { "success", Tone::Green }, { "check", Tone::Green },
		{ "done", Tone::Green }, { "important", Tone::Purple }, { "example", Tone::Purple },
		{ "question", Tone::Yellow }, { "help", Tone::Yellow }, { "faq", Tone::Yellow },
		{ "warning", Tone::Orange }, { "attention", Tone::Orange },
		{ "caution", Tone::Red }, { "danger", Tone::Red }, { "error", Tone::Red }, { "failure", Tone::Red },
		{ "fail", Tone::Red }, { "missing", Tone::Red }, { "bug", Tone::Red },
		{ "quote", Tone::Muted }, { "cite", Tone::Muted },
	};
	const auto found = kTones.find(kind);
	return (found == kTones.end()) ? Tone::Accent : found->second;
}

[[nodiscard]] std::string CalloutTitle(const md::MdCallout &callout) {
	if (!callout.title.empty()) {
		return callout.title;
	}
	static const auto kNames = std::map<std::string, std::pair<const char*, const char*>>{
		{ "note", { "Note", "Примечание" } },
		{ "tip", { "Tip", "Совет" } },
		{ "important", { "Important", "Важно" } },
		{ "warning", { "Warning", "Предупреждение" } },
		{ "caution", { "Caution", "Осторожно" } },
	};
	const auto found = kNames.find(callout.kind);
	if (found != kNames.end()) {
		return IsRussian() ? found->second.second : found->second.first;
	}
	auto name = callout.kind;
	if (!name.empty() && name[0] >= 'a' && name[0] <= 'z') {
		name[0] = char(name[0] - 32);
	}
	return name;
}

// Цитата: черта 0.1875rem `--pv-accent` слева и отступ 0.75rem, текст `--pv-muted`, внутри — любые блоки.
// Callout: подложка и черта тоном вида, заголовок; сворачиваемый (`[!info]-`) — нажатием на заголовок
class QuoteBlock final : public Ui::RpWidget {
public:
	QuoteBlock(QWidget *parent, const md::MdBlock &block, const MarkdownCallbacks &callbacks)
	: RpWidget(parent)
	, _body(Ui::CreateChild<MarkdownView>(this, callbacks))
	, _tone(block.callout ? CalloutTone(block.callout->kind) : Tone::Accent)
	, _isCallout(block.callout.has_value()) {
		Kit::RepaintOnTones(this);
		if (block.callout) {
			_isFoldable = !block.callout->fold.empty();
			_isCollapsed = block.callout->fold == "closed";
			_title = Ui::CreateChild<RichText>(this, RichText::Style{ .semibold = true, .tone = _tone });
			_titleText = CalloutTitle(*block.callout);
			_noteExists = callbacks.noteExists;
			refreshTitle();
			Wire(_title, callbacks, this);
			if (_isFoldable) {
				_title->setCursor(style::cur_pointer);
			}
		}
		_body->setBlocks(block.children);
		_body->setVisible(!_isCollapsed);
		_body->heightValue() | rpl::skip(1) | rpl::on_next([=] {
			// Во время своей раскладки — не перекладывать заново по прежней ширине
			if (!_inLayout) {
				resizeToWidth(width());
			}
		}, _body->lifetime());
	}

protected:
	int resizeGetHeight(int newWidth) override {
		const auto guard = gsl::finally([&, was = _inLayout] { _inLayout = was; });
		_inLayout = true;
		const auto bar = Rem(0.1875);
		if (!_isCallout) {
			const auto left = bar + Rem(0.75);
			_body->resizeToWidth(std::max(newWidth - left, 1));
			_body->moveToLeft(left, 0, newWidth);
			return _body->height();
		}
		const auto padX = Rem(0.75);
		const auto padY = Rem(0.5);
		const auto inner = std::max(newWidth - bar - 2 * padX, 1);
		_title->resizeToWidth(inner);
		_title->moveToLeft(bar + padX, padY, newWidth);
		auto y = padY + _title->height();
		if (!_isCollapsed && !_body->isHidden()) {
			_body->resizeToWidth(inner);
			_body->moveToLeft(bar + padX, y + Rem(0.375), newWidth);
			y += Rem(0.375) + _body->height();
		}
		return y + padY;
	}
	void paintEvent(QPaintEvent *e) override {
		auto p = QPainter(this);
		const auto color = ToneColor(_tone);
		if (_isCallout) {
			PainterHighQualityEnabler hq(p);
			auto fill = color;
			fill.setAlphaF(0.1);
			p.setPen(Qt::NoPen);
			p.setBrush(fill);
			p.drawRoundedRect(rect(), Rem(0.375), Rem(0.375));
		}
		p.fillRect(0, 0, Rem(0.1875), height(), color);
	}
	void mousePressEvent(QMouseEvent *e) override {
		if (_isFoldable && _title && _title->geometry().contains(e->pos())) {
			_isCollapsed = !_isCollapsed;
			_body->setVisible(!_isCollapsed);
			refreshTitle();
			resizeToWidth(width());
			return;
		}
		RpWidget::mousePressEvent(e);
	}

private:
	void refreshTitle() {
		const auto chevron = !_isFoldable ? std::string() : _isCollapsed ? "▸ " : "▾ ";
		_title->setMarkdown(chevron + _titleText, _noteExists);
	}

	const not_null<MarkdownView*> _body;
	const Tone _tone = Tone::Accent;
	const bool _isCallout = false;
	bool _isFoldable = false;
	bool _isCollapsed = false;
	bool _inLayout = false;
	RichText *_title = nullptr;
	std::string _titleText;
	Fn<bool(const std::string&)> _noteExists;

};

// Код: подложка `--pv-raised`, скругление 0.5rem, поля 0.5rem 0.75rem, моноширинный 0.8125rem
class PreBlock final : public Ui::RpWidget {
public:
	PreBlock(QWidget *parent, const std::string &text, const std::string &language)
	: RpWidget(parent)
	, _text(Ui::CreateChild<RichText>(this, RichText::Style{ .px = 13, .mono = true }))
	, _language(Q(language)) {
		Kit::RepaintOnTones(this);
		_text->setCode(Q(text), _language);
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
		if (!_language.isEmpty()) {
			// Язык — подписью в правом верхнем углу (`.codeLang`)
			const auto font = Kit::Font(11, false, true);
			p.setFont(font->f);
			p.setPen(ToneColor(Tone::Faint));
			p.drawText(
				QRect(0, Rem(0.25), width() - Rem(0.5), font->height),
				Qt::AlignRight | Qt::AlignTop,
				_language);
		}
	}

private:
	const not_null<RichText*> _text;
	const QString _language;

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
		const MarkdownCallbacks &callbacks)
	: RpWidget(parent)
	, _depth(item.depth)
	, _task(item.isChecked.has_value()) {
		Kit::RepaintOnTones(this);
		setProperty("pvLine", item.line);
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
		Wire(_text, callbacks, this);
		if (!item.blocks.empty()) {
			// Блоки внутри пункта (второй абзац, код, цитата) — под текстом пункта
			_children = Ui::CreateChild<MarkdownView>(this, callbacks);
			_children->setBlocks(item.blocks);
			_children->heightValue() | rpl::skip(1) | rpl::on_next([=] {
				if (!_inLayout) {
					resizeToWidth(width());
				}
			}, _children->lifetime());
		}
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
			_marker = item.number ? (QString::number(*item.number) + '.') : QString::fromUtf8("•");
		}
	}

protected:
	int resizeGetHeight(int newWidth) override {
		const auto guard = gsl::finally([&, was = _inLayout] { _inLayout = was; });
		_inLayout = true;
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
		height = std::max(height, _check ? _check->height() : 0);
		if (_children) {
			height += Rem(0.375);
			_children->resizeToWidth(available);
			_children->moveToLeft(x, height, newWidth);
			height += _children->height();
		}
		return height;
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
	MarkdownView *_children = nullptr;
	bool _inLayout = false;
	QString _marker;

};

// Список: пункты с промежутком 0.25rem
class ListBlock final : public Ui::RpWidget {
public:
	ListBlock(QWidget *parent, const md::MdBlock &block, const MarkdownCallbacks &callbacks)
	: RpWidget(parent) {
		for (const auto &item : block.items) {
			_rows.push_back(Ui::CreateChild<ItemRow>(this, item, callbacks));
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
				Wire(cell, callbacks, this);
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
		// `.heading1` 1.125rem `--pv-accent`, `.heading2` 1rem и `.heading3` 0.9375rem `--pv-orange`,
		// `.heading4/5` 0.875rem `--pv-yellow`, `.heading6` — `--pv-muted`
		const auto level = block.level;
		const auto px = (level <= 1) ? 18 : (level == 2) ? 16 : (level == 3) ? 15 : 14;
		marginTop = (level <= 1) ? Rem(0.625) : (level == 2) ? Rem(0.5) : (level == 3) ? Rem(0.375) : Rem(0.25);
		auto result = object_ptr<RichText>(this, RichText::Style{
			.px = px,
			.semibold = true,
			.tone = (level <= 1) ? Tone::Accent
				: (level <= 3) ? Tone::Orange
				: (level <= 5) ? Tone::Yellow
				: Tone::Muted,
			.lineHeight = 1.5,
		});
		result->setMarkdown(block.text, _callbacks.noteExists);
		Wire(result.data(), _callbacks, this);
		result->setProperty("pvAnchor", Q(block.id));
		return result;
	}
	case md::MdBlockType::Paragraph: {
		auto result = object_ptr<RichText>(this, RichText::Style());
		result->setMarkdown(block.text, _callbacks.noteExists);
		Wire(result.data(), _callbacks, this);
		return result;
	}
	case md::MdBlockType::Quote:
		return object_ptr<QuoteBlock>(this, block, _callbacks);
	case md::MdBlockType::Code:
		return object_ptr<PreBlock>(this, block.text, block.lang);
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
		// Номер строки текста — опора синхронной прокрутки правки и просмотра
		raw->setProperty("pvLine", block.line);
		raw->show();
		raw->heightValue() | rpl::skip(1) | rpl::on_next([=] {
			if (!_inLayout) {
				resizeToWidth(width());
			}
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
	const auto guard = gsl::finally([&, was = _inLayout] { _inLayout = was; });
	_inLayout = true;
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
		Fn<void(QString target)> openNote,
		Fn<object_ptr<Ui::RpWidget>(QWidget *parent, const md::MdBlock &block)> embed) {
	auto result = object_ptr<MarkdownView>(parent, MarkdownCallbacks{
		.openNote = std::move(openNote),
		.taskTail = [](const std::string &text) {
			return std::make_pair(notes::splitTaskMarker(text).text, QString());
		},
		.embed = embed ? std::move(embed) : [](QWidget *parent, const md::MdBlock &block) -> object_ptr<Ui::RpWidget> {
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
