// Parvane fork (spec 029, фаза 4): тексты справки Parvane — данные web `notes/guide/ru.ts` и `notes/guide/en.ts`,
// перенесённые как есть (сгенерировано из них: заметка — `lines.join("\n")`). Это содержимое файлов `.md`
// пользователя, а не строки интерфейса. Правка текстов — сначала в web, затем повторная выгрузка сюда.
#include "notes_guide_texts.h"

namespace parvane::sections::notes::guide {

const GuideSet &ruSet() {
    static const GuideSet set{
        R"PV(Справка Parvane)PV",
        {
            {"overview", 1, R"PV(Обзор)PV",
             R"PV(# Обзор

Parvane — мессенджер, план, здоровье, заметки и файлы в одном приложении. Переписка, записи плана, заметки и файлы шифруются на ваших устройствах: сервер, на котором работает Parvane, хранит только зашифрованные блоки. #справка

## Разделы
- [[Чаты]] — личные чаты, группы, каналы и звонки.
- [[Календарь и Сегодня]] — задачи и события по дням, повторы, расписание дня.
- [[Ввод текстом]] — строка текста становится записью: «созвон завтра 16:00».
- [[Здоровье]] — питание, вода, сон, показатели тела и тренировки.
- [[Заметки]] — тексты со ссылками, тегами и пунктами, разложенные по папкам.
- [[Граф и Холст]] — карта ссылок между заметками и доска с карточками.
- [[Файлы и Облако]] — личный диск и общие папки.

## Как разделы связаны
[[Связи между разделами]] — главное в Parvane: задание из чата попадает в план, пункт заметки становится задачей, файл из чата ложится в облако.

## Настройка
- [[Устройства и безопасность]] — второе устройство, ключ восстановления, что видит сервер.
- [[Оформление]] — цветовая схема, тёмная тема, фон чатов.
- [[Горячие клавиши]] — холст и календарь с клавиатуры.

## С чего начать
- [ ] Нажать «+ Запись» в «Календаре» и написать дело обычными словами
- [ ] Создать заметку и поставить в ней ссылку на другую заметку
- [ ] Открыть вкладку «Граф»: эта справка видна там картой

Справку можно править и удалять, как обычные заметки. Сама она не вернётся; восстановить её можно кнопкой «Справка Parvane» под списком заметок.
)PV"},
            {"chats", 2, R"PV(Чаты)PV",
             R"PV(# Чаты

Мессенджер: личные чаты, группы и каналы. Сообщение шифруется на устройстве отправителя и расшифровывается только у получателей. #справка

## Что есть
- Текст, фото, видео, файлы, голосовые и видеосообщения, стикеры, GIF, опросы, геопозиция.
- Ответы, правка и удаление, реакции, закрепление, пересылка.
- Звонки: личные со звуком и видео, групповые — до восьми участников.
- «Избранное» — чат с самим собой для записей на ходу; стоит первым в списке.

## Группы и каналы
- Кнопка «Написать» над списком чатов: новое сообщение, группа или канал.
- У группы есть фото и описание, администраторы с отдельными правами и права участников.
- В группу вступают по ссылке-приглашению; можно включить вступление по заявке.

## Порядок в списке
- Папки чатов — чипы над списком. У папки свой значок и цвет.
- Фон чата: Профиль → «Основные». Есть готовые фоны с узором, можно загрузить свою картинку.

## Связи
- Задание или событие отправляется в чат карточкой, получатель добавляет его в свой план — [[Связи между разделами]], [[Календарь и Сегодня]].
- Файл из сообщения сохраняется в облако, файл из облака отправляется в чат — [[Файлы и Облако]].

Назад: [[Обзор]]
)PV"},
            {"calendar", 3, R"PV(Календарь и Сегодня)PV",
             R"PV(# Календарь и Сегодня

Раздел «Календарь» боковой панели. Сверху переключатель видов: «Сегодня · Неделя · Месяц · Год · Список». #справка

## Сегодня
- Карточки дня, расписание списком, задачи дня и задачи «в работе» без даты.
- Строка «Без даты» открывает задачи без дня; кнопка у задачи ставит её на выбранный день.
- «Заметка дня» заводит заметку с датой в «Знаниях» — [[Заметки]].

## Задачи и события
- Задача — то, что нужно сделать: галочка, срок, шаги, список. День и время необязательны.
- Событие — то, что происходит в своё время: начало и конец либо «весь день». Событию можно дать цвет.
- Праздник — событие на весь день с отметкой «Праздник»: его день в месяце закрашен.

## Повторы
- Ежедневно, еженедельно по выбранным дням, ежемесячно по числу, ежегодно; до даты либо заданное число раз.
- При правке одного дня ряда приложение спрашивает: «Только это», «Это и последующие» или «Все в серии».

## Виды и слои
- Неделя — сетка по часам; нажатие на свободное место создаёт запись с этого времени.
- «Слои календаря» — «Сон», «Еда», «Дела» — включают и выключают то, что показано.
- Настройки плана (Профиль → блок «Parvane»): бюджет дня и рабочие часы.

## Как добавить
Кнопка «+ Запись» — [[Ввод текстом]]. «Подробнее» в окне ввода открывает полную форму.

Сон, еда и тренировки приходят из раздела [[Здоровье]]. Что ещё попадает в план — [[Связи между разделами]]. Назад: [[Обзор]]
)PV"},
            {"input", 4, R"PV(Ввод текстом)PV",
             R"PV(# Ввод текстом

Кнопка «+ Запись» в «Календаре» (на телефоне — «+» нижней панели) открывает окно с одним полем. Пишите как в заметке: дата, время, длительность, срок и повтор распознаются сами. #справка

## Примеры
- `купить блок питания` — задача без даты
- `созвон завтра 16:00 45 мин` — событие со временем и длительностью
- `сдать отчёт до пт` — задача со сроком
- `зал по будням 19:00` — событие с повтором
- `урок каждую неделю до марта` — повтор до даты
- `встреча с Петей: бюджет, сроки` — после двоеточия идёт описание
- `созвон завтра 16:00 — обсудить бюджет` — описание после тире
- `купить молоко #дом @Ашан !` — список, место и отметка «в работе»
- `созвон в двадцать один тридцать` — числа можно писать словами

## Что ещё понимает
- `#список` и `!` работают у задач, `@место` — у задач и событий.
- Одна опечатка в слове прощается: «завтар» читается как «завтра».
- Привычная длительность по первому слову: «пара» — 1 ч 45 мин, «урок» — 45 мин.
- Русские и английские слова; язык строки определяется по её буквам.

## Чипы под полем
- Чип — распознанная часть строки. Крестик на чипе снимает значение, слова остаются в названии.
- Строку можно прочитать по-разному — на чипе есть другие варианты.
- Переключатель «Авто / Событие / Задача» задаёт тип вручную.
- Правки запоминаются: после трёх одинаковых исправлений слово читается по-вашему. Словарь правок общий для ваших устройств; сбросить его можно в настройках плана.

## Здоровье тем же окном
`овсянка 9:00 300 ккал`, `вода 500 мл`, `сон 23:40-07:30`, `вес 72,4`, `бег 5 км 28 мин` — [[Здоровье]].

Записи появляются в разделе [[Календарь и Сегодня]]. Те же правила у пунктов с датой в заметках — [[Заметки]]. Назад: [[Обзор]]
)PV"},
            {"health", 5, R"PV(Здоровье)PV",
             R"PV(# Здоровье

Раздел «Здоровье» боковой панели: питание, вода, тело, сон и активность за выбранный день. Всё вводится текстом через «+ Запись» — [[Ввод текстом]]. #справка

## Что записывать
- Еда: `обед гречка 150г б30 ж10 у60 520 ккал` — приём пищи, порция, белки, жиры, углеводы, калории.
- Вода: `вода 500 мл`; на экране есть кнопки «+ стакан» и «+ бутылка».
- Сон: `сон 23:40-07:30` или словами: «лёг в 1:30, встал в 9».
- Тело: `вес 72,4`, `давление 120/80`, `пульс 64`, `самочувствие 4` (оценка до 5).
- Активность: `шаги 9500`, `бег 5 км 28 мин`, `зал присед 4x8x80, жим 3x10x60`.

## Цели
- `цель белок 140 вода 2,5л сон 8ч` задаёт цели текстом; то же — в блоке «Цели и настройки».
- Сахар и соль считаются пределом, а не целью.

## Связь с календарём
- Сон, еда и тренировки видны в календаре слоями — [[Календарь и Сегодня]].
- После короткой ночи бюджет дня в календаре снижается на 20 %.
- Тренировка со временем, на будущий день или с повтором записывается событием календаря.

Шаги, пульс и вес вписываются вручную: сбора с часов и телефона пока нет. Все переходы между разделами — [[Связи между разделами]]. Назад: [[Обзор]]
)PV"},
            {"notes", 6, R"PV(Заметки)PV",
             R"PV(# Заметки

Раздел «Знания», вкладка «Заметки». Заметка — обычный файл `.md` в папке «Знания» вашего облака; он зашифрован, как и остальные файлы. #справка

## Разметка
- `[[Название]]` — ссылка на заметку. Такой заметки ещё нет — она создаётся по нажатию.
- `[[Название|другой текст]]` — ссылка, показанная другими словами.
- `#тег` — метка; по ней работает поиск над списком.
- `- [ ] текст` — пункт с галочкой.
- Заголовки — строки, начатые с `#`, `##` или `###`; `**жирный**`; код — в обратных кавычках.

## Пункты и план
Пункт с датой или сроком становится задачей плана, галочка ходит в обе стороны. Например, `- [ ] оплатить счёт до пт` или `- [ ] созвон завтра 16:00`. Правила разбора — [[Ввод текстом]].

## Папки
- «Новая папка» под списком создаёт папку; «+» в её заголовке — заметку в ней.
- Перенос: нажмите на название папки под заголовком заметки и выберите другую. На компьютере строку заметки можно перетащить на заголовок папки.
- Ссылки при переносе не ломаются: заметку находят по названию, а не по папке.
- «⋯» в заголовке папки — переименовать или удалить её.

## Связи
- «Связи» показывают, кто ссылается на заметку. «Запланировано» — записи плана, в названии которых стоит ссылка на неё.
- «Заметка дня» на экране «Сегодня» заводит заметку с датой в папке «Ежедневные» — [[Календарь и Сегодня]].
- Карта всех ссылок — [[Граф и Холст]]. Сами файлы видны во вкладке «Файлы» — [[Файлы и Облако]].

## Попробуйте
- [ ] Нажать «Изменить» и поправить этот текст
- [ ] Отметить этот пункт галочкой

Заметку изменили на двух устройствах сразу — правки сводятся построчно; при расхождении рядом появляется копия с пометкой «конфликт». Назад: [[Обзор]]
)PV"},
            {"boards", 7, R"PV(Граф и Холст)PV",
             R"PV(# Граф и Холст

Две вкладки раздела «Знания». #справка

## Граф
- Заметки — точки, ссылки между ними — линии.
- Фильтры добавляют заметки дня и записи плана, в названии которых есть ссылка на заметку.
- Нажатие на узел открывает заметку. Узел заметки, которой ещё нет, предлагает её создать.
- Эта справка на графе — карта приложения: в центре [[Обзор]] и [[Связи между разделами]].

## Холст
- Доска с карточками и стрелками. Это файл `.canvas` в папке «Знания»; формат — JSON Canvas, его понимают и другие программы.
- Карточки: текст, заметка, ссылка на страницу с превью, файл из облака. Группа — рамка с названием.
- Двойной щелчок по пустому месту — новая карточка; по карточке — правка текста на месте.
- Стрелка тянется от точки на стороне карточки; подпись стрелки правится двойным щелчком.
- Несколько карточек выделяются с Shift или рамкой; их можно выровнять и обернуть в группу.
- Отмена и повтор — кнопками и клавишами: [[Горячие клавиши]].

## Холст из графа
- «Холст из графа» кладёт на доску карточку на каждую заметку и стрелку на каждую ссылку.
- «Обновить из графа» добавляет новые заметки и ссылки и убирает стрелки исчезнувших ссылок. Сделанное руками остаётся на месте.

Заметки и ссылки — [[Заметки]]. Файлы на карточках — [[Файлы и Облако]]. Назад: [[Обзор]]
)PV"},
            {"files", 8, R"PV(Файлы и Облако)PV",
             R"PV(# Файлы и Облако

Пункт «Облако» боковой панели, он же вкладка «Файлы» раздела «Знания». Личный диск: 10 ГБ на аккаунт, один файл — до 2 ГБ. Файлы шифруются на устройстве: сервер не видит ни имён, ни содержимого. #справка

## Диск
- Папки, загрузка файлов, переименование, перенос, поиск и сортировка.
- Просмотр внутри приложения: фото, видео, аудио, PDF и текстовые файлы. Остальное скачивается.
- Корзина хранит удалённое 30 дней; до этого всё можно вернуть.
- Папка «Знания» на диске — хранилище заметок: [[Заметки]].

## Общие папки
- «Доступ» у папки делает её общей. У участника роль: «Просмотр» или «Правка».
- Приглашение приходит участнику сообщением в чат и строкой в «Доступные мне».
- «Закрыть доступ» возвращает папку в личный диск.
- Сервер видит, кто состоит в общей папке, но не её содержимое.

## Связь с чатами
- «Сохранить в облако» — в меню сообщения с файлом.
- «Из облака» — в меню вложений чата, «Отправить в чат» — у файла на диске. Файл не перекачивается через устройство: сервер копирует зашифрованный блок. Подробнее — [[Чаты]].

Все переходы между разделами — [[Связи между разделами]]. Файлы на холсте — [[Граф и Холст]]. Назад: [[Обзор]]
)PV"},
            {"connections", 9, R"PV(Связи между разделами)PV",
             R"PV(# Связи между разделами

Разделы Parvane работают вместе. Ниже — откуда, куда и что происходит. #справка

## Чаты → план
- Чат → план и календарь: в меню вложений чата есть «Задание». Получатель видит карточку с кнопкой «В план» (задача) либо «В календарь» (событие с днём и временем) и кнопкой «Отклонить». Отправитель видит, кто принял; в группе каждый решает сам. См. [[Чаты]] и [[Календарь и Сегодня]].
- Карточка → запись: после добавления на карточке появляется «В плане · открыть» — переход к записи.

## Чаты ↔ облако
- Сообщение с файлом → облако: «Сохранить в облако» в меню сообщения.
- Облако → чат: «Из облака» в меню вложений либо «Отправить в чат» у файла. См. [[Файлы и Облако]].
- Общая папка → чат: приглашение в общую папку приходит участнику сообщением.

## Заметки ↔ план
- Пункт заметки → задача: строка `- [ ] оплатить счёт до пт` в заметке заводит задачу плана. Галочка в заметке отмечает задачу, галочка в плане — пункт. См. [[Заметки]].
- Запись плана → заметка: ссылка в двойных квадратных скобках в названии записи открывает заметку, а сама запись видна у заметки в блоке «Запланировано». Строка для окна [[Ввод текстом]]: `созвон завтра 16:00 [[Проект]]`.
- Сегодня → заметка дня: кнопка «Заметка дня» заводит заметку с датой.

## Здоровье → календарь
- Сон, еда и тренировки показаны в календаре слоями; короткий сон снижает бюджет дня. См. [[Здоровье]].
- Окно ввода текстом общее: оно создаёт и дела, и записи здоровья.

## Заметки ↔ файлы ↔ холст
- Заметка → облако: заметки — файлы папки «Знания»; они видны во вкладке «Файлы», корзина у них общая с диском.
- Заметки → граф → холст: ссылки между заметками рисует граф, «Холст из графа» превращает его в доску. См. [[Граф и Холст]].
- Облако → холст: файл с диска кладётся на холст карточкой.

## Устройства
- Устройство ↔ устройство: чаты, план, здоровье, заметки, файлы, папки чатов и словарь правок ввода одинаковы на всех ваших устройствах.
- Telegram → вход: ключ восстановления приходит в Telegram от бота; ответ боту этим ключом подключает новое устройство. См. [[Устройства и безопасность]].

Цвета общие для всех разделов — [[Оформление]]. Клавиши — [[Горячие клавиши]]. Назад: [[Обзор]]
)PV"},
            {"security", 10, R"PV(Устройства и безопасность)PV",
             R"PV(# Устройства и безопасность

Что зашифровано, как подключить новое устройство и зачем нужен ключ восстановления. #справка

## Что видит сервер
- Сообщения, записи плана и здоровья, заметки, файлы и их имена шифруются на устройстве. Ключи есть только у ваших устройств и у тех, с кем вы переписываетесь или делите папку.
- Сервер видит адреса аккаунтов, состав групп и общих папок, время и размер передаваемого.
- Parvane ставится на свой сервер: данные лежат там, где его развернули.

## Новое устройство
- Войдите с ником и паролем. Дальше устройство нужно привязать, иначе оно не получит переписку, план и файлы.
- Первый способ: на прежнем устройстве откройте Профиль → «Устройства» и подтвердите запрос, сверив код.
- Второй способ, если сервер работает с ботом Telegram: ответьте боту ключом восстановления. Прежние устройства остаются подключёнными.
- После привязки на устройство приходят история чатов, план и ключи облака.

## Ключ восстановления
- Создаётся вместе с аккаунтом. Приходит в Telegram от бота; без бота показывается на экране один раз.
- Нужен, когда под рукой нет ни одного привязанного устройства. Храните его отдельно от пароля.
- Ключ, отправленный через Telegram, виден серверу и Telegram открытым текстом.

## Выход и защита входа
- Профиль → «Устройства»: список сеансов; чужой сеанс завершается с вводом пароля.
- Выход стирает с устройства ключи и данные. С последнего устройства вернуться можно только по ключу.
- «Защита входа» в настройках конфиденциальности добавляет подтверждение входа через Telegram.

Что одинаково на всех устройствах — [[Связи между разделами]]. Назад: [[Обзор]]
)PV"},
            {"appearance", 11, R"PV(Оформление)PV",
             R"PV(# Оформление

Настройки собраны в «Профиле»: кнопка внизу боковой панели, на телефоне — вкладка «Профиль». #справка

- Цветовая схема: Gruvbox, Telegram, Nord, Catppuccin, Solarized. Профиль → «Оформление». Меняются только цвета — сразу в чатах и во всех разделах.
- Светлая и тёмная тема: Профиль → «Ещё» → ночной режим. У каждой схемы есть оба варианта.
- Размер текста и фон чатов: Профиль → «Основные».
- Анимации: Профиль → «Ещё».
- Значок и цвет папки чатов задаются в настройках папки — [[Чаты]].
- Цвет списка задач и цвет события — [[Календарь и Сегодня]].

Цветовая схема хранится на устройстве: на телефоне и компьютере она может быть разной. Остальные связи — [[Связи между разделами]]. Назад: [[Обзор]]
)PV"},
            {"shortcuts", 12, R"PV(Горячие клавиши)PV",
             R"PV(# Горячие клавиши

На Mac вместо Ctrl — Cmd. #справка

## Холст
- Ctrl+Z — отменить; Ctrl+Shift+Z или Ctrl+Y — вернуть.
- Ctrl+A — выделить всё; Ctrl+D — дублировать выделенное.
- Delete или Backspace — удалить выделенное.
- Enter или F2 — править текст выделенной карточки.
- Стрелки — сдвинуть выделенное.
- Пробел с перетаскиванием — двигать поле.
- Shift со щелчком или с перетаскиванием — выделить несколько карточек.
- Двойной щелчок: на пустом месте — новая карточка, на карточке — правка текста.

## Календарь
- Ctrl+Z — отменить последнее действие, когда курсор не в поле ввода.
- Enter в окне ввода текстом — создать запись.

## Везде
- Escape закрывает окно, шторку или правку на месте.
- Enter в поле названия заметки или папки — сохранить.

Холст — [[Граф и Холст]], календарь — [[Календарь и Сегодня]], окно ввода — [[Ввод текстом]]. Остальное — [[Связи между разделами]]. Назад: [[Обзор]]
)PV"},
        },
        {R"PV(оплатить счёт до пт)PV", R"PV(созвон завтра 16:00)PV"},
        {
            {R"PV(купить блок питания)PV", "task"},
            {R"PV(созвон завтра 16:00 45 мин)PV", "event"},
            {R"PV(сдать отчёт до пт)PV", "task"},
            {R"PV(зал по будням 19:00)PV", "event"},
            {R"PV(урок каждую неделю до марта)PV", "task"},
            {R"PV(встреча с Петей: бюджет, сроки)PV", "task"},
            {R"PV(созвон завтра 16:00 — обсудить бюджет)PV", "event"},
            {R"PV(купить молоко #дом @Ашан !)PV", "task"},
            {R"PV(созвон в двадцать один тридцать)PV", "event"},
            {R"PV(овсянка 9:00 300 ккал)PV", "food"},
            {R"PV(обед гречка 150г б30 ж10 у60 520 ккал)PV", "food"},
            {R"PV(вода 500 мл)PV", "water"},
            {R"PV(сон 23:40-07:30)PV", "sleep"},
            {R"PV(вес 72,4)PV", "metric"},
            {R"PV(давление 120/80)PV", "metric"},
            {R"PV(пульс 64)PV", "metric"},
            {R"PV(самочувствие 4)PV", "metric"},
            {R"PV(шаги 9500)PV", "metric"},
            {R"PV(бег 5 км 28 мин)PV", "workout"},
            {R"PV(зал присед 4x8x80, жим 3x10x60)PV", "workout"},
            {R"PV(цель белок 140 вода 2,5л сон 8ч)PV", "goal"},
        },
    };
    return set;
}

const GuideSet &enSet() {
    static const GuideSet set{
        R"PV(Parvane guide)PV",
        {
            {"overview", 1, R"PV(Overview)PV",
             R"PV(# Overview

Parvane is a messenger, a planner, a health log, notes and files in one app. Messages, planner entries, notes and files are encrypted on your devices: the server Parvane runs on stores only encrypted blocks. #guide

## Sections
- [[Chats]] — private chats, groups, channels and calls.
- [[Calendar and Today]] — tasks and events by day, repeats, the day schedule.
- [[Text input]] — a line of text becomes an entry: “call tomorrow 16:00”.
- [[Health]] — nutrition, water, sleep, body metrics and workouts.
- [[Notes]] — texts with links, tags and checklists, sorted into folders.
- [[Graph and Canvas]] — a map of links between notes and a board with cards.
- [[Files and Cloud]] — your personal drive and shared folders.

## How the sections connect
[[How sections connect]] is the main thing in Parvane: a task from a chat lands in the planner, a note item becomes a task, a file from a chat goes to the cloud.

## Setup
- [[Devices and security]] — a second device, the recovery key, what the server sees.
- [[Appearance]] — colour scheme, dark theme, chat background.
- [[Keyboard shortcuts]] — the canvas and the calendar from the keyboard.

## Where to start
- [ ] Press “+ Entry” in “Calendar” and type a plan in plain words
- [ ] Create a note and put a link to another note in it
- [ ] Open the “Graph” tab: this guide is drawn there as a map

You can edit and delete the guide like any other notes. It does not come back by itself; to restore it, press “Parvane guide” under the list of notes.
)PV"},
            {"chats", 2, R"PV(Chats)PV",
             R"PV(# Chats

A messenger: private chats, groups and channels. A message is encrypted on the sender’s device and decrypted only by the recipients. #guide

## What is there
- Text, photos, videos, files, voice and video messages, stickers, GIFs, polls, locations.
- Replies, editing and deleting, reactions, pinning, forwarding.
- Calls: private audio and video calls, group calls for up to eight people.
- “Saved Messages” is a chat with yourself for quick notes; it stays first in the list.

## Groups and channels
- The “Compose” button above the chat list: a new message, a group or a channel.
- A group has a photo and a description, admins with separate rights, and member permissions.
- People join by an invite link; you can require approval of join requests.

## Order in the list
- Chat folders are chips above the list. Each folder has its own icon and colour.
- Chat background: Profile → “General”. There are ready patterns, or upload your own picture.

## Connections
- A task or an event is sent to a chat as a card, and the recipient adds it to their own planner — [[How sections connect]], [[Calendar and Today]].
- A file from a message is saved to the cloud, a cloud file is sent to a chat — [[Files and Cloud]].

Back: [[Overview]]
)PV"},
            {"calendar", 3, R"PV(Calendar and Today)PV",
             R"PV(# Calendar and Today

The “Calendar” section of the sidebar. The switch on top: “Today · Week · Month · Year · List”. #guide

## Today
- Day cards, the schedule as a list, tasks of the day and undated tasks that are in progress.
- The “No date” row opens tasks without a day; the button next to a task puts it on the selected day.
- “Daily note” starts a dated note in “Knowledge” — [[Notes]].

## Tasks and events
- A task is something to do: a tick, a deadline, steps, a list. Day and time are optional.
- An event happens at its own time: a start and an end, or “All day”. An event can have a colour.
- A holiday is an all-day event marked “Holiday”: its day is filled in the month view.

## Repeats
- Daily, weekly on chosen weekdays, monthly on a date, yearly; until a date or a set number of times.
- When you edit one day of a series the app asks: “Only this”, “This and following” or “All in series”.

## Views and layers
- Week is an hourly grid; pressing a free spot creates an entry starting at that time.
- “Calendar layers” — sleep, food and plans — switch what the calendar shows.
- Planner settings (Profile → the “Parvane” block): the day budget and working hours.

## How to add
The “+ Entry” button — [[Text input]]. “More options” in the input window opens the full form.

Sleep, food and workouts come from [[Health]]. What else lands in the planner — [[How sections connect]]. Back: [[Overview]]
)PV"},
            {"input", 4, R"PV(Text input)PV",
             R"PV(# Text input

The “+ Entry” button in “Calendar” (on a phone — “+” in the bottom bar) opens a window with one field. Type as you would in a note: date, time, duration, deadline and repeat are recognised. #guide

## Examples
- `buy a power supply` — a task with no date
- `call tomorrow 16:00 45 min` — an event with a time and a duration
- `send the report by fri` — a task with a deadline
- `gym on weekdays 19:00` — a repeating event
- `lesson every week for 6 weeks` — a repeat with an end
- `meeting with Pete: budget, deadlines` — a description goes after the colon
- `call tomorrow 16:00 — discuss the budget` — or after a dash
- `buy milk #home @Mall !` — the list, the place and the “in progress” mark
- `call 4pm twenty-five minutes` — numbers can be written as words

## What else it understands
- `#list` and `!` work for tasks, `@place` for tasks and events.
- One typo in a word is forgiven: “tomorow” reads as “tomorrow”.
- A usual duration by the first word: a “lesson” takes 45 minutes.
- English and Russian words; the language of a line is taken from its letters.

## Chips under the field
- A chip is a recognised part of the line. Its cross removes the value, the words stay in the name.
- When a line can be read in more than one way, the chip offers the other readings.
- The “Auto / Event / Task” switch sets the type by hand.
- Corrections are learned: after three identical fixes the word is read your way. The dictionary is shared by your devices; reset it in the planner settings.

## Health in the same window
`oatmeal 9:00 300 kcal`, `water 500 ml`, `sleep 23:40-07:30`, `weight 72.4`, `run 5 km 28 min` — [[Health]].

Entries appear in [[Calendar and Today]]. Dated checklist items in notes follow the same rules — [[Notes]]. Back: [[Overview]]
)PV"},
            {"health", 5, R"PV(Health)PV",
             R"PV(# Health

The “Health” section of the sidebar: nutrition, water, body, sleep and activity for the selected day. Everything is entered as text through “+ Entry” — [[Text input]]. #guide

## What to log
- Food: `lunch buckwheat 150g p30 f10 c60 520 kcal` — meal, portion, protein, fat, carbs, calories.
- Water: `water 500 ml`; the screen also has “+ glass” and “+ bottle” buttons.
- Sleep: `sleep 23:40-07:30`.
- Body: `weight 72.4`, `bp 120/80`, `pulse 64`, `mood 4` (a mark up to 5).
- Activity: `steps 9500`, `run 5 km 28 min`, `gym squat 4x8x80, bench 3x10x60`.

## Goals
- `goal protein 140 water 2.5l` sets goals as text; the same is in the “Goals and settings” block.
- Sugar and salt count as a limit, not as a goal.

## Connection with the calendar
- Sleep, food and workouts are shown in the calendar as layers — [[Calendar and Today]].
- After a short night the day budget in the calendar goes down by 20%.
- A workout with a time, on a future day or with a repeat is saved as a calendar event.

Steps, pulse and weight are typed in by hand: there is no import from watches or phones yet. All the paths between sections — [[How sections connect]]. Back: [[Overview]]
)PV"},
            {"notes", 6, R"PV(Notes)PV",
             R"PV(# Notes

The “Knowledge” section, the “Notes” tab. A note is a plain `.md` file in the “Knowledge” folder of your cloud; it is encrypted like every other file. #guide

## Markup
- `[[Title]]` links to a note. If there is no such note yet, pressing the link creates it.
- `[[Title|other text]]` is a link shown with other words.
- `#tag` is a label; the search above the list finds it.
- `- [ ] text` is a checklist item.
- Headings are lines starting with `#`, `##` or `###`; `**bold**`; code goes in backticks.

## Items and the planner
An item with a date or a deadline becomes a planner task, and the tick travels both ways. For example, `- [ ] pay the invoice by fri` or `- [ ] call tomorrow 16:00`. The parsing rules — [[Text input]].

## Folders
- “New folder” under the list creates a folder; “+” in its caption creates a note inside it.
- To move a note, press the folder name under the note title and pick another one. On a computer you can also drag a note row onto a folder caption.
- Links survive a move: a note is found by its title, not by its folder.
- “⋯” in a folder caption renames or deletes the folder.

## Connections
- “Links” show who links to the note. “Planned” lists planner entries whose name carries a link to it.
- “Daily note” on the “Today” screen starts a dated note in the “Daily” folder — [[Calendar and Today]].
- The map of all links — [[Graph and Canvas]]. The files themselves are in the “Files” tab — [[Files and Cloud]].

## Try it
- [ ] Press “Edit” and change this text
- [ ] Tick this item

If a note is changed on two devices at once, the edits are merged line by line; when they clash, a copy marked “conflict” appears next to it. Back: [[Overview]]
)PV"},
            {"boards", 7, R"PV(Graph and Canvas)PV",
             R"PV(# Graph and Canvas

Two tabs of the “Knowledge” section. #guide

## Graph
- Notes are dots, links between them are lines.
- Filters add daily notes and planner entries whose name carries a link to a note.
- Pressing a node opens the note. A node of a note that does not exist yet offers to create it.
- On the graph this guide is a map of the app, with [[Overview]] and [[How sections connect]] in the centre.

## Canvas
- A board with cards and arrows. It is a `.canvas` file in the “Knowledge” folder; the format is JSON Canvas, which other apps read too.
- Cards: text, a note, a link to a page with a preview, a cloud file. A group is a named frame.
- Double-click an empty spot for a new card; double-click a card to edit its text in place.
- An arrow is drawn from a dot on a card side; double-click an arrow to edit its label.
- Select several cards with Shift or a frame; they can be aligned and wrapped in a group.
- Undo and redo — with buttons and keys: [[Keyboard shortcuts]].

## Canvas from graph
- “Canvas from graph” puts a card for every note and an arrow for every link on the board.
- “Refresh from graph” adds new notes and links and removes arrows of links that are gone. What you made by hand stays where it is.

Notes and links — [[Notes]]. Files on cards — [[Files and Cloud]]. Back: [[Overview]]
)PV"},
            {"files", 8, R"PV(Files and Cloud)PV",
             R"PV(# Files and Cloud

“Cloud” in the sidebar, which is also the “Files” tab of “Knowledge”. A personal drive: 10 GB per account, one file up to 2 GB. Files are encrypted on the device: the server sees neither names nor content. #guide

## The drive
- Folders, uploads, renaming, moving, search and sorting.
- Preview inside the app: photos, video, audio, PDF and text files. Everything else is downloaded.
- The trash keeps deleted items for 30 days; until then everything can be restored.
- The “Knowledge” folder on the drive is the notes vault: [[Notes]].

## Shared folders
- “Sharing” on a folder makes it shared. A member is a “Reader” or an “Editor”.
- The invitation arrives as a chat message and as a row in “Shared with me”.
- “Make private” turns the folder back into a folder of your personal drive.
- The server sees who is in a shared folder, but not what is inside.

## Connection with chats
- “Save to Cloud” is in the menu of a message with a file.
- “From Cloud” is in the attachment menu of a chat, “Send to chat” is on a file in the drive. The file is not pumped through your device: the server copies the encrypted block. More — [[Chats]].

All the paths between sections — [[How sections connect]]. Files on a canvas — [[Graph and Canvas]]. Back: [[Overview]]
)PV"},
            {"connections", 9, R"PV(How sections connect)PV",
             R"PV(# How sections connect

The sections of Parvane work together. Below: from where, to where, and what happens. #guide

## Chats → planner
- Chat → planner and calendar: the attachment menu of a chat has “Task”. The recipient sees a card with “To plan” (a task) or “To calendar” (an event with a day and a time) and “Decline”. The sender sees who accepted; in a group everyone decides for themselves. See [[Chats]] and [[Calendar and Today]].
- Card → entry: once added, the card shows “In plan · open”, which jumps to the entry.

## Chats ↔ cloud
- Message with a file → cloud: “Save to Cloud” in the message menu.
- Cloud → chat: “From Cloud” in the attachment menu or “Send to chat” on a file. See [[Files and Cloud]].
- Shared folder → chat: the invitation to a shared folder arrives as a message.

## Notes ↔ planner
- Note item → task: a line `- [ ] pay the invoice by fri` in a note creates a planner task. The tick in the note marks the task, the tick in the planner marks the item. See [[Notes]].
- Planner entry → note: a link in double square brackets in the name of an entry opens the note, and the entry shows up in the “Planned” block of that note. A line for the [[Text input]] window: `call tomorrow 16:00 [[Project]]`.
- Today → daily note: the “Daily note” button starts a dated note.

## Health → calendar
- Sleep, food and workouts are calendar layers; a short night lowers the day budget. See [[Health]].
- The text input window is shared: it creates both plans and health records.

## Notes ↔ files ↔ canvas
- Note → cloud: notes are files of the “Knowledge” folder; they show in the “Files” tab and share its trash.
- Notes → graph → canvas: the graph draws the links between notes, “Canvas from graph” turns it into a board. See [[Graph and Canvas]].
- Cloud → canvas: a file from the drive is put on a canvas as a card.

## Devices
- Device ↔ device: chats, the planner, health, notes, files, chat folders and the dictionary of input corrections are the same on all your devices.
- Telegram → sign-in: the recovery key arrives in Telegram from the bot; replying to the bot with the key connects a new device. See [[Devices and security]].

Colours are shared by all sections — [[Appearance]]. Keys — [[Keyboard shortcuts]]. Back: [[Overview]]
)PV"},
            {"security", 10, R"PV(Devices and security)PV",
             R"PV(# Devices and security

What is encrypted, how to connect a new device and what the recovery key is for. #guide

## What the server sees
- Messages, planner and health entries, notes, files and their names are encrypted on the device. The keys are held only by your devices and by the people you chat or share a folder with.
- The server sees account addresses, members of groups and shared folders, the time and size of traffic.
- Parvane is installed on your own server: the data stays where it was deployed.

## A new device
- Sign in with the nickname and password. Then link the device, or it gets no messages, planner or files.
- First way: on an old device open Profile → “Devices” and confirm the request after comparing the code.
- Second way, when the server works with the Telegram bot: reply to the bot with the recovery key. Your other devices stay connected.
- After linking the device receives the chat history, the planner and the cloud keys.

## The recovery key
- Created with the account. It arrives in Telegram from the bot; with no bot it is shown on screen once.
- You need it when no linked device is at hand. Keep it apart from the password.
- A key sent through Telegram is visible to the server and to Telegram in plain text.

## Signing out and sign-in protection
- Profile → “Devices”: the list of sessions; ending another session asks for the password.
- Signing out erases keys and data from the device. From the last device the only way back is the key.
- “Sign-in protection” in the privacy settings adds a confirmation of sign-ins through Telegram.

What is the same on all devices — [[How sections connect]]. Back: [[Overview]]
)PV"},
            {"appearance", 11, R"PV(Appearance)PV",
             R"PV(# Appearance

Settings live in “Profile”: the button at the bottom of the sidebar, on a phone — the “Profile” tab. #guide

- Colour scheme: Gruvbox, Telegram, Nord, Catppuccin, Solarized. Profile → “Appearance”. Only colours change — at once in chats and in every section.
- Light and dark theme: Profile → “More” → Night Mode. Every scheme has both.
- Text size and chat background: Profile → “General”.
- Animations: Profile → “More”.
- The icon and colour of a chat folder are set in the folder settings — [[Chats]].
- The colour of a task list and of an event — [[Calendar and Today]].

The colour scheme is stored on the device: a phone and a computer may differ. Other connections — [[How sections connect]]. Back: [[Overview]]
)PV"},
            {"shortcuts", 12, R"PV(Keyboard shortcuts)PV",
             R"PV(# Keyboard shortcuts

On a Mac use Cmd instead of Ctrl. #guide

## Canvas
- Ctrl+Z — undo; Ctrl+Shift+Z or Ctrl+Y — redo.
- Ctrl+A — select all; Ctrl+D — duplicate the selection.
- Delete or Backspace — delete the selection.
- Enter or F2 — edit the text of the selected card.
- Arrows — move the selection.
- Space with dragging — move the board.
- Shift with a click or with dragging — select several cards.
- Double-click: an empty spot gives a new card, a card opens its text for editing.

## Calendar
- Ctrl+Z — undo the last action when the cursor is not in an input field.
- Enter in the text input window — create the entry.

## Everywhere
- Escape closes a window, a sheet or an in-place edit.
- Enter in the name field of a note or a folder — save.

Canvas — [[Graph and Canvas]], calendar — [[Calendar and Today]], the input window — [[Text input]]. Everything else — [[How sections connect]]. Back: [[Overview]]
)PV"},
        },
        {R"PV(pay the invoice by fri)PV", R"PV(call tomorrow 16:00)PV"},
        {
            {R"PV(buy a power supply)PV", "task"},
            {R"PV(call tomorrow 16:00 45 min)PV", "event"},
            {R"PV(send the report by fri)PV", "task"},
            {R"PV(gym on weekdays 19:00)PV", "event"},
            {R"PV(lesson every week for 6 weeks)PV", "task"},
            {R"PV(meeting with Pete: budget, deadlines)PV", "task"},
            {R"PV(call tomorrow 16:00 — discuss the budget)PV", "event"},
            {R"PV(buy milk #home @Mall !)PV", "task"},
            {R"PV(call 4pm twenty-five minutes)PV", "event"},
            {R"PV(oatmeal 9:00 300 kcal)PV", "food"},
            {R"PV(lunch buckwheat 150g p30 f10 c60 520 kcal)PV", "food"},
            {R"PV(water 500 ml)PV", "water"},
            {R"PV(sleep 23:40-07:30)PV", "sleep"},
            {R"PV(weight 72.4)PV", "metric"},
            {R"PV(bp 120/80)PV", "metric"},
            {R"PV(pulse 64)PV", "metric"},
            {R"PV(mood 4)PV", "metric"},
            {R"PV(steps 9500)PV", "metric"},
            {R"PV(run 5 km 28 min)PV", "workout"},
            {R"PV(gym squat 4x8x80, bench 3x10x60)PV", "workout"},
            {R"PV(goal protein 140 water 2.5l)PV", "goal"},
        },
    };
    return set;
}

} // namespace parvane::sections::notes::guide
