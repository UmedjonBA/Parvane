// Parvane fork: реализация parvane_notes_graph_panel.h. Размеры — web `Knowledge.module.scss` (`.graphPanel*`,
// `.graphInfo*`).
#include "parvane/parvane_notes_graph_panel.h"

#include "lang/lang_keys.h"
#include "ui/painter.h"
#include "ui/widgets/scroll_area.h"

#include <crl/crl_on_main.h>

#include <QtGui/QFontMetricsF>
#include <QtGui/QtEvents>

namespace Parvane::Knowledge {
namespace {

using Kit::Rem;

// Тело панели: поля 1.25rem 1.375rem 1.5rem вокруг одного виджета
class Padded final : public Ui::RpWidget {
public:
	using RpWidget::RpWidget;

	void setChild(Ui::RpWidget *child) {
		_child = child;
		if (_child) {
			_child->heightValue() | rpl::skip(1) | rpl::on_next([=] {
				resizeToWidth(width());
			}, _child->lifetime());
		}
		resizeToWidth(width());
	}

protected:
	int resizeGetHeight(int newWidth) override {
		if (!_child) {
			return 0;
		}
		const auto padX = Rem(1.375);
		_child->resizeToWidth(std::max(newWidth - 2 * padX, 1));
		_child->moveToLeft(padX, Rem(1.25), newWidth);
		return Rem(1.25) + _child->height() + Rem(1.5);
	}

private:
	Ui::RpWidget *_child = nullptr;

};

// Карточка точки без заметки (`.graphInfo`): вид моноширинными заглавными цветом точки, название, строка, кнопка
class InfoCard final : public Ui::RpWidget {
public:
	InfoCard(
		QWidget *parent,
		const QString &kind,
		Tone tone,
		const QString &title,
		const QString &line,
		bool lineIcon,
		const QString &button,
		const QString &buttonIcon,
		Fn<void()> pressed)
	: RpWidget(parent)
	, _kind(kind)
	, _tone(tone)
	, _lineIcon(lineIcon) {
		Kit::RepaintOnTones(this);
		_title = Ui::CreateChild<Kit::Label>(this, title, Kit::Label::Style{
			.px = 22,
			.semibold = true,
			.multiline = true,
		});
		_line = Ui::CreateChild<Kit::Label>(this, line, Kit::Label::Style{ .tone = Tone::Muted, .multiline = true });
		_button = Ui::CreateChild<NotesTextButton>(this, button, buttonIcon, NotesTextButton::Kind::Accent);
		_button->setClickedCallback(std::move(pressed));
	}

protected:
	int resizeGetHeight(int newWidth) override {
		const auto gap = Rem(0.625);
		auto y = capsHeight() + gap;
		_title->resizeToWidth(newWidth);
		_title->moveToLeft(0, y, newWidth);
		y += _title->height() + gap;
		const auto icon = _lineIcon ? (Rem(1.125) + Rem(0.375)) : 0;
		_line->resizeToWidth(std::max(newWidth - icon, 1));
		_line->moveToLeft(icon, y, newWidth);
		_lineTop = y;
		y += _line->height() + Rem(0.375) + gap;
		_button->moveToLeft(0, y, newWidth);
		return y + _button->height();
	}
	void paintEvent(QPaintEvent *e) override {
		auto p = QPainter(this);
		PainterHighQualityEnabler hq(p);
		auto font = Kit::Font(12, true, true)->f;
		font.setCapitalization(QFont::AllUppercase);
		font.setLetterSpacing(QFont::AbsoluteSpacing, Kit::Px(12) * 0.06);
		p.setFont(font);
		p.setPen(ToneColor(_tone));
		p.drawText(QRectF(0, 0, width(), capsHeight()), Qt::AlignLeft | Qt::AlignVCenter, _kind);
		if (_lineIcon) {
			const auto icon = Rem(1.125);
			const auto line = Kit::Font(Kit::kBodyPx)->height;
			PaintNotesIcon(p, u"cal"_q, ToneColor(Tone::Muted), 0, _lineTop + (line - icon) / 2, icon);
		}
	}

private:
	[[nodiscard]] static int capsHeight() {
		return Kit::Font(12, true, true)->height;
	}

	QString _kind;
	Tone _tone = Tone::Muted;
	bool _lineIcon = false;
	int _lineTop = 0;
	Kit::Label *_title = nullptr;
	Kit::Label *_line = nullptr;
	NotesTextButton *_button = nullptr;

};

} // namespace

GraphPanel::GraphPanel(QWidget *parent, GraphPanelCallbacks callbacks)
: Island(parent)
, _callbacks(std::move(callbacks)) {
	_scroll = Ui::CreateChild<Ui::ScrollArea>(this);
	_inner = _scroll->setOwnedWidget(object_ptr<Padded>(_scroll)).data();
	_scroll->widthValue() | rpl::on_next([=](int width) {
		_inner->resizeToWidth(width);
	}, lifetime());
}

void GraphPanel::setLinkStartEnabled(bool enabled) {
	if (_linkStartEnabled != enabled) {
		_linkStartEnabled = enabled;
		_headerKey.clear();
		if (_state) {
			rebuildHeader();
			relayout();
		}
	}
}

void GraphPanel::setState(GraphPanelState state) {
	_state = std::move(state);
	rebuildHeader();
	rebuildBody();
	relayout();
}

void GraphPanel::requestEdit(const std::string &noteId, size_t from, size_t to) {
	if (_note && _note->noteId() == noteId) {
		_note->requestEdit(from, to);
	}
}

void GraphPanel::rebuildHeader() {
	const auto &state = *_state;
	const auto note = state.note.note;
	const auto title = note
		? DisplayTitle(note->title, note->isDaily)
		: state.record
		? Q(state.record->name)
		: Q(state.pick.title);
	// Связь ведут от обычной заметки: заметки дней в правке связей не участвуют
	const auto isLinkable = note && !note->isDaily && _linkStartEnabled && _callbacks.linkStart;
	const auto key = S(title) + '\x1f' + (note ? note->id : std::string()) + (isLinkable ? "L" : "-");
	if (key == _headerKey && _header) {
		return;
	}
	_headerKey = key;
	const auto header = Ui::CreateChild<Kit::Header>(this, title, Kit::Header::TitleSize::Small);
	header->addStretch();
	const auto later = [=](Fn<void()> callback) {
		return [=] {
			crl::on_main(this, callback);
		};
	};
	if (note) {
		const auto id = note->id;
		if (isLinkable) {
			const auto connect = header->add(object_ptr<NotesTextButton>(
				header,
				tr::lng_parvane_notes_graph_connect(tr::now),
				u"link"_q,
				NotesTextButton::Kind::Btn));
			connect->setToolTip(tr::lng_parvane_notes_graph_connect_title(tr::now));
			const auto start = _callbacks.linkStart;
			connect->setClickedCallback(later([=] { start(id); }));
		}
		const auto open = header->add(object_ptr<NotesIconButton>(
			header,
			u"open"_q,
			tr::lng_parvane_notes_graph_open_in_notes(tr::now)));
		open->setToolTip(tr::lng_parvane_notes_graph_open_in_notes(tr::now));
		const auto openInNotes = _callbacks.openInNotes;
		open->setClickedCallback(later([=] { openInNotes(id); }));
	}
	const auto close = header->add(object_ptr<NotesIconButton>(
		header,
		u"x"_q,
		tr::lng_parvane_notes_close(tr::now)));
	close->setToolTip(tr::lng_parvane_notes_close(tr::now));
	close->setClickedCallback(later(_callbacks.close));
	header->show();
	_header.reset(header);
}

void GraphPanel::rebuildBody() {
	const auto &state = *_state;
	const auto padded = static_cast<Padded*>(_inner);
	if (const auto note = state.note.note) {
		_info = nullptr;
		if (!_note || _note->noteId() != note->id) {
			delete _note;
			_note = Ui::CreateChild<NoteView>(_inner, NoteOptions{
				.hasLinks = true,
				.isGraphHidden = true,
			}, NoteCallbacks{
				.openTitle = _callbacks.openTitle,
				.deleted = _callbacks.deleted,
				.pickFolder = _callbacks.pickFolder,
			});
			_note->show();
			padded->setChild(_note);
		}
		_note->setData(state.note);
		_bodyKey = note->id;
		return;
	}
	if (_note) {
		padded->setChild(nullptr);
		delete _note;
		_note = nullptr;
	}
	auto key = std::string();
	auto card = (InfoCard*)nullptr;
	if (const auto &record = state.record) {
		auto when = QString();
		if (record->day) {
			when = FormatDayShort(*record->day);
			if (record->time) {
				when += u", "_q + Q(*record->time);
			}
		} else if (record->due) {
			when = FormatDue(*record->due);
		} else {
			when = tr::lng_parvane_notes_no_date(tr::now);
		}
		if (record->repeat) {
			when += u" · "_q + FormatRepeat(*record->repeat);
		}
		if (record->isDone.value_or(false)) {
			when += u" · "_q + tr::lng_parvane_notes_status_done(tr::now);
		}
		key = "r" + record->key + S(when) + record->name;
		if (key == _bodyKey && _info) {
			return;
		}
		const auto item = *record;
		const auto openInPlan = _callbacks.openInPlan;
		card = Ui::CreateChild<InfoCard>(
			_inner,
			(record->kind == "task")
				? tr::lng_parvane_notes_graph_kind_task(tr::now)
				: tr::lng_parvane_notes_graph_kind_event(tr::now),
			KindTone(record->kind),
			Q(record->name),
			when,
			true,
			tr::lng_parvane_notes_graph_open_in_plan(tr::now),
			u"open"_q,
			[=] { crl::on_main(this, [=] { openInPlan(item); }); });
	} else {
		key = "m" + state.pick.title;
		if (key == _bodyKey && _info) {
			return;
		}
		const auto title = state.pick.title;
		const auto create = _callbacks.create;
		card = Ui::CreateChild<InfoCard>(
			_inner,
			tr::lng_parvane_notes_graph_kind_missing(tr::now),
			Tone::Faint,
			Q(title),
			tr::lng_parvane_notes_graph_missing_text(tr::now),
			false,
			tr::lng_parvane_notes_graph_create(tr::now),
			u"plus"_q,
			[=] { crl::on_main(this, [=] { create(title); }); });
	}
	_bodyKey = key;
	card->show();
	padded->setChild(card);
	_info.reset(card);
}

void GraphPanel::relayout() {
	const auto inner = innerRect();
	auto y = inner.y();
	if (_header) {
		_header->resizeToWidth(inner.width());
		_header->moveToLeft(inner.x(), y, width());
		y += _header->height();
	}
	const auto bottom = inner.y() + inner.height() - Rem(0.5);
	_scroll->setGeometry(inner.x(), y, inner.width(), std::max(bottom - y, 0));
	_inner->resizeToWidth(_scroll->width());
}

void GraphPanel::resizeEvent(QResizeEvent *e) {
	relayout();
}

} // namespace Parvane::Knowledge
