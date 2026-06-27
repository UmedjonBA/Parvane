// CLOUD screen — distributed personal storage.

function CloudScreen() {
  const c = MONO_DATA.cloud;
  const [sel, setSel] = useState(c.sel);
  const [view, setView] = useState("list"); // list | tree

  return (
    <div className="cloud-screen">
      <div className="cloud-left col">
        <Panel title="PINNED" sub={c.pinned.length + " paths"}>
          <div className="rowlist">
            {c.pinned.map(p => (
              <div key={p.name} className="row">
                <span className="marker">▌</span>
                <span style={{ color: "var(--orange)" }}>📌</span>
                <span className="strong">{p.name}</span>
                <span className="muted" style={{ marginLeft: "auto" }}>{p.note}</span>
              </div>
            ))}
          </div>
        </Panel>

        <Panel title="NODES" sub="4 · shards 3014">
          <div className="rowlist">
            {c.nodes.map(n => (
              <div key={n.id} className="row" style={{ display: "block", padding: "4px 0 4px 8px" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <span className="marker">▌</span>
                  <Dot color={n.status === "online" ? "green" : n.status === "sleep" ? "yellow" : "red"} />
                  <span className="strong">{n.id}</span>
                  <span className="muted" style={{ marginLeft: 4 }}>{n.role}</span>
                  <span className="muted" style={{ marginLeft: "auto" }}>{n.used} / {n.total} GB</span>
                </div>
                <div className="progress" style={{ marginTop: 4, paddingLeft: 24, width: "100%" }}>
                  <span className="bar" style={{ width: "calc(100% - 28px)" }}>
                    <i style={{
                      width: (n.used / n.total * 100) + "%",
                      background: n.status === "online" ? "var(--green)" : "var(--muted)"
                    }} />
                  </span>
                </div>
              </div>
            ))}
          </div>
        </Panel>

        <Panel title="USAGE" sub="distributed pool">
          <div className="usage-stats">
            <div className="usage-cell">
              <div className="muted">used</div>
              <div className="strong">{c.stats.used} GB</div>
            </div>
            <div className="usage-cell">
              <div className="muted">total</div>
              <div className="strong">{c.stats.total} GB</div>
            </div>
            <div className="usage-cell">
              <div className="muted">shards</div>
              <div className="strong" style={{ color: "var(--green)" }}>{c.stats.healthy}/{c.stats.shards}</div>
            </div>
            <div className="usage-cell">
              <div className="muted">snapshots</div>
              <div className="strong">{c.stats.snapshots}</div>
            </div>
          </div>
          <div className="hr" />
          <UsageRing used={c.stats.used} total={c.stats.total} />
        </Panel>
      </div>

      <div className="cloud-center col">
        <Panel
          title="FILES"
          sub={c.cwd}
          hint="↑↓ select  [Enter] open  [Space] mark  [d] delete  [/] search"
          focused
        >
          <div className="bread">
            {c.bread.map((b, i) => (
              <span key={i} className="bread-item">
                <span style={{ color: i === c.bread.length - 1 ? "var(--yellow)" : "var(--muted)" }}>{b}</span>
                {i < c.bread.length - 1 && <span className="muted"> / </span>}
              </span>
            ))}
            <span style={{ marginLeft: "auto", display: "flex", gap: 6 }}>
              <button className={"filter-pill" + (view === "list" ? " on" : "")} onClick={() => setView("list")}>list</button>
              <button className={"filter-pill" + (view === "tree" ? " on" : "")} onClick={() => setView("tree")}>tree</button>
              <button className="filter-pill">[/] search</button>
            </span>
          </div>
          <div className="hr" />
          <div className="file-table">
            <div className="file-row head">
              <span className="col-name muted">name</span>
              <span className="col-size muted">size</span>
              <span className="col-mtime muted">modified</span>
              <span className="col-rep muted">replicas</span>
              <span className="col-flag muted">flags</span>
            </div>
            {c.entries.map((e, i) => (
              <button
                key={e.name}
                className={"file-row" + (i === sel ? " sel" : "") + (e.type === "dir" ? " is-dir" : "")}
                onClick={() => setSel(i)}
              >
                <span className="col-name">
                  <span className="file-glyph">
                    {e.name === ".." ? "↩"
                      : e.type === "dir" ? "▸"
                      : e.enc ? "🔒"
                      : fileGlyph(e.name)}
                  </span>
                  <span className={e.type === "dir" ? "strong" : ""} style={{
                    color: e.type === "dir" ? "var(--yellow)"
                      : e.enc ? "var(--red)"
                      : "var(--text)"
                  }}>{e.name}</span>
                </span>
                <span className="col-size muted">{e.size || ""}</span>
                <span className="col-mtime muted">{e.mtime || ""}</span>
                <span className="col-rep">
                  {e.replicas ? (
                    <span style={{ color: e.replicas >= 3 ? "var(--green)" : e.replicas === 2 ? "var(--yellow)" : "var(--red)" }}>
                      {"●".repeat(e.replicas) + "○".repeat(Math.max(0, 3 - e.replicas))}
                    </span>
                  ) : ""}
                </span>
                <span className="col-flag muted">
                  {e.enc && <span style={{ color: "var(--red)" }}>enc</span>}
                  {e.warn && <span style={{ color: "var(--yellow)", marginLeft: 6 }}>⚠ {e.warn}</span>}
                </span>
              </button>
            ))}
          </div>
        </Panel>

        <Panel
          title="JOBS"
          sub={c.jobs.filter(j => j.state === "running").length + " running"}
          hint="[Enter] inspect  [r] retry  [c] cancel"
        >
          <div className="job-list">
            {c.jobs.map(j => (
              <div key={j.id} className="job-row">
                <span className={"job-state " + j.state}>{j.state.toUpperCase().padEnd(7, " ")}</span>
                <span className="muted" style={{ width: 80 }}>{j.id}</span>
                <span className="strong job-what">{j.what}</span>
                <span className="job-pct" style={{ color: j.state === "done" ? "var(--green)" : j.state === "running" ? "var(--yellow)" : "var(--muted)" }}>{j.pct}%</span>
                <span className="job-bar">
                  <i className={"job-bar-fill state-" + j.state} style={{ width: j.pct + "%" }} />
                </span>
              </div>
            ))}
          </div>
        </Panel>
      </div>

      <div className="cloud-right col">
        <FileDetail file={c.entries[sel]} />
        <SnapshotPanel />
        <PolicyPanel />
      </div>
    </div>
  );
}

function fileGlyph(name) {
  if (name.endsWith(".md")) return "≡";
  if (name.endsWith(".mp4")) return "▶";
  if (name.endsWith(".env.age")) return "🔒";
  if (name.endsWith(".sha256")) return "#";
  if (name.match(/\.(png|jpg|svg)$/)) return "◫";
  return "·";
}

function UsageRing({ used, total }) {
  const pct = used / total;
  const R = 38, C = 2 * Math.PI * R;
  return (
    <div className="usage-ring">
      <svg width="100" height="100" viewBox="0 0 100 100">
        <circle cx="50" cy="50" r={R} fill="none" stroke="#3c3836" strokeWidth="6" />
        <circle cx="50" cy="50" r={R} fill="none" stroke="#fabd2f" strokeWidth="6"
          strokeDasharray={`${C * pct} ${C}`} strokeLinecap="butt"
          transform="rotate(-90 50 50)" />
        <text x="50" y="48" textAnchor="middle" fill="#fbf1c7" fontFamily="JetBrains Mono" fontSize="14" fontWeight="700">
          {Math.round(pct * 100)}%
        </text>
        <text x="50" y="62" textAnchor="middle" fill="#928374" fontFamily="JetBrains Mono" fontSize="9">
          used
        </text>
      </svg>
      <div className="usage-legend">
        <div className="muted">primary <span className="strong" style={{ color: "var(--yellow)" }}>n01</span></div>
        <div className="muted">replicas <span className="strong">3</span></div>
        <div className="muted">read <span className="strong" style={{ color: "var(--aqua)" }}>4.1 MB/s</span></div>
        <div className="muted">write <span className="strong" style={{ color: "var(--orange)" }}>1.2 MB/s</span></div>
      </div>
    </div>
  );
}

function FileDetail({ file }) {
  if (!file) return null;
  return (
    <Panel title={file.type === "dir" ? "DIRECTORY" : "FILE"} sub={file.name} focused>
      <div className="form-row"><label>name</label><span className="v strong">{file.name}</span></div>
      <div className="form-row"><label>type</label><span className="v">{file.type}</span></div>
      <div className="form-row"><label>size</label><span className="v">{file.size}</span></div>
      <div className="form-row"><label>modified</label><span className="v">{file.mtime}</span></div>
      <div className="form-row"><label>replicas</label>
        <span className="v">
          <span style={{ color: (file.replicas || 0) >= 3 ? "var(--green)" : "var(--yellow)" }}>
            {file.replicas || 0}
          </span> / 3
          {file.warn && <span style={{ color: "var(--yellow)", marginLeft: 8 }}>⚠ {file.warn}</span>}
        </span>
      </div>
      <div className="form-row"><label>encryption</label>
        <span className="v">{file.enc ? <span style={{ color: "var(--red)" }}>● age, identity v1</span> : <span className="muted">○ none</span>}</span>
      </div>
      <div className="form-row"><label>integrity</label><span className="v"><span style={{ color: "var(--green)" }}>● sha256 ok</span></span></div>
      <div className="form-row"><label>last access</label><span className="v muted">13/05 22:11 from MONOVIEW</span></div>
      <div className="hr" />
      {file.type === "file" && (
        <div className="file-preview">
          <pre className="ascii dim" style={{ fontSize: 10, lineHeight: 1.1 }}>
{`▒▒░░  ▓▒░  ░░░░░ ▒▓
▓▓▒░  ░░▓  ▒░▓ ░ ░░
░▒▓▒  ▒▒░  ░▓░▒░▒ ░
▒▒░░  ░░░  ░ ▒ ░░░░`}
          </pre>
        </div>
      )}
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 8 }}>
        <button className="btn">[Enter] open</button>
        <button className="btn">[r] rename</button>
        <button className="btn">[c] copy</button>
        <button className="btn">[s] share</button>
        <button className="btn danger">[d] delete</button>
      </div>
    </Panel>
  );
}

function SnapshotPanel() {
  const snaps = [
    { time: "13/05 22:00", size: "+312 MB", auto: true,  state: "ok" },
    { time: "13/05 14:00", size: "+ 18 MB", auto: true,  state: "ok" },
    { time: "13/05 08:00", size: "+  4 MB", auto: true,  state: "ok" },
    { time: "12/05 22:00", size: "+ 76 MB", auto: true,  state: "ok" },
    { time: "12/05 11:14", size: "+128 MB", auto: false, state: "ok", label: "before-deploy" },
  ];
  return (
    <Panel title="SNAPSHOTS" sub="last 5 of 14">
      <div className="rowlist">
        {snaps.map((s, i) => (
          <div key={i} className="row">
            <span className="marker">▌</span>
            <span style={{ color: "var(--aqua)" }}>◐</span>
            <span className="strong" style={{ width: 92 }}>{s.time}</span>
            <span className="muted">{s.size}</span>
            {s.label && <span className="badge atp" style={{ marginLeft: 6 }}>{s.label}</span>}
            <span className="muted" style={{ marginLeft: "auto", fontSize: 11 }}>{s.auto ? "auto" : "manual"}</span>
          </div>
        ))}
      </div>
      <div className="hr" />
      <div style={{ display: "flex", gap: 8 }}>
        <button className="btn primary">[s] snapshot now</button>
        <button className="btn">[r] restore</button>
      </div>
    </Panel>
  );
}

function PolicyPanel() {
  return (
    <Panel title="POLICY" sub="vault rules">
      <div className="rowlist">
        <div className="row"><Dot color="green" /><span className="muted">redundancy</span><span className="strong" style={{ marginLeft: "auto" }}>3× replicas</span></div>
        <div className="row"><Dot color="green" /><span className="muted">scrub</span><span className="strong" style={{ marginLeft: "auto" }}>weekly</span></div>
        <div className="row"><Dot color="yellow" /><span className="muted">off-site</span><span className="strong" style={{ marginLeft: "auto" }}>vps-fra (1)</span></div>
        <div className="row"><Dot color="green" /><span className="muted">encryption</span><span className="strong" style={{ marginLeft: "auto" }}>age @ /diary, /secrets</span></div>
        <div className="row"><Dot color="green" /><span className="muted">retention</span><span className="strong" style={{ marginLeft: "auto" }}>90 days</span></div>
        <div className="row"><Dot color="muted" /><span className="muted">cold tier</span><span className="strong" style={{ marginLeft: "auto" }}>rpi-attic, sleep</span></div>
      </div>
    </Panel>
  );
}

window.CloudScreen = CloudScreen;
