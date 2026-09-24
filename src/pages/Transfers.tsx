import { useEffect, useState } from "react";
import { call, newIdempotencyKey, type ApiResult } from "../api";
import { Money, Result, Section, dollarsToCents, useApi } from "../components/ui";
import { DEFAULT_FEES, transferFee } from "@domain";

/** One idempotency key per intended transfer: stays the same across retries/double clicks, renews when inputs change. */
function useIdemKey(deps: unknown[]) {
  const [key, setKey] = useState(newIdempotencyKey());
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => setKey(newIdempotencyKey()), deps);
  return key;
}

export default function Transfers() {
  const { data: me, reload } = useApi<any>("/me");
  const { data: terms } = useApi<any>("/fees");
  const [inBank, setInBank] = useState(""); const [inAmt, setInAmt] = useState(""); const [inRes, setInRes] = useState<ApiResult | null>(null);
  const [outBank, setOutBank] = useState(""); const [outAmt, setOutAmt] = useState(""); const [speed, setSpeed] = useState<"standard" | "instant">("standard"); const [outRes, setOutRes] = useState<ApiResult | null>(null);
  const [to, setTo] = useState(""); const [p2pAmt, setP2pAmt] = useState(""); const [code, setCode] = useState(""); const [needCode, setNeedCode] = useState(false); const [p2pRes, setP2pRes] = useState<ApiResult | null>(null);
  const inKey = useIdemKey([inBank, inAmt]);
  const outKey = useIdemKey([outBank, outAmt, speed]);
  const p2pKey = useIdemKey([to, p2pAmt, code]);
  if (!me) return <p className="muted">Loading…</p>;
  const banks = me.banks as any[];
  const fees = terms?.fees ?? DEFAULT_FEES;
  const outCents = dollarsToCents(outAmt);
  const fee = Number.isFinite(outCents) && outCents > 0 ? transferFee(outCents, speed, fees) : 0;
  const chk = me.accounts.find((a: any) => a.kind === "checking");
  return (
    <div className="space-y-5">
      <h1 className="h1">Transfers</h1>
      {chk && <p className="muted">Checking available: <Money cents={chk.availableCents} testId="transfers-available" /></p>}
      <Section title="Add money (ACH from linked bank)" testId="ach-in">
        <div className="flex flex-wrap items-end gap-2">
          <select className="input w-72" value={inBank} onChange={(e) => setInBank(e.target.value)} data-testid="ach-in-bank">
            <option value="">Select bank…</option>{banks.map((b) => <option key={b.id} value={b.id}>{b.institution} ••••{b.mask}</option>)}
          </select>
          <input className="input w-40" placeholder="0.00" value={inAmt} onChange={(e) => setInAmt(e.target.value)} data-testid="ach-in-amount" />
          <button className="btn" data-testid="ach-in-submit" onClick={async () => { setInRes(await call("POST", "/transfers/ach-in", { bankId: inBank, amountCents: dollarsToCents(inAmt) }, inKey)); reload(); }}>Add money</button>
        </div>
        <p className="muted mt-2">Deposits post right away but stay on hold for {terms?.policy.achIn.holdBusinessDays ?? 3} business days until the transfer settles.</p>
        <Result r={inRes} testId="ach-in" />
      </Section>
      <Section title="Withdraw to linked bank" testId="ach-out">
        <div className="flex flex-wrap items-end gap-2">
          <select className="input w-72" value={outBank} onChange={(e) => setOutBank(e.target.value)} data-testid="ach-out-bank">
            <option value="">Select bank…</option>{banks.map((b) => <option key={b.id} value={b.id}>{b.institution} ••••{b.mask}</option>)}
          </select>
          <input className="input w-40" placeholder="0.00" value={outAmt} onChange={(e) => setOutAmt(e.target.value)} data-testid="ach-out-amount" />
          <label className="flex items-center gap-1 text-sm"><input type="radio" checked={speed === "standard"} onChange={() => setSpeed("standard")} data-testid="speed-standard" /> Standard (1–3 days, free)</label>
          <label className="flex items-center gap-1 text-sm"><input type="radio" checked={speed === "instant"} onChange={() => setSpeed("instant")} data-testid="speed-instant" /> Instant</label>
          <button className="btn" data-testid="ach-out-submit" onClick={async () => { setOutRes(await call("POST", "/transfers/ach-out", { bankId: outBank, amountCents: outCents, speed }, outKey)); reload(); }}>Withdraw</button>
        </div>
        <p className="mt-2 text-sm" data-testid="ach-out-fee-quote">Fee: <Money cents={fee} testId="ach-out-fee" /> · Total debit: <Money cents={(Number.isFinite(outCents) ? outCents : 0) + fee} testId="ach-out-total" /></p>
        <Result r={outRes} testId="ach-out" />
      </Section>
      <Section title="Send to a Harbor member" testId="p2p">
        <div className="flex flex-wrap items-end gap-2">
          <input className="input w-72" placeholder="their@email" value={to} onChange={(e) => setTo(e.target.value)} data-testid="p2p-recipient" />
          <input className="input w-40" placeholder="0.00" value={p2pAmt} onChange={(e) => setP2pAmt(e.target.value)} data-testid="p2p-amount" />
          {needCode && <input className="input w-40" placeholder="6-digit code" value={code} onChange={(e) => setCode(e.target.value)} data-testid="p2p-stepup-code" />}
          <button className="btn" data-testid="p2p-submit" onClick={async () => {
            const r = await call("POST", "/transfers/p2p", { recipientEmail: to, amountCents: dollarsToCents(p2pAmt), stepUpCode: code || undefined }, p2pKey);
            if (r.error?.code === "step_up_required") setNeedCode(true); else if (r.ok) { setNeedCode(false); setCode(""); }
            setP2pRes(r); reload();
          }}>Send</button>
        </div>
        {needCode && <p className="mt-2 text-sm text-amber-700" data-testid="p2p-stepup-prompt">New recipient: enter the verification code we sent you (demo: 000000).</p>}
        <Result r={p2pRes} testId="p2p" />
      </Section>
    </div>
  );
}
