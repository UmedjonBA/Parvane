#!/usr/bin/env bash
# Parvane Android, стадия 3: Telegram X (GPL-3, TGX-Android/Telegram-X) поверх
# нашего шва. Клон X живёт ВНЕ репозитория (/mnt/hdd/ub/android/tgx, сабмодули
# ~1 ГБ); здесь — оверлей: подмена модуля tdlib (наш Client.kt + ParvaneStore +
# ParvaneCore + libparvane_jni.so вместо libtdjni.so), правка CMake (без tdjni),
# local.properties. Повторяемо: скрипт идемпотентен.
#   ./setup-tgx.sh            — наложить оверлей на существующий клон
#   ./setup-tgx.sh --build    — … и собрать assembleLatestArm64Debug
# Тулчейн X: JDK 21, Gradle 9.7 (wrapper), AGP 9.4, NDK r27d (27.3.13750724).
set -Eeuo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TGX="${TGX_DIR:-/mnt/hdd/ub/android/tgx}"
SDK="${ANDROID_HOME:-/mnt/hdd/ub/android/sdk}"
JDK21="${JDK21:-/mnt/hdd/ub/android/jdk-21}"
KEYS="${PARVANE_KEYS:-/mnt/hdd/ub/android/keys}"
[ -d "$TGX/app" ] || { echo "нет клона Telegram X в $TGX: git clone --recursive --depth=1 --shallow-submodules https://github.com/TGX-Android/Telegram-X $TGX"; exit 2; }
[ -x "$JDK21/bin/java" ] || { echo "нет JDK 21 в $JDK21"; exit 2; }

echo "== бандл tdlib: бинарники OpenSSL лежат в Git LFS (без git-lfs — файлы-указатели) =="
export PATH="/mnt/hdd/ub/android/tools/bin:$PATH"
if head -c 40 "$TGX/tdlib/openssl/27.3.13750724/arm64-v8a/lib/libcryptox.so" 2>/dev/null | grep -q "git-lfs"; then
  command -v git-lfs >/dev/null || { echo "нужен git-lfs (tools/bin) — см. BUILD-android.md"; exit 2; }
  (cd "$TGX/tdlib" && git lfs install --local >/dev/null 2>&1 && git lfs pull)
fi

echo "== оверлей tdlib: наш шов вместо TDLib =="
TDLIB="$TGX/tdlib/src/main/java/org/drinkless/tdlib"
mkdir -p "$TDLIB" "$TGX/tdlib/src/main/java/org/parvane/core"
rm -f "$TDLIB/Client.java"
cp "$ROOT/libtd/src/main/java/org/drinkless/tdlib/Client.kt" "$TDLIB/"
cp "$ROOT/libtd/src/main/java/org/drinkless/tdlib/ParvaneStore.kt" "$TDLIB/"
cp "$ROOT/libtd/src/main/java/org/parvane/core/ParvaneCore.kt" "$TGX/tdlib/src/main/java/org/parvane/core/"
# TdApi: у бандла X тот же коммит TDLib (tdlib/version.txt); если версии разойдутся —
# перегенерировать наш (android/BUILD-android.md) и подложить сюда
if [ -f "$TGX/tdlib/version.txt" ]; then
  echo "   TDLib бандла X: $(cat "$TGX/tdlib/version.txt")"
fi
[ -f "$TDLIB/TdApi.java" ] || cp "$ROOT/libtd/src/main/java/org/drinkless/tdlib/TdApi.java" "$TDLIB/"

echo "== нативная либа шва в jniLibs =="
for abi in arm64-v8a x86_64; do
  so="$(find "$ROOT/libtd/build/intermediates" -path "*/$abi/libparvane_jni.so" 2>/dev/null | grep -v Debug | head -1)"
  if [ -n "$so" ]; then
    mkdir -p "$TGX/tdlib/src/main/jniLibs/$abi"
    cp "$so" "$TGX/tdlib/src/main/jniLibs/$abi/"
    echo "   $abi: $(stat -c %s "$so") байт"
  else
    echo "   $abi: libparvane_jni.so не собрана (gradle :app:assembleRelease в android/) — пропуск"
  fi
done

echo "== NLoader: грузим libparvane_jni вместо libtdjni =="
for f in "$TGX"/app/src/*/kotlin/tgx/flavor/NLoader.kt; do
  sed -i 's/loadLibrary("tdjni")/loadLibrary("parvane_jni")/; s/loadLibrary(reLinker, "tdjni", BuildConfig.TDLIB_VERSION)/loadLibrary(reLinker, "parvane_jni", BuildConfig.JNI_VERSION)/' "$f"
done

echo "== экран входа по нику (ParvaneNickController) вместо PhoneController в логине =="
cp -r "$ROOT/tgx-overlay/app" "$TGX/"
MA="$TGX/app/src/main/java/org/thunderdog/challegram/MainActivity.java"
sed -i 's/PhoneController c = new PhoneController(this, account.tdlib());/ParvaneNickController c = new ParvaneNickController(this, account.tdlib());/; s/new PhoneController(this, account.tdlib())/new ParvaneNickController(this, account.tdlib())/g' "$MA"
grep -q "import org.thunderdog.challegram.ui.ParvaneNickController;" "$MA" ||   sed -i 's/^import org.thunderdog.challegram.ui.PhoneController;/import org.thunderdog.challegram.ui.PhoneController;\nimport org.thunderdog.challegram.ui.ParvaneNickController;/' "$MA"
sed -i 's/navigateTo(new PhoneController(context, getTdlib()));/navigateTo(new ParvaneNickController(context, getTdlib()));/' "$TGX/app/src/main/java/org/thunderdog/challegram/ui/IntroController.java"

echo "== контакты: без диалога синхронизации с Telegram (телефонной книги у Parvane нет) =="
CMGR="$TGX/app/src/main/java/org/thunderdog/challegram/telegram/TdlibContactManager.java"
grep -q "parvane: нет синхронизации контактов" "$CMGR" || sed -i 's/^  private boolean canShowAlert (boolean force) {$/  private boolean canShowAlert (boolean force) {\n    if (true) return false; \/\/ parvane: нет синхронизации контактов с Telegram/' "$CMGR"

echo "== ребрендинг: Telegram → Parvane в строках, интро X → экран ника, иконки =="
# Текст ресурсов (все локали): «Telegram X» и слово Telegram (не в URL/ключах)
for f in "$TGX"/app/src/main/res/values*/strings.xml; do
  perl -pi -e 's/Telegram X/Parvane/g; s/\bTelegram\b(?!\.(?:org|me|dog|com)\b|\/)/Parvane/g; s/(\\n)Telegram\b/$1Parvane/g' "$f"
done
# Русский язык: values-ru из словаря десктопа + ручного (tgx-overlay/ru_hand.py); формы few/many
python3 "$(dirname "$0")/tgx-overlay/gen-ru.py" "$TGX" "$(cd "$(dirname "$0")/.." && pwd)" || { echo "gen-ru упал"; exit 3; }
# Без телеграмовского интро (бумажный самолётик, «fastest messaging app»): сразу ник
sed -i 's/navigation.initController(new IntroController(this, account.tdlib()));/navigation.initController(new ParvaneNickController(this, account.tdlib()));/' "$MA"
# Иконки приложения/уведомлений — из tgx-overlay (mipmap-*), скопированы выше вместе с app/

echo "== кнопки без логики — прячем (решение пользователя: боты/Stories/Premium/платежи вне скоупа; Telegram-ссылки не про нас) =="
DR="$TGX/app/src/main/java/org/thunderdog/challegram/navigation/DrawerController.java"
# боковое меню: «Пригласить друзей», «Помощь» (Telegram FAQ), «Звонки» (на Android пока нет), «Добавить аккаунт», прокси
perl -0pi -e 's/^\s*items\.add\(new ListItem\(ListItem\.TYPE_DRAWER_ITEM, R\.id\.btn_(invite|help|addAccount), [^\n]*\n//mg; s/^\s*items\.add\(new ListItem\(ListItem\.TYPE_DRAWER_ITEM, R\.id\.btn_calls, [^\n]*\n//mg; s/^\s*items\.add\(proxyItem\);\n//mg' "$DR"
SC="$TGX/app/src/main/java/org/thunderdog/challegram/ui/SettingsController.java"
# настройки: строки, за которыми Telegram-сервисы (вопрос, FAQ, политика, обновления, бета, исходники),
# и разделы без логики в шве (стикеры, папки, устройства, приватность, телефон) — вместе с разделителем перед ними
perl -0pi -e 's/^\s*items\.add\(new ListItem\(ListItem\.TYPE_SEPARATOR\)\);\n(?=\s*items\.add\(new ListItem\([^\n]*R\.id\.btn_(help|faq|privacyPolicy|checkUpdates|subscribeToBeta|sourceCode|sourceCodeChanges|stickerSettingsAndEmoji|chatFolders|devices|privacySettings|phone)\b)//mg; s/^\s*items\.add\(new ListItem\([^\n]*R\.id\.btn_(help|faq|privacyPolicy|checkUpdates|subscribeToBeta|sourceCode|sourceCodeChanges|stickerSettingsAndEmoji|chatFolders|devices|privacySettings|phone)\b[^\n]*\n(\s*\.set[^\n]*\n)*//mg' "$SC"
grep -c "btn_faq\|btn_privacyPolicy" "$SC" | sed 's/^/   осталось упоминаний faq\/policy в настройках: /'
ML="$TGX/app/src/main/java/org/thunderdog/challegram/component/attach/MediaLayout.java"
# меню вложений: пятая вкладка «Опрос»/«Инлайн-бот» (опросов в шве пока нет, ботов не будет)
perl -0pi -e 's/^\s*needVote \?\n\s*new MediaBottomBar\.BarItem\([^\n]*CreatePoll[^\n]*\n\s*new MediaBottomBar\.BarItem\([^\n]*InlineBot[^\n]*\)(,)?\n//mg' "$ML"
PC="$TGX/app/src/main/java/org/thunderdog/challegram/ui/ProfileController.java"
# профиль, меню «…»: «Секретный чат» (у нас всё E2E), «Приватность» (экрана нет)
perl -0pi -e 's/^\s*if \(mode == Mode\.USER && user\.id != myUserId && !TD\.isBot\(user\)\) \{\n\s*ids\.append\(R\.id\.btn_newSecretChat\);\n\s*strings\.append\(R\.string\.StartEncryptedChat\);\n\s*\}\n//m; s/^\s*if \(!tdlib\.chatFullyBlocked\((?:chatId|getChatId\(\))\)\) \{\n\s*ids\.append\(R\.id\.more_btn_privacy\);\n\s*strings\.append\(R\.string\.EditPrivacy\);\n\s*\}\n//mg' "$PC"
# предохранители: код, ищущий удалённые строки по id (−1 → вставка по кривому индексу)
sed -i 's/position = adapter.indexOfViewById(R.id.btn_phone);/position = adapter.indexOfViewById(R.id.btn_username);/' "$SC"
sed -i 's/^\(\s*\)adapter.addItem(i, proxyItem);/\1if (i >= 0) adapter.addItem(i, proxyItem);/' "$DR"
# drawer: отладочные «Clear/Send TDLib logs» (в debug-сборке developer mode включён всегда)
perl -0pi -e 's/if \(Settings\.instance\(\)\.inDeveloperMode\(\)\) \{\n(\s*items\.add\(new ListItem\(ListItem\.TYPE_SEPARATOR_FULL\)\);)/if (false) {\n$1/' "$DR"
CC="$TGX/app/src/main/java/org/thunderdog/challegram/ui/ChatsController.java"
# пустой список чатов: кнопка «Invite contacts» (SMS-приглашения) — нет
perl -0pi -e 's/^\s*items\.add\(new ListItem\(ListItem\.TYPE_SHADOW_TOP\)\);\n\s*items\.add\(new ListItem\(ListItem\.TYPE_BUTTON, R\.id\.btn_invite, 0, [^\n]*\n\s*items\.add\(new ListItem\(ListItem\.TYPE_SHADOW_BOTTOM\)\);\n//m' "$CC"
MC="$TGX/app/src/main/java/org/thunderdog/challegram/ui/MainController.java"
# главный экран: вкладка «Calls» (звонков на Android пока нет) — одна вкладка
perl -0pi -e 's/return hasFolders\(\) \? pagerChatLists\.size\(\) : 2;/return hasFolders() ? pagerChatLists.size() : 1;/; s/(getMenuSectionName\(MAIN_PAGER_ITEM_ID, \/\* pagerItemPosition \*\/ 0, \/\* hasFolders \*\/ false, ChatFolderStyle\.LABEL_ONLY, \/\* upperCase \*\/ true\)),\n\s*Lang\.uppercase\(Lang\.getString\(R\.string\.Calls\)\)[^\n]*\n/$1\n/; s/(getDefaultMainItem\(\)),\n\s*new ViewPagerTopView\.Item\(callsItem\)\n/$1\n/' "$MC"
NM="$TGX/app/src/main/java/org/thunderdog/challegram/telegram/TdlibNotificationManager.java"
# нет Firebase → X вечно светит «уведомления могут не работать» красной точкой; пуша у нас нет по дизайну
perl -0pi -e 's/boolean hasPushServices = hasRemotePushService\(\);\n(\s*)if \(!hasPushServices\) \{/boolean hasPushServices = hasRemotePushService();\n$1if (false) {/; s/if \(tdlib\.context\(\)\.getTokenState\(\) == TdlibManager\.TokenState\.ERROR\)\n(\s*)return Status\.PUSH_SERVICE_ERROR;/if (false)\n$1return Status.PUSH_SERVICE_ERROR;/' "$NM"
sed -i '/^      !hasRemotePushService() ||$/d' "$NM"   # hasLocalNotificationProblem: без Firebase — не «проблема»
echo "   drawer devmode: $(grep -c 'inDeveloperMode()) {' "$DR"), invite btn: $(grep -c 'R.id.btn_invite, 0' "$CC"), calls tab: $(grep -c 'R.string.Calls))' "$MC"), push warn: $(grep -c 'if (!hasPushServices)' "$NM")"
# профиль: строка «Телефон: Unknown» только при заданном номере; «Переименовать/Удалить/Добавить контакт» — телефонной книги нет
perl -0pi -e 's/return user\.isContact \|\| user\.isMutualContact \|\| TD\.hasPhoneNumber\(user\);/return TD.hasPhoneNumber(user);/; s/^\s*if \(TD\.isContact\(user\)\) \{\n\s*ids\.append\(R\.id\.more_btn_edit\);\n\s*strings\.append\(R\.string\.RenameContact\);\n\s*ids\.append\(R\.id\.more_btn_delete\);\n\s*strings\.append\(R\.string\.DeleteContact\);\n\s*\} else if \(TD\.canAddContact\(user\)\) \{\n\s*ids\.append\(R\.id\.more_btn_addToContacts\);\n\s*strings\.append\(R\.string\.AddContact\);\n\s*\}\n//m' "$PC"
echo "   profile contact menu: $(grep -c 'R.string.RenameContact' "$PC"), phone cell: $(grep -c 'user.isMutualContact || TD.hasPhoneNumber' "$PC")"
echo "   attach InlineBot: $(grep -c 'R.string.InlineBot' "$ML"), profile newSecretChat/privacy: $(grep -c 'btn_newSecretChat\|more_btn_privacy' "$PC")"

echo "== CMake: без libtdjni (наш шов — не JNI TDLib) =="
CM="$TGX/app/jni/CMakeLists.txt"
if grep -q "^  tdjni$" "$CM"; then
  sed -i '/^  tdjni$/d' "$CM"
fi
grep -q "parvane: tdjni убран" "$CM" || sed -i '1i # parvane: tdjni убран из линковки tgxjni (шов над parvane-core, см. android/setup-tgx.sh)' "$CM"

echo "== google-services.json: клиент для нашего app.id (Firebase у нас не используется) =="
python3 - "$TGX/app/google-services.json" <<'PY'
import json, sys, copy
p = sys.argv[1]; j = json.load(open(p))
pk = "org.parvane.tgx"
if not any(c["client_info"]["android_client_info"]["package_name"] == pk for c in j["client"]):
    c = copy.deepcopy(j["client"][0])
    c["client_info"]["android_client_info"]["package_name"] = pk
    j["client"].append(c)
    json.dump(j, open(p, "w"), indent=2)
    print("   добавлен клиент", pk)
else:
    print("   клиент", pk, "уже есть")
PY

echo "== local.properties / keystore =="
[ -f "$KEYS/keystore.properties" ] || { echo "нет $KEYS/keystore.properties (см. BUILD-android.md)"; exit 2; }
cat > "$TGX/local.properties" <<PROPS
sdk.dir=$SDK
org.gradle.workers.max=8
keystore.file=$KEYS/keystore.properties
app.id=org.parvane.tgx
app.name=Parvane
app.download_url=https://parvane.duckdns.org:20443/
app.sources_url=https://github.com/TGX-Android/Telegram-X
telegram.api_id=17349
telegram.api_hash=344583e45741c457fe1862106095a5eb
youtube.api_key=
tgx.extension=none
PROPS
echo "   $TGX/local.properties записан"

if [ "${1:-}" = "--build" ]; then
  echo "== сборка assembleLatestArm64Debug (долго: ffmpeg/libvpx/webrtc) =="
  cd "$TGX"
  export JAVA_HOME="$JDK21" ANDROID_HOME="$SDK" ANDROID_SDK_ROOT="$SDK"
  export PATH="$JDK21/bin:/mnt/hdd/ub/android/tools/bin:$PATH"
  ./gradlew assembleLatestArm64Debug --no-daemon --console=plain
fi
echo "== готово =="
