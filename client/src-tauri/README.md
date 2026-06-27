# MONOLITH desktop (Tauri v2)

Оборачивает статический фронтенд из `client/` (`index.html` + `src/`) в нативное
окно. Кросс-платформенно: Windows, Linux, macOS из одной кодовой базы.

`frontendDist` в `tauri.conf.json` указывает на `../` — Tauri отдаёт тот же
`index.html`, что и в вебе. Шага сборки фронтенда нет (React/Babel из CDN).

## Одноразовая подготовка

### 1. Системный webview (нужен root)

Tauri v2 на Linux требует `webkit2gtk-4.1`. На Arch:

```bash
sudo pacman -S --needed webkit2gtk-4.1 base-devel curl wget file \
  openssl gtk3 libappindicator-gtk3 librsvg
```

(macOS — ничего ставить не нужно; Windows — WebView2, обычно уже есть.)

### 2. Tauri CLI (root не нужен)

```bash
cargo install tauri-cli --version "^2"
```

### 3. Иконки

`tauri build` требует набор иконок. Сгенерируй из любого квадратного PNG:

```bash
cd client
cargo tauri icon путь/к/логотипу.png      # создаст src-tauri/icons/*
```

## Запуск и сборка

```bash
cd client
cargo tauri dev      # окно с приложением (hot-reload фронтенда)
cargo tauri build    # релизный бандл под текущую ОС (.deb/.AppImage/.msi/.dmg)
```

## Что улучшить перед релизом

- **Вендорить React/Babel локально** вместо CDN — сейчас десктоп требует
  интернет на старте. Положить `react`, `react-dom`, прекомпилированный JS
  в `src/vendor/` и убрать `unpkg`-ссылки из `index.html`.
- **Прекомпилировать JSX** (Vite/esbuild) — убрать Babel-standalone из рантайма,
  ускорить запуск; тогда `beforeBuildCommand` будет собирать `dist/`.
- Подключить экраны к реальному бэкенду Parvane (NATS-шарды) вместо моков
  `src/data.jsx`.

## Статус

Каркас готов и стандартен (Tauri v2). На этой машине не собран: отсутствует
`webkit2gtk-4.1` (нужен `sudo`, см. шаг 1). После установки зависимостей
`cargo tauri dev` поднимет окно.
