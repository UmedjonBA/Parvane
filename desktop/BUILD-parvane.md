# Сборка форка (Parvane desktop) на Arch без root

Воспроизводимый рецепт нативной сборки `desktop/tdesktop` против системных
библиотек Arch + локального sysroot (без `sudo`, без Docker). Проверено на:
Arch Linux, Qt6 6.11, cmake 4.3, gcc 16, 12 ядер / 16 ГБ.

> Зачем sysroot: часть dev-зависимостей не установлена в системе, а `sudo` нет.
> Мы скачиваем нужные Arch-пакеты с зеркала и распаковываем их в
> `~/.local/parvane-sysroot`, не трогая систему и установленный `telegram-desktop`.

## 0. Предпосылки (уже есть в системе)

Qt6 (base/svg/imageformats/wayland), ffmpeg, openssl, openal, abseil-cpp,
protobuf, lz4, xxhash, hunspell, rnnoise, opus, ada, minizip, glibmm, cmake,
ninja, gcc/clang, python3.

## 1. Локальный sysroot из Arch-пакетов (без root)

```bash
SR=~/.local/parvane-sysroot
mkdir -p "$SR" ~/.local/bin /tmp/pvpkg && cd /tmp/pvpkg
# URL берём через pacman (root не нужен): pacman -Sp <pkg>
for pkg in boost boost-libs libtg_owt gperf; do
  url=$(pacman -Sp "$pkg" | tail -1)
  case "$url" in file://*) cp "${url#file://}" . ;; *) curl -fsSL -O "$url" ;; esac
done
for f in *.pkg.tar.zst; do tar --use-compress-program=unzstd -xf "$f" -C "$SR"; done
cp "$SR/usr/bin/gperf" ~/.local/bin/      # gperf на PATH для tde2e
```

Даёт: Boost (+cmake), `tg_owt` (WebRTC, +cmake), `gperf`.

## 2. tde2e (E2E-библиотека) из исходников

`tde2e` отдельным пакетом в Arch нет; на Linux cmake форсит
`find_package(tde2e REQUIRED)`. Собираем из `tdlib/td` @ `51743df` с
`-DTD_E2E_ONLY=ON` (только E2E-подмножество) и ставим в sysroot.

```bash
export PATH="$HOME/.local/bin:$PATH"
SR=~/.local/parvane-sysroot/usr
cd desktop && git clone https://github.com/tdlib/td.git tde2e-src
cd tde2e-src && git fetch --depth 1 origin 51743df && git checkout 51743df
cmake -B build -G Ninja -DCMAKE_BUILD_TYPE=Debug \
  -DCMAKE_INSTALL_PREFIX="$SR" -DTD_E2E_ONLY=ON \
  -DGPERF_EXECUTABLE="$HOME/.local/bin/gperf" -DOPENSSL_ROOT_DIR=/usr
cmake --build build --target install
```

## 3. Патч libdispatch (системная сборка на Arch)

Upstream пропускает модуль `dispatch` (`desktop_app_skip_libs` в корневом
`CMakeLists.txt`) и рассчитывает, что на Linux crl соберётся без него. Но на Arch
установлены заголовки `/usr/include/dispatch/*` (пакет `libdispatch`), поэтому
исходники `Telegram/lib_crl/crl/dispatch/*.cpp` включают dispatch-бэкенд и требуют
`libdispatch` при линковке — иначе `undefined reference to dispatch_*`. Два правки
(уже закоммичены в форк):

1. **`CMakeLists.txt`** — убрать `dispatch` из `set(desktop_app_skip_libs …)`,
   чтобы под-CMakeLists модуля обрабатывался и создавал target `external_dispatch`.
2. **`cmake/external/dispatch/CMakeLists.txt`** — снять гейт `DESKTOP_APP_USE_PACKAGED`
   с поиска системной либы: всегда `find_library(... dispatch)` /
   `find_path(... dispatch/dispatch.h)` и линковать найденный `libdispatch.so`,
   минуя bundled-сборку (исходников bundled dispatch в клоне нет).

> Альтернатива без правок — собирать там, где dev-заголовков libdispatch нет; тогда
> crl сам падает на common-queue. Но на Arch с установленным `libdispatch` правки
> нужны. `find_library` находит `/usr/lib/libdispatch.so`.

## 4. Конфигурация и сборка форка

```bash
export PATH="$HOME/.local/bin:$PATH"
SR=~/.local/parvane-sysroot/usr
cd desktop/tdesktop
cmake -B ../build-probe -G Ninja \
  -DCMAKE_BUILD_TYPE=Debug \
  -DDESKTOP_APP_USE_PACKAGED=ON \
  -DCMAKE_PREFIX_PATH="$SR" \
  -DTDESKTOP_API_ID=17349 \
  -DTDESKTOP_API_HASH=344583e45741c457fe1862106095a5eb \
  -DDESKTOP_APP_DISABLE_AUTOUPDATE=ON \
  -DDESKTOP_APP_DISABLE_CRASH_REPORTS=ON
nice -n 10 ninja -C ../build-probe -j6      # -j6: щадим 16 ГБ RAM
```

`DESKTOP_APP_USE_PACKAGED=ON` — режим системных библиотек (как в Arch-пакете);
без него tdesktop пытается собирать зависимости bundled-путём (для Docker-сборки).

> `api_id/hash` здесь — заглушки для компиляции; после врезки Parvane-транспорта
> (Фаза 2) реальные креды Telegram не нужны — клиент ходит в NATS, не в MTProto.

Готовый бинарь: `desktop/build-probe/bin/Telegram` (переименуем в фазе брендинга).

## Обновление upstream

См. `desktop/UPSTREAM` (тег/коммит). Версии tde2e/tg_owt в новом теге —
сверять по `Telegram/build/prepare/prepare.py` (stage 'tde2e', 'tg_owt').

## 5. Пропавшие системные пакеты (2026-09-03) — всё в sysroot без root
После чистки системы исчезли `lld`, `gobject-introspection` (g-ir-scanner),
`python-setuptools` (+ цепочка jaraco/more-itertools/packaging), `libdispatch`,
`boost` (заголовки) и `/usr/bin/cargo`. Кэш сборки помнил `/usr/...` пути, cmake
падал ещё на пробе компилятора (`-fuse-ld=lld`). Рецепт восстановления —
всё из `/var/cache/pacman/pkg` (или `pacman -Sp`) в `~/.local/parvane-sysroot`:
```bash
SR=~/.local/parvane-sysroot
for p in lld gobject-introspection libdispatch python-setuptools \
         python-jaraco.functools python-jaraco.text python-jaraco.context \
         python-jaraco.collections python-more-itertools python-packaging \
         python-autocommand python-platformdirs python-wheel; do
  tar --use-compress-program=unzstd -xf /var/cache/pacman/pkg/$p-*.pkg.tar.zst -C "$SR"
done
# distutils для giscanner на Python ≥3.12: шим на setuptools/_distutils
SP=$(ls -d $SR/usr/lib/python3.*/site-packages | tail -1)
mkdir -p $SR/pyshim && ln -sfn $SP/setuptools/_distutils $SR/pyshim/distutils
```
Обёртки в `~/.local/bin` (лежат вне репо): `ld.lld` — exec sysroot-бинаря с
`LD_LIBRARY_PATH=$SR/usr/lib`; `g-ir-scanner` — то же плюс
`PYTHONPATH=$SR/pyshim:$SP`. Затем перенастроить кэш:
```bash
cmake -S desktop/tdesktop -B desktop/build-probe \
  -DCARGO_EXE=$HOME/.cargo/bin/cargo \
  -DDESKTOP_APP_GIRSCANNER=$HOME/.local/bin/g-ir-scanner \
  -DDESKTOP_APP_DISPATCH_LIBRARIES=$SR/usr/lib/libdispatch.so \
  -DDESKTOP_APP_DISPATCH_INCLUDE_DIRS=$SR/usr/include
```
Проверка, что build.ninja не ссылается на пропавшее (осторожно: паттерн
`/usr/lib/` матчит и подстроки sysroot-путей — смотреть полный токен):
`grep -o "[^ ]*/usr/bin/[^ ]*" build.ninja | sort -u | while read f; do [ -e "$f" ] || echo MISSING $f; done`.

## 6. Переезд на новую систему (2026-09-05)
Пути в кэше сборки абсолютные (`/home/ub/Projects/active/...`, `~/.cargo`,
`~/.local/parvane-sysroot`) — после переноса $HOME достаточно восстановить их
симлинками, кэш переживает. Дополнительно понадобилось:
- `gdbus-codegen` (пакет `glib2-devel`) — в sysroot без root, скрипт сам находит
  `../share/glib-2.0/codegen`:
  ```bash
  cd /tmp && curl -fsSL -O "$(pacman -Sp glib2-devel | tail -1)"
  tar --use-compress-program=unzstd -xf glib2-devel-*.pkg.tar.zst -C "$SR" \
    usr/bin/gdbus-codegen usr/share/glib-2.0/codegen
  ```
  и к cmake-реконфигу из п. 5 добавить `-DDESKTOP_APP_GDBUSCODEGEN=$SR/usr/bin/gdbus-codegen`.
- Смена мажора protobuf в системе (36 → 35) → старый бинарь не стартует
  (`libprotobuf-lite.so.36 not found`), нужна полная пересборка; cmake сам
  подхватывает новый `protoc`.
- Финальная линковка `Telegram` (Debug, lld) держит ~10 ГБ. Если сборку гоняет
  агент, его харнесс убивает фоновые задачи при нехватке памяти, хотя swap
  свободен — линк запускать отдельным юнитом:
  `systemd-run --user --unit=parvane-ninja-link --collect -p WorkingDirectory=$PWD -E PATH="$PATH" sh -c 'ninja -C desktop/build-probe -j1 > /tmp/ninja.log 2>&1'`.
