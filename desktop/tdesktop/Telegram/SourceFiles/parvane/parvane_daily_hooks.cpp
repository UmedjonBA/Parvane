// Parvane fork: хук сценариев `PARVANE_AUTOUI` (ревью 7 ноя 2026, этап 2 «ежедневное сломано») — действия
// штатных кнопок tdesktop без мыши: тот же вход, что у кнопки (бокс «Новая группа», Calls::Instance,
// «Перейти к дате», меню отправки с «без звука» / «запланировать», раздел «Запланированные», пересылка с
// «скрыть имя»). Сценарии `desktop/verify_daily_ui.sh`, `verify_scheduled.sh`, `verify_forward_media.sh`
// проверяют маркеры журнала. Только сборка с PARVANE_DEV.
//
//   PARVANE_AUTOUI=<шаг>@<сек>[,<шаг>@<сек>…], шаг — <действие>:<аргументы через |>:
//     newgroup:<имя>|<адрес участника>   newchannel:<имя>
//     call:<адрес>                       groupcall:<имя группы>
//     jumpdate:<адрес>|<ГГГГ-ММ-ДД>      addcontact:-    mainmenu:-    reactions:-
//     silent:<адрес>|<текст>             schedtext:<адрес>|<текст>|<через сек>   schedonline:<адрес>|<текст>
//     schedfile:<адрес>|<путь>|<через сек>[|voice]   schedloc:<адрес>|<lat>|<lon>|<через сек>
//     schedlist:<адрес>   schednow:<адрес>   scheddelete:<адрес>   schedmove:<адрес>|<через сек>
//     forward:<откуда>|<куда>|<preserve|noname|nocaption>
#include "parvane/parvane_client_internal.h"

#include "boxes/add_contact_box.h"
#include "api/api_editing.h"
#include "api/api_sending.h"
#include "calls/calls_instance.h"
#include "core/application.h"
#include "data/components/scheduled_messages.h"
#include "data/data_histories.h"
#include "data/data_message_reactions.h"
#include "mainwindow.h"
#include "window/window_controller.h"
#include "window/window_session_controller.h"

namespace Parvane {
namespace {

struct UiStep {
	QString op;
	QStringList args;
	int seconds = 0;
};

[[nodiscard]] std::vector<UiStep> ParseUiSteps() {
	auto result = std::vector<UiStep>();
	const auto raw = QString::fromUtf8(ParvaneDevEnv("PARVANE_AUTOUI") ? ParvaneDevEnv("PARVANE_AUTOUI") : "");
	for (const auto &part : raw.split(',', Qt::SkipEmptyParts)) {
		const auto at = part.lastIndexOf('@');
		const auto colon = part.indexOf(':');
		if (colon <= 0 || at < colon) {
			continue;
		}
		result.push_back({
			.op = part.left(colon),
			.args = part.mid(colon + 1, at - colon - 1).split('|'),
			.seconds = part.mid(at + 1).toInt(),
		});
	}
	return result;
}

[[nodiscard]] Window::SessionController *Controller() {
	const auto window = Core::App().activePrimaryWindow();
	return window ? window->sessionController() : nullptr;
}

[[nodiscard]] History *HistoryOf(not_null<Main::Session*> session, const QString &address) {
	if (address.isEmpty()) {
		return nullptr;
	}
	if (g_knownGroups.contains(address)) {
		return session->data().history(peerFromChat(ChatId(BareId(IdForAddress(address)))));
	}
	for (auto i = g_knownGroups.constBegin(); i != g_knownGroups.constEnd(); ++i) {
		if (i.value() == address) { // по имени группы
			return session->data().history(peerFromChat(ChatId(BareId(IdForAddress(i.key())))));
		}
	}
	if (address == SelfAddress()) {
		return session->data().history(session->user());
	}
	return session->data().history(EnsureUser(session, address));
}

[[nodiscard]] std::vector<not_null<HistoryItem*>> ScheduledOf(not_null<History*> history) {
	auto result = std::vector<not_null<HistoryItem*>>();
	const auto &scheduled = history->session().scheduledMessages();
	for (const auto &id : scheduled.list(history).ids) {
		if (const auto item = scheduled.lookupItem(id)) {
			result.push_back(item);
		}
	}
	return result;
}

void RunUiStep(const UiStep &step) {
	const auto session = g_sessionWeak.get();
	const auto controller = Controller();
	if (!session || !controller) {
		LOG(("Parvane: autoui %1 — нет сессии или окна").arg(step.op));
		return;
	}
	const auto arg = [&](int i) { return step.args.value(i); };
	LOG(("Parvane: autoui %1 %2").arg(step.op, step.args.join('|')));
	if (step.op == u"newgroup"_q || step.op == u"newchannel"_q) {
		const auto channel = (step.op == u"newchannel"_q);
		auto box = Box<GroupInfoBox>(
			controller,
			channel ? GroupInfoBox::Type::Channel : GroupInfoBox::Type::Group);
		const auto raw = box.data();
		controller->show(std::move(box));
		auto users = std::vector<not_null<PeerData*>>();
		if (!arg(1).isEmpty()) {
			users.push_back(EnsureUser(session, arg(1)));
		}
		const auto weak = base::make_weak(raw);
		const auto title = arg(0);
		crl::on_main([=] {
			if (const auto strong = weak.get()) {
				strong->submitForTest(title, users);
			}
		});
	} else if (step.op == u"call"_q) {
		Core::App().calls().startOutgoingCall(EnsureUser(session, arg(0)), {});
	} else if (step.op == u"groupcall"_q) {
		if (const auto history = HistoryOf(session, arg(0))) {
			Core::App().calls().startOrJoinGroupCall(controller->uiShow(), history->peer, {});
		}
	} else if (step.op == u"jumpdate"_q) {
		const auto history = HistoryOf(session, arg(0));
		const auto date = QDate::fromString(arg(1), Qt::ISODate);
		if (history && date.isValid()) {
			session->api().resolveJumpToDate(Dialogs::Key(history), date, [=](
					not_null<PeerData*> peer,
					MsgId id) {
				const auto item = session->data().message(peer->id, id);
				LOG(("Parvane: autoui jumpdate → msg %1 (%2)")
					.arg(id.bare)
					.arg(item ? item->originalText().text : u"-"_q));
			});
		}
	} else if (step.op == u"addcontact"_q) {
		controller->showAddContact();
	} else if (step.op == u"mainmenu"_q) {
		controller->widget()->showMainMenu();
	} else if (step.op == u"reactions"_q) {
		const auto &reactions = session->data().reactions();
		const auto &list = reactions.list(Data::Reactions::Type::Active);
		auto names = QStringList();
		for (const auto &reaction : list) {
			names.push_back(reaction.id.emoji());
		}
		LOG(("Parvane: autoui реакции: %1 [%2] быстрая=%3")
			.arg(list.size())
			.arg(names.join(' '))
			.arg(reactions.favoriteId().emoji()));
	} else if (step.op == u"silent"_q || step.op == u"schedtext"_q || step.op == u"schedonline"_q) {
		const auto history = HistoryOf(session, arg(0));
		if (!history) {
			return;
		}
		auto action = Api::SendAction(history);
		if (step.op == u"silent"_q) {
			action.options.silent = true;
		} else if (step.op == u"schedonline"_q) {
			action.options.scheduled = Api::kScheduledUntilOnlineTimestamp;
		} else {
			action.options.scheduled = base::unixtime::now() + std::max(arg(2).toInt(), 1);
		}
		auto message = Api::MessageToSend(action);
		message.textWithTags = TextWithTags{ arg(1) };
		session->api().sendMessage(std::move(message));
	} else if (step.op == u"schedfile"_q) {
		const auto history = HistoryOf(session, arg(0));
		auto file = QFile(arg(1));
		if (!history || !file.open(QIODevice::ReadOnly)) {
			return;
		}
		auto action = Api::SendAction(history);
		action.options.scheduled = base::unixtime::now() + std::max(arg(2).toInt(), 1);
		const auto bytes = file.readAll();
		if (arg(3) == u"voice"_q) {
			auto waveform = VoiceWaveform();
			for (auto i = 0; i != 32; ++i) {
				waveform.push_back(char(i % 31));
			}
			session->api().sendVoiceMessage(bytes, waveform, crl::time(2000), false, action);
		} else {
			const auto lower = arg(1).toLower();
			const auto photo = lower.endsWith(u".png"_q) || lower.endsWith(u".jpg"_q);
			session->api().sendFile(bytes, photo ? SendMediaType::Photo : SendMediaType::File, action);
		}
	} else if (step.op == u"schedloc"_q) {
		if (const auto history = HistoryOf(session, arg(0))) {
			auto action = Api::SendAction(history);
			action.options.scheduled = base::unixtime::now() + std::max(arg(3).toInt(), 1);
			Api::SendLocation(action, arg(1).toDouble(), arg(2).toDouble());
		}
	} else if (step.op == u"schedlist"_q) {
		if (const auto history = HistoryOf(session, arg(0))) {
			session->scheduledMessages().refreshFromParvane(history);
			auto texts = QStringList();
			for (const auto &item : ScheduledOf(history)) {
				texts.push_back(item->originalText().text.isEmpty()
					? (item->media() ? u"[медиа]"_q : u"-"_q)
					: item->originalText().text);
			}
			LOG(("Parvane: autoui запланированные %1: %2 [%3]")
				.arg(arg(0))
				.arg(session->scheduledMessages().count(history))
				.arg(texts.join(';')));
		}
	} else if (step.op == u"schednow"_q || step.op == u"scheddelete"_q) {
		const auto history = HistoryOf(session, arg(0));
		if (!history) {
			return;
		}
		const auto items = ScheduledOf(history);
		if (items.empty()) {
			LOG(("Parvane: autoui %1 — запланированных нет").arg(step.op));
			return;
		}
		if (step.op == u"scheddelete"_q) {
			// Штатное удаление (Data::Histories → DeleteScheduled)
			session->data().histories().deleteMessages({ items.front()->fullId() }, true);
		} else {
			auto ids = QVector<MTPint>();
			ids.push_back(MTP_int(session->scheduledMessages().lookupId(items.front())));
			SendScheduledNow(history->peer, ids);
		}
	} else if (step.op == u"schedmove"_q) {
		const auto history = HistoryOf(session, arg(0));
		const auto items = history ? ScheduledOf(history) : std::vector<not_null<HistoryItem*>>();
		if (!items.empty()) {
			auto options = Api::SendOptions();
			options.scheduled = base::unixtime::now() + std::max(arg(1).toInt(), 1);
			Api::RescheduleMessage(items.front(), options); // штатный «Перенести»
		}
	} else if (step.op == u"forward"_q) {
		const auto from = HistoryOf(session, arg(0));
		const auto to = HistoryOf(session, arg(1));
		if (!from || !to) {
			return;
		}
		auto last = (HistoryItem*)nullptr;
		for (const auto &block : from->blocks) {
			for (const auto &view : block->messages) {
				if (view->data()->isRegular()) {
					last = view->data();
				}
			}
		}
		if (!last) {
			LOG(("Parvane: autoui forward — в %1 нет сообщений").arg(arg(0)));
			return;
		}
		auto draft = Data::ResolvedForwardDraft{ .items = { not_null<HistoryItem*>(last) } };
		draft.options = (arg(2) == u"noname"_q) ? Data::ForwardOptions::NoSenderNames
			: (arg(2) == u"nocaption"_q) ? Data::ForwardOptions::NoNamesAndCaptions
			: Data::ForwardOptions::PreserveInfo;
		session->api().forwardMessages(std::move(draft), Api::SendAction(to), nullptr);
	} else if (!RunRareUiStep(step.op, step.args)) {
		LOG(("Parvane: autoui — неизвестный шаг %1").arg(step.op));
	}
}

} // namespace

void StartDailyUiHooks() {
	for (const auto &step : ParseUiSteps()) {
		base::call_delayed(std::max(step.seconds, 0) * crl::time(1000), [=] { RunUiStep(step); });
	}
}

} // namespace Parvane
