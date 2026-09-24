// Time helpers. All instants are UTC. Business days skip Saturday/Sunday and listed holidays.

export const MS_HOUR = 3_600_000;
export const MS_DAY = 86_400_000;

export function addDays(d: Date, days: number): Date {
  return new Date(d.getTime() + days * MS_DAY);
}

export function addHours(d: Date, hours: number): Date {
  return new Date(d.getTime() + hours * MS_HOUR);
}

export function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function isBusinessDay(d: Date, holidays: string[] = []): boolean {
  const dow = d.getUTCDay();
  return dow !== 0 && dow !== 6 && !holidays.includes(isoDate(d));
}

/** Add N business days (same time of day). 0 returns the input unchanged. */
export function addBusinessDays(d: Date, n: number, holidays: string[] = []): Date {
  if (!Number.isInteger(n) || n < 0) throw new Error("business days must be a non-negative integer");
  let cur = new Date(d.getTime());
  let left = n;
  while (left > 0) {
    cur = addDays(cur, 1);
    if (isBusinessDay(cur, holidays)) left--;
  }
  return cur;
}

export function startOfUtcDay(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

export function startOfUtcMonth(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
}

export function daysInMonth(year: number, month0: number): number {
  return new Date(Date.UTC(year, month0 + 1, 0)).getUTCDate();
}
