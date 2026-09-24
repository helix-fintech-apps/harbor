import { useCallback, useEffect, useState, type ReactNode } from "react";
import { formatCents } from "@domain";
import { call, type ApiResult } from "../api";

export function Money({ cents, testId, className }: { cents: number; testId?: string; className?: string }) {
  return <span data-testid={testId} data-cents={cents} className={`${cents < 0 ? "text-red-600" : ""} ${className ?? ""}`}>{formatCents(cents)}</span>;
}

/** Parse a dollar string like "12.34" into integer cents without floats. */
export function dollarsToCents(v: string): number {
  const m = v.trim().replace(/[$,]/g, "").match(/^(\d+)(?:\.(\d{0,2}))?$/);
  if (!m) return NaN;
  return Number(m[1]) * 100 + Number((m[2] ?? "").padEnd(2, "0"));
}

export function Result({ r, testId = "result" }: { r: ApiResult | null; testId?: string }) {
  if (!r) return null;
  if (!r.ok) return <p data-testid={`${testId}-error`} data-code={r.error?.code} className="mt-2 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{r.error?.code}: {r.error?.message}</p>;
  return <p data-testid={`${testId}-ok`} className="mt-2 rounded-lg bg-green-50 px-3 py-2 text-sm text-green-700">Done. {summarize(r.data)}</p>;
}

function summarize(d: any): string {
  if (!d || typeof d !== "object") return "";
  const bits: string[] = [];
  if (d.status) bits.push(`Status: ${d.status}`);
  if (typeof d.feeCents === "number") bits.push(`Fee: ${formatCents(d.feeCents)}`);
  if (d.settleAt) bits.push(`Available after ${new Date(d.settleAt).toLocaleString()}`);
  if (d.approved === false) bits.push(`Declined: ${d.reason}`);
  if (d.approved === true) bits.push(`Approved, hold ${formatCents(d.holdCents)}`);
  if (d.state) bits.push(`KYC: ${d.state} (${d.reason})`);
  if (typeof d.payoutCents === "number") bits.push(`Payout: ${formatCents(d.payoutCents)}`);
  return bits.join(" · ");
}

export function Section({ title, children, testId, right }: { title: string; children: ReactNode; testId?: string; right?: ReactNode }) {
  return (
    <section className="card" data-testid={testId}>
      <div className="mb-3 flex items-center justify-between"><h2 className="h2">{title}</h2>{right}</div>
      {children}
    </section>
  );
}

export function useApi<T = any>(path: string | null) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reload = useCallback(async () => {
    if (!path) return;
    const r = await call<T>("GET", path);
    if (r.ok) { setData(r.data); setError(null); } else setError(r.error?.message ?? "error");
  }, [path]);
  useEffect(() => { void reload(); }, [reload]);
  return { data, error, reload };
}

export function Badge({ children, tone = "slate", testId }: { children: ReactNode; tone?: "slate" | "green" | "amber" | "red" | "blue"; testId?: string }) {
  const tones = { slate: "bg-slate-100 text-slate-700", green: "bg-green-100 text-green-800", amber: "bg-amber-100 text-amber-800", red: "bg-red-100 text-red-700", blue: "bg-harbor-100 text-harbor-700" };
  return <span data-testid={testId} className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${tones[tone]}`}>{children}</span>;
}

export function kycTone(s: string) {
  return s === "approved" ? "green" : s === "rejected" || s === "frozen_legal" ? "red" : s === "needs_review" || s === "suspended" ? "amber" : "slate";
}
