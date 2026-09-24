import { useState } from "react";
import { call, type ApiResult } from "../api";
import { formatCents } from "@domain";
import { Badge, Money, Result, Section, dollarsToCents, useApi } from "../components/ui";

export default function Disputes() {
  const { data: me, reload } = useApi<any>("/me");
  const [form, setForm] = useState({ authId: "", amount: "", reason: "" });
  const [res, setRes] = useState<ApiResult | null>(null);
  if (!me) return <p className="muted">Loading…</p>;
  const posted = me.authorizations.filter((a: any) => a.status === "captured");
  return (
    <div className="space-y-5">
      <h1 className="h1">Disputes</h1>
      <Section title="Dispute a card transaction" testId="dispute-form">
        <div className="grid gap-2 md:grid-cols-4">
          <select className="input" value={form.authId} onChange={(e) => setForm({ ...form, authId: e.target.value })} data-testid="dispute-auth">
            <option value="">Transaction…</option>
            {posted.map((a: any) => <option key={a.id} value={a.id}>{a.merchant} — {formatCents(a.captured_cents - a.refunded_cents)}</option>)}
          </select>
          <input className="input" placeholder="Amount $" value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} data-testid="dispute-amount" />
          <input className="input" placeholder="What went wrong?" value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })} data-testid="dispute-reason" />
          <button className="btn" data-testid="dispute-submit" onClick={async () => { setRes(await call("POST", "/disputes", { authorizationId: form.authId, amountCents: dollarsToCents(form.amount), reason: form.reason })); reload(); }}>Submit dispute</button>
        </div>
        <Result r={res} testId="dispute" />
      </Section>
      <Section title="Your disputes" testId="dispute-list">
        <table className="table">
          <thead><tr><th>Opened</th><th>Amount</th><th>Status</th><th>Provisional credit</th><th>Credit due by</th><th>Decision due by</th></tr></thead>
          <tbody>
            {me.disputes.map((d: any) => (
              <tr key={d.id} data-testid="dispute-row">
                <td>{new Date(d.opened_at).toLocaleDateString()}</td>
                <td><Money cents={d.amount_cents} /></td>
                <td><Badge tone={d.status === "won" ? "green" : d.status === "lost" ? "red" : "amber"} testId="dispute-status">{d.status.replace("_", " ")}</Badge></td>
                <td><Money cents={d.provisional_credit_cents} testId="dispute-provisional" /></td>
                <td>{new Date(d.provisional_credit_due_at).toLocaleDateString()}</td>
                <td>{new Date(d.resolution_due_at).toLocaleDateString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Section>
    </div>
  );
}
