import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { LockKeyhole } from "lucide-react";

type GateState = "checking" | "locked" | "ready" | "error";

/** The Windows access code is displayed only in the local server's terminal. */
export default function LocalAccessGate({ children, onAccess }: { children: ReactNode; onAccess: (token: string) => void }) {
  const [state, setState] = useState<GateState>("checking");
  const [token, setToken] = useState("");
  const [message, setMessage] = useState("");
  const [checkingCode, setCheckingCode] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let active = true;
    fetch("/api/local-session/mode", { cache: "no-store" })
      .then(async response => {
        if (!response.ok) throw new Error("mode unavailable");
        const value = await response.json();
        if (typeof value.requiresToken !== "boolean") throw new Error("invalid mode");
        if (active) setState(value.requiresToken ? "locked" : "ready");
      })
      .catch(() => { if (active) setState("error"); });
    return () => { active = false; };
  }, [attempt]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!token.trim() || checkingCode) return;
    setCheckingCode(true);
    setMessage("");
    try {
      const response = await fetch("/api/local-session/verify", {
        method: "GET", cache: "no-store",
        headers: { "X-Local-Assistant": "1", "X-Local-Access": token.trim() },
      });
      if (!response.ok) throw new Error("invalid token");
      onAccess(token.trim());
      setToken("");
      setState("ready");
    } catch {
      setMessage("访问码不正确或服务已重启，请复制当前启动窗口中的最新访问码。");
    } finally { setCheckingCode(false); }
  }

  if (state === "ready") return <>{children}</>;
  return <main className="local-gate"><section className="local-gate-card" aria-labelledby="local-gate-title">
    <span className="local-gate-icon"><LockKeyhole size={23} /></span>
    <h1 id="local-gate-title">本机访问保护</h1>
    {state === "checking" && <p>正在确认本机服务状态…</p>}
    {state === "error" && <><p>无法确认服务状态，请检查程序是否已启动。</p><button className="local-gate-button" onClick={() => { setState("checking"); setAttempt(value => value + 1); }}>重新检查</button></>}
    {state === "locked" && <><p>请从启动程序的 PowerShell 窗口复制“本机访问码”，粘贴到下方。访问码每次重启后更换，请勿分享。</p><form onSubmit={event => void submit(event)}><label htmlFor="local-access-code">本机访问码</label><input id="local-access-code" type="password" autoComplete="off" value={token} onChange={event => setToken(event.target.value)} required /><button className="local-gate-button" disabled={checkingCode || !token.trim()}>{checkingCode ? "正在验证…" : "进入助手"}</button></form>{message && <p className="local-gate-error" role="alert">{message}</p>}</>}
  </section></main>;
}
