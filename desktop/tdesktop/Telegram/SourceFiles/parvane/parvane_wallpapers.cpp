// Parvane fork: фоны чата как в web — см. parvane_wallpapers.h.
#include "parvane/parvane_wallpapers.h"

#include "data/data_wall_paper.h"
#include "lang/lang_keys.h"
#include "parvane/parvane_space.h"
#include "settings.h"
#include "ui/painter.h"
#include "ui/rp_widget.h"
#include "ui/ui_utility.h"
#include "window/themes/window_theme.h"
#include "styles/style_boxes.h"
#include "styles/style_layers.h"

#include <crl/crl_on_main.h>
#include <rpl/lifetime.h>

#include <QtCore/QFile>
#include <QtGui/QLinearGradient>
#include <QtGui/QMouseEvent>
#include <QtGui/QPainter>
#include <QtSvg/QSvgRenderer>

#include <cmath>
#include <map>
#include <vector>

namespace Parvane::Wallpapers {
namespace {

// Как web wallpapers.ts: фон 2048 px, плитка рисунка 480×960 (рисунок 400×800, бесшовный)
constexpr auto kSize = 2048;
constexpr auto kTileWidth = 480;
constexpr auto kTileHeight = kTileWidth * 2;
constexpr auto kComboPrefix = "combo-";
constexpr auto kDefaultPattern = "science-mix";
// Плотность рисунка фона по умолчанию (одним тоном поверх фона схемы, как web `color-scheme-flat`)
constexpr auto kDefaultInkDark = 0.07;
constexpr auto kDefaultInkLight = 0.10;

// web PATTERN_IDS — порядок образцов
const char *kPatterns[] = {
	"mathematics", "programming", "cosmos", "physics", "chemistry",
	"biology", "electronics", "algorithms", "flight", "science-mix",
};

struct Gradient {
	const char *id = nullptr;
	std::vector<QColor> colors;
	int angle = 0; // 0 — слева направо, 90 — сверху вниз
	QColor ink;
	double inkAlpha = 0.;
};

[[nodiscard]] Gradient Dark(const char *id, std::vector<QColor> colors, int angle) {
	return { id, std::move(colors), angle, QColor(255, 255, 255), 0.22 };
}

[[nodiscard]] Gradient Light(const char *id, std::vector<QColor> colors, int angle, QColor ink) {
	return { id, std::move(colors), angle, ink, 0.3 };
}

[[nodiscard]] const std::vector<Gradient> &Gradients() {
	// web GRADIENTS — тот же порядок и цвета
	static const auto result = std::vector<Gradient>{
		Dark("night", { QColor("#1b2338"), QColor("#101626"), QColor("#232f4d") }, 135),
		Dark("plum", { QColor("#3a2350"), QColor("#1e142e"), QColor("#4d2a5c") }, 150),
		Dark("pine", { QColor("#17382d"), QColor("#0d211b"), QColor("#1f4a3a") }, 120),
		Dark("coal", { QColor("#24262b"), QColor("#15161a"), QColor("#32353c") }, 140),
		Light("meadow", { QColor("#cfe6a8"), QColor("#9fd0a0"), QColor("#e3efc0") }, 130, QColor("#1f4d2a")),
		Light("dawn", { QColor("#f6d6c0"), QColor("#f0b6c2"), QColor("#fbe6cf") }, 110, QColor("#7a2f45")),
		Light("lagoon", { QColor("#bfe3f2"), QColor("#8fc7e6"), QColor("#d8f0f5") }, 160, QColor("#16506e")),
		Light("lilac", { QColor("#d9d0f5"), QColor("#b9a8ea"), QColor("#ece6fb") }, 125, QColor("#3f2f8a")),
		Dark("dusk", { QColor("#3b2a5a"), QColor("#1c1b33"), QColor("#0f1a2e") }, 135),
		Dark("forest", { QColor("#1f4d3a"), QColor("#0f2f25"), QColor("#24613f") }, 160),
		Dark("ocean", { QColor("#0f3d5c"), QColor("#0a2540"), QColor("#146b8a") }, 120),
		Dark("ember", { QColor("#5a2a2a"), QColor("#2e1414"), QColor("#7a3b1f") }, 145),
		Dark("lavender", { QColor("#7c6fcf"), QColor("#4a3f9a"), QColor("#a48ad6") }, 110),
		Light("mint", { QColor("#7cd4b0"), QColor("#3f9a7a"), QColor("#b4e6cf") }, 150, QColor("#124a36")),
		Light("sand", { QColor("#d9c39a"), QColor("#b58f5a"), QColor("#f0dfc0") }, 130, QColor("#5a3d14")),
		Light("sky", { QColor("#8cc6f0"), QColor("#4a8fd6"), QColor("#cfe6fa") }, 100, QColor("#143f6e")),
		Light("rose", { QColor("#e2a0b8"), QColor("#b3607f"), QColor("#f4cfdc") }, 125, QColor("#6a1f3d")),
		Dark("graphite", { QColor("#3a3d45"), QColor("#1f2126"), QColor("#5a5f6a") }, 140),
	};
	return result;
}

[[nodiscard]] const Gradient *FindGradient(const QString &id) {
	for (const auto &gradient : Gradients()) {
		if (id == QLatin1String(gradient.id)) {
			return &gradient;
		}
	}
	return nullptr;
}

[[nodiscard]] bool IsPattern(const QString &id) {
	for (const auto pattern : kPatterns) {
		if (id == QLatin1String(pattern)) {
			return true;
		}
	}
	return false;
}

struct Combination {
	QString gradient;
	QString pattern;
};

// ── выбор (tdata/parvane-background) ───────────────────────────────────────

bool Applying = false;
int Restoring = 0; // RestoreScope

[[nodiscard]] QString ModePath() {
	return cWorkingDir() + u"tdata/parvane-background"_q;
}

[[nodiscard]] QString ReadMode() {
	auto f = QFile(ModePath());
	return f.open(QIODevice::ReadOnly) ? QString::fromUtf8(f.readAll()).trimmed() : QString();
}

void WriteMode(const QString &mode) {
	auto f = QFile(ModePath());
	if (f.open(QIODevice::WriteOnly | QIODevice::Truncate)) {
		f.write(mode.toUtf8());
	}
}

[[nodiscard]] std::optional<Combination> ParseCombination(const QString &mode) {
	if (!mode.startsWith(QLatin1String(kComboPrefix))) {
		return std::nullopt;
	}
	const auto parts = mode.mid(int(qstrlen(kComboPrefix))).split('_');
	if (parts.size() != 2 || !FindGradient(parts[0]) || !IsPattern(parts[1])) {
		return std::nullopt;
	}
	return Combination{ parts[0], parts[1] };
}

[[nodiscard]] QString CombinationSlug(const Combination &combination) {
	return QLatin1String(kComboPrefix) + combination.gradient + '_' + combination.pattern;
}

[[nodiscard]] bool IsDefaultMode(const QString &mode) {
	return mode.isEmpty() || mode.startsWith(u"default"_q);
}

[[nodiscard]] QString DefaultKey() {
	return u"default:%1:%2"_q.arg(CurrentScheme(), Window::Theme::IsNightMode() ? u"n"_q : u"d"_q);
}

// ── отрисовка ──────────────────────────────────────────────────────────────

[[nodiscard]] QImage PatternTile(const QString &pattern) {
	static auto cache = std::map<QString, QImage>();
	if (const auto i = cache.find(pattern); i != end(cache)) {
		return i->second;
	}
	auto tile = QImage(kTileWidth, kTileHeight, QImage::Format_ARGB32_Premultiplied);
	tile.fill(Qt::transparent);
	auto renderer = QSvgRenderer(u":/gui/parvane/patterns/%1.svg"_q.arg(pattern));
	if (renderer.isValid()) {
		auto p = QPainter(&tile);
		p.setRenderHint(QPainter::Antialiasing);
		renderer.render(&p, QRectF(0, 0, kTileWidth, kTileHeight));
	}
	cache.emplace(pattern, tile);
	return tile;
}

// Рисунок чёрный: перекрашиваем его в цвет фона через маску (как web drawPattern)
[[nodiscard]] QImage TintedTile(const QString &pattern, const QColor &ink, double scale) {
	auto tile = PatternTile(pattern);
	if (scale != 1.) {
		tile = tile.scaled(
			std::max(1, int(std::lround(kTileWidth * scale))),
			std::max(1, int(std::lround(kTileHeight * scale))),
			Qt::IgnoreAspectRatio,
			Qt::SmoothTransformation);
	}
	auto p = QPainter(&tile);
	p.setCompositionMode(QPainter::CompositionMode_SourceIn);
	p.fillRect(tile.rect(), ink);
	return tile;
}

[[nodiscard]] QImage Render(
		QSize size,
		const std::vector<QColor> &colors,
		int angle,
		const QString &pattern,
		const QColor &ink,
		double inkAlpha,
		double tileScale) {
	auto result = QImage(size, QImage::Format_ARGB32_Premultiplied);
	auto p = QPainter(&result);
	const auto side = double(std::max(size.width(), size.height()));
	const auto rad = angle * M_PI / 180.;
	const auto dx = std::cos(rad) * side / 2.;
	const auto dy = std::sin(rad) * side / 2.;
	const auto center = QPointF(size.width() / 2., size.height() / 2.);
	auto gradient = QLinearGradient(center - QPointF(dx, dy), center + QPointF(dx, dy));
	const auto last = int(colors.size()) - 1;
	for (auto i = 0; i <= last; ++i) {
		gradient.setColorAt(last ? double(i) / last : 0., colors[i]);
	}
	p.fillRect(result.rect(), gradient);
	p.setOpacity(inkAlpha);
	p.fillRect(result.rect(), QBrush(TintedTile(pattern, ink, tileScale)));
	return result;
}

[[nodiscard]] QImage RenderCombination(const Combination &combination, QSize size, double tileScale) {
	const auto gradient = FindGradient(combination.gradient);
	Assert(gradient != nullptr);
	return Render(
		size,
		gradient->colors,
		gradient->angle,
		combination.pattern,
		gradient->ink,
		gradient->inkAlpha,
		tileScale);
}

// Фон схемы: фон → панель → фон, рисунок цветом текста схемы
struct DefaultLook {
	std::vector<QColor> colors;
	QColor ink;
	double inkAlpha = 0.;
};

[[nodiscard]] DefaultLook DefaultColors() {
	const auto night = Window::Theme::IsNightMode();
	const auto swatches = SchemeSwatches(CurrentScheme(), night);
	return {
		{ swatches[0], swatches[1], swatches[0] },
		swatches[3],
		night ? kDefaultInkDark : kDefaultInkLight,
	};
}

void ApplyImage(QImage image, const QString &mode) {
	WriteMode(mode);
	Applying = true;
	Window::Theme::Background()->set(Data::CustomWallPaper(), std::move(image));
	Window::Theme::Background()->setTile(false);
	Applying = false;
}

void ApplyCombination(const Combination &combination) {
	ApplyImage(RenderCombination(combination, QSize(kSize, kSize), 1.), CombinationSlug(combination));
}

// web pickCombination: второе из пары — из текущего фона, иначе градиент темы / рисунок по умолчанию
[[nodiscard]] Combination PickCombination(const QString &gradient, const QString &pattern) {
	const auto current = ParseCombination(ReadMode());
	const auto themeGradient = Window::Theme::IsNightMode() ? u"night"_q : u"lagoon"_q;
	return {
		!gradient.isEmpty() ? gradient : current ? current->gradient : themeGradient,
		!pattern.isEmpty() ? pattern : current ? current->pattern : QString::fromLatin1(kDefaultPattern),
	};
}

// ── выбор в окне «Фон для чатов» ───────────────────────────────────────────

class Picker final : public Ui::RpWidget {
public:
	explicit Picker(QWidget *parent);

	int resizeGetHeight(int newWidth) override;

protected:
	void paintEvent(QPaintEvent *e) override;
	void mouseMoveEvent(QMouseEvent *e) override;
	void mousePressEvent(QMouseEvent *e) override;
	void leaveEventHook(QEvent *e) override;

private:
	struct Cell {
		QRect rect;
		QString gradient;
		QString pattern;
	};

	void layoutCells(int width);
	void refreshPreviews();
	[[nodiscard]] int cellAt(QPoint point) const;

	std::vector<Cell> _cells;
	std::map<QString, QImage> _patternPreviews; // рисунок → образец на текущем градиенте
	QString _previewGradient;
	QRect _patternTitle;
	QRect _colorTitle;
	int _over = -1;

};

constexpr auto kPatternColumns = 5;
constexpr auto kColorColumns = 6;

Picker::Picker(QWidget *parent) : RpWidget(parent) {
	setMouseTracking(true);
	Window::Theme::Background()->updates(
	) | rpl::on_next([=] {
		refreshPreviews();
		update();
	}, lifetime());
}

int Picker::resizeGetHeight(int newWidth) {
	layoutCells(newWidth);
	auto bottom = 0;
	for (const auto &cell : _cells) {
		bottom = std::max(bottom, cell.rect.y() + cell.rect.height());
	}
	return bottom + st::boxPadding.bottom();
}

void Picker::layoutCells(int width) {
	_cells.clear();
	const auto left = st::boxPadding.left();
	const auto inner = width - left - st::boxPadding.right();
	const auto gap = st::boxPadding.left() / 2;
	const auto font = st::boxTitleFont;
	auto top = st::boxPadding.top();
	_patternTitle = QRect(left, top, inner, font->height);
	top += font->height + gap;
	const auto patternWidth = (inner - gap * (kPatternColumns - 1)) / kPatternColumns;
	const auto patternHeight = patternWidth * 5 / 4;
	auto index = 0;
	for (const auto pattern : kPatterns) {
		const auto row = index / kPatternColumns;
		const auto column = index % kPatternColumns;
		_cells.push_back({
			QRect(left + column * (patternWidth + gap), top + row * (patternHeight + gap), patternWidth, patternHeight),
			QString(),
			QString::fromLatin1(pattern),
		});
		++index;
	}
	top += ((index + kPatternColumns - 1) / kPatternColumns) * (patternHeight + gap) + gap;
	_colorTitle = QRect(left, top, inner, font->height);
	top += font->height + gap;
	const auto colorSide = (inner - gap * (kColorColumns - 1)) / kColorColumns;
	index = 0;
	for (const auto &gradient : Gradients()) {
		const auto row = index / kColorColumns;
		const auto column = index % kColorColumns;
		_cells.push_back({
			QRect(left + column * (colorSide + gap), top + row * (colorSide + gap), colorSide, colorSide),
			QString::fromLatin1(gradient.id),
			QString(),
		});
		++index;
	}
	refreshPreviews();
}

void Picker::refreshPreviews() {
	const auto current = ParseCombination(ReadMode());
	const auto gradient = current
		? current->gradient
		: (Window::Theme::IsNightMode() ? u"night"_q : u"lagoon"_q);
	if (gradient == _previewGradient && !_patternPreviews.empty()) {
		return;
	}
	_previewGradient = gradient;
	_patternPreviews.clear();
	const auto ratio = style::DevicePixelRatio();
	for (const auto &cell : _cells) {
		if (cell.pattern.isEmpty()) {
			continue;
		}
		// Образец — уменьшенный фон: плитка в той же доле, что на экране чата
		const auto size = cell.rect.size() * ratio;
		auto image = RenderCombination({ gradient, cell.pattern }, size, 0.35 * ratio);
		image.setDevicePixelRatio(ratio);
		_patternPreviews[cell.pattern] = std::move(image);
	}
}

int Picker::cellAt(QPoint point) const {
	for (auto i = 0; i != int(_cells.size()); ++i) {
		if (_cells[i].rect.contains(point)) {
			return i;
		}
	}
	return -1;
}

void Picker::paintEvent(QPaintEvent *e) {
	auto p = QPainter(this);
	p.setRenderHint(QPainter::Antialiasing);
	p.setFont(st::boxTitleFont);
	p.setPen(st::boxTitleFg);
	p.drawText(_patternTitle, Qt::AlignLeft | Qt::AlignVCenter, tr::lng_parvane_bg_pattern(tr::now));
	p.drawText(_colorTitle, Qt::AlignLeft | Qt::AlignVCenter, tr::lng_parvane_bg_color(tr::now));

	const auto mode = ReadMode();
	const auto current = ParseCombination(mode);
	const auto radius = st::boxRadius;
	const auto accent = ToneColor(Tone::Accent);
	for (auto i = 0; i != int(_cells.size()); ++i) {
		const auto &cell = _cells[i];
		auto path = QPainterPath();
		path.addRoundedRect(cell.rect, radius, radius);
		p.save();
		p.setClipPath(path);
		if (!cell.pattern.isEmpty()) {
			const auto j = _patternPreviews.find(cell.pattern);
			if (j != end(_patternPreviews)) {
				p.drawImage(cell.rect, j->second);
			}
		} else if (const auto gradient = FindGradient(cell.gradient)) {
			auto fill = QLinearGradient(cell.rect.topLeft(), cell.rect.bottomRight());
			const auto last = int(gradient->colors.size()) - 1;
			for (auto k = 0; k <= last; ++k) {
				fill.setColorAt(last ? double(k) / last : 0., gradient->colors[k]);
			}
			p.fillRect(cell.rect, fill);
		}
		p.restore();
		const auto selected = current
			&& ((!cell.pattern.isEmpty() && cell.pattern == current->pattern)
				|| (!cell.gradient.isEmpty() && cell.gradient == current->gradient));
		if (selected || i == _over) {
			auto pen = QPen(selected ? accent : st::windowSubTextFg->c);
			pen.setWidthF(selected ? style::ConvertScaleExact(2.5) : style::ConvertScaleExact(1.));
			p.setPen(pen);
			p.setBrush(Qt::NoBrush);
			const auto inset = pen.widthF() / 2.;
			p.drawRoundedRect(QRectF(cell.rect).adjusted(inset, inset, -inset, -inset), radius, radius);
		}
	}
}

void Picker::mouseMoveEvent(QMouseEvent *e) {
	const auto over = cellAt(e->pos());
	if (over != _over) {
		_over = over;
		setCursor(over >= 0 ? style::cur_pointer : style::cur_default);
		update();
	}
}

void Picker::leaveEventHook(QEvent *e) {
	if (_over >= 0) {
		_over = -1;
		update();
	}
}

void Picker::mousePressEvent(QMouseEvent *e) {
	const auto index = cellAt(e->pos());
	if (index < 0) {
		return;
	}
	const auto &cell = _cells[index];
	ApplyCombination(PickCombination(cell.gradient, cell.pattern));
	refreshPreviews();
	update();
}

} // namespace

QImage RenderDefault() {
	const auto look = DefaultColors();
	return Render(
		QSize(kSize, kSize),
		look.colors,
		135,
		QString::fromLatin1(kDefaultPattern),
		look.ink,
		look.inkAlpha,
		1.);
}

void NoteCustomApplied() {
	if (!Applying && !Restoring) {
		WriteMode(u"custom"_q);
	}
}

RestoreScope::RestoreScope() {
	++Restoring;
}

RestoreScope::~RestoreScope() {
	--Restoring;
}

void ApplyDefault() {
	ApplyImage(RenderDefault(), DefaultKey());
}

void Start() {
	static auto lifetime = rpl::lifetime();
	static auto started = false;
	if (started) {
		return;
	}
	started = true;
	const auto refresh = [] {
		if (Applying || !IsDefaultMode(ReadMode())) {
			return;
		}
		const auto key = DefaultKey();
		if (key != ReadMode()) {
			ApplyDefault();
		}
	};
	refresh();
	Window::Theme::Background()->updates(
	) | rpl::filter([](const Window::Theme::BackgroundUpdate &update) {
		return update.paletteChanged();
	}) | rpl::on_next([=] {
		crl::on_main(refresh);
	}, lifetime);
}

object_ptr<Ui::RpWidget> CreatePicker(QWidget *parent) {
	return object_ptr<Picker>(parent);
}

} // namespace Parvane::Wallpapers
