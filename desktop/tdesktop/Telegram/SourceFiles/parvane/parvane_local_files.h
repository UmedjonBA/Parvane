// Parvane fork: временный каталог экземпляра для расшифрованных файлов (ревью безопасности 21 окт 2026).
//
// Файлы, которые нужны по пути (открыть системой, «Сохранить как», загрузить в облако, отдать плееру tdesktop),
// лежат в `<workdir>/tdata/parvane-tmp/<вид>/…` (0700, файлы 0600): у каждого экземпляра (`-workdir`) свой
// каталог, а не общий `$TMPDIR/parvane-*`. Стирается при старте и при выходе со стиранием (`LogOutAndWipe`), не
// сразу — файл должен жить, пока его держит внешнее приложение. Запись — под оградой хранилища: после стирания
// при выходе фоновая задача прежней сессии сюда не пишет. Логика и тесты — parvane-core `local_files`.
#pragma once

#include "settings.h"

#include <parvane/local_files.h>
#include <parvane/storecrypt.h>

#include <QtCore/QByteArray>
#include <QtCore/QDir>
#include <QtCore/QFile>
#include <QtCore/QString>

#include <string_view>

namespace Parvane {

[[nodiscard]] inline QString TdataDir() {
	return cWorkingDir() + u"tdata"_q;
}

// Новый пустой подкаталог `<tdata>/parvane-tmp/<kind>/<случайное имя>`; пусто — не создан (ограда, сбой).
[[nodiscard]] inline QString MakeTempDir(const QString &kind) {
	return QString::fromStdString(parvane::localfiles::makeTempDir(
		TdataDir().toStdString(),
		kind.toStdString()));
}

// Постоянный каталог вида `<tdata>/parvane-tmp/<kind>` (один на запуск); пусто — не создан.
[[nodiscard]] inline QString TempKindDir(const QString &kind) {
	return QString::fromStdString(parvane::localfiles::tempKindDir(
		TdataDir().toStdString(),
		kind.toStdString()));
}

// Открытый файл во временном каталоге: атомарно, 0600, под оградой хранилища.
inline bool WriteTempFile(const QString &path, const QByteArray &bytes) {
	return parvane::storecrypt::writeRawFile(
		QFile::encodeName(path).toStdString(),
		std::string_view(bytes.constData(), std::size_t(bytes.size())));
}

inline bool WriteTempFile(const QString &path, const std::string &bytes) {
	return parvane::storecrypt::writeRawFile(QFile::encodeName(path).toStdString(), bytes);
}

// Значение, которому не место в журнале клиента (текст сообщения, координаты, токен ссылки, SAS звонка, имя
// файла): в релизе — отметка с длиной, в dev-сборке — как есть (verify_*.sh сверяют строки). parvane-core logpriv.
[[nodiscard]] inline QString LogSecret(const QString &value) {
	return QString::fromStdString(parvane::logpriv::secret(value.toStdString()));
}

[[nodiscard]] inline QString LogSecret(double value) {
	return LogSecret(QString(u"%1"_q).arg(value)); // dev — тот же вид, что у .arg(double)
}

} // namespace Parvane
