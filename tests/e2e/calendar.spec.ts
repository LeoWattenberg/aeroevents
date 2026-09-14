import { expect, test } from "@playwright/test";

test("filters agenda items and preserves the selection in the URL", async ({ page }) => {
  await page.goto("./");
  await expect(page.getByRole("heading", { level: 1, name: /Hvad sker der/ })).toBeVisible();

  const target = page.locator('[data-calendar-kind="agenda"]:visible').first();
  await expect(target).toBeVisible();
  const organizerId = await target.getAttribute("data-organizer");
  const categoryId = (await target.getAttribute("data-categories"))?.split("|").filter(Boolean)[0];
  const eventDate = await target.getAttribute("data-date");
  const eventTitle = (await target.locator("h3").innerText()).trim();
  expect(organizerId).toBeTruthy();
  expect(categoryId).toBeTruthy();
  expect(eventDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);

  await page.getByLabel("Arrangør").selectOption(organizerId!);
  await page.locator('select[name="kategori"]').selectOption(categoryId!);
  await page.getByLabel("Søg").fill(eventTitle);
  await page.getByText("Vælg datoer", { exact: true }).click();
  await page.getByLabel("Fra og med").fill(eventDate!);
  await page.getByLabel("Til og med").fill(eventDate!);
  await page.getByText("Vælg datoer", { exact: true }).click();
  await page.getByRole("button", { name: "Vis arrangementer" }).click();

  await expect(page).toHaveURL(new RegExp(`arrangoer=${organizerId}`));
  await expect(page).toHaveURL(new RegExp(`kategori=${categoryId}`));
  await expect(page).toHaveURL(/q=/);
  await expect(page).toHaveURL(new RegExp(`fra=${eventDate}`));
  await expect(page).toHaveURL(new RegExp(`til=${eventDate}`));
  const visibleAgendaItems = page.locator('[data-calendar-kind="agenda"]:visible');
  await expect(visibleAgendaItems).not.toHaveCount(0);
  await expect(visibleAgendaItems.first().locator("h3")).toHaveText(eventTitle);
  for (const item of await visibleAgendaItems.all()) {
    const date = await item.getAttribute("data-date");
    expect(date).toBe(eventDate);
  }

  await page.reload();
  await expect(page.getByLabel("Arrangør")).toHaveValue(organizerId!);
  await expect(page.locator('select[name="kategori"]')).toHaveValue(categoryId!);
  await expect(page.getByLabel("Søg")).toHaveValue(eventTitle);
  await expect(page.getByLabel("Fra og med")).toHaveValue(eventDate!);
  await expect(page.getByLabel("Til og med")).toHaveValue(eventDate!);
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

test("keeps the page usable without JavaScript", async ({ browser, baseURL }) => {
  const context = await browser.newContext({
    javaScriptEnabled: false,
    ...(baseURL ? { baseURL } : {}),
  });
  const page = await context.newPage();
  await page.goto("./");

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

test("shows booking and source details on stable event pages", async ({ page }) => {
  await page.goto("./begivenheder/aeroe-bibliotek-10260/");
  await expect(page.locator("main h1")).toContainText("Ude for uden");
  await expect(page.getByText("Gratis", { exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "Tilmeld eller bestil" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Sted" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Kilde" })).toBeVisible();
});

test("lists every enabled external source and links to it from the site", async ({ page }, testInfo) => {
  await page.goto("./");
  await page.getByRole("link", { name: "Se alle kilder" }).click();

  await expect(page).toHaveURL(/\/aeroevents\/kilder\/$/);
  await expect(page.getByRole("heading", { level: 1, name: "Kilder" })).toBeVisible();
  await expect(page.locator("[data-source-id]")).toHaveCount(24);
  await expect(page.getByRole("link", { name: /Ærø Kommunes mødeplan/ })).toHaveAttribute(
    "href",
    "https://www.aeroekommune.dk/politik-og-indflydelse/moedeplaner",
  );
  await expect(page.getByRole("link", { name: /Ærø Kirkelivs kalender/ })).toHaveAttribute(
    "href",
    "https://www.xn--rkirkeliv-f3a3r.dk/kalender--aktiviteter",
  );
  await expect(page.getByRole("link", { name: /Ærø Folkebiblioteks arrangementer/ })).toHaveAttribute(
    "href",
    "https://www.arrebib.dk/arrangementer",
  );
  await expect(page.getByRole("link", { name: /Offentlige Facebook-kilder/ })).toHaveAttribute(
    "href",
    "https://www.facebook.com/events/",
  );
  const sourceSection = page.locator('[aria-labelledby="external-sources-heading"]');
  await expect(sourceSection.locator("article")).toHaveCount(24);
  await expect(page.locator("[data-facebook-source-id]"), "every configured Facebook source").toHaveCount(47);
  await expect(page.locator('[data-facebook-source-id="det-sker-i-ommel"] a')).toHaveAttribute(
    "href",
    "https://www.facebook.com/groups/871725845485563/",
  );
  await expect(page.locator('[data-facebook-source-id="aeroe-hotel"] a')).toHaveAttribute(
    "href",
    "https://www.facebook.com/aeroehotel/",
  );
  await expect(page.locator("[data-candidate-source-id]"), "no integrated source remains in the backlog").toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Alle hidtil undersøgte kilder er integreret" })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await expect(page.getByRole("heading", { name: /Lokale arrangører kan også sende/ })).toBeVisible();
  await expect(page.getByRole("link", { name: "Indsend et arrangement", exact: true })).toHaveAttribute(
    "href",
    "/aeroevents/indsend/",
  );

  const expectedInternalPath = "/aeroevents/kilder/";
  if (!testInfo.project.name.startsWith("mobile")) {
    await expect(
      page.getByRole("navigation", { name: "Primær navigation" }).getByRole("link", { name: "Kilder" }),
    ).toHaveAttribute("href", expectedInternalPath);
  }
  await expect(
    page.getByRole("navigation", { name: "Sidefod" }).getByRole("link", { name: "Kilder" }),
  ).toHaveAttribute("href", expectedInternalPath);
});

test("fits the mobile viewport and exposes the submission address", async ({ page }, testInfo) => {
  test.skip(!testInfo.project.name.startsWith("mobile"), "Mobilkontrol køres i mobilprojektet");
  await page.goto("./indsend/");
  await expect(page.getByRole("heading", { level: 1, name: "Indsend et arrangement" })).toBeVisible();
  await expect(page.locator('a[href^="mailto:"]').first()).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(1);
});
