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
