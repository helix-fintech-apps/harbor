import { useState } from "react";
import { Link } from "react-router-dom";
import { call, newIdempotencyKey, type ApiResult } from "../api";
import { Badge, Money, Result, Section, dollarsToCents, kycTone, useApi } from "../components/ui";

export default function Accounts() {
  const { data: me, reload } = useApi<any>("/me");
  const [kycRes, setKycRes] = useState<ApiResult | null>(null);
  const [moveRes, setMoveRes] = useState<ApiResult | null>(null);
  const [amount, setAmount] = useState("");
  const [dir, setDir] = useState<"checking-savings" | "savings-checking">("checking-savings");
  if (!me) return <p className="muted">Loading…</p>;
  const p = me.profile;
  const move = async () => {
    const [from, to] = dir.split("-");
    setMoveRes(await call("POST", "/transfers/pocket", { from, to, amountCents: dollarsToCents(amount) }, newIdempotencyKey()));
    reload();
  };
  return (
    <div className="space-y-5">
      <div className="flex items-center gap-3">
        <h1 className="h1">Hi, {p.legalName.split(" ")[0]}</h1>
        <Badge tone={kycTone(p.kycState)} testId="kyc-state">{p.kycState.replace("_", " ")}</Badge>
        <Badge tone="blue" testId="tier">{p.tier}</Badge>
      </div>
      {p.kycState !== "approved" && (
        <Section title="Verify your identity" testId="kyc-panel">
          <p className="muted mb-3">
            {p.kycState === "unverified" && "We need to verify your identity before you can move money."}
            {p.kycState === "pending" && "Your verification is still processing. You can check again."}
            {p.kycState === "needs_review" && "Your application is being reviewed by our team."}
            {p.kycState === "rejected" && "We couldn't verify your identity."}
            {(p.kycState === "suspended" || p.kycState === "frozen_legal") && "Your account is restricted. Contact support."}
          </p>
          {(p.kycState === "unverified" || p.kycState === "pending") && (
            <button className="btn" data-testid="kyc-start" onClick={async () => { setKycRes(await call("POST", "/kyc/start")); reload(); }}>
              {p.kycState === "unverified" ? "Start verification" : "Check again"}
            </button>
          )}
          <Result r={kycRes} testId="kyc" />
        </Section>
      )}
      <div className="grid gap-4 md:grid-cols-2">
        {me.accounts.map((a: any) => (
          <div key={a.id} className="card" data-testid={`account-${a.kind}`}>
            <div className="flex items-center justify-between">
              <h2 className="h2 capitalize">{a.kind}</h2>
              <Badge tone={a.status === "open" ? "green" : "red"} testId={`account-${a.kind}-status`}>{a.status}</Badge>
            </div>
            <p className="muted">Acct {a.accountNumber} · Routing {a.routingNumber}</p>
            <div className="mt-3 grid grid-cols-3 gap-2">
              <div><p className="label">Available</p><Money cents={a.availableCents} testId={`${a.kind}-available`} className="text-2xl font-semibold" /></div>
              <div><p className="label">Posted</p><Money cents={a.postedCents} testId={`${a.kind}-posted`} className="text-lg" /></div>
              <div><p className="label">On hold</p><Money cents={a.holdsCents} testId={`${a.kind}-holds`} className="text-lg text-slate-500" /></div>
            </div>
          </div>
        ))}
        {me.accounts.length === 0 && <p className="muted" data-testid="no-accounts">Accounts open once your identity is verified.</p>}
      </div>
      {me.accounts.length > 0 && (
        <Section title="Move between pockets" testId="pocket-move">
          <div className="flex flex-wrap items-end gap-2">
            <select className="input w-56" value={dir} onChange={(e) => setDir(e.target.value as any)} data-testid="pocket-direction">
              <option value="checking-savings">Checking → Savings</option>
              <option value="savings-checking">Savings → Checking</option>
            </select>
            <input className="input w-40" placeholder="0.00" value={amount} onChange={(e) => setAmount(e.target.value)} data-testid="pocket-amount" />
            <button className="btn" onClick={move} data-testid="pocket-submit">Move</button>
          </div>
          <Result r={moveRes} testId="pocket" />
        </Section>
      )}
      <Section title="Limits" testId="limits">
        <p className="muted">Daily transfers out <Money cents={me.limits.dailyTransferOutCents} /> · Monthly <Money cents={me.limits.monthlyTransferOutCents} /> · Daily card spend <Money cents={me.limits.dailyCardSpendCents} /> · Monthly card spend <Money cents={me.limits.monthlyCardSpendCents} /></p>
      </Section>
      <Section title="Recent activity" testId="activity" right={<Link to="/statements" className="text-sm text-harbor-700">Statements →</Link>}>
        <table className="table">
          <thead><tr><th>Date</th><th>Type</th><th>Status</th><th className="text-right">Amount</th><th className="text-right">Fee</th></tr></thead>
          <tbody>
            {me.transfers.map((t: any) => (
              <tr key={t.id} data-testid="activity-row">
                <td>{new Date(t.created_at).toLocaleDateString()}</td>
                <td>{t.kind}{t.speed ? ` (${t.speed})` : ""}{t.counterparty_user_id === p.id ? " received" : ""}</td>
                <td><Badge tone={t.status === "returned" ? "red" : t.status === "pending" ? "amber" : "green"}>{t.status}{t.return_code ? ` ${t.return_code}` : ""}</Badge></td>
                <td className="text-right"><Money cents={t.amount_cents} /></td>
                <td className="text-right"><Money cents={t.fee_cents} /></td>
              </tr>
            ))}
            {me.authorizations.map((a: any) => (
              <tr key={a.id} data-testid="card-activity-row">
                <td>{new Date(a.created_at).toLocaleDateString()}</td>
                <td>Card · {a.merchant} ({a.mcc})</td>
                <td><Badge tone={a.status === "declined" ? "red" : a.status === "authorized" ? "amber" : "green"}>{a.status}{a.decline_reason ? `: ${a.decline_reason}` : ""}</Badge></td>
                <td className="text-right"><Money cents={a.status === "captured" ? a.captured_cents : a.amount_cents} /></td>
                <td className="text-right"><Money cents={a.fee_cents} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </Section>
    </div>
  );
}
