// MESSENGER screen.

// ── локальное состояние (localStorage) ───────────────────────────────────────
// Прочитанность и группы храним на клиенте: бэкенд про «прочитано» не знает,
// его unread — это всего лишь общее число полученных от собеседника сообщений.
function lsLoad(key, fallback) {
  try { const v = JSON.parse(localStorage.getItem(key)); return v == null ? fallback : v; }
  catch { return fallback; }
}
function lsSave(key, value) { localStorage.setItem(key, JSON.stringify(value)); }

const LS_READ    = "pv_chat_read";          // { peer: <baseline кумулятивного unread> }
const LS_GROUPS  = "pv_chat_groups";        // [{ id, name }]
const LS_ASSIGN  = "pv_chat_group_assign";  // { peer: groupId }
const LS_PINNED  = "pv_pinned";             // { peer: { msgId: {id, from, t, text} } }

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

  // Прочитанность и группы (клиентское состояние, см. helpers выше)
  const [readState, setReadState] = useState(() => lsLoad(LS_READ, {}));
  const [groups, setGroups]       = useState(() => lsLoad(LS_GROUPS, []));
  const [assign, setAssign]       = useState(() => lsLoad(LS_ASSIGN, {}));
  const [menu, setMenu]           = useState(null); // {x,y,peer,creating?}
  const [groupDraft, setGroupDraft] = useState(null); // null=не создаём, строка=ввод имени
  const [pinned, setPinned]       = useState(() => lsLoad(LS_PINNED, {}));
  const [msgMenu, setMsgMenu]     = useState(null); // {x,y,msg,el}

  const togglePin = useCallback((peer, msg) => {
    if (!peer || !msg || msg.id == null) return;
    setPinned((prev) => {
      const forPeer = { ...(prev[peer] || {}) };
      if (forPeer[msg.id]) delete forPeer[msg.id];
      else forPeer[msg.id] = { id: msg.id, from: msg.from, t: msg.t, text: msg.text };
      const next = { ...prev, [peer]: forPeer };
      lsSave(LS_PINNED, next);
      return next;
    });
  }, []);

  const markRead = useCallback((peer, cumulative) => {
    setReadState((prev) => {
      if (prev[peer] === cumulative) return prev;
      const next = { ...prev, [peer]: cumulative };
      lsSave(LS_READ, next);
      return next;
    });
  }, []);

  const markUnread = useCallback((peer) => {
    setReadState((prev) => {
      const next = { ...prev, [peer]: 0 };
      lsSave(LS_READ, next);
      return next;
    });
  }, []);

  const addGroup = useCallback((name) => {
    const nm = name.trim();
    if (!nm) return null;
    const g = { id: "g" + Date.now().toString(36), name: nm };
    setGroups((prev) => { const next = [...prev, g]; lsSave(LS_GROUPS, next); return next; });
    return g.id;
  }, []);

  const deleteGroup = useCallback((id) => {
    setGroups((prev) => { const next = prev.filter((g) => g.id !== id); lsSave(LS_GROUPS, next); return next; });
    setAssign((prev) => {
      const next = {}; for (const k in prev) if (prev[k] !== id) next[k] = prev[k];
      lsSave(LS_ASSIGN, next); return next;
    });
    setFilter((f) => (f === id ? "all" : f));
  }, []);

  const assignToGroup = useCallback((peer, groupId) => {
    setAssign((prev) => {
      const next = { ...prev };
      if (groupId) next[peer] = groupId; else delete next[peer];
      lsSave(LS_ASSIGN, next); return next;
    });
  }, []);

  // Выбираем первую беседу когда они загружены
  useEffect(() => {
    if (!sel && chatList.length > 0) setSel(chatList[0].id);
  }, [chatList.length]);

  // Открытие чата = прочитано: сдвигаем baseline до текущего кумулятивного
  // числа полученных. Пока чат выбран, держим его прочитанным при новых письмах.
  useEffect(() => {
    if (!sel || !liveAvail) return;
    const conv = convs.find((c) => c.peer === sel);
    if (conv) markRead(sel, conv.unread);
  }, [sel, convs, liveAvail, markRead]);

  const activePeer = liveAvail && sel && convs.some((c) => c.peer === sel) ? sel : null;
  const live = window.useLiveChat(me || "", activePeer || "");

  // Видимое число непрочитанных = кумулятив с бэкенда минус сохранённый baseline.
  const decorated = chatList.map((c) => ({
    ...c,
    unread: Math.max(0, (c.unread || 0) - (readState[c.peer] || 0)),
    group:  assign[c.peer] || null,
  }));

  const filtered = decorated.filter((c) => {
    if (filter === "all")    return true;
    if (filter === "unread") return c.unread > 0;
    return c.group === filter; // filter — это id группы
  });

  const selChat = chatList.find((c) => c.id === sel);
  const peer    = sel ? (contacts[sel] || makePeerContact(sel)) : null;

  // Клавиатурная навигация: [n] новый чат, ↑↓ по списку
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === "Escape") { setMenu(null); setMsgMenu(null); setGroupDraft(null); return; }
      if (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA") return;
      if (e.code === "KeyN") { setNewChat(v => !v); return; }
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const idx = filtered.findIndex(c => c.id === sel);
        const next = e.key === "ArrowDown"
          ? Math.min(idx + 1, filtered.length - 1)
          : Math.max(idx - 1, 0);
        if (filtered[next]) setSel(filtered[next].id);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [filtered, sel]);

  const isLiveChat    = liveAvail && !!activePeer;
  const displayMsgs   = isLiveChat
    ? live.messages.map((m) => ({
        id:   m.id,
        from: m.from === "me" ? "me" : activePeer,
        t:    m.t,
        text: m.text,
        read: true,
      }))
    : (selChat?.messages || []);

  return (
    <div className="msg-screen" onClick={() => { if (menu) setMenu(null); if (msgMenu) setMsgMenu(null); }}>
      {/* LEFT */}
      <div className="msg-chats">
        <Panel title="МЕССЕНДЖЕР" sub={chatList.length ? `${chatList.length} бесед` : ""} hint="[/] поиск  [n] новый чат">
          <div className="msg-search">
            <span className="muted">[/]</span>
            <input className="form-input" placeholder="поиск…" />
          </div>
          <div className="msg-filter-row">
            {[["all","все"],["unread","непрочитанные"]].map(([k, label]) => (
              <button key={k} className={"filter-pill" + (filter === k ? " on" : "")} onClick={() => setFilter(k)}>
                {label}
              </button>
            ))}
            {groups.map((g) => (
              <button
                key={g.id}
                className={"filter-pill" + (filter === g.id ? " on" : "")}
                onClick={() => setFilter(g.id)}
                onContextMenu={(e) => { e.preventDefault(); if (confirm(`Удалить группу «${g.name}»?`)) deleteGroup(g.id); }}
                title="ПКМ — удалить группу"
              >
                {g.name}
              </button>
            ))}
            {groupDraft === null ? (
              <button className="filter-pill add" onClick={() => setGroupDraft("")} title="новая группа">+ группа</button>
            ) : (
              <input
                className="filter-pill group-input"
                placeholder="имя группы"
                value={groupDraft}
                autoFocus
                onChange={(e) => setGroupDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") { const id = addGroup(groupDraft); if (id) setFilter(id); setGroupDraft(null); }
                  if (e.key === "Escape") setGroupDraft(null);
                }}
                onBlur={() => { if (groupDraft.trim()) addGroup(groupDraft); setGroupDraft(null); }}
              />
            )}
          </div>
          <div className="hr" />
          <div className="chat-list">
            {filtered.map((c) => {
              const p      = contacts[c.peer] || makePeerContact(c.peer);
              const isSel  = c.id === sel;
              return (
                <button
                  key={c.id}
                  className={"chat-row" + (isSel ? " sel" : "")}
                  onClick={() => setSel(c.id)}
                  onContextMenu={(e) => { e.preventDefault(); setMenu({ x: e.clientX, y: e.clientY, peer: c.peer }); }}
                >
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
                        {c.group && <span className="group-chip">{(groups.find((g) => g.id === c.group) || {}).name}</span>}
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
            <ConversationBody
              messages={displayMsgs}
              contacts={contacts}
              me={me}
              peer={sel}
              pinnedIds={pinned[sel] || {}}
              onMsgMenu={(e, m) => { e.preventDefault(); setMsgMenu({ x: e.clientX, y: e.clientY, msg: m, el: e.currentTarget }); }}
            />
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
        {selChat && (
          <PinnedMessages
            pinned={pinned[sel] ? Object.values(pinned[sel]) : []}
            contacts={contacts}
            onUnpin={(m) => togglePin(sel, m)}
          />
        )}
      </div>

      {menu && (
        <ChatMenu
          menu={menu}
          setMenu={setMenu}
          groups={groups}
          assign={assign}
          assignToGroup={assignToGroup}
          addGroup={addGroup}
          markRead={markRead}
          markUnread={markUnread}
          convs={convs}
          peerName={(contacts[menu.peer] || makePeerContact(menu.peer)).name}
        />
      )}

      {msgMenu && (
        <MsgMenu
          menu={msgMenu}
          setMenu={setMsgMenu}
          peer={sel}
          togglePin={togglePin}
          isPinned={!!(pinned[sel] && msgMenu.msg.id != null && pinned[sel][msgMenu.msg.id])}
        />
      )}
    </div>
  );
}

// ── контекстное меню чата (ПКМ по строке списка) ─────────────────────────────
function ChatMenu({ menu, setMenu, groups, assign, assignToGroup, addGroup, markRead, markUnread, convs, peerName }) {
  const peer    = menu.peer;
  const current = assign[peer] || null;
  const conv    = convs.find((c) => c.peer === peer);
  const close   = () => setMenu(null);

  return (
    <div className="ctx-menu" style={{ left: menu.x, top: menu.y }} onClick={(e) => e.stopPropagation()}>
      <div className="ctx-head">{peerName}</div>
      <button className="ctx-item" onClick={() => { markRead(peer, conv ? conv.unread : 0); close(); }}>
        Отметить прочитанным
      </button>
      <button className="ctx-item" onClick={() => { markUnread(peer); close(); }}>
        Отметить непрочитанным
      </button>
      <div className="ctx-sep" />
      <div className="ctx-head">ГРУППА</div>
      {groups.map((g) => (
        <button key={g.id} className="ctx-item" onClick={() => { assignToGroup(peer, g.id); close(); }}>
          {current === g.id ? "● " : "○ "}{g.name}
        </button>
      ))}
      {current && (
        <button className="ctx-item" onClick={() => { assignToGroup(peer, null); close(); }}>
          ○ Без группы
        </button>
      )}
      {menu.creating ? (
        <input
          className="ctx-input"
          placeholder="имя новой группы"
          autoFocus
          onClick={(e) => e.stopPropagation()}
          onKeyDown={(e) => {
            if (e.key === "Enter") { const id = addGroup(e.target.value); if (id) assignToGroup(peer, id); close(); }
            if (e.key === "Escape") setMenu({ ...menu, creating: false });
          }}
        />
      ) : (
        <button className="ctx-item" onClick={() => setMenu({ ...menu, creating: true })}>
          ＋ Новая группа…
        </button>
      )}
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

function ConversationBody({ messages, contacts, me, peer, pinnedIds, onMsgMenu }) {
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
        const isPin  = pinnedIds && m.id != null && pinnedIds[m.id];
        return (
          <div
            key={m.id || i}
            className={"msg" + (isMe ? " me" : "")}
            onContextMenu={(e) => onMsgMenu && onMsgMenu(e, m)}
          >
            <span className={"msg-bar bar-" + author.color} />
            <div className="msg-content">
              <div className="msg-head">
                <span className={"msg-author author-" + author.color}>{isMe ? "вы" : author.name}</span>
                <span className="msg-time muted">{m.t}</span>
                {isPin && <span className="msg-pin" title="закреплено">📌</span>}
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

function PinnedMessages({ pinned, contacts, onUnpin }) {
  return (
    <Panel title="ЗАКРЕПЛЕНО" sub={pinned.length + " сообщений"}>
      {pinned.length === 0 ? (
        <div className="muted" style={{ fontSize: 12 }}>
          нет закреплённых
          <div style={{ marginTop: 4, color: "var(--dim)" }}>ПКМ по сообщению → закрепить</div>
        </div>
      ) : (
        <div className="rowlist">
          {pinned.map((m, i) => {
            const a = contacts[m.from] || makePeerContact(m.from);
            return (
              <div key={m.id || i} className="pinned-row">
                <span className={"msg-bar bar-" + a.color} style={{ position: "relative" }} />
                <div style={{ flex: 1, paddingLeft: 8 }}>
                  <div className="muted" style={{ fontSize: 11, display: "flex", alignItems: "center", gap: 6 }}>
                    <span>{m.from === "me" ? "вы" : a.name} · {m.t}</span>
                    <button className="tag-x" style={{ marginLeft: "auto" }} title="открепить"
                      onClick={() => onUnpin(m)}>✕</button>
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

// ── контекстное меню сообщения (ПКМ по сообщению в треде) ─────────────────────
function MsgMenu({ menu, setMenu, isPinned, togglePin, peer }) {
  const m = menu.msg;
  const copy = async () => {
    try { await navigator.clipboard.writeText(m.text || ""); }
    catch (e) { console.error("[msg] copy:", e); }
  };
  const selectText = () => {
    const el = menu.el && (menu.el.querySelector(".msg-text") || menu.el);
    if (!el) return;
    const range = document.createRange();
    range.selectNodeContents(el);
    const s = window.getSelection();
    s.removeAllRanges();
    s.addRange(range);
  };
  return (
    <div className="ctx-menu" style={{ left: menu.x, top: menu.y }} onClick={(e) => e.stopPropagation()}>
      <button className="ctx-item" onClick={() => { copy(); setMenu(null); }}>Копировать</button>
      <button className="ctx-item" onClick={() => { selectText(); setMenu(null); }}>Выделить текст</button>
      <div className="ctx-sep" />
      <button className="ctx-item" onClick={() => { togglePin(peer, m); setMenu(null); }}>
        {isPinned ? "📌 Открепить" : "📌 Закрепить"}
      </button>
    </div>
  );
}

window.MessengerScreen = MessengerScreen;
