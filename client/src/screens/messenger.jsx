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

// ── markdown в чате (Telegram-style) ─────────────────────────────────────────
// Поддержка: **жирный**, *курсив*, __подчёркнутый__, ~~зачёркнутый~~,
// ||спойлер||, `моноширинный`, [текст](url). Спойлер — клик, чтобы открыть.
const CHAT_MD_RE =
  /(\*\*[^*\n]+\*\*|__[^_\n]+__|~~[^~\n]+~~|\|\|[^|\n]+\|\||`[^`\n]+`|\[[^\]\n]+\]\([^)\s]+\)|\*[^*\n]+\*)/g;

function Spoiler({ children }) {
  const [open, setOpen] = useState(false);
  return (
    <span
      className={"chat-spoiler" + (open ? " open" : "")}
      onClick={(e) => { e.stopPropagation(); setOpen(true); }}
      title={open ? "" : "спойлер — нажмите, чтобы открыть"}
    >{children}</span>
  );
}

function chatInline(text) {
  const out = [];
  let last = 0, m, key = 0;
  CHAT_MD_RE.lastIndex = 0;
  while ((m = CHAT_MD_RE.exec(text)) !== null) {
    if (m.index > last) out.push(<span key={key++}>{text.slice(last, m.index)}</span>);
    const tok = m[0];
    if (tok.startsWith("**"))        out.push(<strong key={key++}>{tok.slice(2, -2)}</strong>);
    else if (tok.startsWith("__"))   out.push(<u key={key++}>{tok.slice(2, -2)}</u>);
    else if (tok.startsWith("~~"))   out.push(<s key={key++}>{tok.slice(2, -2)}</s>);
    else if (tok.startsWith("||"))   out.push(<Spoiler key={key++}>{tok.slice(2, -2)}</Spoiler>);
    else if (tok.startsWith("`"))    out.push(<code key={key++} className="chat-code">{tok.slice(1, -1)}</code>);
    else if (tok.startsWith("[")) {
      const mm = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(tok);
      out.push(
        <a key={key++} className="chat-link" href={mm[2]} target="_blank" rel="noreferrer"
           onClick={(e) => e.stopPropagation()}>{mm[1]}</a>
      );
    }
    else if (tok.startsWith("*"))    out.push(<em key={key++}>{tok.slice(1, -1)}</em>);
    last = m.index + tok.length;
  }
  if (last < text.length) out.push(<span key={key++}>{text.slice(last)}</span>);
  return out;
}

// Рендер текста сообщения: блоки ```код``` + построчный inline-markdown.
function ChatText({ text }) {
  const src = text || "";
  if (src.indexOf("```") === -1) {
    const lines = src.split("\n");
    return (
      <>{lines.map((ln, i) => (
        <React.Fragment key={i}>{i > 0 && <br />}{chatInline(ln)}</React.Fragment>
      ))}</>
    );
  }
  // есть код-блоки — разбираем по строкам
  const lines = src.split("\n");
  const out = [];
  let i = 0, key = 0;
  while (i < lines.length) {
    if (lines[i].startsWith("```")) {
      const code = [];
      i++;
      while (i < lines.length && !lines[i].startsWith("```")) { code.push(lines[i]); i++; }
      if (i < lines.length) i++; // закрывающий ```
      out.push(<pre key={key++} className="chat-pre"><code>{code.join("\n")}</code></pre>);
    } else {
      out.push(<div key={key++}>{chatInline(lines[i])}</div>);
      i++;
    }
  }
  return <>{out}</>;
}

// ── медиа: кеш блобов, скачивание, рендер ────────────────────────────────────
const blobCache = new Map(); // file_id → data-URL

function bytesToB64(bytes) {
  let bin = "";
  const step = 0x8000;
  for (let i = 0; i < bytes.length; i += step) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + step));
  }
  return btoa(bin);
}
function fmtBytes(n) {
  if (!n) return "";
  if (n < 1024) return n + " B";
  if (n < 1024 * 1024) return (n / 1024).toFixed(0) + " KB";
  return (n / 1024 / 1024).toFixed(1) + " MB";
}
function fmtDur(s) {
  s = Math.max(0, Math.round(s || 0));
  return Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0");
}
function imageDims(blob) {
  return new Promise((res) => {
    const img = new Image();
    const url = URL.createObjectURL(blob);
    img.onload = () => { res({ w: img.naturalWidth, h: img.naturalHeight }); URL.revokeObjectURL(url); };
    img.onerror = () => { res({ w: 0, h: 0 }); URL.revokeObjectURL(url); };
    img.src = url;
  });
}
function videoDims(blob) {
  return new Promise((res) => {
    const v = document.createElement("video");
    const url = URL.createObjectURL(blob);
    v.onloadedmetadata = () => { res({ w: v.videoWidth, h: v.videoHeight, dur: v.duration || 0 }); URL.revokeObjectURL(url); };
    v.onerror = () => { res({ w: 0, h: 0, dur: 0 }); URL.revokeObjectURL(url); };
    v.src = url;
  });
}

// Скачивает блоб один раз, кеширует data-URL в памяти.
function useBlob(fileId, mime) {
  const [url, setUrl] = useState(() => (fileId ? blobCache.get(fileId) || null : null));
  useEffect(() => {
    if (!fileId || !window.PARVANE.available) return;
    if (blobCache.has(fileId)) { setUrl(blobCache.get(fileId)); return; }
    let alive = true;
    window.PARVANE.downloadBlob(fileId)
      .then((b) => {
        const dataUrl = `data:${b.mime || mime || "application/octet-stream"};base64,${b.data}`;
        blobCache.set(fileId, dataUrl);
        if (alive) setUrl(dataUrl);
      })
      .catch((e) => console.error("[media] download:", e));
    return () => { alive = false; };
  }, [fileId]);
  return url;
}

function MediaMessage({ content, onOpen }) {
  const c = content || {};
  const url = useBlob(c.file_id, c.mime);
  const caption = c.caption ? <div className="msg-caption"><ChatText text={c.caption} /></div> : null;
  const open = (kind) => { if (url && onOpen) onOpen({ url, kind }); };

  if (c.kind === "photo") {
    return (
      <div className="media photo">
        {url
          ? <img className="media-photo zoomable" src={url} alt="" title="открыть в полном размере"
              onClick={() => open("photo")} />
          : <div className="media-loading">🖼 загрузка…</div>}
        {caption}
      </div>
    );
  }
  if (c.kind === "video") {
    return (
      <div className="media video">
        {url ? (
          <div className="media-vwrap">
            <video className="media-video" src={url} controls preload="none" />
            <button className="media-expand" title="на весь экран" onClick={() => open("video")}>⛶</button>
          </div>
        ) : <div className="media-loading">📹 загрузка…</div>}
        {caption}
      </div>
    );
  }
  if (c.kind === "video_note") {
    return (
      <div className="media note">
        {url
          ? <video className="media-note zoomable" src={url} controls loop muted playsInline preload="metadata"
              onDoubleClick={() => open("video")} />
          : <div className="media-loading note">🎥</div>}
        <span className="media-dur">{fmtDur(c.duration_secs)}</span>
      </div>
    );
  }
  if (c.kind === "voice") {
    return (
      <div className="media voice">
        🎤 {url ? <audio className="media-audio" src={url} controls preload="none" /> : <span className="media-loading">загрузка…</span>}
        <span className="media-dur">{fmtDur(c.duration_secs)}</span>
      </div>
    );
  }
  // file
  return (
    <div className="media file">
      <span className="file-ico">📎</span>
      <div className="file-info">
        <div className="file-name">{c.filename || "файл"}</div>
        <div className="file-size muted">{fmtBytes(c.size_bytes)}</div>
      </div>
      {url
        ? <a className="btn" href={url} download={c.filename || "file"}>скачать</a>
        : <span className="muted">загрузка…</span>}
      {caption}
    </div>
  );
}

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
  const [chatsCollapsed, setChatsCollapsed] = useState(false); // левый список → иконки
  const [sideHidden, setSideHidden]         = useState(false); // правая панель скрыта
  const [lightbox, setLightbox]             = useState(null);  // {url,kind} для просмотра медиа

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
        id:      m.id,
        from:    m.from === "me" ? "me" : activePeer,
        t:       m.t,
        text:    m.text,
        content: m.content,
        read:    m.read,
        edited:  m.edited,
        deleted: m.deleted,
        replyTo: m.replyTo,
      }))
    : (selChat?.messages || []);

  // Ответ/правка: на какое сообщение отвечаем и какое редактируем.
  const [replyTo, setReplyTo] = useState(null);
  const [editing, setEditing] = useState(null);

  // Сброс при смене собеседника.
  useEffect(() => { setReplyTo(null); setEditing(null); setDraft(""); }, [sel]);

  const startReply = useCallback((m) => { setEditing(null); setReplyTo(m); }, []);
  const startEdit  = useCallback((m) => { setReplyTo(null); setEditing(m); setDraft(m.text || ""); }, []);
  const doDelete   = useCallback((m) => {
    if (!isLiveChat || !m || m.id == null) return;
    if (confirm("Удалить сообщение у всех?")) live.deleteMessage(m.id);
  }, [isLiveChat, live]);

  const onComposerSend = (text) => {
    if (!isLiveChat) return;
    if (editing) { live.editMessage(editing.id, text); setEditing(null); }
    else         { live.send(text, replyTo ? replyTo.id : null); setReplyTo(null); }
  };

  // ── медиа: вложения и запись (голос/кружок) ─────────────────────────────────
  const fileInputRef = useRef(null);
  const recRef       = useRef(null);   // { rec, stream, kind, canceled, audioCtx, raf, started }
  const previewRef   = useRef(null);   // <video> для живого превью кружка
  const recTimerRef  = useRef(null);
  const [recording, setRecording] = useState(null); // "voice" | "video_note" | null
  const [recSecs, setRecSecs]   = useState(0);
  const [recLevel, setRecLevel] = useState(0);       // уровень микрофона 0..1

  // Живое превью камеры в кружке: цепляем поток к <video> после монтирования.
  useEffect(() => {
    if (recording !== "video_note") return;
    const v = previewRef.current, r = recRef.current;
    if (!v || !r) return;
    v.srcObject = r.stream;
    v.muted = true;
    const tryPlay = () => { v.play().catch(() => {}); };
    tryPlay();
    v.onloadedmetadata = tryPlay;     // на случай, если поток подключился позже
    return () => { v.onloadedmetadata = null; };
  }, [recording]);

  // Загрузить блоб в облако и отправить медиа-сообщение.
  const uploadAndSend = useCallback(async (blob, kind, name, extra) => {
    try {
      const buf  = await blob.arrayBuffer();
      const b64  = bytesToB64(new Uint8Array(buf));
      const mime = blob.type || "application/octet-stream";
      const res  = await window.PARVANE.uploadBlob(name, mime, b64);
      // Текст композера превращается в подпись для photo/video/file.
      const cap  = (kind === "photo" || kind === "video" || kind === "file") ? (draft.trim() || null) : null;
      const w = extra.w || 0, h = extra.h || 0, dur = Math.round(extra.dur || 0);
      const meta = {
        kind, file: res.file_id, filename: name, mime, size: res.size,
        reply: replyTo ? replyTo.id : null, width: w, height: h, duration: dur, caption: cap,
      };
      const content = {
        kind, file_id: res.file_id, mime, size_bytes: res.size,
        width: w, height: h, duration_secs: dur, filename: name, caption: cap,
      };
      await live.sendMedia(meta, content);
      if (cap) setDraft("");
      setReplyTo(null);
    } catch (e) {
      console.error("[media] uploadAndSend:", e);
      alert("Не удалось отправить медиа: " + e);
    }
  }, [draft, replyTo, live]);

  // Выбор файла через системный диалог (input[type=file]).
  const onAttach = useCallback(() => { fileInputRef.current && fileInputRef.current.click(); }, []);
  const onFilePicked = useCallback(async (e) => {
    const f = e.target.files && e.target.files[0];
    e.target.value = "";
    if (!f) return;
    let kind = "file", extra = {};
    if (f.type.startsWith("image/"))      { kind = "photo"; extra = await imageDims(f); }
    else if (f.type.startsWith("video/")) { kind = "video"; extra = await videoDims(f); }
    else if (f.type.startsWith("audio/")) { kind = "voice"; }
    await uploadAndSend(f, kind, f.name || "file", extra);
  }, [uploadAndSend]);

  // Индикатор уровня микрофона (Web Audio) для волны при записи голосового.
  const startMeter = useCallback((stream) => {
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      const ctx = new AC();
      const src = ctx.createMediaStreamSource(stream);
      const an  = ctx.createAnalyser(); an.fftSize = 256;
      src.connect(an);
      const data = new Uint8Array(an.frequencyBinCount);
      if (recRef.current) recRef.current.audioCtx = ctx;
      const tick = () => {
        an.getByteFrequencyData(data);
        let sum = 0; for (let i = 0; i < data.length; i++) sum += data[i];
        setRecLevel(Math.min(1, (sum / data.length) / 96));
        if (recRef.current) recRef.current.raf = requestAnimationFrame(tick);
      };
      tick();
    } catch (_) {}
  }, []);

  // Старт записи голоса/кружка через MediaRecorder.
  const startRec = useCallback(async (kind) => {
    if (recording) return; // уже идёт запись — управляется кнопками панели
    try {
      // AGC включён: аппаратное усиление мика приведено в норму (Capture/Boost
      // больше не клиппят), поэтому авто-громкость теперь выравнивает уровень
      // чисто, а не борется с уже «срезанным» сигналом.
      const AUDIO = { echoCancellation: true, noiseSuppression: true, autoGainControl: true };
      const constraints = kind === "voice"
        ? { audio: AUDIO }
        // facingMode="user" ломает обычные веб-камеры; берём мягкие ideal-размеры.
        : { audio: AUDIO, video: { width: { ideal: 480 }, height: { ideal: 480 } } };
      const stream  = await navigator.mediaDevices.getUserMedia(constraints);
      // ВАЖНО: без явного mimeType WebKitGTK выбирает audio/mp4 (AAC) для
      // аудио-потока — кодека нет → "MediaRecorder unsupported". Принуждаем webm.
      const cands = kind === "voice"
        ? ["audio/webm;codecs=opus", "audio/webm"]
        : ["video/webm;codecs=vp8,opus", "video/webm;codecs=vp8", "video/webm"];
      const mime = cands.find((t) => { try { return MediaRecorder.isTypeSupported(t); } catch { return false; } }) || "";
      const opts = mime ? { mimeType: mime } : {};
      opts.audioBitsPerSecond = 96000;            // ровный голос без «грязи»
      if (kind !== "voice") opts.videoBitsPerSecond = 1200000;
      const rec  = new MediaRecorder(stream, opts);
      const chunks  = [];
      const started = Date.now();
      rec.ondataavailable = (ev) => { if (ev.data && ev.data.size) chunks.push(ev.data); };
      rec.onstop = async () => {
        const r = recRef.current;
        const canceled = !r || r.canceled;
        stream.getTracks().forEach((t) => t.stop());
        if (r && r.audioCtx) { try { r.audioCtx.close(); } catch (_) {} }
        if (r && r.raf) cancelAnimationFrame(r.raf);
        recRef.current = null;
        const bytes = chunks.reduce((n, c) => n + (c.size || 0), 0);
        try { window.PARVANE && window.PARVANE.diag &&
          window.PARVANE.diag(`rec stop ${kind}: canceled=${canceled} chunks=${chunks.length} bytes=${bytes}`); } catch (_) {}
        if (canceled || !chunks.length) return;
        const type = rec.mimeType || (kind === "voice" ? "audio/webm" : "video/webm");
        const blob = new Blob(chunks, { type });
        const dur  = (Date.now() - started) / 1000;
        const name = kind === "voice" ? "voice.webm" : "circle.webm";
        await uploadAndSend(blob, kind, name, { dur, w: kind === "voice" ? 0 : 480, h: kind === "voice" ? 0 : 480 });
      };
      recRef.current = { rec, stream, kind, canceled: false, started };
      // timeslice: гарантируем периодические ondataavailable (для кружка важно —
      // иначе при коротких записях видеочанк мог не успеть сформироваться).
      rec.start(250);
      setRecording(kind);
      setRecSecs(0);
      setRecLevel(0);
      recTimerRef.current = setInterval(() => setRecSecs((s) => s + 1), 1000);
      if (kind === "voice") startMeter(stream);
    } catch (err) {
      console.error("[media] record:", err);
      const detail = `${kind}: ${(err && err.name) || "?"} / ${(err && err.message) || err}`;
      try { window.PARVANE && window.PARVANE.diag && window.PARVANE.diag("record fail: " + detail); } catch (_) {}
      alert("Запись недоступна (нет доступа к микрофону/камере):\n" + detail);
    }
  }, [recording, uploadAndSend, startMeter]);

  // Стоп записи: send=true — отправить, send=false — отменить (выбросить).
  const stopRec = useCallback((send) => {
    if (!recRef.current) { setRecording(null); return; }
    recRef.current.canceled = !send;
    if (recTimerRef.current) { clearInterval(recTimerRef.current); recTimerRef.current = null; }
    try { recRef.current.rec.stop(); } catch (_) {}
    setRecording(null);
    setRecLevel(0);
  }, []);

  return (
    <div
      className="msg-screen"
      style={{ gridTemplateColumns: `${chatsCollapsed ? "60px" : "320px"} minmax(0, 1fr)${sideHidden ? "" : " 320px"}` }}
      onClick={() => { if (menu) setMenu(null); if (msgMenu) setMsgMenu(null); }}
    >
      {/* LEFT */}
      <div className={"msg-chats" + (chatsCollapsed ? " collapsed" : "")}>
        {chatsCollapsed ? (
          <div className="chat-rail">
            <button className="rail-toggle" title="развернуть список" onClick={() => setChatsCollapsed(false)}>»</button>
            {filtered.map((c) => {
              const p = contacts[c.peer] || makePeerContact(c.peer);
              return (
                <button
                  key={c.id}
                  className={"rail-avatar avatar-" + p.color + (c.id === sel ? " sel" : "")}
                  title={p.name}
                  onClick={() => setSel(c.id)}
                  onContextMenu={(e) => { e.preventDefault(); setMenu({ x: e.clientX, y: e.clientY, peer: c.peer }); }}
                >
                  <span>{p.init}</span>
                  {p.status === "online" && <span className="online-pip" />}
                  {c.unread > 0 && <span className="rail-badge">{c.unread}</span>}
                </button>
              );
            })}
          </div>
        ) : (
        <Panel title="МЕССЕНДЖЕР" sub={chatList.length ? `${chatList.length} бесед` : ""} hint="[/] поиск  [n] новый чат">
          <div className="msg-search">
            <button className="rail-toggle inline" title="свернуть список" onClick={() => setChatsCollapsed(true)}>«</button>
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
        )}
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
              {/* Клик по аватару/имени — открыть профиль (медиа, ссылки, инфо),
                  как в Telegram. */}
              <button className="thread-peer" title="профиль собеседника"
                onClick={() => setSideHidden(false)}>
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
              </button>
              <div style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
                <button
                  className={"btn" + (!sideHidden ? " on" : "")}
                  title="профиль · медиа · файлы · ссылки"
                  onClick={() => setSideHidden((v) => !v)}
                >[i] инфо</button>
              </div>
            </div>
            <div className="hr" />
            <ConversationBody
              messages={displayMsgs}
              contacts={contacts}
              me={me}
              peer={sel}
              pinnedIds={pinned[sel] || {}}
              onOpenMedia={setLightbox}
              onMsgMenu={(e, m) => { e.preventDefault(); setMsgMenu({ x: e.clientX, y: e.clientY, msg: m, el: e.currentTarget }); }}
            />
            <div className="hr" />
            {recording ? (
              <RecordingPanel
                kind={recording}
                secs={recSecs}
                level={recLevel}
                previewRef={previewRef}
                onCancel={() => stopRec(false)}
                onSend={() => stopRec(true)}
              />
            ) : (
              <Composer
                draft={draft}
                setDraft={setDraft}
                live={isLiveChat}
                error={live.error}
                onSend={isLiveChat ? onComposerSend : null}
                reply={replyTo}
                editing={editing}
                peerName={peer.name}
                onCancel={() => { setReplyTo(null); setEditing(null); setDraft(""); }}
                onAttach={onAttach}
                onVoice={() => startRec("voice")}
                onVideoNote={() => startRec("video_note")}
                recording={recording}
              />
            )}
            <input
              ref={fileInputRef}
              type="file"
              style={{ display: "none" }}
              onChange={onFilePicked}
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
      {!sideHidden && (
        <div className="msg-side col">
          {peer && <ContactPanel peer={peer} peerAddr={sel} messages={displayMsgs} onClose={() => setSideHidden(true)} />}
          {selChat && <SharedMedia messages={displayMsgs} onOpen={setLightbox} />}
          {selChat && (
            <PinnedMessages
              pinned={pinned[sel] ? Object.values(pinned[sel]) : []}
              contacts={contacts}
              onUnpin={(m) => togglePin(sel, m)}
            />
          )}
        </div>
      )}

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
          live={isLiveChat}
          onReply={startReply}
          onEdit={startEdit}
          onDelete={doDelete}
        />
      )}

      {lightbox && <Lightbox data={lightbox} onClose={() => setLightbox(null)} />}
    </div>
  );
}

// Полноэкранный просмотр фото/видео (как в Telegram). Клик по фону / Esc — закрыть.
function Lightbox({ data, onClose }) {
  useEffect(() => {
    const onKey = (e) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="lightbox" onClick={onClose}>
      <button className="lightbox-close" title="закрыть (Esc)" onClick={onClose}>✕</button>
      <div className="lightbox-body" onClick={(e) => e.stopPropagation()}>
        {data.kind === "photo"
          ? <img className="lightbox-media" src={data.url} alt="" />
          : <video className="lightbox-media" src={data.url} controls autoPlay />}
      </div>
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

function ConversationBody({ messages, contacts, me, peer, pinnedIds, onMsgMenu, onOpenMedia }) {
  // Индекс по id для отрисовки цитаты ответа.
  const byId = {};
  messages.forEach((m) => { if (m.id != null) byId[m.id] = m; });
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
        const quoted = m.replyTo != null ? byId[m.replyTo] : null;
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
                {m.edited && !m.deleted && <span className="muted" style={{ fontSize: 10 }}>(изменено)</span>}
                {isPin && <span className="msg-pin" title="закреплено">📌</span>}
                {isMe && !m.deleted && (
                  <span className="msg-read">
                    {m.read
                      ? <span style={{ color: "var(--blue)" }}>✓✓</span>
                      : <span className="muted">✓</span>}
                  </span>
                )}
              </div>
              {quoted && !m.deleted && (
                <div className="msg-quote">
                  <span className="msg-quote-author">{quoted.from === "me" ? "вы" : (contacts[quoted.from] || makePeerContact(quoted.from)).name}</span>
                  <span className="msg-quote-text">{quoted.deleted ? "удалённое сообщение" : (quoted.text || "").slice(0, 80)}</span>
                </div>
              )}
              {m.deleted
                ? <div className="msg-text muted" style={{ fontStyle: "italic" }}>🚫 сообщение удалено</div>
                : (m.content && m.content.kind && m.content.kind !== "text")
                  ? <div className="msg-text"><MediaMessage content={m.content} onOpen={onOpenMedia} /></div>
                  : <div className="msg-text"><ChatText text={m.text} /></div>}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// Кнопки форматирования: [подпись, открывающий/закрывающий маркер, шорткат].
const FMT_BTNS = [
  ["B",  "**", "жирный (Ctrl+B)"],
  ["I",  "*",  "курсив (Ctrl+I)"],
  ["U",  "__", "подчёркнутый (Ctrl+U)"],
  ["S",  "~~", "зачёркнутый (Ctrl+Shift+S)"],
  ["</>","`",  "код (Ctrl+Shift+K)"],
  ["▒",  "||", "спойлер (Ctrl+Shift+P)"],
];

// Бегущая волна уровня микрофона при записи голосового (как в Telegram).
function RecMeter({ level }) {
  const BARS = 28;
  return (
    <div className="rec-meter">
      {Array.from({ length: BARS }).map((_, i) => {
        const base = 12 + level * 88;
        const h = Math.max(8, Math.min(100, base * (0.35 + Math.random() * 0.9)));
        return <span key={i} className="rec-meter-bar" style={{ height: h + "%" }} />;
      })}
    </div>
  );
}

// Панель записи голоса/кружка: индикация + таймер + волна/превью + отмена/отправка.
function RecordingPanel({ kind, secs, level, previewRef, onCancel, onSend }) {
  const mm = String(Math.floor(secs / 60)).padStart(1, "0");
  const ss = String(secs % 60).padStart(2, "0");
  const time = `${mm}:${ss}`;

  // Enter — отправить, Esc — отменить (как в Telegram).
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === "Enter") { e.preventDefault(); onSend(); }
      else if (e.key === "Escape") { e.preventDefault(); onCancel(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onSend, onCancel]);

  return (
    <div className="rec-panel">
      {kind === "video_note" && (
        <div className="rec-circle-wrap">
          <video ref={previewRef} className="rec-circle" muted playsInline autoPlay />
          <div className="rec-circle-ring" />
        </div>
      )}
      <div className="rec-bar">
        <span className="rec-dot" />
        <span className="rec-label">
          {kind === "voice" ? "запись голосового" : "запись кружка"}
        </span>
        <span className="rec-time">{time}</span>
        {kind === "voice"
          ? <RecMeter level={level} />
          : <span className="rec-hint">смотрите в камеру…</span>}
        <button className="rec-cancel" title="отменить (Esc)" onClick={onCancel}>🗑 отмена</button>
        <button className="rec-send" title="отправить (Enter)" onClick={onSend}>➤ отправить</button>
      </div>
    </div>
  );
}

function Composer({ draft, setDraft, live, error, onSend, reply, editing, peerName, onCancel,
                    onAttach, onVoice, onVideoNote, recording }) {
  const inputRef = useRef(null);
  const [hasSel, setHasSel] = useState(false);

  const fire = () => {
    if (onSend && draft.trim()) { onSend(draft); setDraft(""); setHasSel(false); }
  };

  // Обернуть выделенный фрагмент (или вставить пару маркеров у курсора) в markdown.
  const wrap = (marker) => {
    const el = inputRef.current;
    if (!el) return;
    const s = el.selectionStart ?? draft.length;
    const e = el.selectionEnd ?? draft.length;
    const sel = draft.slice(s, e);
    const next = draft.slice(0, s) + marker + sel + marker + draft.slice(e);
    setDraft(next);
    // Вернуть фокус и выделение внутрь маркеров.
    requestAnimationFrame(() => {
      el.focus();
      const a = s + marker.length, b = a + sel.length;
      el.setSelectionRange(a, b);
      setHasSel(b > a);
    });
  };

  const syncSel = (e) => {
    const el = e.target;
    setHasSel((el.selectionStart ?? 0) !== (el.selectionEnd ?? 0));
  };

  const onKey = (e) => {
    if (e.key === "Enter") { e.preventDefault(); fire(); return; }
    if (e.key === "Escape" && (reply || editing)) { e.preventDefault(); onCancel && onCancel(); return; }
    // Шорткаты форматирования (раскладко-независимо по e.code).
    if (e.ctrlKey || e.metaKey) {
      const sh = e.shiftKey;
      let mk = null;
      if (!sh && e.code === "KeyB") mk = "**";
      else if (!sh && e.code === "KeyI") mk = "*";
      else if (!sh && e.code === "KeyU") mk = "__";
      else if (sh && e.code === "KeyS") mk = "~~";
      else if (sh && e.code === "KeyK") mk = "`";
      else if (sh && e.code === "KeyP") mk = "||";
      if (mk) { e.preventDefault(); wrap(mk); }
    }
  };

  const banner = editing
    ? { tag: "✎ изменение", text: editing.text }
    : reply
      ? { tag: "↩ ответ " + (reply.from === "me" ? "себе" : (peerName || "")), text: reply.text }
      : null;

  return (
    <div className="composer">
      {banner && (
        <div className="composer-banner">
          <span className="composer-banner-tag">{banner.tag}</span>
          <span className="composer-banner-text">{(banner.text || "").slice(0, 80)}</span>
          <button className="tag-x" title="отмена (Esc)" onClick={() => { onCancel && onCancel(); }}>✕</button>
        </div>
      )}
      {/* Тулбар форматирования — появляется при выделении текста в поле ввода. */}
      {hasSel && (
        <div className="composer-fmt">
          {FMT_BTNS.map(([label, mk, title]) => (
            <button key={mk} className="fmt-btn" title={title}
              onMouseDown={(e) => { e.preventDefault(); wrap(mk); }}>{label}</button>
          ))}
        </div>
      )}
      <div className="composer-row">
        {/* медиа-кнопки доступны только в живом чате */}
        {live && onAttach && (
          <div className="composer-media">
            <button className="media-btn" title="прикрепить файл / фото / видео" onClick={onAttach}>📎</button>
            <button className={"media-btn" + (recording === "voice" ? " rec" : "")}
              title="голосовое сообщение" onClick={onVoice}>🎤</button>
            <button className={"media-btn" + (recording === "video_note" ? " rec" : "")}
              title="видеосообщение (кружок)" onClick={onVideoNote}>⭕</button>
          </div>
        )}
        <span className="composer-prompt" style={{ color: live ? "var(--green)" : "var(--orange)" }}>{editing ? "✎" : ">"}</span>
        <input
          ref={inputRef}
          className="form-input composer-input"
          placeholder={editing ? "новый текст…" : reply ? "ответ…" : (live ? "сообщение → бэкенд…" : "напишите сообщение…")}
          value={draft}
          onChange={(e) => { setDraft(e.target.value); syncSel(e); }}
          onSelect={syncSel}
          onKeyUp={syncSel}
          onMouseUp={syncSel}
          onKeyDown={onKey}
        />
        {error && <div style={{ color: "var(--red)", fontSize: 11 }}>✗ {error}</div>}
        <div className="composer-tools">
          <button className="btn primary" onClick={fire}>{editing ? "[⏎] save" : "[⏎] send"}</button>
        </div>
      </div>
    </div>
  );
}

function ContactPanel({ peer, peerAddr, messages, onClose }) {
  // Сводка по чату для профиля (как шапка профиля в Telegram).
  const stats = useMemo(() => {
    let msgs = 0, media = 0, files = 0;
    (messages || []).forEach((m) => {
      if (m.deleted) return;
      msgs++;
      const c = m.content;
      if (c && c.kind && c.kind !== "text") {
        if (c.kind === "file") files++; else media++;
      }
    });
    return { msgs, media, files };
  }, [messages]);

  return (
    <Panel
      title="ПРОФИЛЬ"
      sub={peer.handle}
      hint={onClose ? <button className="rail-toggle inline" title="скрыть панель" onClick={onClose}>✕</button> : null}
    >
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
      <div className="contact-stats">
        <div className="contact-stat"><span className="strong">{stats.msgs}</span><span className="muted">сообщений</span></div>
        <div className="contact-stat"><span className="strong">{stats.media}</span><span className="muted">медиа</span></div>
        <div className="contact-stat"><span className="strong">{stats.files}</span><span className="muted">файлов</span></div>
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

// ── общая медиатека чата ──────────────────────────────────────────────────────
// Как профиль собеседника в Telegram: всё медиа / файлы / ссылки / голосовые
// чата собрано в одном месте с вкладками.
const URL_RE = /https?:\/\/[^\s]+/g;

function SharedMedia({ messages, onOpen }) {
  const [tab, setTab] = useState("media");

  const { media, files, voices, links } = useMemo(() => {
    const media = [], files = [], voices = [], links = [];
    (messages || []).forEach((m) => {
      if (m.deleted) return;
      const c = m.content;
      if (c && c.kind && c.kind !== "text") {
        if (c.kind === "photo" || c.kind === "video" || c.kind === "video_note") media.push(m);
        else if (c.kind === "voice") voices.push(m);
        else files.push(m);
      }
      const txt = (m.text || "") + " " + ((c && c.caption) || "");
      const found = txt.match(URL_RE);
      if (found) found.forEach((u) => links.push({ url: u, t: m.t }));
    });
    return { media, files, voices, links };
  }, [messages]);

  const tabs = [
    ["media",  "Медиа",  media.length],
    ["files",  "Файлы",  files.length],
    ["links",  "Ссылки", links.length],
    ["voices", "Голос",  voices.length],
  ];

  return (
    <Panel title="ОБЩЕЕ" sub="медиа · файлы · ссылки">
      <div className="shared-tabs">
        {tabs.map(([k, label, n]) => (
          <button key={k} className={"shared-tab" + (tab === k ? " on" : "")} onClick={() => setTab(k)}>
            {label}<span className="shared-count">{n}</span>
          </button>
        ))}
      </div>

      {tab === "media" && (
        media.length
          ? <div className="shared-grid">{media.map((m, i) => <SharedThumb key={m.id || i} content={m.content} onOpen={onOpen} />)}</div>
          : <div className="shared-empty muted">нет медиа</div>
      )}
      {tab === "files" && (
        files.length
          ? <div className="rowlist">{files.map((m, i) => <SharedFile key={m.id || i} m={m} />)}</div>
          : <div className="shared-empty muted">нет файлов</div>
      )}
      {tab === "links" && (
        links.length
          ? <div className="rowlist">{links.map((l, i) => (
              <a key={i} className="shared-link" href={l.url} target="_blank" rel="noreferrer" title={l.url}>
                <span className="shared-link-ico">🔗</span>
                <span className="shared-link-url">{l.url}</span>
                <span className="shared-link-t muted">{l.t}</span>
              </a>
            ))}</div>
          : <div className="shared-empty muted">нет ссылок</div>
      )}
      {tab === "voices" && (
        voices.length
          ? <div className="rowlist">{voices.map((m, i) => <SharedVoice key={m.id || i} content={m.content} t={m.t} />)}</div>
          : <div className="shared-empty muted">нет голосовых</div>
      )}
    </Panel>
  );
}

function SharedThumb({ content, onOpen }) {
  const c = content || {};
  const url = useBlob(c.file_id, c.mime);
  const kind = c.kind === "photo" ? "photo" : "video";
  if (!url) return <div className="shared-thumb loading">…</div>;
  return (
    <button className="shared-thumb" title="открыть" onClick={() => onOpen && onOpen({ url, kind })}>
      {c.kind === "photo"
        ? <img src={url} alt="" />
        : <><video src={url} muted preload="metadata" /><span className="shared-thumb-play">▶</span></>}
    </button>
  );
}

function SharedFile({ m }) {
  const c = m.content || {};
  const url = useBlob(c.file_id, c.mime);
  return (
    <div className="shared-file">
      <span className="file-ico">📎</span>
      <div className="file-info">
        <div className="file-name">{c.filename || "файл"}</div>
        <div className="file-size muted">{fmtBytes(c.size_bytes)} · {m.t}</div>
      </div>
      {url && <a className="btn" href={url} download={c.filename || "file"} title="скачать">↓</a>}
    </div>
  );
}

function SharedVoice({ content, t }) {
  const c = content || {};
  const url = useBlob(c.file_id, c.mime);
  return (
    <div className="shared-voice">
      <span>🎤</span>
      {url ? <audio src={url} controls preload="none" /> : <span className="muted">загрузка…</span>}
      <span className="media-dur">{fmtDur(c.duration_secs)}</span>
      <span className="muted" style={{ fontSize: 10, marginLeft: "auto" }}>{t}</span>
    </div>
  );
}

// ── контекстное меню сообщения (ПКМ по сообщению в треде) ─────────────────────
function MsgMenu({ menu, setMenu, isPinned, togglePin, peer, live, onReply, onEdit, onDelete }) {
  const m = menu.msg;
  const isMe = m.from === "me";
  const deleted = !!m.deleted;
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
      {live && !deleted && (
        <button className="ctx-item" onClick={() => { onReply && onReply(m); setMenu(null); }}>↩ Ответить</button>
      )}
      <button className="ctx-item" onClick={() => { copy(); setMenu(null); }}>Копировать</button>
      <button className="ctx-item" onClick={() => { selectText(); setMenu(null); }}>Выделить текст</button>
      {live && isMe && !deleted && (
        <>
          <div className="ctx-sep" />
          <button className="ctx-item" onClick={() => { onEdit && onEdit(m); setMenu(null); }}>✎ Изменить</button>
          <button className="ctx-item danger" onClick={() => { onDelete && onDelete(m); setMenu(null); }}>🗑 Удалить у всех</button>
        </>
      )}
      <div className="ctx-sep" />
      <button className="ctx-item" onClick={() => { togglePin(peer, m); setMenu(null); }}>
        {isPinned ? "📌 Открепить" : "📌 Закрепить"}
      </button>
    </div>
  );
}

window.MessengerScreen = MessengerScreen;
