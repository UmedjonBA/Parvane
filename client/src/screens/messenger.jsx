// MESSENGER screen.

function MessengerScreen({ me }) {
  const liveAvail = window.PARVANE.available;

  const { convs, loading: convsLoading, refresh: refreshConvs } = liveAvail
    ? window.useLiveConversations()
    : { convs: [], loading: false, refresh: () => {} };

  // В Tauri: только реальные беседы. В браузере: демо-данные.
  const chatList = liveAvail
    ? convs.map((c) => ({
        id:       c.peer,
        peer:     c.peer,
        pinned:   false,
        unread:   c.unread,
        lastTime: c.last_ts ? liveHHMM(c.last_ts) : "",
        preview:  c.last_text || "",
        isLive:   true,
        messages: [],
      }))
    : MONO_DATA.chats;

  // Контакты: только реальные peer'ы в Tauri, демо-данные в браузере
  const contacts = liveAvail
    ? buildLiveContacts(convs)
    : MONO_DATA.contacts;

  const [sel, setSel]       = useState(null);
  const [draft, setDraft]   = useState("");
  const [filter, setFilter] = useState("all");
  const [newChat, setNewChat]   = useState(false);
  const [newPeer, setNewPeer]   = useState("");
  const [newMsg, setNewMsg]     = useState("");
  const [newErr, setNewErr]     = useState("");

  // Выбираем первую беседу когда они загружены
  useEffect(() => {
    if (!sel && chatList.length > 0) setSel(chatList[0].id);
  }, [chatList.length]);

  const activePeer = liveAvail && sel && convs.some((c) => c.peer === sel) ? sel : null;
  const live = window.useLiveChat(me || "", activePeer || "");

  const filtered = chatList.filter((c) => {
    if (filter === "unread") return c.unread > 0;
    if (filter === "pinned") return c.pinned;
    return true;
  });

  const selChat = chatList.find((c) => c.id === sel);
  const peer    = sel ? (contacts[sel] || makePeerContact(sel)) : null;

  const isLiveChat    = liveAvail && !!activePeer;
  const displayMsgs   = isLiveChat
    ? live.messages.map((m) => ({
        from: m.from === "me" ? "me" : activePeer,
        t:    m.t,
        text: m.text,
        read: true,
      }))
    : (selChat?.messages || []);

  return (
    <div className="msg-screen">
      {/* LEFT */}
      <div className="msg-chats">
        <Panel title="МЕССЕНДЖЕР" sub={chatList.length ? `${chatList.length} бесед` : ""} hint="[/] поиск  [n] новый чат">
          <div className="msg-search">
            <span className="muted">[/]</span>
            <input className="form-input" placeholder="поиск…" />
          </div>
          <div className="msg-filter-row">
            {[["all","все"],["unread","непрочитанные"],["pinned","закреплённые"]].map(([k, label]) => (
              <button key={k} className={"filter-pill" + (filter === k ? " on" : "")} onClick={() => setFilter(k)}>
                {label}
              </button>
            ))}
          </div>
          <div className="hr" />
          <div className="chat-list">
            {filtered.map((c) => {
              const p      = contacts[c.peer] || makePeerContact(c.peer);
              const isSel  = c.id === sel;
              return (
                <button key={c.id} className={"chat-row" + (isSel ? " sel" : "")} onClick={() => setSel(c.id)}>
                  <div className={"chat-avatar avatar-" + p.color}>
                    <span>{p.init}</span>
                    {p.status === "online" && <span className="online-pip" />}
                  </div>
                  <div className="chat-meta">
                    <div className="chat-top">
                      <span className="strong chat-name">{p.name}</span>
                      <span className="muted chat-time">{c.lastTime}</span>
                    </div>
                    <div className="chat-bottom">
                      <span className="chat-prev muted">{c.preview}</span>
                      <span className="chat-tag">
                        {c.pinned && <span className="muted">📌</span>}
                        {c.unread > 0 && <span className="unread-badge">{c.unread}</span>}
                      </span>
                    </div>
                  </div>
                </button>
              );
            })}
            {liveAvail && chatList.length === 0 && !convsLoading && (
              <div className="muted" style={{ padding: "20px 8px", fontSize: 12, textAlign: "center" }}>
                нет бесед
                <div style={{ marginTop: 6, color: "var(--dim)" }}>
                  напишите кому-нибудь первым
                </div>
              </div>
            )}
            {convsLoading && (
              <div className="muted" style={{ padding: "8px", fontSize: 12 }}>загрузка…</div>
            )}
          </div>
          <div className="hr" />
          {newChat && (
            <div style={{ padding: "4px 0", display: "flex", flexDirection: "column", gap: 6 }}>
              <input
                className="form-input"
                placeholder="адрес: bob@local"
                value={newPeer}
                onChange={(e) => { setNewPeer(e.target.value); setNewErr(""); }}
                autoFocus
              />
              <input
                className="form-input"
                placeholder="первое сообщение…"
                value={newMsg}
                onChange={(e) => setNewMsg(e.target.value)}
                onKeyDown={async (e) => {
                  if (e.key === "Enter") {
                    const peer = newPeer.trim();
                    const txt  = newMsg.trim();
                    if (!peer) { setNewErr("введите адрес"); return; }
                    if (!txt)  { setNewErr("введите сообщение"); return; }
                    try {
                      await window.PARVANE.send(peer, txt);
                      setSel(peer);
                      setNewChat(false);
                      setNewPeer("");
                      setNewMsg("");
                      refreshConvs();
                    } catch (ex) {
                      setNewErr(String(ex));
                    }
                  }
                  if (e.key === "Escape") setNewChat(false);
                }}
              />
              {newErr && <div style={{ color: "var(--red)", fontSize: 11 }}>✗ {newErr}</div>}
              <div style={{ display: "flex", gap: 6 }}>
                <button className="btn primary" onClick={async () => {
                  const peer = newPeer.trim();
                  const txt  = newMsg.trim();
                  if (!peer) { setNewErr("введите адрес"); return; }
                  if (!txt)  { setNewErr("введите сообщение"); return; }
                  try {
                    await window.PARVANE.send(peer, txt);
                    setSel(peer);
                    setNewChat(false);
                    setNewPeer("");
                    setNewMsg("");
                    refreshConvs();
                  } catch (ex) {
                    setNewErr(String(ex));
                  }
                }}>[⏎] отправить</button>
                <button className="btn" onClick={() => setNewChat(false)}>[Esc]</button>
              </div>
            </div>
          )}
          <div style={{ display: "flex", gap: 8 }}>
            <button className="btn primary" onClick={() => { setNewChat(true); setNewErr(""); }}>[n] новый чат</button>
            <button className="btn" onClick={refreshConvs}>[r] обновить</button>
          </div>
        </Panel>
      </div>

      {/* CENTER */}
      <div className="msg-thread">
        {selChat && peer ? (
          <Panel
            title={peer.name.toUpperCase()}
            sub={isLiveChat ? (live.ready ? "● live" : "подключение…") : peer.status}
            hint="[Enter] отправить"
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
                  {peer.handle} · {isLiveChat
                    ? <span style={{ color: "var(--green)" }}>● live</span>
                    : <span className="muted">{peer.status}</span>}
                </div>
              </div>
              <div style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
                <button className="btn">[i] инфо</button>
                <button className="btn">[/] поиск</button>
              </div>
            </div>
            <div className="hr" />
            <ConversationBody messages={displayMsgs} contacts={contacts} me={me} peer={sel} />
            <div className="hr" />
            <Composer
              draft={draft}
              setDraft={setDraft}
              live={isLiveChat}
              error={live.error}
              onSend={isLiveChat ? live.send : null}
            />
          </Panel>
        ) : (
          <Panel title="МЕССЕНДЖЕР" focused>
            <div className="thread-empty">
              <div className="muted" style={{ textAlign: "center", paddingTop: 60, fontSize: 13 }}>
                {liveAvail && chatList.length === 0
                  ? "начните новую переписку"
                  : "выберите беседу"}
              </div>
            </div>
          </Panel>
        )}
      </div>

      {/* RIGHT */}
      <div className="msg-side col">
        {peer && <ContactPanel peer={peer} peerAddr={sel} />}
        {selChat && <PinnedMessages messages={displayMsgs} contacts={contacts} />}
      </div>
    </div>
  );
}

function buildLiveContacts(convs) {
  const m = {};
  convs.forEach((c) => { m[c.peer] = makePeerContact(c.peer); });
  return m;
}

function makePeerContact(addr) {
  if (!addr) return { name: "?", handle: "?", status: "offline", color: "muted", init: "?" };
  const name = addr.split("@")[0];
  const colors = ["blue","green","orange","purple","aqua","yellow"];
  const color = colors[addr.charCodeAt(0) % colors.length];
  return {
    id:     addr,
    name:   name,
    handle: "@" + name,
    status: "online",
    color,
    init:   name[0].toUpperCase(),
  };
}

function TypingDots() {
  const [n, setN] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setN((x) => (x + 1) % 4), 350);
    return () => clearInterval(id);
  }, []);
  return <span>{".".repeat(n)}</span>;
}

function ConversationBody({ messages, contacts, me, peer }) {
  return (
    <div className="thread-body">
      {messages.length === 0 && (
        <div className="muted" style={{ textAlign: "center", padding: "30px 0", fontSize: 12 }}>
          нет сообщений
        </div>
      )}
      {messages.map((m, i) => {
        const isMe   = m.from === "me";
        const author = contacts[m.from] || makePeerContact(m.from);
        return (
          <div key={m.id || i} className={"msg" + (isMe ? " me" : "")}>
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
              <div className="msg-text">{m.text}</div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function Composer({ draft, setDraft, live, error, onSend }) {
  const fire = () => {
    if (onSend && draft.trim()) { onSend(draft); setDraft(""); }
  };
  return (
    <div className="composer">
      <span className="composer-prompt" style={{ color: live ? "var(--green)" : "var(--orange)" }}>{">"}</span>
      <input
        className="form-input composer-input"
        placeholder={live ? "сообщение → бэкенд…" : "напишите сообщение…"}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); fire(); } }}
      />
      {error && <div style={{ color: "var(--red)", fontSize: 11 }}>✗ {error}</div>}
      <div className="composer-tools">
        <button className="btn">[a] вложить</button>
        <button className="btn primary" onClick={fire}>[⏎] send</button>
      </div>
    </div>
  );
}

function ContactPanel({ peer, peerAddr }) {
  return (
    <Panel title="КОНТАКТ" sub={peer.handle}>
      <div className="contact-head">
        <div className={"chat-avatar avatar-" + peer.color} style={{ width: 56, height: 56, fontSize: 18 }}>
          <span>{peer.init}</span>
        </div>
        <div style={{ flex: 1 }}>
          <div className="strong" style={{ fontSize: 16 }}>{peer.name}</div>
          <div className="muted">{peerAddr}</div>
          <div style={{ marginTop: 4 }}>
            <span style={{ color: "var(--green)" }}>● online</span>
          </div>
        </div>
      </div>
      <div className="hr" />
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <button className="btn">[m] без звука</button>
        <button className="btn danger">[d] заблокировать</button>
      </div>
    </Panel>
  );
}

function PinnedMessages({ messages, contacts }) {
  const pinned = messages.filter((m) => m.read).slice(0, 3);
  return (
    <Panel title="ЗАКРЕПЛЕНО" sub={pinned.length + " сообщений"}>
      {pinned.length === 0 ? (
        <div className="muted">нет закреплённых</div>
      ) : (
        <div className="rowlist">
          {pinned.map((m, i) => {
            const a = contacts[m.from] || makePeerContact(m.from);
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
