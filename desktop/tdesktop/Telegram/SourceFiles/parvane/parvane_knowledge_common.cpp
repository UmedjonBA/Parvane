// Parvane fork: реализация parvane_knowledge_common.h.
#include "parvane/parvane_knowledge_common.h"

#include "parvane/parvane_client.h"
#include "parvane/parvane_client_internal.h"
#include "parvane/parvane_icons.h"
#include "parvane/parvane_safe_open.h"

#include <parvane/storecrypt.h>

#include <parvane/sections/notes_look.h>
#include <parvane/sections/notes_folders.h>

#include "core/application.h"
#include "core/mime_type.h"
#include "lang/lang_keys.h"
#include "ui/basic_click_handlers.h"
#include "ui/boxes/confirm_box.h"
#include "window/window_controller.h"
#include "ui/painter.h"
#include "ui/style/style_core.h"
#include "ui/wrap/vertical_layout.h"
#include "styles/style_basic.h"

#include <QtCore/QDate>
#include <QtCore/QDateTime>
#include <QtCore/QFile>
#include <QtCore/QJsonDocument>
#include <QtCore/QJsonObject>
#include <QtCore/QLocale>
#include <QtCore/QUrl>
#include <QtGui/QDesktopServices>
#include <QtGui/QtEvents>
#include <QtSvg/QSvgRenderer>
#include <QtCore/QHash>

namespace Parvane::Knowledge {
namespace {

// Ключ ширины панели в настройках (web `parvane:panel-<имя>`)
[[nodiscard]] std::string PanelKey(const std::string &panel) {
	return "parvane:panel-" + panel;
}

// Файл аккаунта (`tdata/parvane-knowledge-<адрес>.json`): после выхода без стирания и входа другим аккаунтом
// настройки прежнего (имена его папок) новому не видны. Нет допустимого адреса — пусто (настройки не пишутся)
[[nodiscard]] QString PrefsPath() {
	return AccountFilePath(u"parvane-knowledge-"_q, SelfAddress(), u".json"_q);
}

// Прежний общий файл (до 21 окт 2026) — не переносится: чей он, неизвестно; стирается при первом обращении
[[nodiscard]] QString LegacyPrefsPath() {
	return cWorkingDir() + u"tdata/parvane-knowledge.json"_q;
}

// Ревью 21 окт 2026 (L9): настройки «Знаний» (ширины панелей, свёрнутые папки, папки графа — имена папок
// аккаунта) — через хелперы хранилища: шифром хранилища и под оградой стирания при выходе (после стирания
// фоновая запись не пересоздаёт файл). Без кэша в памяти: после выхода и входа другим аккаунтом прежние
// настройки не всплывают (сбрасывать при Sections::OnAccountReset нечего — каждое чтение из файла текущего
// аккаунта). Открытый файл аккаунта читается (миграция), следующая запись — уже шифром.
[[nodiscard]] QJsonObject Prefs() {
	if (QFile::exists(LegacyPrefsPath())) {
		QFile::remove(LegacyPrefsPath());
	}
	const auto path = PrefsPath();
	if (path.isEmpty()) {
		return QJsonObject();
	}
	const auto raw = parvane::storecrypt::readFile(QFile::encodeName(path).toStdString());
	if (raw.empty()) {
		return QJsonObject();
	}
	const auto doc = QJsonDocument::fromJson(QByteArray::fromStdString(raw));
	return doc.isObject() ? doc.object() : QJsonObject();
}

void WritePrefs(const QJsonObject &prefs) {
	const auto path = PrefsPath();
	if (path.isEmpty()) {
		return;
	}
	(void)parvane::storecrypt::writeFile(
		QFile::encodeName(path).toStdString(),
		QJsonDocument(prefs).toJson(QJsonDocument::Compact).toStdString());
}

[[nodiscard]] QLocale UiLocale() {
	return QLocale(IsRussian() ? QLocale::Russian : QLocale::English);
}

[[nodiscard]] QDate DayOf(const std::string &day) {
	return QDate::fromString(Q(day), u"yyyy-MM-dd"_q);
}

} // namespace

Tone FolderTone(const std::string &folder, bool isDaily) {
	const auto tone = notes::folderTone(folder, isDaily);
	if (tone == "blue") return Tone::Blue;
	if (tone == "green") return Tone::Green;
	if (tone == "orange") return Tone::Orange;
	if (tone == "purple") return Tone::Purple;
	if (tone == "aqua") return Tone::Aqua;
	if (tone == "red") return Tone::Red;
	return Tone::Yellow; // `--pv-note`
}

Tone KindTone(const std::string &kind) {
	return (kind == "task") ? Tone::Purple : Tone::Blue;
}

bool IsRussian() {
	return Parvane::IsRussianUi();
}

std::string VaultName() {
	return S(tr::lng_parvane_notes_vault_name(tr::now));
}

std::string DailyFolderName() {
	return S(tr::lng_parvane_notes_daily_folder(tr::now));
}

std::string TodayKey() {
	return S(QDate::currentDate().toString(u"yyyy-MM-dd"_q));
}

double NowMinutes() {
	const auto time = QTime::currentTime();
	return time.hour() * 60. + time.minute();
}

QString DisplayTitle(const std::string &title, bool isDaily) {
	if (!isDaily || !notes::isDayTitle(title)) {
		return Q(title);
	}
	const auto date = DayOf(title);
	if (!date.isValid()) {
		return Q(title);
	}
	// Intl `{ weekday: 'short', day: 'numeric', month: 'long' }`: «пт, 17 октября» / «Fri, October 17»
	const auto locale = UiLocale();
	return IsRussian()
		? locale.toString(date, u"ddd, d MMMM"_q)
		: locale.toString(date, u"ddd, MMMM d"_q);
}

QString FormatDayShort(const std::string &day) {
	const auto date = DayOf(day);
	if (!date.isValid()) {
		return Q(day);
	}
	auto result = IsRussian()
		? UiLocale().toString(date, u"d MMM"_q)
		: UiLocale().toString(date, u"MMM d"_q);
	if (result.endsWith('.')) {
		result.chop(1);
	}
	return result;
}

QString FormatDue(const std::string &day) {
	return tr::lng_parvane_notes_due(tr::now, lt_date, FormatDayShort(day));
}

QString FormatRepeat(const planner::Repeat &repeat) {
	const auto n = repeat.interval;
	const auto amount = QString::number(n);
	const auto locale = UiLocale();
	auto base = QString();
	if (repeat.kind == "daily") {
		base = (n == 1)
			? tr::lng_parvane_notes_repeat_daily(tr::now)
			: tr::lng_parvane_notes_repeat_every_days(tr::now, lt_amount, amount);
	} else if (repeat.kind == "weekly") {
		// С понедельника: 0 — воскресенье (как Date.getDay)
		auto days = repeat.weekdays.value_or(std::vector<int>());
		ranges::sort(days, [](int a, int b) { return ((a + 6) % 7) < ((b + 6) % 7); });
		auto names = QStringList();
		for (const auto weekday : days) {
			names.push_back(locale.dayName(weekday ? weekday : 7, QLocale::ShortFormat));
		}
		const auto list = names.join(u", "_q);
		base = (n == 1)
			? tr::lng_parvane_notes_repeat_weekly(tr::now, lt_days, list)
			: tr::lng_parvane_notes_repeat_every_weeks(tr::now, lt_amount, amount, lt_days, list);
	} else if (repeat.kind == "monthly") {
		const auto start = DayOf(repeat.startDay);
		const auto day = QString::number(repeat.monthDay.value_or(start.isValid() ? start.day() : 1));
		base = (n == 1)
			? tr::lng_parvane_notes_repeat_monthly(tr::now, lt_day, day)
			: tr::lng_parvane_notes_repeat_every_months(tr::now, lt_amount, amount, lt_day, day);
	} else {
		const auto start = DayOf(repeat.startDay);
		const auto date = start.isValid() ? locale.toString(start, u"d MMMM"_q) : QString();
		base = (n == 1)
			? tr::lng_parvane_notes_repeat_yearly(tr::now, lt_date, date)
			: tr::lng_parvane_notes_repeat_every_years(tr::now, lt_amount, amount, lt_date, date);
	}
	auto parts = QStringList{ base };
	if (repeat.endDay) {
		const auto end = DayOf(*repeat.endDay);
		parts.push_back(tr::lng_parvane_notes_repeat_until(
			tr::now,
			lt_date,
			end.isValid() ? locale.toString(end, u"d MMMM yyyy"_q) : Q(*repeat.endDay)));
	}
	if (repeat.count && *repeat.count) {
		parts.push_back(tr::lng_parvane_notes_repeat_times(tr::now, lt_amount, QString::number(*repeat.count)));
	}
	return parts.join(u" · "_q);
}

QString FolderCaption(const std::string &path) {
	return path.empty() ? tr::lng_parvane_notes_root(tr::now) : Q(notes::folderCaption(path));
}

QString FormatSize(int64_t bytes) {
	const auto locale = UiLocale();
	if (bytes < 1024) {
		return QString::number(bytes) + (IsRussian() ? u" Б"_q : u" B"_q);
	}
	const auto units = IsRussian()
		? std::array<QString, 4>{ u"КБ"_q, u"МБ"_q, u"ГБ"_q, u"ТБ"_q }
		: std::array<QString, 4>{ u"KB"_q, u"MB"_q, u"GB"_q, u"TB"_q };
	auto value = bytes / 1024.;
	auto unit = 0;
	while (value >= 1024. && unit + 1 < int(units.size())) {
		value /= 1024.;
		++unit;
	}
	return locale.toString(value, 'f', (value < 10.) ? 1 : 0) + ' ' + units[unit];
}

// ── настройки ────────────────────────────────────────────────────────────────

std::optional<std::string> PrefGet(const std::string &key) {
	const auto value = Prefs().value(Q(key));
	if (!value.isString()) {
		return std::nullopt;
	}
	return S(value.toString());
}

void PrefSet(const std::string &key, const std::optional<std::string> &value) {
	auto prefs = Prefs();
	if (value) {
		prefs.insert(Q(key), Q(*value));
	} else {
		prefs.remove(Q(key));
	}
	WritePrefs(prefs);
}

std::optional<int> PanelWidth(const std::string &panel) {
	const auto stored = PrefGet(PanelKey(panel));
	if (!stored) {
		return std::nullopt;
	}
	auto ok = false;
	const auto value = Q(*stored).toInt(&ok);
	return (ok && value > 0) ? std::make_optional(value) : std::nullopt;
}

void SetPanelWidth(const std::string &panel, std::optional<int> width) {
	PrefSet(PanelKey(panel), width ? std::make_optional(std::to_string(*width)) : std::nullopt);
}

// ── текст с разметкой ────────────────────────────────────────────────────────

struct RichText::Colors {
	Colors()
	: link(st::windowActiveTextFg->c)
	, mono(ToneColor(Tone::Orange))
	, palette(st::defaultTextPalette)
	, style(st::defaultTextStyle) {
		palette.linkFg = link.color();
		palette.monoFg = mono.color();
		palette.selectLinkFg = link.color();
		palette.selectMonoFg = mono.color();
		refresh();
	}

	void refresh() {
		mono.update(ToneColor(Tone::Orange));
		pens[0] = QPen(ToneColor(Tone::Purple));
		pens[1] = QPen(ToneColor(Tone::Red));
		pens[2] = QPen(ToneColor(Tone::Aqua));
		for (auto i = 0; i != int(pens.size()); ++i) {
			special[i] = Ui::Text::SpecialColor{ .pen = &pens[i], .penSelected = &pens[i] };
		}
	}

	style::owned_color link;
	style::owned_color mono;
	style::TextPalette palette;
	style::TextStyle style;
	std::array<QPen, 3> pens;
	std::array<Ui::Text::SpecialColor, 3> special;
};

namespace {

// Номера цветов Colorized: данные сущности — QChar(n) → special[n - 1]
constexpr auto kNoteColor = 1;
constexpr auto kMissingColor = 2;
constexpr auto kTagColor = 3;
const auto kNoteScheme = u"pvnote:"_q;

[[nodiscard]] TextWithEntities BuildMarked(
		const std::vector<md::MdInline> &parts,
		const Fn<bool(const std::string&)> &noteExists) {
	auto result = TextWithEntities();
	for (const auto &part : parts) {
		const auto text = Q(part.text);
		const auto offset = int(result.text.size());
		const auto length = int(text.size());
		result.text.append(text);
		if (!length) {
			continue;
		}
		const auto add = [&](EntityType type, const QString &data = QString()) {
			result.entities.push_back(EntityInText(type, offset, length, data));
		};
		switch (part.type) {
		case md::MdInlineType::Bold: add(EntityType::Bold); break;
		case md::MdInlineType::Italic: add(EntityType::Italic); break;
		case md::MdInlineType::Strike: add(EntityType::StrikeOut); break;
		case md::MdInlineType::Code: add(EntityType::Code); break;
		case md::MdInlineType::Tag: add(EntityType::Colorized, QString(QChar(kTagColor))); break;
		case md::MdInlineType::Note: {
			const auto exists = !noteExists || noteExists(part.target);
			add(EntityType::CustomUrl, kNoteScheme + Q(part.target));
			add(EntityType::Colorized, QString(QChar(exists ? kNoteColor : kMissingColor)));
		} break;
		case md::MdInlineType::Link: add(EntityType::CustomUrl, Q(part.url)); break;
		case md::MdInlineType::Text: break;
		}
	}
	return result;
}

} // namespace

RichText::RichText(QWidget *parent, Style st)
: RpWidget(parent)
, _st(st)
, _colors(std::make_unique<Colors>()) {
	setMouseTracking(true);
	refreshStyle();
	TonesChanges() | rpl::on_next([=] {
		_colors->refresh();
		update();
	}, lifetime());
}

RichText::~RichText() = default;

void RichText::refreshStyle() {
	auto &style = _colors->style;
	style.font = Kit::Font(_st.px, _st.semibold, _st.mono);
	style.lineHeight = int(std::round(Kit::Px(_st.px) * _st.lineHeight));
	style.linkUnderline = st::kLinkUnderlineActive;
}

void RichText::setInlines(const std::vector<md::MdInline> &parts, Fn<bool(const std::string&)> noteExists) {
	_marked = BuildMarked(parts, noteExists);
	apply();
}

void RichText::setMarkdown(const std::string &text, Fn<bool(const std::string&)> noteExists) {
	setInlines(md::parseInline(text), std::move(noteExists));
}

void RichText::setPlain(const QString &text) {
	_marked = TextWithEntities{ text };
	apply();
}

void RichText::setTone(Tone tone) {
	_st.tone = tone;
	update();
}

void RichText::setOpenNote(Fn<void(QString)> callback) {
	_openNote = std::move(callback);
}

void RichText::apply() {
	auto marked = _marked;
	if (_st.strike && !marked.text.isEmpty()) {
		marked.entities.push_front(EntityInText(EntityType::StrikeOut, 0, int(marked.text.size())));
	}
	auto options = TextParseOptions{
		TextParseLinks | TextParseMultiline | TextParseMarkdown | TextParseColorized,
		0,
		0,
		Qt::LayoutDirectionAuto,
	};
	_text.setMarkedText(_colors->style, marked, options);
	setNaturalWidth(_text.maxWidth());
	resize(width(), resizeGetHeight(width()));
	update();
}

int RichText::naturalTextWidth() const {
	return _text.maxWidth();
}

int RichText::resizeGetHeight(int newWidth) {
	const auto line = _colors->style.lineHeight;
	if (_text.isEmpty() || newWidth <= 0) {
		return line;
	}
	return std::max(_text.countHeight(newWidth), line);
}

void RichText::paintEvent(QPaintEvent *e) {
	auto p = QPainter(this);
	p.setPen(ToneColor(_st.tone));
	_text.draw(p, {
		.position = QPoint(),
		.outerWidth = width(),
		.availableWidth = width(),
		.clip = e->rect(),
		.palette = &_colors->palette,
		.colors = std::span<Ui::Text::SpecialColor>(_colors->special),
	});
}

ClickHandlerPtr RichText::linkAt(QPoint point) const {
	return _text.getState(point, width()).link;
}

void RichText::mouseMoveEvent(QMouseEvent *e) {
	const auto link = linkAt(e->pos());
	setCursor(link ? style::cur_pointer : style::cur_default);
	if (ClickHandler::getActive() != link) {
		ClickHandler::setActive(link, nullptr);
		update();
	}
}

void RichText::leaveEventHook(QEvent *e) {
	setCursor(style::cur_default);
	if (ClickHandler::getActive()) {
		ClickHandler::setActive(nullptr, nullptr);
		update();
	}
}

void RichText::mousePressEvent(QMouseEvent *e) {
	_pressed = (e->button() == Qt::LeftButton) ? linkAt(e->pos()) : nullptr;
	if (!_pressed) {
		RpWidget::mousePressEvent(e);
	}
}

void RichText::mouseReleaseEvent(QMouseEvent *e) {
	const auto pressed = std::exchange(_pressed, nullptr);
	if (!pressed || linkAt(e->pos()) != pressed) {
		RpWidget::mouseReleaseEvent(e);
		return;
	}
	const auto url = pressed->url();
	if (url.startsWith(kNoteScheme)) {
		if (_openNote) {
			_openNote(url.mid(kNoteScheme.size()));
		}
	} else if (!url.isEmpty()) {
		// Ревью 21 окт 2026 (2.3): не UrlClickHandler (он превращает t.me во внутренний tg:// и открывает скрытые
		// ссылки без вопроса), а браузер системы; подпись ≠ адресу — окно «Перейти по ссылке?»
		auto shown = QString();
		auto found = false;
		for (const auto &entity : _marked.entities) {
			if (entity.type() != EntityType::CustomUrl || entity.data() != url) {
				continue;
			}
			shown = _marked.text.mid(entity.offset(), entity.length());
			found = true;
			if (md::linkNeedsConfirmation(S(shown), S(url))) {
				break;
			}
		}
		// Автоссылка — сам адрес в тексте; иначе подписи не нашли — спросить
		const auto literal = !found && _marked.text.contains(url);
		OpenExternalLink(url, found ? shown : url, !found && !literal);
	}
}

// ── значки ───────────────────────────────────────────────────────────────────

namespace {

// Контуры web PvIcon.tsx: `d` — линия, `c` — круг, `r` — прямоугольник (`x y w h скругление`), `f` — точка-заливка
const QHash<QString, QStringList> &NotesIconShapes() {
	static const auto result = QHash<QString, QStringList>{
		{ u"minus"_q, { u"d:M5 12h14"_q } },
		{ u"left"_q, { u"d:M15 5l-7 7 7 7"_q } },
		{ u"up"_q, { u"d:M6 15l6-6 6 6"_q } },
		{ u"down"_q, { u"d:M6 9l6 6 6-6"_q } },
		{ u"x"_q, { u"d:M6 6l12 12M18 6L6 18"_q } },
		{ u"edit"_q, { u"d:M4 20h4L19 9l-4-4L4 16z"_q } },
		{ u"trash"_q, { u"d:M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"_q } },
		{ u"cal"_q, { u"r:3 5 18 16 2"_q, u"d:M3 10h18M8 3v4M16 3v4"_q } },
		{ u"link"_q, { u"d:M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"_q } },
		{ u"board"_q, { u"r:3 3 8 7 1.5"_q, u"r:14 6 7 6 1.5"_q, u"r:6 15 8 6 1.5"_q, u"d:M11 7h3M10 10l0 5"_q } },
		{ u"fit"_q, { u"d:M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"_q } },
		{ u"graph"_q, { u"c:6 6 2.5"_q, u"c:18 9 2.5"_q, u"c:9 18 2.5"_q, u"d:M8.4 6.6l7.2 1.8M6.6 8.4l1.8 7.2M16.2 10.8l-5.4 5.4"_q } },
		{ u"dots"_q, { u"f:12 5 1.4"_q, u"f:12 12 1.4"_q, u"f:12 19 1.4"_q } },
		{ u"undo"_q, { u"d:M9 14L4 9l5-5"_q, u"d:M4 9h10a6 6 0 0 1 0 12h-3"_q } },
		{ u"open"_q, { u"d:M14 4h6v6M20 4l-9 9"_q, u"d:M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"_q } },
		{ u"file"_q, { u"d:M6 3h9l4 4v14H6z"_q, u"d:M14 3v5h5M9 13h6M9 17h6"_q } },
	};
	return result;
}

[[nodiscard]] QImage NotesIconImage(const QString &name, const QColor &color, int size) {
	static auto cache = QHash<QString, QImage>();
	const auto ratio = style::DevicePixelRatio();
	const auto key = name + '/' + QString::number(color.rgba(), 16) + '/'
		+ QString::number(size) + '/' + QString::number(ratio);
	if (const auto i = cache.constFind(key); i != cache.constEnd()) {
		return *i;
	}
	const auto colorName = color.name(QColor::HexRgb).toLatin1();
	const auto opacity = QByteArray::number(color.alphaF(), 'f', 3);
	auto svg = QByteArray("<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"")
		+ colorName + "\" stroke-opacity=\"" + opacity
		+ "\" stroke-width=\"1.8\" stroke-linecap=\"round\" stroke-linejoin=\"round\">";
	for (const auto &shape : NotesIconShapes().value(name)) {
		const auto kind = shape.left(1);
		const auto values = shape.mid(2).toLatin1();
		const auto numbers = values.split(' ');
		if (kind == u"d"_q) {
			svg += "<path d=\"" + values + "\"/>";
		} else if (kind == u"c"_q && numbers.size() == 3) {
			svg += "<circle cx=\"" + numbers[0] + "\" cy=\"" + numbers[1] + "\" r=\"" + numbers[2] + "\"/>";
		} else if (kind == u"f"_q && numbers.size() == 3) {
			svg += "<circle cx=\"" + numbers[0] + "\" cy=\"" + numbers[1] + "\" r=\"" + numbers[2]
				+ "\" fill=\"" + colorName + "\" fill-opacity=\"" + opacity + "\" stroke=\"none\"/>";
		} else if (kind == u"r"_q && numbers.size() == 5) {
			svg += "<rect x=\"" + numbers[0] + "\" y=\"" + numbers[1] + "\" width=\"" + numbers[2]
				+ "\" height=\"" + numbers[3] + "\" rx=\"" + numbers[4] + "\"/>";
		}
	}
	svg += "</svg>";
	auto image = QImage(QSize(size, size) * ratio, QImage::Format_ARGB32_Premultiplied);
	image.fill(Qt::transparent);
	{
		auto renderer = QSvgRenderer(svg);
		auto p = QPainter(&image);
		renderer.render(&p, QRectF(0, 0, size * ratio, size * ratio));
	}
	image.setDevicePixelRatio(ratio);
	cache.insert(key, image);
	return image;
}

} // namespace

void PaintNotesIcon(QPainter &p, const QString &name, const QColor &color, int x, int y, int size) {
	if (NotesIconShapes().contains(name)) {
		p.drawImage(x, y, NotesIconImage(name, color, size));
	} else if (HasIcon(name)) {
		PaintIcon(p, name, color, x, y, size);
	}
}

QString KitIcon(const QString &name) {
	if (HasIcon(name)) {
		return name;
	} else if (name == u"edit"_q) {
		return u"pen"_q;
	} else if (name == u"cal"_q) {
		return u"calendar"_q;
	}
	return QString();
}

NotesIconButton::NotesIconButton(QWidget *parent, const QString &icon, const QString &accessibleName, int side)
: Button(parent)
, _icon(icon) {
	setAccessibleName(accessibleName);
	const auto size = side ? side : Kit::Rem(2.25);
	setNaturalWidth(size);
	resize(size, size);
}

void NotesIconButton::setIcon(const QString &icon) {
	_icon = icon;
	update();
}

void NotesIconButton::paintEvent(QPaintEvent *e) {
	auto p = QPainter(this);
	PainterHighQualityEnabler hq(p);
	if (!isEnabled()) {
		p.setOpacity(0.4);
	}
	const auto over = isEnabled() && (isOver() || isDown());
	const auto r = QRectF(rect());
	if (over) {
		p.setPen(Qt::NoPen);
		p.setBrush(ToneColor(Tone::Hover));
		p.drawEllipse(r);
	}
	const auto icon = (width() < Kit::Rem(2.25)) ? Kit::Rem(1.125) : Kit::Rem(1.375);
	PaintNotesIcon(
		p,
		_icon,
		ToneColor(over ? Tone::Fg : Tone::Muted),
		(width() - icon) / 2,
		(height() - icon) / 2,
		icon);
	if (focusVisible() && hasFocus()) {
		paintFocusRing(p, r, r.height() / 2.);
	}
}

NotesTextButton::NotesTextButton(QWidget *parent, const QString &text, const QString &icon, Kind kind)
: Button(parent)
, _text(text)
, _icon(icon)
, _kind(kind) {
	setAccessibleName(text);
	if (_kind == Kind::Chip) {
		_px = 13;
	} else if (_kind != Kind::Plain) {
		_px = 14;
	}
	_semibold = (_kind == Kind::Accent);
	refreshSize();
}

void NotesTextButton::setText(const QString &text) {
	_text = text;
	setAccessibleName(text);
	refreshSize();
}

void NotesTextButton::setIcon(const QString &icon, const QString &trailingIcon) {
	_icon = icon;
	_trailing = trailingIcon;
	refreshSize();
}

void NotesTextButton::setOn(bool on, std::optional<Tone> tone) {
	_on = on;
	_tone = tone;
	update();
}

void NotesTextButton::setTextTone(Tone tone) {
	_textTone = tone;
	update();
}

void NotesTextButton::setFontPx(int px, bool semibold) {
	_px = px;
	_semibold = semibold;
	refreshSize();
}

void NotesTextButton::setWide(bool wide) {
	_wide = wide;
	setNaturalWidth(_wide ? -1 : contentWidth());
	refreshSize();
}

int NotesTextButton::contentWidth() const {
	const auto pad = (_kind == Kind::Plain) ? 0 : (_kind == Kind::Chip) ? Kit::Rem(0.75) : Kit::Rem(0.875);
	const auto gap = Kit::Rem(0.375);
	const auto icon = Kit::Rem(1.125);
	auto w = 2 * pad + Kit::Font(_px, _semibold)->width(_text);
	if (!_icon.isEmpty()) {
		w += icon + (_text.isEmpty() ? 0 : gap);
	}
	if (!_trailing.isEmpty()) {
		w += icon + gap;
	}
	return w;
}

void NotesTextButton::refreshSize() {
	const auto h = (_kind == Kind::Chip)
		? Kit::Rem(1.875)
		: (_kind == Kind::Plain)
		? std::max(Kit::Font(_px, _semibold)->height, Kit::Rem(1.125))
		: Kit::Rem(2.25);
	if (!_wide) {
		const auto w = contentWidth();
		setNaturalWidth(w);
		resize(w, h);
	} else {
		resize(width(), h);
	}
	update();
}

int NotesTextButton::resizeGetHeight(int newWidth) {
	return height();
}

void NotesTextButton::paintEvent(QPaintEvent *e) {
	auto p = QPainter(this);
	PainterHighQualityEnabler hq(p);
	const auto enabled = isEnabled();
	if (!enabled) {
		p.setOpacity((_kind == Kind::Chip) ? 0.4 : 0.5);
	}
	const auto over = enabled && (isOver() || isDown());
	const auto r = QRectF(rect());
	auto fg = ToneColor(Tone::Fg);
	auto radius = Kit::Rem(0.5);
	switch (_kind) {
	case Kind::Plain:
		fg = ToneColor(_textTone.value_or(over ? Tone::Fg : Tone::Muted));
		radius = Kit::Rem(0.375);
		break;
	case Kind::Btn:
		p.setPen(Qt::NoPen);
		p.setBrush(ToneColor(over ? Tone::Line2 : Tone::Hover));
		p.drawRoundedRect(r, radius, radius);
		break;
	case Kind::Ghost:
		if (over) {
			p.setPen(Qt::NoPen);
			p.setBrush(ToneColor(Tone::Hover));
			p.drawRoundedRect(r, radius, radius);
		}
		fg = ToneColor(over ? Tone::Fg : Tone::Muted);
		break;
	case Kind::Accent: {
		auto bg = ToneColor(Tone::Accent);
		if (over) {
			bg = bg.lighter(106);
		}
		p.setPen(Qt::NoPen);
		p.setBrush(bg);
		p.drawRoundedRect(r, radius, radius);
		fg = ToneColor(Tone::AccentInk);
	} break;
	case Kind::Danger: {
		if (over) {
			p.setPen(Qt::NoPen);
			p.setBrush(Kit::Mix(Tone::Red, 0.14));
			p.drawRoundedRect(r, radius, radius);
		}
		fg = ToneColor(Tone::Red);
	} break;
	case Kind::Chip: {
		radius = height() / 2;
		const auto tone = ToneColor(_tone.value_or(Tone::Accent));
		const auto panel = ToneColor(Tone::Panel);
		auto bg = panel;
		if (_on) {
			// `color-mix(in srgb, <тон> 22%, --pv-panel)`
			bg = QColor(
				int(tone.red() * 0.22 + panel.red() * 0.78),
				int(tone.green() * 0.22 + panel.green() * 0.78),
				int(tone.blue() * 0.22 + panel.blue() * 0.78));
		}
		p.setPen(_on ? QPen(Qt::NoPen) : QPen(ToneColor(Tone::Line2), Kit::Px(1)));
		p.setBrush(bg);
		p.drawRoundedRect(r.adjusted(0.5, 0.5, -0.5, -0.5), radius, radius);
		fg = _on ? tone : ToneColor(over ? Tone::Fg : Tone::Muted);
	} break;
	}
	const auto pad = (_kind == Kind::Plain) ? 0 : (_kind == Kind::Chip) ? Kit::Rem(0.75) : Kit::Rem(0.875);
	const auto gap = Kit::Rem(0.375);
	const auto icon = Kit::Rem(1.125);
	auto x = _wide ? std::max((width() - contentWidth()) / 2, 0) + pad : pad;
	if (!_icon.isEmpty()) {
		PaintNotesIcon(p, _icon, fg, x, (height() - icon) / 2, icon);
		x += icon + gap;
	}
	const auto font = Kit::Font(_px, _semibold);
	auto right = width() - pad;
	if (!_trailing.isEmpty()) {
		right -= icon;
		PaintNotesIcon(p, _trailing, fg, right, (height() - icon) / 2, icon);
		right -= gap;
	}
	p.setFont(font->f);
	p.setPen(fg);
	p.drawText(x, (height() - font->height) / 2 + font->ascent, font->elided(_text, std::max(right - x, 0)));
	if (focusVisible() && hasFocus()) {
		paintFocusRing(p, r, radius);
	}
}

// ── строка со значком ────────────────────────────────────────────────────────

IconRow::IconRow(QWidget *parent, Descriptor descriptor)
: Button(parent)
, _descriptor(std::move(descriptor)) {
	setAccessibleName(_descriptor.title);
	resize(width(), Kit::Rem(2.75));
}

int IconRow::resizeGetHeight(int newWidth) {
	return Kit::Rem(2.75);
}

void IconRow::paintEvent(QPaintEvent *e) {
	auto p = QPainter(this);
	PainterHighQualityEnabler hq(p);
	const auto r = QRectF(rect());
	const auto radius = double(Kit::Rem(0.5));
	if (_descriptor.selected || isOver() || isDown() || (focusVisible() && hasFocus())) {
		p.setPen(Qt::NoPen);
		p.setBrush(ToneColor(Tone::Hover));
		p.drawRoundedRect(r, radius, radius);
	}
	const auto padX = Kit::Rem(0.625);
	const auto gap = Kit::Rem(0.75);
	const auto side = Kit::Rem(2);
	const auto tile = QRectF(padX, (height() - side) / 2., side, side);
	const auto color = _descriptor.tone ? ToneColor(*_descriptor.tone) : ToneColor(Tone::Muted);
	p.setPen(Qt::NoPen);
	p.setBrush(_descriptor.tone ? Kit::Mix(color, 0.22) : ToneColor(Tone::Raised));
	p.drawRoundedRect(tile, Kit::Rem(0.625), Kit::Rem(0.625));
	if (!_descriptor.icon.isEmpty()) {
		const auto icon = Kit::Rem(1.125);
		PaintNotesIcon(p, _descriptor.icon, color, int(tile.x() + (side - icon) / 2), int(tile.y() + (side - icon) / 2), icon);
	}
	auto left = padX + side + gap;
	auto right = width() - padX;
	if (!_descriptor.trailingIcon.isEmpty()) {
		const auto icon = Kit::Rem(1.125);
		right -= icon;
		PaintNotesIcon(p, _descriptor.trailingIcon, ToneColor(Tone::Fg), right, (height() - icon) / 2, icon);
		right -= gap;
	}
	const auto font = Kit::Font(Kit::kBodyPx);
	p.setFont(font->f);
	p.setPen(ToneColor(Tone::Fg));
	p.drawText(
		left,
		(height() - font->height) / 2 + font->ascent,
		font->elided(_descriptor.title, std::max(right - left, 0)));
	if (focusVisible() && hasFocus()) {
		paintFocusRing(p, r, radius);
	}
}

// ── окна ─────────────────────────────────────────────────────────────────────

not_null<QWidget*> SheetHost(not_null<QWidget*> widget) {
	for (auto w = widget.get(); w; w = w->parentWidget()) {
		if (w->objectName() == u"ParvaneKnowledge"_q) {
			return w;
		}
	}
	return widget->window();
}

not_null<Kit::Sheet*> ShowQuestion(
		not_null<QWidget*> parent,
		const QString &title,
		const QString &text,
		std::vector<SheetButton> buttons,
		bool column) {
	const auto sheet = Kit::Sheet::Show(parent, {
		.title = title,
		.closeName = tr::lng_parvane_notes_close(tr::now),
	});
	if (!text.isEmpty()) {
		sheet->add(object_ptr<Kit::Label>(
			sheet,
			text,
			Kit::Label::Style{ .multiline = true }));
	}
	buttons.push_back({
		.text = tr::lng_parvane_notes_cancel(tr::now),
		.kind = Kit::PushButton::Kind::Ghost,
	});
	const auto addButton = [=](not_null<QWidget*> parent, const SheetButton &button) {
		auto result = object_ptr<Kit::PushButton>(parent, button.text, button.kind, KitIcon(button.icon));
		const auto callback = button.callback;
		result->setClickedCallback([=] {
			sheet->requestClose();
			if (callback) {
				callback();
			}
		});
		return result;
	};
	if (column) {
		for (const auto &button : buttons) {
			const auto raw = sheet->add(addButton(sheet, button));
			raw->setWide(true);
		}
	} else {
		const auto row = sheet->addButtons();
		for (const auto &button : buttons) {
			row->add(addButton(row, button));
		}
	}
	sheet->showSheet();
	return sheet;
}

// ── правки ───────────────────────────────────────────────────────────────────

void EnsureNote(const std::string &title, Fn<void(std::optional<std::string>)> done) {
	const auto vault = VaultName();
	const auto daily = DailyFolderName();
	Sections::Ask<std::optional<std::string>>([=](Sections::Workers &w) -> std::optional<std::string> {
		if (const auto found = w.notes.findNoteByTitle(title)) {
			return found->id;
		}
		return notes::isDayTitle(title)
			? w.notes.openDailyNote(title, vault, daily)
			: w.notes.createNote(title, vault);
	}, [=](std::optional<std::string> id) {
		if (done) {
			done(std::move(id));
		}
	});
}

void SaveNote(
		const std::string &noteId,
		const std::string &text,
		std::optional<std::string> base,
		Fn<void(bool)> done) {
	const auto vault = VaultName();
	Sections::Ask<bool>([=](Sections::Workers &w) {
		return w.notes.saveNote(noteId, text, vault, base);
	}, [=](bool ok) {
		if (done) {
			done(ok);
		}
	});
}

void RenameNote(const std::string &noteId, const std::string &title) {
	const auto vault = VaultName();
	Sections::Post([=](Sections::Workers &w) {
		w.notes.renameNote(noteId, title, vault);
	});
}

void DeleteNote(const std::string &noteId) {
	Sections::Post([=](Sections::Workers &w) {
		w.notes.deleteNote(noteId);
	});
}

void MoveNote(const std::string &noteId, std::optional<std::string> folderId) {
	Sections::Post([=](Sections::Workers &w) {
		w.notes.moveNote(noteId, folderId);
	});
}

notes::NoteRef FindNote(const std::string &noteId) {
	const auto view = Sections::Notes();
	for (const auto &note : view->notes) {
		if (note->id == noteId) {
			return note;
		}
	}
	return nullptr;
}

} // namespace Parvane::Knowledge

// ── ввод от собеседника: ссылки и файлы (ревью безопасности 21 окт 2026, 2.3) ─────────────────────────────────

namespace Parvane {

bool SafeToOpenFile(const QString &name, const std::string &mime) {
	if (!parvane::sections::cloud::safeToOpenExternally(mime, name.toStdString())) {
		return false;
	}
	switch (Core::DetectNameType(name)) {
	case Core::NameType::Image:
	case Core::NameType::Video:
	case Core::NameType::Audio:
		return true;
	default:
		return false;
	}
}

void OpenExternalLink(const QString &url, const QString &shown, bool alwaysConfirm) {
	namespace md = parvane::sections::markdown;
	const auto window = Core::App().activeWindow();
	const auto trimmed = url.trimmed();
	const auto parsed = QUrl(trimmed, QUrl::StrictMode);
	const auto scheme = parsed.scheme().toLower();
	const auto allowed = md::isSafeUrl(trimmed.toStdString())
		&& parsed.isValid()
		&& (scheme == u"http"_q || scheme == u"https"_q || scheme == u"mailto"_q)
		&& (scheme == u"mailto"_q || !parsed.host().isEmpty());
	if (!allowed) {
		if (window) {
			window->showToast(tr::lng_parvane_link_blocked(tr::now));
		}
		return;
	}
	const auto open = [=] {
		QDesktopServices::openUrl(parsed);
	};
	// mailto: из чужого текста несёт произвольные параметры (cc, bcc, body) — всегда с подтверждением и полным адресом
	if (!alwaysConfirm && scheme != u"mailto"_q && !md::linkNeedsConfirmation(shown.toStdString(), trimmed.toStdString())) {
		open();
		return;
	}
	if (!window) {
		return;
	}
	// Полный адрес (с punycode-узлом — чтобы похожие буквы другого алфавита было видно)
	const auto display = parsed.toString(QUrl::FullyEncoded);
	window->show(Ui::MakeConfirmBox({
		.text = tr::lng_open_this_link(tr::now) + u"\n\n"_q + display,
		.confirmed = [=](Fn<void()> close) {
			open();
			close();
		},
		.confirmText = tr::lng_open_link(tr::now),
	}));
}

} // namespace Parvane
