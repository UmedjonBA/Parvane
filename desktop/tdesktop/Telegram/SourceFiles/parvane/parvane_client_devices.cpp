// Parvane fork: устройства, ICE-серверы, переименование и удаление групп (spec 029, T038 — вынесено из parvane_client.cpp).
#include "parvane/parvane_client_internal.h"

namespace Parvane {

// ── Мультидевайс: устройства (identity.device.list / revoke) ─────────────────
void ListDevices(Fn<void(std::vector<DeviceEntry>)> done) {
	crl::async([done = std::move(done)] {
		const auto t = ControlSnapshot();
		std::vector<DeviceEntry> out;
		if (t) {
			try {
				const auto mine = OwnDeviceId();
				for (const auto &d : parvane::v2::account::listDevices(*t)) {
					DeviceEntry e;
					e.deviceId = QString::fromStdString(d.deviceId);
					e.clientKind = QString::fromStdString(d.clientKind);
					e.updatedAt = d.lastSeenMs / 1000;
					e.createdAt = d.createdMs / 1000;
					e.current = (d.deviceId == mine);
					out.push_back(std::move(e));
				}
			} catch (const std::exception &e) {
				LOG(("Parvane: device.list ошибка: %1").arg(QString::fromUtf8(e.what())));
			}
		}
		// Устройства только из журнала v2: у аккаунта на v2 новое устройство в
		// каталог v1 не попадает (T048) — иначе его не видно и не отозвать.
		if (const auto s = V2Ready()) {
			const auto mine = OwnDeviceId();
			for (const auto &id : s->ownDevices()) {
				const auto idQ = QString::fromStdString(id);
				const auto known = std::any_of(out.begin(), out.end(), [&](const DeviceEntry &e) {
					return e.deviceId == idQ;
				});
				if (known) {
					continue;
				}
				DeviceEntry e;
				e.deviceId = idQ;
				e.updatedAt = QDateTime::currentSecsSinceEpoch();
				e.current = (id == mine);
				out.push_back(std::move(e));
			}
		}
		crl::on_main([done, out = std::move(out)]() mutable { done(std::move(out)); });
	});
}

// «Seen by» / «read at» для нативного меню: список прочитавших сообщение из
// messenger (msg.chat.readers). Воркер → main. Себя не отдаём.
std::vector<std::pair<not_null<PeerData*>, QString>> ReactorsOf(
		not_null<Main::Session*> session,
		qint64 msgId) {
	auto out = std::vector<std::pair<not_null<PeerData*>, QString>>();
	const auto it = g_msgIdToUuid.find(msgId);
	if (it == g_msgIdToUuid.end()) {
		return out;
	}
	auto users = QHash<QString, QString>();
	{
		std::lock_guard<std::mutex> lk(g_v2Mutex);
		users = g_v2Reactions.value(it.value());
	}
	const auto self = SelfAddress();
	for (auto r = users.cbegin(); r != users.cend(); ++r) {
		if (r.value().isEmpty()) {
			continue;
		}
		const auto peer = (r.key() == self)
			? not_null<PeerData*>(session->user())
			: not_null<PeerData*>(ensurePeerUser(session, IdForAddress(r.key()), r.key()));
		out.emplace_back(peer, r.value());
	}
	return out;
}

void FetchReaders(qint64 msgId, Fn<void(std::vector<ReaderEntry>)> done) {
	QString uuid;
	{
		const auto it = g_msgIdToUuid.find(msgId);
		if (it != g_msgIdToUuid.end()) {
			uuid = it.value();
		}
	}
	const auto self = SelfAddress().toStdString();
	if (uuid.isEmpty() || !IsV2Message(uuid.toStdString())) {
		done({});
		return;
	}
	crl::async([=, uuid = uuid.toStdString()] {
		std::vector<ReaderEntry> out;
		try {
			// Прочтения — E2E-квитанции, их знает только движок (серверу не видно, кто что прочитал)
			const auto v2 = V2Ready();
			const auto list = v2 ? v2->readers(uuid) : decltype(v2->readers(uuid))();
			for (const auto &[address, ts] : list) {
				if (address == self || address.empty()) {
					continue;
				}
				out.push_back(ReaderEntry{
					.address = QString::fromStdString(address),
					.userId = qint64(IdForAddress(QString::fromStdString(address))),
					.date = ts,
				});
			}
		} catch (const std::exception &e) {
			LOG(("Parvane: readers %1 — ошибка: %2")
				.arg(QString::fromStdString(uuid))
				.arg(QString::fromUtf8(e.what())));
		}
		QStringList who;
		for (const auto &r : out) {
			who.push_back(r.address + '@' + QString::number(r.date));
		}
		LOG(("Parvane: readers %1: %2")
			.arg(QString::fromStdString(uuid))
			.arg(who.isEmpty() ? u"—"_q : who.join(", ")));
		crl::on_main([done, out = std::move(out)]() mutable {
			done(std::move(out));
		});
	});
}

void RevokeDevice(const QString &deviceId, Fn<void(bool)> done, const QString &password, bool rotateKeys) {
	const auto devStd = deviceId.toStdString();
	const auto pwStd = password.toStdString();
	crl::async([=] {
		const auto t = ControlSnapshot();
		bool ok = false;
		if (t && devStd != OwnDeviceId()) {
			try {
				// P-07: отзыв устройства требует текущий пароль (session.reauth внутри).
				parvane::v2::account::revokeDevice(*t, devStd, pwStd);
				ok = true;
			} catch (const std::exception &e) {
				LOG(("Parvane: device.revoke ошибка: %1").arg(QString::fromUtf8(e.what())));
			}
		}
		if (ok) {
			// Протокол v2 (T128, FR-066): запись отзыва в журнале устройств и
			// ротации ключей, которые устройство держало (пароль проверен выше).
			// «Просто выйти» — запись sign_out без ротаций; «выйти и сменить ключи» — отзыв с ротациями.
			auto journaled = false;
			if (const auto s = V2Ready()) {
				try {
					if (rotateKeys ? s->revokeDevice(devStd) : s->signOutDevice(devStd)) {
						journaled = true;
						LOG(("Parvane: v2: устройство %1 %2 в журнале устройств").arg(deviceId,
							rotateKeys ? u"отозвано со сменой ключей"_q : u"вышло"_q));
					}
				} catch (const std::exception &e) {
					LOG(("Parvane: v2: отзыв устройства в журнале не выполнен: %1")
						.arg(QString::fromUtf8(e.what())));
				}
			}
			// Отзыв — только запись журнала устройств: мост отвечает «ok» уже после
			// проверки пароля. Записи нет — отзыва не было.
			if (!journaled) {
				LOG(("Parvane: устройство %1 не отозвано: без v1 нужна запись журнала устройств").arg(deviceId));
				ok = false;
			}
		}
		crl::on_main([done, ok] { done(ok); });
	});
}

// ── ICE-серверы (STUN/TURN с эфемерными кредами) из шарда call ───────────────
// Запрос к шарду НЕЛЬЗЯ делать там, где создаётся движок звонка: входящий вызов
// обрабатывается на потоке чтения транспорта gateway, и request оттуда ждал
// ответ, который должен был прочитать этот же поток, — 4 с таймаута, звонок без
// STUN/TURN (за NAT он не соединялся). Поэтому серверы запрашиваются заранее
// воркером (PrefetchIceServers: при готовности сессии и по сроку кэша), а
// FetchIceServers только отдаёт кэш и никогда не блокирует.

namespace Internal {
std::mutex g_iceMutex;
std::vector<IceServer> g_iceCached;
std::int64_t g_iceCachedUntil = 0;
bool g_iceRefreshing = false;

// Воркер: один запрос call.ice.request, результат — в кэш.
void RefreshIceServers() {
	const auto t = ControlSnapshot();
	std::vector<IceServer> out;
	std::int64_t ttl = 600;
	if (t) {
		try {
			const auto cfg = parvane::v2::account::iceConfig(*t);
			ttl = cfg.ttlSecs > 0 ? cfg.ttlSecs : 600;
			for (const auto &srv : cfg.servers) {
				IceServer ice;
				ice.urls = srv.urls;
				ice.username = srv.username;
				ice.password = srv.credential;
				if (!ice.urls.empty()) {
					out.push_back(std::move(ice));
				}
			}
		} catch (const std::exception &e) {
			LOG(("Parvane: call.ice.request ошибка: %1").arg(QString::fromUtf8(e.what())));
		}
	}
	std::lock_guard<std::mutex> lk(g_iceMutex);
	g_iceRefreshing = false;
	if (!out.empty()) {
		g_iceCached = out;
		g_iceCachedUntil = parvane::nowUnix() + (ttl * 8) / 10; // как web: 0.8×TTL
		LOG(("Parvane: ICE-серверы получены: %1").arg(int(out.size())));
	}
}


} // namespace Internal
void PrefetchIceServers() {
	{
		std::lock_guard<std::mutex> lk(g_iceMutex);
		if (g_iceRefreshing
			|| (!g_iceCached.empty() && parvane::nowUnix() < g_iceCachedUntil)) {
			return;
		}
		g_iceRefreshing = true;
	}
	crl::async([] { RefreshIceServers(); });
}

std::vector<IceServer> FetchIceServers() {
	// Просроченный кэш обновляем фоном к следующему звонку; этот берёт что есть.
	PrefetchIceServers();
	std::lock_guard<std::mutex> lk(g_iceMutex);
	return g_iceCached;
}

// ── Группы: переименование / удаление ────────────────────────────────────────
void RenameGroup(const QString &groupId, const QString &name) {
	if (RunV2GroupChange(u"group.rename %1"_q.arg(groupId), groupId, [nm = name.trimmed().toStdString()](const nlohmann::json &info) {
			return V2SetInfo(info, nm, std::nullopt, std::nullopt);
		}, nullptr)) {
		return;
	}
}

void DeleteGroup(const QString &groupId) {
	if (RunV2GroupChange(u"group.delete %1"_q.arg(groupId), groupId, [](const nlohmann::json &) {
			return nlohmann::json{ { "delete_group", nlohmann::json::object() } };
		}, nullptr)) {
		return;
	}
}

} // namespace Parvane
