// Parvane fork: вход, регистрация, 2FA, учётные данные (сервер, токен, секрет доверия) (spec 029, T038 — вынесено из parvane_client.cpp).
#include "parvane/parvane_client_internal.h"

namespace Parvane {

// "wss://host:port/ws" / "ws://host:port/ws" (WebSocket — единственный путь
// на прод: Caddy публикует только HTTPS). Без PARVANE_GATEWAY_URL и без
// PARVANE_NATS_URL — прод по WSS, как у веб-клиента.
constexpr auto kDefaultGatewayWss = "wss://parvane.duckdns.org:20443/ws";

QString GatewayUrl() {
	if (const char *v = std::getenv("PARVANE_GATEWAY_URL"); v && *v) {
		const auto url = QString::fromUtf8(v);
#ifndef PARVANE_DEV
		// P-45: в релизе только wss:// — plaintext TCP/ws:// к gateway отдал бы
		// JWT в открытом виде; переменной окружения этого не обойти.
		if (!url.startsWith(u"wss://"_q, Qt::CaseInsensitive)) {
			LOG(("Parvane: PARVANE_GATEWAY_URL без wss:// проигнорирован в релизе: %1").arg(url));
			return QString::fromUtf8(kDefaultGatewayWss);
		}
#endif
		return url;
	}
	return QString::fromUtf8(kDefaultGatewayWss);
}

// Сервер ответил «версия клиента ниже минимальной» (ERROR_CODE_UPGRADE_REQUIRED) — экран входа объясняет.
std::atomic<bool> g_upgradeRequired{false};

bool UpgradeRequired() {
	return g_upgradeRequired;
}

// Отказ v2 → текст на языке интерфейса для экранов входа/настроек; попутно запоминается «нужна новая версия».
[[nodiscard]] QString V2ErrorText(const std::string &code, const QString &fallback) {
	if (code == "ERROR_CODE_UPGRADE_REQUIRED") {
		g_upgradeRequired = true;
		return tr::lng_parvane_upgrade_required(tr::now);
	} else if (code == "ERROR_CODE_RATE_LIMITED") {
		return tr::lng_parvane_too_many_attempts(tr::now);
	} else if (code == "ERROR_CODE_REVOKED") {
		return tr::lng_parvane_device_revoked(tr::now);
	}
	return fallback;
}

[[nodiscard]] QString ErrorTextOf(const std::exception &e, const QString &fallback) {
	if (const auto v2 = dynamic_cast<const parvane::v2::V2Error *>(&e)) {
		return V2ErrorText(v2->code(), fallback);
	}
	return QString::fromUtf8(e.what());
}

// Соединение управления v2 (Hello → Auth по JWT). Пустой token — брать текущий Token() при каждом
// (пере)подключении; иначе — заданный (одноразовые соединения настроек).
[[nodiscard]] std::shared_ptr<parvane::v2::Control> MakeControl(const QString &token) {
	const auto gw = GatewayUrl();
	if (gw.isEmpty()) {
		throw std::runtime_error("gateway: адрес сервера не задан");
	}
	parvane::v2::ControlConfig cfg;
	cfg.gatewayUrl = gw.toStdString();
	if (token.isEmpty()) {
		cfg.token = [] { return Token().toStdString(); };
	} else {
		cfg.token = [t = token.toStdString()] { return t; };
	}
	cfg.log = [](const std::string &line) {
		LOG(("Parvane: %1").arg(QString::fromStdString(line)));
	};
	return std::make_shared<parvane::v2::Control>(std::move(cfg));
}

// ── секрет доверия (2FA) ────────────────────────────────────────────────────
// Выдаётся identity ОДИН раз после подтверждённого входа в Telegram; с ним
// доверенное устройство входит по паролю без Telegram. device_id для этого не
// годится — он публичен (каталог прекеев отдаёт его любому).
[[nodiscard]] QString TrustSecretPath(const QString &user) {
	return cWorkingDir() + u"tdata/parvane-trust-"_q + user + u".txt"_q;
}

[[nodiscard]] QString ReadTrustSecret(const QString &user) {
	return QString::fromUtf8(StoreRead(TrustSecretPath(user))).trimmed();
}

void WriteTrustSecret(const QString &user, const QString &secret) {
	if (user.isEmpty() || secret.isEmpty()) {
		return;
	}
	if (StoreWrite(TrustSecretPath(user), secret.toUtf8())) {
		LOG(("Parvane: получен секрет доверия устройства (2FA) для %1").arg(user));
	}
}

// ── персист логин-состояния (self+token) ─────────────────────────────────────
// tdesktop на РЕСТАРТЕ возобновляет кэшированную сессию, минуя экран логина
// (SetSelf не зовётся). Чтобы Parvane-слой поднялся с той же личностью,
// сохраняем self+token и восстанавливаем в AfterSessionReady при пустом self.
[[nodiscard]] QString SessionCredsPath() {
	return cWorkingDir() + u"tdata/parvane-session.txt"_q;
}

void SaveSessionCreds(const QString &address, const QString &token) {
	StoreWrite(SessionCredsPath(), address.toUtf8() + "\n" + token.toUtf8() + "\n");
}

// Восстановить self+token с диска (для рестарта). true — восстановлено.
bool RestoreSessionCreds() {
	const auto raw = StoreRead(SessionCredsPath());
	if (raw.isEmpty()) {
		return false;
	}
	const auto lines = QString::fromUtf8(raw).split('\n');
	if (lines.size() < 2 || lines[0].trimmed().isEmpty()) {
		return false;
	}
	const auto address = lines[0].trimmed();
	const auto token = lines[1].trimmed();
	{
		std::lock_guard<std::mutex> lk(g_sessionMutex);
		g_selfAddress = address;
		g_token = token;
	}
	RegisterPeer(address);
	LOG(("Parvane: логин-состояние восстановлено с диска (%1)").arg(address));
	return true;
}

void EnsureDefaultLanguage() {
	const char *lf = std::getenv("PARVANE_LANG_FILE");
	if (!lf || !*lf) {
		return;
	}
	const auto path = QString::fromUtf8(lf);
	if (!QFileInfo::exists(path)) {
		LOG(("Parvane: языковой файл не найден: %1").arg(path));
		return;
	}
	// Однократно: маркер в tdata. Дальше язык — выбор пользователя.
	const auto marker = cWorkingDir() + u"tdata/parvane-lang-applied"_q;
	if (QFileInfo::exists(marker)) {
		return;
	}
	Core::App().langpack().switchToCustomFile(path);
	QFile f(marker);
	if (f.open(QIODevice::WriteOnly)) {
		f.write("ru");
	}
	LOG(("Parvane: язык по умолчанию — русский (%1)").arg(path));
}

void LogStartup() {
	LOG(("Parvane: протокол v2, сервер %1").arg(GatewayUrl()));
	StartupHousekeeping(); // до хранилища и сессии (Application::run → startLocalStorage — следом)
}

namespace {

// Строки журнала клиента («Parvane…»): dev-сборка пишет их в log.txt как раньше (verify_*.sh), релиз — только
// при режиме отладки tdesktop, иначе в память (parvane-core logpriv). Ставится до main — до первой строки.
[[maybe_unused]] const bool kLogDevBuildSet = [] {
#ifdef PARVANE_DEV
	parvane::logpriv::setDevBuild(true);
#endif // PARVANE_DEV
	return true;
}();

} // namespace

ServerInfo FetchServerInfo() {
	ServerInfo out;
	out.domain = u"local"_q;
	try {
		const auto info = parvane::v2::account::describeServer(GatewayUrl().toStdString());
		if (!info.domain.empty()) {
			out.domain = QString::fromStdString(info.domain);
		}
		out.confirm = QString::fromStdString(info.confirm);
		out.telegramBot = QString::fromStdString(info.telegramBot);
	} catch (const parvane::v2::V2Error &e) {
		(void)V2ErrorText(e.code(), QString());
		LOG(("Parvane: server.describe недоступен (%1), домен по умолчанию")
			.arg(QString::fromStdString(e.code())));
	} catch (const std::exception &e) {
		LOG(("Parvane: server.info недоступен (%1), домен по умолчанию")
			.arg(QString::fromUtf8(e.what())));
	}
	return out;
}

QString CanonicalAddress(const QString &input, const QString &domain) {
	const auto trimmed = input.trimmed().toLower();
	if (trimmed.isEmpty() || trimmed.contains('@')) {
		return trimmed;
	}
	return trimmed + '@' + domain;
}

IssueResult Issue(
		const QString &user,
		const QString &password,
		const QString &loginToken,
		bool cancelDeletion) {
	IssueResult out;
	// Выход со стиранием прежнего аккаунта ещё идёт — вход после него (иначе стирание задело бы новый вход)
	if (!PrepareForLogin()) {
		out.error = tr::lng_parvane_logout_pending(tr::now);
		return out;
	}
	try {
		// Канал PRE: без токена (gateway пускает identity.session.issue до auth).
		parvane::v2::account::IssueRequest req;
		req.user = user.toStdString();
		req.password = password.toStdString();
		// device_id этой установки → claim dev в JWT: отозванное устройство теряет
		// токен сразу. Ключ хранилища (P-13) — ДО чтения файлов каталога состояния:
		// вход со свежего старта процесса шёл раньше первого StoreRead, и
		// устройство каждый раз получало НОВЫЙ device_id.
		EnsureStoreKey();
		// id устройства — из каталога состояния v2 (существующая установка — тот же id, что у состояния
		// движка; новая — создаётся и сохраняется)
		const auto stateDir = V2StateDir(user).toStdString();
		req.deviceId = parvane::v2::Session::deviceIdFor(stateDir);
		// ID-01: устройство, уже привязанное к журналу, доказывает ключ по сохранённому состоянию движка
		req.deviceProof = parvane::v2::Session::sessionProofFor(stateDir, QDateTime::currentMSecsSinceEpoch());
		req.cancelDeletion = cancelDeletion; // spec 027: вход в аккаунт, ждущий удаления, — восстановить его
		req.loginToken = loginToken.toStdString(); // двухфакторный вход: подтверждённый в Telegram токен
		req.trustSecret = ReadTrustSecret(user).toStdString(); // доверенное устройство
		const auto r = parvane::v2::account::issueSession(GatewayUrl().toStdString(), req);
		out.ok = r.ok;
		out.token = QString::fromStdString(r.token);
		if (!r.trustSecret.empty()) {
			WriteTrustSecret(user, QString::fromStdString(r.trustSecret));
		}
		out.errorCode = QString::fromStdString(r.errorCode);
		out.deletionAtMs = r.deletionAtMs;
		out.address = QString::fromStdString(r.address); // spec 026: новый ник
		out.confirmRequired = r.confirmRequired;
		if (r.twofaRequired) {
			out.twofaRequired = true;
			out.loginToken = QString::fromStdString(r.loginToken);
			out.telegramBot = QString::fromStdString(r.telegramBot);
		}
		if (!r.errorCode.empty()) {
			out.error = V2ErrorText(r.errorCode, tr::lng_parvane_bad_login(tr::now));
		}
		if (!out.ok && out.error.isEmpty() && !out.deletionAtMs && !out.twofaRequired && !out.confirmRequired) {
			out.error = tr::lng_parvane_sign_in_failed(tr::now);
		}
	} catch (const std::exception &e) {
		out.ok = false;
		out.error = ErrorTextOf(e, tr::lng_parvane_sign_in_failed(tr::now));
		LOG(("Parvane: Issue exception: %1").arg(QString::fromUtf8(e.what())));
	}
	return out;
}

RegisterResult Register(const QString &user, const QString &password,
		const QString &email) {
	RegisterResult out;
	if (!PrepareForLogin()) {
		out.error = tr::lng_parvane_logout_pending(tr::now);
		return out;
	}
	try {
		// bootstrap: как Issue, до auth (identity.user.register разрешён).
		// email — регистрация через почту (PARVANE_EMAIL_REQUIRED на identity):
		// ответ confirm_required → нужен код из письма (identity.email.confirm).
		const auto r = parvane::v2::account::registerAccount(GatewayUrl().toStdString(),
			user.toStdString(), password.toStdString(), email.trimmed().toStdString());
		out.ok = r.ok;
		out.confirmRequired = r.confirmRequired;
		out.telegramToken = QString::fromStdString(r.telegramToken);
		out.emailRequired = r.emailRequired; // сервер подтверждает почтой — экран входа спросит адрес
		// Отказ v2 — текст на языке интерфейса
		if (const auto &code = r.errorCode; !code.empty() && !r.emailRequired) {
			out.error = (code == "ERROR_CODE_DUPLICATE")
				? tr::lng_parvane_nick_taken(tr::now)
				: (code == "ERROR_CODE_INVALID")
				? tr::lng_parvane_register_invalid(tr::now)
				: V2ErrorText(code, tr::lng_parvane_register_failed(tr::now));
		}
		if (!out.ok && out.error.isEmpty()) {
			out.error = tr::lng_parvane_register_failed(tr::now);
		}
	} catch (const std::exception &e) {
		out.ok = false;
		out.error = ErrorTextOf(e, tr::lng_parvane_register_failed(tr::now));
		LOG(("Parvane: Register exception: %1").arg(QString::fromUtf8(e.what())));
	}
	return out;
}

bool RegisterStatus(const QString &user, const QString &token) {
	try {
		return parvane::v2::account::registerStatus(GatewayUrl().toStdString(),
			user.toStdString(), token.toStdString());
	} catch (const std::exception &e) {
		LOG(("Parvane: RegisterStatus exception: %1").arg(QString::fromUtf8(e.what())));
		return false;
	}
}


namespace Internal {
TwoFactorState RequestTwoFactor(
		const std::optional<bool> &enabled,
		const QString &password = QString()) {
	TwoFactorState out;
	try {
		auto control = MakeControl(Token());
		// P-07: смена 2FA — только со свежим паролем (session.reauth внутри).
		const auto r = enabled
			? parvane::v2::account::setTwoFactor(*control, *enabled, password.toStdString())
			: parvane::v2::account::getTwoFactor(*control);
		out.ok = true;
		out.enabled = r.enabled;
		out.telegramLinked = r.telegramLinked;
		if (!r.trustSecret.empty()) {
			// Устройство, включившее 2FA, доверенное сразу — иначе при следующем
			// старте оно само попросило бы подтверждение в Telegram
			WriteTrustSecret(SelfAddress(), QString::fromStdString(r.trustSecret));
		}
	} catch (const parvane::v2::V2Error &e) {
		out.error = (e.code() == "ERROR_CODE_REAUTH_REQUIRED" || e.code() == "ERROR_CODE_FORBIDDEN"
			|| e.code() == "ERROR_CODE_INVALID")
			? tr::lng_parvane_bad_login(tr::now)
			: V2ErrorText(e.code(), tr::lng_parvane_sign_in_failed(tr::now));
		LOG(("Parvane: twofa отказ: %1").arg(QString::fromStdString(e.code())));
	} catch (const std::exception &e) {
		out.error = QString::fromUtf8(e.what());
		LOG(("Parvane: twofa exception: %1").arg(out.error));
	}
	return out;
}


} // namespace Internal
TwoFactorState FetchTwoFactor() {
	return RequestTwoFactor(std::nullopt);
}

TwoFactorState SetTwoFactor(bool enabled, const QString &password) {
	return RequestTwoFactor(enabled, password);
}

ConfirmResult ConfirmEmail(const QString &user, const QString &code) {
	ConfirmResult out;
	try {
		const auto errorCode = parvane::v2::account::confirmEmail(GatewayUrl().toStdString(),
			user.toStdString(), code.trimmed().toStdString());
		out.ok = errorCode.empty();
		if (!out.ok) {
			out.error = V2ErrorText(errorCode, tr::lng_parvane_bad_code(tr::now));
		}
	} catch (const std::exception &e) {
		out.ok = false;
		out.error = ErrorTextOf(e, tr::lng_parvane_bad_code(tr::now));
		LOG(("Parvane: ConfirmEmail exception: %1").arg(QString::fromUtf8(e.what())));
	}
	return out;
}

void SetToken(const QString &token) {
	{
		std::lock_guard<std::mutex> lk(g_sessionMutex);
		g_token = token;
	}
	std::lock_guard<std::mutex> lk(g_v2Mutex);
	g_v2Token = token.toStdString(); // v2-сессия берёт JWT при переподключении
}

QString Token() {
	std::lock_guard<std::mutex> lk(g_sessionMutex);
	return g_token;
}

} // namespace Parvane
