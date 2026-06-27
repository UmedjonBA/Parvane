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

  // Enter в любом поле → войти
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
  const [me, setMe]   = useState(null);     // null = не залогинен
  const [tab, setTab] = useState("messenger");
  const [t, setTweak] = useTweaks(TWEAK_DEFAULTS);

  // Если Tauri не доступен — работаем как статичное демо без логина
  const needLogin = window.PARVANE.available && me === null;

  // Проверяем авто-логин из localStorage при старте
  useEffect(() => {
    if (!window.PARVANE.available) {
      setMe("demo");
      return;
    }
    // live.jsx уже запустил автологин; проверяем результат
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

  // глобальные горячие клавиши
  useEffect(() => {
    const onKey = (e) => {
      if (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA") return;
      const map = { "1":"calendar","2":"diary","3":"home","4":"system","5":"messenger","6":"notes","7":"cloud" };
      if (map[e.key]) setTab(map[e.key]);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  if (needLogin) {
    return <LoginScreen onLogin={(u) => setMe(u)} />;
  }

  const screen = {
    calendar:  <CalendarScreen me={me} />,
    diary:     <DiaryScreen />,
    home:      <HomeScreen />,
    system:    <SystemScreen />,
    messenger: <MessengerScreen me={me} />,
    notes:     <NotesScreen me={me} />,
    cloud:     <CloudScreen me={me} />,
  }[tab];

  const footer = {
    calendar:  <Footer hints={[["↑↓","week"],["←→","day"],["[Enter]","select"],["[a]","add"],["[1-7]","tabs"]]} focus={"CALENDAR · " + (me || "demo")} />,
    diary:     <Footer hints={[["↑↓","entry"],["[n]","new"],["[1-7]","tabs"]]} focus="DIARY" />,
    home:      <Footer hints={[["[tab]","panel"],["↑↓","device"],["[Enter]","toggle"],["[1-7]","tabs"]]} focus="HOME" />,
    system:    <Footer hints={[["[tab]","focus"],["[Enter]","ping"],["[:]","cmd"],["[1-7]","tabs"]]} focus="SYSTEM" />,
    messenger: <Footer hints={[["↑↓","chat"],["[/]","search"],["[Enter]","send"],["[1-7]","tabs"]]} focus={"MESSENGER · " + (me || "demo")} />,
    notes:     <Footer hints={[["↑↓","note"],["[Enter]","open"],["[n]","new"],["[1-7]","tabs"]]} focus="NOTES" />,
    cloud:     <Footer hints={[["↑↓","entry"],["[Enter]","open"],["[d]","delete"],["[1-7]","tabs"]]} focus="CLOUD" />,
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
        <TweakSection title="Visual">
          <TweakColor t={t} setTweak={setTweak} k="accent"
            options={["#fe8019","#fabd2f","#d3869b","#8ec07c","#83a598"]}>
            Accent
          </TweakColor>
          <TweakRadio t={t} setTweak={setTweak} k="density"
            options={["compact","comfortable"]}>Density</TweakRadio>
          <TweakRadio t={t} setTweak={setTweak} k="logo"
            options={["block","line"]}>Logo style</TweakRadio>
        </TweakSection>
        <TweakSection title="Demo">
          <TweakToggle t={t} setTweak={setTweak} k="showFire">FIRE alert modal</TweakToggle>
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
        <div className="muted" style={{ fontSize: 11, marginTop: 6 }}>VERTEX:BUZZ:ON</div>
      </div>
    </div>
  );
}

ReactDOM.createRoot(document.getElementById("root")).render(<App />);
