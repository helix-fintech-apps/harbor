import { useState } from "react";
import { call, type ApiResult } from "../api";
import { Result, Section, useApi } from "../components/ui";

export default function Settings() {
  const { data: me, reload } = useApi<any>("/me");
  const [confirm, setConfirm] = useState(false);
  const [bankId, setBankId] = useState("");
  const [res, setRes] = useState<ApiResult | null>(null);
  if (!me) return <p className="muted">Loading…</p>;
  return (
    <div className="space-y-5">
      <h1 className="h1">Settings</h1>
      <Section title="Close account" testId="close-account">
        <p className="muted mb-2">
          Your cards will be canceled and your remaining balance sent to the linked bank.
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <select
            className="input w-72"
            value={bankId}
            onChange={(e) => setBankId(e.target.value)}
            data-testid="close-bank"
          >
            <option value="">Payout bank…</option>
            {me.banks.map((b: any) => (
              <option key={b.id} value={b.id}>
                {b.institution} ••••{b.mask}
              </option>
            ))}
          </select>
          {!confirm ? (
            <button
              className="btn-danger"
              onClick={() => setConfirm(true)}
              data-testid="close-start"
            >
              Close my account
            </button>
          ) : (
            <button
              className="btn-danger"
              data-testid="close-confirm"
              onClick={async () => {
                setRes(await call("POST", "/accounts/close", { bankId: bankId || undefined }));
                setConfirm(false);
                reload();
              }}
            >
              Confirm closure
            </button>
          )}
        </div>
        <Result r={res} testId="close" />
      </Section>
    </div>
  );
}
