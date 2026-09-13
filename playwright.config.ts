import { existsSync } from "node:fs";
import { defineConfig, devices } from "@playwright/test";

const systemChromium = "/snap/bin/chromium";

export default defineConfig({
  testDir: "tests/e2e",
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  ...(process.env.CI ? { workers: 2 } : {}),
  reporter: process.env.CI ? "github" : "list",
  use: {
    baseURL: "http://127.0.0.1:4321/aeroevents/",
    trace: "on-first-retry",
    ...(existsSync(systemChromium) ? { launchOptions: { executablePath: systemChromium } } : {}),
  },
  projects: [
    { name: "desktop-chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "mobile-chromium", use: { ...devices["Pixel 7"] } },
  ],
  webServer: {
    command:
      "AEROEVENTS_NOW=2026-09-13T12:00:00+02:00 AEROEVENTS_INCLUDE_DRAFTS=1 PUBLIC_SITE_URL=http://127.0.0.1:4321 PUBLIC_BASE_PATH=/aeroevents npm run build && PUBLIC_BASE_PATH=/aeroevents npx tsx scripts/serve-static.ts",
    url: "http://127.0.0.1:4321/aeroevents/",
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
