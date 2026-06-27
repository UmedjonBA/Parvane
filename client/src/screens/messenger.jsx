// MESSENGER screen — реальные беседы через messenger-шард.

function MessengerScreen({ me }) {
  const liveAvail = window.PARVANE.available;

  // Список бесед из бэкенда
  const { convs, refresh: refreshConvs } = liveAvail
    ? window.useLiveConversations()
    : { convs: [], refresh: () => {} };

  // Строим список чатов: живые + мок-данные (мок только если не авторизованы)
  const liveChats = convs.map((c) => ({
    id:       c.peer,
    peer:     c.peer,
    pinned:   false,
    unread:   c.unread,
    lastTime: c.last_ts ? liveHHMM(c.last_ts) : "",
    preview:  c.last_text || "",
    isLive:   true,
    messages: [], // загружаются при выборе беседы
  }));

  const baseChats = liveAvail && liveChats.length > 0 ? liveChats : MONO_DATA.chats;
  const [sel, setSel]   = useState(null);
  const [draft, setDraft] = useState("");
  const [filter, setFilter] = useState("all");

  // Выбираем первую беседу по умолчанию
  useEffect(() => {
    if (!sel && baseChats.length > 0) setSel(baseChats[0].id);
  }, [baseChats.length]);

  // Живой чат с выбранным собеседником
  const activePeer = liveAvail && sel && convs.find((c) => c.peer === sel)
    ? sel
    : null;
  const live = window.useLiveChat(me || "demo", activePeer || "");

  // Контакты: реальный peer как объект или берём из MONO_DATA
  const contacts = { ...MONO_DATA.contacts };
  convs.forEach((c) => {
    if (!contacts[c.peer]) {
      contacts[c.peer] = {
        id:     c.peer,
        name:   c.peer.split("@")[0],
        handle: "@" + c.peer.split("@")[0],
        status: "online",
        color:  "blue",
        init:   c.peer[0].toUpperCase(),
      };
    }
  });

  const filtered = baseChats.filter((c) => {
    if (filter === "unread")  return c.unread > 0;
    if (filter === "pinned")  return c.pinned;
    if (filter === "groups")  return contacts[c.peer]?.status === "group";
    if (filter === "secret")  return c.secret;
    return true;
  });

  const selChat = baseChats.find((c) => c.id === sel);
  const peer    = selChat ? (contacts[selChat.peer] || contacts.me) : contacts.me;

  // Сообщения: реальные от useLiveChat или мок из selChat
  const isLiveChat = liveAvail && activePeer;
  const displayMessages = isLiveChat
    ? live.messages.map((m) => ({
        from: m.from === "me" ? "me" : activePeer,
        t:    m.t,
        text: m.text,
        read: true,
      }))
    : (selChat?.messages || []);

  return (
    <div className="msg-screen">
      {/* LEFT: список чатов */}
      <div className="msg-chats">
        <Panel
          title="MESSENGER"
          sub={`${baseChats.length} бесед`}
          hint="↑↓ select  [/] search"
        >
          <div className="msg-search">
            <span className="muted">[/]</span>
            <input className="form-input" placeholder="поиск чатов…" />
          </div>
          <div className="msg-filter-row">
            {[["all","all"],["unread","unread"],["pinned","pin"],["groups","groups"],["secret","🔒"]].map(([k, label]) => (
              <button key={k} className={"filter-pill" + (filter === k ? " on" : "")} onClick={() => setFilter(k)}>
                {label}
              </button>
            ))}
          </div>
          <div className="hr" />
          <div className="chat-list">
            {filtered.map((c) => {
              const p      = contacts[c.peer] || contacts.me;
              const isSel  = c.id === sel;
              const isGroup= p.status === "group";
              return (
                <button
                  key={c.id}
                  className={"chat-row" + (isSel ? " sel" : "")}
                  onClick={() => setSel(c.id)}
                >
                  <div className={"chat-avatar avatar-" + p.color}>
                    <span>{p.init}</span>
                    {p.status === "online" && !isGroup && <span className="online-pip" />}
                  </div>
                  <div className="chat-meta">
                    <div className="chat-top">
                      <span className="strong chat-name">
                        {c.secret && <span style={{ color: "var(--red)" }}>🔒 </span>}
                        {p.name}
                      </span>
                      <span className="muted chat-time">{c.lastTime}</span>
                    </div>
                    <div className="chat-bottom">
                      <span className={"chat-prev " + (p.status === "typing" ? "typing" : "muted")}>
                        {isGroup && c.messages?.length > 0 && (
                          <span style={{ color: "var(--" + (contacts[c.messages.at(-1).from]?.color || "muted") + ")" }}>
                            {(contacts[c.messages.at(-1).from]?.name || c.messages.at(-1).from) + ": "}
                          </span>
                        )}
                        {c.preview}
                      </span>
                      <span className="chat-tag">
                        {c.pinned && <span className="muted">📌</span>}
                        {c.unread > 0 && <span className="unread-badge">{c.unread}</span>}
                      </span>
                    </div>
                  </div>
                </button>
              );
            })}
            {filtered.length === 0 && (
              <div className="muted" style={{ padding: "12px 8px", fontSize: 12 }}>
                {liveAvail ? "нет бесед" : "нет чатов"}
              </div>
            )}
          </div>
          <div className="hr" />
          <div style={{ display: "flex", gap: 8 }}>
            <button className="btn primary" onClick={refreshConvs}>[r] обновить</button>
            <button className="btn">[n] новый чат</button>
          </div>
        </Panel>
      </div>

      {/* CENTER: переписка */}
      <div className="msg-thread">
        {selChat ? (
          <Panel
            title={peer.name.toUpperCase()}
            sub={peer.status === "group" ? `${peer.members} участников` : peer.status === "typing" ? "печатает..." : peer.status}
            hint="↑↓ scroll  [Enter] send  [r] reply"
            focused
            className="thread-panel"
          >
            <div className="thread-top">
              <div className={"chat-avatar avatar-" + peer.color}>
                <span>{peer.init}</span>
              </div>
              <div>
                <div className="strong">{peer.name}</div>
                <div className="muted" style={{ fontSize: 11 }}>
                  {peer.handle} ·{" "}
                  {isLiveChat
                    ? <span style={{ color: "var(--green)" }}>● live · {live.ready ? "подключён" : "загрузка…"}</span>
                    : peer.status === "typing"
                    ? <span style={{ color: "var(--blue)" }}>typing<TypingDots /></span>
                    : peer.status === "online"
                    ? <span style={{ color: "var(--green)" }}>● online</span>
                    : peer.status === "group"
                    ? <span style={{ color: "var(--aqua)" }}>## {peer.members} members</span>
                    : <span className="muted">{peer.status}</span>}
                </div>
              </div>
              <div style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
                <button className="btn">[i] инфо</button>
                <button className="btn">[/] поиск</button>
                <button className="btn">[m] звук</button>
              </div>
            </div>
            <div className="hr" />
            <ConversationBody messages={displayMessages} contacts={contacts} me={me} />
            <div className="hr" />
            <Composer
              draft={draft}
              setDraft={setDraft}
              secret={selChat.secret}
              live={isLiveChat}
              error={live.error}
              onSend={isLiveChat ? live.send : null}
            />
          </Panel>
        ) : (
          <Panel title="MESSENGER" focused>
            <div className="thread-empty">
              <div className="muted" style={{ textAlign: "center", paddingTop: 40 }}>
                выберите беседу
              </div>
            </div>
          </Panel>
        )}
      </div>

      {/* RIGHT: инфо о собеседнике */}
      <div className="msg-side col">
        {selChat && <ContactPanel peer={peer} />}
        <SharedMedia />
        {selChat && <PinnedMessages messages={displayMessages} contacts={contacts} />}
      </div>
    </div>
  );
}

function TypingDots() {
  const [n, setN] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setN((x) => (x + 1) % 4), 350);
    return () => clearInterval(id);
  }, []);
  return <span>{".".repeat(n)}</span>;
}

function ConversationBody({ messages, contacts, me }) {
  return (
    <div className="thread-body">
      <div className="day-sep"><span>сегодня</span></div>
      {messages.length === 0 && (
        <div className="muted" style={{ textAlign: "center", padding: "20px 0", fontSize: 12 }}>
          нет сообщений
        </div>
      )}
      {messages.map((m, i) => {
        const isMe   = m.from === "me";
        const author = contacts[m.from] || { name: m.from, color: "blue", init: (m.from || "?")[0] };
        return (
          <div key={i} className={"msg" + (isMe ? " me" : "")}>
            <span className={"msg-bar bar-" + author.color} />
            <div className="msg-content">
              <div className="msg-head">
                <span className={"msg-author author-" + author.color}>{isMe ? "вы" : author.name}</span>
                <span className="msg-time muted">{m.t}</span>
                {isMe && (
                  <span className="msg-read">
                    {m.read
                      ? <span style={{ color: "var(--blue)" }}>✓✓</span>
                      : <span className="muted">✓</span>}
                  </span>
                )}
              </div>
              {m.typing
                ? <div className="muted">печатает<TypingDots /></div>
                : <div className="msg-text">{m.text}</div>}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function Composer({ draft, setDraft, secret, live, error, onSend }) {
  if (secret) return null;
  const fire = () => {
    if (onSend && draft.trim()) {
      onSend(draft);
      setDraft("");
    }
  };
  return (
    <div className="composer">
      <span className="composer-prompt" style={{ color: live ? "var(--green)" : "var(--orange)" }}>{">"}</span>
      <input
        className="form-input composer-input"
        placeholder={live ? "сообщение → messenger-шард…" : "напиши сообщение..."}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); fire(); } }}
      />
      {error && <div style={{ color: "var(--red)", fontSize: 11, padding: "0 8px" }}>✗ {error}</div>}
      <div className="composer-tools">
        <button className="btn">[a] вложить</button>
        <button className="btn">[v] голос</button>
        <button className="btn primary" onClick={fire}>[⏎] send</button>
      </div>
    </div>
  );
}

function ContactPanel({ peer }) {
  const isGroup = peer.status === "group";
  return (
    <Panel title={isGroup ? "ГРУППА" : "КОНТАКТ"} sub={peer.handle}>
      <div className="contact-head">
        <div className={"chat-avatar avatar-" + peer.color} style={{ width: 56, height: 56, fontSize: 18 }}>
          <span>{peer.init}</span>
        </div>
        <div style={{ flex: 1 }}>
          <div className="strong" style={{ fontSize: 16 }}>{peer.name}</div>
          <div className="muted">{peer.handle}</div>
          <div style={{ marginTop: 4 }}>
            {peer.status === "online"
              ? <span style={{ color: "var(--green)" }}>● online</span>
              : peer.status === "group"
              ? <span style={{ color: "var(--aqua)" }}>## group · {peer.members} members</span>
              : peer.status === "secret"
              ? <span style={{ color: "var(--red)" }}>🔒 secret</span>
              : <span className="muted">{peer.status}</span>}
          </div>
        </div>
      </div>
      <div className="hr" />
      {!isGroup && (
        <>
          <div className="form-row"><label>адрес</label><span className="v">{peer.handle}</span></div>
          <div className="form-row"><label>статус</label><span className="v">{peer.status}</span></div>
        </>
      )}
      <div className="hr" />
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <button className="btn">[m] без звука</button>
        <button className="btn danger">[d] заблокировать</button>
      </div>
    </Panel>
  );
}

function SharedMedia() {
  const tiles = [
    { kind: "img", label: "schedule.png" },
    { kind: "img", label: "log.svg" },
    { kind: "doc", label: "spec_v3.md" },
    { kind: "img", label: "screen.png" },
    { kind: "doc", label: "proto.go" },
    { kind: "img", label: "ascii.txt" },
  ];
  return (
    <Panel title="МЕДИА" sub="6 вложений">
      <div className="shared-grid">
        {tiles.map((t, i) => (
          <div key={i} className="shared-cell">
            <div className="shared-thumb">
              {t.kind === "img" ? (
                <pre className="ascii dim" style={{ fontSize: 8, lineHeight: 1, margin: 0 }}>
{`▓▓▒▒░░
░▒▓▓▒░░
▒▓██▓▒░
░▒▓▓▒░░`}
                </pre>
              ) : (
                <span style={{ color: "var(--blue)" }}>md</span>
              )}
            </div>
            <div className="shared-label muted">{t.label}</div>
          </div>
        ))}
      </div>
    </Panel>
  );
}

function PinnedMessages({ messages, contacts }) {
  const pinned = messages.filter((m) => m.read).slice(0, 2);
  return (
    <Panel title="ЗАКРЕПЛЕНО" sub={pinned.length + " сообщений"}>
      {pinned.length === 0 ? (
        <div className="muted">нет закреплённых</div>
      ) : (
        <div className="rowlist">
          {pinned.map((m, i) => {
            const a = contacts[m.from] || { name: m.from, color: "blue" };
            return (
              <div key={i} className="pinned-row">
                <span className={"msg-bar bar-" + a.color} style={{ position: "relative" }} />
                <div style={{ flex: 1, paddingLeft: 8 }}>
                  <div className="muted" style={{ fontSize: 11 }}>
                    {m.from === "me" ? "вы" : a.name} · {m.t}
                  </div>
                  <div>{m.text}</div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </Panel>
  );
}

window.MessengerScreen = MessengerScreen;
