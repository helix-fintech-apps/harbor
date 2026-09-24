import { defineConfig, devices } from "@playwright/test";
import { existsSync } from "node:fs";

// E2E runs against DEMO MODE: the real service + router run in the browser on the in-memory store
// with fake providers (no backend). Each test gets a fresh browser context, so a fresh demo seed.
// Base URL: E2E_BASE_URL (e.g. a deployed preview) or a local `vite preview` of a demo-mode build.
const externalBaseUrl = process.env.E2E_BASE_URL;
const port = Number(process.env.E2E_PORT ?? 4173);
const baseURL = externalBaseUrl || `http://localhost:${port}`;

// Browser: an explicit PW_CHROMIUM_PATH, else a preinstalled Chromium at /opt/pw-browsers/chromium,
// else whatever `npx playwright install chromium` put in the default cache (CI).
const preinstalled = "/opt/pw-browsers/chromium";
const executablePath =
  process.env.PW_CHROMIUM_PATH || (existsSync(preinstalled) ? preinstalled : undefined);

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  timeout: 30_000,
  expect: { timeout: 7_000 },
  use: {
    baseURL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        launchOptions: executablePath ? { executablePath } : {},
      },
    },
  ],
  webServer: externalBaseUrl
    ? undefined
    : {
        // A production build served by `vite preview` (no dev-server dependency re-optimization).
        command: `npx vite build && npx vite preview --port ${port} --strictPort`,
        url: baseURL,
        reuseExistingServer: !process.env.CI,
        timeout: 120_000,
        // Empty Supabase settings force demo mode even if a local .env has them.
        env: { VITE_SUPABASE_URL: "", VITE_SUPABASE_ANON_KEY: "" },
      },
});
