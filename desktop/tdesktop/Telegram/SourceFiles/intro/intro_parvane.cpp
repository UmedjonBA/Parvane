// Parvane fork: см. intro_parvane.h.
#include "intro/intro_parvane.h"

#include "intro/intro_widget.h"
#include "parvane/parvane_client.h"
#include "ui/widgets/fields/input_field.h"
#include "ui/widgets/fields/password_input.h"
#include "styles/style_intro.h"

#include <crl/crl_async.h>
#include <crl/crl_on_main.h>

#include "base/call_delayed.h"

#include <QtCore/QFile>

#include <cstdlib>

namespace Intro {
namespace details {

ParvaneWidget::ParvaneWidget(
	QWidget *parent,
	not_null<Main::Account*> account,
	not_null<Data*> data)
: Step(parent, account, data)
, _user(this, st::introName, rpl::single(u"user@server"_q))
, _password(this, st::introPassword, rpl::single(u"пароль"_q))
, _email(this, st::introName, rpl::single(u"email для подтверждения"_q))
, _code(this, st::introName, rpl::single(u"код из письма (6 цифр)"_q)) {
	setTitleText(rpl::single(u"Parvane"_q));
	setDescriptionText(rpl::single(u"Вход через шард identity"_q));
	setErrorCentered(true);

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
	_email->setVisible(stage == Stage::Email);
	_code->setVisible(stage == Stage::Code);
	if (stage == Stage::Email) {
		setDescriptionText(rpl::single(
			u"Регистрация: укажите email — на него придёт код подтверждения"_q));
		_email->setFocus();
	} else if (stage == Stage::Code) {
		setDescriptionText(rpl::single(
			u"Введите 6-значный код из письма"_q));
		_code->setFocus();
	} else {
		setDescriptionText(rpl::single(u"Вход через шард identity"_q));
		_user->setFocus();
	}
	updateControlsGeometry();
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
}

void ParvaneWidget::setInnerFocus() {
	_user->setFocusFast();
}

void ParvaneWidget::activate() {
	Step::activate();
	_user->show();
	_password->show();
	setInnerFocus();

	// Debug-хук для headless e2e: PARVANE_AUTOLOGIN=user@server:password
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
				submit();
			}
		}
	}
}

rpl::producer<QString> ParvaneWidget::nextButtonText() const {
	return rpl::single(u"Войти"_q);
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
	const auto user = _user->getLastText().trimmed();
	const auto password = _password->getLastText();
	if (_stage == Stage::Login) {
		if (user.isEmpty()) {
			showError(rpl::single(u"Укажите user@server"_q));
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
				if (reg.confirmRequired) {
					setStage(Stage::Code);
				} else {
					finishLogin(user, password);
				}
			});
		});
		return;
	}
	crl::async([=] {
		// Логин. Если аккаунта нет (issue отделён от регистрации) — регистрируем
		// и логинимся повторно: один экран покрывает вход и регистрацию. При
		// PARVANE_EMAIL_REQUIRED identity просит email («нужен корректный
		// email») → экран email → код; «почта не подтверждена» → экран кода
		// (повторный register перевысылает код на сохранённую почту, как у web).
		auto res = Parvane::Issue(user, password);
		auto next = Stage::Login;
		if (!res.ok) {
			if (res.error.contains(u"почта не подтверждена"_q)) {
				Parvane::Register(user, password, email); // перевысылка кода
				next = Stage::Code;
			} else {
				const auto reg = Parvane::Register(user, password, email);
				if (reg.ok && reg.confirmRequired) {
					next = Stage::Code;
				} else if (reg.ok) {
					res = Parvane::Issue(user, password);
				} else if (reg.error.contains(u"email"_q, Qt::CaseInsensitive)) {
					next = Stage::Email;
				} else if (!reg.error.isEmpty() && !reg.error.contains(u"логин занят"_q)) {
					res.error = reg.error;
				}
			}
		}
		crl::on_main(weak, [=, res = std::move(res)] {
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
		showError(rpl::single(error.isEmpty() ? u"Ошибка входа"_q : error));
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
