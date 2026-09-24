import { useState } from "react";
import { signIn, MODE, DEMO_PASSWORD, resetDemo, type Session } from "../api";
import { DEMO_USERS } from "@shared/app/demo.ts";

export default function SignIn({ onSignIn }: { onSignIn: (s: Session) => void }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const submit = async (e?: React.FormEvent, em = email, pw = password) => {
    e?.preventDefault();
    try { onSignIn(await signIn(em, pw)); } catch (x) { setErr((x as Error).message); }
  };
  return (
    <div className="mx-auto max-w-md space-y-4">
      <form className="card space-y-3" onSubmit={submit} data-testid="signin-form">
        <h1 className="h1">Sign in to Harbor</h1>
        <div><label className="label" htmlFor="email">Email</label><input id="email" className="input" data-testid="signin-email" value={email} onChange={(e) => setEmail(e.target.value)} /></div>
        <div><label className="label" htmlFor="password">Password</label><input id="password" type="password" className="input" data-testid="signin-password" value={password} onChange={(e) => setPassword(e.target.value)} /></div>
        {err && <p className="text-sm text-red-600" data-testid="signin-error">{err}</p>}
        <button className="btn w-full" data-testid="signin-submit">Sign in</button>
      </form>
      {MODE === "demo" && (
        <div className="card space-y-2" data-testid="demo-users">
          <p className="muted">Demo users (password <code>{DEMO_PASSWORD}</code>):</p>
          <div className="flex flex-wrap gap-2">
            {DEMO_USERS.map((u) => (
              <button key={u.email} className="btn-outline" data-testid={`demo-login-${u.email.split("@")[0]}`} onClick={() => submit(undefined, u.email, DEMO_PASSWORD)}>
                {u.legalName} <span className="ml-1 text-xs text-slate-500">({u.role === "customer" ? u.email.split("@")[0] : u.role})</span>
              </button>
            ))}
          </div>
          <button className="text-xs text-slate-500 underline" data-testid="demo-reset" onClick={async () => { await resetDemo(); location.reload(); }}>Reset demo data</button>
        </div>
      )}
    </div>
  );
}
