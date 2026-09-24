// Sign in / out, role-based landing, and staff KYC review.
import { expect, test } from "@playwright/test";
import { PASSWORD, nav, signIn, signOut } from "./helpers";

test.describe("sign in", () => {
  test("a customer signs in with email + password, sees their accounts, and signs out", async ({
    page,
  }) => {
    await page.goto("/");
    await expect(page).toHaveURL(/\/signin$/);
    await expect(page.getByTestId("demo-mode")).toBeVisible();

    await page.getByTestId("signin-email").fill("ava@harbor.test");
    await page.getByTestId("signin-password").fill("wrong-password");
    await page.getByTestId("signin-submit").click();
    await expect(page.getByTestId("signin-error")).toHaveText("Invalid email or password");

    await page.getByTestId("signin-password").fill(PASSWORD);
    await page.getByTestId("signin-submit").click();
    await expect(page).toHaveURL(/\/$/);
    await expect(page.getByTestId("session-email")).toHaveText("ava@harbor.test");
    await expect(page.getByTestId("kyc-state")).toHaveText("approved");
    await expect(page.getByTestId("checking-available")).toHaveAttribute("data-cents", "250000");
    await expect(page.getByTestId("nav-admin")).toHaveCount(0);

    await signOut(page);
    await page.goto("/cards");
    await expect(page).toHaveURL(/\/signin$/);
  });

  test("staff land on the admin console", async ({ page }) => {
    await signIn(page, "admin@harbor.test");
    await expect(page).toHaveURL(/\/admin$/);
    await expect(page.getByTestId("admin-users")).toBeVisible();
    await expect(page.getByTestId("trial-balance")).toHaveText("Trial balance 0");
  });
});

test.describe("admin KYC review", () => {
  test("an admin approves a customer in review (reason required) and the customer's accounts open", async ({
    page,
  }) => {
    await signIn(page, "admin@harbor.test");
    await page.getByTestId("admin-kyc-filter").selectOption("needs_review");
    const rita = page.locator('[data-testid="admin-user-row"][data-email="rita@harbor.test"]');
    await expect(rita.getByTestId("admin-user-kyc")).toHaveText("needs_review");
    await expect(rita).toContainText("identity requires input");

    // A KYC decision always needs a reason.
    await rita.getByTestId("admin-kyc-approved").click();
    await expect(page.getByTestId("admin-error")).toHaveAttribute("data-code", "reason_required");

    await page.getByTestId("admin-reason").fill("ID documents verified by support");
    await rita.getByTestId("admin-kyc-approved").click();
    await expect(page.getByTestId("admin-ok")).toContainText("KYC: approved");
    await expect(rita).toHaveCount(0); // no longer in the review queue

    await page.getByTestId("admin-kyc-filter").selectOption("approved");
    await expect(
      page
        .locator('[data-testid="admin-user-row"][data-email="rita@harbor.test"]')
        .getByTestId("admin-user-kyc"),
    ).toHaveText("approved");

    await signOut(page);
    await signIn(page, "rita@harbor.test");
    await expect(page.getByTestId("kyc-state")).toHaveText("approved");
    await expect(page.getByTestId("account-checking")).toBeVisible();
    await expect(page.getByTestId("account-savings")).toBeVisible();
    await expect(page.getByTestId("checking-posted")).toHaveAttribute("data-cents", "0");
  });

  test("customers cannot open the admin console", async ({ page }) => {
    await signIn(page, "ben@harbor.test");
    await page.goto("/admin");
    await expect(page).toHaveURL(/\/$/);
    await nav(page, "accounts");
    await expect(page.getByTestId("checking-available")).toHaveAttribute("data-cents", "50000");
  });
});
