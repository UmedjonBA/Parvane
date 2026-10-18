// Parvane fork: реализация parvane_planner_header.h. Размеры — из web Planner.module.scss (`.hdr`, `.calendarHdr`,
// `.periodTitle`, `.periodPicker*`, `.seg*`, `.chip*`), в комментариях — rem.
#include "parvane/parvane_planner_header.h"

#include "lang/lang_keys.h"
#include "ui/painter.h"

#include <QtGui/QtEvents>

namespace Parvane::PlannerViews {
namespace {

// Выбор месяца и года (`.periodPicker`): окно под заголовком, закрывается нажатием мимо него
class PeriodPicker final : public Ui::RpWidget {
public:
	PeriodPicker(QWidget *parent, QPoint anchor, std::string picked, Fn<void(std::string)> pick)
	: RpWidget(parent)
	, _anchor(anchor)
	, _picked(std::move(picked))
	, _year(DateOf(_picked).year())
	, _pick(std::move(pick)) {
		setAttribute(Qt::WA_DeleteOnClose);
		setGeometry(QRect(QPoint(), parent->size()));
		setMouseTracking(true);
		Kit::RepaintOnTones(this);
		show();
		raise();
		setFocus();
	}

protected:
	void paintEvent(QPaintEvent *e) override;
	void mouseMoveEvent(QMouseEvent *e) override {
		_mouse = e->pos();
		update();
	}
	void mousePressEvent(QMouseEvent *e) override;
	void keyPressEvent(QKeyEvent *e) override {
		if (e->key() == Qt::Key_Escape) {
			close();
		}
	}

private:
	[[nodiscard]] QRect panel() const {
		const auto width = Kit::Rem(16);
		const auto height = Kit::Rem(0.75) * 2 + Kit::Rem(2.25) + Kit::Rem(0.5) + 3 * monthHeight() + 2 * Kit::Rem(0.25);
		return QRect(_anchor.x(), _anchor.y() + Kit::Rem(0.25), width, height);
	}
	[[nodiscard]] int monthHeight() const {
		return Kit::Font(14)->height + Kit::Rem(0.375) * 2;
	}
	[[nodiscard]] QRect prevRect() const {
		const auto p = panel();
		return QRect(p.x() + Kit::Rem(0.75), p.y() + Kit::Rem(0.75), Kit::Rem(2.25), Kit::Rem(2.25));
	}
	[[nodiscard]] QRect nextRect() const {
		const auto p = panel();
		return QRect(p.right() + 1 - Kit::Rem(0.75) - Kit::Rem(2.25), p.y() + Kit::Rem(0.75), Kit::Rem(2.25),
			Kit::Rem(2.25));
	}
	[[nodiscard]] QRect monthRect(int index) const {
		const auto p = panel().marginsRemoved({ Kit::Rem(0.75), Kit::Rem(0.75), Kit::Rem(0.75), Kit::Rem(0.75) });
		const auto gap = Kit::Rem(0.25);
		const auto width = (p.width() - 3 * gap) / 4;
		const auto top = p.y() + Kit::Rem(2.25) + Kit::Rem(0.5);
		return QRect(p.x() + (index % 4) * (width + gap), top + (index / 4) * (monthHeight() + gap), width, monthHeight());
	}

	const QPoint _anchor;
	const std::string _picked;
	int _year = 0;
	const Fn<void(std::string)> _pick;
	std::optional<QPoint> _mouse;

};

void PeriodPicker::paintEvent(QPaintEvent *e) {
	auto p = QPainter(this);
	PainterHighQualityEnabler hq(p);
	const auto rect = panel();
	// Тень `0 0.5rem 1.5rem rgb(0 0 0 / 30%)`
	for (auto i = 6; i > 0; --i) {
		p.setPen(Qt::NoPen);
		p.setBrush(QColor(0, 0, 0, 10));
		p.drawRoundedRect(QRectF(rect).adjusted(-i, -i + 4, i, i + 4), Kit::Rem(0.75) + i, Kit::Rem(0.75) + i);
	}
	p.setPen(QPen(ToneColor(Tone::Line2), 1));
	p.setBrush(ToneColor(Tone::Panel));
	p.drawRoundedRect(QRectF(rect).adjusted(0.5, 0.5, -0.5, -0.5), Kit::Rem(0.75), Kit::Rem(0.75));
	const auto drawIb = [&](QRect r, const QString &icon) {
		const auto hovered = _mouse && r.contains(*_mouse);
		if (hovered) {
			p.setPen(Qt::NoPen);
			p.setBrush(ToneColor(Tone::Hover));
			p.drawEllipse(r);
		}
		const auto size = Kit::Px(22);
		PaintPlannerIcon(p, icon, hovered ? ToneColor(Tone::Fg) : ToneColor(Tone::Muted), r.x() + (r.width() - size) / 2,
			r.y() + (r.height() - size) / 2, size);
	};
	drawIb(prevRect(), u"previous"_q);
	drawIb(nextRect(), u"next"_q);
	const auto yearFont = Kit::Font(Kit::kBodyPx, true, true);
	const auto year = QString::number(_year);
	const auto yr = prevRect();
	p.setFont(yearFont);
	p.setPen(ToneColor(Tone::Fg));
	p.drawText(rect.x() + (rect.width() - yearFont->width(year)) / 2, yr.y() + (yr.height() - yearFont->height) / 2
		+ yearFont->ascent, year);
	const auto picked = DateOf(_picked);
	const auto font = Kit::Font(14);
	for (auto i = 0; i != 12; ++i) {
		const auto r = monthRect(i);
		const auto active = (_year == picked.year() && i + 1 == picked.month());
		const auto hovered = _mouse && r.contains(*_mouse);
		if (active || hovered) {
			p.setPen(Qt::NoPen);
			p.setBrush(active ? ToneColor(Tone::Accent) : ToneColor(Tone::Hover));
			p.drawRoundedRect(r, Kit::Rem(0.5), Kit::Rem(0.5));
		}
		const auto label = FormatMonthShort(i + 1);
		p.setFont(font);
		p.setPen(active ? ToneColor(Tone::AccentInk) : ToneColor(Tone::Fg));
		p.drawText(r.x() + (r.width() - font->width(label)) / 2, r.y() + (r.height() - font->height) / 2 + font->ascent,
			label);
	}
}

void PeriodPicker::mousePressEvent(QMouseEvent *e) {
	const auto point = e->pos();
	if (!panel().contains(point)) {
		close();
		return;
	}
	if (prevRect().contains(point)) {
		--_year;
		update();
		return;
	} else if (nextRect().contains(point)) {
		++_year;
		update();
		return;
	}
	for (auto i = 0; i != 12; ++i) {
		if (monthRect(i).contains(point)) {
			// День месяца сохраняется, если он есть в выбранном месяце
			const auto picked = DateOf(_picked);
			const auto anchor = QDate(_year, i + 1, 1);
			const auto shifted = planner::shiftPeriod("month", _picked,
				(_year - picked.year()) * 12 + (i + 1) - picked.month());
			const auto day = (shifted.substr(0, 7) == DayKey(anchor).substr(0, 7)) ? shifted : DayKey(anchor);
			const auto pick = _pick;
			close();
			pick(day);
			return;
		}
	}
}

} // namespace

// Заголовок-кнопка периода (`.periodTitle`): 1.25rem, наведение — `--pv-hover`
class PeriodBar::TitleButton final : public Kit::Button {
public:
	TitleButton(QWidget *parent)
	: Button(parent) {
		Kit::RepaintOnTones(this);
	}

	void setText(const QString &text) {
		_text = text;
		const auto font = Kit::Font(20, true);
		resize(font->width(_text) + 2 * Kit::Rem(0.375), Kit::Px(24) + 2 * Kit::Rem(0.25));
		update();
	}

protected:
	void paintEvent(QPaintEvent *e) override {
		auto p = QPainter(this);
		PainterHighQualityEnabler hq(p);
		if (isOver() || isDown()) {
			p.setPen(Qt::NoPen);
			p.setBrush(ToneColor(Tone::Hover));
			p.drawRoundedRect(rect(), Kit::Rem(0.5), Kit::Rem(0.5));
		}
		const auto font = Kit::Font(20, true);
		DrawElided(&p, font, ToneColor(Tone::Fg), Kit::Rem(0.375), (height() - font->height) / 2 + font->ascent, _text,
			width() - 2 * Kit::Rem(0.375));
		if (focusVisible()) {
			paintFocusRing(p, QRectF(rect()), Kit::Rem(0.5));
		}
	}

private:
	QString _text;

};

PeriodBar::PeriodBar(QWidget *parent, Callbacks callbacks)
: RpWidget(parent)
, _callbacks(std::move(callbacks)) {
	Kit::RepaintOnTones(this);
	_title = Ui::CreateChild<TitleButton>(this);
	_title->setAccessibleName(tr::lng_parvane_planner_pick_period(tr::now));
	_title->setClickedCallback([=] { openPicker(); });
	_prev = Ui::CreateChild<IconBtn>(this, u"previous"_q, tr::lng_parvane_planner_prev_period(tr::now));
	_next = Ui::CreateChild<IconBtn>(this, u"next"_q, tr::lng_parvane_planner_next_period(tr::now));
	_prev->setClickedCallback([=] { _callbacks.prev(); });
	_next->setClickedCallback([=] { _callbacks.next(); });
	_jump = Ui::CreateChild<Kit::Pill>(this, tr::lng_parvane_planner_jump_today(tr::now));
	_jump->setClickedCallback([=] { _callbacks.today(); });

	const auto layers = std::vector<std::pair<QString, std::pair<QString, Tone>>>{
		{ u"sleep"_q, { tr::lng_parvane_planner_health_sleep(tr::now), Tone::Aqua } },
		{ u"food"_q, { tr::lng_parvane_planner_health_food(tr::now), Tone::Orange } },
		{ u"work"_q, { tr::lng_parvane_planner_layer_work(tr::now), Tone::Blue } },
	};
	for (const auto &[key, look] : layers) {
		const auto chip = Ui::CreateChild<Kit::Chip>(this, Kit::Chip::Descriptor{
			.text = look.first,
			.tone = look.second,
			.dot = true,
		});
		chip->setClickedCallback([=, key = key] { _callbacks.toggleLayer(key); });
		_layers.push_back(chip);
	}

	_segmentValues = { u"today"_q, u"week"_q, u"month"_q, u"year"_q, u"agenda"_q };
	_segments = Ui::CreateChild<Kit::Segments>(this, std::vector<QString>{
		tr::lng_parvane_planner_today(tr::now),
		tr::lng_parvane_planner_cal_week(tr::now),
		tr::lng_parvane_planner_cal_month(tr::now),
		tr::lng_parvane_planner_cal_year(tr::now),
		tr::lng_parvane_planner_cal_agenda(tr::now),
	}, 2);
	_segments->activated() | rpl::on_next([=](int index) {
		if (index >= 0 && index < int(_segmentValues.size())) {
			_callbacks.segment(_segmentValues[index]);
		}
	}, lifetime());
	_settings = Ui::CreateChild<IconBtn>(this, u"settings"_q, tr::lng_parvane_planner_settings(tr::now));
	_settings->setClickedCallback([=] { _callbacks.settings(); });
	_add = Ui::CreateChild<IconBtn>(this, u"add"_q, tr::lng_parvane_planner_add_entry(tr::now), true);
	_add->setClickedCallback([=] { _callbacks.add(); });
}

void PeriodBar::setState(State state) {
	_state = std::move(state);
	_title->setText(_state.title);
	_prev->setAccessibleName(_state.prevLabel);
	_next->setAccessibleName(_state.nextLabel);
	const auto on = std::array{ _state.layers.sleep, _state.layers.food, _state.layers.work };
	for (auto i = 0; i != int(_layers.size()); ++i) {
		_layers[i]->setOn(on[i]);
	}
	const auto i = std::find(_segmentValues.begin(), _segmentValues.end(), _state.segment);
	if (i != _segmentValues.end()) {
		_segments->setActive(int(i - _segmentValues.begin()));
	}
	resizeToWidth(width());
	update();
}

void PeriodBar::openPicker() {
	const auto host = window();
	if (!host) {
		return;
	}
	const auto anchor = host->mapFromGlobal(_title->mapToGlobal(QPoint(0, _title->height())));
	const auto pick = _callbacks.pickDay;
	Ui::CreateChild<PeriodPicker>(host, anchor, _state.picked, [=](std::string day) {
		pick(day);
	});
}

void PeriodBar::relayout(int width) {
	// `.hdr`: поля 0.75rem 1.125rem, промежуток 0.5rem (`.calendarHdr`); на узком месте — перенос строк
	const auto padX = Kit::Rem(1.125);
	const auto padY = Kit::Rem(0.75);
	const auto gap = Kit::Rem(0.5);
	const auto rowHeight = Kit::Rem(2.25);
	auto x = padX;
	auto y = padY;
	const auto place = [&](Ui::RpWidget *widget, bool shown) {
		widget->setVisible(shown);
	};
	const auto isToday = _state.isToday;
	place(_title, !isToday);
	place(_prev, !isToday);
	place(_next, !isToday);
	place(_jump, !isToday);
	for (const auto chip : _layers) {
		place(chip, !isToday);
	}

	// Правая группа: слои, переключатель, настройки, «+»
	auto rightItems = std::vector<Ui::RpWidget*>();
	if (!isToday) {
		for (const auto chip : _layers) {
			rightItems.push_back(chip);
		}
	}
	rightItems.push_back(_segments);
	rightItems.push_back(_settings);
	rightItems.push_back(_add);
	auto rightWidth = 0;
	for (const auto item : rightItems) {
		rightWidth += item->width() + (rightWidth ? gap : 0);
	}

	auto leftWidth = 0;
	if (!isToday) {
		leftWidth = _title->width() + Kit::Rem(0.375) + _prev->width() + gap + _next->width() + gap + _jump->width();
	} else {
		leftWidth = Kit::Font(20, true)->width(tr::lng_parvane_planner_today(tr::now));
	}
	const auto oneRow = (padX + leftWidth + gap + rightWidth + padX <= width);
	if (!isToday) {
		_title->move(x, y + (rowHeight - _title->height()) / 2);
		x += _title->width() + Kit::Rem(0.375);
		_prev->move(x, y);
		x += _prev->width() + gap;
		_next->move(x, y);
		x += _next->width() + gap;
		_jump->move(x, y + (rowHeight - _jump->height()) / 2);
	}
	auto rightY = y;
	if (!oneRow) {
		rightY = y + rowHeight + Kit::Rem(0.625);
	}
	auto rx = width - padX - rightWidth;
	if (!oneRow) {
		rx = std::max(padX, width - padX - rightWidth);
	}
	for (const auto item : rightItems) {
		item->move(rx, rightY + (rowHeight - item->height()) / 2);
		rx += item->width() + gap;
	}
}

int PeriodBar::resizeGetHeight(int newWidth) {
	relayout(newWidth);
	const auto padY = Kit::Rem(0.75);
	auto bottom = 0;
	for (const auto child : { (Ui::RpWidget*)_segments, (Ui::RpWidget*)_add }) {
		bottom = std::max(bottom, child->y() + child->height());
	}
	return std::max(Kit::Rem(3.75), bottom + padY);
}

void PeriodBar::paintEvent(QPaintEvent *e) {
	auto p = QPainter(this);
	if (_state.isToday) {
		const auto font = Kit::Font(20, true);
		const auto rowHeight = Kit::Rem(2.25);
		DrawElided(&p, font, ToneColor(Tone::Fg), Kit::Rem(1.125), Kit::Rem(0.75) + (rowHeight - font->height) / 2
			+ font->ascent, tr::lng_parvane_planner_today(tr::now), _segments->x() - Kit::Rem(1.5));
	}
	p.fillRect(QRect(0, height() - 1, width(), 1), ToneColor(Tone::Line));
}

} // namespace Parvane::PlannerViews
