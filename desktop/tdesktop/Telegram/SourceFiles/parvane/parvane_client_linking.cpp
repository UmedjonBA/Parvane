// Parvane fork: привязка устройства (LINK-1), история при линковке, копия ключей (spec 029, T038 — вынесено из parvane_client.cpp).
#include "parvane/parvane_client_internal.h"

namespace Parvane {

// ── Авто-линковка истории (паритет web provider.ts / linking.ts) ─────────────
// Протокол v2 (P-03/P-48, правило LINK-1): новое устройство публикует
// обязательство на эфемерный ключ и свой signing-ключ; старое шлёт challenge
// своим эфемерным ключом; новое раскрывает ключ; SAS считается от ПАРЫ ключей
// (12 цифр); грант принимается только под ключ challenge; экспорт — без
// приватного Olm-аккаунта, с подписанным переносом владения исходящими.

namespace Internal {
constexpr auto kLinkGrantPollMs = 5000;
constexpr auto kLinkOffersPollMs = 10000;
constexpr auto kLinkOfferLifetimeMs = 10 * 60 * 1000;

// Новое устройство: эфемерный ключ оффера (пока ждём грант). Под g_sessionMutex.
std::optional<parvane::linking::EphemeralKey> g_linkEph;
std::string g_linkCommitment;
std::string g_linkChallenge; // эфемерный ключ старого устройства (после challenge)
QString g_linkCode;
std::int64_t g_linkStartedMs = 0;
bool g_linkActive = false;
// Грант сервер отдаёт ОДИН раз в любом identity.link.poll — и в опросе чужих
// офферов тоже. Грант, пришедший туда, ждёт здесь ближайшего опроса своего
// оффера (иначе терялся: опрос офферов каждые 10 с съедал его раньше).
parvane::json g_linkPendingGrant;
// Старое устройство: свой эфемерный ключ на каждый challenge (device_id → ключ)
// и офферы, уже показанные пользователю (device_id → раскрытый eph_pub).
std::map<QString, parvane::linking::EphemeralKey> g_linkChallenges;
QHash<QString, QString> g_linkOffersShown;
// Окна подтверждения привязки по устройству (только main): запрос исчез — окно закрывается само
QHash<QString, base::weak_qptr<Ui::GenericBox>> g_linkBoxes;
bool g_linkOffersPolling = false;

[[nodiscard]] std::int64_t NowMs() {
	return QDateTime::currentMSecsSinceEpoch();
}

[[nodiscard]] QString CurrentLinkCode() {
	std::lock_guard<std::mutex> lk(g_sessionMutex);
	return g_linkActive ? g_linkCode : QString();
}

[[nodiscard]] bool HeadlessUi() {
	return std::getenv("QT_QPA_PLATFORM")
		&& QString::fromUtf8(std::getenv("QT_QPA_PLATFORM")) == u"offscreen"_q;
}

// ── LINK-1 п. 8 (spec 007, T138, SC-002): история v2-эпохи при линковке ────
// Сообщения v2 запечатаны под устройства, существовавшие при отправке: новому
// устройству сервер их не отдаст, а грант движка несёт только ключи. Старое
// устройство кладёт уже расшифрованные строки v2 в экспорт линковки (поле
// `v2History` рядом с decCache; формат строки — StoredMessage, общий с web
// `v2/linkHistory.ts`), новое применяет их как строки v2.
constexpr auto kV2HistoryLimit = std::size_t(20000);
constexpr auto kLinkedGroupRetryMs = crl::time(3000);
constexpr auto kLinkedGroupRetries = 40;

[[nodiscard]] bool V2HistoryRowOk(const nlohmann::json &row) {
	try {
		if (!row.is_object()
			|| !row.contains("content")
			|| !row["content"].is_object()
			|| row.value("id", std::string()).empty()
			|| row.value("from", std::string()).empty()
			|| row.value("to", std::string()).empty()
			|| !row.contains("ts")
			|| !row["ts"].is_number()) {
			return false;
		}
		if (row.contains("deleted") && row["deleted"].is_boolean() && row["deleted"].get<bool>()) {
			return false;
		}
		const auto &content = row["content"];
		const auto kind = content.value("kind", std::string());
		if (kind.empty() || kind == "encrypted" || kind == "group_encrypted") {
			return false;
		}
		return TtlFromContent(content) == 0; // эфемерное не переносится
	} catch (const std::exception &) {
		return false;
	}
}

// Строки v2 из журнала истории (с правками и реакциями из кэша v2) — для
// экспорта линковки и ручной копии ключей.
[[nodiscard]] nlohmann::json CollectV2HistoryRows() {
	LoadV2Ids();
	auto rows = nlohmann::json::array();
	auto seen = std::set<std::string>();
	for (const auto &line : StoreReadLines(HistoryPath())) {
		try {
			auto row = nlohmann::json::parse(line.toStdString());
			const auto id = row.value("id", std::string());
			if (id.empty() || !IsV2Message(id) || !seen.insert(id).second) {
				continue;
			}
			{
				std::lock_guard<std::mutex> lk(g_v2Mutex);
				const auto it = g_v2Cache.find(QString::fromStdString(id));
				if (it != g_v2Cache.end()) {
					row = it.value().toJson();
				}
			}
			if (!V2HistoryRowOk(row)) {
				continue;
			}
			for (const auto key : { "copies", "updated_at", "origin" }) {
				row.erase(key);
			}
			rows.push_back(std::move(row));
		} catch (const std::exception &) {
		}
	}
	if (rows.size() > kV2HistoryLimit) {
		rows.erase(rows.begin(), rows.begin() + (rows.size() - kV2HistoryLimit));
	}
	return rows;
}

// Старое устройство: экспорт линковки + история v2-эпохи.
[[nodiscard]] std::string WithV2History(const std::string &exported) {
	auto rows = CollectV2HistoryRows();
	if (rows.empty()) {
		return exported;
	}
	try {
		auto state = nlohmann::json::parse(exported);
		const auto count = int(rows.size());
		state["v2History"] = std::move(rows);
		LOG(("Parvane: линковка: в экспорт добавлена история v2 (%1 сообщений)").arg(count));
		return state.dump();
	} catch (const std::exception &) {
		return exported;
	}
}

// Новое устройство: применить привезённые строки. Строки групп v2 ждут, пока
// группа появится из журнала групп (иначе сообщение ушло бы в чат с «адресом»).
void ApplyLinkedV2History(std::vector<parvane::StoredMessage> rows, QString owner, int attempt) {
	crl::on_main([rows = std::move(rows), owner, attempt]() mutable {
		const auto session = g_sessionWeak.get();
		if (!session || SelfAddress() != owner) {
			return;
		}
		auto ready = std::vector<parvane::StoredMessage>();
		auto waiting = std::vector<parvane::StoredMessage>();
		for (auto &sm : rows) {
			const auto group = parvane::v2::isGroupAddress(sm.to);
			const auto known = [&] {
				std::lock_guard<std::mutex> lk(g_sessionMutex);
				return g_knownGroups.contains(QString::fromStdString(sm.to));
			}();
			if (group && !known) {
				waiting.push_back(std::move(sm));
			} else {
				ready.push_back(std::move(sm));
			}
		}
		if (!ready.empty()) {
			LOG(("Parvane: линковка: история v2 перенесена (%1 сообщений)").arg(int(ready.size())));
			injectOnMain(session, ready, /*live=*/true);
		}
		if (waiting.empty() || attempt >= kLinkedGroupRetries) {
			return;
		}
		base::call_delayed(kLinkedGroupRetryMs, [waiting = std::move(waiting), owner, attempt]() mutable {
			ApplyLinkedV2History(std::move(waiting), owner, attempt + 1);
		});
	});
}

void ImportV2History(const std::string &stateJson) {
	auto out = std::vector<parvane::StoredMessage>();
	const auto owner = SelfAddress();
	const auto self = owner.toStdString();
	try {
		const auto state = nlohmann::json::parse(stateJson);
		if (!state.is_object() || !state.contains("v2History") || !state["v2History"].is_array()) {
			return;
		}
		LoadV2Ids();
		auto seen = std::set<std::string>(); // повтор строки в том же снимке (отметка V2NoteMessage — после цикла)
		for (const auto &row : state["v2History"]) {
			if (out.size() >= kV2HistoryLimit) {
				break;
			}
			try {
				if (!V2HistoryRowOk(row)) {
					continue;
				}
				auto sm = parvane::StoredMessage::fromJson(row);
				if (sm.id.empty() || IsV2Message(sm.id) || !seen.insert(sm.id).second) {
					continue;
				}
				if (sm.from != self) {
					sm.read = true; // история, а не новые входящие
				}
				out.push_back(std::move(sm));
			} catch (const std::exception &) {
			}
		}
	} catch (const std::exception &) {
		return;
	}
	// Перенос истории (экспорт линковки, снимок из копии ключей) — по времени отправки: строки снимка web идут
	// не по порядку, а id сообщения выдаётся по порядку вставки (ORDER-1), и сообщение 12 окт вставало выше
	// сообщения 11 окт (spec 030)
	std::stable_sort(out.begin(), out.end(), [](const auto &a, const auto &b) { return a.ts < b.ts; });
	for (const auto &sm : out) {
		const auto chat = parvane::v2::isGroupAddress(sm.to)
			? sm.to
			: (sm.from == self) ? sm.to : sm.from;
		V2NoteMessage(sm, QString::fromStdString(chat));
	}
	if (!out.empty()) {
		ApplyLinkedV2History(std::move(out), owner, 0);
	}
}

// Воркер: публикует оффер (identity.link.offer: commitment + signing_key, без
// ключа) и запускает опрос гранта.
void StartHistoryLinkOffer() {
	const auto t = ControlSnapshot();
	if (!t) {
		return;
	}
	auto eph = parvane::linking::EphemeralKey::generate();
	if (!eph) {
		return;
	}
	const auto commitment = parvane::linking::commitment(eph->publicB64());
	try {
		parvane::v2::account::linkOffer(*t, std::string(), commitment, std::string(), false);
	} catch (const std::exception &e) {
		LOG(("Parvane: линковка: оффер не опубликован: %1").arg(QString::fromUtf8(e.what())));
		return;
	}
	{
		std::lock_guard<std::mutex> lk(g_sessionMutex);
		g_linkEph = std::move(eph);
		g_linkCommitment = commitment;
		g_linkPendingGrant = nullptr;
		g_linkChallenge.clear();
		g_linkCode.clear();
		g_linkStartedMs = NowMs();
		g_linkActive = true;
	}
	LOG(("Parvane: линковка: оффер (обязательство) опубликован"));
}

void RetractHistoryLinkOffer() {
	std::shared_ptr<parvane::v2::Control> t;
	{
		std::lock_guard<std::mutex> lk(g_sessionMutex);
		t = g_control;
		g_linkActive = false;
		g_linkPendingGrant = nullptr;
		g_linkEph.reset();
		g_linkCommitment.clear();
		g_linkChallenge.clear();
		g_linkCode.clear();
	}
	if (!t) {
		return;
	}
	try {
		parvane::v2::account::linkOffer(*t, std::string(), std::string(), std::string(), true);
	} catch (const std::exception &) {
	}
}

// Воркер: один опрос гранта. true — линковка завершена (успех/стоп).
bool PollLinkGrantOnce() {
	std::shared_ptr<parvane::v2::Control> t;
	std::string commitment, challenge;
	std::optional<parvane::linking::EphemeralKey> eph;
	std::int64_t started = 0;
	{
		std::lock_guard<std::mutex> lk(g_sessionMutex);
		if (!g_linkActive) {
			return true;
		}
		t = g_control;
		eph = g_linkEph;
		commitment = g_linkCommitment;
		challenge = g_linkChallenge;
		started = g_linkStartedMs;
	}
	if (!t || !eph) {
		return true;
	}
	if (NowMs() - started > kLinkOfferLifetimeMs) {
		LOG(("Parvane: линковка: оффер истёк (10 мин) — отзываю"));
		RetractHistoryLinkOffer();
		return true;
	}
	if (!V2NeedsLinking()) {
		LOG(("Parvane: линковка: устройство уже в журнале устройств — отзываю оффер"));
		RetractHistoryLinkOffer();
		return true;
	}
	parvane::json grant;
	std::string newChallenge;
	try {
		const auto resp = parvane::v2::account::linkPoll(*t);
		newChallenge = resp.challenge;
		if (resp.grant) {
			grant = parvane::json{ { "box_payload", resp.grant->boxPayload }, { "eph_pub", resp.grant->ephPub } };
		} else {
			std::lock_guard<std::mutex> lk(g_sessionMutex);
			if (g_linkPendingGrant.is_object()) {
				grant = g_linkPendingGrant;
			}
		}
	} catch (const std::exception &) {
		return false;
	}
	// Challenge пришёл — раскрываем ключ (сервер сверяет с обязательством) и
	// показываем SAS от пары ключей. Фиксируется первый challenge.
	if (challenge.empty() && !newChallenge.empty()) {
		try {
			parvane::v2::account::linkOffer(*t, eph->publicB64(), commitment, std::string(), false);
		} catch (const std::exception &) {
			LOG(("Parvane: линковка: раскрытие ключа отклонено"));
			return false;
		}
		const auto code = QString::fromStdString(
			parvane::linking::sasCodeV2(eph->publicB64(), newChallenge));
		{
			std::lock_guard<std::mutex> lk(g_sessionMutex);
			if (!g_linkActive) {
				return true;
			}
			g_linkChallenge = newChallenge;
			g_linkCode = code;
		}
		challenge = newChallenge;
		LOG(("Parvane: линковка: ключ раскрыт, код сверки готов"));
#ifdef PARVANE_DEV
		// Только dev-сборка: headless e2e сверяет код по логу.
		// Код сверки — секрет: открыто только при PARVANE_LOG_CONTENT=1 на стенде (ревью 21 окт 2026).
		LOG(("Parvane: линковка (dev): код сверки %1").arg(LogSecret(code)));
#endif
		(void)code;
		PublishLinkingStatus(); // код показывает окно привязки и экран «Устройства»
	}
	if (grant.is_null()) {
		return false;
	}
	if (challenge.empty() || grant.value("eph_pub", std::string()) != challenge) {
		// Грант не под тот ключ, с которым считался SAS: гонка двух старых
		// устройств или подмена — игнорируем.
		LOG(("Parvane: линковка: грант под чужой эфемерный ключ — отклонён"));
		return false;
	}
	{
		std::lock_guard<std::mutex> lk(g_sessionMutex);
		g_linkActive = false;
	}
	const auto plain = eph->open(grant.value("eph_pub", std::string()),
		grant.value("box_payload", std::string()));
	if (!plain) {
		LOG(("Parvane: линковка: бокс не расшифровался (чужой эфемерный ключ?)"));
		return true;
	}
	const auto box = parvane::json::parse(*plain, nullptr, false);
	if (!box.is_object()) {
		return true;
	}
	// LINK-1 v2: материал гранта движка (SSK, журнал устройств, ключ доставки,
	// ключ личного состояния) лежит отдельным блобом — как web joinV2WithLinkGrant.
	if (box.contains("v2") && box["v2"].is_object()) {
		if (const auto s = V2AwaitNeedsLinking()) {
			try {
				const auto &coords = box["v2"];
				auto d = DownloadChatBlob(coords.value("file_id", std::string()));
				auto material = d.ok
					? parvane::blobcrypt::decrypt(d.bytes,
						coords.value("file_key", std::string()),
						coords.value("file_nonce", std::string()))
					: std::nullopt;
				if (material) {
					LOG(("Parvane: линковка: грант v2 получен — устройство вступает в журнал устройств"));
					s->joinWithGrant(std::move(*material));
				} else {
					LOG(("Parvane: линковка: грант v2 не скачался или не расшифровался"));
				}
			} catch (const std::exception &e) {
				LOG(("Parvane: линковка: грант v2: %1").arg(QString::fromUtf8(e.what())));
			}
		}
	}
	std::string stateJson;
	try {
		auto d = DownloadChatBlob(box.value("file_id", std::string()));
		if (!d.ok) {
			LOG(("Parvane: линковка: экспорт не скачался из cloud: %1")
				.arg(QString::fromStdString(d.error)));
			return true;
		}
		const auto dec = parvane::blobcrypt::decrypt(d.bytes,
			box.value("file_key", std::string()), box.value("file_nonce", std::string()));
		if (!dec) {
			LOG(("Parvane: линковка: экспорт не расшифровался"));
			return true;
		}
		stateJson = *dec;
	} catch (const std::exception &e) {
		LOG(("Parvane: линковка: скачивание: %1").arg(QString::fromUtf8(e.what())));
		return true;
	}
	LOG(("Parvane: линковка: экспорт получен"));
	ImportV2History(stateJson); // LINK-1 п. 8: история v2-эпохи
	return true;
}

void ScheduleLinkGrantPoll() {
	crl::on_main([] {
		base::call_delayed(kLinkGrantPollMs, [] {
			crl::async([] {
				if (!PollLinkGrantOnce()) {
					ScheduleLinkGrantPoll();
				}
			});
		});
	});
}

// Воркер (старое устройство): выдать грант устройству deviceId с раскрытым
// ключом ephPub — экспорт БЕЗ приватного материала → blobcrypt → cloud
// (owner-only) → ECDH-бокс (с подписанным переносом владения) → link.grant.
void GrantLink(const QString &deviceId, const QString &ephPub, const QString &signingKey) {
	std::shared_ptr<parvane::v2::Control> t;
	std::optional<parvane::linking::EphemeralKey> own;
	{
		std::lock_guard<std::mutex> lk(g_sessionMutex);
		t = g_control;
		if (const auto it = g_linkChallenges.find(deviceId); it != g_linkChallenges.end()) {
			own = it->second;
		}
	}
	if (!t || !own) {
		LOG(("Parvane: линковка: нет своего challenge для устройства %1").arg(deviceId));
		return;
	}
	try {
		// Экспорт линковки — формат web 2: история v2-эпохи (LINK-1 п. 8), ключи — грантом движка
		const auto exported = WithV2History(nlohmann::json{ { "linkVersion", 2 } }.dump());
		auto enc = parvane::blobcrypt::encrypt(exported);
		const auto fileId = t->uploadBlob(enc.ciphertext);
		parvane::json boxPlain = {{"file_id", fileId},
			{"file_key", enc.keyB64}, {"file_nonce", enc.nonceB64}};
		(void)signingKey; // перенос владения исходящими v1 (Olm) больше не нужен
		// LINK-1 v2: грант движка — вторым блобом (бокс ограничен 8 КБ).
		if (const auto s = V2Ready()) {
			auto material = s->linkGrantMaterial();
			if (!material.empty()) {
				auto encV2 = parvane::blobcrypt::encrypt(material);
				std::fill(material.begin(), material.end(), '\0');
				const auto v2File = t->uploadBlob(encV2.ciphertext);
				boxPlain["v2"] = {{"file_id", v2File},
					{"file_key", encV2.keyB64}, {"file_nonce", encV2.nonceB64}};
				LOG(("Parvane: линковка: грант v2 приложен"));
			}
		}
		const auto box = own->seal(ephPub.toStdString(), boxPlain.dump());
		if (!box) {
			return;
		}
		parvane::v2::account::linkGrant(*t, deviceId.toStdString(), *box, own->publicB64());
		LOG(("Parvane: линковка: грант выдан устройству %1").arg(deviceId));
		std::lock_guard<std::mutex> lk(g_sessionMutex);
		g_linkChallenges.erase(deviceId);
	} catch (const std::exception &e) {
		LOG(("Parvane: линковка: грант не удался: %1").arg(QString::fromUtf8(e.what())));
	}
}

// Воркер (старое устройство): опрос чужих офферов → challenge → после
// раскрытия ключа подтверждение с SAS-кодом. Legacy-офферы v1 (без
// обязательства) не обслуживаются.
void PollLinkOffersOnce() {
	const auto t = ControlSnapshot();
	if (!t) {
		return;
	}
	parvane::json offers = parvane::json::array();
	try {
		const auto resp = parvane::v2::account::linkPoll(*t);
		if (resp.grant) {
			// Свой грант пришёл в опросе чужих офферов — оставляем опросу своего оффера.
			std::lock_guard<std::mutex> lk(g_sessionMutex);
			if (g_linkActive) {
				g_linkPendingGrant = parvane::json{
					{ "box_payload", resp.grant->boxPayload }, { "eph_pub", resp.grant->ephPub } };
			}
		}
		// Уже вошедшие в журнал своих устройств (ключом восстановления, подтверждением) — не запрос: их оффер мог
		// остаться на сервере до отзыва, а «новое устройство просит привязку» для них только путает
		std::set<std::string> joined;
		if (!resp.offers.empty()) {
			if (const auto s = V2Ready()) {
				try {
					s->refreshPeerLog(SelfAddress().toStdString());
				} catch (const std::exception &) {
				}
				for (auto &id : s->ownDevices()) {
					joined.insert(std::move(id));
				}
			}
		}
		for (const auto &o : resp.offers) {
			if (joined.count(o.deviceId)) {
				continue;
			}
			offers.push_back(parvane::json{ { "device_id", o.deviceId }, { "eph_pub", o.ephPub },
				{ "commitment", o.commitment }, { "signing_key", o.signingKey },
				{ "challenge_pub", o.challengePub }, { "created_at", o.createdMs / 1000 } });
		}
	} catch (const std::exception &) {
		return;
	}
	// Ключи challenge для исчезнувших офферов больше не нужны.
	{
		std::set<QString> live;
		for (const auto &o : offers) {
			if (o.is_object()) {
				live.insert(QString::fromStdString(o.value("device_id", std::string())));
			}
		}
		QStringList gone;
		{
			std::lock_guard<std::mutex> lk(g_sessionMutex);
			for (auto it = g_linkChallenges.begin(); it != g_linkChallenges.end();) {
				it = live.count(it->first) ? std::next(it) : g_linkChallenges.erase(it);
			}
			for (auto it = g_linkOffersShown.begin(); it != g_linkOffersShown.end();) {
				if (live.count(it.key())) {
					++it;
					continue;
				}
				gone.push_back(it.key());
				it = g_linkOffersShown.erase(it);
			}
		}
		if (!gone.isEmpty()) {
			crl::on_main([gone] {
				for (const auto &dev : gone) {
					if (const auto box = g_linkBoxes.take(dev).get()) {
						box->closeBox();
					}
				}
			});
		}
	}
	for (const auto &o : offers) {
		if (!o.is_object()) {
			continue;
		}
		const auto dev = QString::fromStdString(o.value("device_id", std::string()));
		const auto eph = QString::fromStdString(o.value("eph_pub", std::string()));
		const auto commitment = o.value("commitment", std::string());
		const auto challengePub = o.value("challenge_pub", std::string());
		const auto signingKey = QString::fromStdString(o.value("signing_key", std::string()));
		if (dev.isEmpty() || commitment.empty()) {
			continue;
		}
		std::optional<parvane::linking::EphemeralKey> own;
		{
			std::lock_guard<std::mutex> lk(g_sessionMutex);
			if (const auto it = g_linkChallenges.find(dev); it != g_linkChallenges.end()) {
				own = it->second;
			}
		}
		if (!own && !challengePub.empty()) {
			continue; // challenge выставило другое наше устройство
		}
		if (!own || challengePub.empty()) {
			// Нет challenge (или новое устройство переофферило — сервер его
			// сбросил): шлём свой ключ; при повторе — тот же (идемпотентно).
			auto key = own ? own : parvane::linking::EphemeralKey::generate();
			if (!key) {
				continue;
			}
			try {
				parvane::v2::account::linkChallenge(*t, dev.toStdString(), key->publicB64());
			} catch (const std::exception &) {
				continue;
			}
			std::lock_guard<std::mutex> lk(g_sessionMutex);
			g_linkChallenges.insert_or_assign(dev, *key);
			continue;
		}
		if (challengePub != own->publicB64() || eph.isEmpty()) {
			continue; // ждём раскрытия ключа (или это чужой challenge)
		}
		if (!parvane::linking::commitmentMatches(eph.toStdString(), commitment)) {
			LOG(("Parvane: линковка: ключ оффера %1 не соответствует обязательству").arg(dev));
			continue;
		}
		{
			std::lock_guard<std::mutex> lk(g_sessionMutex);
			if (g_linkOffersShown.value(dev) == eph) {
				continue;
			}
			g_linkOffersShown.insert(dev, eph);
		}
		const auto code = QString::fromStdString(
			parvane::linking::sasCodeV2(eph.toStdString(), own->publicB64()));
		LOG(("Parvane: линковка: запрос переноса истории от устройства %1, код готов").arg(dev));
#ifdef PARVANE_DEV
		// Только dev-сборка: headless e2e сверяет код с кодом нового устройства.
		LOG(("Parvane: линковка (dev): код сверки %1 для устройства %2").arg(LogSecret(code), dev));
#endif
		// Headless e2e: PARVANE_AUTOLINK_GRANT=1 — подтверждать без UI (только dev-сборка).
		if (const char *ag = ParvaneDevEnv("PARVANE_AUTOLINK_GRANT"); ag && *ag) {
			GrantLink(dev, eph, signingKey);
			continue;
		}
		crl::on_main([dev, eph, signingKey, code] {
			if (const auto previous = g_linkBoxes.take(dev).get()) {
				previous->closeBox();
			}
			g_linkBoxes[dev] = Ui::show(Ui::MakeConfirmBox({
				.text = tr::lng_parvane_link_grant_confirm(tr::now, lt_code, code),
				.confirmed = [dev, eph, signingKey](Fn<void()> &&close) {
					crl::async([dev, eph, signingKey] { GrantLink(dev, eph, signingKey); });
					close();
				},
				.confirmText = tr::lng_parvane_link_grant_button(),
			}));
		});
	}
}

void ScheduleLinkOffersPoll() {
	crl::on_main([] {
		base::call_delayed(kLinkOffersPollMs, [] {
			if (!SessionActive()) {
				return;
			}
			crl::async([] {
				PollLinkOffersOnce();
				ScheduleLinkOffersPoll();
			});
		});
	});
}


// ── Резервная копия ключей (PARITY «ДЫРА: нет резервной копии ключей») ──────
// Формат веб-клиента (keybackup.h), файл годится для переноса между клиентами.
// Блокирующие — звать с воркера (crl::async).
} // namespace Internal
[[nodiscard]] QString BackupMarkerPath() {
	return cWorkingDir() + u"tdata/parvane-backup-done"_q;
}

bool KeyBackupDone() {
	return QFile::exists(BackupMarkerPath());
}

bool ExportKeyBackup(const QString &path, const QString &password, QString *error) {
	// Формат web 2 (keyBackup.ts): {deviceId, v2: устройство движка, v2History} — сервер историю заново не отдаст
	const auto s = V2Ready();
	if (!s) {
		*error = tr::lng_parvane_keys_not_ready(tr::now);
		return false;
	}
	auto payload = nlohmann::json::object();
	try {
		payload["deviceId"] = OwnDeviceId();
		if (auto device = s->deviceBackup(); device.is_object()) {
			payload["v2"] = std::move(device);
		}
		if (auto rows = CollectV2HistoryRows(); !rows.empty()) {
			LOG(("Parvane: копия ключей: история v2 (%1 сообщений)").arg(int(rows.size())));
			payload["v2History"] = std::move(rows);
		}
	} catch (const std::exception &) {
	}
	if (!payload.contains("v2")) {
		*error = tr::lng_parvane_keys_export_failed(tr::now);
		return false;
	}
	const auto state = payload.dump();
	const auto file = parvane::keybackup::exportEncrypted(state, password.toStdString());
	if (file.empty()) {
		*error = tr::lng_parvane_keys_export_failed(tr::now);
		return false;
	}
	auto f = QFile(path);
	if (!f.open(QIODevice::WriteOnly | QIODevice::Truncate)
		|| f.write(file.data(), qint64(file.size())) != qint64(file.size())) {
		*error = tr::lng_parvane_keys_export_failed(tr::now);
		return false;
	}
	parvane::storecrypt::writeRawFile(BackupMarkerPath().toStdString(), "1"); // под оградой хранилища
	LOG(("Parvane: копия ключей сохранена (%1 байт)").arg(qint64(file.size())));
	return true;
}

bool ImportKeyBackup(const QString &path, const QString &password, QString *error) {
	auto f = QFile(path);
	if (!f.open(QIODevice::ReadOnly)) {
		*error = tr::lng_parvane_keys_import_bad_password(tr::now);
		return false;
	}
	const auto state = parvane::keybackup::importEncrypted(
		f.readAll().toStdString(), password.toStdString());
	if (!state) {
		*error = tr::lng_parvane_keys_import_bad_password(tr::now);
		return false;
	}
	// История v2 из копии сливается с журналом. Устройство копии (`v2`) десктоп не перенимает: своя личность
	// устройства сохраняется, в журнал устройств оно входит привязкой или ключом восстановления.
	try {
		const auto parsed = nlohmann::json::parse(*state);
		if (!parsed.is_object() || !parsed.contains("v2")) {
			*error = tr::lng_parvane_keys_import_failed(tr::now);
			return false;
		}
		if (parsed.contains("v2History") && parsed["v2History"].is_array()) {
			ImportV2History(nlohmann::json{ { "v2History", parsed["v2History"] } }.dump());
		}
	} catch (const std::exception &) {
		*error = tr::lng_parvane_keys_import_bad_password(tr::now);
		return false;
	}
	LOG(("Parvane: копия ключей восстановлена"));
	return true;
}

// Воркер: сессии v2 нужен грант линковки (событие `needsLinking`) — оффер
// публикуется, даже если история v1 на устройстве уже есть.
void StartDeviceLinkOfferForV2() {
	if (ParvaneDevEnv("PARVANE_NO_LINK_OFFER")) {
		return;
	}
	{
		std::lock_guard<std::mutex> lk(g_sessionMutex);
		if (g_linkActive) {
			return;
		}
	}
	LOG(("Parvane: линковка: журнал устройств v2 уже есть — публикую оффер"));
	StartHistoryLinkOffer();
	bool active = false;
	{
		std::lock_guard<std::mutex> lk(g_sessionMutex);
		active = g_linkActive;
	}
	if (active) {
		ScheduleLinkGrantPoll();
	}
}

// Воркер, после initDevice: новое устройство без истории публикует оффер и
// ждёт грант; любое устройство опрашивает чужие офферы (роль «старого»).
void StartHistoryLinking() {
	bool offered = false;
	{
		std::lock_guard<std::mutex> lk(g_sessionMutex);
		offered = g_linkActive; // оффер уже опубликован по событию v2 `needsLinking`
	}
	if (!offered && V2NeedsLinking()
		&& !ParvaneDevEnv("PARVANE_NO_LINK_OFFER")) {
		StartHistoryLinkOffer();
		bool active = false;
		{
			std::lock_guard<std::mutex> lk(g_sessionMutex);
			active = g_linkActive;
		}
		if (active) {
			ScheduleLinkGrantPoll();
		}
	}
	bool start = false;
	{
		std::lock_guard<std::mutex> lk(g_sessionMutex);
		start = !g_linkOffersPolling;
		g_linkOffersPolling = true;
	}
	if (start) {
		PollLinkOffersOnce();
		ScheduleLinkOffersPoll();
	}
}

// Код линковки (новое устройство, пока ждём грант); пусто — не ждём или
// старое устройство ещё не прислало challenge (v2: код появляется после него).
QString HistoryLinkCode() {
	std::lock_guard<std::mutex> lk(g_sessionMutex);
	return g_linkActive ? g_linkCode : QString();
}

// Выход из аккаунта / вход другим (ревью 21 окт 2026, вечер): оффер, ключи и показанные офферы прежнего — прочь
void ResetLinkingAccountData() {
	std::lock_guard<std::mutex> lk(g_sessionMutex);
	g_linkEph.reset();
	g_linkCommitment.clear();
	g_linkChallenge.clear();
	g_linkCode.clear();
	g_linkStartedMs = 0;
	g_linkActive = false;
	g_linkPendingGrant = parvane::json();
	g_linkChallenges.clear();
	g_linkOffersShown.clear();
}

} // namespace Parvane
