// Parvane fork: см. intro_parvane.h.
#include "intro/intro_parvane.h"

#include "intro/intro_widget.h"
#include "parvane/parvane_client.h"
#include "ui/widgets/fields/input_field.h"
#include "ui/widgets/fields/password_input.h"
#include "ui/widgets/buttons.h"
#include "ui/abstract_button.h"
#include "ui/painter.h"
#include "styles/style_intro.h"

#include <crl/crl_async.h>
#include <crl/crl_on_main.h>

#include "base/call_delayed.h"

#include <QtWidgets/QLineEdit>
#include <QtCore/QDateTime>
#include <QtCore/QFile>

#include <cstdlib>

namespace Intro {
namespace details {
namespace {

// Глаз рисуем вручную: иконки eye в ресурсах tdesktop нет, а тащить новый
// ресурс ради одной кнопки — лишний виток кодогенерации.
void PaintEye(QPainter &p, QRect rect, bool crossed, QColor color) {
	auto hq = PainterHighQualityEnabler(p);
	auto pen = QPen(color);
	pen.setWidthF(1.4);
	pen.setCapStyle(Qt::RoundCap);
	pen.setJoinStyle(Qt::RoundJoin);
	p.setPen(pen);
	p.setBrush(Qt::NoBrush);
	const auto cx = rect.center().x() + 0.5;
	const auto cy = rect.center().y() + 0.5;
	const auto w = rect.width() * 0.34;
	const auto h = rect.height() * 0.17;
	auto path = QPainterPath();
	path.moveTo(cx - w, cy);
	path.quadTo(cx, cy - h * 2.6, cx + w, cy);
	path.quadTo(cx, cy + h * 2.6, cx - w, cy);
	p.drawPath(path);
	p.drawEllipse(QPointF(cx, cy), h * 0.85, h * 0.85);
	if (crossed) {
		p.drawLine(
			QPointF(cx - w * 0.9, cy + h * 2.0),
			QPointF(cx + w * 0.9, cy - h * 2.0));
	}
}

constexpr auto kEyeSize = 28;

} // namespace


ParvaneWidget::ParvaneWidget(
	QWidget *parent,
	not_null<Main::Account*> account,
	not_null<Data*> data)
: Step(parent, account, data)
, _user(this, st::introName, rpl::single(u"ник"_q))
, _password(this, st::introPassword, rpl::single(u"пароль"_q))
, _email(this, st::introName, rpl::single(u"email для подтверждения"_q))
, _code(this, st::introName, rpl::single(u"код из письма (6 цифр)"_q))
, _tgLink(this, st::introName, rpl::single(u"ссылка на бота"_q))
, _showPassword(this)
, _switchMode(this, QString(), st::introLink) {
	setTitleText(rpl::single(u"Parvane"_q));
	setErrorCentered(true);
	_tgLink->hide();

	_showPassword->resize(kEyeSize, kEyeSize);
	_showPassword->setPointerCursor(true);
	_showPassword->paintRequest(
	) | rpl::on_next([=](QRect) {
		auto p = QPainter(_showPassword.data());
		PaintEye(
			p,
			_showPassword->rect(),
			_passwordShown,
			(_showPassword->isOver()
				? st::introLink.overColor
				: st::introLink.color)->c);
	}, _showPassword->lifetime());
	_showPassword->setClickedCallback([=] { togglePasswordShown(); });
	_showPassword->hide();

	_switchMode->setClickedCallback([=] {
		setMode(_mode == Mode::SignIn ? Mode::SignUp : Mode::SignIn);
	});
	setMode(Mode::SignIn);

	_user->submits(
	) | rpl::on_next([=] { submit(); }, _user->lifetime());
	connect(_password, &Ui::MaskedInputField::submitted, [=] { submit(); });
	_email->submits(
	) | rpl::on_next([=] { submit(); }, _email->lifetime());
	_code->submits(
	) | rpl::on_next([=] { submit(); }, _code->lifetime());
	_email->hide();
	_code->hide();

	setMouseTracking(true);
}

void ParvaneWidget::setStage(Stage stage) {
	_stage = stage;
	const auto login = (stage == Stage::Login);
	_user->setVisible(login);
	_password->setVisible(login);
	_showPassword->setVisible(login);
	_switchMode->setVisible(login);
	_email->setVisible(stage == Stage::Email);
	_code->setVisible(stage == Stage::Code);
	_tgLink->setVisible(stage == Stage::Telegram);
	if (stage == Stage::Telegram) {
		setDescriptionText(rpl::single(_tgMode == TelegramMode::Login
			? u"Двухфакторный вход: откройте бота по ссылке и нажмите Start. Подтвердить может только привязанный Telegram"_q
			: u"Подтверждение через Telegram: откройте бота по ссылке и нажмите Start — вход произойдёт сам"_q));
		_tgLink->setFocus();
	} else if (stage == Stage::Email) {
		setDescriptionText(rpl::single(
			u"Регистрация: укажите email — на него придёт код подтверждения"_q));
		_email->setFocus();
	} else if (stage == Stage::Code) {
		setDescriptionText(rpl::single(
			u"Введите 6-значный код из письма"_q));
		_code->setFocus();
	} else {
		setDescriptionText(rpl::single(_mode == Mode::SignIn
			? u"Вход в аккаунт"_q
			: u"Создание аккаунта"_q));
		_user->setFocus();
	}
	_switchMode->setVisible(login);
	updateControlsGeometry();
}

void ParvaneWidget::startTelegram(
		const QString &user,
		const QString &password,
		const QString &token,
		const QString &bot,
		TelegramMode mode) {
	_tgUser = user;
	_tgPassword = password;
	_tgToken = token;
	_tgMode = mode;
	_tgGeneration++;
	_tgStartedAt = QDateTime::currentSecsSinceEpoch();
	const auto botName = bot.isEmpty() ? _serverBot : bot;
	const auto link = u"https://t.me/"_q + botName + u"?start="_q + token;
	_tgLink->setText(link);
	// Headless e2e: токен виден в логе, «бот» подтверждает через gateway
	LOG(("Parvane: Telegram %1 — ждём подтверждения, token=%2 bot=%3")
		.arg(mode == TelegramMode::Login ? u"вход"_q : u"регистрация"_q, token, botName));
	_requesting = false;
	hideError();
	setStage(Stage::Telegram);
	const auto weak = base::make_weak(this);
	const auto generation = _tgGeneration;
	base::call_delayed(2000, weak, [=] {
		if (_tgGeneration == generation) {
			pollTelegram();
		}
	});
}

void ParvaneWidget::pollTelegram() {
	if (_stage != Stage::Telegram || _requesting) {
		return;
	}
	if (QDateTime::currentSecsSinceEpoch() - _tgStartedAt > 14 * 60) {
		showError(rpl::single(u"Ссылка устарела — войдите заново"_q));
		setStage(Stage::Login);
		return;
	}
	const auto weak = base::make_weak(this);
	const auto generation = _tgGeneration;
	const auto user = _tgUser;
	const auto password = _tgPassword;
	const auto token = _tgToken;
	const auto mode = _tgMode;
	crl::async([=] {
		const auto confirmed = Parvane::RegisterStatus(user, token);
		crl::on_main(weak, [=] {
			if (_tgGeneration != generation || _stage != Stage::Telegram) {
				return;
			}
			if (!confirmed) {
				base::call_delayed(2000, weak, [=] {
					if (_tgGeneration == generation) {
						pollTelegram();
					}
				});
				return;
			}
			_requesting = true;
			crl::async([=] {
				// Регистрация: обычный вход; 2FA: JWT только с подтверждённым
				// login_token (устройство становится доверенным)
				auto res = Parvane::Issue(user, password,
					mode == TelegramMode::Login ? token : QString());
				crl::on_main(weak, [=, res = std::move(res)] {
					onIssued(user, res.ok, res.token, res.error);
				});
			});
		});
	});
}

void ParvaneWidget::resizeEvent(QResizeEvent *e) {
	Step::resizeEvent(e);
	updateControlsGeometry();
}

void ParvaneWidget::updateControlsGeometry() {
	const auto firstTop = contentTop() + st::introStepFieldTop;
	const auto secondTop = firstTop
		+ st::introName.heightMin
		+ st::introPhoneTop;
	_user->moveToLeft(contentLeft(), firstTop);
	_password->moveToLeft(contentLeft(), secondTop);
	_email->moveToLeft(contentLeft(), firstTop);
	_code->moveToLeft(contentLeft(), firstTop);
	_tgLink->moveToLeft(contentLeft(), firstTop);
	// Глазок — внутри строки пароля у правого края
	_showPassword->moveToRight(
		contentLeft(),
		secondTop + (st::introPassword.heightMin - _showPassword->height()) / 2);
	// Переключатель «вход ↔ регистрация» — отдельной строкой под паролем
	_switchMode->moveToLeft(
		contentLeft(),
		secondTop + st::introPassword.heightMin + st::introPhoneTop / 2);
}

void ParvaneWidget::setInnerFocus() {
	_user->setFocusFast();
}

void ParvaneWidget::activate() {
	Step::activate();
	_user->show();
	_password->show();
	_showPassword->show();
	_switchMode->show();
	setInnerFocus();

	// Debug-хук для headless e2e: PARVANE_AUTOLOGIN=user[@server]:password
	// автозаполняет поля и отправляет форму один раз. В обычном запуске
	// переменная не задана и хук не срабатывает.
	if (!_autologinTried) {
		_autologinTried = true;
		if (const char *v = std::getenv("PARVANE_AUTOLOGIN"); v && *v) {
			const auto spec = QString::fromUtf8(v);
			const auto sep = spec.indexOf(':');
			if (sep > 0) {
				_user->setText(spec.left(sep));
				_password->setText(spec.mid(sep + 1));
				// PARVANE_AUTOEMAIL=addr — email для headless-регистрации через почту.
				if (const char *em = std::getenv("PARVANE_AUTOEMAIL"); em && *em) {
					_email->setText(QString::fromUtf8(em));
				}
				LOG(("Parvane: autologin hook for %1").arg(spec.left(sep)));
				_autologinActive = true;
				submit();
			}
		}
	}
}

void ParvaneWidget::togglePasswordShown() {
	_passwordShown = !_passwordShown;
	_password->setEchoMode(_passwordShown
		? QLineEdit::Normal
		: QLineEdit::Password);
	_showPassword->update();
	_password->setFocus();
}

void ParvaneWidget::setMode(Mode mode) {
	_mode = mode;
	const auto signIn = (mode == Mode::SignIn);
	_switchMode->setText(signIn
		? u"Нет аккаунта? Зарегистрироваться"_q
		: u"Уже есть аккаунт? Войти"_q);
	_nextText = signIn ? u"Войти"_q : u"Создать аккаунт"_q;
	if (_stage == Stage::Login) {
		setDescriptionText(rpl::single(signIn
			? u"Вход в аккаунт"_q
			: u"Создание аккаунта"_q));
	}
	hideError();
	updateControlsGeometry();
}

rpl::producer<QString> ParvaneWidget::nextButtonText() const {
	return _nextText.value();
}

void ParvaneWidget::startCodeFilePoll() {
	const char *cf = std::getenv("PARVANE_AUTOCODE_FILE");
	if (!cf || !*cf) {
		return;
	}
	const auto path = QString::fromUtf8(cf);
	const auto weak = base::make_weak(this);
	const auto poll = std::make_shared<Fn<void(int)>>();
	*poll = [=](int left) {
		if (!weak || left <= 0 || _stage != Stage::Code || _requesting) {
			return;
		}
		QFile f(path);
		if (f.open(QIODevice::ReadOnly)) {
			const auto c = QString::fromUtf8(f.readAll()).trimmed();
			if (c.size() == 6 && c != _lastCodeTried) {
				_lastCodeTried = c;
				_code->setText(c);
				submit();
				return;
			}
		}
		base::call_delayed(1000, weak, [=] { (*poll)(left - 1); });
	};
	(*poll)(120);
}

void ParvaneWidget::finishLogin(const QString &user, const QString &password) {
	const auto weak = base::make_weak(this);
	crl::async([=] {
		auto res = Parvane::Issue(user, password);
		crl::on_main(weak, [=, res = std::move(res)] {
			onIssued(user, res.ok, res.token, res.error);
		});
	});
}

void ParvaneWidget::submit() {
	if (_requesting) {
		return;
	}
	const auto rawUser = _user->getLastText().trimmed();
	const auto password = _password->getLastText();
	if (_stage == Stage::Login) {
		if (rawUser.isEmpty()) {
			showError(rpl::single(u"Укажите ник"_q));
			_user->setFocus();
			return;
		}
		if (password.isEmpty()) {
			showError(rpl::single(u"Укажите пароль"_q));
			_password->setFocus();
			return;
		}
	}
	_requesting = true;
	hideError();
	const auto weak = base::make_weak(this);
	const auto stage = _stage;
	const auto email = _email->getLastText().trimmed();
	const auto code = _code->getLastText().trimmed();

	// Домен сервера подтягиваем один раз (identity.server.info): голый ник →
	// ник@домен, режим подтверждения (telegram/email) и имя бота
	if (!_serverInfoLoaded) {
		crl::async([=] {
			const auto info = Parvane::FetchServerInfo();
			crl::on_main(weak, [=] {
				_serverDomain = info.domain;
				_serverConfirm = info.confirm;
				_serverBot = info.telegramBot;
				_serverInfoLoaded = true;
				_requesting = false;
				submit();
			});
		});
		return;
	}
	const auto user = Parvane::CanonicalAddress(rawUser, _serverDomain);
	if (stage == Stage::Telegram) {
		// Кнопка на экране Telegram — проверить сразу, не дожидаясь таймера
		_requesting = false;
		pollTelegram();
		return;
	}

	if (stage == Stage::Code) {
		// Код из письма → identity.email.confirm → обычный вход.
		crl::async([=] {
			const auto r = Parvane::ConfirmEmail(user, code);
			crl::on_main(weak, [=] {
				_requesting = false;
				if (!r.ok) {
					showError(rpl::single(r.error.isEmpty() ? u"Неверный код"_q : r.error));
					_code->setFocus();
					startCodeFilePoll(); // headless: ждём следующий код
					return;
				}
				finishLogin(user, password);
			});
		});
		return;
	}
	if (stage == Stage::Email) {
		crl::async([=] {
			const auto reg = Parvane::Register(user, password, email);
			crl::on_main(weak, [=] {
				_requesting = false;
				if (!reg.ok) {
					showError(rpl::single(reg.error.isEmpty()
						? u"Ошибка регистрации"_q : reg.error));
					_email->setFocus();
					return;
				}
				if (reg.confirmRequired && !reg.telegramToken.isEmpty()) {
					startTelegram(user, password, reg.telegramToken, QString(), TelegramMode::Register);
				} else if (reg.confirmRequired) {
					setStage(Stage::Code);
				} else {
					finishLogin(user, password);
				}
			});
		});
		return;
	}
	const auto mode = _mode;
	crl::async([=] {
		// Вход и регистрация РАЗДЕЛЕНЫ. Раньше это была одна ветка: не удался
		// issue — молча звали register, и пользователь не понимал, вошёл он или
		// завёл новый аккаунт (а опечатка в нике создавала пустой аккаунт).
		auto res = Parvane::IssueResult();
		auto next = Stage::Login;
		auto telegramToken = QString();
		if (mode == Mode::SignUp) {
			const auto reg = Parvane::Register(user, password, email);
			if (!reg.ok) {
				if (reg.error.contains(u"email"_q, Qt::CaseInsensitive)) {
					next = Stage::Email; // сервер требует почту — спросим её
				} else {
					res.error = reg.error.isEmpty()
						? u"Не удалось создать аккаунт"_q
						: reg.error;
				}
			} else if (reg.confirmRequired && !reg.telegramToken.isEmpty()) {
				next = Stage::Telegram;
				telegramToken = reg.telegramToken;
			} else if (reg.confirmRequired) {
				next = Stage::Code;
			} else {
				res = Parvane::Issue(user, password);
			}
		} else {
			res = Parvane::Issue(user, password);
			if (!res.ok && res.twofaRequired) {
				// Пароль верен, включён двухфакторный вход — экран Telegram
				next = Stage::Telegram;
				telegramToken = res.loginToken;
			} else if (!res.ok
				&& res.error.contains(u"почта не подтверждена"_q)) {
				// Аккаунт есть, но ждёт подтверждения: повторный register
				// перевысылает код / выдаёт новый токен Telegram
				const auto reg = Parvane::Register(user, password, email);
				if (!reg.telegramToken.isEmpty()) {
					next = Stage::Telegram;
					telegramToken = reg.telegramToken;
				} else {
					next = Stage::Code;
				}
			} else if (!res.ok && res.error.isEmpty()) {
				res.error = u"Неверный ник или пароль"_q;
			}
		}
		const auto twofaBot = res.telegramBot;
		const auto twofa = res.twofaRequired;
		crl::on_main(weak, [=, res = std::move(res)] {
			if (next == Stage::Telegram) {
				startTelegram(user, password, telegramToken, twofaBot,
					twofa ? TelegramMode::Login : TelegramMode::Register);
				return;
			}
			if (next != Stage::Login) {
				_requesting = false;
				hideError();
				setStage(next);
				if (next == Stage::Code) {
					startCodeFilePoll();
				} else if (next == Stage::Email && !email.isEmpty()) {
					submit(); // autologin с PARVANE_AUTOEMAIL — шлём сразу
				}
				return;
			}
			onIssued(user, res.ok, res.token, res.error);
		});
	});
}

void ParvaneWidget::onIssued(
		const QString &user,
		bool ok,
		QString token,
		QString error) {
	_requesting = false;
	if (!ok) {
		// Headless-хук: аккаунта может не быть (e2e регистрируют на лету) —
		// прежний экран заводил его молча; для хука сохраняем это, для человека
		// вход и регистрация теперь разделены.
		if (_autologinActive && !_autologinRegisterTried
			&& _mode == Mode::SignIn && _stage == Stage::Login) {
			_autologinRegisterTried = true;
			LOG(("Parvane: autologin — вход отклонён (%1), пробуем регистрацию")
				.arg(error));
			setMode(Mode::SignUp);
			submit();
			return;
		}
		if (_stage == Stage::Telegram) {
			// После подтверждения выдача не удалась — назад к паролю
			setStage(Stage::Login);
		}
		// В режиме входа подсказываем, что аккаунта может не быть: молча
		// заводить его мы больше не станем, переключение — осознанное.
		const auto hint = (_mode == Mode::SignIn && !error.contains(u"пароль"_q))
			? u" Если аккаунта ещё нет — нажмите «Зарегистрироваться»."_q
			: QString();
		showError(rpl::single(
			(error.isEmpty() ? u"Не удалось войти"_q : error) + hint));
		_password->setFocus();
		return;
	}
	// Запоминаем себя (адрес+JWT) и поднимаем персистентную сессию шины на
	// воркер-потоке (connect блокирующий, но локальный и быстрый). Сессия нужна
	// для зеркалирования исходящих (Фаза 3b) и приёма (Фаза 3c).
	Parvane::SetSelf(user, token);
	crl::async([] { Parvane::StartSession(); });
	loginSucceeded(user);
}

void ParvaneWidget::loginSucceeded(const QString &user) {
	// Синтезируем себя как MTPUser (как Account::createSession для legacy-данных),
	// затем создаём сессию НАПРЯМУЮ, минуя messages.getDialogFilters (он требует
	// живого MTProto). Список диалогов наполнит msg.sync.* в Фазе 3.
	const auto self = MTP_user(
		MTP_flags(MTPDuser::Flag::f_self | MTPDuser::Flag::f_first_name),
		MTP_long(Parvane::IdForAddress(user)),
		MTPlong(),           // access_hash
		MTP_string(user),    // first_name — показываем адрес
		MTPstring(),         // last_name
		MTPstring(),         // username
		MTPstring(),         // phone
		MTPUserProfilePhoto(),
		MTPUserStatus(),
		MTPint(),            // bot_info_version
		MTPVector<MTPRestrictionReason>(),
		MTPstring(),         // bot_inline_placeholder
		MTPstring(),         // lang_code
		MTPEmojiStatus(),
		MTPVector<MTPUsername>(),
		MTPRecentStory(),
		MTPPeerColor(),      // color
		MTPPeerColor(),      // profile_color
		MTPint(),            // bot_active_users
		MTPlong(),           // bot_verification_icon
		MTPlong());          // send_paid_messages_stars

	LOG(("Parvane: login OK for %1, creating session").arg(user));
	createSession(self, QImage(), QVector<MTPDialogFilter>(), false);
	// "this" удалён внутри createSession — больше ничего не трогаем.
}

} // namespace details
} // namespace Intro
