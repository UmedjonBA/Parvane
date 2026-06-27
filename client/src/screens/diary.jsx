// JOURNAL screen — diary lens over the vault. Journal entries = notes with
// YYYY-MM-DD titles. Mood is stored in the title: "YYYY-MM-DD moodkey"
// (e.g. "2026-06-27 focused"). A new entry is always a distinct note — same
// date never overwrites an existing entry.

const MOODS = [
  { key: "focused",    color: "blue",   pct: 80 },
  { key: "productive", color: "green",  pct: 95 },
  { key: "calm",       color: "aqua",   pct: 65 },
  { key: "tired",      color: "yellow", pct: 40 },
  { key: "stressed",   color: "red",    pct: 55 },
];
const MOOD_MAP = Object.fromEntries(MOODS.map(m => [m.key, m]));
const moodColor = (k) => MOOD_MAP[k]?.color || "muted";
const moodPct   = (k) => MOOD_MAP[k]?.pct   || 30;

function journalTodayKey() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
}

function longDate(iso) {
  if (!iso) return "";
  try {
    const d = new Date(iso + "T12:00:00");
    return d.toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric" });
  } catch { return iso; }
}

function shortDate(iso) {
  if (!iso) return "";
  try {
    const d = new Date(iso + "T12:00:00");
    const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
    return `${months[d.getMonth()]} ${String(d.getDate()).padStart(2,"0")}`;
  } catch { return iso; }
}

function bodyPreview(body) {
  return (body || "").split("\n")
    .filter(l => l.trim() && !l.startsWith("#"))
    .join(" ")
    .slice(0, 90);
}

// Simple inline markdown renderer for read view
function DiaryBody({ body }) {
  const lines = (body || "").split("\n");
  return (
    <div className="diary-body-rich">
      {lines.map((ln, i) => {
        if (ln.startsWith("# "))   return <div key={i} className="dbr-h1">{ln.slice(2)}</div>;
        if (ln.startsWith("## "))  return <div key={i} className="dbr-h2">{ln.slice(3)}</div>;
        if (ln.startsWith("### ")) return <div key={i} className="dbr-h3">{ln.slice(4)}</div>;
        if (ln.startsWith("> "))   return <div key={i} className="dbr-bq">{ln.slice(2)}</div>;
        if (ln.startsWith("- "))   return <div key={i} className="dbr-li">• {ln.slice(2)}</div>;
        if (ln.trim() === "")      return <div key={i} className="dbr-br" />;
        return <div key={i} className="dbr-p">{ln}</div>;
      })}
    </div>
  );
}

function MoodPicker({ value, onChange }) {
  return (
    <span className="mood-picker">
      {MOODS.map(m => (
        <button
          key={m.key}
          className={"mood-opt mood-" + m.color + (value === m.key ? " on" : "")}
          onClick={() => onChange(value === m.key ? null : m.key)}
          title={m.key}
        >
          <span className="mood-glyph">◆</span> {m.key}
        </button>
      ))}
    </span>
  );
}

function MoodGraph({ entries, selId, onPick }) {
  // show last 30 chronologically
  const chrono = [...entries]
    .sort((a, b) => a.created.localeCompare(b.created) || a.id.localeCompare(b.id))
    .slice(-30);

  if (entries.length === 0) {
    return (
      <div className="muted" style={{ fontSize: 12, padding: "8px 0", textAlign: "center" }}>
        Chart appears with your first entries
      </div>
    );
  }

  const counts = {};
  entries.forEach(e => { if (e.mood) counts[e.mood] = (counts[e.mood] || 0) + 1; });

  return (
    <div className="mood-graph">
      <div className="mood-bars">
        {chrono.map(e => (
          <button
            key={e.id}
            className={"mood-bar-btn" + (e.id === selId ? " sel" : "")}
            title={`${e.created} · ${e.mood || "no mood"}`}
            onClick={() => onPick(e.id)}
          >
            <div
              className={"mood-fill mood-" + moodColor(e.mood)}
              style={{ height: moodPct(e.mood) + "%" }}
            />
          </button>
        ))}
      </div>
      <div className="mood-legend">
        {MOODS.map(m => counts[m.key] ? (
          <span key={m.key} className="mood-leg-item">
            <span className={"mood-leg-sw mood-" + m.color} /> {m.key}
            <span className="muted"> {counts[m.key]}</span>
          </span>
        ) : null)}
      </div>
    </div>
  );
}

function ComposeEntry({ existingDates, onSave, onCancel }) {
  const today = journalTodayKey();
  const [date, setDate] = useState(today);
  const [mood, setMood] = useState("focused");
  const [body, setBody] = useState("");
  const hasOther = existingDates.includes(date);
  const textRef = useRef(null);
  useEffect(() => { textRef.current?.focus(); }, []);

  const submit = () => {
    const fullBody = body.trim()
      ? `# ${date}\n\n${body.trim()}`
      : `# ${date}\n\n`;
    onSave({ date, mood, body: fullBody });
  };

  return (
    <Panel title="NEW ENTRY" sub="journal" hint="[Ctrl+Enter] save · [Esc] cancel" focused>
      <div className="form-row">
        <label>Date</label>
        <span style={{ display: "flex", gap: 10, alignItems: "center" }}>
          <input
            className="form-input"
            type="date"
            value={date}
            onChange={e => setDate(e.target.value)}
          />
          <button className="btn" onClick={() => setDate(today)}>today</button>
          {hasOther && (
            <span className="muted" style={{ fontSize: 11 }}>
              note: another entry exists for this date
            </span>
          )}
        </span>
      </div>

      <div className="form-row">
        <label>Mood</label>
        <MoodPicker value={mood} onChange={v => setMood(v || "focused")} />
      </div>

      <div className="form-row" style={{ alignItems: "flex-start" }}>
        <label style={{ paddingTop: 6 }}>Entry</label>
        <textarea
          ref={textRef}
          className="note-editor journal-editor"
          placeholder="How was your day?"
          value={body}
          onChange={e => setBody(e.target.value)}
          onKeyDown={e => {
            if ((e.ctrlKey || e.metaKey) && e.key === "Enter") { e.preventDefault(); submit(); }
            if (e.key === "Escape") { e.stopPropagation(); onCancel(); }
          }}
        />
      </div>

      <div className="hr" />
      <div style={{ display: "flex", gap: 8 }}>
        <button className="btn primary" onClick={submit}>[Ctrl+Enter] save</button>
        <button className="btn" onClick={onCancel}>[Esc] cancel</button>
      </div>
    </Panel>
  );
}

function LinkedPanel({ sel, v }) {
  const links = extractLinks(sel.body || "");
  const tags  = noteTags(sel).filter(t => !["#daily"].includes(t));

  if (links.length === 0 && tags.length === 0) {
    return <div className="muted" style={{ fontSize: 12 }}>No links or tags in this entry</div>;
  }

  return (
    <div className="rowlist">
      {links.map((l, i) => {
        const exists = v.notes.some(n => n.title.toLowerCase() === l.toLowerCase());
        return (
          <button key={"l"+i} className="row link-row" onClick={() => v.openByTitle(l)}>
            <Dot color="purple" />
            <span className="muted" style={{ fontSize: 11 }}>note:</span>
            <span style={{ color: exists ? "var(--text-strong)" : "var(--muted)" }}>[[{l}]]</span>
          </button>
        );
      })}
      {tags.map((t, i) => (
        <button key={"t"+i} className="row link-row" onClick={() => { v.setTagFilter(t); v.setMode("notes"); }}>
          <Dot color={tagColor(t)} />
          <span className="muted" style={{ fontSize: 11 }}>tag:</span>
          <span style={{ color: `var(--${tagColor(t)})` }}>{t}</span>
        </button>
      ))}
    </div>
  );
}

function DiaryScreen() {
  const v = useVault();
  const liveAvail = window.PARVANE.available;

  // sort newest first; tie-break by id (UUIDv7 is time-ordered) so multiple
  // entries on the same date keep a stable, newest-first order.
  const entries = useMemo(
    () => v.notes.filter(n => n.isDaily)
      .sort((a, b) => b.created.localeCompare(a.created) || b.id.localeCompare(a.id)),
    [v.notes]
  );

  const [selId, setSelId]       = useState(null);
  const [composing, setComposing] = useState(false);
  const [editing, setEditing]   = useState(false);

  // keep selection valid
  useEffect(() => {
    if (!selId && entries.length > 0) { setSelId(entries[0].id); return; }
    if (selId && !entries.some(e => e.id === selId) && entries.length > 0) setSelId(entries[0].id);
  }, [entries]);

  const sel = entries.find(e => e.id === selId) || entries[0] || null;

  // keyboard: ↑↓ navigate, [n] new, [e] edit toggle, Esc stop editing/composing
  useEffect(() => {
    const onKey = (e) => {
      if (e.target.tagName === "TEXTAREA" || e.target.tagName === "INPUT") return;
      if (e.code === "KeyN") { setComposing(true); setEditing(false); return; }
      if (e.code === "KeyE" && sel && !composing) { setEditing(x => !x); return; }
      if (e.key === "Escape") { setEditing(false); setComposing(false); return; }
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const idx = entries.findIndex(e2 => e2.id === selId);
        const next = e.key === "ArrowDown"
          ? Math.min(idx + 1, entries.length - 1)
          : Math.max(idx - 1, 0);
        if (entries[next]) { setSelId(entries[next].id); setEditing(false); setComposing(false); }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [entries, selId, sel, composing]);

  if (!liveAvail) {
    return (
      <div className="diary-screen">
        <div className="diary-list col">
          <Panel title="JOURNAL" sub="—">
            <div className="muted" style={{ padding: "20px 0", textAlign: "center" }}>
              Sign in to keep a journal.
            </div>
          </Panel>
        </div>
        <div className="diary-read col">
          <Panel title="ENTRY" focused>
            <div className="muted" style={{ padding: "30px 20px", textAlign: "center" }}>—</div>
          </Panel>
        </div>
      </div>
    );
  }

  return (
    <div className="diary-screen">
      {/* LEFT: entry list + mood graph */}
      <div className="diary-list col">
        <Panel
          title="JOURNAL"
          sub={entries.length + " entries"}
          hint="↑↓ · [n] new · [e] edit"
        >
          <div className="entry-list">
            {entries.length === 0 && (
              <div className="muted" style={{ padding: "14px 0", fontSize: 12, textAlign: "center" }}>
                No entries yet.<br />
                Press <span className="kbd">[n]</span> for your first entry.
              </div>
            )}
            {entries.map(e => (
              <button
                key={e.id}
                className={"entry-card" + (e.id === sel?.id ? " sel" : "")}
                onClick={() => { setSelId(e.id); setEditing(false); setComposing(false); }}
              >
                <div className="entry-card-top">
                  <span className="strong">{shortDate(e.created)}</span>
                  {e.mood && (
                    <span className={"mood-tag mood-" + moodColor(e.mood)}>
                      <span className="mood-glyph">◆</span> {e.mood}
                    </span>
                  )}
                </div>
                <div className="entry-card-preview muted">
                  {bodyPreview(e.body) || "empty entry"}
                </div>
              </button>
            ))}
          </div>
          <div className="hr" />
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <button className="btn primary" onClick={() => { setComposing(true); setEditing(false); }}>
              [n] new entry
            </button>
            {sel && (
              <button className="btn" onClick={() => v.openNote(sel.id)}>
                open as note →
              </button>
            )}
          </div>
        </Panel>

        <Panel title="MOOD" sub={"last " + Math.min(30, entries.length)}>
          <MoodGraph
            entries={entries}
            selId={sel?.id}
            onPick={id => { setSelId(id); setComposing(false); }}
          />
        </Panel>
      </div>

      {/* RIGHT: compose or read/edit selected entry */}
      <div className="diary-read col">
        {composing ? (
          <ComposeEntry
            existingDates={entries.map(e => e.created)}
            onSave={payload => { v.createDaily(payload); setComposing(false); }}
            onCancel={() => setComposing(false)}
          />
        ) : !sel ? (
          <Panel title="ENTRY" sub="—" focused>
            <div className="muted" style={{ padding: "30px 20px", textAlign: "center" }}>
              No entries. Press <span className="kbd">[n]</span> to start.
            </div>
          </Panel>
        ) : (
          <>
            <Panel
              title={"ENTRY · " + sel.created}
              sub={longDate(sel.created)}
              hint={editing ? "[Esc] done · live save" : "[e] edit · [n] new"}
              focused
            >
              <div className="entry-meta">
                <MoodPicker
                  value={sel.mood}
                  onChange={m => v.updateDailyMood(sel.id, sel.created, m)}
                />
                <span className="muted" style={{ marginLeft: "auto", fontSize: 11 }}>
                  {wordCount(sel.body)} words
                </span>
                {!editing
                  ? <button className="btn" onClick={() => setEditing(true)}>[e] edit</button>
                  : <button className="btn primary" onClick={() => setEditing(false)}>done</button>}
              </div>
              <div className="hr" />
              {editing ? (
                <UndoTextarea
                  key={sel.id}
                  className="note-editor journal-editor"
                  value={sel.body}
                  autoFocus
                  spellCheck={false}
                  onChange={val => v.updateBody(sel.id, val)}
                  onSaveNow={() => v.saveNow(sel.id)}
                  onKeyDown={e => { if (e.key === "Escape") setEditing(false); }}
                />
              ) : (
                <div className="diary-body-wrap">
                  {sel.body
                    ? <DiaryBody body={sel.body} />
                    : <span className="muted">Empty entry. Press [e] to write.</span>}
                </div>
              )}
            </Panel>

            <Panel title="LINKED" sub="links and tags">
              <LinkedPanel sel={sel} v={v} />
            </Panel>
          </>
        )}
      </div>
    </div>
  );
}

window.DiaryScreen = DiaryScreen;
