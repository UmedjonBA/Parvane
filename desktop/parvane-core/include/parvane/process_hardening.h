// Parvane fork: защита процесса клиента от дампов памяти (ревью безопасности 21 окт 2026).
//
// В памяти клиента — ключи устройства, ключ хранилища, расшифрованная переписка. Дамп при падении
// (systemd-coredump, core-файл) лёг бы на диск открытым текстом, а «ptrace» того же пользователя позволил бы
// читать память живого процесса. Linux: PR_SET_DUMPABLE=0 (нет core-файла, нет присоединения отладчиком без
// CAP_SYS_PTRACE, /proc/<pid>/mem и environ — только root) и RLIMIT_CORE=0. Свой /proc/self процессу доступен.
//
// Только заголовок (inline): android/jni собирает ядро своим списком исходников.
#pragma once

#if defined(__linux__)
#include <sys/prctl.h>
#include <sys/resource.h>
#endif

namespace parvane::hardening {

// Запретить дампы памяти процесса. true — оба запрета поставлены (на не-Linux — ничего не делает, false).
inline bool disableCoreDumps() {
#if defined(__linux__)
    bool ok = ::prctl(PR_SET_DUMPABLE, 0, 0, 0, 0) == 0;
    struct rlimit none {};
    none.rlim_cur = 0;
    none.rlim_max = 0;
    ok = (::setrlimit(RLIMIT_CORE, &none) == 0) && ok;
    return ok;
#else
    return false;
#endif
}

// Текущее состояние (для теста и строки журнала): процесс не «dumpable» и предел core-файла 0.
[[nodiscard]] inline bool coreDumpsDisabled() {
#if defined(__linux__)
    struct rlimit cur {};
    if (::getrlimit(RLIMIT_CORE, &cur) != 0) return false;
    return ::prctl(PR_GET_DUMPABLE, 0, 0, 0, 0) == 0 && cur.rlim_cur == 0 && cur.rlim_max == 0;
#else
    return false;
#endif
}

} // namespace parvane::hardening
