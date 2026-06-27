// CLOUD screen — реальные файлы через cloud-шард.

function fmtBytes(n) {
  if (n === undefined || n === null) return "—";
  if (n >= 1073741824) return (n / 1073741824).toFixed(1) + " GB";
  if (n >= 1048576)    return (n / 1048576).toFixed(1) + " MB";
  if (n >= 1024)       return (n / 1024).toFixed(0) + " KB";
  return n + " B";
}

function fmtTs(ts) {
  if (!ts) return "—";
  return new Date(ts * 1000).toLocaleDateString("ru-RU", { day: "2-digit", month: "short" });
}

function CloudScreen({ me }) {
  const liveAvail = window.PARVANE.available;
  const { files, loading, refresh } = liveAvail
    ? window.useLiveFiles()
    : { files: [], loading: false, refresh: () => {} };

  const c = MONO_DATA.cloud;
  const [sel, setSel] = useState(null);

  // Конвертируем живые файлы в формат, удобный для таблицы
  const liveEntries = files.map((f) => ({
    file_id:  f.file_id,
    name:     f.filename,
    size:     fmtBytes(f.size_bytes),
    mtime:    fmtTs(f.created_at),
    mime:     f.mime_type,
    type:     "file",
    isLive:   true,
  }));

  const entries = (liveAvail && liveEntries.length > 0) ? liveEntries : c.entries;
  const selFile = sel !== null ? entries[sel] : null;

  return (
    <div className="cloud-screen">
      {/* LEFT: узлы и статистика */}
      <div className="cloud-left col">
        <Panel title="ЗАКРЕПЛЕНО" sub={c.pinned.length + " путей"}>
          <div className="rowlist">
            {c.pinned.map((p) => (
              <div key={p.name} className="row">
                <span className="marker">▌</span>
                <span style={{ color: "var(--orange)" }}>📌</span>
                <span className="strong">{p.name}</span>
                <span className="muted" style={{ marginLeft: "auto" }}>{p.note}</span>
              </div>
            ))}
          </div>
        </Panel>

        <Panel title="УЗЛЫ" sub="шарды">
          <div className="rowlist">
            {c.nodes.map((n) => (
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
                    <i style={{ width: (n.used / n.total * 100) + "%", background: n.status === "online" ? "var(--green)" : "var(--muted)" }} />
                  </span>
                </div>
              </div>
            ))}
          </div>
        </Panel>

        <Panel title="ОБЪЁМ" sub="распределённый пул">
          <div className="usage-stats">
            <div className="usage-cell"><div className="muted">used</div><div className="strong">{c.stats.used} GB</div></div>
            <div className="usage-cell"><div className="muted">total</div><div className="strong">{c.stats.total} GB</div></div>
            <div className="usage-cell"><div className="muted">shards</div><div className="strong" style={{ color: "var(--green)" }}>{c.stats.healthy}/{c.stats.shards}</div></div>
            <div className="usage-cell"><div className="muted">файлов</div><div className="strong">{loading ? "…" : liveEntries.length || c.stats.snapshots}</div></div>
          </div>
          <div className="hr" />
          <UsageRing used={c.stats.used} total={c.stats.total} />
        </Panel>
      </div>

      {/* CENTER: список файлов */}
      <div className="cloud-center col">
        <Panel
          title="ФАЙЛЫ"
          sub={liveAvail ? `cloud-шард · ${liveEntries.length} файлов` : c.cwd}
          hint="↑↓ select  [Enter] open  [d] delete  [/] search"
          focused
        >
          <div className="bread">
            <span style={{ color: "var(--yellow)" }}>~/cloud</span>
            <span style={{ marginLeft: "auto", display: "flex", gap: 6 }}>
              <button className="btn" onClick={refresh} disabled={loading}>[r] {loading ? "…" : "обновить"}</button>
              <button className="filter-pill">[/] поиск</button>
            </span>
          </div>
          <div className="hr" />
          <div className="file-table">
            <div className="file-row head">
              <span className="col-name muted">имя</span>
              <span className="col-size muted">размер</span>
              <span className="col-mtime muted">создан</span>
              <span className="col-flag muted">тип</span>
            </div>
            {entries.length === 0 && (
              <div className="muted" style={{ padding: "12px 8px", fontSize: 12 }}>
                {loading ? "загрузка…" : "нет файлов"}
              </div>
            )}
            {entries.map((e, i) => (
              <button
                key={e.file_id || e.name}
                className={"file-row" + (i === sel ? " sel" : "")}
                onClick={() => setSel(i)}
              >
                <span className="col-name">
                  <span className="file-glyph">{fileGlyph(e.name)}</span>
                  <span style={{ color: "var(--text)" }}>{e.name}</span>
                </span>
                <span className="col-size muted">{e.size || "—"}</span>
                <span className="col-mtime muted">{e.mtime || "—"}</span>
                <span className="col-flag muted" style={{ fontSize: 10 }}>{e.mime || e.type || ""}</span>
              </button>
            ))}
          </div>
        </Panel>

        <Panel title="ЗАДАЧИ" sub={c.jobs.filter((j) => j.state === "running").length + " активных"}>
          <div className="job-list">
            {c.jobs.map((j) => (
              <div key={j.id} className="job-row">
                <span className={"job-state " + j.state}>{j.state.toUpperCase().padEnd(7, " ")}</span>
                <span className="muted" style={{ width: 80 }}>{j.id}</span>
                <span className="strong job-what">{j.what}</span>
                <span className="job-pct" style={{ color: j.state === "done" ? "var(--green)" : j.state === "running" ? "var(--yellow)" : "var(--muted)" }}>{j.pct}%</span>
                <span className="job-bar"><i className={"job-bar-fill state-" + j.state} style={{ width: j.pct + "%" }} /></span>
              </div>
            ))}
          </div>
        </Panel>
      </div>

      {/* RIGHT: детали файла */}
      <div className="cloud-right col">
        <FileDetail file={selFile} />
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
  if (!file) return (
    <Panel title="ФАЙЛ" sub="не выбран" focused>
      <div className="muted">выберите файл в списке</div>
    </Panel>
  );
  return (
    <Panel title="ФАЙЛ" sub={file.name} focused>
      <div className="form-row"><label>имя</label><span className="v strong">{file.name}</span></div>
      <div className="form-row"><label>размер</label><span className="v">{file.size || "—"}</span></div>
      <div className="form-row"><label>создан</label><span className="v">{file.mtime || "—"}</span></div>
      {file.mime && <div className="form-row"><label>MIME</label><span className="v muted">{file.mime}</span></div>}
      {file.file_id && (
        <div className="form-row">
          <label>ID</label>
          <span className="v muted" style={{ fontSize: 10, wordBreak: "break-all" }}>{file.file_id}</span>
        </div>
      )}
      {!file.isLive && (
        <>
          <div className="form-row"><label>replicas</label>
            <span className="v">
              <span style={{ color: (file.replicas || 0) >= 3 ? "var(--green)" : "var(--yellow)" }}>{file.replicas || 0}</span> / 3
            </span>
          </div>
          <div className="form-row"><label>enc</label>
            <span className="v">{file.enc ? <span style={{ color: "var(--red)" }}>● age</span> : <span className="muted">○ нет</span>}</span>
          </div>
        </>
      )}
      <div className="hr" />
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 8 }}>
        <button className="btn">[Enter] открыть</button>
        <button className="btn danger">[d] удалить</button>
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
