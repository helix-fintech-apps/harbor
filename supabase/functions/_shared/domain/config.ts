// Money policy + fee schedule. The same values are stored in `money_policies` and `fee_schedules`
// (versioned). Holds, transfers and cards snapshot the version they were created under.

export type Tier = "tier1" | "tier2";

export interface TierLimits {
  dailyTransferOutCents: number; // ACH push + instant + P2P sent, per UTC day
  monthlyTransferOutCents: number; // per UTC calendar month
  dailyCardSpendCents: number;
  monthlyCardSpendCents: number;
  dailyAchInCents: number;
}

export interface MoneyPolicy {
  version: number;
  currency: "USD";
  tiers: Record<Tier, TierLimits>;
  kyc: {
    vendorTimeoutMs: number;
    sanctionsFuzzyThresholdBps: number; // token-overlap score that counts as a potential match
  };
  achIn: {
    holdBusinessDays: number; // deposit is posted but not available until settlement
    reversingReturnCodes: string[]; // codes that reverse + claw back the credit
    nameMatchRequired: boolean;
  };
  achOut: {
    coolingOffHours: number; // no withdrawals to a bank linked less than N hours ago
  };
  p2p: {
    newPayeeStepUp: boolean; // first transfer to a new payee needs step-up (2FA) confirmation
    minCents: number;
  };
  cards: {
    authValidityDays: number; // uncaptured auth hold released after N days
    overCaptureToleranceBps: Record<string, number>; // by MCC group (restaurant tips etc.)
    fuelMaxCaptureCents: number; // fuel pumps authorize small, capture up to this
    velocity: { maxAuths: number; windowMinutes: number };
    maxActiveVirtualCards: number;
  };
  family: {
    teenRequiresGuardianApproval: boolean;
    maxMembers: number;
  };
  disputes: {
    windowDays: number; // days after posting a cardholder may dispute
    provisionalCreditBusinessDays: number;
    resolutionDays: number;
    newAccountResolutionDays: number; // extended timeline for accounts younger than newAccountDays
    newAccountDays: number;
  };
  interest: {
    savingsApyBps: number; // applied as a simple daily rate: apy / 365 (documented)
    dayCountBasis: number;
  };
  holidays: string[]; // YYYY-MM-DD, non-business days for ACH/dispute timelines
}

export interface FeeSchedule {
  version: number;
  standardAchCents: number;
  instantTransferBps: number;
  instantTransferMinCents: number;
  instantTransferMaxCents: number;
  atmOutOfNetworkCents: number;
  foreignTransactionBps: number;
  cardReplacementCents: number;
  p2pCents: number;
}

export const DEFAULT_POLICY: MoneyPolicy = {
  version: 1,
  currency: "USD",
  tiers: {
    tier1: {
      dailyTransferOutCents: 100_000, // $1,000
      monthlyTransferOutCents: 500_000, // $5,000
      dailyCardSpendCents: 200_000, // $2,000
      monthlyCardSpendCents: 1_000_000, // $10,000
      dailyAchInCents: 250_000,
    },
    tier2: {
      dailyTransferOutCents: 500_000,
      monthlyTransferOutCents: 2_500_000,
      dailyCardSpendCents: 500_000,
      monthlyCardSpendCents: 2_500_000,
      dailyAchInCents: 1_000_000,
    },
  },
  kyc: { vendorTimeoutMs: 10_000, sanctionsFuzzyThresholdBps: 8_000 },
  achIn: {
    holdBusinessDays: 3,
    reversingReturnCodes: ["R01", "R02", "R03", "R04", "R10", "R16", "R29"],
    nameMatchRequired: true,
  },
  achOut: { coolingOffHours: 72 },
  p2p: { newPayeeStepUp: true, minCents: 100 },
  cards: {
    authValidityDays: 7,
    overCaptureToleranceBps: { restaurant: 2_000, default: 0 },
    fuelMaxCaptureCents: 17_500,
    velocity: { maxAuths: 5, windowMinutes: 10 },
    maxActiveVirtualCards: 3,
  },
  family: { teenRequiresGuardianApproval: true, maxMembers: 5 },
  disputes: {
    windowDays: 60,
    provisionalCreditBusinessDays: 10,
    resolutionDays: 45,
    newAccountResolutionDays: 90,
    newAccountDays: 30,
  },
  interest: { savingsApyBps: 400, dayCountBasis: 365 },
  holidays: [
    "2026-01-01",
    "2026-05-25",
    "2026-07-03",
    "2026-09-07",
    "2026-10-12",
    "2026-11-11",
    "2026-11-26",
    "2026-12-25",
  ],
};

export const DEFAULT_FEES: FeeSchedule = {
  version: 1,
  standardAchCents: 0,
  instantTransferBps: 150, // 1.5%
  instantTransferMinCents: 25,
  instantTransferMaxCents: 1_500,
  atmOutOfNetworkCents: 250,
  foreignTransactionBps: 300, // 3%
  cardReplacementCents: 0,
  p2pCents: 0,
};

/** MCC groups used for over-capture tolerance and family category blocks. */
export const MCC_GROUPS: Record<string, string[]> = {
  restaurant: ["5812", "5813", "5814"],
  fuel: ["5541", "5542"],
  gambling: ["7995"],
  alcohol: ["5921"],
  tobacco: ["5993"],
  adult: ["5967"],
  atm: ["6011"],
  grocery: ["5411"],
  digital_goods: ["5815", "5816", "5817", "5818"],
};

export function mccGroup(mcc: string): string | undefined {
  for (const [g, list] of Object.entries(MCC_GROUPS)) if (list.includes(mcc)) return g;
  return undefined;
}
