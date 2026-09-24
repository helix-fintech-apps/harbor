import { useState } from "react";
import { advanceDemoClock, call, MODE, type ApiResult } from "../api";
import { Badge, Money, Result, Section, kycTone, useApi } from "../components/ui";

const KYC_FILTERS = [
  "",
  "needs_review",
  "pending",
  "approved",
  "rejected",
  "suspended",
  "frozen_legal",
  "unverified",
];

export default function Admin() {
  const [filter, setFilter] = useState("");
  const users = useApi<any[]>(`/admin/users${filter ? `?kyc=${filter}` : ""}`);
  const ledger = useApi<any>("/admin/ledger?limit=50");
  const disputes = useApi<any[]>("/admin/disputes");
  const [res, setRes] = useState<ApiResult | null>(null);
  const [reason, setReason] = useState("");
  const [ret, setRet] = useState({ transferId: "", code: "R01" });
  const [clock, setClock] = useState<string | null>(null);
  const reloadAll = () => {
    users.reload();
    ledger.reload();
    disputes.reload();
  };
  const act = async (path: string, body?: unknown) => {
    setRes(await call("POST", path, body));
    reloadAll();
  };
  return (
    <div className="space-y-5">
      <h1 className="h1">Admin console</h1>
      <Result r={res} testId="admin" />
      <Section
        title="Customers & KYC review"
        testId="admin-users"
        right={
          <select
            className="input w-48"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            data-testid="admin-kyc-filter"
          >
            {KYC_FILTERS.map((k) => (
              <option key={k} value={k}>
                {k || "All"}
              </option>
            ))}
          </select>
        }
      >
        <input
          className="input mb-3"
          placeholder="Reason (required for KYC / freeze actions)"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          data-testid="admin-reason"
        />
        <table className="table">
          <thead>
            <tr>
              <th>Customer</th>
              <th>KYC</th>
              <th>Last check</th>
              <th>Tier</th>
              <th>Accounts</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {(users.data ?? []).map((u: any) => (
              <tr key={u.id} data-testid="admin-user-row" data-email={u.email}>
                <td>
                  {u.legalName}
                  <div className="text-xs text-slate-500">
                    {u.email} · {u.role}
                  </div>
                </td>
                <td>
                  <Badge tone={kycTone(u.kycState)} testId="admin-user-kyc">
                    {u.kycState}
                  </Badge>
                </td>
                <td className="text-xs">
                  {u.lastCheck
                    ? `${u.lastCheck.reason} (${u.lastCheck.identity_status ?? "manual"})`
                    : "—"}
                </td>
                <td>
                  <select
                    className="input w-24"
                    value={u.tier}
                    data-testid="admin-tier"
                    onChange={(e) => act(`/admin/users/${u.id}/tier`, { tier: e.target.value })}
                  >
                    <option>tier1</option>
                    <option>tier2</option>
                  </select>
                </td>
                <td className="text-xs">
                  {u.accounts.map((a: any) => (
                    <div key={a.id} className="flex items-center gap-1">
                      {a.kind}: <Money cents={a.postedCents} /> ({a.status})
                      {a.status === "open" && (
                        <button
                          className="text-red-600 underline"
                          data-testid="admin-freeze-account"
                          onClick={() => act(`/admin/accounts/${a.id}/freeze`, { reason })}
                        >
                          freeze
                        </button>
                      )}
                      {a.status === "frozen" && (
                        <button
                          className="text-harbor-700 underline"
                          data-testid="admin-unfreeze-account"
                          onClick={() => act(`/admin/accounts/${a.id}/unfreeze`, { reason })}
                        >
                          unfreeze
                        </button>
                      )}
                    </div>
                  ))}
                  {u.achDeposits.map((t: any) => (
                    <div
                      key={t.id}
                      className="flex items-center gap-1"
                      data-testid="admin-ach-deposit"
                    >
                      ACH in <Money cents={t.amountCents} /> ({t.status})
                      <button
                        className="text-red-600 underline"
                        data-testid="admin-ach-return-r01"
                        onClick={() => act(`/admin/transfers/${t.id}/return`, { code: "R01" })}
                      >
                        R01
                      </button>
                      <button
                        className="text-red-600 underline"
                        data-testid="admin-ach-return-r10"
                        onClick={() => act(`/admin/transfers/${t.id}/return`, { code: "R10" })}
                      >
                        R10
                      </button>
                    </div>
                  ))}
                </td>
                <td className="space-x-1 whitespace-nowrap">
                  {["approved", "rejected", "suspended", "frozen_legal"]
                    .filter(
                      (s) =>
                        s !== u.kycState &&
                        !(
                          s === "approved" &&
                          ["unverified", "pending", "rejected"].includes(u.kycState)
                        ),
                    )
                    .map((s) => (
                      <button
                        key={s}
                        className={s === "approved" ? "btn" : "btn-outline"}
                        data-testid={`admin-kyc-${s}`}
                        onClick={() => act(`/admin/users/${u.id}/kyc`, { state: s, reason })}
                      >
                        {s.replace("_", " ")}
                      </button>
                    ))}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Section>

      <Section title="Disputes" testId="admin-disputes">
        <table className="table">
          <thead>
            <tr>
              <th>Opened</th>
              <th>Amount</th>
              <th>Status</th>
              <th>Credit due</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {(disputes.data ?? []).map((d: any) => (
              <tr key={d.id} data-testid="admin-dispute-row">
                <td>{new Date(d.opened_at).toLocaleDateString()}</td>
                <td>
                  <Money cents={d.amount_cents} />
                </td>
                <td>
                  <Badge
                    tone={d.status === "won" ? "green" : d.status === "lost" ? "red" : "amber"}
                  >
                    {d.status}
                  </Badge>
                </td>
                <td>{new Date(d.provisional_credit_due_at).toLocaleDateString()}</td>
                <td className="space-x-1">
                  {d.status === "open" && (
                    <button
                      className="btn-outline"
                      data-testid="admin-dispute-credit"
                      onClick={() => act(`/admin/disputes/${d.id}/provisional-credit`)}
                    >
                      Provisional credit
                    </button>
                  )}
                  {(d.status === "open" || d.status === "provisional_credited") && (
                    <>
                      <button
                        className="btn"
                        data-testid="admin-dispute-won"
                        onClick={() => act(`/admin/disputes/${d.id}/resolve`, { outcome: "won" })}
                      >
                        Won
                      </button>
                      <button
                        className="btn-danger"
                        data-testid="admin-dispute-lost"
                        onClick={() => act(`/admin/disputes/${d.id}/resolve`, { outcome: "lost" })}
                      >
                        Lost
                      </button>
                    </>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Section>

      <Section title="ACH returns & jobs" testId="admin-jobs">
        <div className="flex flex-wrap items-end gap-2">
          <input
            className="input w-80"
            placeholder="ACH deposit transfer id"
            value={ret.transferId}
            onChange={(e) => setRet({ ...ret, transferId: e.target.value })}
            data-testid="admin-return-transfer"
          />
          <select
            className="input w-24"
            value={ret.code}
            onChange={(e) => setRet({ ...ret, code: e.target.value })}
            data-testid="admin-return-code"
          >
            <option>R01</option>
            <option>R10</option>
            <option>R02</option>
            <option>R29</option>
          </select>
          <button
            className="btn-danger"
            data-testid="admin-return-submit"
            onClick={() => act(`/admin/transfers/${ret.transferId}/return`, { code: ret.code })}
          >
            Return ACH
          </button>
        </div>
        <div className="mt-3 flex flex-wrap gap-2">
          <button
            className="btn-outline"
            data-testid="job-settle-ach"
            onClick={() => act("/admin/jobs/settle-ach")}
          >
            Settle ACH
          </button>
          <button
            className="btn-outline"
            data-testid="job-expire-auths"
            onClick={() => act("/admin/jobs/expire-auths")}
          >
            Expire card holds
          </button>
          <button
            className="btn-outline"
            data-testid="job-dispute-deadlines"
            onClick={() => act("/admin/jobs/dispute-deadlines")}
          >
            Dispute deadlines
          </button>
          <button
            className="btn-outline"
            data-testid="job-accrue-interest"
            onClick={() => act("/admin/jobs/accrue-interest", {})}
          >
            Accrue interest (today)
          </button>
          <button
            className="btn-outline"
            data-testid="job-post-interest"
            onClick={() =>
              act("/admin/jobs/post-interest", { period: new Date().toISOString().slice(0, 7) })
            }
          >
            Post interest (this month)
          </button>
          {MODE === "demo" && (
            <button
              className="btn-outline"
              data-testid="demo-advance-day"
              onClick={async () => {
                setClock(await advanceDemoClock(24));
                reloadAll();
              }}
            >
              Demo clock +1 day
            </button>
          )}
        </div>
        {clock && (
          <p className="muted mt-2" data-testid="demo-clock">
            Demo clock: {new Date(clock).toLocaleString()}
          </p>
        )}
      </Section>

      <Section
        title="Ledger"
        testId="admin-ledger"
        right={
          ledger.data && (
            <Badge
              tone={ledger.data.trialBalanceCents === 0 ? "green" : "red"}
              testId="trial-balance"
            >
              Trial balance {ledger.data.trialBalanceCents}
            </Badge>
          )
        }
      >
        <table className="table">
          <thead>
            <tr>
              <th>When</th>
              <th>Kind</th>
              <th>Ref</th>
              <th>Lines</th>
            </tr>
          </thead>
          <tbody>
            {(ledger.data?.txns ?? []).map((t: any) => (
              <tr key={t.id} data-testid="ledger-txn">
                <td className="whitespace-nowrap text-xs">{new Date(t.at).toLocaleString()}</td>
                <td>{t.kind}</td>
                <td className="font-mono text-xs">{t.ref?.slice(0, 8)}</td>
                <td className="text-xs">
                  {t.lines.map((l: any, i: number) => (
                    <div key={i}>
                      {l.debit ? "Dr" : "Cr"} {l.account}
                      {l.party ? ` [${String(l.party).slice(0, 8)}]` : ""}{" "}
                      <Money cents={l.debit || l.credit} />
                    </div>
                  ))}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Section>
    </div>
  );
}
