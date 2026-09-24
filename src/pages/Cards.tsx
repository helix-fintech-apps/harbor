import { useState } from "react";
import { call, type ApiResult } from "../api";
import { Badge, Money, Result, Section, dollarsToCents, useApi } from "../components/ui";
import { MCC_GROUPS, formatCents } from "@domain";

const blankLimits = { perTxn: "50.00", daily: "100.00", monthly: "400.00" };

export default function Cards() {
  const { data: me, reload } = useApi<any>("/me");
  const [res, setRes] = useState<ApiResult | null>(null);
  const [sim, setSim] = useState({
    cardId: "",
    amount: "",
    mcc: "5411",
    merchant: "Corner Grocer",
    foreign: false,
  });
  const [simRes, setSimRes] = useState<ApiResult | null>(null);
  const [capture, setCapture] = useState({ authId: "", amount: "" });
  const [fm, setFm] = useState({ name: "", kind: "teen", ...blankLimits, blocks: [] as string[] });
  const [famRes, setFamRes] = useState<ApiResult | null>(null);
  const [topUp, setTopUp] = useState<Record<string, string>>({});
  if (!me) return <p className="muted">Loading…</p>;
  const act = async (path: string, body?: unknown) => {
    setRes(await call("POST", path, body));
    reload();
  };
  const members = Object.fromEntries(me.family.map((m: any) => [m.id, m]));
  return (
    <div className="space-y-5">
      <h1 className="h1">Cards</h1>
      <Section
        title="Your cards"
        testId="cards"
        right={
          <div className="flex gap-2">
            <button
              className="btn"
              data-testid="issue-virtual"
              onClick={() => act("/cards", { kind: "virtual" })}
            >
              New virtual card
            </button>
            <button
              className="btn-outline"
              data-testid="issue-physical"
              onClick={() => act("/cards", { kind: "physical" })}
            >
              Request physical card
            </button>
          </div>
        }
      >
        <table className="table">
          <thead>
            <tr>
              <th>Card</th>
              <th>Type</th>
              <th>Holder</th>
              <th>Status</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {me.cards.map((c: any) => (
              <tr key={c.id} data-testid="card-row" data-card-id={c.id}>
                <td className="font-mono">•••• {c.last4}</td>
                <td>{c.kind}</td>
                <td>
                  {c.family_member_id
                    ? `${members[c.family_member_id]?.name ?? "family"} (${members[c.family_member_id]?.kind ?? ""})`
                    : "You"}
                </td>
                <td>
                  <Badge
                    tone={
                      c.status === "active"
                        ? "green"
                        : c.status === "frozen" || c.status === "requested"
                          ? "amber"
                          : "red"
                    }
                    testId="card-status"
                  >
                    {c.status}
                  </Badge>
                </td>
                <td className="space-x-1">
                  {c.status === "active" && (
                    <button
                      className="btn-outline"
                      data-testid="card-freeze"
                      onClick={() => act(`/cards/${c.id}/freeze`)}
                    >
                      Freeze
                    </button>
                  )}
                  {c.status === "frozen" && (
                    <button
                      className="btn-outline"
                      data-testid="card-unfreeze"
                      onClick={() => act(`/cards/${c.id}/unfreeze`)}
                    >
                      Unfreeze
                    </button>
                  )}
                  {c.status === "requested" && (
                    <button
                      className="btn-outline"
                      data-testid="card-activate"
                      onClick={() => act(`/cards/${c.id}/activate`)}
                    >
                      Activate
                    </button>
                  )}
                  {(c.status === "active" || c.status === "frozen") && (
                    <button
                      className="btn-outline"
                      data-testid="card-replace"
                      onClick={() => act(`/cards/${c.id}/replace`)}
                    >
                      Replace
                    </button>
                  )}
                  {c.status !== "canceled" && c.status !== "replaced" && (
                    <button
                      className="btn-danger"
                      data-testid="card-cancel"
                      onClick={() => act(`/cards/${c.id}/cancel`)}
                    >
                      Cancel
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <Result r={res} testId="card-action" />
      </Section>

      <Section title="Family members" testId="family">
        <div className="grid gap-2 md:grid-cols-6">
          <input
            className="input"
            placeholder="Name"
            value={fm.name}
            onChange={(e) => setFm({ ...fm, name: e.target.value })}
            data-testid="family-name"
          />
          <select
            className="input"
            value={fm.kind}
            onChange={(e) => setFm({ ...fm, kind: e.target.value })}
            data-testid="family-kind"
          >
            <option value="teen">Teen</option>
            <option value="spouse">Spouse</option>
          </select>
          <input
            className="input"
            placeholder="Per txn $"
            value={fm.perTxn}
            onChange={(e) => setFm({ ...fm, perTxn: e.target.value })}
            data-testid="family-per-txn"
          />
          <input
            className="input"
            placeholder="Daily $"
            value={fm.daily}
            onChange={(e) => setFm({ ...fm, daily: e.target.value })}
            data-testid="family-daily"
          />
          <input
            className="input"
            placeholder="Monthly $"
            value={fm.monthly}
            onChange={(e) => setFm({ ...fm, monthly: e.target.value })}
            data-testid="family-monthly"
          />
          <button
            className="btn"
            data-testid="family-add"
            onClick={async () => {
              setFamRes(
                await call("POST", "/family", {
                  name: fm.name,
                  kind: fm.kind,
                  blockedMccGroups: fm.blocks,
                  limits: {
                    perTxnCents: dollarsToCents(fm.perTxn),
                    dailyCents: dollarsToCents(fm.daily),
                    monthlyCents: dollarsToCents(fm.monthly),
                  },
                }),
              );
              reload();
            }}
          >
            Add member
          </button>
        </div>
        <div className="mt-2 flex flex-wrap gap-3 text-sm" data-testid="family-blocks">
          {Object.keys(MCC_GROUPS).map((g) => (
            <label key={g} className="flex items-center gap-1">
              <input
                type="checkbox"
                checked={fm.blocks.includes(g)}
                data-testid={`family-block-${g}`}
                onChange={(e) =>
                  setFm({
                    ...fm,
                    blocks: e.target.checked ? [...fm.blocks, g] : fm.blocks.filter((x) => x !== g),
                  })
                }
              />{" "}
              Block {g}
            </label>
          ))}
        </div>
        <Result r={famRes} testId="family" />
        <table className="table mt-4">
          <thead>
            <tr>
              <th>Name</th>
              <th>Kind</th>
              <th>Status</th>
              <th>Limits (txn/day/month)</th>
              <th>Blocked</th>
              <th>Allowance</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {me.family.map((m: any) => (
              <tr key={m.id} data-testid="family-row">
                <td>{m.name}</td>
                <td>{m.kind}</td>
                <td>
                  <Badge tone={m.status === "active" ? "green" : "amber"} testId="family-status">
                    {m.status.replaceAll("_", " ")}
                  </Badge>
                </td>
                <td>
                  <Money cents={m.limits.perTxnCents} /> / <Money cents={m.limits.dailyCents} /> /{" "}
                  <Money cents={m.limits.monthlyCents} />
                </td>
                <td className="text-xs">{m.blockedMccGroups.join(", ")}</td>
                <td>
                  {m.allowance ? (
                    <Money cents={m.allowance.availableCents} testId="family-allowance" />
                  ) : (
                    "—"
                  )}
                </td>
                <td className="space-x-1 whitespace-nowrap">
                  {m.status === "pending_guardian_approval" && (
                    <button
                      className="btn"
                      data-testid="family-approve"
                      onClick={async () => {
                        setFamRes(await call("POST", `/family/${m.id}/approve`));
                        reload();
                      }}
                    >
                      Approve (guardian)
                    </button>
                  )}
                  {m.kind === "teen" && (
                    <>
                      <input
                        className="input inline w-24"
                        placeholder="$"
                        value={topUp[m.id] ?? ""}
                        onChange={(e) => setTopUp({ ...topUp, [m.id]: e.target.value })}
                        data-testid="family-topup-amount"
                      />
                      <button
                        className="btn-outline"
                        data-testid="family-topup"
                        onClick={async () => {
                          setFamRes(
                            await call("POST", `/family/${m.id}/allowance`, {
                              amountCents: dollarsToCents(topUp[m.id] ?? ""),
                            }),
                          );
                          reload();
                        }}
                      >
                        Top up
                      </button>
                    </>
                  )}
                  {!me.cards.some(
                    (c: any) =>
                      c.family_member_id === m.id &&
                      ["active", "frozen", "requested"].includes(c.status),
                  ) && (
                    <button
                      className="btn-outline"
                      data-testid="family-issue-card"
                      onClick={async () => {
                        setFamRes(
                          await call("POST", "/cards", { kind: "virtual", familyMemberId: m.id }),
                        );
                        reload();
                      }}
                    >
                      Issue card
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Section>

      <Section title="Merchant simulator (test network)" testId="card-sim">
        <p className="muted mb-2">
          Simulates a merchant authorization on the card network. Capture / refund below.
        </p>
        <div className="grid gap-2 md:grid-cols-6">
          <select
            className="input"
            value={sim.cardId}
            onChange={(e) => setSim({ ...sim, cardId: e.target.value })}
            data-testid="sim-card"
          >
            <option value="">Card…</option>
            {me.cards.map((c: any) => (
              <option key={c.id} value={c.id}>
                •••• {c.last4} ({c.status})
              </option>
            ))}
          </select>
          <input
            className="input"
            placeholder="Amount $"
            value={sim.amount}
            onChange={(e) => setSim({ ...sim, amount: e.target.value })}
            data-testid="sim-amount"
          />
          <input
            className="input"
            placeholder="MCC"
            value={sim.mcc}
            onChange={(e) => setSim({ ...sim, mcc: e.target.value })}
            data-testid="sim-mcc"
          />
          <input
            className="input"
            placeholder="Merchant"
            value={sim.merchant}
            onChange={(e) => setSim({ ...sim, merchant: e.target.value })}
            data-testid="sim-merchant"
          />
          <label className="flex items-center gap-1 text-sm">
            <input
              type="checkbox"
              checked={sim.foreign}
              onChange={(e) => setSim({ ...sim, foreign: e.target.checked })}
              data-testid="sim-foreign"
            />{" "}
            Foreign
          </label>
          <button
            className="btn"
            data-testid="sim-authorize"
            onClick={async () => {
              setSimRes(
                await call("POST", `/sim/cards/${sim.cardId}/authorize`, {
                  amountCents: dollarsToCents(sim.amount),
                  mcc: sim.mcc,
                  merchant: sim.merchant,
                  foreign: sim.foreign,
                }),
              );
              reload();
            }}
          >
            Authorize
          </button>
        </div>
        <div className="mt-3 grid gap-2 md:grid-cols-4">
          <select
            className="input"
            value={capture.authId}
            onChange={(e) => setCapture({ ...capture, authId: e.target.value })}
            data-testid="sim-auth"
          >
            <option value="">Authorization…</option>
            {me.authorizations
              .filter((a: any) => a.status === "authorized" || a.status === "captured")
              .map((a: any) => (
                <option key={a.id} value={a.id}>
                  {a.merchant}{" "}
                  {formatCents(a.status === "captured" ? a.captured_cents : a.amount_cents)} (
                  {a.status})
                </option>
              ))}
          </select>
          <input
            className="input"
            placeholder="Amount $"
            value={capture.amount}
            onChange={(e) => setCapture({ ...capture, amount: e.target.value })}
            data-testid="sim-capture-amount"
          />
          <button
            className="btn-outline"
            data-testid="sim-capture"
            onClick={async () => {
              setSimRes(
                await call("POST", `/sim/authorizations/${capture.authId}/capture`, {
                  amountCents: dollarsToCents(capture.amount),
                }),
              );
              reload();
            }}
          >
            Capture
          </button>
          <button
            className="btn-outline"
            data-testid="sim-refund"
            onClick={async () => {
              setSimRes(
                await call("POST", `/sim/authorizations/${capture.authId}/refund`, {
                  refundId: `re_${capture.authId.slice(0, 8)}_${capture.amount}`,
                  amountCents: dollarsToCents(capture.amount),
                }),
              );
              reload();
            }}
          >
            Merchant refund
          </button>
        </div>
        <Result r={simRes} testId="sim" />
      </Section>
    </div>
  );
}
