// Parvane fork: реализация parvane_note_links.h. Размеры — web `Knowledge.module.scss` (`.links`, `.miniGraph`).
#include "parvane/parvane_note_links.h"

#include "lang/lang_keys.h"
#include "ui/painter.h"

#include <parvane/sections/notes_view.h>

#include <QtGui/QtEvents>

#include <set>

namespace Parvane::Knowledge {
namespace {

using Kit::Px;
using Kit::Rem;

struct MiniPoint {
	std::string key;
	QString label;
	Tone tone = Tone::Yellow;
	std::optional<QString> title; // заметку можно открыть; запись «Плана» только показана
	QPointF at;
};

// Малый граф (`.miniGraph`): поле 320×240, растянутое по ширине (не шире 26rem)
class MiniGraph final : public Ui::RpWidget {
public:
	MiniGraph(QWidget *parent, std::vector<MiniPoint> points, Fn<void(QString)> open)
	: RpWidget(parent)
	, _points(std::move(points))
	, _open(std::move(open)) {
		Kit::RepaintOnTones(this);
		setMouseTracking(true);
	}

protected:
	int resizeGetHeight(int newWidth) override {
		const auto w = std::min(newWidth, Rem(26));
		return int(std::round(w * notes::kMiniGraphHeight / notes::kMiniGraphWidth));
	}

	void paintEvent(QPaintEvent *e) override {
		auto p = QPainter(this);
		PainterHighQualityEnabler hq(p);
		const auto k = scale();
		const auto center = QPointF(notes::kMiniGraphWidth / 2, notes::kMiniGraphHeight / 2) * k;
		auto pen = QPen(ToneColor(Tone::Line2));
		pen.setWidthF(k);
		p.setPen(pen);
		for (const auto &point : _points) {
			p.drawLine(center, point.at * k);
		}
		p.setPen(Qt::NoPen);
		p.setBrush(ToneColor(Tone::Accent));
		p.drawEllipse(center, 9 * k, 9 * k);
		const auto font = Kit::Font(11);
		p.setFont(font->f);
		for (auto i = 0; i != int(_points.size()); ++i) {
			const auto &point = _points[i];
			const auto at = point.at * k;
			p.setPen(Qt::NoPen);
			p.setBrush(ToneColor(point.tone));
			p.drawEllipse(at, 6 * k, 6 * k);
			const auto below = point.at.y() > notes::kMiniGraphHeight / 2;
			const auto y = (point.at.y() + (below ? 18 : -10)) * k;
			const auto text = Q(notes::shortenLabel(S(point.label), notes::kMiniGraphLabelMax));
			const auto w = font->width(text);
			p.setPen(ToneColor((i == _over) ? Tone::Accent : Tone::Fg));
			p.drawText(QPointF(at.x() - w / 2., y), text);
		}
	}

	void mouseMoveEvent(QMouseEvent *e) override {
		const auto over = pointAt(e->pos());
		if (_over != over) {
			_over = over;
			setCursor((over >= 0) ? style::cur_pointer : style::cur_default);
			update();
		}
	}

	void leaveEventHook(QEvent *e) override {
		if (_over >= 0) {
			_over = -1;
			update();
		}
	}

	void mouseReleaseEvent(QMouseEvent *e) override {
		const auto index = pointAt(e->pos());
		if (index >= 0 && e->button() == Qt::LeftButton && _open) {
			_open(*_points[index].title);
		}
	}

private:
	[[nodiscard]] double scale() const {
		return std::min(width(), Rem(26)) / notes::kMiniGraphWidth;
	}

	// Точка-заметка под указателем: кружок и подпись
	[[nodiscard]] int pointAt(QPoint position) const {
		const auto k = scale();
		const auto font = Kit::Font(11);
		for (auto i = 0; i != int(_points.size()); ++i) {
			const auto &point = _points[i];
			if (!point.title) {
				continue;
			}
			const auto at = point.at * k;
			const auto d = QPointF(position) - at;
			if (std::hypot(d.x(), d.y()) <= 8 * k) {
				return i;
			}
			const auto below = point.at.y() > notes::kMiniGraphHeight / 2;
			const auto y = (point.at.y() + (below ? 18 : -10)) * k;
			const auto text = Q(notes::shortenLabel(S(point.label), notes::kMiniGraphLabelMax));
			const auto w = font->width(text);
			const auto box = QRectF(at.x() - w / 2., y - font->ascent, w, font->height);
			if (box.contains(position)) {
				return i;
			}
		}
		return -1;
	}

	std::vector<MiniPoint> _points;
	Fn<void(QString)> _open;
	int _over = -1;

};

} // namespace

NoteLinks::NoteLinks(QWidget *parent, Args args)
: RpWidget(parent) {
	const auto &index = *args.index;
	const auto backlinks = index.backlinks(args.note->id);
	const auto open = args.openTitle;

	const auto caption = Ui::CreateChild<Kit::Caps>(
		this,
		tr::lng_parvane_notes_backlinks(tr::now, lt_amount, QString::number(backlinks.size())));
	_caption = caption;
	if (backlinks.empty()) {
		_empty = Ui::CreateChild<Kit::Label>(this, tr::lng_parvane_notes_backlinks_empty(tr::now), Kit::Label::Muted());
	}
	for (const auto other : backlinks) {
		const auto row = Ui::CreateChild<IconRow>(this, IconRow::Descriptor{
			.title = Q(other->title),
			.icon = u"note"_q,
			.tone = FolderTone(other->folder),
		});
		const auto title = Q(other->title);
		row->setClickedCallback([=] {
			if (open) {
				open(title);
			}
		});
		_rows.push_back(row);
	}

	if (!args.isGraphHidden) {
		_graphCaption = Ui::CreateChild<Kit::Caps>(this, tr::lng_parvane_notes_tab_graph(tr::now));
		auto found = std::vector<MiniPoint>();
		auto seen = std::set<std::string>{ args.note->id };
		const auto addNote = [&](const notes::IndexedNote *other, bool isDaily) {
			if (!other || seen.contains(other->id)) {
				return;
			}
			seen.emplace(other->id);
			found.push_back({
				.key = other->id,
				.label = DisplayTitle(other->title, isDaily),
				.tone = FolderTone(other->folder, isDaily),
				.title = Q(other->title),
			});
		};
		// Признак заметки дня — из снимка хранилища
		const auto view = Sections::Notes();
		const auto isDaily = [&](const std::string &id) {
			for (const auto &note : view->notes) {
				if (note->id == id) {
					return note->isDaily;
				}
			}
			return false;
		};
		if (const auto indexed = index.byId(args.note->id)) {
			for (const auto &id : indexed->linkedIds) {
				addNote(index.byId(id), isDaily(id));
			}
		}
		for (const auto other : backlinks) {
			addNote(other, isDaily(other->id));
		}
		for (const auto &item : args.planned) {
			if (seen.contains(item.key)) {
				continue;
			}
			seen.emplace(item.key);
			found.push_back({ .key = item.key, .label = Q(item.name), .tone = KindTone(item.kind) });
		}
		if (int(found.size()) > notes::kMiniGraphMaxPoints) {
			found.resize(notes::kMiniGraphMaxPoints);
		}
		const auto places = notes::miniGraphPlaces(found.size());
		for (auto i = 0; i != int(found.size()); ++i) {
			found[i].at = QPointF(places[i].x, places[i].y);
		}
		_graph = Ui::CreateChild<MiniGraph>(this, std::move(found), open);
	}
}

int NoteLinks::resizeGetHeight(int newWidth) {
	// `.links`: столбец с промежутком 0.875rem; подпись раздела — 0.375rem до строк
	auto y = 0;
	_caption->resizeToWidth(newWidth);
	_caption->moveToLeft(0, y, newWidth);
	y += _caption->height() + Rem(0.375);
	if (_empty) {
		_empty->resizeToWidth(newWidth);
		_empty->moveToLeft(0, y, newWidth);
		y += _empty->height();
	}
	for (const auto row : _rows) {
		row->resizeToWidth(newWidth);
		row->moveToLeft(0, y, newWidth);
		y += row->height();
	}
	if (_graphCaption) {
		y += Rem(0.875);
		_graphCaption->resizeToWidth(newWidth);
		_graphCaption->moveToLeft(0, y, newWidth);
		y += _graphCaption->height() + Rem(0.375);
		_graph->resizeToWidth(newWidth);
		_graph->moveToLeft(0, y, newWidth);
		y += _graph->height();
	}
	return y;
}

} // namespace Parvane::Knowledge
