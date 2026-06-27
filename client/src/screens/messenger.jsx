// MESSENGER screen.

function MessengerScreen() {
  const chats = MONO_DATA.chats;
  const contacts = MONO_DATA.contacts;
  const [sel, setSel] = useState("arseny");
  const [draft, setDraft] = useState("");
  const [filter, setFilter] = useState("all"); // all | unread | pinned | groups | secret

  const filtered = chats.filter(c => {
    if (filter === "unread") return c.unread > 0;
    if (filter === "pinned") return c.pinned;
    if (filter === "groups") return contacts[c.peer]?.status === "group";
    if (filter === "secret") return c.secret;
    return true;
  });

  const chat = chats.find(c => c.id === sel);
  const peer = contacts[chat?.peer];

  return (
    <div className="msg-screen">
      {/* LEFT: chat list */}
      <div className="msg-chats">
        <Panel
          title="MESSENGER"
          sub={`${chats.length} chats`}
          hint="↑↓ select  [/] search"
        >
          <div className="msg-search">
            <span className="muted">[/]</span>
            <input className="form-input" placeholder="search chats, messages..." />
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
            {filtered.map(c => {
              const p = contacts[c.peer];
              const isSel = c.id === sel;
              const isGroup = p.status === "group";
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
                        {isGroup && c.messages.length > 0 && (
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
          </div>
          <div className="hr" />
          <div style={{ display: "flex", gap: 8 }}>
            <button className="btn primary">[n] new chat</button>
            <button className="btn">[c] contacts</button>
          </div>
        </Panel>
      </div>

      {/* CENTER: conversation */}
      <div className="msg-thread">
        <Panel
          title={peer.name.toUpperCase()}
          sub={peer.status === "group" ? `${peer.members} members` : peer.status === "typing" ? "печатает..." : peer.status}
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
                {peer.status === "typing"
                  ? <span style={{ color: "var(--blue)" }}>typing<TypingDots /></span>
                  : peer.status === "online"
                  ? <span style={{ color: "var(--green)" }}>● online</span>
                  : peer.status === "group"
                  ? <span style={{ color: "var(--aqua)" }}>## {peer.members} members</span>
                  : peer.status === "secret"
                  ? <span style={{ color: "var(--red)" }}>🔒 secret · e2e</span>
                  : <span className="muted">{peer.status}</span>}
              </div>
            </div>
            <div style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
              <button className="btn">[i] info</button>
              <button className="btn">[/] search</button>
              <button className="btn">[m] mute</button>
            </div>
          </div>
          <div className="hr" />
          <ConversationBody chat={chat} contacts={contacts} />
          <div className="hr" />
          <Composer draft={draft} setDraft={setDraft} secret={chat.secret} />
        </Panel>
      </div>

      {/* RIGHT: contact + utilities */}
      <div className="msg-side col">
        <ContactPanel peer={peer} />
        <SharedMedia />
        <PinnedMessages chat={chat} contacts={contacts} />
      </div>
    </div>
  );
}

function TypingDots() {
  const [n, setN] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setN(x => (x + 1) % 4), 350);
    return () => clearInterval(id);
  }, []);
  return <span>{".".repeat(n)}</span>;
}

function ConversationBody({ chat, contacts }) {
  if (chat.secret) {
    return (
      <div className="thread-empty">
        <pre className="ascii" style={{ color: "var(--red)", textAlign: "center", margin: "20px auto" }}>
{`     ┌─────────┐
     │  e2e    │
     │  ▓▓▓▓▓  │
     │  ▓ ▓▓▓  │
     └─────────┘`}
        </pre>
        <div style={{ textAlign: "center" }}>
          <div className="strong">SECRET CHAT</div>
          <div className="muted" style={{ marginTop: 6 }}>
            messages are end-to-end encrypted. content is not visible
            in MONOVIEW until you authenticate this device.
          </div>
          <button className="btn primary" style={{ marginTop: 14 }}>[Enter] unlock with key</button>
        </div>
      </div>
    );
  }
  return (
    <div className="thread-body">
      <div className="day-sep"><span>13 May · Wednesday</span></div>
      {chat.messages.map((m, i) => {
        const isMe = m.from === "me";
        const author = contacts[m.from] || contacts.me;
        return (
          <div key={i} className={"msg" + (isMe ? " me" : "")}>
            <span className={"msg-bar bar-" + author.color} />
            <div className="msg-content">
              <div className="msg-head">
                <span className={"msg-author author-" + author.color}>{isMe ? "you" : author.name}</span>
                <span className="msg-time muted">{m.t}</span>
                {isMe && (
                  <span className="msg-read">{m.read ? <span style={{ color: "var(--blue)" }}>✓✓</span> : <span className="muted">✓</span>}</span>
                )}
              </div>
              {m.typing ? (
                <div className="muted">печатает<TypingDots /></div>
              ) : (
                <div className="msg-text">{m.text}</div>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function Composer({ draft, setDraft, secret }) {
  if (secret) return null;
  return (
    <div className="composer">
      <span className="composer-prompt" style={{ color: "var(--orange)" }}>{">"}</span>
      <input
        className="form-input composer-input"
        placeholder="напиши сообщение..."
        value={draft}
        onChange={e => setDraft(e.target.value)}
      />
      <div className="composer-tools">
        <button className="btn">[a] attach</button>
        <button className="btn">[v] voice</button>
        <button className="btn">[e] emoji</button>
        <button className="btn primary">[⏎] send</button>
      </div>
    </div>
  );
}

function ContactPanel({ peer }) {
  const isGroup = peer.status === "group";
  return (
    <Panel title={isGroup ? "GROUP" : "CONTACT"} sub={peer.handle}>
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
          <div className="form-row"><label>nick</label><span className="v">{peer.handle}</span></div>
          <div className="form-row"><label>last seen</label><span className="v">сейчас</span></div>
          <div className="form-row"><label>since</label><span className="v">02 Feb 2024</span></div>
          <div className="form-row"><label>notifs</label><span className="v">on (all)</span></div>
        </>
      )}
      {isGroup && (
        <>
          <div className="form-row"><label>members</label><span className="v">{peer.members}</span></div>
          <div className="form-row"><label>admin</label><span className="v">arseny, you</span></div>
          <div className="form-row"><label>created</label><span className="v">12 Jan 2025</span></div>
        </>
      )}
      <div className="hr" />
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <button className="btn">[m] mute</button>
        <button className="btn">[p] pin</button>
        <button className="btn">[/] in chat</button>
        <button className="btn danger">[d] block</button>
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
    <Panel title="SHARED" sub="6 items">
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
      <button className="btn" style={{ marginTop: 6 }}>[Enter] open shared</button>
    </Panel>
  );
}

function PinnedMessages({ chat, contacts }) {
  const pinned = chat.messages.filter(m => m.read).slice(0, 2);
  return (
    <Panel title="PINNED" sub={pinned.length + " messages"}>
      {pinned.length === 0 ? (
        <div className="muted">No pinned messages</div>
      ) : (
        <div className="rowlist">
          {pinned.map((m, i) => {
            const a = contacts[m.from] || contacts.me;
            return (
              <div key={i} className="pinned-row">
                <span className={"msg-bar bar-" + a.color} style={{ position: "relative" }} />
                <div style={{ flex: 1, paddingLeft: 8 }}>
                  <div className="muted" style={{ fontSize: 11 }}>
                    {m.from === "me" ? "you" : a.name} · {m.t}
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
