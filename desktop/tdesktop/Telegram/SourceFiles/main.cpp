/*
This file is part of Telegram Desktop,
the official desktop application for the Telegram messaging service.

For license and copyright information please follow this link:
https://github.com/telegramdesktop/tdesktop/blob/master/LEGAL
*/
#include "core/launcher.h"

#include <parvane/local_files.h>       // Parvane: logpriv::devBuild (ставится до main)
#include <parvane/process_hardening.h> // Parvane: запрет дампов памяти

#include <cstdio>
#include <cstdlib>
#include <cstring>

// Parvane (spec 035, FR-046, манифест выпуска T144): `engineInfo()` движка этой сборки — C ABI parvane-protocol
extern "C" char *pv_engine_info();
extern "C" void pv_free_string(char *s);

int main(int argc, char *argv[]) {
	// `parvane-desktop --engine-info` — версии движка в JSON и выход, без Qt и профиля
	// (scripts/make_release_manifest.sh, scripts/verify_release_manifest.sh)
	if (argc == 2 && std::strcmp(argv[1], "--engine-info") == 0) {
		char *info = pv_engine_info();
		if (!info) {
			return 1;
		}
		std::fputs(info, stdout);
		std::fputc('\n', stdout);
		pv_free_string(info);
		return 0;
	}
	// Parvane (ревью 21 окт 2026): в памяти — ключи устройства и хранилища, расшифрованная переписка; ни core-файла,
	// ни присоединения ptrace того же пользователя. Dev-сборка может оставить дампы для отладки:
	// PARVANE_ALLOW_COREDUMP=1. Сборщик падений tdesktop выключен (DESKTOP_APP_DISABLE_CRASH_REPORTS).
	{
		const char *allow = std::getenv("PARVANE_ALLOW_COREDUMP");
		const bool keep = parvane::logpriv::devBuild()
			&& allow
			&& std::strcmp(allow, "1") == 0;
		if (!keep) {
			parvane::hardening::disableCoreDumps();
		}
	}
	const auto launcher = Core::Launcher::Create(argc, argv);
	return launcher ? launcher->exec() : 1;
}
