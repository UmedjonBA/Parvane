// Parvane fork: шторки раздела «Облако» (spec 029, T064) — порт web `CloudMenu`, `CloudDialogs` (название,
// выбор папки), `ConfirmDialog`, `CloudShareDialog`, `CloudLinkDialog` + `CloudLinkBlock`, `CloudPreview`,
// `CloudSendDialog`, `CloudChatDialogs`. Шторки — Kit::Sheet поверх раздела; содержимое, зависящее от данных,
// перестраивается при их смене.
#include "parvane/parvane_cloud.h"
#include "parvane/parvane_safe_open.h"
#include "parvane/parvane_cloud_internal.h"

#include "parvane/parvane_client.h"
#include "parvane/parvane_mascot.h"
#include "parvane/parvane_space.h"

#include "boxes/peer_list_box.h"
#include "boxes/peer_list_controllers.h"
#include "data/data_peer.h"
#include "data/data_thread.h"
#include "data/data_user.h"
#include "lang/lang_keys.h"
#include "mainwidget.h"
#include "ui/painter.h"
#include "ui/widgets/fields/input_field.h"
#include "ui/wrap/vertical_layout.h"
#include "window/window_session_controller.h"

#include <QtCore/QTimer>
#include <QtCore/QUrl>
#include <QtGui/QClipboard>
#include <QtGui/QDesktopServices>
#include <QtGui/QGuiApplication>
#include <QtGui/QPainterPath>

namespace Parvane::Cloud {
namespace {

using namespace Kit;
using Kind = Btn::Kind;

constexpr auto kPreviewMaxBytes = std::int64_t(256) * 1024 * 1024; // web PREVIEW_MAX_BYTES_DESKTOP
constexpr auto kPreviewTextChars = 64 * 1024; // длиннее в окне не показываем — Qt рисует текст целиком
constexpr auto kPreviewImageMaxSide = 4096; // картинка просмотра — не крупнее (разбор с уменьшением)
constexpr auto kCopiedHideMs = 2500;

Sheet *NewSheet(not_null<QWidget*> parent, const QString &title, bool wide = false, bool tight = false) {
	return Sheet::Show(parent, Sheet::Descriptor{
		.title = title,
		.closeName = tr::lng_parvane_cloud_close(tr::now),
		.wide = wide,
		.tight = tight,
	}).get();
}

Flow *Buttons(Sheet *sheet) {
	return sheet->addButtons().get();
}

// Пустая полоса фиксированной высоты (поля между блоками внутри VerticalLayout)
object_ptr<Ui::RpWidget> Space(QWidget *parent, int height) {
	auto result = object_ptr<Ui::RpWidget>(parent);
	result->resize(1, height);
	return result;
}

// Строка «значок + текст» (`.linkKeyNote`, `.linkHead`)
class IconText final : public Ui::RpWidget {
public:
	IconText(QWidget *parent, const QString &icon, const QString &text, Tone tone, int px, bool semibold)
	: RpWidget(parent)
	, _icon(icon)
	, _text(text)
	, _tone(tone)
	, _px(px)
	, _semibold(semibold) {
		RepaintOnTones(this);
	}

protected:
	int resizeGetHeight(int newWidth) override {
		const auto font = Font(_px, _semibold);
		const auto left = Rem(1.125) + Rem(0.5);
		auto string = Ui::Text::String(st::defaultTextStyle, _text);
		const auto lines = std::max(1, (font->width(_text) + std::max(newWidth - left, 1) - 1) / std::max(newWidth - left, 1));
		return std::max(Rem(1.125), lines * font->height + Px(4));
	}
	void paintEvent(QPaintEvent *e) override {
		auto p = QPainter(this);
		const auto font = Font(_px, _semibold);
		const auto icon = Rem(1.125);
		const auto color = ToneColor(_tone);
		PaintCloudIcon(p, _icon, color, 0, std::max((font->height - icon) / 2, 0), icon);
		p.setFont(font->f);
		p.setPen(color);
		const auto left = icon + Rem(0.5);
		p.drawText(QRect(left, 0, width() - left, height()), Qt::TextWordWrap | Qt::AlignLeft | Qt::AlignTop, _text);
	}

private:
	QString _icon;
	QString _text;
	Tone _tone;
	int _px = 13;
	bool _semibold = false;

};

// Поле с адресом ссылки (`.linkUrl`): моноширинный 0.75rem в рамке на `--pv-bg`, обрезка многоточием
class UrlBox final : public Ui::RpWidget {
public:
	UrlBox(QWidget *parent, const QString &url) : RpWidget(parent), _url(url) {
		RepaintOnTones(this);
		resize(width(), Rem(2.25));
	}

protected:
	int resizeGetHeight(int newWidth) override {
		return Rem(2.25);
	}
	void paintEvent(QPaintEvent *e) override {
		auto p = QPainter(this);
		PainterHighQualityEnabler hq(p);
		auto pen = QPen(ToneColor(Tone::Line2));
		pen.setWidthF(Px(1));
		p.setPen(pen);
		p.setBrush(ToneColor(Tone::Bg));
		const auto r = QRectF(rect()).adjusted(0.5, 0.5, -0.5, -0.5);
		p.drawRoundedRect(r, Rem(0.5), Rem(0.5));
		const auto font = Font(12, false, true);
		p.setFont(font->f);
		p.setPen(ToneColor(Tone::Fg));
		const auto pad = Rem(0.625);
		p.drawText(pad, (height() - font->height) / 2 + font->ascent, font->elided(_url, width() - 2 * pad));
	}

private:
	QString _url;

};

// Подписи срока (web TTL_KEYS)
QString TtlText(int days) {
	switch (days) {
	case 1: return tr::lng_parvane_cloud_link_ttl_day(tr::now);
	case 7: return tr::lng_parvane_cloud_link_ttl_week(tr::now);
	case 30: return tr::lng_parvane_cloud_link_ttl_month(tr::now);
	}
	return tr::lng_parvane_cloud_link_ttl_forever(tr::now);
}

// Выбор чата штатным окном tdesktop (web `RecipientPicker`); onlyUsers — только пользователи (доступ к папке)
void ChooseRecipient(
		not_null<Window::SessionController*> controller,
		bool onlyUsers,
		Fn<void(not_null<::Data::Thread*>)> chosen) {
	const auto weak = std::make_shared<base::weak_qptr<Ui::BoxContent>>();
	auto callback = [=](not_null<::Data::Thread*> thread) {
		if (const auto strong = weak->get()) {
			strong->closeBox();
		}
		chosen(thread);
	};
	auto filter = [=](not_null<::Data::Thread*> thread) {
		const auto peer = thread->peer();
		return !onlyUsers || (peer->isUser() && !peer->isSelf());
	};
	*weak = controller->show(Box<PeerListBox>(
		std::make_unique<ChooseRecipientBoxController>(ChooseRecipientArgs{
			.session = &controller->session(),
			.callback = std::move(callback),
			.filter = std::move(filter),
		}),
		[](not_null<PeerListBox*> box) {
			box->addButton(tr::lng_cancel(), [=] {
				box->closeBox();
			});
		}));
}

} // namespace

// ── меню ─────────────────────────────────────────────────────────────────────

void ShowMenuSheet(not_null<QWidget*> parent, const QString &title, std::vector<MenuAction> actions, Fn<void(QString)> pick) {
	const auto sheet = NewSheet(parent, title, false, true);
	for (const auto &action : actions) {
		const auto row = sheet->add(object_ptr<ListRow>(sheet->content(), ListRow::Descriptor{
			.tile = Tile{
				.icon = action.icon,
				.color = ToneColor(action.danger ? Tone::Red : Tone::Fg),
				.size = AvatarSize::Medium,
			},
			.title = action.title,
			.danger = action.danger,
			.compact = true,
		}));
		const auto key = action.key;
		row->setCallbacks([=] {
			sheet->requestClose();
			pick(key);
		});
	}
}

// ── название ─────────────────────────────────────────────────────────────────

void ShowNameSheet(
		not_null<QWidget*> parent,
		const QString &title,
		const QString &label,
		const QString &confirm,
		const QString &initial,
		Fn<void(QString)> submit) {
	const auto sheet = NewSheet(parent, title);
	const auto row = sheet->add(object_ptr<HRow>(sheet->content(), Rem(0.5)));
	const auto field = row->add(object_ptr<Field>(row, Field::Kind::Input, rpl::single(label), initial), true);
	const auto button = row->add(object_ptr<Btn>(row, confirm, Kind::Accent));
	const auto error = sheet->add(object_ptr<Label>(sheet->content(), QString(), Label::Error()));
	error->hide();
	const auto send = [=] {
		const auto value = field->text().trimmed();
		const auto problem = cloud::validateName(S(value));
		if (problem) {
			error->setText(NameErrorText(problem));
			error->show();
			field->setError(true);
			return;
		}
		sheet->requestClose();
		submit(value);
	};
	button->setClickedCallback(send);
	field->submits() | rpl::on_next(send, field->lifetime());
	field->cancels() | rpl::on_next([=] { sheet->requestClose(); }, field->lifetime());
	field->setFocusFast();
}

// ── подтверждение ────────────────────────────────────────────────────────────

void ShowConfirmSheet(
		not_null<QWidget*> parent,
		const QString &title,
		const QString &text,
		const QString &confirm,
		bool destructive,
		Fn<void()> confirmed) {
	const auto sheet = NewSheet(parent, title);
	auto st = Label::Style();
	st.multiline = true;
	sheet->add(object_ptr<Label>(sheet->content(), text, st));
	const auto buttons = Buttons(sheet);
	buttons->add(object_ptr<Btn>(buttons, confirm, destructive ? Kind::Danger : Kind::Accent))->setClickedCallback([=] {
		sheet->requestClose();
		confirmed();
	});
	buttons->add(object_ptr<Btn>(buttons, tr::lng_parvane_cloud_cancel(tr::now), Kind::Ghost))->setClickedCallback([=] {
		sheet->requestClose();
	});
}

// ── выбор папки ──────────────────────────────────────────────────────────────

void ShowFolderSheet(not_null<QWidget*> parent, FolderSheetArgs args) {
	struct Row {
		QString key;
		std::optional<std::string> place;
		std::optional<std::string> folder;
		QString name;
		int depth = 0;
		QString icon;
		Tone tone = Tone::Fg;
		bool current = false;
		bool disabled = false;
	};
	const auto hasPlaces = args.places.size() > 1;
	const auto isMoving = !args.movedIds.empty();
	const auto rowKey = [](const std::optional<std::string> &place, const std::optional<std::string> &folder) {
		return Q(place.value_or(std::string())) + '/' + Q(folder.value_or(std::string()));
	};
	auto rows = std::vector<Row>();
	auto sources = std::vector<MovePlace>();
	if (hasPlaces) {
		sources = args.places;
	} else {
		sources.push_back(MovePlace{ {}, args.rootName, false, args.nodes });
	}
	const auto nameSort = cloud::Sort{ cloud::SortKey::Name, false };
	for (const auto &source : sources) {
		const auto sourceId = source.id.empty() ? std::optional<std::string>() : std::optional(source.id);
		// В чужом для переносимого дереве запретных папок нет
		const auto movedIds = (!hasPlaces || sourceId == args.sourcePlace) ? args.movedIds : std::vector<std::string>();
		const CloudNode *first = nullptr;
		if (!movedIds.empty()) {
			for (const auto &n : source.nodes) {
				if (n.id == movedIds[0]) {
					first = &n;
				}
			}
		}
		const auto current = first && first->parent && !first->parent->empty()
			? first->parent
			: std::optional<std::string>();
		const auto isHome = (first != nullptr);
		rows.push_back(Row{
			rowKey(sourceId, std::nullopt),
			sourceId,
			std::nullopt,
			source.name,
			0,
			source.shared ? u"users"_q : u"cloud"_q,
			source.shared ? Tone::Purple : Tone::Fg,
			isHome && !current,
			isHome && !current,
		});
		const auto walk = [&](auto &&self, const std::optional<std::string> &parent, int depth) -> void {
			auto folders = std::vector<CloudNode>();
			for (const auto &n : cloud::childrenOf(source.nodes, parent)) {
				if (n.isFolder()) {
					folders.push_back(n);
				}
			}
			for (const auto &node : cloud::sortNodes(folders, nameSort)) {
				const auto isMoved = std::find(movedIds.begin(), movedIds.end(), node.id) != movedIds.end();
				const auto isCurrent = isHome && current == node.id;
				rows.push_back(Row{
					rowKey(sourceId, node.id),
					sourceId,
					node.id,
					Q(node.name),
					depth,
					u"folder"_q,
					Tone::Blue,
					isCurrent,
					isMoved || isCurrent || !cloud::canMoveInto(source.nodes, movedIds, node.id),
				});
				// Содержимое переносимой папки целью быть не может — его и не показываем
				if (!isMoved) {
					self(self, node.id, depth + 1);
				}
			}
		};
		walk(walk, std::nullopt, 1);
	}

	const auto sheet = NewSheet(
		parent,
		args.title.isEmpty() ? tr::lng_parvane_cloud_move_title(tr::now) : args.title);
	const auto picked = std::make_shared<std::optional<QString>>();
	// Перенос: место выбирает человек. Сохранение: сразу стоит открытая папка
	if (!isMoving) {
		*picked = rowKey(hasPlaces ? args.sourcePlace : std::nullopt, args.startFolder);
	}
	const auto widgets = std::make_shared<std::vector<std::pair<ListRow*, Row>>>();
	const auto describe = [=](const Row &row) {
		const auto isPicked = (*picked == row.key) && !row.disabled;
		return ListRow::Descriptor{
			.tile = Tile{ .icon = row.icon, .color = ToneColor(row.tone), .size = AvatarSize::Small },
			.title = row.name,
			.selected = (*picked == row.key),
			.indent = row.depth * Rem(1.125),
			.note = row.current ? tr::lng_parvane_cloud_here(tr::now) : QString(),
			.checkMark = isPicked,
			.compact = true,
		};
	};
	const auto buttons = std::make_shared<Btn*>(nullptr);
	const auto target = [=]() -> const Row * {
		for (const auto &[widget, row] : *widgets) {
			if (*picked == row.key && !row.disabled) {
				return &row;
			}
		}
		return nullptr;
	};
	const auto refresh = [=] {
		for (const auto &[widget, row] : *widgets) {
			widget->setDescriptor(describe(row));
		}
		if (*buttons) {
			(*buttons)->setDisabled(!target());
		}
	};
	for (const auto &row : rows) {
		const auto widget = sheet->add(object_ptr<ListRow>(sheet->content(), describe(row)));
		widget->setDisabled(row.disabled);
		const auto key = row.key;
		widget->setCallbacks([=] {
			*picked = key;
			refresh();
		});
		widgets->push_back({ widget, row });
	}
	const auto flow = Buttons(sheet);
	const auto submit = args.submit;
	*buttons = flow->add(object_ptr<Btn>(
		flow,
		args.confirm.isEmpty() ? tr::lng_parvane_cloud_move_here(tr::now) : args.confirm,
		Kind::Accent));
	(*buttons)->setClickedCallback([=] {
		const auto row = target();
		if (!row) {
			return;
		}
		const auto folder = row->folder;
		const auto place = hasPlaces ? row->place : std::nullopt;
		sheet->requestClose();
		submit(folder, place);
	});
	flow->add(object_ptr<Btn>(flow, tr::lng_parvane_cloud_cancel(tr::now), Kind::Ghost))->setClickedCallback([=] {
		sheet->requestClose();
	});
	refresh();
}

// ── ссылка (`CloudLinkBlock`) ────────────────────────────────────────────────

object_ptr<Ui::RpWidget> MakeLinkBlock(
		QWidget *parent,
		not_null<QWidget*> sheetParent,
		std::optional<LinkSource> source,
		std::optional<QString> linkId,
		bool hasHeading,
		Fn<void()> revoked) {
	auto result = object_ptr<Ui::VerticalLayout>(parent);
	const auto layout = result.data();
	struct Local {
		int ttl = cloud::kLinkDefaultTtlDays;
		bool extending = false;
		bool busy = false;
		bool copied = false;
		QString shownId;
		int copiedSeq = 0;
	};
	const auto local = std::make_shared<Local>();
	const auto rebuild = std::make_shared<Fn<void()>>();
	*rebuild = [=] {
		Kit::ClearLayout(layout);
		const auto gap = Rem(0.75);
		auto first = true;
		const auto add = [&](object_ptr<Ui::RpWidget> w) {
			const auto raw = layout->add(std::move(w), style::margins(0, first ? 0 : gap, 0, 0));
			first = false;
			return raw;
		};
		auto link = std::optional<json>();
		if (linkId) {
			if (const auto &links = Links(); links && links->is_array()) {
				for (const auto &l : *links) {
					if (Q(l.value("id", std::string())) == *linkId) {
						link = l;
					}
				}
			}
		} else if (source) {
			link = LinkOfSource(source->container, source->node.value_or(std::string()));
		}
		const auto id = link ? Q(link->value("id", std::string())) : QString();
		if (id != local->shownId) {
			local->shownId = id;
			local->extending = false;
			local->copied = false;
		}
		const auto &progress = CurrentLinkProgress();
		const auto preparingHere = progress && source && !link
			&& progress->container == source->container
			&& progress->node == source->node.value_or(std::string());
		if (hasHeading) {
			add(object_ptr<IconText>(layout, u"link"_q, tr::lng_parvane_cloud_link_heading(tr::now), Tone::Blue, kBodyPx, true));
		}
		const auto small = Label::Small();
		auto smallWrap = small;
		smallWrap.multiline = true;
		const auto ttlChips = [&](std::optional<int> selected) {
			auto flow = object_ptr<Flow>(layout);
			for (const auto days : cloud::kLinkTtlDays) {
				const auto chip = flow->add(object_ptr<Chip>(flow.data(), Chip::Descriptor{ .text = TtlText(days) }));
				chip->setOn(selected == days);
				chip->setDisabled(local->busy);
				chip->setClickedCallback([=] {
					if (!link || !local->extending) {
						local->ttl = days;
						(*rebuild)();
						return;
					}
					local->busy = true;
					(*rebuild)();
					ExtendLink(id, days, [=](bool) {
						local->busy = false;
						local->extending = false;
						(*rebuild)();
					});
				});
			}
			return flow;
		};
		if (!link && !preparingHere) {
			add(Text(layout, tr::lng_parvane_cloud_link_note(tr::now), smallWrap));
			add(Text(layout, tr::lng_parvane_cloud_link_ttl(tr::now), small));
			add(ttlChips(local->ttl));
			auto flow = object_ptr<Flow>(layout, Rem(0.5));
			const auto create = flow->add(object_ptr<Btn>(flow.data(), tr::lng_parvane_cloud_link_create(tr::now), Kind::Accent, u"link"_q));
			create->setDisabled(!source || progress.has_value());
			create->setClickedCallback([=] {
				if (source) {
					CreateLink(source->container, source->node, source->name, local->ttl);
				}
			});
			add(std::move(flow));
		}
		if (preparingHere) {
			auto row = object_ptr<HRow>(layout, Rem(0.5));
			const auto text = progress->total
				? tr::lng_parvane_cloud_link_preparing(
					tr::now,
					lt_done,
					QString::number(progress->done),
					lt_total,
					QString::number(progress->total))
				: tr::lng_parvane_cloud_link_preparing_start(tr::now);
			auto st = Label::Style();
			st.px = 14;
			row->add(object_ptr<Label>(row.data(), text, st), true);
			row->add(object_ptr<Btn>(row.data(), tr::lng_parvane_cloud_cancel(tr::now), Kind::Ghost))->setClickedCallback([] {
				CancelLinkCreate();
			});
			add(std::move(row));
		}
		const auto confirmRevoke = [=] {
			ShowConfirmSheet(
				sheetParent,
				tr::lng_parvane_cloud_link_revoke(tr::now),
				tr::lng_parvane_cloud_link_revoke_confirm(tr::now),
				tr::lng_parvane_cloud_link_revoke(tr::now),
				true,
				[=] {
					local->busy = true;
					(*rebuild)();
					RevokeLink(id, [=](bool ok) {
						local->busy = false;
						if (ok && revoked) {
							revoked();
						}
					});
				});
		};
		const auto state = link ? Q(link->value("state", std::string())) : QString();
		if (link && state == u"preparing"_q) {
			add(Text(layout, tr::lng_parvane_cloud_link_unfinished_note(tr::now), smallWrap));
			auto flow = object_ptr<Flow>(layout, Rem(0.5));
			const auto del = flow->add(object_ptr<Btn>(flow.data(), tr::lng_parvane_cloud_delete(tr::now), Kind::Danger));
			del->setDisabled(local->busy);
			del->setClickedCallback(confirmRevoke);
			add(std::move(flow));
		}
		if (link && state != u"preparing"_q) {
			const auto url = Q(link->value("url", std::string()));
			if (!url.isEmpty()) {
				auto row = object_ptr<HRow>(layout, Rem(0.5));
				row->add(object_ptr<UrlBox>(row.data(), url), true);
				const auto copy = row->add(object_ptr<Btn>(
					row.data(),
					local->copied ? tr::lng_parvane_cloud_link_copied(tr::now) : tr::lng_parvane_cloud_link_copy(tr::now),
					Kind::Accent,
					local->copied ? u"check"_q : u"copy"_q));
				copy->setClickedCallback([=] {
					QGuiApplication::clipboard()->setText(url);
					local->copied = true;
					const auto seq = ++local->copiedSeq;
					(*rebuild)();
					QTimer::singleShot(kCopiedHideMs, layout, [=] {
						if (local->copiedSeq == seq) {
							local->copied = false;
							(*rebuild)();
						}
					});
				});
				add(std::move(row));
			} else {
				add(Text(layout, tr::lng_parvane_cloud_link_no_name(tr::now), smallWrap));
			}
			const auto expires = link->value("expiresAt", std::int64_t(0));
			const auto bytes = link->value("bytes", std::int64_t(0));
			auto term = (state == u"expired"_q)
				? tr::lng_parvane_cloud_link_expired(tr::now, lt_date, LongDate(expires))
				: expires
				? tr::lng_parvane_cloud_link_until(tr::now, lt_date, LongDate(expires))
				: tr::lng_parvane_cloud_link_forever(tr::now);
			if (bytes > 0) {
				term += u" · "_q + FormatSize(bytes);
			}
			auto row = object_ptr<HRow>(layout, Rem(0.5));
			auto termSt = Label::Style();
			termSt.px = 14;
			termSt.tone = (state == u"expired"_q) ? Tone::Red : Tone::Fg;
			row->add(object_ptr<Label>(row.data(), term, termSt), true);
			const auto extend = row->add(object_ptr<Btn>(
				row.data(),
				tr::lng_parvane_cloud_link_extend(tr::now),
				(state == u"expired"_q) ? Kind::Accent : Kind::Ghost));
			extend->setDisabled(local->busy);
			extend->setClickedCallback([=] {
				local->extending = !local->extending;
				(*rebuild)();
			});
			add(std::move(row));
			if (local->extending) {
				add(Text(layout, tr::lng_parvane_cloud_link_extend_hint(tr::now), small));
				add(ttlChips(std::nullopt));
			}
			add(object_ptr<IconText>(layout, u"lock"_q, tr::lng_parvane_cloud_link_key_note(tr::now), Tone::Muted, 13, false));
			auto flow = object_ptr<Flow>(layout, Rem(0.5));
			if (!url.isEmpty() && state == u"active"_q) {
				flow->add(object_ptr<Btn>(flow.data(), tr::lng_parvane_cloud_link_preview(tr::now), Kind::Normal, u"eye"_q))->setClickedCallback([=] {
					// Адрес ссылки собран из ответа сервера: только http(s), браузером системы
					OpenExternalLink(url, url);
				});
			}
			const auto revoke = flow->add(object_ptr<Btn>(flow.data(), tr::lng_parvane_cloud_link_revoke(tr::now), Kind::Danger));
			revoke->setDisabled(local->busy);
			revoke->setClickedCallback(confirmRevoke);
			add(std::move(flow));
		}
		layout->resizeToWidth(layout->width());
	};
	StoreChanges() | rpl::on_next([=] {
		(*rebuild)();
	}, layout->lifetime());
	layout->widthValue() | rpl::filter([](int w) { return w > 0; }) | rpl::take(1) | rpl::on_next([=] {
		(*rebuild)();
	}, layout->lifetime());
	(*rebuild)();
	return result;
}

void ShowLinkSheet(not_null<QWidget*> parent, std::optional<LinkSource> source, std::optional<QString> linkId) {
	auto name = source ? source->name : QString();
	if (name.isEmpty() && linkId) {
		if (const auto &links = Links(); links && links->is_array()) {
			for (const auto &l : *links) {
				if (Q(l.value("id", std::string())) == *linkId) {
					name = Q(l.value("name", std::string()));
				}
			}
		}
	}
	const auto sheet = NewSheet(
		parent,
		name.isEmpty()
			? tr::lng_parvane_cloud_link_heading(tr::now)
			: tr::lng_parvane_cloud_link_title(tr::now, lt_name, name));
	const auto weak = QPointer<Sheet>(sheet);
	sheet->add(MakeLinkBlock(sheet->content(), parent, source, linkId, false, source ? Fn<void()>() : Fn<void()>([=] {
		if (weak) {
			weak->requestClose();
		}
	})));
}

// ── доступ к совместной папке (`CloudShareDialog`) ───────────────────────────

void ShowShareSheet(
		not_null<QWidget*> parent,
		not_null<Window::SessionController*> controller,
		std::optional<std::string> containerId) {
	const auto sheet = NewSheet(parent, QString());
	struct Local {
		std::optional<std::string> created;
		std::string newRole = "reader";
		bool busy = false;
		bool tried = false;
		QString name;
	};
	const auto local = std::make_shared<Local>();
	const auto content = sheet->content();
	const auto weak = QPointer<Sheet>(sheet);
	// Папки больше нет в списке — подняться из неё
	const auto leavePlace = [=](const std::string &id) {
		const auto place = CurrentPlace();
		if (place.container == id) {
			SetPlace(place.view.isEmpty() ? Place() : Place{ place.view, {}, {} });
		}
	};
	const auto rebuild = std::make_shared<Fn<void()>>();
	const auto run = [=](const std::string &method, json args, Fn<void(bool, json)> done = nullptr) {
		local->busy = true;
		(*rebuild)();
		CallShared(method, std::move(args), [=](bool ok, json result) {
			local->busy = false;
			if (done) {
				done(ok, result);
			}
			if (weak) {
				(*rebuild)();
			}
		});
	};
	*rebuild = [=] {
		if (!weak) {
			return;
		}
		Kit::ClearLayout(content);
		const auto id = containerId ? containerId : local->created;
		const auto container = id ? ContainerOf(*id) : nullptr;
		const auto isOwner = container && container->role == "owner";
		const auto folderName = ContainerName(container);
		sheet->setTitle(container
			? tr::lng_parvane_cloud_share_title(tr::now, lt_name, folderName)
			: tr::lng_parvane_cloud_new_shared(tr::now));
		auto small = Label::Small();
		small.multiline = true;
		if (!container && !id) {
			const auto row = sheet->add(object_ptr<HRow>(content, Rem(0.5)));
			const auto field = row->add(object_ptr<Field>(
				row,
				Field::Kind::Input,
				rpl::single(tr::lng_parvane_cloud_folder_name(tr::now)),
				local->name), true);
			const auto create = row->add(object_ptr<Btn>(row, tr::lng_parvane_cloud_create(tr::now), Kind::Accent));
			create->setDisabled(local->busy);
			const auto problem = local->tried ? cloud::validateName(S(local->name.trimmed())) : std::nullopt;
			if (problem) {
				sheet->add(object_ptr<Label>(content, NameErrorText(problem), Label::Error()));
				field->setError(true);
			}
			sheet->add(object_ptr<Label>(content, tr::lng_parvane_cloud_share_note(tr::now), small));
			const auto submit = [=] {
				local->name = field->text().trimmed();
				local->tried = true;
				if (cloud::validateName(S(local->name))) {
					(*rebuild)();
					return;
				}
				run("parvaneCloudCreateShared", json{ { "name", S(local->name) } }, [=](bool ok, json result) {
					if (ok) {
						local->created = result.value("container", std::string());
					}
				});
			};
			create->setClickedCallback(submit);
			field->submits() | rpl::on_next(submit, field->lifetime());
			field->setFocusFast();
		} else if (container) {
			const auto cid = container->id;
			sheet->add(object_ptr<Label>(
				content,
				isOwner
					? tr::lng_parvane_cloud_share_note(tr::now)
					: (tr::lng_parvane_cloud_shared_by(tr::now, lt_name, NameOf(container->owner))
						+ (container->role.empty() ? QString() : (u" · "_q + RoleTitle(container->role)))),
				small));
			if (isOwner) {
				// `.shareAdd`: права нового участника, подсказка, «Добавить»
				const auto add = sheet->add(object_ptr<HRow>(content, Rem(0.5)));
				const auto roles = add->add(object_ptr<Segments>(add, std::vector<QString>{
					RoleTitle("reader"),
					RoleTitle("editor"),
				}, local->newRole == "editor" ? 1 : 0));
				roles->activated() | rpl::on_next([=](int index) {
					local->newRole = index ? "editor" : "reader";
					(*rebuild)();
				}, roles->lifetime());
				add->add(object_ptr<Label>(add, local->newRole == "editor"
					? tr::lng_parvane_cloud_role_editor_hint(tr::now)
					: tr::lng_parvane_cloud_role_reader_hint(tr::now), Label::Small()), true);
				const auto addButton = add->add(object_ptr<Btn>(add, tr::lng_parvane_cloud_share_add(tr::now), Kind::Accent));
				addButton->setDisabled(local->busy);
				addButton->setClickedCallback([=] {
					ChooseRecipient(controller, true, [=](not_null<::Data::Thread*> thread) {
						const auto user = thread->peer()->asUser();
						const auto address = user ? AddressForUser(user) : QString();
						if (address.isEmpty()) {
							ShowNotice(u"not-found"_q);
							return;
						}
						const auto role = local->newRole;
						const auto roleText = RoleTitle(role).toLower();
						run("parvaneCloudShare", json{
							{ "container", cid },
							{ "user", S(address) },
							{ "role", role },
							{ "inviteText", S(tr::lng_parvane_cloud_invite_text(tr::now, lt_name, ContainerName(ContainerOf(cid)), lt_role, roleText)) },
						});
					});
				});
				// Участники и их права
				for (const auto &m : container->members) {
					const auto name = NameOf(m.user);
					const auto row = sheet->add(object_ptr<ListRow>(content, ListRow::Descriptor{
						.tile = Tile{
							.letter = name.left(1).toUpper(),
							.color = ToneColor(Tone::Purple),
							.size = AvatarSize::Medium,
							.round = true,
						},
						.title = name,
						.plain = true,
						.compact = true,
					}));
					const auto user = m.user;
					const auto isEditor = (m.role == "editor");
					const auto role = row->addRight(object_ptr<PillBtn>(row, RoleTitle(isEditor ? "editor" : "reader"), u"down"_q, false, true));
					role->setDisabled(local->busy);
					role->setClickedCallback([=] {
						const auto next = isEditor ? "reader" : "editor";
						run("parvaneCloudShare", json{ { "container", cid }, { "user", user }, { "role", next }, { "inviteText", "" } });
					});
					const auto remove = row->addRight(object_ptr<IconBtn>(row, u"x"_q, tr::lng_parvane_cloud_remove_member(tr::now), true));
					remove->setDisabled(local->busy);
					remove->setClickedCallback([=] {
						run("parvaneCloudUnshare", json{ { "container", cid }, { "user", user } });
					});
				}
				if (container->members.empty()) {
					sheet->add(object_ptr<Label>(content, tr::lng_parvane_cloud_no_members(tr::now), Label::Muted()));
				}
			}
			// Ссылка для людей без аккаунта (spec 022): снимок всей папки, создаёт владелец либо редактор
			if (isOwner || container->role == "editor") {
				sheet->add(MakeLinkBlock(content, parent, LinkSource{ cid, std::nullopt, folderName }, std::nullopt, true, nullptr));
			}
			const auto buttons = Buttons(sheet);
			const auto confirm = [=](QString title, QString text, QString label, bool destructive, Fn<void()> done) {
				ShowConfirmSheet(parent, title, text, label, destructive, done);
			};
			if (isOwner) {
				const auto priv = buttons->add(object_ptr<Btn>(buttons, tr::lng_parvane_cloud_make_private(tr::now), Kind::Normal));
				priv->setDisabled(local->busy);
				priv->setClickedCallback([=] {
					confirm(
						tr::lng_parvane_cloud_make_private(tr::now),
						tr::lng_parvane_cloud_make_private_confirm(tr::now),
						tr::lng_parvane_cloud_make_private(tr::now),
						false,
						[=] {
							leavePlace(cid);
							if (weak) {
								weak->requestClose();
							}
							UnshareFolder(cid);
						});
				});
				const auto stop = buttons->add(object_ptr<Btn>(buttons, tr::lng_parvane_cloud_stop_sharing(tr::now), Kind::Danger));
				stop->setDisabled(local->busy);
				stop->setClickedCallback([=] {
					confirm(
						tr::lng_parvane_cloud_stop_sharing(tr::now),
						tr::lng_parvane_cloud_stop_sharing_confirm(tr::now),
						tr::lng_parvane_cloud_delete(tr::now),
						true,
						[=] {
							run("parvaneCloudRemoveShared", json{ { "container", cid } }, [=](bool ok, json) {
								if (ok) {
									leavePlace(cid);
									RefreshUsage();
									if (weak) {
										weak->requestClose();
									}
								}
							});
						});
				});
			} else {
				const auto leave = buttons->add(object_ptr<Btn>(buttons, tr::lng_parvane_cloud_leave(tr::now), Kind::Danger));
				leave->setDisabled(local->busy);
				leave->setClickedCallback([=] {
					confirm(
						tr::lng_parvane_cloud_leave(tr::now),
						tr::lng_parvane_cloud_leave_confirm(tr::now),
						tr::lng_parvane_cloud_leave(tr::now),
						true,
						[=] {
							run("parvaneCloudLeave", json{ { "container", cid } }, [=](bool ok, json) {
								if (ok) {
									leavePlace(cid);
									if (weak) {
										weak->requestClose();
									}
								}
							});
						});
				});
			}
		} else {
			sheet->add(object_ptr<Label>(content, tr::lng_parvane_cloud_invite_gone(tr::now), Label::Muted()));
		}
	};
	DataChanges() | rpl::on_next([=] {
		(*rebuild)();
	}, sheet->lifetime());
	(*rebuild)();
}

// ── просмотр (`CloudPreview`) ────────────────────────────────────────────────

namespace {

// Место просмотра `.previewArt`: заглушка с типом файла, «загрузка», картинка либо текст
class PreviewArt final : public Ui::RpWidget {
public:
	explicit PreviewArt(QWidget *parent)
	: RpWidget(parent)
	, _loading(Ui::CreateChild<Mascot>(this)) {
		RepaintOnTones(this);
		// web `CloudPreview`: `<Loading />`, пока файл не скачан
		sizeValue() | rpl::on_next([=](QSize size) {
			_loading->setGeometry(QRect(QPoint(), size));
		}, lifetime());
	}

	void setStub(const QString &type, const QString &icon, const QString &text) {
		_mode = Mode::Stub;
		_type = type;
		_icon = icon;
		_text = text;
		refresh();
	}
	void setLoading() {
		_mode = Mode::Loading;
		refresh();
	}
	void setImage(QImage image) {
		_mode = Mode::Image;
		_image = std::move(image);
		refresh();
	}
	void setText(const QString &text) {
		_mode = Mode::Text;
		_text = text;
		refresh();
	}

protected:
	int resizeGetHeight(int newWidth) override {
		const auto minimal = Rem(13.75);
		if (_mode == Mode::Image && !_image.isNull()) {
			const auto ratio = _image.devicePixelRatio();
			const auto w = std::min(double(newWidth), _image.width() / ratio);
			const auto h = _image.height() / ratio * (w / std::max(_image.width() / ratio, 1.));
			return std::max(minimal, int(std::min(h, double(Rem(37.5)))));
		} else if (_mode == Mode::Text) {
			const auto font = Font(13, false, true);
			const auto lines = int(_text.count('\n')) + 1;
			return std::max(minimal, std::min(lines * int(font->height * 1.5) + 2 * Rem(0.875), Rem(37.5)));
		}
		return minimal;
	}
	void paintEvent(QPaintEvent *e) override {
		auto p = QPainter(this);
		PainterHighQualityEnabler hq(p);
		const auto r = QRectF(rect());
		auto path = QPainterPath();
		path.addRoundedRect(r, Rem(0.75), Rem(0.75));
		p.setClipPath(path);
		p.fillRect(rect(), ToneColor(Tone::Raised));
		switch (_mode) {
		case Mode::Loading: {
			// Маскот — дочерний виджет поверх фона
		} break;
		case Mode::Image: {
			const auto ratio = _image.devicePixelRatio();
			const auto size = QSizeF(_image.width() / ratio, _image.height() / ratio).scaled(QSizeF(size_()), Qt::KeepAspectRatio);
			const auto target = QRectF((width() - size.width()) / 2., (height() - size.height()) / 2., size.width(), size.height());
			p.drawImage(target, _image);
		} break;
		case Mode::Text: {
			// `.previewText`: моноширинный 0.8125rem, межстрочный 1.5, поля 0.875rem 1rem, без переноса
			const auto font = Font(13, false, true);
			p.setFont(font->f);
			p.setPen(ToneColor(Tone::Fg));
			const auto line = int(font->height * 1.5);
			auto y = Rem(0.875) + font->ascent;
			for (const auto &l : _text.split('\n')) {
				if (y - font->ascent > height()) {
					break;
				}
				p.drawText(Rem(1), y, font->elided(l, width() - 2 * Rem(1)));
				y += line;
			}
		} break;
		case Mode::Stub: {
			const auto font = Font(14);
			auto y = height() / 2 - Rem(2.5);
			if (!_type.isEmpty()) {
				// `.previewType`: тип файла крупно в рамке
				const auto big = Font(24, true, true);
				const auto w = big->width(_type) + 2 * Rem(1);
				const auto h = int(big->height * 1.2) + 2 * Rem(0.5);
				const auto box = QRectF((width() - w) / 2., y - h / 2., w, h);
				auto pen = QPen(ToneColor(Tone::Line2));
				pen.setWidthF(Px(2));
				p.setPen(pen);
				p.setBrush(Qt::NoBrush);
				p.drawRoundedRect(box, Rem(0.75), Rem(0.75));
				p.setFont(big->f);
				p.setPen(ToneColor(Tone::Fg));
				p.drawText(box, Qt::AlignCenter, _type);
				y = int(box.bottom()) + Rem(0.75);
			} else {
				const auto icon = Rem(3);
				PaintCloudIcon(p, _icon, ToneColor(Tone::Muted), (width() - icon) / 2, y - icon / 2, icon);
				y += icon / 2 + Rem(0.75);
			}
			p.setFont(font->f);
			p.setPen(ToneColor(Tone::Muted));
			const auto w = std::min(width() - 2 * Rem(1), font->width(u"0"_q) * 36);
			p.drawText(QRect((width() - w) / 2, y, w, height() - y), Qt::AlignHCenter | Qt::AlignTop | Qt::TextWordWrap, _text);
		} break;
		}
	}

private:
	enum class Mode {
		Stub,
		Loading,
		Image,
		Text,
	};
	[[nodiscard]] QSize size_() const {
		return size();
	}
	void refresh() {
		_loading->setVisible(_mode == Mode::Loading);
		resizeToWidth(width());
		update();
	}

	Mascot *_loading = nullptr;
	Mode _mode = Mode::Loading;
	QString _type;
	QString _icon;
	QString _text;
	QImage _image;

};

void FillPreview(Sheet *sheet, std::shared_ptr<PreviewArgs> args) {
	const auto content = sheet->content();
	Kit::ClearLayout(content);
	const auto &node = args->entry.node;
	const auto kind = cloud::kindOfFile(node.mime, node.name);
	const auto isText = (kind == cloud::FileKind::Text);
	// Видео, звук и PDF desktop в окне не проигрывает (в web — средствами браузера): тип файла и «Скачать»
	const auto viewable = (kind == cloud::FileKind::Photo) || isText;
	const auto tooLarge = node.size > (isText ? std::min(kPreviewMaxBytes, cloud::kTextPreviewMaxBytes) : kPreviewMaxBytes);
	const auto canPreview = viewable && !tooLarge;
	const auto typeLabel = Q(cloud::fileTypeLabel(node.name));
	sheet->setTitle(Q(node.name));

	// Соседние файлы папки: «‹ ›» (в web — в шапке шторки)
	const auto &siblings = args->siblings;
	const auto position = std::find_if(siblings.begin(), siblings.end(), [&](const Entry &e) {
		return e.node.id == node.id && e.container == args->entry.container;
	});
	if (siblings.size() > 1 && position != siblings.end()) {
		const auto index = int(position - siblings.begin());
		const auto row = sheet->add(object_ptr<HRow>(content, Rem(0.5)));
		const auto go = [=](int step) {
			const auto count = int(args->siblings.size());
			args->entry = args->siblings[(index + step + count) % count];
			FillPreview(sheet, args);
		};
		row->add(object_ptr<IconBtn>(row, u"left"_q, tr::lng_parvane_cloud_previous(tr::now)))->setClickedCallback([=] { go(-1); });
		row->add(object_ptr<Ui::RpWidget>(row), true);
		row->add(object_ptr<IconBtn>(row, u"right"_q, tr::lng_parvane_cloud_next(tr::now)))->setClickedCallback([=] { go(1); });
	}

	const auto art = sheet->add(object_ptr<PreviewArt>(content));
	const auto stubText = tooLarge
		? tr::lng_parvane_cloud_preview_too_large(tr::now)
		: (!viewable && !typeLabel.isEmpty())
		? tr::lng_parvane_cloud_preview_no_viewer(tr::now, lt_type, typeLabel)
		: tr::lng_parvane_cloud_preview_unavailable(tr::now);
	const auto stubIcon = (kind == cloud::FileKind::Photo) ? u"image"_q : u"note"_q;
	if (!canPreview) {
		art->setStub(typeLabel, stubIcon, stubText);
	} else {
		art->setLoading();
		const auto weak = QPointer<PreviewArt>(art);
		const auto id = node.id;
		// Ревью 21 окт 2026 (2.2): `node.size` называет загрузивший — потолок скачивания тот же, что у проверки выше
		const auto previewMax = isText ? std::min(kPreviewMaxBytes, cloud::kTextPreviewMaxBytes) : kPreviewMaxBytes;
		OpenBlob(args->entry, [=](std::optional<QByteArray> bytes) {
			if (!weak) {
				return;
			}
			const auto fail = [&] {
				weak->setStub(typeLabel, stubIcon, tr::lng_parvane_cloud_preview_unavailable(tr::now));
			};
			if (!bytes) {
				fail();
				return;
			}
			if (isText) {
				const auto decoded = cloud::decodeTextPreview(std::string_view(bytes->constData(), bytes->size()));
				// Расширение текстовое, а внутри двоичные данные — заглушка
				if (!decoded) {
					fail();
					return;
				}
				auto text = Q(*decoded);
				if (text.size() > kPreviewTextChars) {
					text = text.left(kPreviewTextChars) + QString::fromUtf8("\n…");
				}
				weak->setText(text);
			} else {
				auto image = DecodeImageBounded(*bytes, kPreviewImageMaxSide);
				if (image.isNull()) {
					fail();
				} else {
					weak->setImage(std::move(image));
				}
			}
		}, previewMax);
	}

	// `.previewFacts`: размер, дата, папка, доступ
	const auto fact = [&](const QString &label, const QString &value) {
		const auto row = sheet->add(object_ptr<HRow>(content, Rem(1)));
		auto muted = Label::Muted();
		muted.px = 14;
		const auto title = row->add(object_ptr<Label>(row, label, muted));
		title->resizeToWidth(Rem(7));
		auto st = Label::Style();
		st.px = 14;
		st.multiline = true;
		row->add(object_ptr<Label>(row, value, st), true);
	};
	fact(tr::lng_parvane_cloud_size(tr::now), FormatSize(node.size));
	fact(tr::lng_parvane_cloud_modified(tr::now), ShortDate(node.mtime, true));
	if (!args->folderText.isEmpty()) {
		fact(tr::lng_parvane_cloud_folder(tr::now), args->folderText);
	}
	if (!args->accessText.isEmpty()) {
		fact(tr::lng_parvane_cloud_share(tr::now), args->accessText);
	}
	const auto buttons = Buttons(sheet);
	buttons->add(object_ptr<Btn>(buttons, tr::lng_parvane_cloud_download(tr::now), Kind::Accent, u"download"_q))->setClickedCallback([=] {
		args->download(args->entry);
	});
	if (args->send) {
		buttons->add(object_ptr<Btn>(buttons, tr::lng_parvane_cloud_to_chat(tr::now), Kind::Normal, u"chat"_q))->setClickedCallback([=] {
			sheet->requestClose();
			args->send(args->entry);
		});
	}
	if (args->more) {
		buttons->add(object_ptr<Btn>(buttons, tr::lng_parvane_cloud_more(tr::now), Kind::Normal, u"dots"_q))->setClickedCallback([=] {
			sheet->requestClose();
			args->more(args->entry);
		});
	}
	sheet->add(object_ptr<Label>(content, tr::lng_parvane_cloud_decrypted_here(tr::now), Label::Small()));
}

} // namespace

void ShowPreviewSheet(not_null<QWidget*> parent, PreviewArgs args) {
	const auto sheet = NewSheet(parent, Q(args.entry.node.name), true);
	FillPreview(sheet, std::make_shared<PreviewArgs>(std::move(args)));
}

// ── в чат (`CloudSendDialog`) ────────────────────────────────────────────────

namespace {

void SendPaths(not_null<Window::SessionController*> controller, not_null<::Data::Thread*> thread, std::vector<Entry> entries) {
	const auto weakThread = base::make_weak(thread.get());
	const auto weakController = base::make_weak(controller.get());
	DownloadToTemp(entries, [=](QStringList paths, QString error) {
		const auto strongController = weakController.get();
		const auto strongThread = weakThread.get();
		if (!strongController || !strongThread) {
			return;
		}
		if (paths.isEmpty()) {
			ShowNotice(error.isEmpty() ? u"rejected"_q : error);
			return;
		}
		// Отправка — штатным окном файлов в открытом чате; раздел уступает место мессенджеру
		ShowSection(Section::Chats);
		strongController->content()->sendPaths(strongThread, paths);
	});
}

} // namespace

void SendToChat(not_null<Window::SessionController*> controller, std::vector<Entry> entries) {
	auto files = std::vector<Entry>();
	for (const auto &e : entries) {
		if (!e.node.isFolder()) {
			files.push_back(e);
		}
	}
	if (files.empty()) {
		return;
	}
	ChooseRecipient(controller, false, [=](not_null<::Data::Thread*> thread) {
		SendPaths(controller, thread, files);
	});
}

} // namespace Parvane::Cloud

// ── связь с чатами (`CloudChatDialogs`) ─────────────────────────────────────

namespace Parvane {

void ShowCloudSaveDialog(not_null<Window::SessionController*> controller, const QStringList &paths) {
	using namespace Cloud;
	if (paths.isEmpty()) {
		return;
	}
	const auto &data = Current();
	const auto root = data.rootId.value_or(std::string());
	ShowFolderSheet(controller->content(), FolderSheetArgs{
		.title = tr::lng_parvane_cloud_choose_folder(tr::now),
		.rootName = tr::lng_parvane_cloud_tab_drive(tr::now),
		.nodes = NodesOf(root),
		.confirm = tr::lng_parvane_cloud_save_here(tr::now),
		.submit = [=](std::optional<std::string> target, std::optional<std::string>) {
			UploadFiles(root.empty() ? std::string("root") : root, target, paths);
			ShowNotice(u"saved"_q);
		},
	});
}

void ShowCloudAttachDialog(not_null<Window::SessionController*> controller, not_null<::Data::Thread*> thread) {
	using namespace Cloud;
	using namespace Kit;
	const auto parent = controller->content();
	const auto sheet = Sheet::Show(parent, Sheet::Descriptor{
		.title = tr::lng_parvane_cloud_choose_files(tr::now),
		.closeName = tr::lng_parvane_cloud_close(tr::now),
	}).get();
	struct Local {
		std::optional<std::string> folder;
		std::vector<std::string> picked;
	};
	const auto local = std::make_shared<Local>();
	const auto weakThread = base::make_weak(thread.get());
	const auto list = sheet->add(object_ptr<Ui::VerticalLayout>(sheet->content()));
	const auto send = std::make_shared<Btn*>(nullptr);
	const auto rebuild = std::make_shared<Fn<void()>>();
	*rebuild = [=] {
		Kit::ClearLayout(list);
		const auto root = Current().rootId.value_or(std::string());
		const auto &nodes = NodesOf(root);
		// Путь: «Мои файлы › Папка › Вложенная»
		auto crumbs = object_ptr<Flow>(list, Rem(0.125));
		crumbs->add(object_ptr<LinkButton>(crumbs.data(), tr::lng_parvane_cloud_tab_drive(tr::now), 14))->setClickedCallback([=] {
			local->folder.reset();
			(*rebuild)();
		});
		for (const auto &n : cloud::pathOf(nodes, local->folder)) {
			crumbs->add(object_ptr<Label>(crumbs.data(), u"›"_q, Label::Faint()));
			const auto id = n.id;
			crumbs->add(object_ptr<LinkButton>(crumbs.data(), Q(n.name), 14))->setClickedCallback([=] {
				local->folder = id;
				(*rebuild)();
			});
		}
		list->add(std::move(crumbs), style::margins(0, 0, 0, Rem(0.5)));
		const auto children = cloud::sortNodes(cloud::childrenOf(cloud::listedNodes(nodes), local->folder), cloud::Sort());
		for (const auto &n : children) {
			const auto isPicked = std::find(local->picked.begin(), local->picked.end(), n.id) != local->picked.end();
			const auto row = list->add(object_ptr<ListRow>(list, ListRow::Descriptor{
				.tile = Tile{
					.icon = n.isFolder() ? u"folder"_q : isPicked ? u"check"_q : u"file"_q,
					.color = ToneColor(n.isFolder() ? Tone::Blue : isPicked ? Tone::Accent : Tone::Fg),
					.size = AvatarSize::Small,
				},
				.title = Q(n.name),
				.sub = n.isFolder() ? QString() : FormatSize(n.size),
				.selected = isPicked,
				.compact = true,
			}));
			const auto id = n.id;
			const auto folder = n.isFolder();
			row->setCallbacks([=] {
				if (folder) {
					local->folder = id;
				} else {
					auto &picked = local->picked;
					const auto it = std::find(picked.begin(), picked.end(), id);
					if (it == picked.end()) {
						picked.push_back(id);
					} else {
						picked.erase(it);
					}
				}
				(*rebuild)();
			});
		}
		if (children.empty()) {
			list->add(object_ptr<Empty>(list, nodes.empty()
				? tr::lng_parvane_cloud_empty(tr::now)
				: tr::lng_parvane_cloud_empty_folder(tr::now)));
		}
		if (*send) {
			(*send)->setDisabled(local->picked.empty());
		}
		list->resizeToWidth(list->width());
	};
	const auto buttons = sheet->addButtons();
	*send = buttons->add(object_ptr<Btn>(buttons.get(), tr::lng_parvane_cloud_send(tr::now), Btn::Kind::Accent));
	(*send)->setClickedCallback([=] {
		const auto root = Current().rootId.value_or(std::string());
		auto entries = std::vector<Entry>();
		for (const auto &id : local->picked) {
			for (const auto &n : NodesOf(root)) {
				if (n.id == id) {
					entries.push_back({ root, n });
				}
			}
		}
		const auto strongThread = weakThread.get();
		sheet->requestClose();
		if (strongThread && !entries.empty()) {
			SendPaths(controller, strongThread, entries);
		}
	});
	buttons->add(object_ptr<Btn>(buttons.get(), tr::lng_parvane_cloud_cancel(tr::now), Btn::Kind::Ghost))->setClickedCallback([=] {
		sheet->requestClose();
	});
	DataChanges() | rpl::on_next([=] {
		(*rebuild)();
	}, sheet->lifetime());
	(*rebuild)();
	Sections::CallCloud("parvaneCloudSync", json::object(), nullptr);
}

} // namespace Parvane
