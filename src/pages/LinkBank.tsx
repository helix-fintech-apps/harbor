import { useState } from "react";
import { call, MODE, type ApiResult } from "../api";
import { Badge, Result, Section, useApi } from "../components/ui";

const INSTITUTIONS = ["First Platypus Bank", "Tattersall Credit Union", "Houndstooth Bank"];

export default function LinkBank() {
  const { data: me, reload } = useApi<any>("/me");
  const [open, setOpen] = useState(false);
  const [inst, setInst] = useState(INSTITUTIONS[0]);
  const [owner, setOwner] = useState("");
  const [res, setRes] = useState<ApiResult | null>(null);
  const [dd, setDd] = useState({ employerName: "", percent: "100", signatureName: "" });
  const [ddRes, setDdRes] = useState<ApiResult | null>(null);
  if (!me) return <p className="muted">Loading…</p>;
  const startLink = async () => {
    const t = await call("POST", "/banks/link-token");
    if (!t.ok) return setRes(t);
    setOwner(me.profile.legalName);
    setOpen(true);
  };
  const finish = async () => {
    // Fake Plaid Link: the public token encodes the institution and the account owner name.
    const publicToken = `public-fake-${inst.replaceAll(" ", "_")}-${owner.trim().replaceAll(" ", "_")}`;
    setRes(await call("POST", "/banks/exchange", { publicToken }));
    setOpen(false);
    reload();
  };
  return (
    <div className="space-y-5">
      <h1 className="h1">Linked banks</h1>
      <Section title="Your banks" testId="banks" right={<button className="btn" onClick={startLink} data-testid="link-bank-start">Link a bank</button>}>
        <table className="table">
          <thead><tr><th>Institution</th><th>Account</th><th>Owner</th><th>Name match</th><th>Withdrawals from</th><th /></tr></thead>
          <tbody>
            {me.banks.map((b: any) => (
              <tr key={b.id} data-testid="bank-row">
                <td>{b.institution}</td><td>••••{b.mask}</td><td>{b.ownerNames.join(", ")}</td>
                <td><Badge tone={b.nameMatched ? "green" : "red"} testId="bank-name-match">{b.nameMatched ? "matched" : "mismatch"}</Badge></td>
                <td data-testid="bank-cooling-off">{new Date(b.coolingOffUntil).toLocaleString()}</td>
                <td><button className="btn-danger" data-testid="bank-remove" onClick={async () => { await call("POST", `/banks/${b.id}/remove`); reload(); }}>Remove</button></td>
              </tr>
            ))}
          </tbody>
        </table>
        <Result r={res} testId="link" />
        {open && (
          <div className="mt-4 rounded-xl border border-harbor-100 bg-harbor-50 p-4" data-testid="plaid-modal">
            <p className="mb-2 text-sm font-medium">{MODE === "demo" ? "Plaid (fake) — select your bank" : "Plaid sandbox"}</p>
            <div className="grid gap-2 md:grid-cols-3">
              <div><label className="label">Institution</label>
                <select className="input" value={inst} onChange={(e) => setInst(e.target.value)} data-testid="plaid-institution">{INSTITUTIONS.map((i) => <option key={i}>{i}</option>)}</select></div>
              <div><label className="label">Account owner name (as the bank reports it)</label>
                <input className="input" value={owner} onChange={(e) => setOwner(e.target.value)} data-testid="plaid-owner" /></div>
              <div className="flex items-end gap-2"><button className="btn" onClick={finish} data-testid="plaid-continue">Continue</button><button className="btn-outline" onClick={() => setOpen(false)}>Cancel</button></div>
            </div>
          </div>
        )}
      </Section>
      <Section title="Switch your direct deposit" testId="direct-deposit">
        <p className="muted mb-3">We'll record your switch form. Give it to your employer; Harbor does not contact employers.</p>
        <div className="grid gap-2 md:grid-cols-4">
          <input className="input" placeholder="Employer" value={dd.employerName} onChange={(e) => setDd({ ...dd, employerName: e.target.value })} data-testid="dd-employer" />
          <input className="input" placeholder="Percent of paycheck" value={dd.percent} onChange={(e) => setDd({ ...dd, percent: e.target.value })} data-testid="dd-percent" />
          <input className="input" placeholder="Signature (legal name)" value={dd.signatureName} onChange={(e) => setDd({ ...dd, signatureName: e.target.value })} data-testid="dd-signature" />
          <button className="btn" data-testid="dd-submit" onClick={async () => setDdRes(await call("POST", "/direct-deposit", { employerName: dd.employerName, allocation: { kind: "percent", percent: Number(dd.percent) }, signatureName: dd.signatureName }))}>Save form</button>
        </div>
        <Result r={ddRes} testId="dd" />
      </Section>
    </div>
  );
}
