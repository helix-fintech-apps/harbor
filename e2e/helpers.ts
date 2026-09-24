// Shared steps for the demo-mode E2E suite. Every test starts from a fresh demo seed (new browser
// context => empty localStorage): Ava $2,500 settled + bank + virtual card, Ben $500, Rita in review.
import { expect, type Locator, type Page } from "@playwright/test";

/** Demo password of every seeded user (docs/SPEC.md). */
export const PASSWORD = "Harbor!2026";

export async function signIn(page: Page, email: string) {
  await page.goto("/signin");
  await page.getByTestId("signin-email").fill(email);
  await page.getByTestId("signin-password").fill(PASSWORD);
  await page.getByTestId("signin-submit").click();
  await expect(page.getByTestId("session-email")).toHaveText(email);
}

export async function signOut(page: Page) {
  await page.getByTestId("sign-out").click();
  await expect(page.getByTestId("signin-form")).toBeVisible();
}

export async function nav(
  page: Page,
  to:
    | "accounts"
    | "link-bank"
    | "transfers"
    | "cards"
    | "disputes"
    | "fees-terms"
    | "settings"
    | "admin",
) {
  await page.getByTestId(`nav-${to}`).click();
}

/** Integer cents rendered by <Money> (data-cents), never parsed from the formatted text. */
export async function cents(locator: Locator): Promise<number> {
  const v = await locator.getAttribute("data-cents");
  if (v === null || !/^-?\d+$/.test(v)) throw new Error(`no integer data-cents on ${locator}`);
  return Number(v);
}

export async function expectCents(locator: Locator, expected: number) {
  await expect(locator).toHaveAttribute("data-cents", String(expected));
}

/** Merchant simulator: authorize `amount` (dollars, e.g. "12.34") on a card at an MCC. */
export async function authorize(
  page: Page,
  cardId: string,
  amount: string,
  mcc = "5411",
  merchant = "Corner Grocer",
) {
  await page.getByTestId("sim-card").selectOption(cardId);
  await page.getByTestId("sim-amount").fill(amount);
  await page.getByTestId("sim-mcc").fill(mcc);
  await page.getByTestId("sim-merchant").fill(merchant);
  await page.getByTestId("sim-authorize").click();
}
