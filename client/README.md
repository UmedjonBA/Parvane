# MONOLITH client (MONOVIEW)

Десктоп-оболочка для платформы — операторская консоль в духе Gruvbox-TUI.
Импортирована из Claude Design (проект `monolith`), реализует `MONOLITH.html`.

Семь экранов, переключаются клавишами `1`–`7` или кликом по вкладкам:

| # | Экран | Назначение |
|---|---|---|
| 1 | CALENDAR | календарь, события, дедлайны, расписание |
| 2 | DIARY | дневник + график настроения |
| 3 | HOME | устройства VERTEX / печать UKAZ / таймеры ACHTUNG |
| 4 | SYSTEM | мониторинг узлов, логи, командная строка |
| 5 | MESSENGER | 1-на-1 чаты, группы, secret-чаты |
| 6 | NOTES | Obsidian-стиль: дерево, редактор, граф связей |
| 7 | CLOUD | распределённое хранилище, файлы, ноды, снапшоты |

## Стек

- **React 18** + **Babel standalone** — JSX транспилируется прямо в браузере,
  сборка не требуется. Каждый файл `src/*.jsx` регистрирует глобальные
  компоненты (см. `index.html` — порядок подключения важен).
- **JetBrains Mono** + CSS-токены Gruvbox (`src/styles.css`, `src/styles-screens.css`).
- Данные — моки в `src/data.jsx` (живой бэкенд ещё не подключён).

## Запуск (веб, без сборки)

JSX подгружается через `fetch`, поэтому нужен HTTP-сервер (не `file://`):

```bash
cd client
python3 -m http.server 8099
# открыть http://127.0.0.1:8099/index.html
```

Любой статический сервер подойдёт (`npx serve`, `caddy file-server` и т.п.).
Требуется интернет — React и Babel грузятся с CDN.

## Проверка

```bash
cd client
npm install --no-save @babel/core @babel/preset-react
node check_jsx.mjs        # синтаксис-проверка всех .jsx через Babel

npm install --no-save playwright && npx playwright install chromium
node render_check.mjs     # headless-рендер всех 7 экранов + лог JS-ошибок
```

## Десктоп (Tauri, кросс-платформа Win/Lin/Mac)

Каркас в `src-tauri/` оборачивает этот статический фронтенд в нативное окно.
Сборка требует системного webview и Tauri CLI — см. `src-tauri/README.md`.

## Структура

```
client/
├── index.html              ← оболочка (= MONOLITH.html): CDN React/Babel + порядок загрузки
├── src/
│   ├── styles.css          ← токены Gruvbox + общий chrome (panel, tabs, footer…)
│   ├── styles-screens.css  ← стили под каждый экран
│   ├── atoms.jsx           ← Panel, Dot, Badge, HubStatus, Tabs, Footer, useClock
│   ├── shell.jsx           ← App shell (header + tabs + main + footer)
│   ├── data.jsx            ← моки (window.MONO_DATA)
│   ├── app.jsx             ← корень: маршрутизация вкладок, FireAlert, TweaksPanel
│   ├── tweaks-panel.jsx    ← служебная панель Claude Design (не часть продукта)
│   └── screens/            ← calendar, diary, home, system, messenger, notes, cloud
└── src-tauri/              ← Tauri-обёртка для десктопа
```
