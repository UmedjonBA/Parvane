// Parvane fork: см. intro_parvane.h.
#include "intro/intro_parvane.h"

#include "intro/intro_widget.h"
#include "parvane/parvane_client.h"
#include "ui/widgets/fields/input_field.h"
#include "ui/widgets/fields/password_input.h"
#include "styles/style_intro.h"

#include <crl/crl_async.h>
#include <crl/crl_on_main.h>

#include <cstdlib>

namespace Intro {
namespace details {
namespace {

// Стабильный 64-бит UserId из адреса user@server (FNV-1a, 48 бит, ненулевой).
// Пока identity не выдаёт числовой id — детерминированно выводим из строки,
// чтобы один и тот же пользователь имел один и тот же id между запусками.
[[nodiscard]] uint64 StableUserId(const QString &user) {
	const auto utf8 = user.toUtf8();
	uint64 h = 1469598103934665603ULL; // FNV offset basis
	for (const auto c : utf8) {
		h ^= static_cast<unsigned char>(c);
		h *= 1099511628211ULL; // FNV prime
	}
	h &= ((uint64(1) << 48) - 1); // в безопасный диапазон id
	return h ? h : 1;
}

} // namespace

ParvaneWidget::ParvaneWidget(
	QWidget *parent,
	not_null<Main::Account*> account,
	not_null<Data*> data)
: Step(parent, account, data)
, _user(this, st::introName, rpl::single(u"user@server"_q))
, _password(this, st::introPassword, rpl::single(u"пароль"_q)) {
	setTitleText(rpl::single(u"Parvane"_q));
	setDescriptionText(rpl::single(u"Вход через шард identity"_q));
	setErrorCentered(true);

	_user->submits(
	) | rpl::on_next([=] { submit(); }, _user->lifetime());
	connect(_password, &Ui::MaskedInputField::submitted, [=] { submit(); });

	setMouseTracking(true);
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
				LOG(("Parvane: autologin hook for %1").arg(spec.left(sep)));
				submit();
			}
		}
	}
}

rpl::producer<QString> ParvaneWidget::nextButtonText() const {
	return rpl::single(u"Войти"_q);
}

void ParvaneWidget::submit() {
	if (_requesting) {
		return;
	}
	const auto user = _user->getLastText().trimmed();
	const auto password = _password->getLastText();
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

	_requesting = true;
	hideError();

	const auto weak = base::make_weak(this);
	crl::async([=] {
		auto res = Parvane::Issue(user, password);
		crl::on_main(weak, [=, res = std::move(res)] {
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
	Parvane::SetToken(token);
	loginSucceeded(user);
}

void ParvaneWidget::loginSucceeded(const QString &user) {
	// Синтезируем себя как MTPUser (как Account::createSession для legacy-данных),
	// затем создаём сессию НАПРЯМУЮ, минуя messages.getDialogFilters (он требует
	// живого MTProto). Список диалогов наполнит msg.sync.* в Фазе 3.
	const auto self = MTP_user(
		MTP_flags(MTPDuser::Flag::f_self),
		MTP_long(StableUserId(user)),
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
