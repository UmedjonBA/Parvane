// Shared sample data for MONOLITH. Russian content where natural.

const MONO_DATA = {
  // ---------- CALENDAR ----------
  events: {
    "2026-05-13": [
      { time: "23:59", title: "Go Reflect", cat: "deadline" },
    ],
    "2026-05-15": [
      { time: "10:00", title: "Сдача Spark", cat: "deadline" },
    ],
    "2026-05-06": [
      { time: "14:00", title: "Дип-ревью MONOLITH", cat: "work" },
    ],
    "2026-05-19": [
      { time: "18:00", title: "Стрим code dump", cat: "personal" },
    ],
    "2026-05-21": [
      { time: "12:00", title: "Сдача ЗАЧЕЕЕТ", cat: "deadline" },
    ],
  },
  deadlines: [
    { label: "TODAY", title: "Go Reflect", color: "red" },
    { label: "2d",    title: "ЗАЧЕЕЕТ",    color: "yellow" },
    { label: "4d",    title: "Test PD Spark", color: "muted" },
    { label: "6d",    title: "Go Lowlevel",   color: "muted" },
  ],
  schedule: {
    Mon: [
      { range: "10:45-12:10", tags: ["Lecture","Math"], title: "Дискретный анализ", room: "415 ГК" },
      { range: "12:20-13:45", tags: ["Seminar","DM"],   title: "Дискретная матем.",   room: "212 ГК" },
      { range: "17:05-18:30", tags: ["Lab","FL"],       title: "Формальные языки",    room: "303 КПМ" },
    ],
    Tue: [
      { range: "09:00-10:25", tags: ["Lecture","ATP"],  title: "Алгоритмы и теория",  room: "513 КПМ" },
      { range: "12:20-13:45", tags: ["Seminar","Math"], title: "Матанализ. Семинар",  room: "201 ГК" },
    ],
    Wed: [
      { range: "10:45-12:10", tags: ["Seminar","ATP"],  title: "Параллельные и распределенные вычисления", room: "425 Физтех. Арктика" },
      { range: "17:05-18:30", tags: ["Lecture","ATP"],  title: "Разработка на Golang", room: "202 Квант", current: true },
      { range: "18:35-20:00", tags: ["Seminar","ATP"],  title: "Разработка на Golang", room: "202 Квант" },
    ],
    Thu: [
      { range: "12:20-13:45", tags: ["Lecture","Math"], title: "Линейная алгебра",    room: "201 ГК" },
      { range: "14:00-15:25", tags: ["Lab","DM"],       title: "Лабы по структурам",  room: "303 КПМ" },
    ],
    Fri: [
      { range: "10:45-12:10", tags: ["Sport"],          title: "Физическая культура", room: "UNK" },
      { range: "18:35-20:00", tags: ["Practic"],        title: "Инновационная практика", room: "115 КПМ" },
    ],
    Sat: [
      { range: "11:00-12:30", tags: ["Lecture","FL"],   title: "Формальные языки. Лекция", room: "513 КПМ" },
    ],
    Sun: [],
  },

  // ---------- DIARY ----------
  diary: [
    {
      date: "2026-05-13", short: "13 May", weekday: "Wednesday, 13 May 2026",
      mood: "focused", color: "blue",
      preview: "Started working on MonoView TUI...",
      body: `Started working on MonoView TUI. Сегодня дополнил schedule, починил парсер времени для расписания. Сел разбирать почему панель ACHTUNG не обновляется до прихода первого OK от концентратора. Кажется, нужен явный pending-state.

Завтра:
  - дописать ADD EVENT валидацию
  - заглушка для NOTES
  - набросок MESSENGER чата`,
    },
    {
      date: "2026-05-12", short: "12 May", weekday: "Tuesday, 12 May 2026",
      mood: "productive", color: "green",
      preview: "Fixed the WebSocket connection issues.",
      body: `Fixed the WebSocket connection issues. mTLS наконец-то стабильно держит соединение, переподключение работает без явных гонок. Перезаписал retry policy: экспоненциальный backoff + capped jitter.`,
    },
    {
      date: "2026-05-11", short: "11 May", weekday: "Monday, 11 May 2026",
      mood: "calm", color: "aqua",
      preview: "Rainy day. Read documentation.",
      body: `Rainy day. Читал доку bubbletea, набросал layout для CLOUD. Мысль: облако — это не SaaS, это распределённое личное хранилище. Узлы, шарды, состояние, как в SYSTEM.`,
    },
    {
      date: "2026-05-09", short: "09 May", weekday: "Saturday, 9 May 2026",
      mood: "tired", color: "yellow",
      preview: "Долгая отладка GOVERNOR. Не сошлись таймстампы.",
      body: `Долгая отладка GOVERNOR. Не сошлись таймстампы между нодами, монотонные часы тоже не совпадают. Поставил drift-метрику в SYSTEM panel.`,
    },
    {
      date: "2026-05-07", short: "07 May", weekday: "Thursday, 7 May 2026",
      mood: "stressed", color: "red",
      preview: "Куча дедлайнов на след. неделе.",
      body: `Слишком много дедлайнов. План на пятницу: закрыть Go Reflect, перенести лабу по FL. Если успею — набросаю MESSENGER.`,
    },
  ],

  // ---------- HOME ----------
  vertex: [
    { id: "lamp", name: "Desk Lamp",   topic: "LAMP",  kind: "toggle", state: "on" },
    { id: "led",  name: "LED Light",   topic: "LED",   kind: "toggle", state: "on" },
    { id: "mode", name: "LED Mode",    topic: "LED",   kind: "cycle",  state: "fade",  modes: ["solid","fade","blink"] },
    { id: "br",   name: "Brightness", topic: "LED",   kind: "value",  value: 225, max: 255, step: 15 },
    { id: "buzz", name: "Buzzer",      topic: "BUZZ",  kind: "toggle", state: "off" },
    { id: "fan",  name: "Desk Fan",    topic: "FAN",   kind: "toggle", state: "off" },
  ],
  ukaz: [
    { id: "deadlines", name: "Print Deadlines", cmd: "PRINT DEADLINES" },
    { id: "status",    name: "Print Status",    cmd: "PRINT STATUS" },
    { id: "schedule",  name: "Print Schedule",  cmd: "PRINT SCHEDULE" },
  ],
  achtung: [
    { kind: "TIMER", name: "tea_steep",   left: "02:14",  due: null },
    { kind: "TIMER", name: "pomodoro_25", left: "17:08",  due: null },
    { kind: "ALARM", name: "morning",     left: "07h 24m", due: "06:30" },
    { kind: "ALARM", name: "evening_run", left: "21h 02m", due: "19:00" },
  ],

  // ---------- SYSTEM ----------
  nodes: [
    { id: "VERTEX",   status: "online",  ping: 26,  uptime: "3d 14h 02m" },
    { id: "ACHTUNG",  status: "online",  ping: 31,  uptime: "3d 14h 02m" },
    { id: "GOVERNOR", status: "online",  ping: 19,  uptime: "11d 04h 18m" },
    { id: "UKAZ",     status: "offline", ping: null, uptime: "—" },
  ],
  logs: [
    { t: "23:36:50", lvl: "MSG",  src: "VERTEX",   msg: "OK:LED:STATE:ON" },
    { t: "23:36:48", lvl: "MSG",  src: "VERTEX",   msg: "OK:LED:BRIGHT:225" },
    { t: "23:36:44", lvl: "INFO", src: "MONOVIEW", msg: "ping VERTEX => 26ms" },
    { t: "23:36:34", lvl: "WARN", src: "UKAZ",     msg: "no heartbeat in 14s" },
    { t: "23:36:30", lvl: "MSG",  src: "ACHTUNG",  msg: "OK:LIST:2 timers, 2 alarms" },
    { t: "23:36:12", lvl: "ERR",  src: "UKAZ",     msg: "ECONNREFUSED 127.0.0.1:4011" },
    { t: "23:36:02", lvl: "MSG",  src: "GOVERNOR", msg: "OK:EVENTS:1" },
    { t: "23:35:55", lvl: "INFO", src: "MONOVIEW", msg: "subscribed: VERTEX, ACHTUNG, GOVERNOR" },
    { t: "23:35:50", lvl: "MSG",  src: "VERTEX",   msg: "OK:LAMP:STATE:ON" },
    { t: "23:35:33", lvl: "INFO", src: "MONOVIEW", msg: "connected wss://127.0.0.1:8443" },
  ],

  // ---------- MESSENGER ----------
  contacts: {
    me:      { id: "me",      name: "paravoz",     handle: "@paravoz",     status: "online", color: "yellow" },
    arseny:  { id: "arseny",  name: "Арсений",     handle: "@arseny",      status: "online", color: "green",  init: "AR" },
    masha:   { id: "masha",   name: "Маша",        handle: "@masha_m",     status: "typing", color: "purple", init: "MM" },
    dim:     { id: "dim",     name: "Дима",        handle: "@dim_k",       status: "online", color: "blue",   init: "DK" },
    coreteam:{ id: "coreteam",name: "core team",   handle: "#core-team",   status: "group",  color: "aqua",   members: 6,   init: "##" },
    mom:     { id: "mom",     name: "Мама",        handle: "@mama",        status: "offline last 2h", color: "muted",  init: "ма" },
    leha:    { id: "leha",    name: "Лёха",        handle: "@leha",        status: "offline yesterday", color: "muted", init: "LH" },
    fizteh:  { id: "fizteh",  name: "поток C-103", handle: "#c-103",       status: "group",  color: "orange", members: 28, init: "##" },
    nikita:  { id: "nikita",  name: "Никита",      handle: "@nik",         status: "online", color: "green",  init: "NK" },
    alice:   { id: "alice",   name: "Alice",       handle: "@alice",       status: "secret", color: "red",    init: "AL", secret: true },
  },
  chats: [
    {
      id: "arseny", peer: "arseny",
      pinned: true, unread: 0,
      lastTime: "23:34",
      preview: "ок, я закину коммит — проверь в master",
      messages: [
        { from: "arseny", t: "21:11", text: "ты видел сегодня PR от Дима?" },
        { from: "me",     t: "21:14", text: "Видел. Там GOVERNOR опять плодит горутины без cancel." },
        { from: "arseny", t: "21:14", text: "Угу. Я уже сделал ревью, просил завернуть.", read: true },
        { from: "me",     t: "21:15", text: "Ок, добью свой бранч и вернусь." },
        { from: "arseny", t: "23:30", text: "кстати, сваггер генерил из proto? у меня не подтянулся transcoder", read: true },
        { from: "me",     t: "23:33", text: "из proto, да. ща скину сниппет." },
        { from: "me",     t: "23:33", text: "buf generate --template buf.gen.yaml", read: true },
        { from: "me",     t: "23:33", text: "ну и потом make swagger", read: true },
        { from: "arseny", t: "23:34", text: "ок, я закину коммит — проверь в master" },
      ],
    },
    {
      id: "coreteam", peer: "coreteam",
      pinned: true, unread: 3,
      lastTime: "22:58",
      preview: "Маша: я подниму staging после ужина",
      messages: [
        { from: "dim",    t: "22:40", text: "ребят, кто-нибудь готов прогнать e2e на staging?" },
        { from: "masha",  t: "22:58", text: "я подниму staging после ужина" },
        { from: "nikita", t: "22:59", text: "+1, помогу" },
      ],
    },
    {
      id: "masha", peer: "masha",
      pinned: false, unread: 1,
      lastTime: "20:12",
      preview: "печатает...",
      messages: [
        { from: "masha", t: "20:11", text: "ты завтра придёшь на семинар по ATP?" },
        { from: "masha", t: "20:12", text: "...", typing: true },
      ],
    },
    {
      id: "dim", peer: "dim",
      pinned: false, unread: 0,
      lastTime: "19:02",
      preview: "Окей, спасибо. До завтра.",
      messages: [
        { from: "dim", t: "18:55", text: "глянь мой PR #312, там мутный merge" },
        { from: "me",  t: "19:00", text: "посмотрю, попозже отпишусь" },
        { from: "dim", t: "19:02", text: "Окей, спасибо. До завтра." },
      ],
    },
    {
      id: "fizteh", peer: "fizteh",
      pinned: false, unread: 12,
      lastTime: "18:44",
      preview: "Никита: пересдача в пятницу",
      messages: [
        { from: "nikita", t: "18:44", text: "пересдача в пятницу" },
      ],
    },
    {
      id: "alice", peer: "alice",
      pinned: false, unread: 0,
      lastTime: "пн",
      preview: "🔒 [secret] 12 messages",
      secret: true,
      messages: [],
    },
    {
      id: "mom", peer: "mom",
      pinned: false, unread: 0,
      lastTime: "пн",
      preview: "позвони как сможешь, не срочно",
      messages: [
        { from: "mom", t: "11:00", text: "позвони как сможешь, не срочно" },
        { from: "me",  t: "12:14", text: "ок, вечером наберу" },
      ],
    },
    {
      id: "leha", peer: "leha",
      pinned: false, unread: 0,
      lastTime: "08/05",
      preview: "го в субботу гриль?",
      messages: [
        { from: "leha", t: "Fri 19:01", text: "го в субботу гриль?" },
      ],
    },
  ],

  // ---------- NOTES (Obsidian-like) ----------
  vault: {
    name: "vault://monolith",
    tree: [
      { type: "dir", name: "00 inbox", open: true, children: [
        { type: "note", id: "todo",       name: "todo.md" },
        { type: "note", id: "shower",     name: "shower-thoughts.md" },
      ]},
      { type: "dir", name: "10 monolith", open: true, children: [
        { type: "note", id: "monolith",   name: "MONOLITH.md", active: true },
        { type: "note", id: "vertex",     name: "VERTEX.md" },
        { type: "note", id: "achtung",    name: "ACHTUNG.md" },
        { type: "note", id: "governor",   name: "GOVERNOR.md" },
        { type: "note", id: "ukaz",       name: "UKAZ.md" },
        { type: "note", id: "protocol",   name: "protocol.md" },
      ]},
      { type: "dir", name: "20 daily", open: false, children: [
        { type: "note", id: "d_0513",     name: "2026-05-13.md" },
        { type: "note", id: "d_0512",     name: "2026-05-12.md" },
        { type: "note", id: "d_0511",     name: "2026-05-11.md" },
      ]},
      { type: "dir", name: "30 study", open: false, children: [
        { type: "note", id: "atp",        name: "ATP.md" },
        { type: "note", id: "fl",         name: "FL.md" },
        { type: "note", id: "dm",         name: "DM.md" },
      ]},
      { type: "dir", name: "90 archive", open: false, children: [] },
    ],
    activeId: "monolith",
    notes: {
      monolith: {
        title: "MONOLITH",
        path: "10 monolith / MONOLITH.md",
        tags: ["#project","#os","#wip"],
        modified: "13 May 23:36",
        words: 412,
        body:
`# MONOLITH

> Operator-grade personal OS. Hub-based, terminal-first.

MONOLITH — это распределённая личная система. Состоит из узлов:
- [[VERTEX]] — физические устройства (свет, буззер, fan)
- [[ACHTUNG]] — таймеры и алармы
- [[GOVERNOR]] — события, дедлайны, расписание
- [[UKAZ]] — печать
- [[MONOVIEW]] — операторский UI (этот клиент)

## Текущее
Сейчас активная работа на [[VERTEX]] и [[ACHTUNG]]. Базовый
[[protocol]] стабилизирован, нужны валидация форм и pending-state.

## TODO
- [ ] добавить pending-state для команд [[VERTEX]]
- [ ] inline-валидацию форм [[GOVERNOR]]
- [x] переключение вкладок 1..7
- [ ] спроектировать NOTES-граф`,
      },
    },
    backlinks: ["VERTEX","ACHTUNG","GOVERNOR","UKAZ","protocol"],
    outgoing:  ["VERTEX","ACHTUNG","GOVERNOR","UKAZ","MONOVIEW","protocol"],
    // graph: nodes + edges. Coordinates are normalized (-1..1).
    graph: {
      nodes: [
        { id: "MONOLITH",  x:  0.00, y:  0.00, r: 18, kind: "core" },
        { id: "VERTEX",    x: -0.55, y: -0.35, r: 12, kind: "node" },
        { id: "ACHTUNG",   x:  0.60, y: -0.30, r: 12, kind: "node" },
        { id: "GOVERNOR",  x: -0.55, y:  0.40, r: 12, kind: "node" },
        { id: "UKAZ",      x:  0.55, y:  0.45, r: 12, kind: "node" },
        { id: "MONOVIEW",  x:  0.00, y: -0.70, r: 10, kind: "node" },
        { id: "protocol",  x:  0.00, y:  0.65, r: 10, kind: "doc" },
        { id: "ATP",       x: -0.90, y:  0.05, r:  7, kind: "tag" },
        { id: "FL",        x: -0.85, y: -0.55, r:  7, kind: "tag" },
        { id: "DM",        x:  0.88, y:  0.10, r:  7, kind: "tag" },
        { id: "todo",      x:  0.85, y: -0.55, r:  7, kind: "doc" },
        { id: "daily 13",  x: -0.20, y:  0.80, r:  6, kind: "doc" },
        { id: "daily 12",  x:  0.20, y:  0.80, r:  6, kind: "doc" },
      ],
      edges: [
        ["MONOLITH","VERTEX"],["MONOLITH","ACHTUNG"],["MONOLITH","GOVERNOR"],
        ["MONOLITH","UKAZ"],["MONOLITH","MONOVIEW"],["MONOLITH","protocol"],
        ["VERTEX","protocol"],["ACHTUNG","protocol"],["GOVERNOR","protocol"],["UKAZ","protocol"],
        ["GOVERNOR","daily 13"],["GOVERNOR","daily 12"],
        ["MONOLITH","todo"],["ATP","daily 13"],["DM","todo"],["FL","VERTEX"],
      ],
    },
  },

  // ---------- CLOUD ----------
  cloud: {
    cwd: "/monolith/builds/0.4.2/",
    bread: ["/", "monolith", "builds", "0.4.2"],
    entries: [
      { type: "dir",  name: "..",                size: null,        mtime: "—",          enc: false },
      { type: "dir",  name: "artifacts/",        size: "412.0 MB",  mtime: "13/05 22:10",enc: false, replicas: 3 },
      { type: "dir",  name: "logs/",             size: "  8.3 MB",  mtime: "13/05 23:30",enc: false, replicas: 2 },
      { type: "file", name: "monoview-linux-amd64",      size: "  9.1 MB", mtime: "13/05 22:09", enc: false, replicas: 3, sel: true },
      { type: "file", name: "monoview-darwin-arm64",     size: "  9.6 MB", mtime: "13/05 22:09", enc: false, replicas: 3 },
      { type: "file", name: "checksums.sha256",          size: "  1.2 KB", mtime: "13/05 22:10", enc: false, replicas: 3 },
      { type: "file", name: "RELEASE-NOTES.md",          size: "  4.8 KB", mtime: "13/05 21:58", enc: false, replicas: 3 },
      { type: "file", name: "secrets.env.age",           size: "    812 B",mtime: "12/05 11:02", enc: true,  replicas: 2 },
      { type: "file", name: "screen-recording-2026-05-13.mp4", size: "187.3 MB", mtime: "13/05 19:44", enc: false, replicas: 1, warn: "1 replica" },
    ],
    sel: 3,
    nodes: [
      { id: "n01 paravoz",    role: "primary",  used: 412, total: 1024, status: "online" },
      { id: "n02 vault-home", role: "replica",  used: 388, total: 1024, status: "online" },
      { id: "n03 vps-fra",    role: "replica",  used:  92, total:  500, status: "online" },
      { id: "n04 rpi-attic",  role: "cold",     used:  14, total:  256, status: "sleep" },
    ],
    jobs: [
      { id: "sync-1124", what: "screen-recording-2026-05-13.mp4 → n02", pct: 64, state: "running" },
      { id: "rep-0991",  what: "artifacts/  →  n03", pct: 100, state: "done" },
      { id: "snap-77",   what: "snapshot @ 2026-05-13T22:00", pct: 100, state: "done" },
      { id: "scrub-12",  what: "integrity scrub /monolith", pct: 11, state: "running" },
      { id: "back-09",   what: "weekly off-site backup", pct: 0, state: "queued" },
    ],
    pinned: [
      { name: "/monolith/", note: "project root" },
      { name: "/diary/",    note: "private (age)" },
      { name: "/photos/",   note: "media bucket" },
      { name: "/scratch/",  note: "ephemeral 24h" },
    ],
    stats: { used: 906, total: 2804, shards: 3014, healthy: 3014, snapshots: 14 },
  },
};

window.MONO_DATA = MONO_DATA;
