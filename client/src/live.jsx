// Мост к бэкенду Parvane через Tauri IPC.
// В браузере (без window.__TAURI__) деградирует мягко: available=false,
// приложение продолжает работать на моках как статичное демо.

(function () {
  const T = window.__TAURI__;
  const invoke = T && T.core ? T.core.invoke : null;
  window.PARVANE = {
    available: !!invoke,
    status: () => (invoke ? invoke("nats_status").catch(() => false) : Promise.resolve(false)),
    login: (user, password) =>
      invoke ? invoke("login", { user, password }) : Promise.reject("нет tauri"),
    currentUser: () => (invoke ? invoke("current_user") : Promise.resolve(null)),
    send: (to, text) =>
      invoke ? invoke("send_text", { to, text }) : Promise.reject("нет tauri"),
    // Tauri v2 конвертирует camelCase JS → snake_case Rust, поэтому ключ
    // должен быть lastSeenId (а не last_seen_id), иначе аргумент не дойдёт.
    sync: (last_seen_id) =>
      invoke ? invoke("sync_messages", { lastSeenId: last_seen_id }) : Promise.resolve([]),
  };
})();

const ZERO_UUID = "00000000-0000-0000-0000-000000000000";

function liveTextOf(content) {
  if (!content) return "";
  if (content.kind === "text") return content.text;
  return "[" + content.kind + "]";
}

function liveHHMM(sec) {
  const d = new Date(sec * 1000);
  const p = (n) => String(n).padStart(2, "0");
  return p(d.getHours()) + ":" + p(d.getMinutes());
}

// Статус соединения с бэкендом: null = неизвестно (веб/моки), bool в десктопе.
function useLiveStatus() {
  const [online, setOnline] = useState(null);
  useEffect(() => {
    if (!window.PARVANE.available) return;
    let alive = true;
    const tick = () => window.PARVANE.status().then((s) => alive && setOnline(!!s));
    tick();
    const id = setInterval(tick, 3000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);
  return online;
}

// Живой чат с одним собеседником через реальный messenger-шард.
// `me` логинится при монтировании; входящие тянутся синхронизацией каждые 2.5с;
// исходящие пишутся оптимистично (sync возвращает только адресованное мне).
function useLiveChat(me, peer) {
  const [messages, setMessages] = useState([]);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState(null);
  const lastSeen = useRef(ZERO_UUID);

  useEffect(() => {
    if (!window.PARVANE.available) return;
    let alive = true;
    let timer = null;

    const pull = async () => {
      try {
        const incoming = await window.PARVANE.sync(lastSeen.current);
        if (!alive || !incoming.length) return;
        setMessages((prev) => {
          const seen = new Set(prev.map((m) => m.id));
          const add = incoming
            .filter((m) => !seen.has(m.id))
            .map((m) => ({
              id: m.id,
              from: "live",
              text: liveTextOf(m.content),
              t: liveHHMM(m.ts),
            }));
          return add.length ? [...prev, ...add] : prev;
        });
        lastSeen.current = incoming[incoming.length - 1].id;
      } catch (e) {
        console.error("[live] sync", e);
      }
    };

    (async () => {
      try {
        await window.PARVANE.login(me, "app");
        if (!alive) return;
        setReady(true);
        await pull();
        timer = setInterval(pull, 2500);
      } catch (e) {
        if (alive) setError(String(e));
        console.error("[live] login", e);
      }
    })();

    return () => {
      alive = false;
      if (timer) clearInterval(timer);
    };
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
      console.error("[live] send", e);
    }
  };

  return { messages, ready, error, send };
}

window.useLiveStatus = useLiveStatus;
window.useLiveChat = useLiveChat;
