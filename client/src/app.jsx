// MONOLITH root.

const TWEAK_DEFAULTS = /*EDITMODE-BEGIN*/{
  "accent": "#fe8019",
  "density": "comfortable",
  "logo": "block",
  "showFire": false
}/*EDITMODE-END*/;

// ── экран входа ──────────────────────────────────────────────────────────────

function LoginScreen({ onLogin }) {
  const [user, setUser]       = useState(localStorage.getItem("parvane_user")     || "");
  const [pass, setPass]       = useState(localStorage.getItem("parvane_password") || "");
  const [error, setError]     = useState(null);
  const [loading, setLoading] = useState(false);

  const submit = async (e) => {
    e && e.preventDefault();
    const u = user.trim();
    const p = pass;
    if (!u || !p) { setError("заполните логин и пароль"); return; }
    setLoading(true);
    setError(null);
    try {
      await window.parvaneLogin(u, p);
      onLogin(u);
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  };

  const onKey = (e) => { if (e.key === "Enter") submit(); };

  return (
    <div className="login-screen">
      <div className="login-box">
        <pre className="ascii login-logo" style={{ textAlign: "center", color: "var(--accent)", marginBottom: 16 }}>
{`██████╗  █████╗ ██████╗ ██╗   ██╗ █████╗ ███╗   ██╗███████╗
██╔══██╗██╔══██╗██╔══██╗██║   ██║██╔══██╗████╗  ██║██╔════╝
██████╔╝███████║██████╔╝██║   ██║███████║██╔██╗ ██║█████╗
██╔═══╝ ██╔══██║██╔══██╗╚██╗ ██╔╝██╔══██║██║╚██╗██║██╔══╝
██║     ██║  ██║██║  ██║ ╚████╔╝ ██║  ██║██║ ╚████║███████╗
╚═╝     ╚═╝  ╚═╝╚═╝  ╚═╝  ╚═══╝  ╚═╝  ╚═╝╚═╝  ╚═══╝╚══════╝`}
        </pre>
        <div className="login-title">federated self-hosted</div>

        <form className="login-form" onSubmit={submit}>
          <div className="form-row login-row">
            <label>user</label>
            <input
              className="form-input"
              value={user}
              onChange={(e) => setUser(e.target.value)}
              onKeyDown={onKey}
              placeholder="user@domain"
              autoFocus
            />
          </div>
          <div className="form-row login-row">
            <label>pass</label>
            <input
              className="form-input"
              type="password"
              value={pass}
              onChange={(e) => setPass(e.target.value)}
              onKeyDown={onKey}
              placeholder="••••••••"
            />
          </div>

          {error && (
            <div className="login-error" style={{ color: "var(--red)", marginTop: 8 }}>
              ✗ {error}
            </div>
          )}

          <div style={{ marginTop: 14, display: "flex", gap: 8 }}>
            <button className="btn primary" type="submit" disabled={loading} style={{ flex: 1 }}>
              {loading ? "вход…" : "[Enter] войти"}
            </button>
          </div>
          <div className="muted" style={{ fontSize: 11, marginTop: 6, textAlign: "center" }}>
            новый пользователь создаётся автоматически
          </div>
        </form>
      </div>
    </div>
  );
}

// ── основное приложение ───────────────────────────────────────────────────────

function App() {
  const [me, setMe]   = useState(null);
  const [tab, setTab] = useState("messenger");
  const [t, setTweak] = useTweaks(TWEAK_DEFAULTS);

  const needLogin = window.PARVANE.available && me === null;

  useEffect(() => {
    if (!window.PARVANE.available) {
      setMe("demo");
      return;
    }
    const stored = localStorage.getItem("parvane_user");
    if (stored) {
      window.PARVANE.currentUser().then((u) => {
        if (u) setMe(u);
      }).catch(() => {});
    }
  }, []);

  useEffect(() => {
    document.documentElement.style.setProperty("--accent", t.accent);
    document.body.dataset.density = t.density;
  }, [t.accent, t.density]);

  useEffect(() => {
    const onKey = (e) => {
      if (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA") return;
      const map = { "1": "calendar", "2": "messenger", "3": "notes" };
      if (map[e.key]) setTab(map[e.key]);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Это десктоп-приложение, а не сайт: подавляем нативное контекстное меню
  // вебвью (reload/inspect/back) везде, кроме полей ввода, где пользователю
  // нужны cut/copy/paste. Экраны вешают свои onContextMenu для своих действий.
  useEffect(() => {
    const onCtx = (e) => {
      const tag = e.target.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || e.target.isContentEditable) return;
      e.preventDefault();
    };
    window.addEventListener("contextmenu", onCtx);
    return () => window.removeEventListener("contextmenu", onCtx);
  }, []);

  if (needLogin) {
    return <LoginScreen onLogin={(u) => setMe(u)} />;
  }

  const screen = {
    calendar:  <CalendarScreen me={me} />,
    messenger: <MessengerScreen me={me} />,
    notes:     <WorkspaceScreen me={me} />,
  }[tab] || null;

  const footer = {
    calendar:  <Footer hints={[["↑↓","неделя"],["←→","день"],["[a]","добавить"],["[1-3]","вкладки"]]} focus={"CALENDAR · " + (me || "")} />,
    messenger: <Footer hints={[["↑↓","чат"],["[/]","поиск"],["[Enter]","отправить"],["[n]","новый"],["[1-3]","вкладки"]]} focus={"MESSENGER · " + (me || "")} />,
    notes:     <Footer hints={[["[g]","заметки"],["[j]","журнал"],["↑↓","запись"],["[n]","новая"],["[Ctrl+S]","сохранить"],["[1-3]","вкладки"]]} focus={"DIARY · " + (me || "")} />,
  }[tab];

  const onLogout = async () => {
    await window.parvaneLogout();
    setMe(null);
  };

  return (
    <>
      <Shell active={tab} onTab={setTab} footer={footer} tweaks={t} me={me} onLogout={onLogout}>
        {screen}
      </Shell>
      {t.showFire && <FireAlert onClose={() => setTweak("showFire", false)} />}
      <TweaksPanel title="MONOLITH · Tweaks">
        <TweakSection label="Visual">
          <TweakColor label="Accent" value={t.accent}
            options={["#fe8019","#fabd2f","#d3869b","#8ec07c","#83a598"]}
            onChange={(v) => setTweak("accent", v)} />
          <TweakRadio label="Density" value={t.density}
            options={["compact","comfortable"]}
            onChange={(v) => setTweak("density", v)} />
        </TweakSection>
        <TweakSection label="Demo">
          <TweakToggle label="FIRE alert" value={t.showFire}
            onChange={(v) => setTweak("showFire", v)} />
        </TweakSection>
      </TweaksPanel>
    </>
  );
}

function FireAlert({ onClose }) {
  return (
    <div className="fire-backdrop" onClick={onClose}>
      <div className="fire-modal" onClick={(e) => e.stopPropagation()}>
        <h2>⚠ ALARM</h2>
        <p>TIMER fired</p>
        <p className="fire-name">pomodoro_25</p>
        <div className="fire-action">[ Enter ] turn off buzzer</div>
      </div>
    </div>
  );
}

ReactDOM.createRoot(document.getElementById("root")).render(<App />);
