// Money in and out: fake Plaid link (owner-name match, cooling-off), ACH deposit hold (posted vs
// available), instant withdrawal fee = the published fee page, P2P with step-up for a new payee.
import { expect, test, type Page } from "@playwright/test";
import { expectCents, nav, signIn, signOut } from "./helpers";

test.beforeEach(async ({ page }) => {
  await signIn(page, "ava@harbor.test");
});

test("link a bank through fake Plaid: name match, mismatch, and the 72h cooling-off", async ({
  page,
}) => {
  await nav(page, "link-bank");
  await expect(page.getByTestId("bank-row")).toHaveCount(1); // seeded First Platypus Bank

  await page.getByTestId("link-bank-start").click();
  await expect(page.getByTestId("plaid-modal")).toBeVisible();
  await page.getByTestId("plaid-institution").selectOption("Houndstooth Bank");
  await expect(page.getByTestId("plaid-owner")).toHaveValue("Ava Harbor"); // Plaid reports the owner name
  await page.getByTestId("plaid-continue").click();
  await expect(page.getByTestId("link-ok")).toBeVisible();
  const linked = page.getByTestId("bank-row").filter({ hasText: "Houndstooth Bank" });
  await expect(linked.getByTestId("bank-name-match")).toHaveText("matched");
  // Withdrawals open 72 hours after linking.
  const openAt = Date.parse(
    (await linked.getByTestId("bank-cooling-off").getAttribute("data-at"))!,
  );
  expect(Math.round((openAt - Date.now()) / 3_600_000)).toBe(72);

  // Someone else's account links but is unusable.
  await page.getByTestId("link-bank-start").click();
  await page.getByTestId("plaid-institution").selectOption("Tattersall Credit Union");
  await page.getByTestId("plaid-owner").fill("Mallory Smith");
  await page.getByTestId("plaid-continue").click();
  const mismatched = page.getByTestId("bank-row").filter({ hasText: "Mallory Smith" });
  await expect(mismatched.getByTestId("bank-name-match")).toHaveText("mismatch");

  await nav(page, "transfers");
  await selectBank(page, "ach-in-bank", "Tattersall");
  await page.getByTestId("ach-in-amount").fill("10.00");
  await page.getByTestId("ach-in-submit").click();
  await expect(page.getByTestId("ach-in-error")).toHaveAttribute("data-code", "bank_name_mismatch");

  await selectBank(page, "ach-out-bank", "Houndstooth");
  await page.getByTestId("ach-out-amount").fill("10.00");
  await page.getByTestId("ach-out-submit").click();
  await expect(page.getByTestId("ach-out-error")).toHaveAttribute("data-code", "cooling_off");
});

test("an ACH deposit posts immediately but stays on hold: posted vs available", async ({
  page,
}) => {
  await nav(page, "transfers");
  await page.getByTestId("ach-in-bank").selectOption({ index: 1 });
  await page.getByTestId("ach-in-amount").fill("100.00");
  await page.getByTestId("ach-in-submit").click();
  await expect(page.getByTestId("ach-in-ok")).toContainText("Available after");
  await expectCents(page.getByTestId("transfers-available"), 250_000);

  await nav(page, "accounts");
  await expectCents(page.getByTestId("checking-posted"), 260_000);
  await expectCents(page.getByTestId("checking-holds"), 10_000);
  await expectCents(page.getByTestId("checking-available"), 250_000);
  await expect(
    page.getByTestId("activity-row").filter({ hasText: "ach_in" }).first(),
  ).toContainText("pending");
});

test("the instant withdrawal fee is exactly the fee on the published fee page", async ({
  page,
}) => {
  await nav(page, "fees-terms");
  const text = (await page.getByTestId("fee-instant").textContent())!;
  const m = /^(\d+)(?:\.(\d{2}))?% \(min \$(\d+)\.(\d{2}), max \$(\d+)\.(\d{2})\)$/.exec(
    text.trim(),
  );
  expect(m, `unexpected fee text: ${text}`).not.toBeNull();
  const bps = Number(m![1]) * 100 + Number(m![2] ?? "0");
  const minCents = Number(m![3]) * 100 + Number(m![4]);
  const maxCents = Number(m![5]) * 100 + Number(m![6]);
  // fee = bps of the amount, rounded half up, clamped to [min, max] — integer cents only.
  const published = (amountCents: number) =>
    Math.min(Math.max(Math.floor((amountCents * bps * 2 + 10_000) / 20_000), minCents), maxCents);

  await nav(page, "transfers");
  await page.getByTestId("ach-out-bank").selectOption({ index: 1 });
  await page.getByTestId("speed-instant").check();
  for (const [amount, amountCents] of [
    ["10.00", 1_000],
    ["100.00", 10_000],
    ["1500.00", 150_000],
    ["33.33", 3_333],
  ] as const) {
    await page.getByTestId("ach-out-amount").fill(amount);
    await expectCents(page.getByTestId("ach-out-fee"), published(amountCents));
    await expectCents(page.getByTestId("ach-out-total"), amountCents + published(amountCents));
  }
  expect([published(1_000), published(10_000), published(150_000)]).toEqual([
    minCents,
    150,
    maxCents,
  ]);

  // What is actually charged matches the quote and the fee page.
  await page.getByTestId("ach-out-amount").fill("100.00");
  await page.getByTestId("ach-out-submit").click();
  await expect(page.getByTestId("ach-out-ok")).toContainText("Fee: $1.50");
  await nav(page, "accounts");
  await expectCents(page.getByTestId("checking-posted"), 250_000 - 10_000 - published(10_000));
  const row = page.getByTestId("activity-row").filter({ hasText: "ach_out (instant)" });
  await expect(row.locator("[data-cents]").nth(1)).toHaveAttribute(
    "data-cents",
    String(published(10_000)),
  );
});

test("P2P to a new payee needs step-up; the next payment doesn't; the recipient is credited", async ({
  page,
}) => {
  await nav(page, "transfers");
  await page.getByTestId("p2p-recipient").fill("ben@harbor.test");
  await page.getByTestId("p2p-amount").fill("25.00");
  await page.getByTestId("p2p-submit").click();
  await expect(page.getByTestId("p2p-error")).toHaveAttribute("data-code", "step_up_required");
  await expect(page.getByTestId("p2p-stepup-prompt")).toBeVisible();

  await page.getByTestId("p2p-stepup-code").fill("123456");
  await page.getByTestId("p2p-submit").click();
  await expect(page.getByTestId("p2p-error")).toHaveAttribute("data-code", "step_up_required");
  await expectCents(page.getByTestId("transfers-available"), 250_000);

  await page.getByTestId("p2p-stepup-code").fill("000000");
  await page.getByTestId("p2p-submit").click();
  await expect(page.getByTestId("p2p-ok")).toContainText("completed");
  await expectCents(page.getByTestId("transfers-available"), 247_500);

  // Ben is a known payee now: no code needed.
  await page.getByTestId("p2p-amount").fill("5.00");
  await page.getByTestId("p2p-submit").click();
  await expect(page.getByTestId("p2p-ok")).toBeVisible();
  await expect(page.getByTestId("p2p-stepup-prompt")).toHaveCount(0);
  await expectCents(page.getByTestId("transfers-available"), 247_000);

  await signOut(page);
  await signIn(page, "ben@harbor.test");
  await expectCents(page.getByTestId("checking-posted"), 53_000);
  await expectCents(page.getByTestId("checking-available"), 53_000);
});

async function selectBank(page: Page, testId: string, text: string) {
  const option = page.getByTestId(testId).locator("option", { hasText: text });
  await page.getByTestId(testId).selectOption((await option.getAttribute("value"))!);
}
