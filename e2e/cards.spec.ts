// Debit cards through the card-network simulator: a frozen card is declined; a teen family card
// needs guardian approval, spends only from its allowance, and blocks restricted merchant categories.
import { expect, test } from "@playwright/test";
import { authorize, expectCents, nav, signIn } from "./helpers";

test.beforeEach(async ({ page }) => {
  await signIn(page, "ava@harbor.test");
  await nav(page, "cards");
});

test("freeze a card: purchases are declined until it is unfrozen", async ({ page }) => {
  const card = page.getByTestId("card-row").first();
  const cardId = (await card.getAttribute("data-card-id"))!;
  await expect(card.getByTestId("card-status")).toHaveText("active");

  await card.getByTestId("card-freeze").click();
  await expect(card.getByTestId("card-status")).toHaveText("frozen");
  await authorize(page, cardId, "12.34");
  await expect(page.getByTestId("sim-ok")).toContainText("Declined: card_frozen");

  await card.getByTestId("card-unfreeze").click();
  await expect(card.getByTestId("card-status")).toHaveText("active");
  await authorize(page, cardId, "12.34");
  await expect(page.getByTestId("sim-ok")).toContainText("Approved, hold $12.34");

  await nav(page, "accounts");
  await expectCents(page.getByTestId("checking-holds"), 1_234);
  await expectCents(page.getByTestId("checking-available"), 250_000 - 1_234);
  await expect(
    page.getByTestId("card-activity-row").filter({ hasText: "card_frozen" }),
  ).toHaveCount(1);
});

test("teen family card: guardian approval, allowance-only spending, MCC block", async ({
  page,
}) => {
  await page.getByTestId("family-name").fill("Tia");
  await page.getByTestId("family-kind").selectOption("teen");
  await page.getByTestId("family-add").click();
  const tia = page.getByTestId("family-row").filter({ hasText: "Tia" });
  await expect(tia.getByTestId("family-status")).toHaveText("pending guardian approval");
  await expect(tia).toContainText("gambling"); // teen defaults block gambling/alcohol/tobacco/adult

  await tia.getByTestId("family-issue-card").click();
  const teenCard = page.getByTestId("card-row").filter({ hasText: "Tia (teen)" });
  const cardId = (await teenCard.getAttribute("data-card-id"))!;
  await authorize(page, cardId, "5.00");
  await expect(page.getByTestId("sim-ok")).toContainText("Declined: member_inactive");

  await tia.getByTestId("family-approve").click();
  await expect(tia.getByTestId("family-status")).toHaveText("active");
  await tia.getByTestId("family-topup-amount").fill("20.00");
  await tia.getByTestId("family-topup").click();
  await expectCents(tia.getByTestId("family-allowance"), 2_000);

  // Over the allowance: declined even though the owner's checking has $2,480.
  await authorize(page, cardId, "25.00");
  await expect(page.getByTestId("sim-ok")).toContainText("Declined: allowance_exceeded");
  // Gambling (MCC 7995) is blocked for teens whatever the amount.
  await authorize(page, cardId, "5.00", "7995", "Lucky Casino");
  await expect(page.getByTestId("sim-ok")).toContainText("Declined: mcc_blocked");
  // Within the allowance at a grocer: approved and held on the allowance, not on checking.
  await authorize(page, cardId, "10.00");
  await expect(page.getByTestId("sim-ok")).toContainText("Approved, hold $10.00");
  await expectCents(tia.getByTestId("family-allowance"), 1_000);

  await nav(page, "accounts");
  await expectCents(page.getByTestId("checking-posted"), 248_000);
  await expectCents(page.getByTestId("checking-available"), 248_000);
});
