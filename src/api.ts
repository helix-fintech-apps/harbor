// API client. Two transports:
//  - live:  Supabase Auth + the `api` Edge Function (when VITE_SUPABASE_URL is set)
//  - demo:  the same service + router running in the browser on an in-memory store with fake
//           providers, persisted to localStorage (no backend needed; default for local dev / Helix runs).
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { createMemoryApp, seedDemo, DEMO_PASSWORD, DEMO_USERS, type MemoryApp } from "@shared/app/demo.ts";

export type Role = "customer" | "admin" | "support_agent";
export interface Session { userId: string; email: string; role: Role }
export interface ApiResult<T = any> { ok: boolean; status: number; data: T; error?: { code: string; message: string; details?: unknown } }

const LIVE = !!import.meta.env.VITE_SUPABASE_URL;
export const MODE: "live" | "demo" = LIVE ? "live" : "demo";
const supabase: SupabaseClient | null = LIVE ? createClient(import.meta.env.VITE_SUPABASE_URL!, import.meta.env.VITE_SUPABASE_ANON_KEY!) : null;

const DEMO_KEY = "harbor-demo-v1";
const SESSION_KEY = "harbor-session";
export { DEMO_PASSWORD };
let demo: Promise<MemoryApp> | null = null;

function safeGet(k: string) { try { return localStorage.getItem(k); } catch { return null; } }
function safeSet(k: string, v: string | null) { try { if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch { /* ignore */ } }

async function demoApp(): Promise<MemoryApp> {
  if (!demo) {
    demo = (async () => {
      const saved = safeGet(DEMO_KEY);
      if (saved) {
        const data = JSON.parse(saved);
        const app = createMemoryApp(new Date(Date.now() + (data.offsetMs ?? 0)));
        app.store.load(data.store);
        app.clock.offsetMs = data.offsetMs ?? 0;
        return app;
      }
      const app = createMemoryApp(new Date(Date.now() - 7 * 86_400_000));
      await seedDemo(app);
      return app;
    })();
  }
  return demo;
}

async function persist(app: MemoryApp) {
  safeSet(DEMO_KEY, JSON.stringify({ store: app.store.toJSON(), offsetMs: app.clock.offsetMs }));
}

export async function resetDemo() {
  safeSet(DEMO_KEY, null);
  demo = null;
  await demoApp().then(persist);
}

export async function advanceDemoClock(hours: number) {
  const app = await demoApp();
  app.clock.advanceHours(hours);
  await persist(app);
  return app.clock.now().toISOString();
}

export function getSession(): Session | null {
  const s = safeGet(SESSION_KEY);
  return s ? JSON.parse(s) : null;
}

export async function signIn(email: string, password: string): Promise<Session> {
  if (supabase) {
    const { data, error } = await supabase.auth.signInWithPassword({ email, password });
    if (error || !data.user) throw new Error(error?.message ?? "sign in failed");
    const me = await call("GET", "/me");
    const s = { userId: data.user.id, email, role: me.data?.profile?.role ?? "customer" };
    safeSet(SESSION_KEY, JSON.stringify(s));
    return s;
  }
  const u = DEMO_USERS.find((x) => x.email === email.toLowerCase().trim());
  if (!u || password !== DEMO_PASSWORD) throw new Error("Invalid email or password");
  const s = { userId: u.id, email: u.email, role: u.role };
  safeSet(SESSION_KEY, JSON.stringify(s));
  return s;
}

export async function signOut() {
  if (supabase) await supabase.auth.signOut();
  safeSet(SESSION_KEY, null);
}

export function newIdempotencyKey() {
  return crypto.randomUUID();
}

export async function call<T = any>(method: "GET" | "POST", path: string, body?: unknown, idempotencyKey?: string): Promise<ApiResult<T>> {
  if (supabase) {
    const { data } = await supabase.auth.getSession();
    const res = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/api${path}`, {
      method,
      headers: {
        "Content-Type": "application/json",
        ...(data.session ? { Authorization: `Bearer ${data.session.access_token}` } : {}),
        ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
      },
      body: method === "GET" ? undefined : JSON.stringify(body ?? {}),
    });
    const json = await res.json();
    return { ok: res.ok, status: res.status, data: json, error: json?.error };
  }
  const app = await demoApp();
  const s = getSession();
  const res = await app.call(s ? { userId: s.userId, role: s.role } : null, method, path, body ?? {}, { idempotencyKey });
  if (method !== "GET") await persist(app);
  const b = res.body as any;
  return { ok: res.status < 400, status: res.status, data: b, error: b?.error };
}
