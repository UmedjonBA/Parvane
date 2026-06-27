// Мост к бэкенду Parvane через Tauri IPC.
// В браузере (без window.__TAURI__) available=false — все хуки работают на моках.

(function () {
  const T = window.__TAURI__;
  const invoke = T && T.core ? T.core.invoke : null;
  const P = {
    available: !!invoke,
    // auth
    status:      ()               => invoke ? invoke("nats_status").catch(() => false) : Promise.resolve(false),
    login:       (user, password) => invoke ? invoke("login",    { user, password })   : Promise.reject("нет tauri"),
    logout:      ()               => invoke ? invoke("logout")                          : Promise.resolve(),
    currentUser: ()               => invoke ? invoke("current_user")                    : Promise.resolve(null),
    // messenger
    sync:            (since)     => invoke ? invoke("sync_messages",    { since })         : Promise.resolve([]),
    getConversations:()          => invoke ? invoke("get_conversations")                   : Promise.resolve([]),
    getMessages:     (peer)      => invoke ? invoke("get_messages",     { peer })          : Promise.resolve([]),
    send:            (to, text)  => invoke ? invoke("send_text",        { to, text })      : Promise.reject("нет tauri"),
    // notes
    listNotes:   ()                                    => invoke ? invoke("list_notes")                                    : Promise.resolve([]),
    createNote:  (title)                               => invoke ? invoke("create_note",  { title })                      : Promise.reject("нет tauri"),
    saveNote:    (note_id, title, body)                => invoke ? invoke("save_note",    { id: note_id, title, body })   : Promise.resolve(),
    deleteNote:  (note_id)                             => invoke ? invoke("delete_note",  { id: note_id })                : Promise.resolve(),
    // calendar
    listEvents:       ()                                           => invoke ? invoke("list_events")                                          : Promise.resolve([]),
    createEvent:      (fields)                                     => invoke ? invoke("create_event",       { fields })                       : Promise.reject("нет tauri"),
    updateEventField: (event_id, field, value)                     => invoke ? invoke("update_event_field", { id: event_id, field, value })   : Promise.resolve(),
    deleteEvent:      (event_id)                                   => invoke ? invoke("delete_event",       { id: event_id })                 : Promise.resolve(),
    // cloud
    listFiles: () => invoke ? invoke("list_files") : Promise.resolve({ files: [] }),
    // calls
    callHistory: () => invoke ? invoke("call_history") : Promise.resolve({ calls: [] }),
  };
  window.PARVANE = P;
})();

const ZERO_UUID = "00000000-0000-0000-0000-000000000000";

// ── auth ────────────────────────────────────────────────────────────────────

// Логин с сохранением в localStorage.
async function parvaneLogin(user, password) {
  await window.PARVANE.login(user, password);
  localStorage.setItem("parvane_user",     user);
  localStorage.setItem("parvane_password", password);
}

// Выход и очистка.
async function parvaneLogout() {
  await window.PARVANE.logout();
  localStorage.removeItem("parvane_user");
  localStorage.removeItem("parvane_password");
}

// Попытка автоматического входа при старте приложения (из localStorage).
if (window.PARVANE.available) {
  (async () => {
    const user     = localStorage.getItem("parvane_user");
    const password = localStorage.getItem("parvane_password");
    if (user && password) {
      try {
        await window.PARVANE.login(user, password);
        console.log("[live] auto-login OK:", user);
      } catch (e) {
        console.warn("[live] auto-login failed:", e);
      }
    }
  })();
}

window.parvaneLogin  = parvaneLogin;
window.parvaneLogout = parvaneLogout;

// ── утилиты ─────────────────────────────────────────────────────────────────

function liveTextOf(content) {
  if (!content) return "";
  if (content.kind === "text")       return content.text;
  if (content.kind === "voice")      return "🎤 Голосовое";
  if (content.kind === "video_note") return "🎥 Кружочек";
  if (content.kind === "photo")      return "🖼 Фото" + (content.caption ? ": " + content.caption : "");
  if (content.kind === "video")      return "📹 Видео" + (content.caption ? ": " + content.caption : "");
  if (content.kind === "file")       return "📎 " + (content.filename || "файл");
  return "[" + content.kind + "]";
}

function liveHHMM(sec) {
  const d = new Date(sec * 1000);
  const p = (n) => String(n).padStart(2, "0");
  return p(d.getHours()) + ":" + p(d.getMinutes());
}

// ── хуки ────────────────────────────────────────────────────────────────────

// Статус соединения: null=неизвестно, true/false в десктопе.
function useLiveStatus() {
  const [online, setOnline] = useState(null);
  useEffect(() => {
    if (!window.PARVANE.available) return;
    let alive = true;
    const tick = () => window.PARVANE.status().then((s) => alive && setOnline(!!s));
    tick();
    const id = setInterval(tick, 3000);
    return () => { alive = false; clearInterval(id); };
  }, []);
  return online;
}

// Текущий залогиненный пользователь (null если нет).
function useLiveUser() {
  const [user, setUser] = useState(null);
  useEffect(() => {
    if (!window.PARVANE.available) return;
    window.PARVANE.currentUser().then(setUser).catch(() => setUser(null));
  }, []);
  return [user, setUser];
}

// Список бесед, отсортированных по времени последнего сообщения.
function useLiveConversations() {
  const [convs, setConvs]     = useState([]);
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    if (!window.PARVANE.available) return;
    setLoading(true);
    try {
      const data = await window.PARVANE.getConversations();
      setConvs(data || []);
    } catch (e) {
      console.error("[live] getConversations:", e);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
    const id = setInterval(refresh, 5000);
    return () => clearInterval(id);
  }, [refresh]);

  return { convs, loading, refresh };
}

// Живой чат с конкретным собеседником, с поллингом входящих.
function useLiveChat(me, peer) {
  const [messages, setMessages] = useState([]);
  const [ready, setReady]       = useState(false);
  const [error, setError]       = useState(null);
  const lastSeen                = useRef(ZERO_UUID);

  useEffect(() => {
    if (!window.PARVANE.available || !me || !peer) return;
    let alive = true;
    let timer = null;

    const loadAll = async () => {
      const msgs = await window.PARVANE.getMessages(peer);
      if (!alive) return;
      setMessages(msgs.map((m) => ({
        id:   m.id,
        from: m.from === me ? "me" : "peer",
        text: liveTextOf(m.content),
        t:    liveHHMM(m.ts),
      })));
      if (msgs.length) lastSeen.current = msgs[msgs.length - 1].id;
    };

    const pull = async () => {
      try {
        const incoming = await window.PARVANE.sync(lastSeen.current);
        if (!alive || !incoming.length) return;
        const fromPeer = incoming.filter((m) => m.from === peer || m.to === peer);
        if (!fromPeer.length) return;
        setMessages((prev) => {
          const seen = new Set(prev.map((m) => m.id));
          const add  = fromPeer
            .filter((m) => !seen.has(m.id))
            .map((m) => ({
              id:   m.id,
              from: m.from === me ? "me" : "peer",
              text: liveTextOf(m.content),
              t:    liveHHMM(m.ts),
            }));
          return add.length ? [...prev, ...add] : prev;
        });
        lastSeen.current = incoming[incoming.length - 1].id;
      } catch (e) {
        console.error("[live] sync:", e);
      }
    };

    (async () => {
      try {
        await loadAll();
        if (!alive) return;
        setReady(true);
        timer = setInterval(pull, 2500);
      } catch (e) {
        if (alive) setError(String(e));
        console.error("[live] useLiveChat init:", e);
      }
    })();

    return () => { alive = false; if (timer) clearInterval(timer); };
  }, [me, peer]);

  const send = async (text) => {
    const body = text.trim();
    if (!body) return;
    try {
      const id = await window.PARVANE.send(peer, body);
      setMessages((prev) => [
        ...prev,
        { id, from: "me", text: body, t: liveHHMM(Date.now() / 1000) },
      ]);
    } catch (e) {
      setError(String(e));
      console.error("[live] send:", e);
    }
  };

  return { messages, ready, error, send };
}

// Заметки: полный CRUD через notes-шард.
function useLiveNotes() {
  const [notes, setNotes]     = useState([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving]   = useState(false);

  const refresh = useCallback(async () => {
    if (!window.PARVANE.available) return;
    setLoading(true);
    try {
      const data = await window.PARVANE.listNotes();
      setNotes(data || []);
    } catch (e) {
      console.error("[live] listNotes:", e);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  const create = async (title) => {
    const id = await window.PARVANE.createNote(title);
    await refresh();
    return id;
  };

  const save = async (note_id, title, body) => {
    setSaving(true);
    try {
      await window.PARVANE.saveNote(note_id, title, body);
      setNotes((prev) =>
        prev.map((n) => n.note_id === note_id ? { ...n, title, text: body } : n)
      );
    } finally {
      setSaving(false);
    }
  };

  const remove = async (note_id) => {
    await window.PARVANE.deleteNote(note_id);
    setNotes((prev) => prev.filter((n) => n.note_id !== note_id));
  };

  return { notes, loading, saving, refresh, create, save, remove };
}

// Календарь: события через calendar-шард.
function useLiveCalendar() {
  const [events, setEvents]   = useState([]);
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    if (!window.PARVANE.available) return;
    setLoading(true);
    try {
      const data = await window.PARVANE.listEvents();
      setEvents(data || []);
    } catch (e) {
      console.error("[live] listEvents:", e);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
    const id = setInterval(refresh, 10000);
    return () => clearInterval(id);
  }, [refresh]);

  const create = async (title, start, end, location) => {
    const fields = { title, start: String(start), end: String(end) };
    if (location) fields.location = location;
    const id = await window.PARVANE.createEvent(fields);
    await refresh();
    return id;
  };

  const update = async (event_id, field, value) => {
    await window.PARVANE.updateEventField(event_id, field, value);
    await refresh();
  };

  const remove = async (event_id) => {
    await window.PARVANE.deleteEvent(event_id);
    setEvents((prev) => prev.filter((e) => e.event_id !== event_id));
  };

  return { events, loading, refresh, create, update, remove };
}

// Облако: список файлов.
function useLiveFiles() {
  const [files, setFiles]     = useState([]);
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    if (!window.PARVANE.available) return;
    setLoading(true);
    try {
      const resp = await window.PARVANE.listFiles();
      setFiles((resp && resp.files) ? resp.files : []);
    } catch (e) {
      console.error("[live] listFiles:", e);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
    const id = setInterval(refresh, 15000);
    return () => clearInterval(id);
  }, [refresh]);

  return { files, loading, refresh };
}

// История звонков.
function useLiveCallHistory() {
  const [calls, setCalls]     = useState([]);
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    if (!window.PARVANE.available) return;
    setLoading(true);
    try {
      const resp = await window.PARVANE.callHistory();
      setCalls((resp && resp.calls) ? resp.calls : []);
    } catch (e) {
      console.error("[live] callHistory:", e);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  return { calls, loading, refresh };
}

window.useLiveStatus       = useLiveStatus;
window.useLiveUser         = useLiveUser;
window.useLiveConversations= useLiveConversations;
window.useLiveChat         = useLiveChat;
window.useLiveNotes        = useLiveNotes;
window.useLiveCalendar     = useLiveCalendar;
window.useLiveFiles        = useLiveFiles;
window.useLiveCallHistory  = useLiveCallHistory;
window.liveTextOf          = liveTextOf;
window.liveHHMM            = liveHHMM;
