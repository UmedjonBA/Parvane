# Архитектура врезки Parvane в tdesktop (черновик, Фаза 2)

Карта составлена по исходникам v6.9.3. Уточняется при реализации.

## Поток данных в оригинале

```
UI (HistoryWidget, intro/*)
  ├─ исходящее → ApiWrap (Telegram/SourceFiles/apiwrap.{h,cpp}, ~6000 строк)
  │                  └─ request(MTPmethod(...)) → MTP::Sender → MTP::Instance → сеть
  └─ чтение ← Data::Session (rpl::producer потоки)  ← обновляется из…
incoming: MTP::Instance → Main::Account::_mtpUpdates (rpl::event_stream<MTPUpdates>)
          → Api::Updates (api/api_updates.{h,cpp}) → Data::Session::processMessage/…
          → UI обновляется реактивно
```

Владение:
- `Main::Account` (main/main_account.h) владеет `std::unique_ptr<MTP::Instance> _mtp`,
  создаёт его в `startMtp(config)`, отдаёт через `mtp()`, и **пушит входящие
  апдейты в `_mtpUpdates` (rpl::event_stream<MTPUpdates>)** — ключевой вход.
- `Main::Session` (main/main_session.h) владеет `_api` (ApiWrap) и `_data`
  (Data::Session); `mtp()` делегирует в Account.
- Все исходящие запросы идут через `ApiWrap::request(MTP<method>(...))`.

## Точка врезки

**Единственный шов = `MTP::Instance`** (mtproto/mtp_instance.h, sender.h):
- исходящее: ApiWrap → Sender → Instance — заменить транспорт здесь;
- входящее: Instance → `Account::_mtpUpdates` — отсюда вбрасывать синтетические
  `MTPUpdates`, собранные из событий Parvane.

Глубокая связка — **модель данных**: и запросы, и ответы, и апдейты — это
TL-типы (`MTPmessage`, `MTPUser`, `MTPUpdates`, …) из
`mtproto/scheme/api.tl`. Заменить MTProto = **синтезировать TL-объекты** из
JSON-событий Parvane. Это основной объём.

## Две стратегии (выбрать в начале Фазы 2)

1. **Подменить `MTP::Instance`** реализацией поверх `parvane::transport`:
   принимает TL-запросы тем же интерфейсом Sender, отвечает синтетическими TL,
   а входящие Parvane-события превращает в `MTPUpdates` → `_mtpUpdates`.
   - Плюс: ApiWrap/Data/UI не трогаем вообще.
   - Минус: интерфейс MTP::Instance широкий; нужно покрыть набор TL-методов.
2. **Перехват в ApiWrap** для узкого набора действий (send/getHistory/…).
   - Минус: ApiWrap огромный и завязан на TL; врезка размазывается.

Предпочтение: **(1)**, вертикальными срезами — сначала минимальный набор TL для
логина и одного текстового диалога, потом расширять.

## Минимальный набор TL для первого среза (Фаза 2–3)

- авторизация: подменяем intro-флоу на `identity.token.issue` (user/password),
  синтезируем себя как `MTPUser`; токен храним в Account.
- `messages.getDialogs` / `messages.getHistory` → из `msg.sync.*` Parvane.
- `messages.sendMessage` → публикация `msg.chat.send`.
- входящие сообщения/доставка → `MTPUpdates` (updateNewMessage и т.п.).

## Брендинг (чтобы не пересекаться с установленным Telegram)

Сменить имя приложения и базовый каталог данных (`AppName`, `AppFile`,
data dir → `Parvane`), чтобы форк никогда не делил `~/.local/share/TelegramDesktop`
с системным `telegram-desktop`. См. core/launcher / settings, Фаза брендинга.

## Файлы для работы в Фазе 2

- `Telegram/SourceFiles/mtproto/mtp_instance.{h,cpp}`, `sender.h` — шов.
- `Telegram/SourceFiles/main/main_account.{h,cpp}` — `startMtp`, `_mtpUpdates`.
- `Telegram/SourceFiles/api/api_updates.{h,cpp}` — обработка апдейтов.
- `Telegram/SourceFiles/intro/*` — экраны логина (заменяем на Parvane-логин).
- НОВОЕ: `Telegram/SourceFiles/parvane/{transport,events}.{h,cpp}` — cnats + JSON,
  C++-зеркало `shared/parvane-types/src/lib.rs` (типы + топики-константы).
