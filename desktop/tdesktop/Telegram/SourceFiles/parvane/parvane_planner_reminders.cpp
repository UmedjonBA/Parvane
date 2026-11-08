// Parvane fork: напоминания «Плана» на desktop (ревью 7 ноя 2026, п. 12) — как web `reminders.ts` и android
// `PlannerReminders.kt`. Раз в 30 с и при каждом изменении «Плана» ядро (`planner::readReminders`) отдаёт
// наступившие и ещё не отмеченные напоминания задач и событий; свежее (не старше 2 мин) показывается штатным
// уведомлением — сервисным сообщением в чате «Parvane» (окно уведомления и звук tdesktop), пропущенное, пока
// приложение было закрыто, только отмечается. Отметка «напомнено» — объект `Reminded` домена `planner/v1`
// (`State::reminded`), общая для всех устройств: другое устройство то же напоминание уже не покажет.
// Моменты ядра — «настенные» (день и время без пояса): сейчас считается из местного времени.
#include "parvane/parvane_client_internal.h"

#include "parvane/parvane_sections_data.h"

#include <parvane/sections/planner_reminders.h>

namespace Parvane {
namespace {

namespace planner = parvane::sections::planner;

constexpr auto kTickMs = 30 * crl::time(1000);
constexpr auto kFreshMs = 2LL * 60 * 1000;

std::unique_ptr<base::Timer> g_reminderTimer; // main
QSet<QString> g_reminderHandled;              // ключи, обработанные в этом запуске (main)
rpl::lifetime g_reminderLifetime;

[[nodiscard]] long long WallNowMs() {
	const auto now = QDateTime::currentDateTime();
	return now.toMSecsSinceEpoch() + qint64(now.offsetFromUtc()) * 1000;
}

void Ring(const planner::Reminder &reminder) {
	const auto session = g_sessionWeak.get();
	if (!session) {
		return;
	}
	const auto title = QString::fromStdString(reminder.title);
	auto text = tr::lng_parvane_reminder_title(tr::now, lt_title, title);
	if (reminder.start) {
		text += '\n' + tr::lng_parvane_reminder_starts(
			tr::now,
			lt_time,
			QString::fromStdString(*reminder.start));
	}
	const auto history = session->data().history(PeerData::kServiceNotificationsId);
	if (!history->folderKnown()) {
		history->clearFolder(); // иначе requestDialogEntry ушёл бы в MTProto
	}
	session->data().serviceNotification(TextWithEntities{ text });
	LOG(("Parvane: напоминание «Плана» показано: %1 (%2)")
		.arg(title, QString::fromStdString(reminder.kind)));
}

void Tick() {
	if (!SessionActive()) {
		return;
	}
	const auto view = Sections::Planner();
	if (!view || !view->isLoaded || view->status != "ready") {
		return;
	}
	const auto now = WallNowMs();
	const auto plan = planner::readReminders(view->state, now);
	auto fresh = std::vector<std::string>();
	for (const auto &reminder : plan.due) {
		const auto key = QString::fromStdString(reminder.key);
		if (g_reminderHandled.contains(key)) {
			continue;
		}
		g_reminderHandled.insert(key);
		if (now - reminder.at <= kFreshMs) {
			Ring(reminder);
		} else {
			LOG(("Parvane: напоминание «Плана» пропущено (приложение было закрыто): %1")
				.arg(QString::fromStdString(reminder.title)));
		}
		fresh.push_back(reminder.key);
	}
	if (fresh.empty()) {
		return;
	}
	Sections::UpdatePlanner([fresh](planner::State &state) {
		for (const auto &key : fresh) {
			if (std::find(state.reminded.begin(), state.reminded.end(), key) == state.reminded.end()) {
				state.reminded.push_back(key);
			}
		}
		std::sort(state.reminded.begin(), state.reminded.end());
	});
	LOG(("Parvane: напоминания «Плана» отмечены напомненными: %1").arg(fresh.size()));
}

} // namespace

void StartPlannerReminders() {
	g_reminderHandled.clear();
	g_reminderLifetime.destroy();
	if (!g_reminderTimer) {
		g_reminderTimer = std::make_unique<base::Timer>([] { Tick(); });
	}
	g_reminderTimer->callEach(kTickMs);
	// Изменение «Плана» (своё или с другого устройства) — пересчёт сразу
	Sections::PlannerValue(
	) | rpl::on_next([](const std::shared_ptr<const Sections::PlannerView> &) {
		crl::on_main([] { Tick(); });
	}, g_reminderLifetime);
}

void StopPlannerReminders() {
	g_reminderLifetime.destroy();
	g_reminderTimer = nullptr;
	g_reminderHandled.clear();
}

} // namespace Parvane
