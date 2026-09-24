import { useState } from "react";
import { call } from "../api";
import { Money, Section, useApi } from "../components/ui";

export default function Statements() {
  const { data: me } = useApi<any>("/me");
  const [accountId, setAccountId] = useState("");
  const [period, setPeriod] = useState(new Date().toISOString().slice(0, 7));
  const [st, setSt] = useState<any>(null);
  const [err, setErr] = useState<string | null>(null);
  if (!me) return <p className="muted">Loading…</p>;
  const load = async () => {
    const r = await call("GET", `/statements?accountId=${accountId || me.accounts[0]?.id}&period=${period}`);
    if (r.ok) { setSt(r.data); setErr(null); } else setErr(r.error?.message ?? "error");
  };
  return (
    <div className="space-y-5">
      <h1 className="h1">Statements</h1>
      <Section title="Monthly statement" testId="statement">
        <div className="flex flex-wrap gap-2">
          <select className="input w-56" value={accountId} onChange={(e) => setAccountId(e.target.value)} data-testid="statement-account">
            {me.accounts.map((a: any) => <option key={a.id} value={a.id}>{a.kind} {a.accountNumber}</option>)}
          </select>
          <input className="input w-40" type="month" value={period} onChange={(e) => setPeriod(e.target.value)} data-testid="statement-period" />
          <button className="btn" onClick={load} data-testid="statement-load">View</button>
        </div>
        {err && <p className="mt-2 text-sm text-red-600">{err}</p>}
        {st && (
          <div className="mt-4">
            <div className="grid grid-cols-4 gap-2 text-sm">
              <div><p className="label">Opening</p><Money cents={st.openingCents} testId="statement-opening" /></div>
              <div><p className="label">Credits</p><Money cents={st.creditsCents} testId="statement-credits" /></div>
              <div><p className="label">Debits</p><Money cents={st.debitsCents} testId="statement-debits" /></div>
              <div><p className="label">Closing</p><Money cents={st.closingCents} testId="statement-closing" /></div>
            </div>
            <table className="table mt-3">
              <thead><tr><th>Date</th><th>Description</th><th className="text-right">Debit</th><th className="text-right">Credit</th><th className="text-right">Balance</th></tr></thead>
              <tbody>{st.entries.map((e: any, i: number) => (
                <tr key={i} data-testid="statement-row"><td>{new Date(e.at).toLocaleString()}</td><td>{e.kind}</td>
                  <td className="text-right">{e.debit ? <Money cents={e.debit} /> : ""}</td><td className="text-right">{e.credit ? <Money cents={e.credit} /> : ""}</td>
                  <td className="text-right"><Money cents={e.runningCents} /></td></tr>
              ))}</tbody>
            </table>
          </div>
        )}
      </Section>
    </div>
  );
}
