// Parvane fork: реализация parvane_scheme_picker.h.
#include "parvane/parvane_scheme_picker.h"

#include "parvane/parvane_icons.h"
#include "parvane/parvane_kit.h"
#include "parvane/parvane_space.h"

#include "lang/lang_keys.h"
#include "settings/settings_common.h"
#include "ui/painter.h"
#include "ui/vertical_list.h"
#include "ui/widgets/buttons.h"
#include "ui/widgets/labels.h"
#include "ui/wrap/vertical_layout.h"
#include "window/themes/window_theme.h"
#include "styles/style_settings.h"

namespace Parvane {
namespace {

// web ColorSchemePicker.module.scss: карточка от 8.5rem, промежуток 0.625rem, отступ 0.75rem, рамка 0.125rem,
// скругление 0.75rem; образцы 1.375rem, скругление 0.3125rem, промежуток 0.25rem; подпись 0.9375rem.
constexpr auto kMinCardRem = 8.5;
constexpr auto kGapRem = 0.625;
constexpr auto kPaddingRem = 0.75;
constexpr auto kBorderRem = 0.125;
constexpr auto kRadiusRem = 0.75;
constexpr auto kSwatchRem = 1.375;
constexpr auto kSwatchRadiusRem = 0.3125;
constexpr auto kSwatchGapRem = 0.25;
constexpr auto kLabelPx = 15;

// Названия схем — имена собственные, не переводятся (как web SCHEME_NAMES)
[[nodiscard]] QString SchemeName(const QString &scheme) {
	if (scheme == u"gruvbox"_q) return u"Gruvbox"_q;
	if (scheme == u"telegram"_q) return u"Telegram"_q;
	if (scheme == u"nord"_q) return u"Nord"_q;
	if (scheme == u"catppuccin"_q) return u"Catppuccin"_q;
	if (scheme == u"solarized"_q) return u"Solarized"_q;
	return scheme;
}

class SchemeCard final : public Ui::AbstractButton {
public:
	SchemeCard(QWidget *parent, QString scheme)
	: AbstractButton(parent)
	, _scheme(std::move(scheme)) {
		setCursor(style::cur_pointer);
		setAccessibleName(SchemeName(_scheme));
		TonesChanges() | rpl::on_next([=] { update(); }, lifetime());
	}

	[[nodiscard]] const QString &scheme() const {
		return _scheme;
	}

	[[nodiscard]] static int HeightFor() {
		return Kit::Rem(kPaddingRem) * 2
			+ Kit::Rem(kSwatchRem)
			+ Kit::Rem(kGapRem)
			+ Kit::Font(kLabelPx, true)->height
			+ Kit::Rem(kBorderRem) * 2;
	}

protected:
	void paintEvent(QPaintEvent *e) override {
		auto p = QPainter(this);
		PainterHighQualityEnabler hq(p);
		const auto night = Window::Theme::IsNightMode();
		const auto swatches = SchemeSwatches(_scheme, night);
		const auto &panel = swatches[1];
		const auto &accent = swatches[2];
		const auto &text = swatches[3];
		const auto selected = (CurrentScheme() == _scheme);
		const auto border = Kit::Rem(kBorderRem);
		const auto radius = Kit::Rem(kRadiusRem);
		const auto outer = QRectF(rect()).marginsRemoved(QMarginsF(border / 2., border / 2., border / 2., border / 2.));
		p.setPen(QPen(selected
			? accent
			: (isOver() ? ToneColor(Tone::Muted) : ToneColor(Tone::Line2)), border));
		p.setBrush(panel);
		p.drawRoundedRect(outer, radius, radius);

		const auto padding = Kit::Rem(kPaddingRem) + border;
		const auto inner = rect().marginsRemoved({ padding, padding, padding, padding });
		const auto gap = Kit::Rem(kSwatchGapRem);
		const auto count = int(swatches.size());
		const auto swatchWidth = (inner.width() - gap * (count - 1)) / double(count);
		const auto swatchHeight = Kit::Rem(kSwatchRem);
		const auto swatchRadius = Kit::Rem(kSwatchRadiusRem);
		for (auto i = 0; i != count; ++i) {
			const auto r = QRectF(inner.x() + i * (swatchWidth + gap), inner.y(), swatchWidth, swatchHeight);
			p.setPen(QPen(QColor(127, 127, 127, 64), 1));
			p.setBrush(swatches[i]);
			p.drawRoundedRect(r, swatchRadius, swatchRadius);
		}

		const auto font = Kit::Font(kLabelPx, true);
		const auto labelTop = inner.y() + swatchHeight + Kit::Rem(kGapRem);
		p.setFont(font);
		p.setPen(text);
		const auto iconSize = Kit::Px(16);
		const auto labelWidth = inner.width() - (selected ? iconSize + Kit::Px(6) : 0);
		p.drawText(
			QRect(inner.x(), labelTop, labelWidth, font->height),
			font->elided(SchemeName(_scheme), labelWidth),
			style::al_left);
		if (selected) {
			PaintIcon(
				p,
				u"check"_q,
				accent,
				inner.x() + inner.width() - iconSize,
				labelTop + (font->height - iconSize) / 2,
				iconSize);
		}
	}

	void onStateChanged(State was, StateChangeSource source) override {
		update();
	}

private:
	const QString _scheme;

};

// Сетка карточек: столбцов — сколько влезет по ширине от 8.5rem (`repeat(auto-fill, minmax(8.5rem, 1fr))`)
class SchemeGrid final : public Ui::RpWidget {
public:
	explicit SchemeGrid(QWidget *parent) : RpWidget(parent) {
		for (const auto &scheme : Schemes()) {
			const auto card = Ui::CreateChild<SchemeCard>(this, scheme);
			card->setClickedCallback([=] {
				SetScheme(card->scheme());
				for (const auto other : _cards) {
					other->update();
				}
			});
			_cards.push_back(card);
		}
		TonesChanges() | rpl::on_next([=] {
			for (const auto card : _cards) {
				card->update();
			}
		}, lifetime());
	}

	int resizeGetHeight(int newWidth) override {
		const auto gap = Kit::Rem(kGapRem);
		const auto min = Kit::Rem(kMinCardRem);
		const auto columns = std::max(1, (newWidth + gap) / (min + gap));
		const auto cardWidth = (newWidth - gap * (columns - 1)) / columns;
		const auto cardHeight = SchemeCard::HeightFor();
		for (auto i = 0, count = int(_cards.size()); i != count; ++i) {
			const auto column = i % columns;
			const auto row = i / columns;
			_cards[i]->setGeometry(
				column * (cardWidth + gap),
				row * (cardHeight + gap),
				cardWidth,
				cardHeight);
		}
		const auto rows = (int(_cards.size()) + columns - 1) / columns;
		return rows ? (rows * cardHeight + (rows - 1) * gap) : 0;
	}

private:
	std::vector<SchemeCard*> _cards;

};

} // namespace

void SetupSchemePicker(not_null<Ui::VerticalLayout*> container) {
	Ui::AddSubsectionTitle(container, tr::lng_parvane_color_scheme());
	Ui::AddSkip(container, st::settingsThemesTopSkip);
	container->add(
		object_ptr<SchemeGrid>(container),
		st::settingsButtonNoIcon.padding);
	Ui::AddSkip(container);
	Ui::AddDividerText(container, tr::lng_parvane_color_scheme_hint());
}

} // namespace Parvane
