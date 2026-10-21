// Parvane fork (spec 030): пункты меню вложений — см. parvane_attach_actions.h.
#include "parvane/parvane_attach_actions.h"

#include "parvane/parvane_client_internal.h"
#include "parvane/parvane_kit.h"
#include "parvane/parvane_sections_data.h"

#include "boxes/abstract_box.h"
#include "lang/lang_keys.h"
#include "settings/settings_common.h"
#include "ui/layers/generic_box.h"
#include "ui/widgets/buttons.h"
#include "ui/widgets/fields/input_field.h"
#include "ui/widgets/labels.h"
#include "ui/widgets/popup_menu.h"
#include "ui/widgets/scroll_area.h"
#include "ui/wrap/vertical_layout.h"
#include "window/window_session_controller.h"
#include "styles/style_boxes.h"
#include "styles/style_layers.h"
#include "styles/style_settings.h"

#include <parvane/sections/notes_model.h>

#include <QtCore/QRegularExpression>

namespace Parvane {

namespace {

// Пределы полей схемы (web messages.ts / parvaneSendTaskOffer)
constexpr auto kOfferNameMax = 200;
constexpr auto kOfferStepsMax = 100;
constexpr auto kOfferTextMax = 600;
constexpr auto kArticleMaxLength = 65536;
constexpr auto kArticleTitleMax = 200;
constexpr auto kArticleTextMax = 600;
constexpr auto kArticleListMax = 60;
constexpr auto kLivePeriods = std::array<int, 3>{ 15 * 60, 60 * 60, 8 * 60 * 60 };

base::unique_qptr<Ui::PopupMenu> LocationMenu;
QString LastCoordinates;

// Адрес чата, как у MirrorPollCreate: группа v2 по id чата, иначе собеседник или «Избранное»
[[nodiscard]] QString AddressForPeer(not_null<PeerData*> peer) {
	if (peer->isChat()) {
		const auto chatBare = std::uint64_t(peerToChat(peer->id).bare);
		std::lock_guard<std::mutex> lk(g_sessionMutex);
		return g_chatIdToGroupId.value(chatBare);
	} else if (peer->isUser()) {
		return peer->isSelf()
			? SelfAddress()
			: AddressForId(std::uint64_t(peerToUser(peer->id).bare));
	}
	return QString();
}

// Своё сообщение: эхо в ленту (общая инъекция), журнал истории, отправка движком v2. false — чат неизвестен
bool SendOwnContent(not_null<PeerData*> peer, const nlohmann::json &content) {
	const auto session = g_sessionWeak.get();
	const auto address = AddressForPeer(peer);
	if (!session || address.isEmpty() || !SessionActive()) {
		return false;
	}
	parvane::StoredMessage own;
	own.id = parvane::newUuidV7();
	own.from = SelfAddress().toStdString();
	own.to = address.toStdString();
	own.ts = QDateTime::currentSecsSinceEpoch();
	own.content = content;
	injectOnMain(session, { own }, /*live=*/false);
	HistoryAppend(own);
	sendInnerAsync(address, content, own.id);
	return true;
}

// «ДД.ММ.ГГГГ», «ДД.ММ» (текущий год) либо ISO → ключ дня ISO; пусто — поле не заполнено; nullopt — ошибка
[[nodiscard]] std::optional<std::string> ParseDay(const QString &value) {
	const auto text = value.trimmed();
	if (text.isEmpty()) {
		return std::string();
	}
	static const auto iso = QRegularExpression(u"^(\\d{4})-(\\d{1,2})-(\\d{1,2})$"_q);
	static const auto dotted = QRegularExpression(u"^(\\d{1,2})[.\\/](\\d{1,2})(?:[.\\/](\\d{2,4}))?$"_q);
	auto date = QDate();
	if (const auto m = iso.match(text); m.hasMatch()) {
		date = QDate(m.captured(1).toInt(), m.captured(2).toInt(), m.captured(3).toInt());
	} else if (const auto m = dotted.match(text); m.hasMatch()) {
		auto year = m.captured(3).isEmpty() ? QDate::currentDate().year() : m.captured(3).toInt();
		if (year < 100) {
			year += 2000;
		}
		date = QDate(year, m.captured(2).toInt(), m.captured(1).toInt());
	}
	if (!date.isValid()) {
		return std::nullopt;
	}
	return date.toString(u"yyyy-MM-dd"_q).toStdString();
}

// «ЧЧ:ММ» (также «Ч.ММ», «ЧЧ») → «ЧЧ:ММ»; пусто — не задано; nullopt — ошибка
[[nodiscard]] std::optional<std::string> ParseTime(const QString &value) {
	const auto text = value.trimmed();
	if (text.isEmpty()) {
		return std::string();
	}
	static const auto re = QRegularExpression(u"^(\\d{1,2})(?:[:.](\\d{2}))?$"_q);
	const auto m = re.match(text);
	if (!m.hasMatch()) {
		return std::nullopt;
	}
	const auto h = m.captured(1).toInt();
	const auto mm = m.captured(2).isEmpty() ? 0 : m.captured(2).toInt();
	if (h > 23 || mm > 59) {
		return std::nullopt;
	}
	return QString::asprintf("%02d:%02d", h, mm).toStdString();
}

// Текст для клиентов без планировщика — web `taskOfferText` (служебные тексты провайдера — по-русски)
[[nodiscard]] std::string OfferText(
		const std::string &name,
		const std::string &day,
		const std::string &start,
		int minutes,
		const std::string &due,
		bool isEvent) {
	auto parts = QStringList{ (isEvent ? u"📅 Событие: "_q : u"📋 Задание: "_q) + QString::fromStdString(name) };
	if (!day.empty()) {
		parts.push_back(QString::fromStdString(day) + (start.empty() ? QString() : u" "_q + QString::fromStdString(start)));
	}
	if (minutes > 0) {
		parts.push_back(QString::number(minutes) + u" мин"_q);
	}
	if (!due.empty()) {
		parts.push_back(u"до "_q + QString::fromStdString(due));
	}
	return parts.join(u" · "_q).left(kOfferTextMax).toStdString();
}

// Текст статьи для клиентов без окна чтения — web `articleText`
[[nodiscard]] std::string ArticleText(const QString &title, const QString &markdown) {
	auto plain = markdown;
	plain.replace(QRegularExpression(u"^---\\n[\\s\\S]*?\\n---\\n"_q), QString());
	plain.replace(QRegularExpression(u"!?\\[\\[([^\\]|]+)(?:\\|([^\\]]+))?\\]\\]"_q), u"\\1"_q);
	plain.replace(QRegularExpression(u"[#>*_`]+"_q), QString());
	plain = plain.simplified();
	return (u"Статья «"_q + title + u"»\n"_q + plain).left(kArticleTextMax).toStdString();
}

[[nodiscard]] not_null<Ui::InputField*> AddField(
		not_null<Ui::GenericBox*> box,
		tr::phrase<> placeholder,
		bool multiline = false) {
	return box->addRow(object_ptr<Ui::InputField>(
		box,
		st::defaultInputField,
		multiline ? Ui::InputField::Mode::MultiLine : Ui::InputField::Mode::SingleLine,
		placeholder()));
}

void TaskOfferBox(
		not_null<Ui::GenericBox*> box,
		not_null<Window::SessionController*> controller,
		not_null<PeerData*> peer) {
	box->setTitle(tr::lng_parvane_offer_title());
	box->setWidth(st::boxWideWidth);
	const auto name = AddField(box, tr::lng_parvane_offer_name);
	const auto description = AddField(box, tr::lng_parvane_offer_description, true);
	const auto steps = AddField(box, tr::lng_parvane_offer_steps, true);
	const auto day = AddField(box, tr::lng_parvane_offer_day);
	const auto start = AddField(box, tr::lng_parvane_offer_start);
	const auto minutes = AddField(box, tr::lng_parvane_offer_minutes);
	const auto due = AddField(box, tr::lng_parvane_offer_due);
	box->setFocusCallback([=] { name->setFocusFast(); });
	const auto submit = [=] {
		const auto title = name->getLastText().trimmed().left(kOfferNameMax).toStdString();
		if (title.empty()) {
			name->showError();
			return;
		}
		const auto dayKey = ParseDay(day->getLastText());
		if (!dayKey) {
			day->showError();
			return;
		}
		const auto startKey = ParseTime(start->getLastText());
		if (!startKey) {
			start->showError();
			return;
		}
		auto ok = true;
		const auto minutesText = minutes->getLastText().trimmed();
		const auto minutesValue = minutesText.isEmpty() ? 0 : minutesText.toInt(&ok);
		if (!ok || minutesValue < 0 || minutesValue > 24 * 60) {
			minutes->showError();
			return;
		}
		const auto dueKey = ParseDay(due->getLastText());
		if (!dueKey) {
			due->showError();
			return;
		}
		auto stepList = nlohmann::json::array();
		for (const auto &line : steps->getLastText().split('\n')) {
			const auto step = line.trimmed();
			if (!step.isEmpty() && stepList.size() < kOfferStepsMax) {
				stepList.push_back(step.toStdString());
			}
		}
		// Начало — только вместе с днём (web: вид «событие» — день и время без шагов и срока)
		const auto startValue = dayKey->empty() ? std::string() : *startKey;
		const auto isEvent = !dayKey->empty() && !startValue.empty() && stepList.empty() && dueKey->empty();
		auto content = nlohmann::json{
			{ "kind", "task_offer" },
			{ "name", title },
			{ "text", OfferText(title, *dayKey, startValue, minutesValue, *dueKey, isEvent) },
		};
		if (const auto text = description->getLastText().trimmed(); !text.isEmpty()) {
			content["description"] = text.toStdString();
		}
		if (!stepList.empty()) {
			content["steps"] = stepList;
		}
		if (!dayKey->empty()) {
			content["day"] = *dayKey;
		}
		if (!startValue.empty()) {
			content["start"] = startValue;
		}
		if (minutesValue > 0) {
			content["minutes"] = minutesValue;
		}
		if (!dueKey->empty()) {
			content["due"] = *dueKey;
		}
		const auto sent = SendOwnContent(peer, content);
		controller->uiShow()->showToast(sent
			? tr::lng_parvane_offer_sent(tr::now)
			: tr::lng_parvane_offer_send_failed(tr::now));
		if (sent) {
			box->closeBox();
		}
	};
	name->submits() | rpl::on_next([=] { submit(); }, name->lifetime());
	box->addButton(tr::lng_parvane_offer_send(), submit);
	box->addButton(tr::lng_cancel(), [=] { box->closeBox(); });
}

void ArticlePickerBox(
		not_null<Ui::GenericBox*> box,
		not_null<Window::SessionController*> controller,
		not_null<PeerData*> peer) {
	box->setTitle(tr::lng_parvane_article_pick_title());
	box->setWidth(st::boxWideWidth);
	// Пока окно открыто, заметки читаются (как палитра Ctrl+K, web `retainNotes`)
	Sections::SetPaletteOpen(true);
	box->lifetime().add([] { Sections::SetPaletteOpen(false); });
	const auto search = AddField(box, tr::lng_parvane_article_pick_search);
	box->setFocusCallback([=] { search->setFocusFast(); });
	const auto list = box->addRow(object_ptr<Ui::VerticalLayout>(box), style::margins());

	const auto send = [=](const Sections::notes::NoteRef &note) {
		if (!note || note->text.empty()) {
			controller->uiShow()->showToast(tr::lng_parvane_article_pick_loading(tr::now));
			return;
		}
		const auto parsed = parvane::sections::notes::parseNote(note->text);
		const auto markdown = QString::fromStdString(parsed.body);
		if (markdown.size() > kArticleMaxLength) {
			controller->uiShow()->showToast(tr::lng_parvane_article_too_long(tr::now));
			return;
		}
		const auto title = QString::fromStdString(note->title).trimmed().left(kArticleTitleMax);
		const auto content = nlohmann::json{
			{ "kind", "article" },
			{ "title", title.toStdString() },
			{ "markdown", markdown.toStdString() },
			{ "text", ArticleText(title, markdown) },
		};
		const auto sent = SendOwnContent(peer, content);
		controller->uiShow()->showToast(sent
			? tr::lng_parvane_article_sent(tr::now)
			: tr::lng_parvane_article_send_failed(tr::now));
		if (sent) {
			box->closeBox();
		}
	};

	const auto rebuild = [=] {
		Kit::ClearLayout(list);
		const auto view = Sections::Notes();
		const auto query = search->getLastText().trimmed().toLower();
		auto shown = 0;
		if (view) {
			for (const auto &note : view->notes) {
				if (!note || shown >= kArticleListMax) {
					continue;
				}
				const auto title = QString::fromStdString(note->title);
				if (!query.isEmpty() && !title.toLower().contains(query)) {
					continue;
				}
				++shown;
				const auto button = list->add(object_ptr<Ui::SettingsButton>(
					list,
					rpl::single(title),
					st::settingsButtonNoIcon));
				button->setClickedCallback([=] { send(note); });
			}
		}
		if (!shown) {
			const auto loading = !view || view->status == Sections::notes::NotesStatus::Loading;
			list->add(object_ptr<Ui::FlatLabel>(
				list,
				loading
					? tr::lng_parvane_article_pick_loading()
					: tr::lng_parvane_article_pick_empty(),
				st::boxDividerLabel));
		}
		list->resizeToWidth(box->width());
	};
	search->changes() | rpl::on_next(rebuild, search->lifetime());
	// Отложенно: снимок заметок приходит позже открытия окна; правка списка — вне обработчика сигнала
	Sections::NotesValue() | rpl::on_next([=](const auto &) {
		crl::on_main(box, rebuild);
	}, box->lifetime());
	rebuild();
	box->addButton(tr::lng_cancel(), [=] { box->closeBox(); });
}

// «55.75, 37.61», «55.75 37.61», ссылка карт с `lat,lon`/`ll=lon,lat`/`@lat,lon`
[[nodiscard]] std::optional<std::pair<double, double>> ParseCoordinates(const QString &value) {
	const auto text = value.trimmed();
	static const auto ll = QRegularExpression(u"[?&]ll=(-?\\d+(?:\\.\\d+)?)(?:,|%2C)(-?\\d+(?:\\.\\d+)?)"_q);
	static const auto pair = QRegularExpression(u"(-?\\d{1,3}(?:\\.\\d+)?)\\s*[,; ]\\s*(-?\\d{1,3}(?:\\.\\d+)?)"_q);
	auto lat = 0.;
	auto lon = 0.;
	if (const auto m = ll.match(text); m.hasMatch()) {
		lon = m.captured(1).toDouble(); // Яндекс: ll=долгота,широта
		lat = m.captured(2).toDouble();
	} else if (const auto m = pair.match(text); m.hasMatch()) {
		lat = m.captured(1).toDouble();
		lon = m.captured(2).toDouble();
	} else {
		return std::nullopt;
	}
	if (lat < -90. || lat > 90. || lon < -180. || lon > 180.) {
		return std::nullopt;
	}
	return std::make_pair(lat, lon);
}

void LocationBox(
		not_null<Ui::GenericBox*> box,
		not_null<Window::SessionController*> controller,
		not_null<PeerData*> peer,
		int livePeriod) {
	box->setTitle(tr::lng_parvane_location_title());
	box->addRow(object_ptr<Ui::FlatLabel>(box, tr::lng_parvane_location_about(), st::boxLabel));
	const auto field = AddField(box, tr::lng_parvane_location_field);
	if (!LastCoordinates.isEmpty()) {
		field->setText(LastCoordinates);
		field->selectAll();
	}
	box->setFocusCallback([=] { field->setFocusFast(); });
	const auto submit = [=] {
		const auto coordinates = ParseCoordinates(field->getLastText());
		if (!coordinates) {
			field->showError();
			return;
		}
		LastCoordinates = QString::number(coordinates->first, 'f', 6) + u", "_q
			+ QString::number(coordinates->second, 'f', 6);
		const auto sent = MirrorLocationIfOurs(peer, coordinates->first, coordinates->second, livePeriod);
		if (!sent) {
			controller->uiShow()->showToast(tr::lng_parvane_location_failed(tr::now));
			return;
		}
		box->closeBox();
	};
	field->submits() | rpl::on_next([=] { submit(); }, field->lifetime());
	box->addButton(tr::lng_parvane_location_send(), submit);
	box->addButton(tr::lng_cancel(), [=] { box->closeBox(); });
}

} // namespace

void ShowTaskOfferBox(not_null<Window::SessionController*> controller, not_null<PeerData*> peer) {
	controller->show(Box(TaskOfferBox, controller, peer));
}

void ShowArticlePicker(not_null<Window::SessionController*> controller, not_null<PeerData*> peer) {
	controller->show(Box(ArticlePickerBox, controller, peer));
}

void ShowLocationMenu(
		not_null<Window::SessionController*> controller,
		not_null<PeerData*> peer,
		QPoint globalPosition) {
	LocationMenu = Kit::CreateMenu(controller->widget());
	const auto open = [=](int livePeriod) {
		controller->show(Box(LocationBox, controller, peer, livePeriod));
	};
	Kit::AddMenuAction(LocationMenu.get(), tr::lng_parvane_attach_location_current(tr::now), [=] { open(0); });
	Kit::AddMenuAction(LocationMenu.get(), tr::lng_parvane_attach_location_live15(tr::now), [=] {
		open(kLivePeriods[0]);
	});
	Kit::AddMenuAction(LocationMenu.get(), tr::lng_parvane_attach_location_live60(tr::now), [=] {
		open(kLivePeriods[1]);
	});
	Kit::AddMenuAction(LocationMenu.get(), tr::lng_parvane_attach_location_live480(tr::now), [=] {
		open(kLivePeriods[2]);
	});
	LocationMenu->popup(globalPosition);
}

} // namespace Parvane
