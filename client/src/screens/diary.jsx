// DIARY screen.

function DiaryScreen() {
  const [sel, setSel] = useState(0);
  const entry = MONO_DATA.diary[sel];

  return (
    <div className="diary-screen">
      <div className="diary-list col">
        <Panel title="DIARY" sub={MONO_DATA.diary.length + " entries"} hint="↑↓ select  [n] new">
          <div className="entry-list">
            {MONO_DATA.diary.map((e, i) => (
              <button
                key={i}
                className={"entry-card" + (i === sel ? " sel" : "")}
                onClick={() => setSel(i)}
              >
                <div className="entry-card-top">
                  <span className="strong">{e.short}</span>
                  <span className={"mood-tag mood-" + e.color}>
                    <span className="mood-glyph">◆</span> {e.mood}
                  </span>
                </div>
                <div className="entry-card-preview muted">{e.preview}</div>
              </button>
            ))}
          </div>
          <div className="hr" />
          <div style={{ display: "flex", gap: 8 }}>
            <button className="btn primary">[n] new entry</button>
            <button className="btn">[t] mood timeline</button>
          </div>
        </Panel>

        <Panel title="MOOD GRAPH" sub="last 30 days">
          <MoodGraph />
        </Panel>
      </div>

      <div className="diary-read col">
        <Panel title={`ENTRY · ${entry.short.toUpperCase()}`} sub={entry.weekday} focused>
          <div className="entry-meta">
            <span className={"mood-tag mood-" + entry.color}>
              <span className="mood-glyph">◆</span> {entry.mood}
            </span>
            <span className="muted">·  {entry.weekday}</span>
            <span className="muted" style={{ marginLeft: "auto" }}>{entry.body.split(/\s+/).filter(Boolean).length} words</span>
          </div>
          <div className="hr" />
          <pre className="entry-body">{entry.body}</pre>
        </Panel>

        <Panel title="LINKED" sub="related notes & events">
          <div className="rowlist">
            <div className="row"><Dot color="purple" /><span className="muted">notes:</span> <span className="strong">[[MONOLITH]]</span></div>
            <div className="row"><Dot color="purple" /><span className="muted">notes:</span> <span className="strong">[[ACHTUNG]]</span></div>
            <div className="row"><Dot color="red"   /><span className="muted">deadline:</span> <span className="strong">Go Reflect</span> <span className="muted">— today</span></div>
            <div className="row"><Dot color="blue"  /><span className="muted">event:</span> <span className="strong">23:59 Go Reflect</span></div>
          </div>
        </Panel>
      </div>
    </div>
  );
}

function MoodGraph() {
  // generate 30 days of fake moods
  const moods = ["focused","productive","calm","tired","stressed","focused","productive","calm","focused","productive"];
  const colors = { focused:"blue", productive:"green", calm:"aqua", tired:"yellow", stressed:"red" };
  // 30 days back, seeded
  const arr = [];
  let s = 7;
  for (let i = 0; i < 30; i++) { s = (s * 9301 + 49297) % 233280; arr.push(moods[s % moods.length]); }
  return (
    <div className="mood-graph">
      <div className="mood-bars">
        {arr.map((m, i) => (
          <div key={i} className="mood-bar" title={m}>
            <div className={"mood-fill mood-" + colors[m]} style={{ height: (40 + (i*7)%40) + "%" }} />
          </div>
        ))}
      </div>
      <div className="mood-legend">
        {Object.entries(colors).map(([m, c]) => (
          <span key={m} className="mood-leg-item">
            <span className={"mood-leg-sw mood-" + c} /> {m}
          </span>
        ))}
      </div>
    </div>
  );
}

window.DiaryScreen = DiaryScreen;
