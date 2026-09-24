import { formatBps, formatCents } from "@domain";
import { Section, useApi } from "../components/ui";

/** Published terms: rendered from the active fee schedule + money policy (Helix reads this page). */
export default function Fees() {
  const { data } = useApi<any>("/fees");
  if (!data) return <p className="muted">Loading…</p>;
  const { fees: f, policy: p } = data;
  const rows: [string, string, string][] = [
    [
      "Standard transfer to your bank (ACH)",
      f.standardAchCents === 0 ? "Free" : formatCents(f.standardAchCents),
      "fee-standard-ach",
    ],
    [
      "Instant transfer to your bank",
      `${formatBps(f.instantTransferBps)} (min ${formatCents(f.instantTransferMinCents)}, max ${formatCents(f.instantTransferMaxCents)})`,
      "fee-instant",
    ],
    ["Send to a Harbor member", f.p2pCents === 0 ? "Free" : formatCents(f.p2pCents), "fee-p2p"],
    ["Out-of-network ATM withdrawal", formatCents(f.atmOutOfNetworkCents), "fee-atm"],
    [
      "Foreign transaction",
      `${formatBps(f.foreignTransactionBps)} of the purchase (not refunded if the merchant refunds)`,
      "fee-foreign",
    ],
    [
      "Card replacement",
      f.cardReplacementCents === 0 ? "Free" : formatCents(f.cardReplacementCents),
      "fee-card-replacement",
    ],
    ["Monthly fee / minimum balance", "None", "fee-monthly"],
  ];
  return (
    <div
      className="space-y-5"
      data-testid="published-terms"
      data-fee-version={f.version}
      data-policy-version={p.version}
    >
      <h1 className="h1">Fees &amp; account terms</h1>
      <p className="muted">
        Fee schedule version {f.version} · Account policy version {p.version}. Changes apply only to
        transactions started after they take effect.
      </p>
      <Section title="Fee schedule" testId="fee-schedule">
        <table className="table">
          <tbody>
            {rows.map(([k, v, id]) => (
              <tr key={id}>
                <td>{k}</td>
                <td className="font-medium" data-testid={id}>
                  {v}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Section>
      <Section title="Limits" testId="terms-limits">
        <table className="table">
          <thead>
            <tr>
              <th />
              <th>Tier 1</th>
              <th>Tier 2</th>
            </tr>
          </thead>
          <tbody>
            {(
              [
                ["Transfers out per day", "dailyTransferOutCents"],
                ["Transfers out per month", "monthlyTransferOutCents"],
                ["Card spend per day", "dailyCardSpendCents"],
                ["Card spend per month", "monthlyCardSpendCents"],
                ["Bank deposits per day", "dailyAchInCents"],
              ] as const
            ).map(([label, k]) => (
              <tr key={k}>
                <td>{label}</td>
                <td data-testid={`limit-tier1-${k}`}>{formatCents(p.tiers.tier1[k])}</td>
                <td data-testid={`limit-tier2-${k}`}>{formatCents(p.tiers.tier2[k])}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="muted mt-2">
          Limits reset at 00:00 UTC (daily) and on the 1st of the month UTC (monthly). Transfers out
          include bank withdrawals and payments to Harbor members.
        </p>
      </Section>
      <Section title="Funds availability" testId="terms-availability">
        <ul className="list-disc space-y-1 pl-5 text-sm">
          <li data-testid="term-ach-hold">
            Bank deposits (ACH) show in your posted balance right away and become available after{" "}
            {p.achIn.holdBusinessDays} business days.
          </li>
          <li data-testid="term-ach-returns">
            If a deposit is returned by your bank (e.g. R01 insufficient funds, R10 unauthorized),
            we reverse it, even if that makes your balance negative.
          </li>
          <li data-testid="term-cooling-off">
            For your security, you can withdraw to a newly linked bank {p.achOut.coolingOffHours}{" "}
            hours after linking it. The bank account owner's name must match yours.
          </li>
          <li data-testid="term-new-payee">
            The first payment to a new Harbor member requires a verification code.
          </li>
        </ul>
      </Section>
      <Section title="Debit cards" testId="terms-cards">
        <ul className="list-disc space-y-1 pl-5 text-sm">
          <li data-testid="term-auth-expiry">
            Card holds reduce your available balance. A hold not settled by the merchant within{" "}
            {p.cards.authValidityDays} days is released.
          </li>
          <li data-testid="term-tips">
            Restaurants may settle up to {formatBps(p.cards.overCaptureToleranceBps.restaurant)}{" "}
            above the authorized amount (tips). Fuel pumps may settle up to{" "}
            {formatCents(p.cards.fuelMaxCaptureCents)}.
          </li>
          <li data-testid="term-velocity">
            For fraud protection, more than {p.cards.velocity.maxAuths} card attempts within{" "}
            {p.cards.velocity.windowMinutes} minutes are declined.
          </li>
          <li data-testid="term-family">
            Teen cards require the account owner's approval, spend only from the allowance you fund,
            and block gambling, alcohol, tobacco and adult merchants.
          </li>
        </ul>
      </Section>
      <Section title="Disputes (errors and unauthorized transactions)" testId="terms-disputes">
        <ul className="list-disc space-y-1 pl-5 text-sm">
          <li data-testid="term-dispute-window">
            Tell us within {p.disputes.windowDays} days of the transaction posting.
          </li>
          <li data-testid="term-provisional">
            If we need more time, we give you provisional credit within{" "}
            {p.disputes.provisionalCreditBusinessDays} business days.
          </li>
          <li data-testid="term-resolution">
            We decide within {p.disputes.resolutionDays} days ({p.disputes.newAccountResolutionDays}{" "}
            days for accounts open less than {p.disputes.newAccountDays} days). If we find no error,
            we reverse the provisional credit.
          </li>
        </ul>
      </Section>
      <Section title="Savings interest" testId="terms-interest">
        <p className="text-sm" data-testid="term-apy">
          APY: <b>{formatBps(p.interest.savingsApyBps)}</b>.
        </p>
        <p className="muted mt-1" data-testid="term-rounding">
          Interest accrues daily on the end-of-day posted savings balance at APY ÷{" "}
          {p.interest.dayCountBasis}, calculated in millionths of a cent and truncated each day. On
          the last day of the month we pay the month's accrued interest rounded to the nearest cent
          (exact halves round to the even cent); any fraction carries into next month.
        </p>
      </Section>
      <Section title="Closing your account" testId="terms-closure">
        <p className="text-sm" data-testid="term-closure">
          You can close your account any time when you have no pending holds, no open disputes and a
          non-negative balance. We cancel your cards and send the remaining balance to your linked
          bank. Accounts under a legal or sanctions hold can't be paid out.
        </p>
      </Section>
    </div>
  );
}
