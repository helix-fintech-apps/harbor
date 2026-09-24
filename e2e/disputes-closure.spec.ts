// Reg E dispute with provisional credit (customer -> staff -> customer), and account closure
// blocked while a deposit hold is pending.
import { expect, test } from "@playwright/test";
import { authorize, expectCents, nav, signIn, signOut } from "./helpers";

test("dispute a card purchase: provisional credit shows on the dispute and the balance", async ({
  page,
}) => {
  await signIn(page, "ava@harbor.test");
  await nav(page, "cards");
  const cardId = (await page.getByTestId("card-row").first().getAttribute("data-card-id"))!;
  await authorize(page, cardId, "30.00", "5942", "E2E Books");
  await expect(page.getByTestId("sim-ok")).toContainText("Approved, hold $30.00");
  await page.getByTestId("sim-auth").selectOption({ label: "E2E Books $30.00 (authorized)" });
  await page.getByTestId("sim-capture-amount").fill("30.00");
  await page.getByTestId("sim-capture").click();
  await expect(
    page.getByTestId("sim-auth").locator("option", { hasText: "E2E Books $30.00 (captured)" }),
  ).toHaveCount(1);

  await nav(page, "disputes");
  await page.getByTestId("dispute-auth").selectOption({ label: "E2E Books — $30.00" });
  await page.getByTestId("dispute-amount").fill("30.00");
  await page.getByTestId("dispute-reason").fill("Books never arrived");
  await page.getByTestId("dispute-submit").click();
  await expect(page.getByTestId("dispute-ok")).toContainText("Status: open");
  const row = page.getByTestId("dispute-row");
  await expect(row.getByTestId("dispute-status")).toHaveText("open");
  await expectCents(row.getByTestId("dispute-provisional"), 0);
  // The same purchase can't be disputed twice while a dispute is open.
  await page.getByTestId("dispute-submit").click();
  await expect(page.getByTestId("dispute-error")).toHaveAttribute("data-code", "dispute_rejected");
  await nav(page, "accounts");
  await expectCents(page.getByTestId("checking-posted"), 247_000);

  // Staff give provisional credit (due within 10 business days of the notice).
  await signOut(page);
  await signIn(page, "admin@harbor.test");
  const adminRow = page.getByTestId("admin-dispute-row").filter({ hasText: "$30.00" });
  await adminRow.getByTestId("admin-dispute-credit").click();
  await expect(page.getByTestId("admin-ok")).toContainText("provisional_credited");
  await expect(page.getByTestId("trial-balance")).toHaveText("Trial balance 0");

  await signOut(page);
  await signIn(page, "ava@harbor.test");
  await expectCents(page.getByTestId("checking-posted"), 250_000);
  await nav(page, "disputes");
  await expect(row.getByTestId("dispute-status")).toHaveText("provisional credited");
  await expectCents(row.getByTestId("dispute-provisional"), 3_000);
});

test("account closure is blocked while a deposit hold is pending", async ({ page }) => {
  await signIn(page, "ava@harbor.test");
  await nav(page, "transfers");
  await page.getByTestId("ach-in-bank").selectOption({ index: 1 });
  await page.getByTestId("ach-in-amount").fill("50.00");
  await page.getByTestId("ach-in-submit").click();
  await expect(page.getByTestId("ach-in-ok")).toBeVisible();

  await nav(page, "settings");
  await page.getByTestId("close-start").click();
  await page.getByTestId("close-confirm").click();
  const err = page.getByTestId("close-error");
  await expect(err).toHaveAttribute("data-code", "closure_blocked");
  await expect(err).toContainText("pending_holds");

  // Nothing was closed or paid out.
  await nav(page, "accounts");
  await expect(page.getByTestId("account-checking-status")).toHaveText("open");
  await expectCents(page.getByTestId("checking-posted"), 255_000);
  await nav(page, "cards");
  await expect(page.getByTestId("card-row").first().getByTestId("card-status")).toHaveText(
    "active",
  );
});
