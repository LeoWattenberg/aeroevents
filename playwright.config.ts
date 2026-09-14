import { existsSync } from "node:fs";
import { defineConfig, devices } from "@playwright/test";

const systemChromium = "/snap/bin/chromium";
const testPort = Number(process.env.AEROEVENTS_E2E_PORT ?? "4321");
if (!Number.isInteger(testPort) || testPort < 1 || testPort > 65_535) {
  throw new Error("AEROEVENTS_E2E_PORT skal være et gyldigt portnummer");
}
const testOrigin = `http://127.0.0.1:${testPort}`;

export default defineConfig({
  testDir: "tests/e2e",
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  ...(process.env.CI ? { workers: 2 } : {}),
  reporter: process.env.CI ? "github" : "list",
  use: {
    baseURL: `${testOrigin}/aeroevents/`,
    trace: "on-first-retry",
    ...(existsSync(systemChromium) ? { launchOptions: { executablePath: systemChromium } } : {}),
  },
  projects: [
    { name: "desktop-chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "mobile-chromium", use: { ...devices["Pixel 7"] } },
  ],
  webServer: {
    command:
      `AEROEVENTS_NOW=2026-09-13T12:00:00+02:00 AEROEVENTS_INCLUDE_DRAFTS=1 PUBLIC_SITE_URL=${testOrigin} PUBLIC_BASE_PATH=/aeroevents npm run build && PORT=${testPort} PUBLIC_BASE_PATH=/aeroevents npx tsx scripts/serve-static.ts`,
    url: `${testOrigin}/aeroevents/`,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
