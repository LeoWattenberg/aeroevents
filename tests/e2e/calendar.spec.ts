import { expect, test } from "@playwright/test";

test("filters agenda items and preserves the selection in the URL", async ({ page }) => {
  await page.goto("./");
  await expect(page.getByRole("heading", { level: 1, name: /Hvad sker der/ })).toBeVisible();

  await page.getByLabel("Arrangør").selectOption("eksempel-faellesskab");
  await page.getByLabel("Kategori").selectOption("forening-faellesskab");
  await page.getByLabel("Søg").fill("fællesskab");
  await page.getByText("Vælg datoer", { exact: true }).click();
  await page.getByLabel("Fra og med").fill("2026-09-20");
  await page.getByLabel("Til og med").fill("2026-10-31");
  await page.getByText("Vælg datoer", { exact: true }).click();
  await page.getByRole("button", { name: "Vis arrangementer" }).click();

  await expect(page).toHaveURL(/arrangoer=eksempel-faellesskab/);
  await expect(page).toHaveURL(/kategori=forening-faellesskab/);
  await expect(page).toHaveURL(/q=f%C3%A6llesskab/);
  await expect(page).toHaveURL(/fra=2026-09-20/);
  await expect(page).toHaveURL(/til=2026-10-31/);
  const visibleAgendaItems = page.locator('[data-calendar-kind="agenda"]:visible');
  await expect(visibleAgendaItems).not.toHaveCount(0);
  await expect(visibleAgendaItems.first()).toContainText(/Eksempel:/);
  for (const item of await visibleAgendaItems.all()) {
    const date = await item.getAttribute("data-date");
    expect(date).toBeTruthy();
    expect(date! >= "2026-09-20" && date! <= "2026-10-31").toBe(true);
  }

  await page.reload();
  await expect(page.getByLabel("Arrangør")).toHaveValue("eksempel-faellesskab");
  await expect(page.getByLabel("Kategori")).toHaveValue("forening-faellesskab");
  await expect(page.getByLabel("Søg")).toHaveValue("fællesskab");
  await expect(page.getByLabel("Fra og med")).toHaveValue("2026-09-20");
  await expect(page.getByLabel("Til og med")).toHaveValue("2026-10-31");
});

test("switches to a Monday-first month and opens a stable event page", async ({ page }) => {
  await page.goto("./");
  await page.getByRole("button", { name: "Måned" }).click();
  await expect(page).toHaveURL(/visning=maaned/);
  await expect(page.locator("[data-month-view]")).toBeVisible();
  const visibleMonth = page.locator('[data-month-panel]:visible');
  await expect(visibleMonth.locator(".weekdays")).toContainText("Man");
  await expect(visibleMonth.locator(".weekdays span").first()).toHaveText("Man");

  const link = page.locator('[data-month-view] [data-calendar-item]:visible h3 a').first();
  await expect(link).toBeVisible();
  const href = await link.getAttribute("href");
  expect(href).toMatch(/^\/aeroevents\/begivenheder\/[a-z0-9-]+\/$/);
  await link.click();
  await expect(page).toHaveURL(/\/aeroevents\/begivenheder\/[a-z0-9-]+\/$/);
  await expect(page.locator("main h1")).toBeVisible();
});

test("keeps the page usable without JavaScript", async ({ browser }) => {
  const context = await browser.newContext({ javaScriptEnabled: false });
  const page = await context.newPage();
  await page.goto("http://127.0.0.1:4321/aeroevents/");

  await expect(page.locator("[data-agenda-view]")).toBeVisible();
  await expect(page.locator('[data-calendar-kind="agenda"] a').first()).toBeVisible();
  await expect(page.getByText(/Hele kalenderen står nedenfor/)).toBeVisible();
  await context.close();
});

test("supports keyboard-operated search and view switching", async ({ page }) => {
  await page.goto("./");
  const search = page.getByLabel("Søg");
  await search.focus();
  await page.keyboard.type("gudstjeneste");
  await expect(page).toHaveURL(/q=gudstjeneste/);
  await expect(page.locator('[data-calendar-kind="agenda"]:visible').first()).toContainText(/Gudstjeneste/i);

  const monthButton = page.getByRole("button", { name: "Måned", exact: true });
  await monthButton.focus();
  await page.keyboard.press("Enter");
  await expect(monthButton).toHaveAttribute("aria-pressed", "true");
  await expect(page).toHaveURL(/visning=maaned/);
});

test("shows booking and members-only details on stable event pages", async ({ page }) => {
  await page.goto("./begivenheder/eksempel-koncert/");
  await expect(page.locator("main h1")).toContainText("koncert i forsamlingshuset");
  await expect(page.getByText("100 kr.", { exact: true })).toBeVisible();
  await expect(page.getByText("Tilmelding eller billet er nødvendig.")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Sted" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Kilde" })).toBeVisible();

  await page.goto("./begivenheder/eksempel-medlemsmoede/");
  await expect(page.getByText("Kun for medlemmer", { exact: true }).first()).toBeVisible();
});

test("fits the mobile viewport and exposes the submission address", async ({ page }, testInfo) => {
  test.skip(!testInfo.project.name.startsWith("mobile"), "Mobilkontrol køres i mobilprojektet");
  await page.goto("./indsend/");
  await expect(page.getByRole("heading", { level: 1, name: "Indsend et arrangement" })).toBeVisible();
  await expect(page.locator('a[href^="mailto:"]').first()).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(1);
});
