import { useState } from "react";
import { NavLink, Navigate, Route, Routes, useNavigate } from "react-router-dom";
import { getSession, signOut, MODE, type Session } from "./api";
import SignIn from "./pages/SignIn";
import Accounts from "./pages/Accounts";
import LinkBank from "./pages/LinkBank";
import Transfers from "./pages/Transfers";
import Cards from "./pages/Cards";
import Disputes from "./pages/Disputes";
import Fees from "./pages/Fees";
import Admin from "./pages/Admin";
import Statements from "./pages/Statements";
import Settings from "./pages/Settings";

export default function App() {
  const [session, setSession] = useState<Session | null>(getSession());
  const nav = useNavigate();
  const staff = session?.role === "admin" || session?.role === "support_agent";
  const links: [string, string][] = session
    ? [["/", "Accounts"], ["/link-bank", "Link bank"], ["/transfers", "Transfers"], ["/cards", "Cards"], ["/disputes", "Disputes"], ["/statements", "Statements"], ["/fees", "Fees & terms"], ["/settings", "Settings"], ...(staff ? [["/admin", "Admin"] as [string, string]] : [])]
    : [["/fees", "Fees & terms"]];
  return (
    <div className="min-h-screen bg-slate-50 text-slate-900">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-4 px-4 py-3">
          <span className="text-xl font-bold text-harbor-700" data-testid="brand">⚓ Harbor</span>
          <nav className="flex flex-wrap gap-1">
            {links.map(([to, label]) => (
              <NavLink key={to} to={to} end data-testid={`nav-${label.toLowerCase().replace(/[^a-z]+/g, "-")}`}
                className={({ isActive }) => `rounded-lg px-3 py-1.5 text-sm ${isActive ? "bg-harbor-50 font-medium text-harbor-700" : "text-slate-600 hover:bg-slate-100"}`}>{label}</NavLink>
            ))}
          </nav>
          <div className="ml-auto flex items-center gap-3 text-sm">
            {MODE === "demo" && <span className="rounded bg-amber-100 px-2 py-0.5 text-xs text-amber-800" data-testid="demo-mode">Demo mode · fake providers</span>}
            {session ? (
              <>
                <span className="text-slate-600" data-testid="session-email">{session.email}</span>
                <button className="btn-outline" data-testid="sign-out" onClick={async () => { await signOut(); setSession(null); nav("/signin"); }}>Sign out</button>
              </>
            ) : <NavLink to="/signin" className="btn">Sign in</NavLink>}
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-4 py-6">
        <Routes>
          <Route path="/signin" element={<SignIn onSignIn={(s) => { setSession(s); nav(s.role === "customer" ? "/" : "/admin"); }} />} />
          <Route path="/fees" element={<Fees />} />
          {session ? (
            <>
              <Route path="/" element={<Accounts />} />
              <Route path="/link-bank" element={<LinkBank />} />
              <Route path="/transfers" element={<Transfers />} />
              <Route path="/cards" element={<Cards />} />
              <Route path="/disputes" element={<Disputes />} />
              <Route path="/statements" element={<Statements />} />
              <Route path="/settings" element={<Settings />} />
              <Route path="/admin" element={staff ? <Admin /> : <Navigate to="/" />} />
            </>
          ) : <Route path="*" element={<Navigate to="/signin" />} />}
        </Routes>
      </main>
    </div>
  );
}
